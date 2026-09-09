use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes::Aes128;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Url;
use serde_json::{json, Map, Value};

use super::source_session::{is_loopback_target, read_bounded_response, BoundedResponseError, SourceCapabilities};

type Aes128CbcDecryptor = cbc::Decryptor<Aes128>;
type Aes128CbcEncryptor = cbc::Encryptor<Aes128>;

const API: &str = "csp_appget";
const DEVICE_ID: &str = "2e714ed1a871e3291b797524842448850";
const DEFAULT_USER_AGENT: &str = "okhttp/3.14.9";
const MAX_DISCOVERY_BYTES: usize = 8 * 1024;
const MAX_PARSER_BYTES: usize = 64 * 1024;
const MAX_TOKEN_BYTES: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AppProtocol {
    AppGet,
    AppQi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AppGetTransport {
    Json,
    PythonForm,
}

impl AppProtocol {
    fn for_api(api: &str) -> Option<Self> {
        match api.trim().to_ascii_lowercase().as_str() {
            "csp_appget" => Some(Self::AppGet),
            "csp_appqi" => Some(Self::AppQi),
            _ => None,
        }
    }

    fn path(self, method: &str) -> &'static str {
        match (self, method) {
            (Self::AppGet, "home") => "/api.php/getappapi.index/initV119",
            (Self::AppQi, "home") => "/api.php/qijiappapi.index/initV120",
            (Self::AppGet, "category") => "/api.php/getappapi.index/typeFilterVodList",
            (Self::AppQi, "category") => "/api.php/qijiappapi.index/typeFilterVodList",
            (Self::AppGet, "search") => "/api.php/getappapi.index/searchList",
            (Self::AppQi, "search") => "/api.php/qijiappapi.index/searchList",
            (Self::AppGet, "detail") => "/api.php/getappapi.index/vodDetail",
            (Self::AppQi, "detail") => "/api.php/qijiappapi.index/vodDetail",
            (Self::AppGet, "player") | (Self::AppGet, "playback") => {
                "/api.php/getappapi.index/vodParse"
            }
            (Self::AppQi, "player") | (Self::AppQi, "playback") => {
                "/api.php/qijiappapi.index/vodParse"
            }
            _ => "",
        }
    }

    fn error_prefix(self) -> &'static str {
        match self {
            Self::AppGet => "APPGET",
            Self::AppQi => "APPQI",
        }
    }
}

#[derive(Debug, Clone)]
enum AppGetEndpoint {
    Direct(String),
    Discovery(String),
}

#[derive(Debug, Clone)]
pub struct AppGetConfig {
    protocol: AppProtocol,
    transport: AppGetTransport,
    endpoint: AppGetEndpoint,
    resolved_base_url: Arc<tokio::sync::OnceCell<Result<String, String>>>,
    key: [u8; MAX_TOKEN_BYTES],
    iv: [u8; MAX_TOKEN_BYTES],
    device_id: String,
    version: String,
    user_token: String,
    user_agent: String,
}

#[derive(Debug)]
pub enum AppGetError {
    Unsupported(String),
    Request(String),
}

impl AppGetError {
    fn request(code: impl Into<String>) -> Self {
        Self::Request(code.into())
    }
}

pub fn is_supported(api: &str) -> bool {
    AppProtocol::for_api(api).is_some()
}

/// The public catalog sometimes describes the same fixed AppGet contract as
/// a Python script. Only this exact wrapper shape is admitted to Rust: the
/// script path and the ext object must identify the fixed getappapi contract.
pub fn is_python_wrapper_api(api: &str) -> bool {
    let normalized = api.trim().replace('\\', "/").to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "py/app/getapp.py" | "./py/app/getapp.py"
    )
}

pub fn from_python_wrapper_ext(api: &str, ext: &str) -> Result<Option<AppGetConfig>, String> {
    if !is_python_wrapper_api(api) {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(ext.trim())
        .map_err(|error| format!("APPGET_WRAPPER_EXT_JSON_INVALID:{error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "APPGET_WRAPPER_EXT_INVALID".to_string())?;
    let api_path = object
        .get("api")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| "APPGET_WRAPPER_API_PATH_REQUIRED".to_string())?;
    if api_path != "/api.php/getappapi" {
        return Err("APPGET_WRAPPER_API_PATH_INVALID".to_string());
    }
    let Some(mut config) = from_ext_for("csp_AppGet", ext)? else {
        return Err("APPGET_WRAPPER_CONTRACT_REQUIRED".to_string());
    };
    config.transport = AppGetTransport::PythonForm;
    config.user_agent = "okhttp/3.10.0".to_string();
    Ok(Some(config))
}

/// Parse only the AppGet shapes that carry an AES key. Returning `None` keeps
/// the older bounded CMS fallback available for opaque or incomplete ext data.
pub fn from_ext(ext: &str) -> Result<Option<AppGetConfig>, String> {
    from_ext_for(API, ext)
}

pub fn from_ext_for(api: &str, ext: &str) -> Result<Option<AppGetConfig>, String> {
    let protocol = AppProtocol::for_api(api).ok_or_else(|| format!("{API}_UNSUPPORTED_API"))?;
    let raw = ext.trim();
    if raw.is_empty() {
        return Ok(None);
    }

    if raw.starts_with('{') {
        let value: Value = serde_json::from_str(raw)
            .map_err(|error| format!("{}_EXT_JSON_INVALID:{error}", protocol.error_prefix()))?;
        let Some(object) = value.as_object() else {
            return Ok(None);
        };
        let direct_base =
            first_non_empty_string(object, &["url", "baseUrl", "base_url"]).or_else(|| {
                first_non_empty_string(object, &["host"])
                    .filter(|value| !is_discovery_endpoint(value))
            });
        let discovery_url = first_non_empty_string(object, &["site"]).or_else(|| {
            first_non_empty_string(object, &["host"]).filter(|value| is_discovery_endpoint(value))
        });
        let explicit_key = object
            .get("dataKey")
            .or_else(|| object.get("data_key"))
            .or_else(|| object.get("datakey"));
        let key = if let Some(value) = explicit_key {
            let value = value
                .as_str()
                .ok_or_else(|| format!("{}_KEY_INVALID", protocol.error_prefix()))?;
            if fixed_key(value).is_none() {
                return Err(format!("{}_KEY_INVALID", protocol.error_prefix()));
            }
            Some(value.to_string())
        } else {
            first_string(object, &["key", "token"])
        };
        let explicit_iv = object
            .get("dataIv")
            .or_else(|| object.get("data_iv"))
            .or_else(|| object.get("dataiv"));
        let iv = if let Some(value) = explicit_iv {
            let value = value
                .as_str()
                .ok_or_else(|| format!("{}_IV_INVALID", protocol.error_prefix()))?;
            if fixed_key(value).is_none() {
                return Err(format!("{}_IV_INVALID", protocol.error_prefix()));
            }
            Some(value.to_string())
        } else {
            first_string(object, &["iv"])
        };
        let Some((endpoint, discovery)) = direct_base
            .map(|value| (value, false))
            .or_else(|| discovery_url.map(|value| (value, true)))
        else {
            return Ok(None);
        };
        let Some(key) = key else { return Ok(None) };
        let iv = iv.unwrap_or_else(|| key.clone());
        return build_config(
            protocol,
            AppGetTransport::Json,
            endpoint,
            discovery,
            key,
            iv,
            first_string(object, &["deviceId", "device_id"]),
            first_string(object, &["version", "appVersion", "app_version"]),
            first_string(object, &["userToken", "user_token"]),
            first_string(object, &["ua", "userAgent", "user_agent"]),
        );
    }

    let parts: Vec<&str> = raw.split('|').collect();
    if parts.len() < 2 {
        return Ok(None);
    }
    let endpoint = parts[0].to_string();
    let discovery = is_discovery_endpoint_for(protocol, &endpoint);
    let (version, user_token, user_agent) = match protocol {
        AppProtocol::AppGet => (
            parts.get(2).map(|value| (*value).to_string()),
            parts.get(3).map(|value| (*value).to_string()),
            None,
        ),
        AppProtocol::AppQi => (None, None, parts.get(2).map(|value| (*value).to_string())),
    };
    build_config(
        protocol,
        AppGetTransport::Json,
        endpoint,
        discovery,
        parts[1].to_string(),
        parts[1].to_string(),
        None,
        version,
        user_token,
        user_agent,
    )
}

pub fn capabilities() -> SourceCapabilities {
    capabilities_for(API)
}

pub fn capabilities_for(api: &str) -> SourceCapabilities {
    SourceCapabilities {
        home: true,
        category: true,
        search: true,
        detail: true,
        playback: true,
        local_proxy: false,
        filters: true,
        pagination: true,
        engine: if api.trim().eq_ignore_ascii_case("csp_appqi") {
            "http-appqi".to_string()
        } else {
            "http-appget".to_string()
        },
    }
}

pub async fn call(
    config: &AppGetConfig,
    method: &str,
    params: Option<&Value>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, AppGetError> {
    call_inner(config, method, params, headers, timeout, cancelled)
        .await
        .map_err(|error| protocolize_error(config.protocol, error))
}

async fn call_inner(
    config: &AppGetConfig,
    method: &str,
    params: Option<&Value>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, AppGetError> {
    match method.to_ascii_lowercase().as_str() {
        "home" => {
            let value = request_json(
                config,
                config.protocol.path("home"),
                &json!({}),
                headers,
                timeout,
                cancelled,
            )
            .await?;
            map_home(&value)
        }
        "category" => {
            let page = page_param(params);
            let type_id = params
                .and_then(|value| value.get("typeId"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let value = request_json(
                config,
                &format!("{}?page={page}", config.protocol.path("category")),
                &category_body(params, type_id, page),
                headers,
                timeout,
                cancelled,
            )
            .await?;
            map_list(&value, "recommend_list")
        }
        "search" => {
            let key = params
                .and_then(|value| value.get("key"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if key.is_empty() {
                return Err(AppGetError::request("APPGET_SEARCH_KEY_REQUIRED"));
            }
            let page = page_param(params);
            let value = request_json(
                config,
                config.protocol.path("search"),
                &json!({"type_id": 0, "keywords": key, "page": page}),
                headers,
                timeout,
                cancelled,
            )
            .await?;
            map_list(&value, "search_list")
        }
        "detail" => {
            let id = first_id(params)
                .ok_or_else(|| AppGetError::request("APPGET_DETAIL_ID_REQUIRED"))?;
            let value = request_json_detail(
                config,
                config.protocol.path("detail"),
                &json!({"vod_id": id}),
                headers,
                timeout,
                cancelled,
            )
            .await?;
            map_detail(&value, &id, config)
        }
        "player" | "playback" => play(config, params, headers, timeout, cancelled).await,
        other => Err(AppGetError::Unsupported(format!(
            "{}_METHOD_UNAVAILABLE:{other}",
            config.protocol.error_prefix()
        ))),
    }
}

fn protocolize_error(protocol: AppProtocol, error: AppGetError) -> AppGetError {
    match error {
        AppGetError::Unsupported(message) => {
            AppGetError::Unsupported(protocolize_message(protocol, message))
        }
        AppGetError::Request(message) => {
            AppGetError::Request(protocolize_message(protocol, message))
        }
    }
}

fn protocolize_message(protocol: AppProtocol, message: String) -> String {
    if protocol == AppProtocol::AppGet {
        return message;
    }
    message
        .strip_prefix("APPGET_")
        .map(|suffix| format!("{}_{}", protocol.error_prefix(), suffix))
        .unwrap_or(message)
}

fn build_config(
    protocol: AppProtocol,
    transport: AppGetTransport,
    endpoint: String,
    discovery: bool,
    key: String,
    iv: String,
    device_id: Option<String>,
    version: Option<String>,
    user_token: Option<String>,
    user_agent: Option<String>,
) -> Result<Option<AppGetConfig>, String> {
    let key = match fixed_key(&key) {
        Some(value) => value,
        None => return Ok(None),
    };
    let iv = fixed_key(&iv).ok_or_else(|| format!("{}_IV_INVALID", protocol.error_prefix()))?;
    let endpoint = if discovery {
        valid_discovery_endpoint(&endpoint).map(AppGetEndpoint::Discovery)
    } else {
        valid_endpoint(&endpoint).map(AppGetEndpoint::Direct)
    }
    .ok_or_else(|| format!("{}_ENDPOINT_INVALID", protocol.error_prefix()))?;
    Ok(Some(AppGetConfig {
        protocol,
        transport,
        endpoint,
        resolved_base_url: Arc::new(tokio::sync::OnceCell::new()),
        key,
        iv,
        device_id: device_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEVICE_ID.to_string()),
        version: version.unwrap_or_default(),
        user_token: user_token.unwrap_or_default(),
        user_agent: user_agent
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_USER_AGENT.to_string()),
    }))
}

async fn request_json(
    config: &AppGetConfig,
    path: &str,
    body: &Value,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, AppGetError> {
    request_json_with_method(
        config,
        path,
        reqwest::Method::POST,
        Some(body),
        headers,
        timeout,
        cancelled,
    )
    .await
}

async fn request_json_detail(
    config: &AppGetConfig,
    path: &str,
    body: &Value,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, AppGetError> {
    let result = request_json(config, path, body, headers, timeout, cancelled.clone()).await;
    if let Err(error) = result {
        if is_endpoint_mismatch(&error) {
            if let Some(alternate) = detail_alternate_path(path) {
                return request_json(config, &alternate, body, headers, timeout, cancelled).await;
            }
        }
        return Err(error);
    }
    result
}

async fn request_json_with_method(
    config: &AppGetConfig,
    path: &str,
    method: reqwest::Method,
    body: Option<&Value>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, AppGetError> {
    let result = request_json_once(
        config,
        path,
        method.clone(),
        body,
        headers,
        timeout,
        cancelled.clone(),
    )
    .await;
    if let Err(error) = result {
        if is_endpoint_mismatch(&error) {
            if let Some(alternate) = alternate_path(config.protocol, path) {
                return request_json_once(
                    config, &alternate, method, body, headers, timeout, cancelled,
                )
                .await;
            }
        }
        return Err(error);
    }
    result
}

async fn request_json_once(
    config: &AppGetConfig,
    path: &str,
    method: reqwest::Method,
    body: Option<&Value>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, AppGetError> {
    let base_url = resolve_base_url(config, timeout, cancelled.clone()).await?;
    let url = join_endpoint(base_url, path).ok_or_else(|| {
        AppGetError::request(format!(
            "{}_ENDPOINT_INVALID",
            config.protocol.error_prefix()
        ))
    })?;
    let timestamp = unix_seconds();
    let python_form = config.transport == AppGetTransport::PythonForm;
    let is_home_init = python_form && path.ends_with("/initV119");
    let request_method = if is_home_init {
        reqwest::Method::GET
    } else {
        method
    };
    let mut request_headers = headers.clone();
    strip_appget_headers_for_appqi(config.protocol, &mut request_headers);
    if !is_home_init {
        insert_header(
            &mut request_headers,
            "content-type",
            if python_form {
                "application/x-www-form-urlencoded; charset=UTF-8"
            } else {
                "application/json; charset=utf-8"
            },
        );
    }
    insert_header(&mut request_headers, "user-agent", &config.user_agent);
    if config.protocol == AppProtocol::AppGet && !python_form {
        insert_header(
            &mut request_headers,
            "app-user-device-id",
            &config.device_id,
        );
        insert_header(&mut request_headers, "app-version-code", &config.version);
        insert_header(&mut request_headers, "app-api-verify-time", &timestamp);
        insert_header(&mut request_headers, "app-ui-mode", "light");
        insert_header(&mut request_headers, "app-user-token", &config.user_token);
    }

    let client = build_client(request_headers.clone(), timeout, &url)?;
    let body = if is_home_init {
        String::new()
    } else {
        let body = body.ok_or_else(|| {
            AppGetError::request(format!(
                "{}_JSON_BODY_MISSING",
                config.protocol.error_prefix()
            ))
        })?;
        if python_form {
            encode_form_body(body)?
        } else {
            encode_json_body(body)?
        }
    };
    let request_headers_for_retry = request_headers.clone();
    let request_url = url.clone();
    let request_body = body.clone();
    let (status, bytes) = tokio::select! {
        result = read_query_with_retry(
            &client,
            timeout,
            !is_loopback_target(url.as_str()),
            move |client| {
                client
                    .request(request_method.clone(), request_url.clone())
                    .headers(request_headers_for_retry.clone())
                    .body(request_body.clone())
            },
        ) => result.map_err(|error| AppGetError::request(format!("{}_HTTP_FAILED:{error}", config.protocol.error_prefix())))?,
        _ = wait_for_cancel(cancelled.clone()) => return Err(AppGetError::request(format!("{}_REQUEST_CANCELLED", config.protocol.error_prefix()))),
    };
    if !status.is_success() {
        return Err(AppGetError::request(app_http_status_error(
            config.protocol,
            status,
            &bytes,
        )));
    }
    let envelope: Value = serde_json::from_slice(&bytes)
        .map_err(|error| AppGetError::request(format!("APPGET_ENVELOPE_INVALID:{error}")))?;
    if requires_challenge(&envelope) {
        return Err(AppGetError::request(format!("{}_CHALLENGE_REQUIRED", config.protocol.error_prefix())));
    }
    if looks_like_auth_error(&envelope) {
        return Err(AppGetError::request(format!(
            "{}_AUTH_REQUIRED",
            config.protocol.error_prefix()
        )));
    }
    let data = envelope
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| AppGetError::request("APPGET_ENVELOPE_DATA_MISSING"))?;
    let plain = decrypt_base64(data, &config.key, &config.iv)
        .ok_or_else(|| AppGetError::request("APPGET_DECRYPT_FAILED"))?;
    serde_json::from_str(&plain)
        .map_err(|error| AppGetError::request(format!("APPGET_PAYLOAD_INVALID:{error}")))
}

fn map_home(value: &Value) -> Result<Value, AppGetError> {
    let object = value
        .as_object()
        .ok_or_else(|| AppGetError::request("APPGET_HOME_INVALID"))?;
    let classes = object
        .get("type_list")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(json!({
                        "type_id": item.get("type_id")?.clone(),
                        "type_name": item.get("type_name")?.clone()
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut recommendations = object
        .get("recommend_list")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if recommendations.is_empty() {
        if let Some(type_list) = object.get("type_list").and_then(Value::as_array) {
            for item in type_list {
                if let Some(items) = item.get("recommend_list").and_then(Value::as_array) {
                    recommendations.extend(items.iter().cloned());
                }
            }
        }
    }
    Ok(json!({
        "class": classes,
        "list": map_items(&recommendations),
    }))
}

fn map_list(value: &Value, field: &str) -> Result<Value, AppGetError> {
    let items = value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| AppGetError::request(format!("APPGET_{field}_MISSING")))?;
    Ok(json!({ "list": map_items(items), "total": items.len() }))
}

fn map_items(items: &[Value]) -> Vec<Value> {
    items
        .iter()
        .filter_map(|item| {
            let object = item.as_object()?;
            let id = text(object.get("vod_id"));
            let name = text(object.get("vod_name"));
            if id.is_empty() && name.is_empty() {
                return None;
            }
            Some(json!({
                "vod_id": id,
                "vod_name": name,
                "vod_pic": text(object.get("vod_pic")),
                "vod_remarks": text(object.get("vod_remarks")),
            }))
        })
        .collect()
}

fn map_detail(value: &Value, id: &str, config: &AppGetConfig) -> Result<Value, AppGetError> {
    let vod = value
        .get("vod")
        .and_then(Value::as_object)
        .ok_or_else(|| AppGetError::request("APPGET_DETAIL_VOD_MISSING"))?;
    let name = text(vod.get("vod_name"));
    let mut result = Map::new();
    result.insert("vod_id".to_string(), Value::String(id.to_string()));
    for field in [
        "vod_name",
        "vod_pic",
        "vod_remarks",
        "vod_content",
        "vod_actor",
        "vod_director",
        "vod_class",
    ] {
        result.insert(field.to_string(), Value::String(text(vod.get(field))));
    }

    let mut from = Vec::new();
    let mut urls = Vec::new();
    if let Some(playlists) = value.get("vod_play_list").and_then(Value::as_array) {
        for playlist in playlists {
            let Some(object) = playlist.as_object() else {
                continue;
            };
            let info = object
                .get("player_info")
                .and_then(Value::as_object)
                .unwrap_or(object);
            let line = first_text(info, &["show", "name", "parse"])
                .unwrap_or_else(|| format!("线路{}", from.len() + 1));
            let parser = first_text(info, &["parse", "parse_api"]).unwrap_or_default();
            let player_parse_type =
                first_text(info, &["player_parse_type", "playerParseType"]).unwrap_or_default();
            let episodes = object
                .get("urls")
                .or_else(|| object.get("url_list"))
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let mut line_urls = Vec::new();
            for episode in episodes {
                let Some(ep) = episode.as_object() else {
                    continue;
                };
                let episode_name = first_text(ep, &["name", "title"]).unwrap_or_default();
                let source_url = text(ep.get("url"));
                let parse_api_url = first_text(ep, &["parse_api_url"]);
                let direct = parse_api_url
                    .as_deref()
                    .and_then(direct_media_url)
                    .or_else(|| direct_media_url(&source_url))
                    .or_else(|| parse_api_url.as_deref().and_then(valid_media_url));
                let nid = text(ep.get("nid"));
                let payload = if let Some(url) = direct {
                    format!("{episode_name}${url}|{name}|{nid}")
                } else {
                    if parser.is_empty() || source_url.is_empty() {
                        continue;
                    }
                    let token = text(ep.get("token"));
                    if config.transport == AppGetTransport::PythonForm {
                        format!(
                            "{episode_name}${parser},{source_url},token+{token},{player_parse_type}|{name}|{nid}"
                        )
                    } else {
                        let encrypted = encrypt_base64(&source_url, &config.key, &config.iv)
                            .ok_or_else(|| AppGetError::request("APPGET_PLAY_TOKEN_FAILED"))?;
                        format!(
                            "{episode_name}$parse_api={parser}&url={encrypted}&token={token}|{name}|{nid}"
                        )
                    }
                };
                line_urls.push(payload);
            }
            if !line_urls.is_empty() {
                let line = if config.protocol == AppProtocol::AppQi {
                    unique_line_name(&from, line)
                } else {
                    line
                };
                from.push(line);
                urls.push(line_urls.join("#"));
            }
        }
    }
    if !from.is_empty() {
        result.insert("vod_play_from".to_string(), Value::String(from.join("$$$")));
        result.insert("vod_play_url".to_string(), Value::String(urls.join("$$$")));
    }
    Ok(Value::Object(result))
}

async fn play(
    config: &AppGetConfig,
    params: Option<&Value>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, AppGetError> {
    let raw = params
        .and_then(|value| value.get("id").or_else(|| value.get("url")))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if raw.is_empty() {
        return Err(AppGetError::request("APPGET_PLAYER_ID_REQUIRED"));
    }
    let first = raw.split('|').next().unwrap_or(raw);
    let payload = first
        .split_once('$')
        .map(|(_, value)| value)
        .unwrap_or(first);
    if let Some(url) = direct_media_url(payload) {
        return Ok(player_result(config, url));
    }
    if is_bounded_parser_url(payload) {
        let url = request_bounded_parser_url(payload, headers, timeout, cancelled).await?;
        return Ok(player_result(config, url));
    }
    if config.transport == AppGetTransport::PythonForm {
        let (parser, source_url, token, player_parse_type) = parse_python_episode(payload)
            .ok_or_else(|| {
                AppGetError::Unsupported("APPGET_PYTHON_PLAYER_FORMAT_UNSUPPORTED".to_string())
            })?;
        let encrypted = encrypt_base64(&source_url, &config.key, &config.iv)
            .ok_or_else(|| AppGetError::request("APPGET_PLAY_TOKEN_FAILED"))?;
        let body = encode_form_body(&json!({
            "parse_api": parser,
            "url": encrypted,
            "player_parse_type": player_parse_type,
            "token": token,
        }))?;
        let value = request_raw_player(config, &body, headers, timeout, cancelled).await?;
        let url = extract_player_url(&value)
            .ok_or_else(|| AppGetError::request("APPGET_PLAYER_MEDIA_URL_MISSING"))?;
        return Ok(player_result(config, url));
    }
    if requires_dynamic_player(payload) {
        return Err(AppGetError::Unsupported(
            "APPGET_DYNAMIC_PLAYER_UNSUPPORTED".to_string(),
        ));
    }
    let request_bodies = if valid_media_url(payload).is_some() {
        vec![payload.to_string()]
    } else {
        let query = payload
            .split('#')
            .next()
            .unwrap_or(payload)
            .trim_start_matches('$');
        if !query.starts_with("parse_api=") {
            return Err(AppGetError::Unsupported(
                "APPGET_DYNAMIC_PLAYER_UNSUPPORTED".to_string(),
            ));
        }
        let encoded = encode_player_url_parameter(query)?;
        let prefixed = format!("${encoded}");
        match config.protocol {
            AppProtocol::AppGet => vec![encoded, prefixed],
            AppProtocol::AppQi => vec![prefixed, encoded],
        }
    };
    let mut last_error = None;
    for (index, request_body) in request_bodies.iter().enumerate() {
        let value =
            match request_raw_player(config, request_body, headers, timeout, cancelled.clone())
                .await
            {
                Ok(value) => value,
                Err(error)
                    if index + 1 < request_bodies.len() && is_player_form_mismatch(&error) =>
                {
                    last_error = Some(error);
                    continue;
                }
                Err(error) => return Err(error),
            };
        if let Some(url) = extract_player_url(&value) {
            return Ok(player_result(config, url));
        }
        let error = AppGetError::request("APPGET_PLAYER_MEDIA_URL_MISSING");
        if index + 1 < request_bodies.len() {
            last_error = Some(error);
            continue;
        }
        return Err(error);
    }
    Err(last_error.unwrap_or_else(|| AppGetError::request("APPGET_PLAYER_MEDIA_URL_MISSING")))
}

fn parse_python_episode(value: &str) -> Option<(String, String, String, String)> {
    let mut parts = value.splitn(4, ',');
    let parser = parts.next()?.trim();
    let source_url = parts.next()?.trim();
    let token = parts.next()?.trim().strip_prefix("token+")?;
    let player_parse_type = parts.next()?.trim();
    if parser.is_empty() || player_parse_type.is_empty() || valid_media_url(source_url).is_none() {
        return None;
    }
    Some((
        parser.to_string(),
        source_url.to_string(),
        token.to_string(),
        player_parse_type.to_string(),
    ))
}

fn player_result(config: &AppGetConfig, url: String) -> Value {
    let header = if config.transport == AppGetTransport::PythonForm {
        json!({
            "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 14; 23113RK12C Build/SKQ1.231004.001)"
        })
    } else {
        json!({})
    };
    json!({"parse": 0, "jx": 0, "url": url, "header": header})
}

fn is_player_form_mismatch(error: &AppGetError) -> bool {
    matches!(
        error,
        AppGetError::Request(message)
            if message == "APPGET_ENVELOPE_DATA_MISSING"
                || message == "APPGET_DECRYPT_FAILED"
                || message.starts_with("APPGET_PAYLOAD_INVALID:")
    )
}

fn encode_player_url_parameter(value: &str) -> Result<String, AppGetError> {
    let Some(url_start) = value.find("url=").map(|index| index + 4) else {
        return Err(AppGetError::request("APPGET_PLAYER_URL_MISSING"));
    };
    let Some(token_offset) = value[url_start..].find("&token") else {
        return Err(AppGetError::request("APPGET_PLAYER_TOKEN_MISSING"));
    };
    let url_end = url_start + token_offset;
    if url_start == url_end {
        return Err(AppGetError::request("APPGET_PLAYER_URL_MISSING"));
    }
    let mut encoded = String::with_capacity(value.len() + 16);
    encoded.push_str(&value[..url_start]);
    for byte in value[url_start..url_end].bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => {
                encoded.push(char::from(byte));
            }
            b' ' => encoded.push('+'),
            _ => {
                const HEX: &[u8; 16] = b"0123456789ABCDEF";
                encoded.push('%');
                encoded.push(char::from(HEX[(byte >> 4) as usize]));
                encoded.push(char::from(HEX[(byte & 0x0f) as usize]));
            }
        }
    }
    encoded.push_str(&value[url_end..]);
    Ok(encoded)
}

fn direct_media_url(value: &str) -> Option<String> {
    let url = valid_media_url(value)?;
    let lower = Url::parse(&url).ok()?.path().to_ascii_lowercase();
    [".m3u8", ".mp4", ".mkv", ".webm", ".mov", ".flv"]
        .iter()
        .any(|suffix| lower.ends_with(suffix))
        .then_some(url)
}

fn requires_dynamic_player(value: &str) -> bool {
    let Ok(url) = Url::parse(value.trim()) else {
        return false;
    };
    let path = url.path().to_ascii_lowercase();
    path.ends_with(".html")
        || path.ends_with(".htm")
        || url
            .query_pairs()
            .any(|(name, _)| name.eq_ignore_ascii_case("url") || name.eq_ignore_ascii_case("key"))
}

fn is_bounded_parser_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value.trim()) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https")
        || url.username() != ""
        || url.password().is_some()
        || !url.path().eq_ignore_ascii_case("/wmm.php")
    {
        return false;
    }
    let mut has_key = false;
    let mut has_api = false;
    let mut has_url = false;
    for (name, value) in url.query_pairs() {
        match name.to_ascii_lowercase().as_str() {
            "key" if !value.trim().is_empty() && value.len() <= 256 => has_key = true,
            "api" if !value.trim().is_empty() && value.len() <= 32 => has_api = true,
            "url" if !value.trim().is_empty() && value.len() <= 4096 => has_url = true,
            _ => {}
        }
    }
    has_key && has_api && has_url
}

async fn request_bounded_parser_url(
    value: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<String, AppGetError> {
    let url =
        Url::parse(value.trim()).map_err(|_| AppGetError::request("APPGET_PARSER_URL_INVALID"))?;
    let client = super::source_session::client_builder_for_url(reqwest::Client::builder(), value)
        .default_headers(headers.clone())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|error| AppGetError::request(format!("APPGET_PARSER_CLIENT_FAILED:{error}")))?;
    let request_headers = headers.clone();
    let response = tokio::select! {
        result = send_with_direct_retry(
            &client,
            timeout,
            !is_loopback_target(url.as_str()),
            move |client| client.get(url.clone()).headers(request_headers.clone()),
        ) => result.map_err(|error| AppGetError::request(format!("APPGET_PARSER_HTTP_FAILED:{error}")))?,
        _ = wait_for_cancel(cancelled.clone()) => return Err(AppGetError::request("APPGET_REQUEST_CANCELLED")),
    };
    let status = response.status();
    if !status.is_success() {
        return Err(AppGetError::request(format!(
            "APPGET_PARSER_HTTP_STATUS:{}",
            status.as_u16()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PARSER_BYTES as u64)
    {
        return Err(AppGetError::request("APPGET_PARSER_RESPONSE_TOO_LARGE"));
    }
    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or(0)
            .min(MAX_PARSER_BYTES as u64) as usize,
    );
    let mut response = response;
    while let Some(chunk) = tokio::select! {
        result = response.chunk() => result.map_err(|error| AppGetError::request(format!("APPGET_PARSER_READ_FAILED:{error}")))?,
        _ = wait_for_cancel(cancelled.clone()) => return Err(AppGetError::request("APPGET_REQUEST_CANCELLED")),
    } {
        if chunk.len() > MAX_PARSER_BYTES.saturating_sub(bytes.len()) {
            return Err(AppGetError::request("APPGET_PARSER_RESPONSE_TOO_LARGE"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice::<Value>(&bytes)
        .map_err(|error| AppGetError::request(format!("APPGET_PARSER_RESPONSE_INVALID:{error}")))?;
    extract_player_url(&value)
        .ok_or_else(|| AppGetError::request("APPGET_PARSER_MEDIA_URL_MISSING"))
}

fn extract_player_url(value: &Value) -> Option<String> {
    let direct = value
        .pointer("/json/url")
        .or_else(|| value.pointer("/data/url"))
        .or_else(|| value.get("url"))
        .and_then(Value::as_str)
        .and_then(valid_media_url);
    if direct.is_some() {
        return direct;
    }
    for field in ["json", "data"] {
        let Some(raw) = value.get(field).and_then(Value::as_str) else {
            continue;
        };
        let nested: Value = serde_json::from_str(raw).ok()?;
        if let Some(url) = nested
            .get("url")
            .and_then(Value::as_str)
            .and_then(valid_media_url)
        {
            return Some(url);
        }
    }
    None
}

/*
 * AppGet's other dynamic branches execute arbitrary parser pages or inspect
 * redirect headers. They stay outside this adapter: only the fixed vodParse
 * endpoint above is allowed to turn a non-media value into a playback URL.
 */
async fn request_raw_player(
    config: &AppGetConfig,
    body: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, AppGetError> {
    let path = config.protocol.path("player");
    let result =
        request_raw_player_once(config, path, body, headers, timeout, cancelled.clone()).await;
    if let Err(error) = result {
        if is_endpoint_mismatch(&error) {
            if let Some(alternate) = alternate_path(config.protocol, path) {
                return request_raw_player_once(
                    config, &alternate, body, headers, timeout, cancelled,
                )
                .await;
            }
        }
        return Err(error);
    }
    result
}

async fn request_raw_player_once(
    config: &AppGetConfig,
    path: &str,
    body: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, AppGetError> {
    let base_url = resolve_base_url(config, timeout, cancelled.clone()).await?;
    let url = join_endpoint(base_url, path).ok_or_else(|| {
        AppGetError::request(format!(
            "{}_ENDPOINT_INVALID",
            config.protocol.error_prefix()
        ))
    })?;
    let timestamp = unix_seconds();
    let mut request_headers = headers.clone();
    strip_appget_headers_for_appqi(config.protocol, &mut request_headers);
    insert_header(
        &mut request_headers,
        "content-type",
        "application/x-www-form-urlencoded",
    );
    insert_header(&mut request_headers, "user-agent", &config.user_agent);
    if config.protocol == AppProtocol::AppGet && config.transport == AppGetTransport::Json {
        let signature = encrypt_base64(&timestamp, &config.key, &config.iv)
            .ok_or_else(|| AppGetError::request("APPGET_SIGN_FAILED"))?;
        for (name, value) in [
            ("connection", "keep-alive".to_string()),
            ("app-version-code", config.version.clone()),
            ("app-ui-mode", "light".to_string()),
            ("app-user-device-id", config.device_id.clone()),
            ("app-api-verify-time", timestamp.clone()),
            ("app-api-verify-sign", signature),
        ] {
            insert_header(&mut request_headers, name, &value);
        }
    }
    let client = build_client(request_headers.clone(), timeout, &url)?;
    let request_headers_for_retry = request_headers.clone();
    let request_url = url.clone();
    let request_body = body.to_string();
    let (status, bytes) = tokio::select! {
        result = read_query_with_retry(
            &client,
            timeout,
            !is_loopback_target(url.as_str()),
            move |client| {
                client
                    .post(request_url.clone())
                    .headers(request_headers_for_retry.clone())
                    .body(request_body.clone())
            },
        ) => result.map_err(|error| AppGetError::request(format!("{}_HTTP_FAILED:{error}", config.protocol.error_prefix())))?,
        _ = wait_for_cancel(cancelled.clone()) => return Err(AppGetError::request(format!("{}_REQUEST_CANCELLED", config.protocol.error_prefix()))),
    };
    if !status.is_success() {
        return Err(AppGetError::request(app_http_status_error(
            config.protocol,
            status,
            &bytes,
        )));
    }
    let envelope: Value = serde_json::from_slice(&bytes)
        .map_err(|error| AppGetError::request(format!("APPGET_ENVELOPE_INVALID:{error}")))?;
    if requires_challenge(&envelope) {
        return Err(AppGetError::request(format!("{}_CHALLENGE_REQUIRED", config.protocol.error_prefix())));
    }
    if looks_like_auth_error(&envelope) {
        return Err(AppGetError::request(format!(
            "{}_AUTH_REQUIRED",
            config.protocol.error_prefix()
        )));
    }
    let data = envelope
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| AppGetError::request("APPGET_ENVELOPE_DATA_MISSING"))?;
    let plain = decrypt_base64(data, &config.key, &config.iv)
        .ok_or_else(|| AppGetError::request("APPGET_DECRYPT_FAILED"))?;
    serde_json::from_str(&plain)
        .map_err(|error| AppGetError::request(format!("APPGET_PAYLOAD_INVALID:{error}")))
}

fn alternate_path(protocol: AppProtocol, path: &str) -> Option<String> {
    if protocol != AppProtocol::AppQi {
        return None;
    }
    if path == "/api.php/qijiappapi.index/initV120" {
        return Some("/api.php/getappapi.index/initV119".to_string());
    }
    path.strip_prefix("/api.php/qijiappapi.index/")
        .map(|suffix| format!("/api.php/getappapi.index/{suffix}"))
}

fn detail_alternate_path(path: &str) -> Option<String> {
    path.strip_suffix("/vodDetail")
        .map(|prefix| format!("{prefix}/vodDetail2"))
}

fn is_endpoint_mismatch(error: &AppGetError) -> bool {
    matches!(
        error,
        AppGetError::Request(message)
            if message.contains("_HTTP_STATUS:404") || message.contains("_HTTP_STATUS:405")
    )
}

fn app_http_status_error(
    protocol: AppProtocol,
    status: reqwest::StatusCode,
    body: &[u8],
) -> String {
    let hint = upstream_error_hint(body)
        .map(|value| format!(":{value}"))
        .unwrap_or_default();
    format!(
        "{}_HTTP_STATUS:{}{hint}",
        protocol.error_prefix(),
        status.as_u16()
    )
}

/// Keep upstream diagnostics stable and bounded. Never return the remote HTML
/// or its exception text through the source-session error contract.
fn upstream_error_hint(body: &[u8]) -> Option<&'static str> {
    let sample = String::from_utf8_lossy(&body[..body.len().min(4096)]).to_ascii_lowercase();
    (sample.contains("connection refused")
        || sample.contains("localhost:8384")
        || sample.contains("c#111"))
    .then_some("UPSTREAM_BACKEND_UNAVAILABLE")
}

fn requires_challenge(value: &Value) -> bool {
    value.get("need_slider").is_some_and(|v| v.as_bool() == Some(true) || v.as_i64() == Some(1))
        || (value.get("code").and_then(Value::as_i64) == Some(1001)
            && value.get("msg").and_then(Value::as_str).is_some_and(|message| message.contains("滑块验证")))
}

fn looks_like_auth_error(value: &Value) -> bool {
    let code = value.get("code").and_then(Value::as_i64);
    let message = value
        .get("msg")
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    code == Some(0)
        && ["登录", "login", "unauthorized", "auth", "token"]
            .iter()
            .any(|marker| message.contains(marker))
}

fn first_string(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(Value::as_str))
        .map(str::to_string)
}

fn first_non_empty_string(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        object.get(*key).and_then(Value::as_str).and_then(|value| {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        })
    })
}

fn first_text(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .map(|key| text(object.get(*key)))
        .find(|value| !value.is_empty())
}

fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}

/// AppGet/AppQi read endpoints accept a compact JSON request body. Keep the
/// serialization at this boundary so the protocol cannot silently drift back
/// to a generic form encoder.
fn encode_json_body(body: &Value) -> Result<String, AppGetError> {
    serde_json::to_string(body)
        .map_err(|error| AppGetError::request(format!("APPGET_JSON_BODY_INVALID:{error}")))
}

fn encode_form_body(body: &Value) -> Result<String, AppGetError> {
    let object = body
        .as_object()
        .ok_or_else(|| AppGetError::request("APPGET_FORM_BODY_INVALID"))?;
    let mut encoded = String::new();
    for (index, (key, value)) in object.iter().enumerate() {
        if index > 0 {
            encoded.push('&');
        }
        append_form_component(&mut encoded, key);
        encoded.push('=');
        let value = match value {
            Value::String(value) => value.clone(),
            Value::Number(value) => value.to_string(),
            Value::Bool(value) => value.to_string(),
            Value::Null => String::new(),
            _ => return Err(AppGetError::request("APPGET_FORM_BODY_INVALID")),
        };
        append_form_component(&mut encoded, &value);
    }
    Ok(encoded)
}

fn append_form_component(output: &mut String, value: &str) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => {
                output.push(char::from(byte));
            }
            b' ' => output.push('+'),
            _ => {
                output.push('%');
                output.push(char::from(HEX[(byte >> 4) as usize]));
                output.push(char::from(HEX[(byte & 0x0f) as usize]));
            }
        }
    }
}

fn first_id(params: Option<&Value>) -> Option<String> {
    params
        .and_then(|value| value.get("ids").or_else(|| value.get("id")))
        .and_then(|value| {
            value
                .as_array()
                .and_then(|values| values.first())
                .or(Some(value))
        })
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
}

fn category_body(params: Option<&Value>, type_id: &str, page: u64) -> Value {
    json!({
        "area": category_filter(params, &["area"], "全部"),
        "year": category_filter(params, &["year"], "全部"),
        "type_id": type_id,
        "page": page,
        "sort": category_filter(params, &["sort", "by"], "最新"),
        "lang": category_filter(params, &["lang"], "全部"),
        "class": category_filter(params, &["class", "type"], "全部"),
    })
}

fn category_filter(params: Option<&Value>, keys: &[&str], default: &str) -> String {
    let filter = params.and_then(|value| {
        value
            .get("filter")
            .or_else(|| value.get("extend"))
            .and_then(Value::as_object)
    });
    keys.iter()
        .find_map(|key| {
            filter
                .and_then(|value| value.get(*key))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            keys.iter().find_map(|key| {
                params
                    .and_then(|value| value.get(*key))
                    .and_then(Value::as_str)
            })
        })
        .unwrap_or(default)
        .to_string()
}

fn page_param(params: Option<&Value>) -> u64 {
    params
        .and_then(|value| value.get("page"))
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .clamp(1, 10_000)
}

fn fixed_key(value: &str) -> Option<[u8; MAX_TOKEN_BYTES]> {
    let bytes = value.as_bytes();
    if bytes.len() != MAX_TOKEN_BYTES {
        return None;
    }
    let mut output = [0_u8; MAX_TOKEN_BYTES];
    output.copy_from_slice(bytes);
    Some(output)
}

fn valid_endpoint(value: &str) -> Option<String> {
    let mut url = Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string().trim_end_matches('/').to_string())
}

fn valid_discovery_endpoint(value: &str) -> Option<String> {
    let mut url = Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_fragment(None);
    Some(url.to_string())
}

fn is_discovery_endpoint(value: &str) -> bool {
    let Ok(url) = Url::parse(value.trim()) else {
        return false;
    };
    let path = url.path().trim_end_matches('/').to_ascii_lowercase();
    path.ends_with(".txt") || path.ends_with(".json")
}

fn is_discovery_endpoint_for(protocol: AppProtocol, value: &str) -> bool {
    if protocol != AppProtocol::AppQi {
        return is_discovery_endpoint(value);
    }
    Url::parse(value.trim())
        .ok()
        .is_some_and(|url| !url.path().trim_matches('/').is_empty())
}

fn unique_line_name(existing: &[String], requested: String) -> String {
    if !existing.iter().any(|value| value == &requested) {
        return requested;
    }
    let mut suffix = 1_usize;
    loop {
        let candidate = format!("{requested}+{suffix}");
        if !existing.iter().any(|value| value == &candidate) {
            return candidate;
        }
        suffix += 1;
    }
}

async fn resolve_base_url<'a>(
    config: &'a AppGetConfig,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<&'a str, AppGetError> {
    match &config.endpoint {
        AppGetEndpoint::Direct(base_url) => Ok(base_url),
        AppGetEndpoint::Discovery(discovery_url) => {
            let resolved = config
                .resolved_base_url
                .get_or_init(|| async {
                    discover_base_url(discovery_url, &config.user_agent, timeout, cancelled).await
                })
                .await;
            resolved
                .as_deref()
                .map_err(|message| AppGetError::request(message.clone()))
        }
    }
}

async fn discover_base_url(
    discovery_url: &str,
    user_agent: &str,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<String, String> {
    let client =
        super::source_session::client_builder_for_url(reqwest::Client::builder(), discovery_url)
            .user_agent(user_agent)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout)
            .build()
            .map_err(|error| format!("APPGET_DISCOVERY_CLIENT_FAILED:{error}"))?;
    let user_agent = user_agent.to_string();
    let response = tokio::select! {
        result = send_with_direct_retry(
            &client,
            timeout,
            !is_loopback_target(discovery_url),
            move |client| {
                client
                    .get(discovery_url)
                    .header(reqwest::header::USER_AGENT, user_agent.clone())
            },
        ) => result.map_err(|error| format!("APPGET_DISCOVERY_HTTP_FAILED:{error}"))?,
        _ = wait_for_cancel(cancelled.clone()) => return Err("APPGET_REQUEST_CANCELLED".to_string()),
    };
    let status = response.status();
    if !status.is_success() {
        return Err(format!("APPGET_DISCOVERY_HTTP_STATUS:{}", status.as_u16()));
    }
    let bytes = tokio::select! {
        result = read_discovery_response(response) => result?,
        _ = wait_for_cancel(cancelled) => return Err("APPGET_REQUEST_CANCELLED".to_string()),
    };
    match parse_discovery_response(&bytes) {
        Ok(endpoint) => Ok(endpoint),
        Err(error) if is_ok_discovery_marker(&bytes) => {
            discovery_origin(discovery_url).ok_or_else(|| error.to_string())
        }
        Err(error) => Err(error),
    }
}

fn is_ok_discovery_marker(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes)
        .ok()
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("ok"))
}

fn discovery_origin(value: &str) -> Option<String> {
    let mut url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    valid_endpoint(url.as_str())
}

async fn read_discovery_response(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DISCOVERY_BYTES as u64)
    {
        return Err("APPGET_DISCOVERY_RESPONSE_TOO_LARGE".to_string());
    }
    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or(0)
            .min(MAX_DISCOVERY_BYTES as u64) as usize,
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("APPGET_DISCOVERY_READ_FAILED:{error}"))?
    {
        if chunk.len() > MAX_DISCOVERY_BYTES.saturating_sub(bytes.len()) {
            return Err("APPGET_DISCOVERY_RESPONSE_TOO_LARGE".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn parse_discovery_response(bytes: &[u8]) -> Result<String, String> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| "APPGET_DISCOVERY_UTF8_INVALID".to_string())?;
    let text = text.trim_start_matches('\u{feff}').trim();
    if text.is_empty() {
        return Err("APPGET_DISCOVERY_EMPTY".to_string());
    }
    let candidate = if text.starts_with('{') || text.starts_with('[') || text.starts_with('"') {
        let value: Value = serde_json::from_str(text)
            .map_err(|error| format!("APPGET_DISCOVERY_JSON_INVALID:{error}"))?;
        match value {
            Value::String(value) => value,
            Value::Object(object) => first_non_empty_string(&object, &["url"])
                .ok_or_else(|| "APPGET_DISCOVERY_URL_MISSING".to_string())?,
            _ => return Err("APPGET_DISCOVERY_JSON_INVALID".to_string()),
        }
    } else {
        let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
        let first = lines
            .next()
            .ok_or_else(|| "APPGET_DISCOVERY_EMPTY".to_string())?;
        if lines.next().is_some() {
            return Err("APPGET_DISCOVERY_MULTIPLE_URLS".to_string());
        }
        first.to_string()
    };
    let endpoint =
        valid_endpoint(&candidate).ok_or_else(|| "APPGET_DISCOVERY_URL_INVALID".to_string())?;
    if is_discovery_endpoint(&endpoint) {
        return Err("APPGET_DISCOVERY_NESTED".to_string());
    }
    Ok(endpoint)
}

fn join_endpoint(base: &str, path: &str) -> Option<Url> {
    let mut url = Url::parse(base).ok()?;
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let base_path = url.path().trim_end_matches('/');
    let path = path.trim_start_matches('/');
    url.set_path(&format!("{base_path}/{path}"));
    url.set_query((!query.is_empty()).then_some(query));
    url.set_fragment(None);
    Some(url)
}

fn build_client(
    headers: HeaderMap,
    timeout: Duration,
    url: &Url,
) -> Result<reqwest::Client, AppGetError> {
    super::source_session::client_builder_for_url(reqwest::Client::builder(), url.as_str())
        .default_headers(headers)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|error| AppGetError::request(format!("APPGET_CLIENT_FAILED:{error}")))
}

/// Source queries are read-only even when sent as POST. Retry a truncated
/// successful response once through the same route, preserving its signature.
/// Size limits, cancellation and the enclosing source-call deadline still apply.
async fn read_query_with_retry<F>(
    client: &reqwest::Client,
    timeout: Duration,
    direct_retry_allowed: bool,
    build: F,
) -> Result<(reqwest::StatusCode, Vec<u8>), String>
where
    F: Fn(&reqwest::Client) -> reqwest::RequestBuilder,
{
    let response = send_with_direct_retry(client, timeout, direct_retry_allowed, &build).await?;
    let status = response.status();
    match read_bounded_response(response).await {
        Ok(bytes) => Ok((status, bytes)),
        Err(BoundedResponseError::Request(_)) if status.is_success() => {
            let retry = build(client).send().await.map_err(|error| error.to_string())?;
            let status = retry.status();
            let bytes = read_bounded_response(retry).await
                .map_err(|error| error.message("APPGET_RESPONSE_TOO_LARGE"))?;
            Ok((status, bytes))
        }
        Err(error) => Err(error.message("APPGET_RESPONSE_TOO_LARGE")),
    }
}

/// Retry a failed external request once without the environment proxy. The
/// URL, method, headers, and body stay unchanged; HTTPS is never downgraded.
/// A retry is attempted only for transport failures or proxy-style 502/503
/// responses, so healthy requests pay no extra network cost.
async fn send_with_direct_retry<F>(
    client: &reqwest::Client,
    timeout: Duration,
    retry_allowed: bool,
    build: F,
) -> Result<reqwest::Response, String>
where
    F: Fn(&reqwest::Client) -> reqwest::RequestBuilder,
{
    let first = build(client).send().await;
    // A peer may close an established connection before returning headers.
    // These are read-only queries; retry once through the same configured route.
    // Do not retry successful HTTP responses (including auth/challenge errors).
    if first.as_ref().is_err_and(|error| error.is_request() && !error.is_connect() && !error.is_timeout()) {
        return build(client).send().await.map_err(|error| error.to_string());
    }
    let should_retry = match &first {
        Ok(response) => matches!(
            response.status(),
            reqwest::StatusCode::BAD_GATEWAY | reqwest::StatusCode::SERVICE_UNAVAILABLE
        ),
        Err(error) => error.is_connect() || error.is_timeout(),
    };
    if !retry_allowed || !should_retry {
        return first.map_err(|error| error.to_string());
    }

    let first_description = match &first {
        Ok(response) => format!("HTTP {}", response.status()),
        Err(error) => error.to_string(),
    };

    let direct = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|error| format!("{first_description}; direct retry client failed: {error}"))?;
    build(&direct)
        .send()
        .await
        .map_err(|error| format!("{first_description}; direct retry failed: {error}"))
}

fn valid_media_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.len() > 4096 {
        return None;
    }
    let url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url.to_string())
}

fn unix_seconds() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn insert_header(headers: &mut HeaderMap, name: &str, value: &str) {
    if let (Ok(name), Ok(value)) = (
        HeaderName::from_bytes(name.as_bytes()),
        HeaderValue::from_str(value),
    ) {
        headers.insert(name, value);
    }
}

fn strip_appget_headers_for_appqi(protocol: AppProtocol, headers: &mut HeaderMap) {
    if protocol != AppProtocol::AppQi {
        return;
    }
    for name in [
        "app-user-device-id",
        "app-version-code",
        "app-api-verify-time",
        "app-api-verify-sign",
        "app-ui-mode",
        "app-user-token",
    ] {
        headers.remove(name);
    }
}

fn encrypt_base64(
    value: &str,
    key: &[u8; MAX_TOKEN_BYTES],
    iv: &[u8; MAX_TOKEN_BYTES],
) -> Option<String> {
    let mut buffer = vec![0_u8; value.len() + 16];
    buffer[..value.len()].copy_from_slice(value.as_bytes());
    let encrypted = Aes128CbcEncryptor::new(key.into(), iv.into())
        .encrypt_padded_mut::<Pkcs7>(&mut buffer, value.len())
        .ok()?;
    Some(STANDARD.encode(encrypted))
}

fn decrypt_base64(
    value: &str,
    key: &[u8; MAX_TOKEN_BYTES],
    iv: &[u8; MAX_TOKEN_BYTES],
) -> Option<String> {
    let mut bytes = STANDARD.decode(value.trim()).ok()?;
    let decrypted = Aes128CbcDecryptor::new(key.into(), iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut bytes)
        .ok()?;
    String::from_utf8(decrypted.to_vec()).ok()
}

async fn wait_for_cancel(cancelled: Arc<AtomicBool>) {
    let mut interval = tokio::time::interval(Duration::from_millis(25));
    loop {
        interval.tick().await;
        if cancelled.load(Ordering::Acquire) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::source_session::is_loopback_target;
    use super::super::test_support::bind_loopback_tcp;
    use super::{
        app_http_status_error, call, decrypt_base64, direct_media_url, discovery_origin,
        encode_form_body, encode_json_body, encode_player_url_parameter, encrypt_base64, from_ext,
        from_ext_for, from_python_wrapper_ext, is_bounded_parser_url, is_ok_discovery_marker,
        is_python_wrapper_api, is_supported, join_endpoint, looks_like_auth_error, map_detail,
        parse_discovery_response, protocolize_message, request_bounded_parser_url,
        send_with_direct_retry, upstream_error_hint, valid_endpoint, valid_media_url, AppGetConfig,
        AppGetEndpoint, AppGetError, AppGetTransport, AppProtocol,
    };
    use reqwest::header::{HeaderMap, HeaderValue};
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::sync::{atomic::AtomicBool, Arc};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    #[test]
    fn parses_only_fixed_key_appget_ext_and_keeps_opaque_fallback() {
        assert!(is_supported("csp_AppGet"));
        assert!(is_supported("csp_AppQi"));
        assert!(from_ext("https://example.test|opaque-token")
            .expect("parse")
            .is_none());
        let config = from_ext("https://example.test|0123456789abcdef|1|user")
            .expect("parse")
            .expect("fixed-key config");
        assert_eq!(config.version, "1");
        assert_eq!(config.user_token, "user");
        let marker = from_ext("https://444421.xyz|#getapp@TMD@2025|120")
            .expect("TMD marker parses")
            .expect("TMD marker is a fixed-key AppGet config");
        assert_eq!(&marker.key, b"#getapp@TMD@2025");
        assert_eq!(marker.version, "120");
    }

    #[test]
    fn recognizes_only_the_fixed_python_wrapper_and_txt_json_discovery_shapes() {
        assert!(is_python_wrapper_api("./Py\\app\\getapp.py"));
        assert!(is_python_wrapper_api("py/app/getapp.py"));
        assert!(!is_python_wrapper_api(
            "https://evil.example/Py/app/getapp.py"
        ));
        assert!(!is_python_wrapper_api("py/app/getapp.pyc"));

        for host in [
            "https://example.test/getapp.txt",
            "https://example.test/getapp.json",
        ] {
            let config = from_python_wrapper_ext(
                "./Py/app/getapp.py",
                &format!(
                    r#"{{"host":"{host}","api":"/api.php/getappapi","datakey":"0123456789abcdef","dataiv":"fedcba9876543210"}}"#
                ),
            )
            .expect("wrapper ext parses")
            .expect("wrapper ext is supported");
            assert_eq!(config.transport, AppGetTransport::PythonForm);
            assert!(
                matches!(config.endpoint, AppGetEndpoint::Discovery(ref value) if value == host)
            );
            assert_eq!(config.user_agent, "okhttp/3.10.0");
        }

        let direct = from_python_wrapper_ext(
            "py/app/getapp.py",
            r#"{"host":"https://example.test:8006","api":"/api.php/getappapi","datakey":"0123456789abcdef","dataiv":"fedcba9876543210"}"#,
        )
        .expect("direct wrapper ext parses")
        .expect("direct wrapper ext is supported");
        assert!(matches!(
            direct.endpoint,
            AppGetEndpoint::Direct(ref value) if value == "https://example.test:8006"
        ));

        let wrong_api = from_python_wrapper_ext(
            "py/app/getapp.py",
            r#"{"host":"https://example.test","api":"/api.php/qijiappapi","datakey":"0123456789abcdef"}"#,
        )
        .expect_err("a different wrapper API must fail closed");
        assert_eq!(wrong_api, "APPGET_WRAPPER_API_PATH_INVALID");
    }

    #[test]
    fn form_encodes_python_wrapper_values_without_json_or_plus_ambiguity() {
        let body = encode_form_body(&json!({
            "keywords": "肥猫 +",
            "page": 2,
            "url": "https://media.example/source?a+b/c=="
        }))
        .expect("wrapper form body encodes");
        assert!(body.contains("keywords=%E8%82%A5%E7%8C%AB+%2B"));
        assert!(body.contains("page=2"));
        assert!(body.contains("url=https%3A%2F%2Fmedia.example%2Fsource%3Fa%2Bb%2Fc%3D%3D"));
    }

    #[test]
    fn maps_python_wrapper_detail_to_the_fixed_episode_shape() {
        let config = from_python_wrapper_ext(
            "py/app/getapp.py",
            r#"{"host":"https://example.test","api":"/api.php/getappapi","datakey":"0123456789abcdef","dataiv":"fedcba9876543210"}"#,
        )
        .expect("wrapper ext parses")
        .expect("wrapper ext is supported");
        let detail = map_detail(
            &json!({
                "vod": {"vod_name":"测试片"},
                "vod_play_list": [{
                    "player_info": {"show":"固定线","parse":"parser-a","player_parse_type":"1"},
                    "urls": [{
                        "name":"第一集",
                        "url":"https://media.example/source?id=1",
                        "token":"tok+1",
                        "nid":"n1"
                    }]
                }]
            }),
            "detail-1",
            &config,
        )
        .expect("wrapper detail maps");
        assert_eq!(
            detail["vod_play_url"],
            "第一集$parser-a,https://media.example/source?id=1,token+tok+1,1|测试片|n1"
        );
    }

    #[tokio::test]
    async fn completes_python_wrapper_home_search_detail_and_player_over_loopback_aes_fixture() {
        let listener = bind_loopback_tcp()
            .await
            .expect("bind wrapper fixture listener");
        let address = listener.local_addr().expect("wrapper fixture address");
        let config = from_python_wrapper_ext(
            "./Py/app/getapp.py",
            &format!(
                r#"{{"host":"http://{address}","api":"/api.php/getappapi","datakey":"0123456789abcdef","dataiv":"fedcba9876543210"}}"#
            ),
        )
        .expect("wrapper ext parses")
        .expect("wrapper ext is supported");
        assert_eq!(config.transport, AppGetTransport::PythonForm);
        let server_config = config.clone();
        let player_source = "https://media.example/source?id=1";
        let player_cipher = encrypt_base64(player_source, &config.key, &config.iv)
            .expect("encrypt wrapper player source");
        let expected_player_body = encode_form_body(&json!({
            "parse_api": "parser-a",
            "url": player_cipher,
            "player_parse_type": "1",
            "token": "tok+1",
        }))
        .expect("encode wrapper player body");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept wrapper home");
            let (target, body, headers) = read_request(&mut socket).await;
            assert_eq!(target, "/api.php/getappapi.index/initV119");
            assert_eq!(headers.get(":method").map(String::as_str), Some("GET"));
            assert!(body.is_empty());
            assert_eq!(
                headers.get("user-agent").map(String::as_str),
                Some("okhttp/3.10.0")
            );
            assert_no_appget_headers(&headers);
            write_encrypted_json(
                &mut socket,
                &server_config,
                &json!({
                    "type_list": [{"type_id":"1","type_name":"电影"}],
                    "recommend_list": [{"vod_id":"home-1","vod_name":"首页片"}]
                }),
            )
            .await;

            let (mut socket, _) = listener.accept().await.expect("accept wrapper search");
            let (target, body, headers) = read_request(&mut socket).await;
            assert_eq!(target, "/api.php/getappapi.index/searchList");
            assert_eq!(headers.get(":method").map(String::as_str), Some("POST"));
            assert_eq!(
                headers.get("content-type").map(String::as_str),
                Some("application/x-www-form-urlencoded; charset=UTF-8")
            );
            assert_eq!(
                body,
                encode_form_body(&json!({"type_id":0,"keywords":"肥猫 +","page":2}))
                    .expect("encode wrapper search body")
            );
            assert_eq!(
                headers.get("user-agent").map(String::as_str),
                Some("okhttp/3.10.0")
            );
            assert_no_appget_headers(&headers);
            write_encrypted_json(
                &mut socket,
                &server_config,
                &json!({"search_list":[{"vod_id":"search-1","vod_name":"搜索片"}]}),
            )
            .await;

            let (mut socket, _) = listener.accept().await.expect("accept wrapper detail");
            let (target, body, headers) = read_request(&mut socket).await;
            assert_eq!(target, "/api.php/getappapi.index/vodDetail");
            assert_eq!(headers.get(":method").map(String::as_str), Some("POST"));
            assert_eq!(
                body,
                encode_form_body(&json!({"vod_id":"detail-1"}))
                    .expect("encode wrapper detail body")
            );
            assert_no_appget_headers(&headers);
            write_encrypted_json(
                &mut socket,
                &server_config,
                &json!({
                    "vod": {"vod_name":"测试片"},
                    "vod_play_list": [{
                        "player_info": {"show":"固定线","parse":"parser-a","player_parse_type":"1"},
                        "urls": [{"name":"第一集","url":player_source,"token":"tok+1","nid":"n1"}]
                    }]
                }),
            )
            .await;

            let (mut socket, _) = listener.accept().await.expect("accept wrapper player");
            let (target, body, headers) = read_request(&mut socket).await;
            assert_eq!(target, "/api.php/getappapi.index/vodParse");
            assert_eq!(headers.get(":method").map(String::as_str), Some("POST"));
            assert_eq!(
                headers.get("content-type").map(String::as_str),
                Some("application/x-www-form-urlencoded")
            );
            assert_eq!(body, expected_player_body);
            assert_eq!(
                headers.get("user-agent").map(String::as_str),
                Some("okhttp/3.10.0")
            );
            assert_no_appget_headers(&headers);
            write_encrypted_json(
                &mut socket,
                &server_config,
                &json!({"json":{"url":"https://media.example/resolved.m3u8"}}),
            )
            .await;
        });

        let home = call(
            &config,
            "home",
            None,
            &HeaderMap::new(),
            Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("wrapper home succeeds");
        assert_eq!(home["list"][0]["vod_id"], "home-1");

        let search = call(
            &config,
            "search",
            Some(&json!({"key":"肥猫 +","page":2})),
            &HeaderMap::new(),
            Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("wrapper search succeeds");
        assert_eq!(search["list"][0]["vod_id"], "search-1");

        let detail = call(
            &config,
            "detail",
            Some(&json!({"ids":["detail-1"]})),
            &HeaderMap::new(),
            Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("wrapper detail succeeds");
        let episode = detail["vod_play_url"]
            .as_str()
            .expect("wrapper detail episode");
        assert!(episode.contains("token+tok+1"));
        let player = call(
            &config,
            "player",
            Some(&json!({"id":episode})),
            &HeaderMap::new(),
            Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("wrapper player succeeds");
        assert_eq!(player["parse"], 0);
        assert_eq!(player["url"], "https://media.example/resolved.m3u8");
        assert_eq!(
            player["header"]["User-Agent"],
            "Dalvik/2.1.0 (Linux; U; Android 14; 23113RK12C Build/SKQ1.231004.001)"
        );
        server.await.expect("wrapper fixture server completes");
    }

    #[test]
    fn parses_current_public_feimao_app_ext_shapes_without_cms_fallback() {
        let appget_exts = [
            "https://cms140.yhg.one|bM7iC9eA3oZ1nB7z",
            "https://mk1080.top/get.txt|c60d88b2eep53za8",
            "https://vv.229d.cn|8888888888888888",
            "https://app.95112475.xyz|5a9w6x58dsq6z3a6",
            "https://allinadmin.oss-cn-hangzhou.aliyuncs.com/bk/9.txt|88689667dce61725",
            "https://444421.xyz|#getapp@TMD@2025|120",
            "https://www.cyfz.top|e72cdfd629e8895d",
            "https://new.app.bytegooty.com|N4yj7l7xKxHF4*gz",
        ];
        for ext in appget_exts {
            let config = from_ext(ext)
                .expect("current public AppGet ext parses")
                .expect("current public AppGet ext has a fixed key");
            assert_eq!(config.protocol, AppProtocol::AppGet);
            assert_eq!(config.key.len(), 16);
        }

        let appqi_discovery = from_ext_for(
            "csp_AppQi",
            "https://yun-1316442804.cos.ap-guangzhou.myqcloud.com/600.txt|FTgP4Gq8zPiqbt7M",
        )
        .expect("current public AppQi discovery parses")
        .expect("current public AppQi discovery has a fixed key");
        assert!(matches!(
            appqi_discovery.endpoint,
            AppGetEndpoint::Discovery(ref url) if url.ends_with("/600.txt")
        ));

        let appqi_direct = from_ext_for("csp_AppQi", "https://qj4.catbb.xyz|eecbio48dsq13kkk")
            .expect("current public AppQi direct ext parses")
            .expect("current public AppQi direct ext has a fixed key");
        assert!(matches!(
            appqi_direct.endpoint,
            AppGetEndpoint::Direct(ref url) if url == "https://qj4.catbb.xyz"
        ));
    }

    #[test]
    fn rejects_explicit_json_keys_that_cannot_be_aes128_keys() {
        let appget_error = from_ext(
            r#"{
              "url":"https://example.test",
              "dataKey":"short"
            }"#,
        )
        .expect_err("an explicit short AppGet key must fail closed");
        assert_eq!(appget_error, "APPGET_KEY_INVALID");

        let appqi_error = from_ext_for(
            "csp_AppQi",
            r#"{
              "url":"https://example.test",
              "dataKey":123
            }"#,
        )
        .expect_err("an explicit non-string AppQi key must fail closed");
        assert_eq!(appqi_error, "APPQI_KEY_INVALID");

        let appqi_iv_error = from_ext_for(
            "csp_AppQi",
            r#"{
              "url":"https://example.test",
              "dataKey":"0123456789abcdef",
              "dataIv":123
            }"#,
        )
        .expect_err("an explicit non-string AppQi IV must fail closed");
        assert_eq!(appqi_iv_error, "APPQI_IV_INVALID");

        assert!(
            from_ext(r#"{"url":"https://example.test","opaque":"token"}"#)
                .expect("opaque JSON ext parses")
                .is_none()
        );
        assert!(
            from_ext(r#"{"url":"https://example.test","token":"opaque-token"}"#)
                .expect("opaque token JSON ext parses")
                .is_none()
        );
    }

    #[test]
    fn parses_appqi_pipe_ext_without_treating_third_field_as_appget_version() {
        let config = from_ext_for(
            "csp_AppQi",
            "https://example.test|0123456789abcdef|fixture-agent",
        )
        .expect("parse")
        .expect("fixed-key config");
        assert_eq!(config.user_agent, "fixture-agent");
        assert!(config.version.is_empty());
        assert!(config.user_token.is_empty());
        assert_eq!(config.protocol, AppProtocol::AppQi);
    }

    #[test]
    fn keeps_shared_error_codes_namespaced_by_protocol() {
        assert_eq!(
            protocolize_message(AppProtocol::AppGet, "APPGET_DECRYPT_FAILED".to_string()),
            "APPGET_DECRYPT_FAILED"
        );
        assert_eq!(
            protocolize_message(AppProtocol::AppQi, "APPGET_DECRYPT_FAILED".to_string()),
            "APPQI_DECRYPT_FAILED"
        );
        assert_eq!(
            protocolize_message(AppProtocol::AppQi, "APPQI_HTTP_STATUS:502".to_string()),
            "APPQI_HTTP_STATUS:502"
        );
        let error =
            from_ext_for("csp_AppQi", "{").expect_err("malformed AppQi JSON ext must fail closed");
        assert!(
            error.starts_with("APPQI_EXT_JSON_INVALID:"),
            "unexpected AppQi JSON error: {error}"
        );
    }

    #[test]
    fn classifies_only_the_bounded_upstream_backend_failure_hint() {
        let body = b"<title>System Error</title> Connection refused(C#111, localhost:8384)";
        assert_eq!(
            upstream_error_hint(body),
            Some("UPSTREAM_BACKEND_UNAVAILABLE")
        );
        assert_eq!(
            app_http_status_error(
                AppProtocol::AppGet,
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                body
            ),
            "APPGET_HTTP_STATUS:500:UPSTREAM_BACKEND_UNAVAILABLE"
        );
        assert_eq!(
            upstream_error_hint(b"<html>temporary upstream error</html>"),
            None
        );
    }

    #[tokio::test]
    async fn keeps_discovery_and_parser_http_status_errors_numeric() {
        let discovery_listener = bind_loopback_tcp()
            .await
            .expect("bind discovery status fixture");
        let discovery_address = discovery_listener
            .local_addr()
            .expect("discovery status fixture address");
        let config = from_ext(&format!(
            "http://{discovery_address}/source.txt|0123456789abcdef"
        ))
        .expect("discovery status ext parses")
        .expect("discovery status ext has fixed key");
        let discovery_server = tokio::spawn(async move {
            let (mut socket, _) = discovery_listener
                .accept()
                .await
                .expect("accept discovery status request");
            let _ = read_request(&mut socket).await;
            write_http_response(
                &mut socket,
                b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "write discovery status response",
            )
            .await;
        });
        let discovery_error = call(
            &config,
            "home",
            None,
            &HeaderMap::new(),
            Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect_err("discovery status must fail");
        match discovery_error {
            AppGetError::Request(message) => {
                assert_eq!(message, "APPGET_DISCOVERY_HTTP_STATUS:503")
            }
            other => panic!("unexpected discovery error: {other:?}"),
        }
        discovery_server
            .await
            .expect("discovery status fixture completes");

        let parser_listener = bind_loopback_tcp()
            .await
            .expect("bind parser status fixture");
        let parser_address = parser_listener
            .local_addr()
            .expect("parser status fixture address");
        let parser_server = tokio::spawn(async move {
            let (mut socket, _) = parser_listener
                .accept()
                .await
                .expect("accept parser status request");
            let _ = read_request(&mut socket).await;
            write_http_response(
                &mut socket,
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "write parser status response",
            )
            .await;
        });
        let parser_url = format!("http://{parser_address}/wmm.php?key=k&api=a&url=encoded-source");
        let parser_error = request_bounded_parser_url(
            &parser_url,
            &HeaderMap::new(),
            Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect_err("parser status must fail");
        match parser_error {
            AppGetError::Request(message) => {
                assert_eq!(message, "APPGET_PARSER_HTTP_STATUS:502")
            }
            other => panic!("unexpected parser error: {other:?}"),
        }
        parser_server
            .await
            .expect("parser status fixture completes");
    }

    #[test]
    fn decrypts_the_same_pkcs7_base64_envelope_as_appget() {
        let key = *b"0123456789abcdef";
        let encrypted = encrypt_base64("{\"list\":[]}", &key, &key).expect("encrypt");
        assert_eq!(
            decrypt_base64(&encrypted, &key, &key).as_deref(),
            Some("{\"list\":[]}")
        );
    }

    #[test]
    fn matches_the_known_appget_aes_cbc_vectors() {
        let key = *b"0123456789abcdef";
        assert_eq!(
            encrypt_base64("1700000000", &key, &key).as_deref(),
            Some("QXRXZKW0A9bj1nLtGsZqtA==")
        );
        let encrypted = "FhifoztApMDCQDhitBinkTf4iXNDJdH2bXRB6/UtvJfDkxkTbdeOFLUgy28OLHRFJ3iM0D6XsafbBRwfo1tieg==";
        assert_eq!(
            decrypt_base64(encrypted, &key, &key).as_deref(),
            Some(r#"{"json":{"url":"https://media.invalid/resolved.m3u8"}}"#)
        );
    }

    #[test]
    fn form_encodes_only_the_appget_player_url_value() {
        assert_eq!(
            encode_player_url_parameter("$parse_api=p&url=a+b/c==&token=t")
                .expect("player URL encodes"),
            "$parse_api=p&url=a%2Bb%2Fc%3D%3D&token=t"
        );
    }

    #[test]
    fn parses_object_ext_fields_without_treating_opaque_tokens_as_keys() {
        let config = from_ext(
            r#"{
              "url":"https://example.test",
              "dataKey":"0123456789abcdef",
              "dataIv":"fedcba9876543210",
              "deviceId":"device-fixture",
              "version":"119",
              "userToken":"user-fixture",
              "ua":"fixture-agent"
            }"#,
        )
        .expect("object ext parses")
        .expect("complete object ext");
        assert!(matches!(
            &config.endpoint,
            AppGetEndpoint::Direct(base_url) if base_url == "https://example.test"
        ));
        assert_eq!(&config.key, b"0123456789abcdef");
        assert_eq!(&config.iv, b"fedcba9876543210");
        assert_eq!(config.device_id, "device-fixture");
        assert_eq!(config.version, "119");
        assert_eq!(config.user_token, "user-fixture");
        assert_eq!(config.user_agent, "fixture-agent");
        assert!(from_ext("https://example.test|opaque-token")
            .expect("opaque ext parses")
            .is_none());

        let discovery = from_ext(
            r#"{
              "url":"",
              "site":"https://example.test/appget.txt?token=fixture#ignored",
              "dataKey":"0123456789abcdef",
              "dataIv":"fedcba9876543210",
              "version":"119"
            }"#,
        )
        .expect("discovery object ext parses")
        .expect("discovery object has fixed keys");
        assert!(matches!(
            &discovery.endpoint,
            AppGetEndpoint::Discovery(url)
                if url == "https://example.test/appget.txt?token=fixture"
        ));
    }

    #[test]
    fn parses_public_lowercase_host_and_key_aliases_without_relaxing_key_validation() {
        let config = from_ext_for(
            "csp_AppQi",
            r#"{
              "host":"https://example.test",
              "api":"/api.php/qijiappapi",
              "datakey":"0123456789abcdef",
              "dataiv":"fedcba9876543210"
            }"#,
        )
        .expect("lowercase public object ext parses")
        .expect("lowercase public object ext has fixed keys");
        assert!(matches!(
            &config.endpoint,
            AppGetEndpoint::Direct(base_url) if base_url == "https://example.test"
        ));
        assert_eq!(&config.key, b"0123456789abcdef");
        assert_eq!(&config.iv, b"fedcba9876543210");
        assert_eq!(config.protocol, AppProtocol::AppQi);

        let invalid = from_ext_for(
            "csp_AppQi",
            r#"{
              "host":"https://example.test",
              "datakey":"short"
            }"#,
        )
        .expect_err("invalid lowercase public key must fail closed");
        assert_eq!(invalid, "APPQI_KEY_INVALID");
    }

    #[test]
    fn rejects_an_explicit_invalid_data_iv_instead_of_downgrading() {
        let error = from_ext(
            r#"{
              "url":"https://example.test",
              "dataKey":"0123456789abcdef",
              "dataIv":"short"
            }"#,
        )
        .expect_err("an explicit invalid dataIv must fail the AppGet contract");
        assert_eq!(error, "APPGET_IV_INVALID");
    }

    #[test]
    fn parses_only_strict_discovery_response_shapes() {
        assert_eq!(
            parse_discovery_response(
                b"\xef\xbb\xbf  https://api.example.test/root?old=1#stale  \n"
            )
            .as_deref(),
            Ok("https://api.example.test/root")
        );
        assert_eq!(
            parse_discovery_response(br#""https://api.example.test""#).as_deref(),
            Ok("https://api.example.test")
        );
        assert_eq!(
            parse_discovery_response(br#"{"url":"https://api.example.test/v1"}"#).as_deref(),
            Ok("https://api.example.test/v1")
        );
        for invalid in [
            b"ok".as_slice(),
            b"<html>blocked</html>".as_slice(),
            b"https://one.example\nhttps://two.example".as_slice(),
            b"https://user:pass@example.test".as_slice(),
            b"https://example.test/next.txt".as_slice(),
        ] {
            assert!(parse_discovery_response(invalid).is_err());
        }
    }

    #[test]
    fn accepts_only_the_exact_ok_discovery_marker_as_an_origin_fallback() {
        assert!(is_ok_discovery_marker(b"\n OK \r\n"));
        assert!(!is_ok_discovery_marker(b"ok\nhttps://other.example"));
        assert_eq!(
            discovery_origin("https://example.test/get.txt?token=fixture#ignored").as_deref(),
            Some("https://example.test")
        );
        assert!(discovery_origin("https://user:pass@example.test/get.txt").is_none());
    }

    #[test]
    fn identifies_unencrypted_login_errors_without_treating_them_as_payloads() {
        assert!(looks_like_auth_error(&json!({
            "code": 0,
            "msg": "无权请求搜索，请登录账号!",
            "data": []
        })));
        assert!(!looks_like_auth_error(&json!({
            "code": 0,
            "msg": "请求成功",
            "data": []
        })));
        assert!(!looks_like_auth_error(&json!({
            "data": "encrypted-payload"
        })));
    }

    #[test]
    fn normalizes_the_base_and_keeps_endpoint_query_out_of_the_path() {
        let base = valid_endpoint("https://example.test/root/?stale=1#old")
            .expect("base endpoint normalizes");
        assert_eq!(base, "https://example.test/root");

        let endpoint = join_endpoint(&base, "/api.php/getappapi.index/typeFilterVodList?page=2")
            .expect("endpoint joins");
        assert_eq!(
            endpoint.path(),
            "/root/api.php/getappapi.index/typeFilterVodList"
        );
        assert_eq!(endpoint.query(), Some("page=2"));
        assert_eq!(endpoint.fragment(), None);
    }

    #[test]
    fn encodes_read_bodies_as_compact_json() {
        let body = encode_json_body(&json!({
            "type_id": 0,
            "keywords": "光盘 1",
            "page": 2
        }))
        .expect("JSON body encodes");
        assert_eq!(
            serde_json::from_str::<Value>(&body).expect("JSON body parses"),
            json!({"type_id":0,"keywords":"光盘 1","page":2})
        );
    }

    #[tokio::test]
    async fn completes_all_read_methods_and_direct_player_from_encrypted_fixture() {
        let listener = bind_loopback_tcp().await.expect("bind fixture listener");
        let address = listener.local_addr().expect("fixture address");
        let discovery_listener = bind_loopback_tcp().await.expect("bind discovery listener");
        let discovery_address = discovery_listener.local_addr().expect("discovery address");
        let config = from_ext(&format!(
            "http://{discovery_address}/appget.txt|0123456789abcdef|119|user-fixture"
        ))
        .expect("pipe ext parses")
        .expect("pipe ext has fixed key");
        let discovery_server = tokio::spawn(async move {
            let (mut socket, _) = discovery_listener
                .accept()
                .await
                .expect("accept discovery request");
            let (request_target, body, headers) = read_request(&mut socket).await;
            assert_eq!(request_target, "/appget.txt");
            assert!(body.is_empty());
            assert!(!headers.contains_key("app-user-token"));
            let response_body = format!("http://{address}\n");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            write_http_response(&mut socket, response.as_bytes(), "write discovery response")
                .await;
        });
        let server_config = config.clone();
        let server = tokio::spawn(async move {
            for expected_target in [
                "/api.php/getappapi.index/initV119",
                "/api.php/getappapi.index/typeFilterVodList?page=2",
                "/api.php/getappapi.index/searchList",
                "/api.php/getappapi.index/vodDetail",
            ] {
                let (mut socket, _) = listener.accept().await.expect("accept fixture request");
                let (request_target, body, headers) = read_request(&mut socket).await;
                assert_eq!(request_target, expected_target);
                assert_eq!(headers.get(":method").map(String::as_str), Some("POST"));
                assert_eq!(
                    headers.get("content-type").map(String::as_str),
                    Some("application/json; charset=utf-8")
                );
                assert!(body.starts_with('{'));
                if expected_target.ends_with("typeFilterVodList?page=2") {
                    let body: Value = serde_json::from_str(&body).expect("category JSON body");
                    assert_eq!(body["area"], "华语");
                    assert_eq!(body["year"], "2025");
                    assert_eq!(body["sort"], "最新");
                    assert_eq!(body["lang"], "中文");
                    assert_eq!(body["class"], "剧情");
                    assert_eq!(body["page"], 2);
                }
                assert_eq!(
                    headers.get("app-user-device-id").map(String::as_str),
                    Some("2e714ed1a871e3291b797524842448850")
                );
                let payload = match expected_target {
                    "/api.php/getappapi.index/initV119" => json!({
                        "type_list": [{"type_id":"1","type_name":"电影"}],
                        "recommend_list": [{
                            "vod_id": "home-v1",
                            "vod_name": "首页影片",
                            "vod_pic": "",
                            "vod_remarks": ""
                        }]
                    }),
                    "/api.php/getappapi.index/typeFilterVodList?page=2" => json!({
                        "recommend_list": [{
                            "vod_id": "category-v1",
                            "vod_name": "分类影片",
                            "vod_pic": "",
                            "vod_remarks": ""
                        }]
                    }),
                    "/api.php/getappapi.index/searchList" => json!({
                        "search_list": [{
                            "vod_id": "v1",
                            "vod_name": "示例影片",
                            "vod_pic": "https://img.example.invalid/v1.jpg",
                            "vod_remarks": "2026"
                        }]
                    }),
                    _ => json!({
                        "vod": {
                            "vod_name": "示例影片",
                            "vod_pic": "https://img.example.invalid/v1.jpg",
                            "vod_remarks": "2026",
                            "vod_content": "fixture detail",
                            "vod_actor": "演员",
                            "vod_director": "导演",
                            "vod_class": "剧情"
                        },
                        "vod_play_list": [{
                            "player_info": {"show": "主线", "parse": "p"},
                            "urls": [{
                                "url": "https://media.example.invalid/episode.m3u8",
                                "parse_api_url": "fixture-prefixhttps://media.example.invalid/episode.m3u8",
                                "token": "",
                                "name": "第一集",
                                "nid": "n1"
                            }]
                        }, {
                            "player_info": {"show": "解析线", "parse": "parser-a"},
                            "urls": [{
                                "url": "https://media.example.invalid/source-page",
                                "parse_api_url": "",
                                "token": "episode-token",
                                "name": "第二集",
                                "nid": "n2"
                            }]
                        }]
                    }),
                };
                write_encrypted_json(&mut socket, &server_config, &payload).await;
            }
        });

        let cancelled = Arc::new(AtomicBool::new(false));
        let home = call(
            &config,
            "home",
            None,
            &HeaderMap::new(),
            Duration::from_secs(5),
            cancelled.clone(),
        )
        .await
        .expect("encrypted home succeeds");
        assert_eq!(home["class"][0]["type_id"], "1");
        assert_eq!(home["list"][0]["vod_id"], "home-v1");

        let category = call(
            &config,
            "category",
            Some(&json!({
                "typeId":"1",
                "page":2,
                "filter":{"area":"华语","year":"2025","sort":"最新","lang":"中文","class":"剧情"}
            })),
            &HeaderMap::new(),
            Duration::from_secs(5),
            cancelled.clone(),
        )
        .await
        .expect("encrypted category succeeds");
        assert_eq!(category["list"][0]["vod_id"], "category-v1");

        let search = call(
            &config,
            "search",
            Some(&json!({"key":"示例","page":1})),
            &HeaderMap::new(),
            Duration::from_secs(5),
            cancelled.clone(),
        )
        .await
        .expect("encrypted search succeeds");
        assert_eq!(search["list"][0]["vod_id"], "v1");
        assert_eq!(search["list"][0]["vod_name"], "示例影片");

        let detail = call(
            &config,
            "detail",
            Some(&json!({"ids":["v1"]})),
            &HeaderMap::new(),
            Duration::from_secs(5),
            cancelled.clone(),
        )
        .await
        .expect("encrypted detail succeeds");
        assert_eq!(detail["vod_id"], "v1");
        assert_eq!(detail["vod_play_from"], "主线$$$解析线");
        let play_lines = detail["vod_play_url"]
            .as_str()
            .expect("play lines")
            .split("$$$")
            .collect::<Vec<_>>();
        assert_eq!(play_lines.len(), 2);
        assert!(play_lines[1].contains("&token=episode-token|示例影片|n2"));
        assert!(!play_lines[1].contains('#'));
        let episode = play_lines[0].split('$').nth(1).expect("direct episode id");
        let player = call(
            &config,
            "player",
            Some(&json!({"id":episode})),
            &HeaderMap::new(),
            Duration::from_secs(5),
            cancelled,
        )
        .await
        .expect("direct player succeeds without parser request");
        assert_eq!(player["parse"], 0);
        assert_eq!(player["url"], "https://media.example.invalid/episode.m3u8");
        discovery_server
            .await
            .expect("discovery fixture server completes");
        server.await.expect("fixture server completes");
    }

    #[tokio::test]
    async fn completes_appqi_read_methods_and_both_player_paths_from_encrypted_fixture() {
        let api_listener = bind_loopback_tcp()
            .await
            .expect("bind AppQi fixture listener");
        let api_address = api_listener.local_addr().expect("AppQi fixture address");
        let discovery_listener = bind_loopback_tcp()
            .await
            .expect("bind AppQi discovery listener");
        let discovery_address = discovery_listener
            .local_addr()
            .expect("AppQi discovery address");
        let config = from_ext_for(
            "csp_AppQi",
            &format!("http://{discovery_address}/config/current|0123456789abcdef|fixture-agent"),
        )
        .expect("AppQi ext parses")
        .expect("AppQi ext has fixed key");
        assert!(matches!(config.endpoint, AppGetEndpoint::Discovery(_)));
        let discovery_server = tokio::spawn(async move {
            let (mut socket, _) = discovery_listener
                .accept()
                .await
                .expect("accept AppQi discovery request");
            let (target, _, headers) = read_request(&mut socket).await;
            assert_eq!(target, "/config/current");
            assert_eq!(
                headers.get("user-agent").map(String::as_str),
                Some("fixture-agent")
            );
            let body = format!("http://{api_address}");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            write_http_response(
                &mut socket,
                response.as_bytes(),
                "write AppQi discovery response",
            )
            .await;
        });
        let server_config = config.clone();
        let server = tokio::spawn(async move {
            for expected_target in [
                "/api.php/qijiappapi.index/initV120",
                "/api.php/qijiappapi.index/typeFilterVodList?page=2",
                "/api.php/qijiappapi.index/searchList",
                "/api.php/qijiappapi.index/vodDetail",
            ] {
                let (mut socket, _) = api_listener.accept().await.expect("accept AppQi request");
                let (request_target, body, headers) = read_request(&mut socket).await;
                assert_eq!(request_target, expected_target);
                assert_eq!(
                    headers.get("user-agent").map(String::as_str),
                    Some("fixture-agent")
                );
                assert_eq!(headers.get(":method").map(String::as_str), Some("POST"));
                assert_eq!(
                    headers.get("content-type").map(String::as_str),
                    Some("application/json; charset=utf-8")
                );
                assert!(body.starts_with('{'));
                assert_no_appget_headers(&headers);
                let payload = match expected_target {
                    "/api.php/qijiappapi.index/initV120" => json!({
                        "type_list": [{"type_id":"1","type_name":"电影"}],
                        "recommend_list": [{"vod_id":"qi-home","vod_name":"光盘首页"}]
                    }),
                    "/api.php/qijiappapi.index/typeFilterVodList?page=2" => {
                        let body: Value = serde_json::from_str(&body).expect("category JSON body");
                        assert_eq!(body["type_id"], "1");
                        json!({"recommend_list":[{"vod_id":"qi-category","vod_name":"光盘分类"}]})
                    }
                    "/api.php/qijiappapi.index/searchList" => {
                        let body: Value = serde_json::from_str(&body).expect("search JSON body");
                        assert_eq!(body["keywords"], "光盘");
                        assert_eq!(body["page"], 1);
                        json!({"search_list":[{"vod_id":"qi-search","vod_name":"光盘搜索"}]})
                    }
                    _ => {
                        let body: Value = serde_json::from_str(&body).expect("detail JSON body");
                        assert_eq!(body["vod_id"], "qi-search");
                        json!({
                            "vod": {"vod_name":"光盘详情","vod_pic":"https://img.example.invalid/qi.jpg"},
                            "vod_play_list": [
                                {
                                    "player_info": {"show":"光盘线"},
                                    "urls": [{"name":"第一集","parse_api_url":"https://media.example.invalid/qi.m3u8","nid":"q1"}]
                                },
                                {
                                    "player_info": {"show":"光盘线","parse":"fixture-parser"},
                                    "urls": [{"name":"第二集","url":"https://source.example.invalid/watch/2","token":"fixture-token","nid":"q2"}]
                                }
                            ]
                        })
                    }
                };
                write_encrypted_json(&mut socket, &server_config, &payload).await;
            }

            let (mut socket, _) = api_listener
                .accept()
                .await
                .expect("accept AppQi parser request");
            let (target, body, headers) = read_request(&mut socket).await;
            assert_eq!(target, "/api.php/qijiappapi.index/vodParse");
            assert_eq!(
                headers.get("user-agent").map(String::as_str),
                Some("fixture-agent")
            );
            assert_eq!(
                headers.get("content-type").map(String::as_str),
                Some("application/x-www-form-urlencoded")
            );
            assert_no_appget_headers(&headers);
            assert!(body.starts_with("$parse_api=fixture-parser&url="));
            assert!(body.ends_with("&token=fixture-token"));
            write_encrypted_json(
                &mut socket,
                &server_config,
                &json!({"json":{"url":"https://media.example.invalid/qi-resolved.m3u8"}}),
            )
            .await;
        });

        let mut caller_headers = HeaderMap::new();
        for name in [
            "app-user-device-id",
            "app-version-code",
            "app-api-verify-time",
            "app-api-verify-sign",
            "app-ui-mode",
            "app-user-token",
        ] {
            caller_headers.insert(name, HeaderValue::from_static("caller-value"));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let home = call(
            &config,
            "home",
            None,
            &caller_headers,
            Duration::from_secs(5),
            cancelled.clone(),
        )
        .await
        .expect("AppQi home succeeds");
        assert_eq!(home["list"][0]["vod_id"], "qi-home");

        let category = call(
            &config,
            "category",
            Some(&json!({"typeId":"1","page":2})),
            &caller_headers,
            Duration::from_secs(5),
            cancelled.clone(),
        )
        .await
        .expect("AppQi category succeeds");
        assert_eq!(category["list"][0]["vod_id"], "qi-category");

        let search = call(
            &config,
            "search",
            Some(&json!({"key":"光盘","page":1})),
            &caller_headers,
            Duration::from_secs(5),
            cancelled.clone(),
        )
        .await
        .expect("AppQi search succeeds");
        assert_eq!(search["list"][0]["vod_id"], "qi-search");

        let detail = call(
            &config,
            "detail",
            Some(&json!({"ids":["qi-search"]})),
            &caller_headers,
            Duration::from_secs(5),
            cancelled.clone(),
        )
        .await
        .expect("AppQi detail succeeds");
        assert_eq!(detail["vod_play_from"], "光盘线$$$光盘线+1");
        let play_lines = detail["vod_play_url"]
            .as_str()
            .expect("AppQi play lines")
            .split("$$$")
            .collect::<Vec<_>>();
        assert_eq!(play_lines.len(), 2);
        let player = call(
            &config,
            "player",
            Some(&json!({"id": play_lines[0]})),
            &caller_headers,
            Duration::from_secs(5),
            cancelled.clone(),
        )
        .await
        .expect("AppQi direct player succeeds");
        assert_eq!(player["parse"], 0);
        assert_eq!(player["url"], "https://media.example.invalid/qi.m3u8");
        let parsed = call(
            &config,
            "player",
            Some(&json!({"id": play_lines[1]})),
            &caller_headers,
            Duration::from_secs(5),
            cancelled,
        )
        .await
        .expect("AppQi fixed parser succeeds");
        assert_eq!(parsed["parse"], 0);
        assert_eq!(
            parsed["url"],
            "https://media.example.invalid/qi-resolved.m3u8"
        );
        discovery_server
            .await
            .expect("AppQi discovery server completes");
        server.await.expect("AppQi fixture server completes");
    }

    #[tokio::test]
    async fn falls_back_to_getappapi_path_for_appqi_when_legacy_path_is_missing() {
        let listener = bind_loopback_tcp()
            .await
            .expect("bind AppQi fallback listener");
        let address = listener
            .local_addr()
            .expect("AppQi fallback listener address");
        let config = from_ext_for(
            "csp_AppQi",
            &format!("http://{address}|0123456789abcdef|fixture-agent"),
        )
        .expect("AppQi fallback ext parses")
        .expect("AppQi fallback ext has fixed key");
        let server_config = config.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener
                .accept()
                .await
                .expect("accept legacy AppQi request");
            let (target, body, headers) = read_request(&mut socket).await;
            assert_eq!(target, "/api.php/qijiappapi.index/initV120");
            assert_eq!(body, "{}");
            assert_eq!(headers.get(":method").map(String::as_str), Some("POST"));
            assert_eq!(
                headers.get("content-type").map(String::as_str),
                Some("application/json; charset=utf-8")
            );
            write_http_response(
                &mut socket,
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "write legacy AppQi miss",
            )
            .await;

            let (mut socket, _) = listener
                .accept()
                .await
                .expect("accept getapp AppQi request");
            let (target, body, headers) = read_request(&mut socket).await;
            assert_eq!(target, "/api.php/getappapi.index/initV119");
            assert_eq!(body, "{}");
            assert_eq!(headers.get(":method").map(String::as_str), Some("POST"));
            assert_eq!(
                headers.get("content-type").map(String::as_str),
                Some("application/json; charset=utf-8")
            );
            write_encrypted_json(
                &mut socket,
                &server_config,
                &json!({
                    "type_list": [{"type_id":"1","type_name":"电影"}],
                    "recommend_list": [{"vod_id":"fallback-home","vod_name":"回退首页"}]
                }),
            )
            .await;
        });

        let home = call(
            &config,
            "home",
            None,
            &HeaderMap::new(),
            Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("AppQi falls back to getappapi home");
        assert_eq!(home["list"][0]["vod_id"], "fallback-home");
        server.await.expect("AppQi fallback server completes");
    }

    #[tokio::test]
    async fn falls_back_to_vod_detail2_when_vod_detail_is_missing() {
        let listener = bind_loopback_tcp()
            .await
            .expect("bind detail fallback listener");
        let address = listener
            .local_addr()
            .expect("detail fallback listener address");
        eprintln!("detail fixture bound {address}");
        let config = from_ext(&format!("http://{address}|0123456789abcdef|119|user"))
            .expect("detail fallback ext parses")
            .expect("detail fallback ext has fixed key");
        let server_config = config.clone();
        let server = tokio::spawn(async move {
            eprintln!("detail fixture task start {address}");
            let (mut socket, _) = listener.accept().await.expect("accept vodDetail request");
            eprintln!("detail fixture accepted first request {address}");
            let (target, body, headers) = read_request(&mut socket).await;
            eprintln!("detail fixture first target={target} body={body} headers={headers:?}");
            assert_eq!(target, "/api.php/getappapi.index/vodDetail");
            assert_eq!(headers.get(":method").map(String::as_str), Some("POST"));
            assert_eq!(
                serde_json::from_str::<Value>(&body).expect("detail JSON body")["vod_id"],
                "detail-fallback"
            );
            write_http_response(
                &mut socket,
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "write vodDetail miss",
            )
            .await;
            eprintln!("detail fixture wrote first response {address}");

            let (mut socket, _) = listener.accept().await.expect("accept vodDetail2 request");
            eprintln!("detail fixture accepted second request {address}");
            let (target, body, headers) = read_request(&mut socket).await;
            assert_eq!(target, "/api.php/getappapi.index/vodDetail2");
            assert_eq!(headers.get(":method").map(String::as_str), Some("POST"));
            assert_eq!(
                serde_json::from_str::<Value>(&body).expect("detail2 JSON body")["vod_id"],
                "detail-fallback"
            );
            write_encrypted_json(
                &mut socket,
                &server_config,
                &json!({"vod":{"vod_name":"Detail2 影片"}}),
            )
            .await;
        });

        let detail = call(
            &config,
            "detail",
            Some(&json!({"ids":["detail-fallback"]})),
            &HeaderMap::new(),
            Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("vodDetail2 fallback succeeds");
        assert_eq!(detail["vod_name"], "Detail2 影片");
        server.await.expect("detail fallback server completes");
    }

    #[tokio::test]
    async fn direct_media_playback_does_not_resolve_discovery() {
        let listener = bind_loopback_tcp()
            .await
            .expect("bind unused discovery listener");
        let address = listener.local_addr().expect("unused discovery address");
        let config = from_ext(&format!(
            "http://{address}/appget.txt|0123456789abcdef|119|user"
        ))
        .expect("discovery ext parses")
        .expect("discovery ext has fixed key");

        let player = call(
            &config,
            "player",
            Some(&json!({"id":"https://media.example.invalid/direct.m3u8"})),
            &HeaderMap::new(),
            Duration::from_secs(1),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("direct media playback succeeds without discovery");
        assert_eq!(player["parse"], 0);
        assert_eq!(player["url"], "https://media.example.invalid/direct.m3u8");
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "direct media must not request the discovery URL"
        );
    }

    #[tokio::test]
    async fn caches_discovery_redirect_failure_and_does_not_follow_it() {
        let listener = bind_loopback_tcp()
            .await
            .expect("bind discovery redirect listener");
        let address = listener.local_addr().expect("discovery redirect address");
        let redirect_target = bind_loopback_tcp()
            .await
            .expect("bind discovery redirect target");
        let redirect_address = redirect_target
            .local_addr()
            .expect("discovery redirect target address");
        let config = from_ext(&format!(
            "http://{address}/appget.txt?token=fixture|0123456789abcdef|119|user"
        ))
        .expect("redirect discovery ext parses")
        .expect("redirect discovery has fixed key");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept discovery request");
            let (target, _, headers) = read_request(&mut socket).await;
            assert_eq!(target, "/appget.txt?token=fixture");
            assert!(!headers.contains_key("app-user-token"));
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://{redirect_address}/outside\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            write_http_response(
                &mut socket,
                response.as_bytes(),
                "write discovery redirect",
            )
            .await;
            tokio::time::timeout(Duration::from_millis(250), listener.accept())
                .await
                .is_ok()
        });

        let first = call(
            &config,
            "home",
            None,
            &HeaderMap::new(),
            Duration::from_secs(1),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect_err("discovery redirect must fail closed");
        let second = call(
            &config,
            "search",
            Some(&json!({"key":"fixture"})),
            &HeaderMap::new(),
            Duration::from_secs(1),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect_err("cached discovery redirect failure must repeat");
        assert_eq!(format!("{first:?}"), format!("{second:?}"));
        assert!(format!("{first:?}").contains("APPGET_DISCOVERY_HTTP_STATUS:302"));
        assert!(!server.await.expect("discovery redirect server completes"));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), redirect_target.accept())
                .await
                .is_err(),
            "discovery redirect target must not receive a request"
        );
    }

    #[tokio::test]
    async fn resolves_parser_payload_and_validates_timestamp_signature() {
        let listener = bind_loopback_tcp()
            .await
            .expect("bind parser fixture listener");
        let address = listener.local_addr().expect("parser fixture address");
        let config = from_ext(&format!(
            "http://{address}|0123456789abcdef|119|user-fixture"
        ))
        .expect("pipe ext parses")
        .expect("pipe ext has fixed key");
        let server_config = config.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept parser request");
            let (path, body, headers) = read_request(&mut socket).await;
            assert_eq!(path, "/api.php/getappapi.index/vodParse");
            assert!(body.starts_with("parse_api=p&url="));
            assert!(!body.starts_with('$'));
            let verify_time = headers
                .get("app-api-verify-time")
                .expect("timestamp header");
            let signature = headers
                .get("app-api-verify-sign")
                .expect("signature header");
            assert_eq!(
                decrypt_base64(signature, &server_config.key, &server_config.iv).as_deref(),
                Some(verify_time.as_str())
            );
            let payload = json!({
                "json": r#"{"success":true,"url":"https://media.example.invalid/resolved.m3u8"}"#
            });
            write_encrypted_json(&mut socket, &server_config, &payload).await;
        });

        let source_url = "https://media.example.invalid/source-page";
        let encrypted_url =
            encrypt_base64(source_url, &config.key, &config.iv).expect("encrypt parser source URL");
        let id = format!("$parse_api=p&url={encrypted_url}&token=");
        let result = call(
            &config,
            "player",
            Some(&json!({"id": id})),
            &HeaderMap::new(),
            Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("parser player succeeds");
        assert_eq!(result["parse"], 0);
        assert_eq!(result["url"], "https://media.example.invalid/resolved.m3u8");
        server.await.expect("parser fixture server completes");
    }

    #[tokio::test]
    async fn falls_back_to_the_dollar_prefixed_appget_player_form() {
        let listener = bind_loopback_tcp()
            .await
            .expect("bind parser fallback listener");
        let address = listener.local_addr().expect("parser fallback address");
        let config = from_ext(&format!(
            "http://{address}|0123456789abcdef|119|user-fixture"
        ))
        .expect("fallback ext parses")
        .expect("fallback ext has fixed key");
        let server_config = config.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept standard form");
            let (path, body, _) = read_request(&mut socket).await;
            assert_eq!(path, "/api.php/getappapi.index/vodParse");
            assert!(body.starts_with("parse_api=p&url="));
            write_json(&mut socket, r#"{"msg":"","code":0,"data":[]}"#).await;

            let (mut socket, _) = listener.accept().await.expect("accept prefixed form");
            let (path, body, _) = read_request(&mut socket).await;
            assert_eq!(path, "/api.php/getappapi.index/vodParse");
            assert!(body.starts_with("$parse_api=p&url="));
            write_encrypted_json(
                &mut socket,
                &server_config,
                &json!({"data":{"url":"https://media.example.invalid/fallback.m3u8"}}),
            )
            .await;
        });

        let source_url = "https://media.example.invalid/source-page";
        let encrypted_url =
            encrypt_base64(source_url, &config.key, &config.iv).expect("encrypt fallback URL");
        let id = format!("parse_api=p&url={encrypted_url}&token=");
        let result = call(
            &config,
            "player",
            Some(&json!({"id": id})),
            &HeaderMap::new(),
            Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("prefixed player fallback succeeds");
        assert_eq!(result["parse"], 0);
        assert_eq!(result["url"], "https://media.example.invalid/fallback.m3u8");
        server.await.expect("parser fallback server completes");
    }

    #[tokio::test]
    async fn resolves_the_bounded_wmm_parser_contract_without_running_page_scripts() {
        let listener = bind_loopback_tcp()
            .await
            .expect("bind bounded parser listener");
        let address = listener.local_addr().expect("bounded parser address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept bounded parser");
            let (path, _, _) = read_request(&mut socket).await;
            assert_eq!(path, "/wmm.php?key=fixture-key&api=nb&url=encoded-source");
            write_json(
                &mut socket,
                r#"{"code":200,"msg":"解析成功","url":"https://media.example.invalid/wmm.m3u8"}"#,
            )
            .await;
        });
        let id = format!("http://{address}/wmm.php?key=fixture-key&api=nb&url=encoded-source");
        assert!(is_bounded_parser_url(&id));
        assert!(!is_bounded_parser_url(&format!(
            "http://{address}/wmm.php?key=fixture-key&url=encoded-source"
        )));
        let config = from_ext("http://example.test|0123456789abcdef|119|user")
            .expect("bounded parser config parses")
            .expect("bounded parser config has fixed key");
        let result = call(
            &config,
            "player",
            Some(&json!({"id": id})),
            &HeaderMap::new(),
            Duration::from_secs(2),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("bounded parser response resolves");
        assert_eq!(result["parse"], 0);
        assert_eq!(result["url"], "https://media.example.invalid/wmm.m3u8");
        server.await.expect("bounded parser server completes");
    }

    #[tokio::test]
    async fn fails_closed_for_dynamic_player_without_parse_contract_and_bad_envelopes() {
        let listener = bind_loopback_tcp()
            .await
            .expect("bind page fixture listener");
        let address = listener.local_addr().expect("page fixture address");
        let config = from_ext(&format!("http://{address}|0123456789abcdef|119|user"))
            .expect("page ext parses")
            .expect("page fixed key");
        let server_config = config.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept page request");
            let (path, body, _) = read_request(&mut socket).await;
            assert_eq!(path, "/api.php/getappapi.index/vodParse");
            assert_eq!(body, "https://media.example.invalid/page?id=1");
            write_encrypted_json(
                &mut socket,
                &server_config,
                &json!({"json":{"url":"https://media.example.invalid/page-resolved.m3u8"}}),
            )
            .await;
        });
        let dynamic = call(
            &config,
            "player",
            Some(&json!({"id":"https://media.example.invalid/page?id=1"})),
            &HeaderMap::new(),
            Duration::from_secs(1),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("plain https URL is resolved by the fixed parser endpoint");
        assert_eq!(dynamic["parse"], 0);
        assert_eq!(
            dynamic["url"],
            "https://media.example.invalid/page-resolved.m3u8"
        );
        server.await.expect("page fixture server completes");

        let unsupported = call(
            &config,
            "player",
            Some(&json!({"id":"javascript:resolve(1)"})),
            &HeaderMap::new(),
            Duration::from_secs(1),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect_err("dynamic JavaScript must be rejected");
        assert!(format!("{unsupported:?}").contains("APPGET_DYNAMIC_PLAYER_UNSUPPORTED"));

        for id in [
            "https://parser.example/play?url=https://cdn.example/a.m3u8",
            "https://parser.example/play?key=a.mp4",
            "https://parser.example/a.m3u8.html",
        ] {
            let error = call(
                &config,
                "player",
                Some(&json!({"id": id})),
                &HeaderMap::new(),
                Duration::from_secs(1),
                Arc::new(AtomicBool::new(false)),
            )
            .await
            .expect_err("dynamic parser page must fail closed");
            assert!(format!("{error:?}").contains("APPGET_DYNAMIC_PLAYER_UNSUPPORTED"));
        }

        let listener = bind_loopback_tcp()
            .await
            .expect("bind bad envelope fixture listener");
        let address = listener.local_addr().expect("bad envelope fixture address");
        let bad_config = from_ext(&format!("http://{address}|0123456789abcdef|119|user"))
            .expect("bad envelope ext parses")
            .expect("bad envelope fixed key");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener
                .accept()
                .await
                .expect("accept bad envelope request");
            let _ = read_request(&mut socket).await;
            write_json(&mut socket, r#"{"data":"not-base64"}"#).await;
        });
        let error = call(
            &bad_config,
            "search",
            Some(&json!({"key":"示例","page":1})),
            &HeaderMap::new(),
            Duration::from_secs(5),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect_err("bad envelope must fail closed");
        assert!(format!("{error:?}").contains("APPGET_DECRYPT_FAILED"));
        server.await.expect("bad envelope fixture server completes");
    }

    #[tokio::test]
    async fn does_not_follow_redirects_from_fixed_appget_endpoints() {
        let listener = bind_loopback_tcp()
            .await
            .expect("bind redirect fixture listener");
        let address = listener.local_addr().expect("redirect fixture address");
        let redirect_target = bind_loopback_tcp()
            .await
            .expect("bind redirect target listener");
        let redirect_address = redirect_target
            .local_addr()
            .expect("redirect target address");
        let config = from_ext(&format!("http://{address}|0123456789abcdef|119|user"))
            .expect("redirect ext parses")
            .expect("redirect fixed key");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept redirect request");
            let _ = read_request(&mut socket).await;
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://{redirect_address}/outside\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            write_http_response(&mut socket, response.as_bytes(), "write redirect response").await;
        });

        let error = call(
            &config,
            "home",
            None,
            &HeaderMap::new(),
            Duration::from_secs(1),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect_err("AppGet redirects must fail closed");
        assert!(format!("{error:?}").contains("APPGET_HTTP_STATUS:302"));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), redirect_target.accept())
                .await
                .is_err(),
            "redirect target must not receive the AppGet request"
        );
        server.await.expect("redirect fixture server completes");
    }

    async fn read_request(socket: &mut TcpStream) -> (String, String, HashMap<String, String>) {
        let mut bytes = Vec::new();
        let header_end;
        loop {
            let mut chunk = [0_u8; 4096];
            let read = socket.read(&mut chunk).await.expect("read fixture request");
            assert!(read > 0, "fixture request ended before headers");
            bytes.extend_from_slice(&chunk[..read]);
            if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                header_end = index + 4;
                break;
            }
        }
        let header_text = String::from_utf8_lossy(&bytes[..header_end]);
        let mut lines = header_text.split("\r\n");
        let request_line = lines.next().expect("request line");
        let method = request_line
            .split_whitespace()
            .next()
            .expect("request method")
            .to_string();
        let request_target = request_line
            .split_whitespace()
            .nth(1)
            .expect("request target")
            .to_string();
        let mut headers = HashMap::new();
        headers.insert(":method".to_string(), method);
        let mut content_length = 0_usize;
        for line in lines.filter(|line| !line.is_empty()) {
            if let Some((name, value)) = line.split_once(':') {
                let name = name.trim().to_ascii_lowercase();
                let value = value.trim().to_string();
                if name == "content-length" {
                    content_length = value.parse().expect("content length");
                }
                headers.insert(name, value);
            }
        }
        while bytes.len() < header_end + content_length {
            let mut chunk = [0_u8; 4096];
            let read = socket.read(&mut chunk).await.expect("read fixture body");
            assert!(read > 0, "fixture request ended before body");
            bytes.extend_from_slice(&chunk[..read]);
        }
        let body =
            String::from_utf8_lossy(&bytes[header_end..header_end + content_length]).to_string();
        (request_target, body, headers)
    }

    fn assert_no_appget_headers(headers: &HashMap<String, String>) {
        for name in [
            "app-user-device-id",
            "app-version-code",
            "app-api-verify-time",
            "app-api-verify-sign",
            "app-ui-mode",
            "app-user-token",
        ] {
            assert!(
                !headers.contains_key(name),
                "AppQi request must not forward AppGet header {name}"
            );
        }
    }

    async fn write_encrypted_json(socket: &mut TcpStream, config: &AppGetConfig, value: &Value) {
        let plain = serde_json::to_string(value).expect("serialize fixture payload");
        let data =
            encrypt_base64(&plain, &config.key, &config.iv).expect("encrypt fixture payload");
        write_json(socket, &format!(r#"{{"data":"{data}"}}"#)).await;
    }

    async fn write_json(socket: &mut TcpStream, body: &str) {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        write_http_response(socket, response.as_bytes(), "write fixture response").await;
    }

    async fn write_http_response(socket: &mut TcpStream, response: &[u8], context: &str) {
        socket.write_all(response).await.expect(context);
        socket
            .shutdown()
            .await
            .expect("shutdown fixture response write side");
        // On Windows, dropping a socket immediately after shutdown can reset
        // a response before the client consumes it. Drain the peer close so
        // fixtures model a graceful server close, without a timing sleep.
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            let mut buffer = [0_u8; 1024];
            while socket.read(&mut buffer).await.unwrap_or(0) > 0 {}
        }).await;
    }

    #[test]
    fn rejects_credentials_and_non_http_media_urls() {
        assert!(valid_media_url("https://user:pass@example.test/a").is_none());
        assert!(valid_media_url("javascript:alert(1)").is_none());
        assert_eq!(
            valid_media_url("https://media.example/a.m3u8").as_deref(),
            Some("https://media.example/a.m3u8")
        );
        assert_eq!(
            direct_media_url("https://media.example/a.flv").as_deref(),
            Some("https://media.example/a.flv")
        );
    }

    #[test]
    fn bypasses_environment_proxy_only_for_loopback_targets() {
        assert!(is_loopback_target("http://127.0.0.1:1234/api"));
        assert!(is_loopback_target("http://[::1]:1234/api"));
        assert!(is_loopback_target("http://localhost:1234/api"));
        assert!(!is_loopback_target("https://cms.example.test/api"));
    }

    #[tokio::test]
    async fn retries_truncated_query_body_once_preserving_headers_and_payload() {
        let listener = bind_loopback_tcp().await.unwrap();
        let address = listener.local_addr().unwrap();
        let config = from_ext(&format!("http://{address}|0123456789abcdef|1|user")).unwrap().unwrap();
        let server_config = config.clone();
        let fixture = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let first = read_request(&mut socket).await;
            write_http_response(&mut socket, b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n20\r\n{", "truncate body").await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let second = read_request(&mut socket).await;
            assert_eq!(first, second, "retry must preserve method, signature and body");
            write_encrypted_json(&mut socket, &server_config, &json!({"recommend_list":[{"vod_id":"recovered","vod_name":"Recovered"}]})).await;
        });
        let result = super::request_json_once(&config, "/api.php/getappapi.index/initV119", reqwest::Method::POST, Some(&json!({"device":"fixture"})), &HeaderMap::new(), Duration::from_secs(2), Arc::new(AtomicBool::new(false))).await;
        assert_eq!(result.unwrap()["recommend_list"][0]["vod_id"], "recovered");
        tokio::time::timeout(Duration::from_secs(3), fixture).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn retries_read_query_when_peer_closes_before_response_headers() {
        let listener = bind_loopback_tcp().await.unwrap();
        let address = listener.local_addr().unwrap();
        let config = from_ext(&format!("http://{address}|0123456789abcdef|1|user")).unwrap().unwrap();
        let server_config = config.clone();
        let fixture = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let first = read_request(&mut socket).await;
            socket.shutdown().await.unwrap();
            drop(socket);
            let (mut socket, _) = listener.accept().await.unwrap();
            let second = read_request(&mut socket).await;
            assert_eq!(first, second);
            write_encrypted_json(&mut socket, &server_config, &json!({"search_list":[{"vod_id":"recovered"}]})).await;
        });
        let result = super::request_json_once(&config, "/api.php/getappapi.index/searchList", reqwest::Method::POST, Some(&json!({"keywords":"fixture"})), &HeaderMap::new(), Duration::from_secs(2), Arc::new(AtomicBool::new(false))).await;
        assert_eq!(result.unwrap()["search_list"][0]["vod_id"], "recovered");
        tokio::time::timeout(Duration::from_secs(3), fixture).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn reports_slider_challenge_without_retrying_or_decoding_as_media() {
        let listener = bind_loopback_tcp().await.unwrap();
        let config = from_ext_for("csp_AppQi", &format!("http://{}|0123456789abcdef", listener.local_addr().unwrap())).unwrap().unwrap();
        let fixture = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_request(&mut socket).await;
            write_json(&mut socket, r#"{"code":1001,"msg":"请完成滑块验证","need_slider":true}"#).await;
        });
        let error = super::request_json_once(&config, "/api.php/qijiappapi.index/searchList", reqwest::Method::POST, Some(&json!({"keywords":"fixture"})), &HeaderMap::new(), Duration::from_secs(2), Arc::new(AtomicBool::new(false))).await.unwrap_err();
        assert!(format!("{error:?}").contains("APPQI_CHALLENGE_REQUIRED"));
        fixture.await.unwrap();
    }

    #[tokio::test]
    async fn retries_a_proxy_502_once_without_downgrading_the_request() {
        let target = bind_loopback_tcp().await.expect("bind direct target");
        let target_address = target.local_addr().expect("direct target address");
        let proxy = bind_loopback_tcp().await.expect("bind proxy fixture");
        let proxy_address = proxy.local_addr().expect("proxy fixture address");

        let target_task = tokio::spawn(async move {
            let (mut socket, _) = target.accept().await.expect("accept direct retry");
            let _ = read_request(&mut socket).await;
            write_json(&mut socket, r#"{"ok":true}"#).await;
        });
        let proxy_task = tokio::spawn(async move {
            let (mut socket, _) = proxy.accept().await.expect("accept proxy request");
            let _ = read_request(&mut socket).await;
            write_http_response(
                &mut socket,
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "write proxy failure",
            )
            .await;
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_address}")).expect("proxy"))
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .expect("build proxy client");
        let url = format!("http://127.0.0.1:{}/health", target_address.port());
        let response = tokio::time::timeout(
            Duration::from_secs(3),
            send_with_direct_retry(&client, Duration::from_secs(2), true, |client| {
                client.get(url.clone())
            }),
        )
        .await
        .expect("direct retry completes")
        .expect("direct retry succeeds");
        assert_eq!(response.status(), reqwest::StatusCode::OK);

        target_task.await.expect("direct target completes");
        proxy_task.await.expect("proxy fixture completes");
    }
}
