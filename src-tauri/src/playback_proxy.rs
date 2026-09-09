use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_RANGE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use uuid::Uuid;

const MAX_REQUEST_BYTES: usize = 16 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const MAX_UPSTREAM_CLIENTS: usize = 64;
static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(0);
type ResourceRegistry = Arc<Mutex<HashMap<String, String>>>;
type TargetCache = Arc<Mutex<HashMap<String, (std::net::SocketAddr, Instant)>>>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackProxyPayload {
    pub action: String,
    pub session_id: String,
    pub url: Option<String>,
    pub headers: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackProxySnapshot {
    pub session_id: String,
    pub proxy_url: Option<String>,
    pub media_type: Option<String>,
    pub state: String,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone)]
struct ProxySession {
    session_id: String,
    url: String,
    headers: HeaderMap,
    resources: ResourceRegistry,
    targets: TargetCache,
    cancelled: tokio::sync::watch::Sender<bool>,
}

pub struct PlaybackProxyState {
    sessions: Arc<Mutex<HashMap<String, ProxySession>>>,
    clients: Arc<Mutex<HashMap<String, reqwest::Client>>>,
    base_url: Mutex<Option<String>>,
    server_abort: Mutex<Option<tokio::task::AbortHandle>>,
    server_start: tokio::sync::Mutex<()>,
}

impl Default for PlaybackProxyState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            clients: Arc::new(Mutex::new(HashMap::new())),
            base_url: Mutex::new(None),
            server_abort: Mutex::new(None),
            server_start: tokio::sync::Mutex::new(()),
        }
    }
}

#[derive(Debug)]
pub enum PlaybackProxyError {
    Invalid(String),
    NotFound,
    Request(String),
}

impl PlaybackProxyState {
    pub async fn handle(
        &self,
        payload: &PlaybackProxyPayload,
    ) -> Result<PlaybackProxySnapshot, PlaybackProxyError> {
        match payload.action.as_str() {
            "start" => self.start(payload).await,
            "close" => {
                let (removed, empty) = {
                    let mut sessions = self.sessions.lock().map_err(|_| {
                        PlaybackProxyError::Request("proxy state poisoned".to_string())
                    })?;
                    let token = sessions
                        .iter()
                        .find(|(_, session)| session.session_id == payload.session_id)
                        .map(|(token, _)| token.clone());
                    let removed = token.and_then(|token| sessions.remove(&token));
                    let empty = sessions.is_empty();
                    (removed, empty)
                };
                let Some(removed) = removed else { return Err(PlaybackProxyError::NotFound); };
                removed.cancelled.send_replace(true);
                if empty {
                    self.stop_server()?;
                }
                Ok(PlaybackProxySnapshot {
                    session_id: payload.session_id.clone(),
                    proxy_url: None,
                    media_type: None,
                    state: "closed".to_string(),
                    reason_code: None,
                })
            }
            _ => Err(PlaybackProxyError::Invalid(
                "proxy action must be start or close".to_string(),
            )),
        }
    }

    async fn start(
        &self,
        payload: &PlaybackProxyPayload,
    ) -> Result<PlaybackProxySnapshot, PlaybackProxyError> {
        let raw_url = payload
            .url
            .as_deref()
            .ok_or_else(|| PlaybackProxyError::Invalid("playback URL is required".to_string()))?;
        let url = validate_url(raw_url)?;
        let headers = safe_headers(payload.headers.clone().unwrap_or_default())?;
        let token = create_token(&payload.session_id, &url);
        self.sessions
            .lock()
            .map_err(|_| PlaybackProxyError::Request("proxy state poisoned".to_string()))?
            .insert(
                token.clone(),
                ProxySession {
                    session_id: payload.session_id.clone(),
                    url: url.clone(),
                    headers,
                    resources: Arc::new(Mutex::new(HashMap::new())),
                    targets: Arc::new(Mutex::new(HashMap::new())),
                    cancelled: tokio::sync::watch::channel(false).0,
                },
            );
        let base_url = self.ensure_server().await?;
        Ok(PlaybackProxySnapshot {
            session_id: payload.session_id.clone(),
            proxy_url: Some(format!("{base_url}/__qx_playback/{token}")),
            media_type: Some(media_type(&url).to_string()),
            state: "ready".to_string(),
            reason_code: None,
        })
    }

    async fn ensure_server(&self) -> Result<String, PlaybackProxyError> {
        let _startup_guard = self.server_start.lock().await;
        if let Some(value) = self
            .base_url
            .lock()
            .map_err(|_| PlaybackProxyError::Request("proxy state poisoned".to_string()))?
            .clone()
        {
            return Ok(value);
        }
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
        let address = listener
            .local_addr()
            .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
        let base_url = format!("http://127.0.0.1:{}", address.port());
        *self
            .base_url
            .lock()
            .map_err(|_| PlaybackProxyError::Request("proxy state poisoned".to_string()))? =
            Some(base_url.clone());
        let sessions = self.sessions.clone();
        let clients = self.clients.clone();
        let server_base_url = base_url.clone();
        let handle =
            tokio::spawn(
                async move { run_server(listener, sessions, clients, server_base_url).await },
            );
        *self
            .server_abort
            .lock()
            .map_err(|_| PlaybackProxyError::Request("proxy state poisoned".to_string()))? =
            Some(handle.abort_handle());
        Ok(base_url)
    }

    fn stop_server(&self) -> Result<(), PlaybackProxyError> {
        if let Some(abort) = self
            .server_abort
            .lock()
            .map_err(|_| PlaybackProxyError::Request("proxy state poisoned".to_string()))?
            .take()
        {
            abort.abort();
        }
        *self
            .base_url
            .lock()
            .map_err(|_| PlaybackProxyError::Request("proxy state poisoned".to_string()))? = None;
        self.clients
            .lock()
            .map_err(|_| PlaybackProxyError::Request("proxy client pool poisoned".to_string()))?
            .clear();
        Ok(())
    }
}

impl Drop for PlaybackProxyState {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.lock() {
            for session in sessions.values() { session.cancelled.send_replace(true); }
        }
        if let Ok(mut abort) = self.server_abort.lock() {
            if let Some(handle) = abort.take() {
                handle.abort();
            }
        }
    }
}

async fn run_server(
    listener: TcpListener,
    sessions: Arc<Mutex<HashMap<String, ProxySession>>>,
    clients: Arc<Mutex<HashMap<String, reqwest::Client>>>,
    base_url: String,
) {
    while let Ok((stream, _)) = listener.accept().await {
        let sessions = sessions.clone();
        let clients = clients.clone();
        let base_url = base_url.clone();
        tokio::spawn(async move {
            let _ = serve_connection(stream, sessions, clients, &base_url).await;
        });
    }
}

async fn serve_connection(
    mut stream: TcpStream,
    sessions: Arc<Mutex<HashMap<String, ProxySession>>>,
    clients: Arc<Mutex<HashMap<String, reqwest::Client>>>,
    base_url: &str,
) -> Result<(), PlaybackProxyError> {
    let request = read_request_headers(&mut stream).await?;
    let request = String::from_utf8_lossy(&request);
    let mut lines = request.lines();
    let first = lines.next().unwrap_or_default();
    let mut first_parts = first.split_whitespace();
    let method = first_parts.next().unwrap_or_default();
    let path = first_parts.next().unwrap_or_default();
    if method == "OPTIONS" {
        write_cors_preflight(&mut stream).await?;
        return Ok(());
    }
    if method != "GET" && method != "HEAD" {
        write_error(&mut stream, 405, "Method Not Allowed").await?;
        return Ok(());
    }
    let route = path.strip_prefix("/__qx_playback/").unwrap_or_default();
    let mut route_parts = route.split('/');
    let token = route_parts.next().unwrap_or_default();
    let session = sessions
        .lock()
        .map_err(|_| PlaybackProxyError::Request("proxy state poisoned".to_string()))?
        .get(token)
        .cloned();
    let Some(session) = session else {
        write_error(&mut stream, 404, "Not Found").await?;
        return Ok(());
    };
    let mut cancelled = session.cancelled.subscribe();
    tokio::select! {
      biased;
      _ = cancelled.wait_for(|closed| *closed) => Ok(()),
      result = async {
    let upstream_url = match route_parts.next() {
        None => session.url.clone(),
        Some("resource") => {
            let resource_id = route_parts.next().unwrap_or_default();
            let suffix = route_parts.collect::<Vec<_>>().join("/");
            resolve_resource_url(&session.resources, resource_id, &suffix)?
        }
        Some(_) => {
            write_error(&mut stream, 404, "Not Found").await?;
            return Ok(());
        }
    };
    let method_value = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
    let mut range_header = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("range") {
            range_header = Some(value.trim().to_string());
        }
    }
    let response = match send_upstream_request(
        &clients,
        &session.targets,
        method_value,
        &upstream_url,
        &session.headers,
        range_header.as_deref(),
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            write_error(&mut stream, 502, proxy_error_code(&error)).await?;
            return Err(error);
        }
    };
    // A manifest may be reached through one same-origin redirect. Resolve
    // every URI declared by that manifest against the URL that returned the
    // body, rather than the pre-redirect URL supplied by the player.
    let effective_upstream_url = response.url().to_string();
    if response.status().is_redirection() {
        write_error(&mut stream, 502, "Upstream redirects are not followed").await?;
        return Ok(());
    }
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let is_hls =
        content_type.to_ascii_lowercase().contains("mpegurl") || media_type(&effective_upstream_url) == "hls";
    let is_dash = content_type.to_ascii_lowercase().contains("dash+xml")
        || media_type(&effective_upstream_url) == "dash";
    let is_manifest = is_hls || is_dash;
    let manifest_content_type = manifest_content_type(is_hls, is_dash, &content_type);
    if let Some(content_length) = response.content_length() {
        if content_length > MAX_RESPONSE_BYTES as u64 {
            write_error(&mut stream, 413, "Upstream response too large").await?;
            return Ok(());
        }
    }

    if is_manifest && status.is_success() && method != "HEAD" {
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(proxy_request_error)? {
            if exceeds_response_limit(bytes.len(), chunk.len()) {
                write_error(&mut stream, 413, "Upstream manifest too large").await?;
                return Ok(());
            }
            bytes.extend_from_slice(&chunk);
        }
        let body = String::from_utf8(bytes.to_vec()).map_err(|error| {
            PlaybackProxyError::Request(format!("media manifest is not UTF-8: {error}"))
        })?;
        let output = if is_hls {
            rewrite_hls_playlist(&body, &effective_upstream_url, base_url, token, &session.resources)?
        } else {
            rewrite_dash_manifest(&body, &effective_upstream_url, base_url, token, &session.resources)?
        };
        if output.len() > MAX_RESPONSE_BYTES {
            write_error(&mut stream, 413, "Rewritten manifest too large").await?;
            return Ok(());
        }
        let status_code = status.as_u16();
        let header = format!(
            "HTTP/1.1 {status_code} {}\r\nContent-Type: {manifest_content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range, Content-Type, Accept\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
            status.canonical_reason().unwrap_or("Upstream"),
            output.len(),
        );
        stream
            .write_all(header.as_bytes())
            .await
            .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
        stream.write_all(output.as_bytes()).await
            .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
        finish_framed_response(&mut stream).await;
        return Ok(());
    }

    let status_code = status.as_u16();
    let content_length = response.content_length();
    let response_content_type = if is_manifest {
        manifest_content_type
    } else {
        content_type.as_str()
    };
    let content_range = forwarded_content_range(response.headers());
    let header = format!(
        "HTTP/1.1 {status_code} {}\r\nContent-Type: {response_content_type}\r\n{}{}Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range, Content-Type, Accept\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status.canonical_reason().unwrap_or("Upstream"),
        content_length
            .map(|length| format!("Content-Length: {length}\r\n"))
            .unwrap_or_default(),
        content_range
            .map(|value| format!("Content-Range: {value}\r\n"))
            .unwrap_or_default()
    );
    stream
        .write_all(header.as_bytes())
        .await
        .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
    if method == "HEAD" {
        return Ok(());
    }

    let mut streamed = 0usize;
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| PlaybackProxyError::Request(error.to_string()))?
    {
        if exceeds_response_limit(streamed, chunk.len()) {
            return Err(PlaybackProxyError::Request(
                "upstream response exceeded the streaming limit".to_string(),
            ));
        }
        streamed += chunk.len();
        stream
            .write_all(&chunk)
            .await
            .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
    }
    if content_length.is_some() {
        finish_framed_response(&mut stream).await;
    }
    Ok(())
      } => result,
    }
}

async fn finish_framed_response(stream: &mut TcpStream) {
    // write_all only hands bytes to the socket. An immediate shutdown/drop can
    // truncate a large response while a Windows HTTP filter is still forwarding
    // it. Content-Length lets the client finish without waiting for EOF; allow
    // its close to arrive, with a bound for clients that keep the socket open.
    // The enclosing session cancellation also interrupts this wait.
    let mut closed = [0u8; 1];
    let _ = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut closed)).await;
}

async fn read_request_headers(stream: &mut TcpStream) -> Result<Vec<u8>, PlaybackProxyError> {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 2048];
        loop {
            let count = stream.read(&mut buffer).await.map_err(|_| PlaybackProxyError::Request("PLAYBACK_CLIENT_READ_FAILED".into()))?;
            if count == 0 { return Err(PlaybackProxyError::Request("PLAYBACK_CLIENT_CLOSED".into())); }
            if bytes.len() + count > MAX_REQUEST_BYTES { return Err(PlaybackProxyError::Invalid("PLAYBACK_REQUEST_TOO_LARGE".into())); }
            bytes.extend_from_slice(&buffer[..count]);
            if bytes.windows(4).any(|chunk| chunk == b"\r\n\r\n") { return Ok(bytes); }
        }
    }).await.map_err(|_| PlaybackProxyError::Request("PLAYBACK_CLIENT_TIMEOUT".into()))?
}

fn proxy_request_error(error: reqwest::Error) -> PlaybackProxyError {
    PlaybackProxyError::Request(if error.is_timeout() { "PLAYBACK_UPSTREAM_TIMEOUT" }
        else if error.is_connect() { "PLAYBACK_UPSTREAM_CONNECT_FAILED" }
        else if error.is_body() || error.is_decode() { "PLAYBACK_UPSTREAM_BODY_FAILED" }
        else { "PLAYBACK_UPSTREAM_REQUEST_FAILED" }.into())
}

fn proxy_error_code(error: &PlaybackProxyError) -> &str {
    match error {
        PlaybackProxyError::Request(message) if message.starts_with("PLAYBACK_") => message,
        PlaybackProxyError::Invalid(message) if message.contains("redirect") => "PLAYBACK_REDIRECT_REJECTED",
        PlaybackProxyError::Invalid(_) => "PLAYBACK_TARGET_REJECTED",
        PlaybackProxyError::NotFound => "PLAYBACK_SESSION_CLOSED",
        PlaybackProxyError::Request(_) => "PLAYBACK_UPSTREAM_REQUEST_FAILED",
    }
}

async fn send_upstream_request(
    clients: &Arc<Mutex<HashMap<String, reqwest::Client>>>,
    targets: &TargetCache,
    method: reqwest::Method,
    initial_url: &str,
    headers: &HeaderMap,
    range: Option<&str>,
) -> Result<reqwest::Response, PlaybackProxyError> {
    let mut current_url = initial_url.to_string();
    for redirect_count in 0..=1 {
        let resolved_target = cached_public_target(&current_url, targets).await?;
        let parsed = reqwest::Url::parse(&current_url)
            .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
        let host = parsed.host_str().ok_or_else(|| {
            PlaybackProxyError::Invalid("playback target host is required".to_string())
        })?;
        let client_key = format!("{host}@{resolved_target}");
        let client = {
            let mut pool = clients.lock().map_err(|_| {
                PlaybackProxyError::Request("proxy client pool poisoned".to_string())
            })?;
            if let Some(client) = pool.get(&client_key) {
                client.clone()
            } else {
                let client = reqwest::Client::builder()
                    .timeout(Duration::from_secs(30))
                    .pool_idle_timeout(Duration::from_secs(90))
                    .pool_max_idle_per_host(8)
                    .resolve(host, resolved_target)
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
                insert_bounded_client(&mut pool, client_key, client.clone());
                client
            }
        };
        let mut request = client
            .request(method.clone(), &current_url)
            .headers(headers.clone());
        if let Some(range) = range {
            request = request.header("range", range);
        }
        let response = request
            .send()
            .await
            .map_err(proxy_request_error)?;
        if !response.status().is_redirection() {
            return Ok(response);
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| {
                PlaybackProxyError::Invalid("playback redirect is missing Location".to_string())
            })?;
        current_url = if reqwest::Url::parse(initial_url)
            .ok()
            .is_some_and(|url| url.path().starts_with("/nby/m3u8/play/ts/"))
        {
            redirected_nby_segment_url(initial_url, &current_url, location, redirect_count, headers)?
        } else if reqwest::Url::parse(initial_url)
            .ok()
            .is_some_and(|url| is_lirose_segment_url(&url))
        {
            redirected_lirose_segment_url(initial_url, &current_url, location, redirect_count, headers)?
        } else {
            redirected_same_origin_url(initial_url, &current_url, location, redirect_count)?
        };
    }
    Err(PlaybackProxyError::Invalid(
        "playback redirect limit exceeded".to_string(),
    ))
}

fn redirected_same_origin_url(
    initial_url: &str,
    current_url: &str,
    location: &str,
    redirect_count: usize,
) -> Result<String, PlaybackProxyError> {
    if redirect_count > 0 {
        return Err(PlaybackProxyError::Invalid(
            "playback redirect limit exceeded".to_string(),
        ));
    }
    let initial = reqwest::Url::parse(initial_url)
        .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
    let current = reqwest::Url::parse(current_url)
        .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
    let target = current
        .join(location)
        .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
    validate_resource_target(&target)?;
    let same_origin = target.scheme() == initial.scheme()
        && target.host_str() == initial.host_str()
        && target.port_or_known_default() == initial.port_or_known_default();
    if !same_origin {
        return Err(PlaybackProxyError::Invalid(
            "cross-origin playback redirects are not allowed".to_string(),
        ));
    }
    Ok(target.to_string())
}

fn insert_bounded_client(
    pool: &mut HashMap<String, reqwest::Client>,
    key: String,
    client: reqwest::Client,
) {
    if pool.len() >= MAX_UPSTREAM_CLIENTS {
        if let Some(oldest) = pool.keys().next().cloned() {
            pool.remove(&oldest);
        }
    }
    pool.insert(key, client);
}

fn redirected_nby_segment_url(
    initial_url: &str,
    current_url: &str,
    location: &str,
    redirect_count: usize,
    headers: &HeaderMap,
) -> Result<String, PlaybackProxyError> {
    let initial = reqwest::Url::parse(initial_url)
        .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
    if redirect_count > 0 || !initial.path().starts_with("/nby/m3u8/play/ts/") {
        return Err(PlaybackProxyError::Invalid(
            "upstream redirects are not allowed for this resource".to_string(),
        ));
    }
    let current = reqwest::Url::parse(current_url)
        .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
    let target = current
        .join(location)
        .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
    validate_resource_target(&target)?;
    if !target.path().to_ascii_lowercase().ends_with(".png") {
        return Err(PlaybackProxyError::Invalid(
            "NBY segment redirect target must be a PNG wrapper".to_string(),
        ));
    }
    let same_origin = target.scheme() == current.scheme()
        && target.host_str() == current.host_str()
        && target.port_or_known_default() == current.port_or_known_default();
    if !same_origin
        && headers
            .keys()
            .any(|name| name != reqwest::header::USER_AGENT)
    {
        return Err(PlaybackProxyError::Invalid(
            "cross-origin NBY redirects only allow User-Agent".to_string(),
        ));
    }
    Ok(target.to_string())
}

fn is_lirose_segment_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("cibn-edge-5g.1ljx.com"))
        && url.path().starts_with("/ufile/flv/qq/")
        && url.path().to_ascii_lowercase().ends_with(".ts")
}

fn redirected_lirose_segment_url(
    initial_url: &str,
    current_url: &str,
    location: &str,
    redirect_count: usize,
    headers: &HeaderMap,
) -> Result<String, PlaybackProxyError> {
    let initial = reqwest::Url::parse(initial_url)
        .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
    if redirect_count > 0 || !is_lirose_segment_url(&initial) {
        return Err(PlaybackProxyError::Invalid(
            "upstream redirects are not allowed for this resource".to_string(),
        ));
    }
    let current = reqwest::Url::parse(current_url)
        .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
    let target = current
        .join(location)
        .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
    validate_resource_target(&target)?;
    let same_origin = target.scheme() == initial.scheme()
        && target.host_str() == initial.host_str()
        && target.port_or_known_default() == initial.port_or_known_default();
    if same_origin {
        return Ok(target.to_string());
    }
    let public_handoff = target.scheme() == "https"
        && target
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("omts.tc.qq.com"))
        && target.path().starts_with("///")
        && target.path().to_ascii_lowercase().ends_with(".ts")
        && target
            .query_pairs()
            .any(|(name, value)| name.eq_ignore_ascii_case("token") && !value.is_empty());
    if !public_handoff {
        return Err(PlaybackProxyError::Invalid(
            "cross-origin Lirose redirects must target the public QQ TS handoff".to_string(),
        ));
    }
    if headers
        .keys()
        .any(|name| name != reqwest::header::USER_AGENT)
    {
        return Err(PlaybackProxyError::Invalid(
            "cross-origin Lirose redirects only allow User-Agent".to_string(),
        ));
    }
    Ok(target.to_string())
}

fn forwarded_content_range(headers: &HeaderMap) -> Option<String> {
    headers
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

fn rewrite_hls_playlist(
    body: &str,
    upstream_url: &str,
    base_url: &str,
    token: &str,
    resources: &ResourceRegistry,
) -> Result<String, PlaybackProxyError> {
    let mut rewritten = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            rewritten.push(rewrite_uri_attributes(
                line,
                upstream_url,
                base_url,
                token,
                resources,
            )?);
            continue;
        }
        rewritten.push(proxy_resource_url(
            trimmed,
            upstream_url,
            base_url,
            token,
            resources,
        )?);
    }
    let mut output = rewritten.join("\n");
    if body.ends_with('\n') { output.push('\n'); }
    Ok(output)
}

fn rewrite_dash_manifest(
    body: &str,
    upstream_url: &str,
    base_url: &str,
    token: &str,
    resources: &ResourceRegistry,
) -> Result<String, PlaybackProxyError> {
    let mut rewritten = Vec::new();
    for line in body.lines() {
        let mut value =
            rewrite_xml_text_tag(line, "BaseURL", upstream_url, base_url, token, resources)?;
        for attribute in ["media", "initialization", "sourceURL"] {
            value = rewrite_named_attribute(
                &value,
                attribute,
                upstream_url,
                base_url,
                token,
                resources,
            )?;
        }
        rewritten.push(value);
    }
    Ok(rewritten.join("\n"))
}

fn rewrite_xml_text_tag(
    line: &str,
    tag: &str,
    upstream_url: &str,
    base_url: &str,
    token: &str,
    resources: &ResourceRegistry,
) -> Result<String, PlaybackProxyError> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let Some(open_index) = line.find(&open) else {
        return Ok(line.to_string());
    };
    let value_start = open_index + open.len();
    let Some(close_relative) = line[value_start..].find(&close) else {
        return Ok(line.to_string());
    };
    let value_end = value_start + close_relative;
    let rewritten = proxy_resource_url(
        &line[value_start..value_end],
        upstream_url,
        base_url,
        token,
        resources,
    )?;
    Ok(format!(
        "{}{}{}{}{}",
        &line[..value_start],
        rewritten,
        &line[value_end..value_end],
        close,
        &line[value_end + close.len()..]
    ))
}

fn rewrite_named_attribute(
    line: &str,
    attribute: &str,
    upstream_url: &str,
    base_url: &str,
    token: &str,
    resources: &ResourceRegistry,
) -> Result<String, PlaybackProxyError> {
    let marker = format!("{attribute}=\"");
    let Some(start) = line.find(&marker) else {
        return Ok(line.to_string());
    };
    let value_start = start + marker.len();
    let Some(end_relative) = line[value_start..].find('"') else {
        return Ok(line.to_string());
    };
    let value_end = value_start + end_relative;
    let rewritten = proxy_resource_url(
        &line[value_start..value_end],
        upstream_url,
        base_url,
        token,
        resources,
    )?;
    Ok(format!(
        "{}{}{}",
        &line[..value_start],
        rewritten,
        &line[value_end..]
    ))
}

fn rewrite_uri_attributes(
    line: &str,
    upstream_url: &str,
    base_url: &str,
    token: &str,
    resources: &ResourceRegistry,
) -> Result<String, PlaybackProxyError> {
    let mut result = String::with_capacity(line.len());
    let mut cursor = 0;
    while let Some(relative) = line[cursor..].find("URI=") {
        let start = cursor + relative;
        result.push_str(&line[cursor..start + 4]);
        let quote = line.as_bytes().get(start + 4).copied().unwrap_or_default() as char;
        if quote != '"' && quote != '\'' {
            cursor = start + 4;
            continue;
        }
        result.push(quote);
        let value_start = start + 5;
        let Some(end_relative) = line[value_start..].find(quote) else {
            result.push_str(&line[value_start..]);
            return Ok(result);
        };
        let value_end = value_start + end_relative;
        result.push_str(&proxy_resource_url(
            &line[value_start..value_end],
            upstream_url,
            base_url,
            token,
            resources,
        )?);
        result.push(quote);
        cursor = value_end + 1;
    }
    result.push_str(&line[cursor..]);
    Ok(result)
}

fn proxy_resource_url(
    value: &str,
    upstream_url: &str,
    base_url: &str,
    token: &str,
    resources: &ResourceRegistry,
) -> Result<String, PlaybackProxyError> {
    let upstream = reqwest::Url::parse(upstream_url)
        .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
    let target = upstream
        .join(value)
        .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
    validate_resource_target(&target)?;
    let (route_target, suffix) = split_dash_template_target(&target);
    let resource_id = register_resource(resources, route_target.as_str())?;
    Ok(format!(
        "{base_url}/__qx_playback/{token}/resource/{resource_id}{suffix}"
    ))
}

fn split_dash_template_target(target: &reqwest::Url) -> (reqwest::Url, String) {
    let path = target.path();
    let Some(template_start) = path.find('$') else {
        return (
            target.clone(),
            if path.ends_with('/') {
                "/".to_string()
            } else {
                String::new()
            },
        );
    };
    if target.query().is_some() || target.fragment().is_some() {
        return (target.clone(), String::new());
    }
    let Some(directory_end) = path[..template_start].rfind('/') else {
        return (target.clone(), String::new());
    };
    let suffix = path[directory_end + 1..].to_string();
    if suffix.is_empty() {
        return (target.clone(), String::new());
    }
    let mut route_target = target.clone();
    route_target.set_path(&path[..directory_end + 1]);
    (route_target, format!("/{suffix}"))
}

fn register_resource(
    resources: &ResourceRegistry,
    value: &str,
) -> Result<String, PlaybackProxyError> {
    let resource_id = format!("r{:x}", TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed));
    resources
        .lock()
        .map_err(|_| PlaybackProxyError::Request("proxy resource state poisoned".to_string()))?
        .insert(resource_id.clone(), value.to_string());
    Ok(resource_id)
}

fn resolve_resource_url(
    resources: &ResourceRegistry,
    resource_id: &str,
    suffix: &str,
) -> Result<String, PlaybackProxyError> {
    let value = resources
        .lock()
        .map_err(|_| PlaybackProxyError::Request("proxy resource state poisoned".to_string()))?
        .get(resource_id)
        .cloned()
        .ok_or_else(|| PlaybackProxyError::Invalid("invalid playback resource".to_string()))?;
    let mut target = reqwest::Url::parse(&value)
        .map_err(|_| PlaybackProxyError::Invalid("invalid playback resource".to_string()))?;
    if !suffix.is_empty() {
        if suffix.contains(['?', '#']) {
            return Err(PlaybackProxyError::Invalid(
                "invalid playback resource suffix".to_string(),
            ));
        }
        target = target.join(suffix).map_err(|_| {
            PlaybackProxyError::Invalid("invalid playback resource suffix".to_string())
        })?;
    }
    validate_resource_target(&target)?;
    Ok(target.to_string())
}

fn validate_resource_target(target: &reqwest::Url) -> Result<(), PlaybackProxyError> {
    if !matches!(target.scheme(), "http" | "https")
        || target.host_str().is_none()
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return Err(PlaybackProxyError::Invalid(
            "playlist resources must be HTTP(S) without credentials".to_string(),
        ));
    }
    Ok(())
}

async fn write_error(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
) -> Result<(), PlaybackProxyError> {
    let body = format!("{status} {reason}");
    let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range, Content-Type, Accept\r\nConnection: close\r\n\r\n{body}", body.len());
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|error| PlaybackProxyError::Request(error.to_string()))
}

async fn write_cors_preflight(stream: &mut TcpStream) -> Result<(), PlaybackProxyError> {
    stream
        .write_all(
            b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range, Content-Type, Accept\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await
        .map_err(|error| PlaybackProxyError::Request(error.to_string()))
}

fn validate_url(value: &str) -> Result<String, PlaybackProxyError> {
    let url = reqwest::Url::parse(value.trim())
        .map_err(|_| PlaybackProxyError::Invalid("playback URL must be HTTP(S)".to_string()))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(PlaybackProxyError::Invalid(
            "playback URL must be HTTP(S) without credentials".to_string(),
        ));
    }
    let host = url.host_str().unwrap_or_default();
    let host_for_parse = host.trim_matches(['[', ']']);
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return Err(PlaybackProxyError::Invalid(
            "loopback playback targets are not allowed".to_string(),
        ));
    }
    if let Ok(address) = host_for_parse.parse::<std::net::IpAddr>() {
        if is_blocked_address(address) {
            return Err(PlaybackProxyError::Invalid(
                "private or local playback targets are not allowed".to_string(),
            ));
        }
    }
    Ok(url.to_string())
}

async fn cached_public_target(value: &str, cache: &TargetCache) -> Result<std::net::SocketAddr, PlaybackProxyError> {
    let parsed = reqwest::Url::parse(value).map_err(|_| PlaybackProxyError::Invalid("invalid playback target".into()))?;
    let key = parsed.origin().ascii_serialization();
    if let Some((address, until)) = cache.lock().map_err(|_| PlaybackProxyError::Request("target cache poisoned".into()))?.get(&key) {
        if *until > Instant::now() { return Ok(*address); }
    }
    let (address, ttl) = ensure_public_target(value).await?;
    let mut cache = cache.lock().map_err(|_| PlaybackProxyError::Request("target cache poisoned".into()))?;
    if cache.len() >= MAX_UPSTREAM_CLIENTS { cache.retain(|_, (_, until)| *until > Instant::now()); }
    if cache.len() >= MAX_UPSTREAM_CLIENTS { cache.clear(); }
    cache.insert(key, (address, Instant::now() + ttl));
    Ok(address)
}

async fn ensure_public_target(value: &str) -> Result<(std::net::SocketAddr, Duration), PlaybackProxyError> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| PlaybackProxyError::Invalid("invalid playback target".to_string()))?;
    let host = url.host_str().ok_or_else(|| {
        PlaybackProxyError::Invalid("playback target host is required".to_string())
    })?;
    let port = url.port_or_known_default().ok_or_else(|| {
        PlaybackProxyError::Invalid("playback target port is required".to_string())
    })?;
    if let Ok(address) = host.trim_matches(['[', ']']).parse::<std::net::IpAddr>() {
        if is_blocked_address(address) {
            return Err(PlaybackProxyError::Invalid(
                "private or local playback targets are not allowed".to_string(),
            ));
        }
        return Ok((std::net::SocketAddr::new(address, port), Duration::from_secs(60)));
    }
    // Keep the OS resolver first. A broken local resolver must not prevent
    // playback when the configured HTTPS route can still resolve public DNS.
    let mut addresses = match tokio::time::timeout(Duration::from_secs(2), tokio::net::lookup_host((host, port))).await {
        Ok(Ok(addresses)) => addresses,
        _ => return resolve_https_dns(host, port).await,
    };
    let mut resolved = None;
    while let Some(address) = addresses.next() {
        if is_blocked_address(address.ip()) {
            return Err(PlaybackProxyError::Invalid(
                "playback target resolves to a private or local address".to_string(),
            ));
        }
        resolved.get_or_insert(address);
    }
    resolved.map(|address| (address, Duration::from_secs(60))).ok_or_else(|| {
        PlaybackProxyError::Request("playback target has no resolved address".to_string())
    })
}

async fn resolve_https_dns(host: &str, port: u16) -> Result<(std::net::SocketAddr, Duration), PlaybackProxyError> {
    // Fixed documented resolver, no source credentials, redirects or TLS exceptions.
    let client = reqwest::Client::builder().timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none()).build()
        .map_err(|_| PlaybackProxyError::Request("PLAYBACK_DNS_CLIENT_FAILED".into()))?;
    let mut url = reqwest::Url::parse("https://cloudflare-dns.com/dns-query").expect("fixed DNS URL");
    url.query_pairs_mut().append_pair("name", host).append_pair("type", "A");
    let mut response = client.get(url)
        .header("accept", "application/dns-json")
        .send().await.and_then(reqwest::Response::error_for_status)
        .map_err(|_| PlaybackProxyError::Request("PLAYBACK_DNS_RESOLUTION_FAILED".into()))?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| PlaybackProxyError::Request("PLAYBACK_DNS_RESPONSE_FAILED".into()))? {
        if bytes.len() + chunk.len() > 16 * 1024 { return Err(PlaybackProxyError::Invalid("PLAYBACK_DNS_RESPONSE_TOO_LARGE".into())); }
        bytes.extend_from_slice(&chunk);
    }
    let answer = serde_json::from_slice(&bytes).map_err(|_| PlaybackProxyError::Request("PLAYBACK_DNS_RESPONSE_INVALID".into()))?;
    public_dns_answer(&answer, host, port)
}

fn public_dns_answer(value: &serde_json::Value, host: &str, port: u16) -> Result<(std::net::SocketAddr, Duration), PlaybackProxyError> {
    let invalid = || PlaybackProxyError::Request("PLAYBACK_DNS_RESPONSE_INVALID".into());
    let name = |value: &str| value.trim_end_matches('.').to_ascii_lowercase();
    if value["Status"].as_u64() != Some(0) || value["TC"].as_bool() == Some(true)
        || value["Question"][0]["name"].as_str().map(name) != Some(name(host))
        || value["Question"][0]["type"].as_u64() != Some(1) { return Err(invalid()); }
    let answers = value["Answer"].as_array().ok_or_else(invalid)?;
    if answers.len() > 32 { return Err(invalid()); }
    let mut names = vec![name(host)];
    let mut ttl = 60;
    for _ in 0..8 {
        let previous = names.len();
        for answer in answers {
            if answer["type"].as_u64() == Some(5) && answer["name"].as_str().is_some_and(|v| names.contains(&name(v))) {
                let next = name(answer["data"].as_str().ok_or_else(invalid)?);
                ttl = ttl.min(answer["TTL"].as_u64().unwrap_or(0));
                if !names.contains(&next) { names.push(next); }
            }
        }
        if previous == names.len() { break; }
    }
    let mut first = None;
    for answer in answers.iter().filter(|answer| answer["type"].as_u64() == Some(1)) {
        if !answer["name"].as_str().is_some_and(|v| names.contains(&name(v))) { return Err(invalid()); }
        let address: std::net::Ipv4Addr = answer["data"].as_str().ok_or_else(invalid)?.parse().map_err(|_| invalid())?;
        if is_blocked_address(address.into()) { return Err(PlaybackProxyError::Invalid("playback target resolves to a private or local address".into())); }
        ttl = ttl.min(answer["TTL"].as_u64().unwrap_or(0));
        first.get_or_insert(std::net::SocketAddr::new(address.into(), port));
    }
    first.map(|address| (address, Duration::from_secs(ttl))).ok_or_else(invalid)
}

fn is_blocked_address(address: std::net::IpAddr) -> bool {
    match address {
        std::net::IpAddr::V4(address) => {
            address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || address.is_unspecified()
                || address.is_multicast()
        }
        std::net::IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || address.is_unique_local()
                || address.is_unicast_link_local()
        }
    }
}

fn safe_headers(headers: HashMap<String, String>) -> Result<HeaderMap, PlaybackProxyError> {
    let mut result = HeaderMap::new();
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
            return Err(PlaybackProxyError::Invalid(format!(
                "unsafe playback header: {name}"
            )));
        }
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| PlaybackProxyError::Invalid("invalid playback header".to_string()))?;
        let value = HeaderValue::from_str(&value).map_err(|_| {
            PlaybackProxyError::Invalid("invalid playback header value".to_string())
        })?;
        result.insert(name, value);
    }
    Ok(result)
}

fn media_type(url: &str) -> &'static str {
    let path = reqwest::Url::parse(url)
        .map(|url| url.path().to_ascii_lowercase())
        .unwrap_or_default();
    if path.ends_with(".m3u8") || path == "/nby/m3u8/getm3u8" {
        "hls"
    } else if path.ends_with(".mpd") {
        "dash"
    } else {
        "progressive"
    }
}

fn manifest_content_type<'a>(is_hls: bool, is_dash: bool, upstream: &'a str) -> &'a str {
    if is_hls {
        "application/vnd.apple.mpegurl"
    } else if is_dash {
        "application/dash+xml"
    } else {
        upstream
    }
}

fn exceeds_response_limit(current: usize, next: usize) -> bool {
    current > MAX_RESPONSE_BYTES || next > MAX_RESPONSE_BYTES.saturating_sub(current)
}

fn create_token(session_id: &str, url: &str) -> String {
    let random = Uuid::new_v4();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let counter = TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut digest = Sha256::new();
    digest.update(session_id.as_bytes());
    digest.update(url.as_bytes());
    digest.update(now.to_le_bytes());
    digest.update(counter.to_le_bytes());
    digest.update(random.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest.finalize())[..32].to_string()
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn streams_a_complete_large_manifest_and_cancels_an_active_stream() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = upstream.local_addr().unwrap();
        let manifest = format!("#EXTM3U\n#EXT-X-TARGETDURATION:6\n{}#EXT-X-ENDLIST\n", (0..2200).map(|i|format!("#EXTINF:6,\nsegment{i}.ts\n")).collect::<String>());
        let (stream_started, started) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = upstream.accept().await.unwrap();
            super::read_request_headers(&mut stream).await.unwrap();
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{manifest}", manifest.len()).as_bytes()).await.unwrap();
            stream.shutdown().await.unwrap();
            let (mut stream, _) = upstream.accept().await.unwrap();
            super::read_request_headers(&mut stream).await.unwrap();
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: 1000000\r\n\r\nfirst-chunk").await.unwrap();
            stream_started.send(()).unwrap();
            let mut byte = [0u8; 1];
            tokio::time::timeout(std::time::Duration::from_secs(3), stream.read(&mut byte)).await.expect("upstream released after cancel").ok();
        });
        let proxy = PlaybackProxyState::default();
        let origin = format!("http://media.example.test:{}", address.port());
        let opened = proxy.handle(&PlaybackProxyPayload { action: "start".into(), session_id:"large-manifest".into(), url:Some(format!("{origin}/index.m3u8")), headers:None }).await.unwrap();
        // Only this private test instance pins its controlled TCP fixture.
        let session = proxy.sessions.lock().unwrap().values().next().unwrap().clone();
        session.targets.lock().unwrap().insert(origin, (address, std::time::Instant::now() + std::time::Duration::from_secs(60)));
        proxy.clients.lock().unwrap().insert(format!("media.example.test@{address}"), reqwest::Client::builder().no_proxy().resolve("media.example.test", address).build().unwrap());
        let client = reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(5)).build().unwrap();
        let mut response = client.get(opened.proxy_url.unwrap()).send().await.unwrap();
        let declared = response.content_length();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.unwrap_or_else(|error| panic!("manifest response bytes={} declared={declared:?}: {error}",bytes.len())) { bytes.extend_from_slice(&chunk); }
        let playlist = String::from_utf8(bytes).unwrap();
        assert!(playlist.len() > 200000);
        assert!(playlist.ends_with("#EXT-X-ENDLIST\n"));
        let url = playlist.lines().find(|line|line.starts_with("http")).unwrap();
        let mut response = client.get(url).send().await.unwrap();
        started.await.unwrap();
        assert_eq!(response.chunk().await.unwrap().unwrap(), "first-chunk");
        proxy.handle(&PlaybackProxyPayload {action:"close".into(),session_id:"large-manifest".into(),url:None,headers:None}).await.unwrap();
        assert!(tokio::time::timeout(std::time::Duration::from_secs(2), response.chunk()).await.expect("downstream released after cancel").is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn resolves_manifest_resources_against_the_final_redirect_url() {
        use tokio::io::AsyncWriteExt;

        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = upstream.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut redirect_stream, _) = upstream.accept().await.unwrap();
            super::read_request_headers(&mut redirect_stream).await.unwrap();
            redirect_stream
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: /ufile/main.m3u8\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            redirect_stream.shutdown().await.unwrap();

            let (mut manifest_stream, _) = upstream.accept().await.unwrap();
            super::read_request_headers(&mut manifest_stream).await.unwrap();
            let manifest = "#EXTM3U\n#EXTINF:1,\nsegment.ts\n";
            manifest_stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{manifest}",
                        manifest.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            manifest_stream.shutdown().await.unwrap();
        });

        let proxy = PlaybackProxyState::default();
        let origin = format!("http://media.example.test:{}", address.port());
        let opened = proxy
            .handle(&PlaybackProxyPayload {
                action: "start".into(),
                session_id: "final-redirect-base".into(),
                url: Some(format!("{origin}/cloud/main.m3u8")),
                headers: None,
            })
            .await
            .unwrap();
        let session = proxy.sessions.lock().unwrap().values().next().unwrap().clone();
        session.targets.lock().unwrap().insert(
            origin,
            (address, std::time::Instant::now() + std::time::Duration::from_secs(60)),
        );
        proxy.clients.lock().unwrap().insert(
            format!("media.example.test@{address}"),
            reqwest::Client::builder()
                .no_proxy()
                .resolve("media.example.test", address)
                .build()
                .unwrap(),
        );

        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap();
        let playlist = client
            .get(opened.proxy_url.unwrap())
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(playlist.contains("/__qx_playback/"));
        let resources = session.resources.lock().unwrap();
        assert_eq!(resources.len(), 1);
        assert!(resources.values().any(|value| value.ends_with("/ufile/segment.ts")));
        drop(resources);

        proxy
            .handle(&PlaybackProxyPayload {
                action: "close".into(),
                session_id: "final-redirect-base".into(),
                url: None,
                headers: None,
            })
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn waits_for_complete_request_headers_before_responding() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            super::serve_connection(stream, Default::default(), Default::default(), "http://127.0.0.1").await.unwrap();
        });
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        stream.write_all(b"GET /__qx_playback/missing HTTP/1.1\r\nX-Test: ").await.unwrap();
        let mut first = [0u8; 1];
        assert!(tokio::time::timeout(std::time::Duration::from_millis(80), stream.read(&mut first)).await.is_err(), "must not close a connection while request headers remain unread");
        stream.write_all(b"split-across-packets\r\n\r\n").await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 404"));
        server.await.unwrap();
    }
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use reqwest::header::{HeaderMap, HeaderValue, CONTENT_RANGE};

    use super::{
        exceeds_response_limit, insert_bounded_client, is_blocked_address, manifest_content_type,
        media_type, proxy_resource_url, redirected_lirose_segment_url, redirected_nby_segment_url,
        redirected_same_origin_url, rewrite_dash_manifest,
        rewrite_hls_playlist, PlaybackProxyPayload, PlaybackProxyState, MAX_UPSTREAM_CLIENTS,
    };

    #[test]
    fn identifies_supported_media_types() {
        assert_eq!(media_type("https://example.test/a.m3u8"), "hls");
        assert_eq!(
            media_type("http://media.example.test/nby/m3u8/getM3u8?url=fixture"),
            "hls"
        );
        assert_eq!(media_type("https://example.test/a.mpd"), "dash");
        assert_eq!(media_type("https://example.test/a.mp4"), "progressive");
    }

    #[test]
    fn bounds_nby_segment_redirects_to_one_public_png_handoff_without_credentials() {
        let mut user_agent = HeaderMap::new();
        user_agent.insert(
            reqwest::header::USER_AGENT,
            HeaderValue::from_static("fixture-agent"),
        );
        let initial = "http://media.example.test/nby/m3u8/play/ts/opaque?token=redacted";
        let redirected = redirected_nby_segment_url(
            initial,
            initial,
            "http://cdn.example.test/udata/pkg/segment.png",
            0,
            &user_agent,
        )
        .expect("NBY PNG handoff");
        assert_eq!(redirected, "http://cdn.example.test/udata/pkg/segment.png");

        assert!(redirected_nby_segment_url(
            "https://media.example.test/segment.ts",
            "https://media.example.test/segment.ts",
            "https://cdn.example.test/segment.png",
            0,
            &user_agent,
        )
        .is_err());
        assert!(redirected_nby_segment_url(
            initial,
            initial,
            "http://cdn.example.test/segment.ts",
            0,
            &user_agent,
        )
        .is_err());
        assert!(redirected_nby_segment_url(
            initial,
            initial,
            "http://cdn.example.test/segment.png",
            1,
            &user_agent,
        )
        .is_err());

        let mut credentialed = user_agent;
        credentialed.insert(
            reqwest::header::AUTHORIZATION,
            HeaderValue::from_static("Bearer fixture"),
        );
        assert!(redirected_nby_segment_url(
            initial,
            initial,
            "http://cdn.example.test/segment.png",
            0,
            &credentialed,
        )
        .is_err());
    }

    #[test]
    fn follows_one_same_origin_playback_redirect_and_rejects_cross_origin() {
        let initial = "https://media.example.test/path/playlist.m3u8";
        assert_eq!(
            redirected_same_origin_url(initial, initial, "/path/final.m3u8", 0).unwrap(),
            "https://media.example.test/path/final.m3u8"
        );
        assert!(redirected_same_origin_url(
            initial,
            initial,
            "https://cdn.example.test/final.m3u8",
            0
        )
        .is_err());
        assert!(redirected_same_origin_url(initial, initial, "/path/again.m3u8", 1).is_err());
    }

    #[test]
    fn bounds_lirose_segment_redirect_to_public_qq_handoff() {
        let initial = "https://cibn-edge-5g.1ljx.com/ufile/flv/qq/path/segment-0.ts?tg=@lirose_tv";
        let redirected = redirected_lirose_segment_url(
            initial,
            initial,
            "https://omts.tc.qq.com///opaque/segment.ts?index=0&token=fixture",
            0,
            &HeaderMap::new(),
        )
        .expect("Lirose QQ handoff");
        assert!(redirected.starts_with("https://omts.tc.qq.com///opaque/segment.ts?"));

        assert!(redirected_lirose_segment_url(
            initial,
            initial,
            "https://other.example.test///opaque/segment.ts?token=fixture",
            0,
            &HeaderMap::new(),
        )
        .is_err());
        assert!(redirected_lirose_segment_url(
            initial,
            initial,
            "https://omts.tc.qq.com///opaque/segment.ts?index=0",
            0,
            &HeaderMap::new(),
        )
        .is_err());
        assert!(redirected_lirose_segment_url(
            initial,
            initial,
            "https://omts.tc.qq.com///opaque/segment.ts?token=fixture",
            1,
            &HeaderMap::new(),
        )
        .is_err());

        let mut credentialed = HeaderMap::new();
        credentialed.insert(
            reqwest::header::AUTHORIZATION,
            HeaderValue::from_static("Bearer fixture"),
        );
        assert!(redirected_lirose_segment_url(
            initial,
            initial,
            "https://omts.tc.qq.com///opaque/segment.ts?token=fixture",
            0,
            &credentialed,
        )
        .is_err());
    }

    #[test]
    fn bounds_the_dns_pinned_upstream_client_pool() {
        let mut pool = HashMap::new();
        for index in 0..=MAX_UPSTREAM_CLIENTS {
            insert_bounded_client(&mut pool, format!("host-{index}"), reqwest::Client::new());
        }
        assert_eq!(pool.len(), MAX_UPSTREAM_CLIENTS);
    }

    #[test]
    fn normalizes_manifest_mime_types_for_web_players() {
        assert_eq!(
            manifest_content_type(false, true, "application/octet-stream"),
            "application/dash+xml"
        );
        assert_eq!(
            manifest_content_type(true, false, "application/octet-stream"),
            "application/vnd.apple.mpegurl"
        );
        assert_eq!(
            manifest_content_type(false, false, "video/mp4"),
            "video/mp4"
        );
    }

    #[test]
    fn forwards_partial_content_ranges_for_progressive_media() {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_RANGE, HeaderValue::from_static("bytes 0-99/1000"));
        assert_eq!(
            super::forwarded_content_range(&headers).as_deref(),
            Some("bytes 0-99/1000")
        );
    }

    #[test]
    fn enforces_the_streaming_response_limit_without_overflow() {
        assert!(!exceeds_response_limit(0, super::MAX_RESPONSE_BYTES));
        assert!(!exceeds_response_limit(super::MAX_RESPONSE_BYTES - 1, 1));
        assert!(exceeds_response_limit(super::MAX_RESPONSE_BYTES, 1));
        assert!(exceeds_response_limit(super::MAX_RESPONSE_BYTES - 1, 2));
    }

    #[tokio::test]
    async fn rejects_credentials_and_unsafe_headers_before_starting_proxy() {
        let state = PlaybackProxyState::default();
        let error = state
            .handle(&PlaybackProxyPayload {
                action: "start".to_string(),
                session_id: "s1".to_string(),
                url: Some("https://user:pass@example.test/video.mp4".to_string()),
                headers: None,
            })
            .await
            .expect_err("credentials rejected");
        assert!(format!("{error:?}").contains("without credentials"));
    }

    #[tokio::test]
    async fn closes_the_listener_when_the_last_session_is_closed() {
        let state = PlaybackProxyState::default();
        state
            .handle(&PlaybackProxyPayload {
                action: "start".to_string(),
                session_id: "lifecycle".to_string(),
                url: Some("https://media.example.test/video.mp4".to_string()),
                headers: None,
            })
            .await
            .expect("proxy starts");
        assert!(state.base_url.lock().expect("base url lock").is_some());
        state
            .clients
            .lock()
            .expect("client pool lock")
            .insert("fixture".to_string(), reqwest::Client::new());
        state
            .handle(&PlaybackProxyPayload {
                action: "close".to_string(),
                session_id: "lifecycle".to_string(),
                url: None,
                headers: None,
            })
            .await
            .expect("proxy closes");
        assert!(state.base_url.lock().expect("base url lock").is_none());
        assert!(state.clients.lock().expect("client pool lock").is_empty());
    }

    #[tokio::test]
    async fn concurrent_starts_share_one_listener() {
        let state = PlaybackProxyState::default();
        let first_payload = PlaybackProxyPayload {
            action: "start".to_string(),
            session_id: "concurrent-1".to_string(),
            url: Some("https://media.example.test/one.mp4".to_string()),
            headers: None,
        };
        let second_payload = PlaybackProxyPayload {
            action: "start".to_string(),
            session_id: "concurrent-2".to_string(),
            url: Some("https://media.example.test/two.mp4".to_string()),
            headers: None,
        };
        let (first, second) =
            tokio::join!(state.handle(&first_payload), state.handle(&second_payload),);
        let first = first.expect("first proxy starts");
        let second = second.expect("second proxy starts");
        assert_eq!(
            first
                .proxy_url
                .as_deref()
                .and_then(|value| value.split("/__qx_playback/").next()),
            second
                .proxy_url
                .as_deref()
                .and_then(|value| value.split("/__qx_playback/").next())
        );
    }

    #[test]
    fn rejects_local_and_private_proxy_targets() {
        for url in [
            "http://127.0.0.1/video.mp4",
            "http://10.0.0.2/video.mp4",
            "http://[::1]/video.mp4",
            "https://localhost/video.mp4",
        ] {
            super::validate_url(url).expect_err("local target rejected");
        }
    }

    #[test]
    fn classifies_private_addresses_for_dns_rebinding_protection() {
        assert!(is_blocked_address("192.168.1.1".parse().expect("IPv4")));
        assert!(is_blocked_address("169.254.169.254".parse().expect("IPv4")));
        assert!(is_blocked_address("fd00::1".parse().expect("IPv6")));
        assert!(!is_blocked_address("8.8.8.8".parse().expect("IPv4")));
    }

    #[test]
    fn https_dns_keeps_question_cname_ttl_and_private_target_boundaries() {
        use serde_json::json;
        let valid = json!({"Status":0,"TC":false,"Question":[{"name":"media.example.","type":1}],"Answer":[
            {"name":"media.example.","type":5,"TTL":30,"data":"cdn.example."},
            {"name":"cdn.example.","type":1,"TTL":10,"data":"8.8.8.8"}
        ]});
        let (address, ttl) = super::public_dns_answer(&valid, "media.example", 443).unwrap();
        assert_eq!(address.to_string(), "8.8.8.8:443");
        assert_eq!(ttl.as_secs(), 10);
        for private in ["127.0.0.1", "10.0.0.1", "169.254.169.254"] {
            let mut answer = valid.clone(); answer["Answer"][1]["data"] = json!(private);
            assert!(super::public_dns_answer(&answer, "media.example", 443).is_err());
        }
        let mut mismatch = valid.clone(); mismatch["Question"][0]["name"] = json!("other.example");
        assert!(super::public_dns_answer(&mismatch, "media.example", 443).is_err());
        let mut unrelated = valid.clone(); unrelated["Answer"][1]["name"] = json!("other.example");
        assert!(super::public_dns_answer(&unrelated, "media.example", 443).is_err());
        let mut negative = valid.clone(); negative["Status"] = json!(3);
        assert!(super::public_dns_answer(&negative, "media.example", 443).is_err());
    }

    #[tokio::test]
    #[ignore = "live public DNS and playback request; explicit environment check"]
    async fn real_public_media_dns_works_when_system_resolver_is_unavailable() {
        let (address, _) = super::resolve_https_dns("qd-tjwq-person.tjtele.com", 443).await.unwrap();
        assert!(!is_blocked_address(address.ip()));
    }

    #[test]
    fn rewrites_hls_segments_and_uri_attributes_to_opaque_local_resources() {
        let playlist = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"../keys/key.bin\"\n#EXTINF:4,\n../segments/one.ts\n#EXTINF:4,\nhttps://image-cdn.example.test/video/origin.jpg\n";
        let resources = Arc::new(Mutex::new(HashMap::new()));
        let rewritten = rewrite_hls_playlist(
            playlist,
            "https://media.example.test/hls/main.m3u8",
            "http://127.0.0.1:43123",
            "session-token",
            &resources,
        )
        .expect("playlist rewrite");
        assert!(rewritten.contains("/__qx_playback/session-token/resource/"));
        assert!(!rewritten.contains("../segments/one.ts"));
        assert!(!rewritten.contains("origin.jpg"));
        assert!(!rewritten.contains("../keys/key.bin"));
        assert_eq!(resources.lock().expect("resource registry").len(), 3);
    }

    #[test]
    fn accepts_cross_origin_public_playlist_resources() {
        let resources = Arc::new(Mutex::new(HashMap::new()));
        let rewritten = proxy_resource_url(
            "https://other.example.test/segment.ts",
            "https://media.example.test/main.m3u8",
            "http://127.0.0.1:43123",
            "token",
            &resources,
        )
        .expect("cross-origin resource is declared by the playlist");
        assert!(rewritten.contains("/resource/"));
    }

    #[test]
    fn rejects_credentialed_or_non_http_playlist_resources() {
        for value in [
            "https://user:password@other.example.test/segment.ts",
            "file:///C:/secret.ts",
        ] {
            let resources = Arc::new(Mutex::new(HashMap::new()));
            let error = proxy_resource_url(
                value,
                "https://media.example.test/main.m3u8",
                "http://127.0.0.1:43123",
                "token",
                &resources,
            )
            .expect_err("unsafe playlist resource rejected");
            assert!(format!("{error:?}").contains("HTTP(S) without credentials"));
        }
    }

    #[tokio::test]
    #[ignore = "real Jianpian network canary"]
    async fn real_jianpian_hls_proxy_fetches_cross_origin_segment() {
        let state = PlaybackProxyState::default();
        let snapshot = state
            .handle(&PlaybackProxyPayload {
                action: "start".to_string(),
                session_id: "real-jianpian-hls".to_string(),
                url: Some(
                    "https://mv.cuitonghai.com/api/v2/vip/normal/9388/index.m3u8".to_string(),
                ),
                headers: None,
            })
            .await
            .expect("proxy starts");
        let proxy_url = snapshot.proxy_url.expect("proxy URL");
        let manifest = reqwest::get(&proxy_url)
            .await
            .expect("manifest request")
            .error_for_status()
            .expect("manifest status")
            .text()
            .await
            .expect("manifest body");
        assert!(manifest.starts_with("#EXTM3U"));
        let segment_url = manifest
            .lines()
            .map(str::trim)
            .find(|line| {
                !line.starts_with('#')
                    && line.contains("/__qx_playback/")
                    && line.contains("/resource/")
            })
            .expect("rewritten segment")
            .to_string();
        let segment = reqwest::get(segment_url)
            .await
            .expect("segment request")
            .error_for_status()
            .expect("segment status")
            .bytes()
            .await
            .expect("segment body");
        assert!(
            segment.len() > 188,
            "MPEG-TS segment should contain packets"
        );
        state
            .handle(&PlaybackProxyPayload {
                action: "close".to_string(),
                session_id: "real-jianpian-hls".to_string(),
                url: None,
                headers: None,
            })
            .await
            .expect("proxy closes");
    }

    #[test]
    fn rewrites_dash_media_initialization_and_base_urls() {
        let manifest = "<MPD><Period><BaseURL>video/</BaseURL><Representation media=\"chunk-$Number$.m4s\" initialization=\"init.mp4\"/></Period></MPD>";
        let resources = Arc::new(Mutex::new(HashMap::new()));
        let rewritten = rewrite_dash_manifest(
            manifest,
            "https://media.example.test/manifest.mpd",
            "http://127.0.0.1:43123",
            "session-token",
            &resources,
        )
        .expect("DASH rewrite");
        assert_eq!(
            rewritten
                .matches("/__qx_playback/session-token/resource/")
                .count(),
            3
        );
        assert!(!rewritten.contains("video/</BaseURL>"));
        assert!(rewritten.contains("/chunk-$Number$.m4s"));
    }

    #[test]
    fn resolves_dash_template_suffix_to_the_real_resource() {
        let resources = Arc::new(Mutex::new(HashMap::new()));
        let rewritten = proxy_resource_url(
            "video/chunk-$Number$.m4s",
            "https://media.example.test/manifest.mpd",
            "http://127.0.0.1:43123",
            "session-token",
            &resources,
        )
        .expect("DASH template rewrite");
        let resource = rewritten
            .split_once("/__qx_playback/session-token/resource/")
            .expect("proxy resource route")
            .1;
        let (resource_id, suffix) = resource.split_once('/').expect("template suffix");
        assert_eq!(suffix, "chunk-$Number$.m4s");
        assert_eq!(
            super::resolve_resource_url(&resources, resource_id, suffix)
                .expect("resolve template route"),
            "https://media.example.test/video/chunk-$Number$.m4s"
        );
    }
}
