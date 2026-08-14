use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use uuid::Uuid;

const MAX_REQUEST_BYTES: usize = 16 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(0);

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
}

pub struct PlaybackProxyState {
    sessions: Arc<Mutex<HashMap<String, ProxySession>>>,
    base_url: Mutex<Option<String>>,
    server_abort: Mutex<Option<tokio::task::AbortHandle>>,
    server_start: tokio::sync::Mutex<()>,
}

impl Default for PlaybackProxyState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
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
                if removed.is_none() {
                    return Err(PlaybackProxyError::NotFound);
                }
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
        let server_base_url = base_url.clone();
        let handle =
            tokio::spawn(async move { run_server(listener, sessions, server_base_url).await });
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
        Ok(())
    }
}

impl Drop for PlaybackProxyState {
    fn drop(&mut self) {
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
    base_url: String,
) {
    while let Ok((stream, _)) = listener.accept().await {
        let sessions = sessions.clone();
        let base_url = base_url.clone();
        tokio::spawn(async move {
            let _ = serve_connection(stream, sessions, &base_url).await;
        });
    }
}

async fn serve_connection(
    mut stream: TcpStream,
    sessions: Arc<Mutex<HashMap<String, ProxySession>>>,
    base_url: &str,
) -> Result<(), PlaybackProxyError> {
    let mut request = vec![0_u8; MAX_REQUEST_BYTES];
    let size = stream
        .read(&mut request)
        .await
        .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
    let request = String::from_utf8_lossy(&request[..size]);
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
    let upstream_url = match route_parts.next() {
        None => session.url.clone(),
        Some("resource") => {
            let encoded = route_parts.next().unwrap_or_default();
            let suffix = route_parts.collect::<Vec<_>>().join("/");
            decode_resource_url(encoded, &suffix)?
        }
        Some(_) => {
            write_error(&mut stream, 404, "Not Found").await?;
            return Ok(());
        }
    };
    let resolved_target = match ensure_public_target(&upstream_url).await {
        Ok(address) => address,
        Err(error) => {
            write_error(&mut stream, 502, "Upstream target rejected").await?;
            return Err(error);
        }
    };
    let parsed_upstream = reqwest::Url::parse(&upstream_url)
        .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
    let host = parsed_upstream.host_str().ok_or_else(|| {
        PlaybackProxyError::Invalid("playback target host is required".to_string())
    })?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .resolve(host, resolved_target)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
    let method_value = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
    let mut upstream = client
        .request(method_value, &upstream_url)
        .headers(session.headers);
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("range") {
            upstream = upstream.header("range", value.trim());
        }
    }
    let response = upstream
        .send()
        .await
        .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
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
        content_type.to_ascii_lowercase().contains("mpegurl") || media_type(&upstream_url) == "hls";
    let is_dash = content_type.to_ascii_lowercase().contains("dash+xml")
        || media_type(&upstream_url) == "dash";
    let is_manifest = is_hls || is_dash;
    let manifest_content_type = manifest_content_type(is_hls, is_dash, &content_type);
    if let Some(content_length) = response.content_length() {
        if content_length > MAX_RESPONSE_BYTES as u64 {
            write_error(&mut stream, 413, "Upstream response too large").await?;
            return Ok(());
        }
    }

    if is_manifest && status.is_success() && method != "HEAD" {
        let bytes = response
            .bytes()
            .await
            .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
        let body = String::from_utf8(bytes.to_vec()).map_err(|error| {
            PlaybackProxyError::Request(format!("media manifest is not UTF-8: {error}"))
        })?;
        let output = if is_hls {
            rewrite_hls_playlist(&body, &upstream_url, base_url, token)?
        } else {
            rewrite_dash_manifest(&body, &upstream_url, base_url, token)?
        };
        if output.len() > MAX_RESPONSE_BYTES {
            write_error(&mut stream, 413, "Rewritten manifest too large").await?;
            return Ok(());
        }
        let status_code = status.as_u16();
        let header = format!(
            "HTTP/1.1 {status_code} {}\r\nContent-Type: {manifest_content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range, Content-Type, Accept\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
            status.canonical_reason().unwrap_or("Upstream"),
            output.len()
        );
        stream
            .write_all(header.as_bytes())
            .await
            .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
        stream
            .write_all(output.as_bytes())
            .await
            .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
        return Ok(());
    }

    let status_code = status.as_u16();
    let content_length = response.content_length();
    let response_content_type = if is_manifest {
        manifest_content_type
    } else {
        content_type.as_str()
    };
    let header = format!(
        "HTTP/1.1 {status_code} {}\r\nContent-Type: {response_content_type}\r\n{}Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range, Content-Type, Accept\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status.canonical_reason().unwrap_or("Upstream"),
        content_length
            .map(|length| format!("Content-Length: {length}\r\n"))
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
    Ok(())
}

fn rewrite_hls_playlist(
    body: &str,
    upstream_url: &str,
    base_url: &str,
    token: &str,
) -> Result<String, PlaybackProxyError> {
    let mut rewritten = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            rewritten.push(rewrite_uri_attributes(line, upstream_url, base_url, token)?);
            continue;
        }
        rewritten.push(proxy_resource_url(trimmed, upstream_url, base_url, token)?);
    }
    Ok(rewritten.join("\n"))
}

fn rewrite_dash_manifest(
    body: &str,
    upstream_url: &str,
    base_url: &str,
    token: &str,
) -> Result<String, PlaybackProxyError> {
    let mut rewritten = Vec::new();
    for line in body.lines() {
        let mut value = rewrite_xml_text_tag(line, "BaseURL", upstream_url, base_url, token)?;
        for attribute in ["media", "initialization", "sourceURL"] {
            value = rewrite_named_attribute(&value, attribute, upstream_url, base_url, token)?;
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
    let rewritten =
        proxy_resource_url(&line[value_start..value_end], upstream_url, base_url, token)?;
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
    let rewritten =
        proxy_resource_url(&line[value_start..value_end], upstream_url, base_url, token)?;
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
) -> Result<String, PlaybackProxyError> {
    let upstream = reqwest::Url::parse(upstream_url)
        .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
    let target = upstream
        .join(value)
        .map_err(|error| PlaybackProxyError::Invalid(error.to_string()))?;
    validate_resource_target(&target)?;
    let (route_target, suffix) = split_dash_template_target(&target);
    let encoded = URL_SAFE_NO_PAD.encode(route_target.as_str());
    Ok(format!(
        "{base_url}/__qx_playback/{token}/resource/{encoded}{suffix}"
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

fn decode_resource_url(encoded: &str, suffix: &str) -> Result<String, PlaybackProxyError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| PlaybackProxyError::Invalid("invalid playback resource".to_string()))?;
    let value = String::from_utf8(bytes)
        .map_err(|_| PlaybackProxyError::Invalid("invalid playback resource".to_string()))?;
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

async fn ensure_public_target(value: &str) -> Result<std::net::SocketAddr, PlaybackProxyError> {
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
        return Ok(std::net::SocketAddr::new(address, port));
    }
    let mut addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| {
            PlaybackProxyError::Request(format!("playback target DNS failed: {error}"))
        })?;
    let mut resolved = None;
    while let Some(address) = addresses.next() {
        if is_blocked_address(address.ip()) {
            return Err(PlaybackProxyError::Invalid(
                "playback target resolves to a private or local address".to_string(),
            ));
        }
        resolved.get_or_insert(address);
    }
    resolved.ok_or_else(|| {
        PlaybackProxyError::Request("playback target has no resolved address".to_string())
    })
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
    if path.ends_with(".m3u8") {
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
    use super::{
        exceeds_response_limit, is_blocked_address, manifest_content_type, media_type,
        proxy_resource_url, rewrite_dash_manifest, rewrite_hls_playlist, PlaybackProxyPayload,
        PlaybackProxyState,
    };

    #[test]
    fn identifies_supported_media_types() {
        assert_eq!(media_type("https://example.test/a.m3u8"), "hls");
        assert_eq!(media_type("https://example.test/a.mpd"), "dash");
        assert_eq!(media_type("https://example.test/a.mp4"), "progressive");
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
            .handle(&PlaybackProxyPayload {
                action: "close".to_string(),
                session_id: "lifecycle".to_string(),
                url: None,
                headers: None,
            })
            .await
            .expect("proxy closes");
        assert!(state.base_url.lock().expect("base url lock").is_none());
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
    fn rewrites_hls_segments_and_uri_attributes_to_opaque_local_resources() {
        let playlist = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"../keys/key.bin\"\n#EXTINF:4,\n../segments/one.ts\n";
        let rewritten = rewrite_hls_playlist(
            playlist,
            "https://media.example.test/hls/main.m3u8",
            "http://127.0.0.1:43123",
            "session-token",
        )
        .expect("playlist rewrite");
        assert!(rewritten.contains("/__qx_playback/session-token/resource/"));
        assert!(!rewritten.contains("../segments/one.ts"));
        assert!(!rewritten.contains("../keys/key.bin"));
    }

    #[test]
    fn accepts_cross_origin_public_playlist_resources() {
        let rewritten = proxy_resource_url(
            "https://other.example.test/segment.ts",
            "https://media.example.test/main.m3u8",
            "http://127.0.0.1:43123",
            "token",
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
            let error = proxy_resource_url(
                value,
                "https://media.example.test/main.m3u8",
                "http://127.0.0.1:43123",
                "token",
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
        let rewritten = rewrite_dash_manifest(
            manifest,
            "https://media.example.test/manifest.mpd",
            "http://127.0.0.1:43123",
            "session-token",
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
        let rewritten = proxy_resource_url(
            "video/chunk-$Number$.m4s",
            "https://media.example.test/manifest.mpd",
            "http://127.0.0.1:43123",
            "session-token",
        )
        .expect("DASH template rewrite");
        let resource = rewritten
            .split_once("/__qx_playback/session-token/resource/")
            .expect("proxy resource route")
            .1;
        let (encoded, suffix) = resource.split_once('/').expect("template suffix");
        assert_eq!(suffix, "chunk-$Number$.m4s");
        assert_eq!(
            super::decode_resource_url(encoded, suffix).expect("decode template route"),
            "https://media.example.test/video/chunk-$Number$.m4s"
        );
    }
}
