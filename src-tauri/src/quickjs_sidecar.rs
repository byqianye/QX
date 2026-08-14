//! Small, stdio-based QuickJS worker used by the Tauri shell.
//!
//! The sidecar deliberately exposes a narrow host API.  It is not a Node.js
//! replacement: guest scripts get HTTP, hashing, base64, storage, and a quiet
//! console, but no filesystem, process, or module-loading access outside the
//! sources supplied by the parent process.

use std::collections::HashMap;
use std::io::{self, BufRead, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use md5::Md5;
use reqwest::blocking::Client;
use reqwest::header::{HeaderName, HeaderValue};
use rquickjs::function::Args;
use rquickjs::loader::{Loader, Resolver};
use rquickjs::{
    Context, Ctx, Error as JsError, Function, Module, Object, Persistent, Runtime, Type, Value,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as JsonValue};
use sha1::Sha1;
use sha2::{Digest, Sha256};

const MAX_SCRIPT_BYTES: usize = 4 * 1024 * 1024;
const MAX_MODULES: usize = 32;
const MAX_MODULE_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MEMORY_LIMIT_BYTES: usize = 32 * 1024 * 1024;
const STACK_LIMIT_BYTES: usize = 512 * 1024;
const EXECUTION_LIMIT: Duration = Duration::from_secs(5);
const DEFAULT_USER_AGENT: &str = "QX影视/0.9 QuickJS sidecar";

#[derive(Debug)]
struct SidecarError {
    code: &'static str,
    message: String,
}

impl SidecarError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new("QUICKJS_INVALID_REQUEST", message)
    }

    fn script(message: impl Into<String>) -> Self {
        Self::new("QUICKJS_SCRIPT_LOAD_FAILED", message)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: JsonValue,
    method: String,
    #[serde(default)]
    script: Option<String>,
    #[serde(default)]
    module_sources: HashMap<String, String>,
    #[serde(default)]
    allowed_origins: Vec<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    args: Vec<JsonValue>,
}

#[derive(Debug, Serialize)]
struct Response {
    id: JsonValue,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ResponseError>,
}

#[derive(Debug, Serialize)]
struct ResponseError {
    code: &'static str,
    message: String,
}

struct SharedModuleResolver {
    modules: Arc<Mutex<HashMap<String, String>>>,
}

struct SharedModuleLoader {
    modules: Arc<Mutex<HashMap<String, String>>>,
}

impl Resolver for SharedModuleResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<rquickjs::loader::ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        let modules = self.modules.lock().map_err(|_| JsError::Unknown)?;
        if modules.contains_key(name) {
            return Ok(name.to_owned());
        }
        let resolved = normalize_module_name(base, name);
        if modules.contains_key(&resolved) {
            return Ok(resolved);
        }
        Err(JsError::new_loading_message(
            name,
            "module source was not supplied by the parent",
        ))
    }
}

impl Loader for SharedModuleLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<rquickjs::loader::ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js, rquickjs::module::Declared>> {
        let modules = self.modules.lock().map_err(|_| JsError::Unknown)?;
        let source = modules.get(name).ok_or_else(|| {
            JsError::new_loading_message(name, "module source was not supplied by the parent")
        })?;
        Module::declare(ctx.clone(), name, source.clone())
    }
}

struct Sidecar {
    runtime: Runtime,
    context: Context,
    modules: Arc<Mutex<HashMap<String, String>>>,
    allowed_origins: Arc<Mutex<Vec<String>>>,
    exported: Option<Persistent<Object<'static>>>,
    loaded: bool,
}

impl Sidecar {
    fn new() -> Result<Self, SidecarError> {
        let runtime = Runtime::new()
            .map_err(|error| SidecarError::new("QUICKJS_INIT_FAILED", format!("{error:?}")))?;
        runtime.set_memory_limit(MEMORY_LIMIT_BYTES);
        runtime.set_max_stack_size(STACK_LIMIT_BYTES);

        let modules = Arc::new(Mutex::new(HashMap::new()));
        runtime.set_loader(
            SharedModuleResolver {
                modules: modules.clone(),
            },
            SharedModuleLoader {
                modules: modules.clone(),
            },
        );

        let allowed_origins = Arc::new(Mutex::new(Vec::new()));
        let context = Context::full(&runtime)
            .map_err(|error| SidecarError::new("QUICKJS_INIT_FAILED", format!("{error:?}")))?;
        context
            .with(|ctx| install_host_api(ctx, allowed_origins.clone()))
            .map_err(|error| SidecarError::new("QUICKJS_INIT_FAILED", format!("{error:?}")))?;

        Ok(Self {
            runtime,
            context,
            modules,
            allowed_origins,
            exported: None,
            loaded: false,
        })
    }

    fn load(&mut self, request: &Request) -> Result<JsonValue, SidecarError> {
        let script = request
            .script
            .as_deref()
            .ok_or_else(|| SidecarError::invalid("load requires script"))?;
        if script.len() > MAX_SCRIPT_BYTES {
            return Err(SidecarError::script(format!(
                "script exceeds {MAX_SCRIPT_BYTES} bytes"
            )));
        }
        if request.module_sources.len() > MAX_MODULES {
            return Err(SidecarError::script(format!(
                "module count exceeds {MAX_MODULES}"
            )));
        }
        let total_module_bytes = script.len()
            + request
                .module_sources
                .values()
                .map(String::len)
                .sum::<usize>();
        if total_module_bytes > MAX_MODULE_BYTES {
            return Err(SidecarError::script(format!(
                "module bundle exceeds {MAX_MODULE_BYTES} bytes"
            )));
        }

        {
            let mut modules = self.modules.lock().map_err(|_| {
                SidecarError::new("QUICKJS_STATE_FAILED", "module store is unavailable")
            })?;
            modules.clear();
            modules.insert("qx-entry.mjs".to_owned(), script.to_owned());
            modules.insert("entry.mjs".to_owned(), script.to_owned());
            for (name, source) in &request.module_sources {
                modules.insert(name.to_owned(), source.to_owned());
            }
        }
        *self.allowed_origins.lock().map_err(|_| {
            SidecarError::new("QUICKJS_STATE_FAILED", "origin policy is unavailable")
        })? = request.allowed_origins.clone();

        let deadline = Instant::now() + EXECUTION_LIMIT;
        let interrupt_deadline = deadline;
        self.runtime
            .set_interrupt_handler(Some(Box::new(move || Instant::now() >= interrupt_deadline)));
        let result = self.context.with(|ctx| {
            let module = Module::declare(ctx.clone(), "qx-entry.mjs", script)
                .map_err(|error| SidecarError::script(format!("{error:?}")))?;
            let (evaluated, promise) = module
                .eval()
                .map_err(|error| classify_js_error(error, "module evaluation"))?;
            promise
                .finish::<()>()
                .map_err(|error| classify_js_error(error, "module promise"))?;
            let namespace = evaluated
                .namespace()
                .map_err(|error| classify_js_error(error, "module namespace"))?;
            let exported: Object = namespace
                .get("default")
                .map_err(|error| classify_js_error(error, "default export"))?;
            Ok(Persistent::save(&ctx, exported))
        });
        self.runtime.set_interrupt_handler(None);

        match result {
            Ok(exported) => {
                self.exported = Some(exported);
                self.loaded = true;
                Ok(serde_json::json!({ "loaded": true }))
            }
            Err(_error) if Instant::now() >= deadline => Err(SidecarError::new(
                "QUICKJS_TIMEOUT",
                "module evaluation timed out",
            )),
            Err(error) => Err(error),
        }
    }

    fn call(&mut self, request: &Request) -> Result<JsonValue, SidecarError> {
        if !self.loaded {
            return Err(SidecarError::new(
                "QUICKJS_NOT_INITIALIZED",
                "load must complete before call",
            ));
        }
        let name = request
            .name
            .as_deref()
            .ok_or_else(|| SidecarError::invalid("call requires name"))?;
        let exported = self
            .exported
            .as_ref()
            .ok_or_else(|| {
                SidecarError::new("QUICKJS_NOT_INITIALIZED", "default export is unavailable")
            })?
            .clone();

        let deadline = Instant::now() + EXECUTION_LIMIT;
        let interrupt_deadline = deadline;
        self.runtime
            .set_interrupt_handler(Some(Box::new(move || Instant::now() >= interrupt_deadline)));
        let result = self.context.with(|ctx| {
            let object = exported
                .restore(&ctx)
                .map_err(|error| SidecarError::new("QUICKJS_STATE_FAILED", format!("{error:?}")))?;
            let function: Function = object.get(name).map_err(|error| {
                SidecarError::new("QUICKJS_METHOD_NOT_FOUND", format!("{name}: {error:?}"))
            })?;
            let mut args = Args::new(ctx.clone(), request.args.len());
            for argument in &request.args {
                let json = serde_json::to_string(argument).map_err(|error| {
                    SidecarError::invalid(format!("invalid call argument: {error}"))
                })?;
                let value = ctx.json_parse(json).map_err(|error| {
                    SidecarError::invalid(format!("invalid call argument: {error:?}"))
                })?;
                args.push_arg(value).map_err(|error| {
                    SidecarError::new("QUICKJS_CALL_FAILED", format!("{error:?}"))
                })?;
            }
            let value: Value = function
                .call_arg(args)
                .map_err(|error| classify_js_error(error, name))?;
            let json = ctx
                .json_stringify(value)
                .map_err(|error| classify_js_error(error, "return value"))?
                .ok_or_else(|| {
                    SidecarError::new(
                        "QUICKJS_CALL_FAILED",
                        "return value is not JSON serializable",
                    )
                })?;
            let json = json
                .to_string()
                .map_err(|error| SidecarError::new("QUICKJS_CALL_FAILED", format!("{error:?}")))?;
            if json.len() > MAX_RESPONSE_BYTES {
                return Err(SidecarError::new(
                    "QUICKJS_RESPONSE_TOO_LARGE",
                    format!("return value exceeds {MAX_RESPONSE_BYTES} bytes"),
                ));
            }
            serde_json::from_str(&json).map_err(|error| {
                SidecarError::new(
                    "QUICKJS_CALL_FAILED",
                    format!("invalid JSON return value: {error}"),
                )
            })
        });
        self.runtime.set_interrupt_handler(None);
        match result {
            Err(_) if Instant::now() >= deadline => Err(SidecarError::new(
                "QUICKJS_TIMEOUT",
                format!("{name} timed out"),
            )),
            result => result,
        }
    }

    fn capabilities(&self) -> Result<JsonValue, SidecarError> {
        if !self.loaded {
            return Err(SidecarError::new(
                "QUICKJS_NOT_INITIALIZED",
                "load must complete before capabilities",
            ));
        }
        let exported = self
            .exported
            .as_ref()
            .ok_or_else(|| {
                SidecarError::new("QUICKJS_NOT_INITIALIZED", "default export is unavailable")
            })?
            .clone();
        self.context.with(|ctx| {
            let object = exported
                .restore(&ctx)
                .map_err(|error| SidecarError::new("QUICKJS_STATE_FAILED", format!("{error:?}")))?;
            let mut methods = Map::new();
            for name in [
                "init",
                "home",
                "homeVod",
                "category",
                "search",
                "detail",
                "player",
                "localProxy",
            ] {
                let value: Value = object.get(name).map_err(|error| {
                    SidecarError::new("QUICKJS_STATE_FAILED", format!("{error:?}"))
                })?;
                methods.insert(
                    name.to_string(),
                    JsonValue::Bool(value.type_of() == Type::Function),
                );
            }
            Ok(JsonValue::Object(methods))
        })
    }

    fn close(&mut self) {
        self.exported = None;
        self.loaded = false;
        if let Ok(mut modules) = self.modules.lock() {
            modules.clear();
        }
    }
}

fn classify_js_error(error: JsError, operation: &str) -> SidecarError {
    let message = format!("{error:?}");
    if message.to_ascii_lowercase().contains("interrupt")
        || message.to_ascii_lowercase().contains("timeout")
    {
        SidecarError::new("QUICKJS_TIMEOUT", format!("{operation} timed out"))
    } else {
        SidecarError::new("QUICKJS_SCRIPT_ERROR", format!("{operation}: {message}"))
    }
}

fn install_host_api<'js>(
    ctx: Ctx<'js>,
    allowed_origins: Arc<Mutex<Vec<String>>>,
) -> rquickjs::Result<()> {
    let request_origins = allowed_origins.clone();
    let request = Function::new(ctx.clone(), move |url: String, options: Option<Value>| {
        host_request(&request_origins, &url, options.as_ref())
    })?;
    ctx.globals().set("req", request.clone())?;
    ctx.globals().set("fetch", request)?;

    let post_origins = allowed_origins.clone();
    let post = Function::new(
        ctx.clone(),
        move |url: String, body: Option<Value>, headers: Option<Value>| {
            let body = body.as_ref().map(json_from_js).transpose()?;
            let headers = headers.as_ref().map(json_from_js).transpose()?;
            let options = serde_json::json!({ "method": "POST", "body": body, "headers": headers });
            host_request_json(&post_origins, &url, &options)
        },
    )?;
    ctx.globals().set("post", post)?;

    let encode = Function::new(ctx.clone(), |value: String| BASE64.encode(value.as_bytes()))?;
    let decode = Function::new(ctx.clone(), |value: String| -> rquickjs::Result<String> {
        let bytes = BASE64
            .decode(value)
            .map_err(|_| JsError::new_from_js_message("base64", "string", "invalid base64"))?;
        String::from_utf8(bytes).map_err(|_| {
            JsError::new_from_js_message("base64", "string", "decoded bytes are not UTF-8")
        })
    })?;
    let hash = Function::new(
        ctx.clone(),
        |value: String, algorithm: Option<String>| -> rquickjs::Result<String> {
            hash_text(&value, algorithm.as_deref())
                .map_err(|message| JsError::new_from_js_message("hash", "string", message))
        },
    )?;
    ctx.globals().set("encode", encode)?;
    ctx.globals().set("decode", decode)?;
    ctx.globals().set("hash", hash)?;

    let storage = Object::new(ctx.clone())?;
    let values = Arc::new(Mutex::new(HashMap::<String, String>::new()));
    let get_values = values.clone();
    storage.set(
        "getItem",
        Function::new(
            ctx.clone(),
            move |key: String| -> rquickjs::Result<Option<String>> {
                Ok(get_values
                    .lock()
                    .map_err(|_| JsError::Unknown)?
                    .get(&key)
                    .cloned())
            },
        )?,
    )?;
    let set_values = values.clone();
    storage.set(
        "setItem",
        Function::new(
            ctx.clone(),
            move |key: String, value: String| -> rquickjs::Result<()> {
                set_values
                    .lock()
                    .map_err(|_| JsError::Unknown)?
                    .insert(key, value);
                Ok(())
            },
        )?,
    )?;
    let remove_values = values.clone();
    storage.set(
        "removeItem",
        Function::new(ctx.clone(), move |key: String| -> rquickjs::Result<()> {
            remove_values
                .lock()
                .map_err(|_| JsError::Unknown)?
                .remove(&key);
            Ok(())
        })?,
    )?;
    let clear_values = values;
    storage.set(
        "clear",
        Function::new(ctx.clone(), move || -> rquickjs::Result<()> {
            clear_values.lock().map_err(|_| JsError::Unknown)?.clear();
            Ok(())
        })?,
    )?;
    ctx.globals().set("localStorage", storage)?;

    let console = Object::new(ctx.clone())?;
    for method in ["log", "info", "warn", "error", "debug"] {
        console.set(method, Function::new(ctx.clone(), || {})?)?;
    }
    ctx.globals().set("console", console)?;
    Ok(())
}

fn json_from_js<'js>(value: &Value<'js>) -> rquickjs::Result<JsonValue> {
    let text = value
        .ctx()
        .json_stringify(value.clone())?
        .ok_or_else(|| JsError::new_from_js("value", "JSON"))?
        .to_string()?;
    serde_json::from_str(&text).map_err(|_| JsError::new_from_js("JSON", "value"))
}

fn host_request<'js>(
    origins: &Arc<Mutex<Vec<String>>>,
    url: &str,
    options: Option<&Value<'js>>,
) -> rquickjs::Result<String> {
    let options = options.map(json_from_js).transpose()?;
    host_request_json(
        origins,
        url,
        options.as_ref().unwrap_or(&JsonValue::Object(Map::new())),
    )
}

fn host_request_json(
    origins: &Arc<Mutex<Vec<String>>>,
    url: &str,
    options: &JsonValue,
) -> rquickjs::Result<String> {
    let parsed_url = reqwest::Url::parse(url)
        .map_err(|_| JsError::new_from_js_message("url", "HTTP(S) URL", "invalid URL"))?;
    if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
        return Err(JsError::new_from_js_message(
            "url",
            "HTTP(S) URL",
            "only HTTP(S) URLs are permitted",
        ));
    }
    let allowed = origins.lock().map_err(|_| JsError::Unknown)?.clone();
    if allowed.is_empty()
        || !allowed
            .iter()
            .any(|origin| same_origin(&parsed_url, origin))
    {
        return Err(JsError::new_from_js_message(
            "url",
            "allowed origin",
            "request origin is not allowed",
        ));
    }

    let options = options.as_object();
    let method = options
        .and_then(|value| value.get("method"))
        .and_then(JsonValue::as_str)
        .unwrap_or("GET")
        .to_ascii_uppercase();
    let timeout_ms = options
        .and_then(|value| value.get("timeoutMs").or_else(|| value.get("timeout")))
        .and_then(JsonValue::as_u64)
        .unwrap_or(10_000)
        .clamp(1, EXECUTION_LIMIT.as_millis() as u64);
    let client = Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .user_agent(DEFAULT_USER_AGENT)
        .build()
        .map_err(|error| JsError::new_from_js_message("request", "response", error.to_string()))?;
    let mut request = client.request(
        reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|_| JsError::new_from_js_message("method", "HTTP method", "invalid method"))?,
        parsed_url.clone(),
    );
    if let Some(headers) = options
        .and_then(|value| value.get("headers"))
        .and_then(JsonValue::as_object)
    {
        for (name, value) in headers {
            let Some(value) = value.as_str() else {
                continue;
            };
            let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
                continue;
            };
            let Ok(value) = HeaderValue::from_str(value) else {
                continue;
            };
            request = request.header(name, value);
        }
    }
    if let Some(body) = options.and_then(|value| value.get("body")) {
        if !body.is_null() {
            let body = body
                .as_str()
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| body.to_string());
            request = request.body(body);
        }
    }
    let response = request
        .send()
        .map_err(|error| JsError::new_from_js_message("request", "response", error.to_string()))?;
    let status = response.status().as_u16();
    let response_url = response.url().to_string();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            Some((
                name.to_string(),
                JsonValue::String(value.to_str().ok()?.to_owned()),
            ))
        })
        .collect::<Map<String, JsonValue>>();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(JsError::new_from_js_message(
            "response",
            "bounded response",
            "response exceeds maximum size",
        ));
    }
    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or(0)
            .min(MAX_RESPONSE_BYTES as u64) as usize,
    );
    response
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| JsError::new_from_js_message("response", "text", error.to_string()))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(JsError::new_from_js_message(
            "response",
            "bounded response",
            "response exceeds maximum size",
        ));
    }
    let body = String::from_utf8_lossy(&bytes).into_owned();
    let mut guest = match serde_json::from_str::<JsonValue>(&body) {
        Ok(JsonValue::Object(object)) => object,
        _ => Map::new(),
    };
    guest.insert("url".to_owned(), JsonValue::String(response_url));
    guest.insert("status".to_owned(), JsonValue::from(status));
    guest.insert("headers".to_owned(), JsonValue::Object(headers));
    guest.insert("body".to_owned(), JsonValue::String(body));
    serde_json::to_string(&JsonValue::Object(guest))
        .map_err(|error| JsError::new_from_js_message("response", "string", error.to_string()))
}

fn same_origin(url: &reqwest::Url, allowed: &str) -> bool {
    let Ok(origin) = reqwest::Url::parse(allowed) else {
        return false;
    };
    url.scheme() == origin.scheme()
        && url.host_str() == origin.host_str()
        && url.port_or_known_default() == origin.port_or_known_default()
}

fn hash_text(value: &str, algorithm: Option<&str>) -> Result<String, String> {
    let algorithm = algorithm.unwrap_or("sha256").to_ascii_lowercase();
    let bytes = value.as_bytes();
    let digest = match algorithm.as_str() {
        "sha256" => Sha256::digest(bytes).to_vec(),
        "sha1" => Sha1::digest(bytes).to_vec(),
        "md5" => Md5::digest(bytes).to_vec(),
        _ => return Err(format!("unsupported hash algorithm: {algorithm}")),
    };
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn normalize_module_name(base: &str, name: &str) -> String {
    if name.starts_with("http://") || name.starts_with("https://") || name.starts_with("file://") {
        return name.to_owned();
    }
    if base.starts_with("http://") || base.starts_with("https://") {
        if let Ok(url) = reqwest::Url::parse(base).and_then(|url| url.join(name)) {
            return url.to_string();
        }
    }
    let mut parts = base.split('/').collect::<Vec<_>>();
    parts.pop();
    for part in name.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    parts.join("/")
}

fn handle_request(sidecar: &mut Sidecar, request: Request) -> (Response, bool) {
    let id = request.id.clone();
    let method = request.method.to_ascii_lowercase();
    let result = match method.as_str() {
        "load" => sidecar.load(&request),
        "call" => sidecar.call(&request),
        "capabilities" => sidecar.capabilities(),
        "close" => {
            sidecar.close();
            Ok(serde_json::json!({ "closed": true }))
        }
        _ => Err(SidecarError::invalid(format!(
            "unsupported protocol method: {}",
            request.method
        ))),
    };
    let should_close = method == "close";
    match result {
        Ok(result) => (
            Response {
                id,
                ok: true,
                result: Some(result),
                error: None,
            },
            should_close,
        ),
        Err(error) => (
            Response {
                id,
                ok: false,
                result: None,
                error: Some(ResponseError {
                    code: error.code,
                    message: error.message,
                }),
            },
            false,
        ),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout());
    let mut sidecar =
        Sidecar::new().map_err(|error| format!("{}: {}", error.code, error.message))?;
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request = match serde_json::from_str::<Request>(&line) {
            Ok(request) => request,
            Err(error) => {
                let response = Response {
                    id: JsonValue::Null,
                    ok: false,
                    result: None,
                    error: Some(ResponseError {
                        code: "QUICKJS_INVALID_REQUEST",
                        message: error.to_string(),
                    }),
                };
                serde_json::to_writer(&mut stdout, &response)?;
                stdout.write_all(b"\n")?;
                stdout.flush()?;
                continue;
            }
        };
        let (response, should_close) = handle_request(&mut sidecar, request);
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
        if should_close {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_relative_module_names() {
        assert_eq!(normalize_module_name("qx-entry.mjs", "./dep.js"), "dep.js");
        assert_eq!(normalize_module_name("dir/main.mjs", "../dep.js"), "dep.js");
    }

    #[test]
    fn origin_policy_is_exact() {
        let url = reqwest::Url::parse("https://example.com/api").unwrap();
        assert!(same_origin(&url, "https://example.com"));
        assert!(!same_origin(&url, "https://example.net"));
        assert!(!same_origin(&url, "http://example.com"));
    }

    #[test]
    fn hash_algorithms_are_explicit() {
        assert_eq!(hash_text("fixture", None).unwrap().len(), 64);
        assert_eq!(hash_text("fixture", Some("sha1")).unwrap().len(), 40);
        assert_eq!(hash_text("fixture", Some("md5")).unwrap().len(), 32);
        assert!(hash_text("fixture", Some("blake3")).is_err());
    }
}
