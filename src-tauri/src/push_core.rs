use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;
use uuid::Uuid;

const MAX_BODY_BYTES: usize = 256 * 1024;
const MAX_RECENT: usize = 20;
const MAX_PENDING: usize = 12;
const MAX_QUEUE: usize = 20;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushPayload {
    pub action: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushSnapshot {
    pub schema_version: String,
    pub state: Value,
}

#[derive(Debug)]
pub enum PushError {
    Invalid(String),
    Conflict(String),
    Storage(String),
}

#[derive(Debug, Clone)]
pub struct PushRequest {
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone)]
struct PendingRequest {
    id: String,
    request: PushRequest,
    requested_by: String,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct Session {
    id: String,
    title: String,
    state: String,
}

#[derive(Debug, Default)]
struct Runtime {
    enabled: bool,
    configured_port: u16,
    port: Option<u16>,
    listening: bool,
    confirmation_policy: String,
    conflict_mode: String,
    pending: BTreeMap<String, PendingRequest>,
    queue: VecDeque<PendingRequest>,
    recent: Vec<Value>,
    active_session: Option<Session>,
    error: Option<Value>,
}

struct ServerHandle {
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

#[derive(Clone)]
pub struct PushState {
    runtime: Arc<Mutex<Runtime>>,
    server: Arc<Mutex<Option<ServerHandle>>>,
}

impl Default for PushState {
    fn default() -> Self {
        Self::new(true)
    }
}

impl PushState {
    fn new(enabled: bool) -> Self {
        Self {
            runtime: Arc::new(Mutex::new(Runtime {
                enabled,
                configured_port: 0,
                confirmation_policy: "ask".to_string(),
                conflict_mode: "replace".to_string(),
                ..Runtime::default()
            })),
            server: Arc::new(Mutex::new(None)),
        }
    }

    #[cfg(test)]
    pub fn for_test() -> Self {
        Self::new(true)
    }

    pub async fn handle(&self, payload: &PushPayload) -> Result<PushSnapshot, PushError> {
        match payload.action.as_str() {
            "snapshot" | "refresh" => {
                self.ensure_started().await?;
                self.snapshot().await
            }
            "settings" => {
                self.configure(&payload.value).await?;
                self.snapshot().await
            }
            "submit" => {
                let request = parse_push_request(&payload.value)?;
                let result = self.submit_request(request, "localhost", None).await?;
                self.snapshot_with_result(result).await
            }
            "confirm" => {
                let id = required_string(&payload.value, "id")?;
                let decision = payload
                    .value
                    .get("decision")
                    .and_then(Value::as_str)
                    .unwrap_or("play");
                let mode = payload
                    .value
                    .get("mode")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                let result = self.confirm(id, decision, mode.as_deref()).await?;
                self.snapshot_with_result(result).await
            }
            "reject" => {
                let id = required_string(&payload.value, "id")?;
                let result = self.confirm(id, "reject", None).await?;
                self.snapshot_with_result(result).await
            }
            "cancel" => {
                let id = required_string(&payload.value, "id")?;
                let result = self.cancel(id).await?;
                self.snapshot_with_result(result).await
            }
            "clear" => {
                let mut runtime = self.runtime.lock().await;
                runtime.recent.clear();
                drop(runtime);
                self.snapshot().await
            }
            _ => Err(PushError::Invalid(format!(
                "PUSH_ACTION_UNSUPPORTED:{}",
                payload.action
            ))),
        }
    }

    pub async fn submit_url(
        &self,
        url: &str,
        title: &str,
        requested_by: &str,
    ) -> Result<Value, PushError> {
        let request = PushRequest {
            url: validate_push_url(url)?,
            title: normalize_title(title),
        };
        self.submit_request(request, requested_by, None).await
    }

    pub async fn confirm(
        &self,
        id: &str,
        decision: &str,
        mode: Option<&str>,
    ) -> Result<Value, PushError> {
        if decision != "play" && decision != "reject" {
            return Err(PushError::Invalid("PUSH_DECISION_INVALID".to_string()));
        }
        let pending = {
            let mut runtime = self.runtime.lock().await;
            runtime
                .pending
                .remove(id)
                .ok_or_else(|| PushError::Invalid("PUSH_CONFIRMATION_NOT_FOUND".to_string()))?
        };
        if decision == "reject" {
            let recent = self
                .update_recent(
                    &pending,
                    "rejected",
                    None,
                    Some(json!({"code":"PUSH_REJECTED","message":"Push request rejected"})),
                )
                .await;
            return Ok(json!({"kind":"rejected","recent":recent}));
        }
        self.accept(pending, mode).await
    }

    pub async fn shutdown(&self) {
        self.stop_server().await;
    }

    pub async fn cancel(&self, id: &str) -> Result<Value, PushError> {
        let pending = {
            let mut runtime = self.runtime.lock().await;
            if let Some(item) = runtime.pending.remove(id) {
                Some(item)
            } else if let Some(index) = runtime.queue.iter().position(|item| item.id == id) {
                runtime.queue.remove(index)
            } else {
                None
            }
        };
        let Some(pending) = pending else {
            return Err(PushError::Invalid("PUSH_REQUEST_NOT_FOUND".to_string()));
        };
        let recent = self.update_recent(&pending, "cancelled", None, None).await;
        Ok(json!({"recent":recent}))
    }

    async fn configure(&self, value: &Value) -> Result<(), PushError> {
        let (was_enabled, old_port, enabled, port) = {
            let mut runtime = self.runtime.lock().await;
            let was_enabled = runtime.enabled;
            let old_port = runtime.configured_port;
            runtime.enabled = value
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(runtime.enabled);
            runtime.configured_port = value
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .unwrap_or(runtime.configured_port);
            if let Some(policy) = value.get("confirmationPolicy").and_then(Value::as_str) {
                if matches!(policy, "ask" | "allow-trusted-local") {
                    runtime.confirmation_policy = policy.to_string();
                }
            }
            if let Some(mode) = value.get("conflictMode").and_then(Value::as_str) {
                if matches!(mode, "replace" | "queue" | "reject") {
                    runtime.conflict_mode = mode.to_string();
                }
            }
            (
                was_enabled,
                old_port,
                runtime.enabled,
                runtime.configured_port,
            )
        };
        if !enabled {
            self.stop_server().await;
        } else if !was_enabled || old_port != port {
            self.stop_server().await;
            self.ensure_started().await?;
        } else {
            self.ensure_started().await?;
        }
        Ok(())
    }

    async fn submit_request(
        &self,
        request: PushRequest,
        requested_by: &str,
        mode: Option<&str>,
    ) -> Result<Value, PushError> {
        let runtime = self.runtime.lock().await;
        if !runtime.enabled {
            return Err(PushError::Invalid("PUSH_DISABLED".to_string()));
        }
        if runtime.pending.len() >= MAX_PENDING {
            return Err(PushError::Invalid("PUSH_CONFIRMATION_LIMIT".to_string()));
        }
        let policy = runtime.confirmation_policy.clone();
        drop(runtime);
        let id = format!("push-{}", Uuid::new_v4());
        let pending = PendingRequest {
            id: id.clone(),
            request,
            requested_by: requested_by.to_string(),
            created_at: now_millis(),
        };
        if policy == "allow-trusted-local" && requested_by == "trusted-local" {
            return self.accept(pending, mode).await;
        }
        let preview = json!({
            "id": id,
            "type": "url",
            "title": pending.request.title,
            "targetHost": Url::parse(&pending.request.url).ok().and_then(|url| url.host_str().map(ToOwned::to_owned)),
            "requestedBy": pending.requested_by,
            "createdAt": pending.created_at,
        });
        {
            let mut runtime = self.runtime.lock().await;
            runtime.pending.insert(pending.id.clone(), pending.clone());
        }
        self.add_recent(&pending, "pending-confirmation", None, None)
            .await;
        Ok(json!({"kind":"confirmation-required","preview":preview}))
    }

    async fn accept(
        &self,
        pending: PendingRequest,
        mode: Option<&str>,
    ) -> Result<Value, PushError> {
        let conflict_mode = {
            let runtime = self.runtime.lock().await;
            mode.unwrap_or(&runtime.conflict_mode).to_string()
        };
        let active = self.runtime.lock().await.active_session.is_some();
        if active && conflict_mode == "reject" {
            let recent = self
                .update_recent(
                    &pending,
                    "rejected",
                    None,
                    Some(
                        json!({"code":"PUSH_CONFLICT","message":"Active playback session exists"}),
                    ),
                )
                .await;
            return Err(PushError::Conflict(recent.to_string()));
        }
        if active && conflict_mode == "queue" {
            let mut runtime = self.runtime.lock().await;
            if runtime.queue.len() >= MAX_QUEUE {
                return Err(PushError::Invalid("PUSH_QUEUE_LIMIT".to_string()));
            }
            runtime.queue.push_back(pending.clone());
            drop(runtime);
            let recent = self.update_recent(&pending, "queued", None, None).await;
            return Ok(json!({"kind":"queued","recent":recent}));
        }
        let session = Session {
            id: format!("push-session-{}", Uuid::new_v4()),
            title: pending.request.title.clone(),
            state: "active".to_string(),
        };
        {
            let mut runtime = self.runtime.lock().await;
            runtime.active_session = Some(session.clone());
        }
        let recent = self
            .update_recent(&pending, "accepted", Some(session.id.clone()), None)
            .await;
        Ok(json!({
            "kind":"accepted",
            "recent":recent,
            "session": {"id":session.id,"kind":"vod","title":session.title,"state":session.state},
            "playback": {"sessionId":session.id,"url":pending.request.url,"title":pending.request.title}
        }))
    }

    async fn add_recent(
        &self,
        pending: &PendingRequest,
        status: &str,
        session_id: Option<String>,
        error: Option<Value>,
    ) -> Value {
        let record = recent_record(pending, status, session_id, error);
        let mut runtime = self.runtime.lock().await;
        runtime.recent.insert(0, record.clone());
        runtime.recent.truncate(MAX_RECENT);
        record
    }

    async fn update_recent(
        &self,
        pending: &PendingRequest,
        status: &str,
        session_id: Option<String>,
        error: Option<Value>,
    ) -> Value {
        let record = recent_record(pending, status, session_id, error);
        let mut runtime = self.runtime.lock().await;
        runtime
            .recent
            .retain(|item| item.get("id") != Some(&Value::String(pending.id.clone())));
        runtime.recent.insert(0, record.clone());
        runtime.recent.truncate(MAX_RECENT);
        record
    }

    async fn ensure_started(&self) -> Result<(), PushError> {
        let (enabled, configured_port) = {
            let runtime = self.runtime.lock().await;
            (runtime.enabled, runtime.configured_port)
        };
        if !enabled || self.server.lock().await.is_some() {
            return Ok(());
        }
        let listener = TcpListener::bind(("127.0.0.1", configured_port))
            .await
            .map_err(|error| PushError::Storage(format!("PUSH_START_FAILED:{error}")))?;
        let port = listener
            .local_addr()
            .map_err(|error| PushError::Storage(format!("PUSH_START_FAILED:{error}")))?
            .port();
        {
            let mut runtime = self.runtime.lock().await;
            runtime.port = Some(port);
            runtime.listening = true;
            runtime.error = None;
        }
        let (stop, mut stop_receiver) = oneshot::channel();
        let state = self.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stop_receiver => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break; };
                        let state = state.clone();
                        tokio::spawn(async move { handle_connection(state, stream).await; });
                    }
                }
            }
        });
        *self.server.lock().await = Some(ServerHandle { stop, task });
        Ok(())
    }

    async fn stop_server(&self) {
        if let Some(handle) = self.server.lock().await.take() {
            let _ = handle.stop.send(());
            let _ = handle.task.await;
        }
        let mut runtime = self.runtime.lock().await;
        runtime.port = None;
        runtime.listening = false;
    }

    async fn snapshot(&self) -> Result<PushSnapshot, PushError> {
        let runtime = self.runtime.lock().await;
        let endpoint = runtime
            .port
            .map(|port| format!("http://127.0.0.1:{port}/push"));
        Ok(PushSnapshot {
            schema_version: "v1".to_string(),
            state: json!({
                "push": {
                    "enabled": runtime.enabled,
                    "host": "127.0.0.1",
                    "configuredPort": runtime.configured_port,
                    "port": runtime.port,
                    "listening": runtime.listening,
                    "endpoint": endpoint,
                    "confirmationPolicy": runtime.confirmation_policy,
                    "conflictMode": runtime.conflict_mode,
                    "pending": runtime.pending.values().map(preview).collect::<Vec<_>>(),
                    "recent": runtime.recent,
                    "activeSession": runtime.active_session.as_ref().map(session_value),
                    "error": runtime.error,
                    "lanControl": "disabled"
                }
            }),
        })
    }

    async fn snapshot_with_result(&self, result: Value) -> Result<PushSnapshot, PushError> {
        let snapshot = self.snapshot().await?;
        let mut state = snapshot.state;
        state["result"] = result;
        Ok(PushSnapshot {
            schema_version: snapshot.schema_version,
            state,
        })
    }
}

pub fn parse_push_request(value: &Value) -> Result<PushRequest, PushError> {
    if value
        .get("headers")
        .and_then(Value::as_object)
        .is_some_and(|headers| !headers.is_empty())
    {
        return Err(PushError::Invalid("PUSH_HEADERS_UNSUPPORTED".to_string()));
    }
    if let Some(uri) = value.get("uri").and_then(Value::as_str) {
        let parsed =
            Url::parse(uri).map_err(|_| PushError::Invalid("PUSH_URI_INVALID".to_string()))?;
        if parsed.scheme() != "push" || parsed.host_str() != Some("url") {
            return Err(PushError::Invalid("PUSH_TYPE_UNSUPPORTED".to_string()));
        }
        let url = parsed
            .query_pairs()
            .find(|(key, _)| key == "url")
            .map(|(_, value)| value.into_owned())
            .ok_or_else(|| PushError::Invalid("PUSH_REQUEST_INVALID".to_string()))?;
        let title = parsed
            .query_pairs()
            .find(|(key, _)| key == "title")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_else(|| "QX Push".to_string());
        return Ok(PushRequest {
            url: validate_push_url(&url)?,
            title: normalize_title(&title),
        });
    }
    if value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind != "url")
    {
        return Err(PushError::Invalid("PUSH_TYPE_UNSUPPORTED".to_string()));
    }
    let url = value
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| PushError::Invalid("PUSH_URL_REQUIRED".to_string()))?;
    Ok(PushRequest {
        url: validate_push_url(url)?,
        title: normalize_title(
            value
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("QX Push"),
        ),
    })
}

fn validate_push_url(value: &str) -> Result<String, PushError> {
    let parsed =
        Url::parse(value).map_err(|_| PushError::Invalid("PUSH_URL_INVALID".to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(PushError::Invalid("PUSH_URL_BLOCKED".to_string()));
    }
    Ok(parsed.to_string())
}

fn normalize_title(value: &str) -> String {
    let title = value
        .trim()
        .chars()
        .filter(|value| *value != '\r' && *value != '\n')
        .take(200)
        .collect::<String>();
    if title.is_empty() {
        "QX Push".to_string()
    } else {
        title
    }
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, PushError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| PushError::Invalid(format!("PUSH_{key}_REQUIRED")))
}

fn recent_record(
    pending: &PendingRequest,
    status: &str,
    session_id: Option<String>,
    error: Option<Value>,
) -> Value {
    json!({
        "id": pending.id,
        "type": "url",
        "title": pending.request.title,
        "status": status,
        "requestedBy": pending.requested_by,
        "createdAt": pending.created_at,
        "sessionId": session_id,
        "error": error
    })
}

fn preview(pending: &PendingRequest) -> Value {
    json!({
        "id": pending.id,
        "type": "url",
        "title": pending.request.title,
        "targetHost": Url::parse(&pending.request.url).ok().and_then(|url| url.host_str().map(ToOwned::to_owned)),
        "requestedBy": pending.requested_by,
        "createdAt": pending.created_at
    })
}

fn session_value(session: &Session) -> Value {
    json!({
        "id": session.id,
        "kind": "vod",
        "title": session.title,
        "state": session.state
    })
}

async fn handle_connection(state: PushState, mut stream: TcpStream) {
    let result = async {
        let (method, path, body) = read_request(&mut stream).await?;
        if method != "POST" {
            return Err(PushError::Invalid("PUSH_METHOD_UNSUPPORTED".to_string()));
        }
        let value: Value = serde_json::from_slice(&body)
            .map_err(|_| PushError::Invalid("PUSH_BODY_INVALID".to_string()))?;
        let result = match path.as_str() {
            "/push" => {
                let request = parse_push_request(&value)?;
                state.submit_request(request, "localhost", None).await?
            }
            "/push/confirm" => {
                let id = required_string(&value, "id")?;
                let decision = value
                    .get("decision")
                    .and_then(Value::as_str)
                    .unwrap_or("play");
                state
                    .confirm(id, decision, value.get("mode").and_then(Value::as_str))
                    .await?
            }
            "/push/cancel" => {
                let id = required_string(&value, "id")?;
                state.cancel(id).await?
            }
            _ => return Err(PushError::Invalid("PUSH_ROUTE_NOT_FOUND".to_string())),
        };
        let status = if result.get("kind").and_then(Value::as_str) == Some("confirmation-required")
        {
            202
        } else {
            200
        };
        write_json(&mut stream, status, &result).await
    }
    .await;
    if let Err(error) = result {
        let (status, value) = match &error {
            PushError::Conflict(message) => {
                (409, json!({"error":message,"errorCode":"PUSH_CONFLICT"}))
            }
            PushError::Invalid(message) => (400, json!({"error":message,"errorCode":message})),
            PushError::Storage(message) => (
                500,
                json!({"error":message,"errorCode":"PUSH_START_FAILED"}),
            ),
        };
        let _ = write_json(&mut stream, status, &value).await;
    }
}

async fn read_request(stream: &mut TcpStream) -> Result<(String, String, Vec<u8>), PushError> {
    let mut data = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end;
    let content_length;
    loop {
        let size = stream
            .read(&mut buffer)
            .await
            .map_err(|error| PushError::Storage(format!("PUSH_READ_FAILED:{error}")))?;
        if size == 0 {
            return Err(PushError::Invalid("PUSH_BODY_INVALID".to_string()));
        }
        data.extend_from_slice(&buffer[..size]);
        if data.len() > MAX_BODY_BYTES + 16 * 1024 {
            return Err(PushError::Invalid("PUSH_BODY_TOO_LARGE".to_string()));
        }
        if let Some(index) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = index + 4;
            let headers = String::from_utf8_lossy(&data[..index]);
            content_length = headers
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    (key.eq_ignore_ascii_case("content-length"))
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            break;
        }
    }
    if content_length > MAX_BODY_BYTES {
        return Err(PushError::Invalid("PUSH_BODY_TOO_LARGE".to_string()));
    }
    while data.len() < header_end + content_length {
        let size = stream
            .read(&mut buffer)
            .await
            .map_err(|error| PushError::Storage(format!("PUSH_READ_FAILED:{error}")))?;
        if size == 0 {
            return Err(PushError::Invalid("PUSH_BODY_INVALID".to_string()));
        }
        data.extend_from_slice(&buffer[..size]);
    }
    let request_header = String::from_utf8_lossy(&data[..header_end]);
    let request_line = request_header
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>();
    if request_line.len() < 2 {
        return Err(PushError::Invalid("PUSH_REQUEST_INVALID".to_string()));
    }
    Ok((
        request_line[0].to_string(),
        request_line[1].to_string(),
        data[header_end..header_end + content_length].to_vec(),
    ))
}

async fn write_json(stream: &mut TcpStream, status: u16, value: &Value) -> Result<(), PushError> {
    let body = serde_json::to_vec(value).map_err(|error| PushError::Storage(error.to_string()))?;
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        409 => "Conflict",
        500 => "Internal Server Error",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|error| PushError::Storage(error.to_string()))?;
    stream
        .write_all(&body)
        .await
        .map_err(|error| PushError::Storage(error.to_string()))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::{parse_push_request, PushPayload, PushState};
    use serde_json::json;

    #[test]
    fn parses_only_explicit_url_push_requests() {
        let request = parse_push_request(&json!({
            "uri": "push://url?url=https%3A%2F%2Fmedia.example.test%2Fmovie.m3u8&title=Fixture"
        }))
        .expect("URL push");
        assert_eq!(request.url, "https://media.example.test/movie.m3u8");
        assert_eq!(request.title, "Fixture");
        assert!(parse_push_request(&json!({"type":"source-item","contentId":"1"})).is_err());
        assert!(parse_push_request(&json!({"url":"file:///C:/movie.mp4"})).is_err());
        assert!(parse_push_request(&json!({
            "url":"https://media.example.test/movie.mp4",
            "headers":{"Referer":"https://source.example.test/"}
        }))
        .is_err());
        assert!(parse_push_request(&json!({
            "uri":"push://url?url=https%3A%2F%2Fmedia.example.test%2Fmovie.mp4",
            "headers":{"Referer":"https://source.example.test/"}
        }))
        .is_err());
    }

    #[tokio::test]
    async fn confirmation_flow_keeps_url_out_of_recent_records() {
        let state = PushState::for_test();
        let pending = state
            .submit_url(
                "https://media.example.test/movie.mp4",
                "Fixture",
                "localhost",
            )
            .await
            .expect("pending push");
        let id = pending["preview"]["id"]
            .as_str()
            .expect("preview id")
            .to_string();
        let accepted = state
            .confirm(&id, "play", None)
            .await
            .expect("accepted push");
        assert_eq!(accepted["kind"], "accepted");
        assert_eq!(accepted["recent"]["status"], "accepted");
        assert!(!accepted["recent"]
            .to_string()
            .contains("media.example.test"));
    }

    #[tokio::test]
    async fn loopback_http_endpoint_returns_confirmation_preview() {
        let state = PushState::for_test();
        let snapshot = state
            .handle(&PushPayload {
                action: "snapshot".to_string(),
                value: json!({}),
            })
            .await
            .expect("push snapshot");
        let endpoint = snapshot.state["push"]["endpoint"]
            .as_str()
            .expect("push endpoint")
            .to_string();
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("HTTP client");
        let response = client
            .post(endpoint)
            .json(&json!({
                "uri": "push://url?url=https%3A%2F%2Fmedia.example.test%2Fmovie.mp4&title=HTTP%20Fixture"
            }))
            .send()
            .await
            .expect("HTTP push");
        assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
        let value: serde_json::Value = response.json().await.expect("HTTP response");
        assert_eq!(value["kind"], "confirmation-required");
        assert_eq!(value["preview"]["title"], "HTTP Fixture");
        state.shutdown().await;
    }
}
