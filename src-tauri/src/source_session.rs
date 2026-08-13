use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use base64::Engine as _;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCapabilities {
    pub home: bool,
    pub category: bool,
    pub search: bool,
    pub detail: bool,
    pub playback: bool,
    pub local_proxy: bool,
    pub filters: bool,
    pub pagination: bool,
    pub engine: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSessionPayload {
    pub action: String,
    pub session_id: String,
    pub source_id: Option<String>,
    pub site_key: Option<String>,
    pub api: Option<String>,
    pub site_type: Option<u8>,
    pub ext: Option<String>,
    pub method: Option<String>,
    pub params: Option<Value>,
    pub timeout_ms: Option<u64>,
    pub headers: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSessionSnapshot {
    pub session_id: String,
    pub source_id: String,
    pub site_key: Option<String>,
    pub api: String,
    pub site_type: u8,
    pub state: String,
    pub availability_reason: Option<String>,
    pub capabilities: SourceCapabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSessionResult {
    pub session: SourceSessionSnapshot,
    pub method: Option<String>,
    pub result: Option<Value>,
    pub cancelled: bool,
}

#[derive(Debug, Clone)]
struct SourceSession {
    snapshot: SourceSessionSnapshot,
    ext: String,
    headers: HashMap<String, String>,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct SourceSessionState {
    sessions: Mutex<HashMap<String, SourceSession>>,
}

#[derive(Debug)]
pub enum SourceSessionError {
    Invalid(String),
    NotFound,
    Cancelled,
    Unsupported(String),
    Request(String),
}

impl SourceSessionState {
    pub fn open(
        &self,
        payload: &SourceSessionPayload,
    ) -> Result<SourceSessionSnapshot, SourceSessionError> {
        if payload.session_id.trim().is_empty() {
            return Err(SourceSessionError::Invalid(
                "sessionId is required".to_string(),
            ));
        }
        let api_value = payload
            .api
            .as_deref()
            .ok_or_else(|| SourceSessionError::Invalid("api is required".to_string()))?;
        let native = super::native_sources::is_native_api(api_value);
        let api = if native {
            api_value.trim().to_string()
        } else {
            validate_api(api_value)?
        };
        let site_type = payload.site_type.unwrap_or(if native { 3 } else { 1 });
        if !native && !matches!(site_type, 0 | 1 | 4) {
            return Err(SourceSessionError::Invalid(
                "CMS source type must be 0, 1, or 4".to_string(),
            ));
        }
        let capabilities = if native {
            super::native_sources::capabilities(&api).ok_or_else(|| {
                SourceSessionError::Invalid(format!("native source is unavailable: {api}"))
            })?
        } else {
            SourceCapabilities {
                home: true,
                category: true,
                search: true,
                detail: true,
                playback: true,
                local_proxy: false,
                filters: site_type != 0,
                pagination: true,
                engine: "http".to_string(),
            }
        };
        let availability_reason = if api.eq_ignore_ascii_case("csp_Jianpian") {
            Some("native_jianpian_port_pending".to_string())
        } else {
            None
        };
        let snapshot = SourceSessionSnapshot {
            session_id: payload.session_id.clone(),
            source_id: payload
                .source_id
                .clone()
                .unwrap_or_else(|| payload.session_id.clone()),
            site_key: payload.site_key.clone(),
            api,
            site_type,
            state: "ready".to_string(),
            availability_reason,
            capabilities,
        };
        let session = SourceSession {
            snapshot: snapshot.clone(),
            ext: payload.ext.clone().unwrap_or_default(),
            headers: safe_headers(payload.headers.clone().unwrap_or_default())?,
            timeout: Duration::from_millis(
                payload
                    .timeout_ms
                    .unwrap_or(DEFAULT_TIMEOUT_MS)
                    .clamp(1_000, 120_000),
            ),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| SourceSessionError::Request("session state poisoned".to_string()))?;
        if let Some(previous) = sessions.insert(payload.session_id.clone(), session) {
            previous.cancelled.store(true, Ordering::Release);
        }
        Ok(snapshot)
    }

    pub fn close(&self, session_id: &str) -> Result<SourceSessionSnapshot, SourceSessionError> {
        let session = self.remove(session_id)?;
        session.cancelled.store(true, Ordering::Release);
        let mut snapshot = session.snapshot;
        snapshot.state = "closed".to_string();
        Ok(snapshot)
    }

    pub fn cancel(&self, session_id: &str) -> Result<(), SourceSessionError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| SourceSessionError::Request("session state poisoned".to_string()))?;
        let session = sessions
            .get(session_id)
            .ok_or(SourceSessionError::NotFound)?;
        session.cancelled.store(true, Ordering::Release);
        Ok(())
    }

    pub async fn call(
        &self,
        payload: &SourceSessionPayload,
    ) -> Result<SourceSessionResult, SourceSessionError> {
        let session = self.get(&payload.session_id)?;
        if session.cancelled.load(Ordering::Acquire) {
            return Err(SourceSessionError::Cancelled);
        }
        let method = payload
            .method
            .as_deref()
            .unwrap_or("home")
            .to_ascii_lowercase();
        if super::native_sources::is_native_api(&session.snapshot.api) {
            let result = super::native_sources::call(
                &session.snapshot.api,
                &method,
                payload.params.as_ref(),
                &to_header_map(&session.headers)?,
                session.timeout,
                session.cancelled.clone(),
            )
            .await
            .map_err(|error| match error {
                super::native_sources::NativeSourceError::Unsupported(message) => {
                    SourceSessionError::Unsupported(message)
                }
                super::native_sources::NativeSourceError::Request(message) => {
                    SourceSessionError::Request(message)
                }
            })?;
            return Ok(SourceSessionResult {
                session: session.snapshot,
                method: Some(method),
                result: Some(result),
                cancelled: false,
            });
        }
        let url = request_url(&session, &method, payload.params.as_ref())?;
        let client = reqwest::Client::builder()
            .default_headers(to_header_map(&session.headers)?)
            .timeout(session.timeout)
            .build()
            .map_err(|error| SourceSessionError::Request(error.to_string()))?;
        let request = client.get(url);
        let response = tokio::select! {
            result = request.send() => result.map_err(|error| SourceSessionError::Request(error.to_string()))?,
            _ = wait_for_cancel(session.cancelled.clone()) => return Err(SourceSessionError::Cancelled),
        };
        if session.cancelled.load(Ordering::Acquire) {
            return Err(SourceSessionError::Cancelled);
        }
        let status = response.status();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| SourceSessionError::Request(error.to_string()))?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(SourceSessionError::Request(
                "HTTP source response is too large".to_string(),
            ));
        }
        if !status.is_success() {
            return Err(SourceSessionError::Request(format!(
                "HTTP source returned {status}"
            )));
        }
        let body = String::from_utf8_lossy(&bytes)
            .trim_start_matches('\u{feff}')
            .to_string();
        let result = if content_type.contains("xml") || body.trim_start().starts_with('<') {
            parse_cms_xml(&body)?
        } else {
            serde_json::from_str(&body).map_err(|error| {
                SourceSessionError::Request(format!(
                    "HTTP source response is not valid JSON: {error}"
                ))
            })?
        };
        Ok(SourceSessionResult {
            session: session.snapshot,
            method: Some(method),
            result: Some(result),
            cancelled: false,
        })
    }

    pub fn snapshot(&self, session_id: &str) -> Result<SourceSessionSnapshot, SourceSessionError> {
        Ok(self.get(session_id)?.snapshot)
    }

    fn get(&self, session_id: &str) -> Result<SourceSession, SourceSessionError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| SourceSessionError::Request("session state poisoned".to_string()))?;
        sessions
            .get(session_id)
            .cloned()
            .ok_or(SourceSessionError::NotFound)
    }

    fn remove(&self, session_id: &str) -> Result<SourceSession, SourceSessionError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| SourceSessionError::Request("session state poisoned".to_string()))?;
        sessions
            .remove(session_id)
            .ok_or(SourceSessionError::NotFound)
    }
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

fn validate_api(value: &str) -> Result<String, SourceSessionError> {
    let parsed = reqwest::Url::parse(value.trim())
        .map_err(|_| SourceSessionError::Invalid("api must be an HTTP(S) URL".to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.username() != ""
        || parsed.password().is_some()
    {
        return Err(SourceSessionError::Invalid(
            "api must be an HTTP(S) URL without credentials".to_string(),
        ));
    }
    Ok(parsed.to_string())
}

fn safe_headers(
    headers: HashMap<String, String>,
) -> Result<HashMap<String, String>, SourceSessionError> {
    let mut safe = HashMap::new();
    for (name, value) in headers {
        if !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
            || value.contains(['\r', '\n'])
            || matches!(
                name.to_ascii_lowercase().as_str(),
                "host" | "connection" | "content-length" | "transfer-encoding" | "upgrade"
            )
        {
            return Err(SourceSessionError::Invalid(format!(
                "unsafe HTTP header: {name}"
            )));
        }
        safe.insert(name, value);
    }
    Ok(safe)
}

fn to_header_map(headers: &HashMap<String, String>) -> Result<HeaderMap, SourceSessionError> {
    let mut result = HeaderMap::new();
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| SourceSessionError::Invalid(format!("invalid HTTP header: {name}")))?;
        let value = HeaderValue::from_str(value).map_err(|_| {
            SourceSessionError::Invalid(format!("invalid HTTP header value: {name}"))
        })?;
        result.insert(name, value);
    }
    Ok(result)
}

fn request_url(
    session: &SourceSession,
    method: &str,
    params: Option<&Value>,
) -> Result<String, SourceSessionError> {
    let mut url = reqwest::Url::parse(&session.snapshot.api)
        .map_err(|error| SourceSessionError::Invalid(error.to_string()))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair(
            "ac",
            if matches!(method, "home" | "category" | "search") {
                "videolist"
            } else {
                "detail"
            },
        );
        if method == "category" {
            if let Some(value) = params
                .and_then(|value| value.get("typeId"))
                .and_then(Value::as_str)
            {
                query.append_pair("t", value);
            }
            if let Some(value) = params
                .and_then(|value| value.get("page"))
                .and_then(Value::as_u64)
            {
                query.append_pair("pg", &value.max(1).to_string());
            }
        } else if method == "search" {
            if let Some(value) = params
                .and_then(|value| value.get("key"))
                .and_then(Value::as_str)
            {
                query.append_pair("wd", value);
            }
            if let Some(value) = params
                .and_then(|value| value.get("page"))
                .and_then(Value::as_u64)
            {
                query.append_pair("pg", &value.max(1).to_string());
            }
        } else if method == "detail" {
            if let Some(value) = params
                .and_then(|value| value.get("ids"))
                .and_then(Value::as_array)
            {
                let ids = value
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",");
                query.append_pair("ids", &ids);
            }
        }
        if session.snapshot.site_type == 4 && !session.ext.is_empty() {
            query.append_pair(
                "ext",
                &base64::engine::general_purpose::STANDARD.encode(session.ext.as_bytes()),
            );
        }
    }
    Ok(url.to_string())
}

fn parse_cms_xml(body: &str) -> Result<Value, SourceSessionError> {
    let mut reader = quick_xml::Reader::from_str(body);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut stack: Vec<(String, Value)> = Vec::new();
    let mut root: Option<Value> = None;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(quick_xml::events::Event::Start(event)) => {
                let name = String::from_utf8_lossy(event.name().as_ref()).to_ascii_lowercase();
                stack.push((name, Value::Object(Default::default())));
            }
            Ok(quick_xml::events::Event::Text(event)) => {
                if let Some((_, value)) = stack.last_mut() {
                    *value = Value::String(
                        quick_xml::escape::unescape(
                            &event
                                .decode()
                                .map_err(|error| SourceSessionError::Request(error.to_string()))?,
                        )
                        .map_err(|error| SourceSessionError::Request(error.to_string()))?
                        .into_owned(),
                    );
                }
            }
            Ok(quick_xml::events::Event::End(_)) => {
                let (name, value) = stack.pop().ok_or_else(|| {
                    SourceSessionError::Request("CMS XML response is malformed".to_string())
                })?;
                if let Some((parent_name, parent)) = stack.last_mut() {
                    let object = parent.as_object_mut().expect("XML node object");
                    insert_xml_child(object, &name, value);
                    let _ = parent_name;
                } else {
                    root = Some(json!({ name: value }));
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(error) => {
                return Err(SourceSessionError::Request(format!(
                    "CMS XML response is invalid: {error}"
                )))
            }
            _ => {}
        }
        buf.clear();
    }
    root.ok_or_else(|| {
        SourceSessionError::Request("CMS XML response has no root element".to_string())
    })
}

fn insert_xml_child(object: &mut serde_json::Map<String, Value>, name: &str, value: Value) {
    if let Some(previous) = object.remove(name) {
        let values = match previous {
            Value::Array(mut values) => {
                values.push(value);
                values
            }
            previous => vec![previous, value],
        };
        object.insert(name.to_string(), Value::Array(values));
    } else {
        object.insert(name.to_string(), value);
    }
}

#[cfg(test)]
mod tests {
    use super::{SourceSessionPayload, SourceSessionState};
    use serde_json::json;

    #[test]
    fn opens_cms_session_with_stable_capabilities_and_rejects_unsafe_headers() {
        let state = SourceSessionState::default();
        let snapshot = state
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "s1".to_string(),
                source_id: Some("source".to_string()),
                site_key: Some("site".to_string()),
                api: Some("https://example.test/api.php".to_string()),
                site_type: Some(4),
                ext: Some("fixture".to_string()),
                method: None,
                params: None,
                timeout_ms: Some(5_000),
                headers: None,
            })
            .expect("session opens");
        assert_eq!(snapshot.capabilities.engine, "http");
        assert!(snapshot.capabilities.filters);
        let error = state
            .open(&SourceSessionPayload {
                session_id: "unsafe".to_string(),
                api: Some("https://example.test".to_string()),
                headers: Some(
                    [(String::from("X-Test"), String::from("bad\nvalue"))]
                        .into_iter()
                        .collect(),
                ),
                ..SourceSessionPayload {
                    action: "open".to_string(),
                    session_id: "unsafe".to_string(),
                    source_id: None,
                    site_key: None,
                    api: Some("https://example.test".to_string()),
                    site_type: None,
                    ext: None,
                    method: None,
                    params: Some(json!({})),
                    timeout_ms: None,
                    headers: None,
                }
            })
            .expect_err("unsafe header rejected");
        assert!(format!("{error:?}").contains("unsafe HTTP header"));
    }

    #[test]
    fn close_and_cancel_are_idempotent_at_the_session_boundary() {
        let state = SourceSessionState::default();
        let payload = SourceSessionPayload {
            action: "open".to_string(),
            session_id: "s1".to_string(),
            source_id: None,
            site_key: None,
            api: Some("https://example.test".to_string()),
            site_type: Some(1),
            ext: None,
            method: None,
            params: None,
            timeout_ms: None,
            headers: None,
        };
        state.open(&payload).expect("session opens");
        state.cancel("s1").expect("cancel works");
        assert_eq!(state.close("s1").expect("close works").state, "closed");
    }

    #[test]
    fn exposes_native_douban_and_explicit_jianpian_unavailable_reason() {
        let state = SourceSessionState::default();
        let douban = SourceSessionPayload {
            action: "open".to_string(),
            session_id: "douban".to_string(),
            source_id: None,
            site_key: Some("douban".to_string()),
            api: Some("csp_Douban".to_string()),
            site_type: Some(3),
            ext: None,
            method: None,
            params: None,
            timeout_ms: None,
            headers: None,
        };
        let snapshot = state.open(&douban).expect("Douban opens");
        assert_eq!(snapshot.capabilities.engine, "native");
        assert!(!snapshot.capabilities.playback);
        assert!(snapshot.availability_reason.is_none());

        let jianpian = SourceSessionPayload {
            session_id: "jianpian".to_string(),
            api: Some("csp_Jianpian".to_string()),
            ..douban
        };
        let snapshot = state.open(&jianpian).expect("Jianpian boundary opens");
        assert_eq!(
            snapshot.availability_reason.as_deref(),
            Some("native_jianpian_port_pending")
        );
        assert!(!snapshot.capabilities.search);
    }
}
