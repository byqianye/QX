use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::AppHandle;

use super::component_manager;
use super::quickjs_bridge;
use super::runtime_capability;
use super::source_session::{SourceCapabilities, SourceSessionSnapshot};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickJsSessionPayload {
    pub action: String,
    pub session_id: String,
    pub source_id: Option<String>,
    pub site_key: Option<String>,
    pub api: Option<String>,
    pub site_type: Option<u8>,
    pub ext: Option<String>,
    pub method: Option<String>,
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickJsSessionResult {
    pub session: SourceSessionSnapshot,
    pub methods: BTreeMap<String, bool>,
    pub method: Option<String>,
    pub result: Option<Value>,
    pub cancelled: bool,
}

#[derive(Debug)]
pub enum QuickJsSessionError {
    Invalid(String),
    Unsupported { code: String, message: String },
    NotFound,
    Component(component_manager::ComponentManagerError),
    Sidecar(quickjs_bridge::QuickJsBridgeError),
    Storage(String),
}

#[derive(Default)]
pub struct QuickJsSessionState {
    sessions: Mutex<HashMap<String, QuickJsSession>>,
}

#[derive(Debug, Clone)]
struct QuickJsSession {
    snapshot: SourceSessionSnapshot,
    methods: BTreeMap<String, bool>,
}

impl QuickJsSessionState {
    pub fn handle(
        &self,
        app: &AppHandle,
        sidecar: &quickjs_bridge::QuickJsSidecarState,
        payload: &QuickJsSessionPayload,
    ) -> Result<QuickJsSessionResult, QuickJsSessionError> {
        if payload.session_id.trim().is_empty() {
            return Err(QuickJsSessionError::Invalid(
                "sessionId is required".to_string(),
            ));
        }
        match payload.action.as_str() {
            "open" => self.open(app, sidecar, payload),
            "call" => self.call(app, sidecar, payload),
            "cancel" => {
                let session = self.get(&payload.session_id)?;
                Ok(result(session, None, None, true))
            }
            "snapshot" => {
                let session = self.get(&payload.session_id)?;
                Ok(result(session, None, None, false))
            }
            "close" => self.close(app, sidecar, payload),
            action => Err(QuickJsSessionError::Invalid(format!(
                "unsupported action: {action}"
            ))),
        }
    }

    fn open(
        &self,
        app: &AppHandle,
        sidecar: &quickjs_bridge::QuickJsSidecarState,
        payload: &QuickJsSessionPayload,
    ) -> Result<QuickJsSessionResult, QuickJsSessionError> {
        let api = payload
            .api
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| QuickJsSessionError::Invalid("api is required".to_string()))?;
        let script = quickjs_script(api, payload.ext.as_deref())?;
        let allowed_origins = quickjs_allowed_origins(&script, payload.ext.as_deref());
        let capability = runtime_capability::probe(&runtime_capability::RuntimeCapabilityPayload {
            api: api.to_string(),
            ext: payload.ext.clone(),
            script_bytes: if is_remote_script(&script) {
                None
            } else {
                Some(script.len() as u64)
            },
            allowed_origins: Some(allowed_origins.clone()),
            artifact_name: None,
            artifact_base64: None,
        });
        if !capability.supported {
            return Err(QuickJsSessionError::Unsupported {
                code: capability.reason_code,
                message: "QuickJS runtime capability is not available".to_string(),
            });
        }

        let (data_directory, _) = super::app_data_paths(app)
            .map_err(|error| QuickJsSessionError::Storage(error.reason_code))?;
        component_manager::handle(
            &data_directory.join("component-manager-v1"),
            &component_manager::ComponentManagerPayload {
                action: "install-default".to_string(),
                component_id: Some("quickjs".to_string()),
                manifest_json: None,
                signature_base64: None,
                public_key_base64: None,
                artifact_base64: None,
                running: None,
            },
        )
        .map_err(QuickJsSessionError::Component)?;

        sidecar
            .handle(
                app,
                quickjs_bridge::QuickJsSidecarPayload {
                    action: "load".to_string(),
                    session_id: payload.session_id.clone(),
                    script: Some(script),
                    module_sources: HashMap::new(),
                    allowed_origins,
                    name: None,
                    args: Vec::new(),
                },
            )
            .map_err(QuickJsSessionError::Sidecar)?;
        let methods_value = match sidecar.handle(
            app,
            quickjs_bridge::QuickJsSidecarPayload {
                action: "capabilities".to_string(),
                session_id: payload.session_id.clone(),
                script: None,
                module_sources: HashMap::new(),
                allowed_origins: Vec::new(),
                name: None,
                args: Vec::new(),
            },
        ) {
            Ok(value) => value,
            Err(error) => {
                let _ = sidecar.handle(
                    app,
                    quickjs_bridge::QuickJsSidecarPayload {
                        action: "close".to_string(),
                        session_id: payload.session_id.clone(),
                        script: None,
                        module_sources: HashMap::new(),
                        allowed_origins: Vec::new(),
                        name: None,
                        args: Vec::new(),
                    },
                );
                return Err(QuickJsSessionError::Sidecar(error));
            }
        };
        let methods = method_map(methods_value)?;
        if methods.get("init").copied().unwrap_or(false) {
            if let Err(error) = sidecar.handle(
                app,
                quickjs_bridge::QuickJsSidecarPayload {
                    action: "call".to_string(),
                    session_id: payload.session_id.clone(),
                    script: None,
                    module_sources: HashMap::new(),
                    allowed_origins: Vec::new(),
                    name: Some("init".to_string()),
                    args: vec![json!(payload.ext.clone().unwrap_or_default())],
                },
            ) {
                let _ = sidecar.handle(
                    app,
                    quickjs_bridge::QuickJsSidecarPayload {
                        action: "close".to_string(),
                        session_id: payload.session_id.clone(),
                        script: None,
                        module_sources: HashMap::new(),
                        allowed_origins: Vec::new(),
                        name: None,
                        args: Vec::new(),
                    },
                );
                return Err(QuickJsSessionError::Sidecar(error));
            }
        }

        let snapshot = SourceSessionSnapshot {
            session_id: payload.session_id.clone(),
            source_id: payload
                .source_id
                .clone()
                .unwrap_or_else(|| payload.session_id.clone()),
            site_key: payload.site_key.clone(),
            api: api.to_string(),
            site_type: payload.site_type.unwrap_or(3),
            state: "ready".to_string(),
            availability_reason: None,
            capabilities: capabilities(&methods),
        };
        let session = QuickJsSession {
            snapshot: snapshot.clone(),
            methods: methods.clone(),
        };
        self.sessions
            .lock()
            .map_err(|_| {
                QuickJsSessionError::Storage("QuickJS session state poisoned".to_string())
            })?
            .insert(payload.session_id.clone(), session);
        Ok(QuickJsSessionResult {
            session: snapshot,
            methods,
            method: None,
            result: None,
            cancelled: false,
        })
    }

    fn call(
        &self,
        app: &AppHandle,
        sidecar: &quickjs_bridge::QuickJsSidecarState,
        payload: &QuickJsSessionPayload,
    ) -> Result<QuickJsSessionResult, QuickJsSessionError> {
        let session = self.get(&payload.session_id)?;
        let requested = payload
            .method
            .as_deref()
            .unwrap_or("home")
            .to_ascii_lowercase();
        let method = if requested == "home"
            && !session.methods.get("home").copied().unwrap_or(false)
            && session.methods.get("homeVod").copied().unwrap_or(false)
        {
            "homeVod".to_string()
        } else {
            requested.clone()
        };
        if !session.methods.get(&method).copied().unwrap_or(false) {
            return Err(QuickJsSessionError::Unsupported {
                code: "TAURI_QUICKJS_UNSUPPORTED_METHOD".to_string(),
                message: requested,
            });
        }
        let value = sidecar
            .handle(
                app,
                quickjs_bridge::QuickJsSidecarPayload {
                    action: "call".to_string(),
                    session_id: payload.session_id.clone(),
                    script: None,
                    module_sources: HashMap::new(),
                    allowed_origins: Vec::new(),
                    name: Some(method.clone()),
                    args: quickjs_args(&method, payload.params.as_ref()),
                },
            )
            .map_err(QuickJsSessionError::Sidecar)?;
        Ok(result(session, Some(method), Some(value), false))
    }

    fn close(
        &self,
        app: &AppHandle,
        sidecar: &quickjs_bridge::QuickJsSidecarState,
        payload: &QuickJsSessionPayload,
    ) -> Result<QuickJsSessionResult, QuickJsSessionError> {
        let session = self.remove(&payload.session_id)?;
        let closed = sidecar
            .handle(
                app,
                quickjs_bridge::QuickJsSidecarPayload {
                    action: "close".to_string(),
                    session_id: payload.session_id.clone(),
                    script: None,
                    module_sources: HashMap::new(),
                    allowed_origins: Vec::new(),
                    name: None,
                    args: Vec::new(),
                },
            )
            .map_err(QuickJsSessionError::Sidecar);
        closed?;
        let mut snapshot = session.snapshot;
        snapshot.state = "closed".to_string();
        Ok(QuickJsSessionResult {
            session: snapshot,
            methods: session.methods,
            method: None,
            result: None,
            cancelled: true,
        })
    }

    fn get(&self, session_id: &str) -> Result<QuickJsSession, QuickJsSessionError> {
        self.sessions
            .lock()
            .map_err(|_| {
                QuickJsSessionError::Storage("QuickJS session state poisoned".to_string())
            })?
            .get(session_id)
            .cloned()
            .ok_or(QuickJsSessionError::NotFound)
    }

    fn remove(&self, session_id: &str) -> Result<QuickJsSession, QuickJsSessionError> {
        self.sessions
            .lock()
            .map_err(|_| {
                QuickJsSessionError::Storage("QuickJS session state poisoned".to_string())
            })?
            .remove(session_id)
            .ok_or(QuickJsSessionError::NotFound)
    }
}

fn result(
    session: QuickJsSession,
    method: Option<String>,
    value: Option<Value>,
    cancelled: bool,
) -> QuickJsSessionResult {
    QuickJsSessionResult {
        session: session.snapshot,
        methods: session.methods,
        method,
        result: value,
        cancelled,
    }
}

fn quickjs_script(api: &str, ext: Option<&str>) -> Result<String, QuickJsSessionError> {
    let api = api.trim();
    if api.to_ascii_lowercase().starts_with("js:") {
        let script = api[3..].trim();
        if script.is_empty() {
            return Err(QuickJsSessionError::Invalid(
                "TAURI_QUICKJS_SCRIPT_REQUIRED".to_string(),
            ));
        }
        return Ok(script.to_string());
    }
    if is_quickjs_url(api) {
        return Ok(api.to_string());
    }
    ext.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| QuickJsSessionError::Invalid("TAURI_QUICKJS_SCRIPT_REQUIRED".to_string()))
}

fn is_quickjs_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://"))
        && (lower.contains(".js") || lower.contains(".mjs"))
}

fn is_remote_script(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

fn quickjs_allowed_origins(script: &str, ext: Option<&str>) -> Vec<String> {
    let mut origins = BTreeMap::new();
    for value in [Some(script), ext].into_iter().flatten() {
        let mut offset = 0;
        while let Some(relative) = value[offset..]
            .find("http://")
            .or_else(|| value[offset..].find("https://"))
        {
            let start = offset + relative;
            let end = value[start..]
                .find(|character: char| {
                    character.is_whitespace()
                        || matches!(character, '"' | '\'' | '\\' | ')' | ']' | '}' | '<' | '>')
                })
                .map(|index| start + index)
                .unwrap_or(value.len());
            if let Ok(url) = reqwest::Url::parse(&value[start..end]) {
                if let Some(host) = url.host_str() {
                    let origin = format!(
                        "{}://{}{}",
                        url.scheme(),
                        host,
                        url.port()
                            .map(|port| format!(":{port}"))
                            .unwrap_or_default()
                    );
                    origins.insert(origin, ());
                }
            }
            offset = end.max(start + 1);
            if offset >= value.len() {
                break;
            }
        }
    }
    origins.into_keys().collect()
}

fn method_map(value: Value) -> Result<BTreeMap<String, bool>, QuickJsSessionError> {
    let object = value.as_object().ok_or_else(|| {
        QuickJsSessionError::Invalid("QuickJS capabilities must be an object".to_string())
    })?;
    Ok(object
        .iter()
        .filter_map(|(name, value)| value.as_bool().map(|enabled| (name.clone(), enabled)))
        .collect())
}

fn capabilities(methods: &BTreeMap<String, bool>) -> SourceCapabilities {
    let home = methods.get("home").copied().unwrap_or(false)
        || methods.get("homeVod").copied().unwrap_or(false);
    SourceCapabilities {
        home,
        category: methods.get("category").copied().unwrap_or(false),
        search: methods.get("search").copied().unwrap_or(false),
        detail: methods.get("detail").copied().unwrap_or(false),
        playback: methods.get("player").copied().unwrap_or(false),
        local_proxy: methods.get("localProxy").copied().unwrap_or(false),
        filters: methods.get("category").copied().unwrap_or(false),
        pagination: methods.get("category").copied().unwrap_or(false)
            || methods.get("search").copied().unwrap_or(false),
        engine: "quickjs".to_string(),
    }
}

fn quickjs_args(method: &str, params: Option<&Value>) -> Vec<Value> {
    let empty = Value::Object(Map::new());
    let value = params.filter(|value| value.is_object()).unwrap_or(&empty);
    match method {
        "init" => vec![json!(string_value(value.get("ext")))],
        "home" | "homeVod" => vec![json!(boolean_value(value.get("filter")))],
        "category" => vec![
            json!(string_value(
                value.get("typeId").or_else(|| value.get("type_id"))
            )),
            json!(number_value(value.get("page"), 1)),
            json!(boolean_value(value.get("filter"))),
            value
                .get("extend")
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| json!({})),
        ],
        "search" => vec![
            json!(string_value(value.get("key").or_else(|| value.get("wd")))),
            json!(boolean_value(value.get("quick"))),
            json!(number_value(value.get("page"), 1)),
        ],
        "detail" => vec![value
            .get("ids")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().map(|id| json!(string_value(Some(id)))).collect())
            .unwrap_or_else(|| vec![json!(string_value(value.get("id")))])
            .into()],
        "player" => vec![
            json!(string_value(value.get("flag"))),
            json!(string_value(value.get("id"))),
            value
                .get("vipFlags")
                .and_then(Value::as_array)
                .map(|flags| {
                    flags
                        .iter()
                        .map(|flag| json!(string_value(Some(flag))))
                        .collect::<Vec<Value>>()
                })
                .unwrap_or_default()
                .into(),
        ],
        _ => Vec::new(),
    }
}

fn string_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.trim().to_string(),
        Some(Value::Null) | None => String::new(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => value.to_string(),
        Some(value) => value.to_string(),
    }
}

fn number_value(value: Option<&Value>, fallback: i64) -> i64 {
    match value {
        Some(Value::Number(value)) => value
            .as_i64()
            .or_else(|| value.as_f64().map(|n| n as i64))
            .unwrap_or(fallback),
        Some(Value::String(value)) => value.trim().parse().unwrap_or(fallback),
        _ => fallback,
    }
}

fn boolean_value(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(value)) => *value,
        Some(Value::Null) | None => false,
        Some(Value::Number(value)) => value.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::{capabilities, quickjs_allowed_origins, quickjs_args, quickjs_script};
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn preserves_quickjs_argument_contract() {
        assert_eq!(
            quickjs_args(
                "category",
                Some(
                    &json!({"type_id": "movie", "page": "2", "filter": true, "extend": {"area": "CN"}})
                ),
            ),
            vec![json!("movie"), json!(2), json!(true), json!({"area": "CN"})]
        );
        assert_eq!(
            quickjs_args("detail", Some(&json!({"ids": [1, "two"]}))),
            vec![json!(["1", "two"])]
        );
    }

    #[test]
    fn derives_capabilities_and_allowed_origins() {
        let mut methods = BTreeMap::new();
        methods.insert("homeVod".to_string(), true);
        methods.insert("player".to_string(), true);
        let caps = capabilities(&methods);
        assert!(caps.home);
        assert!(caps.playback);
        assert_eq!(
            quickjs_allowed_origins(
                "fetch('https://api.example.test/v1')",
                Some("http://media.example.test/a")
            ),
            vec![
                "http://media.example.test".to_string(),
                "https://api.example.test".to_string()
            ]
        );
    }

    #[test]
    fn resolves_inline_and_remote_scripts() {
        assert_eq!(
            quickjs_script("js:export default {}", None).unwrap(),
            "export default {}"
        );
        assert_eq!(
            quickjs_script("https://example.test/source.mjs", None).unwrap(),
            "https://example.test/source.mjs"
        );
        assert!(quickjs_script("js:", None).is_err());
    }
}
