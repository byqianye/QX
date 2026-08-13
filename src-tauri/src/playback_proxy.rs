use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
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
    url: String,
    headers: HeaderMap,
}

#[derive(Default)]
pub struct PlaybackProxyState {
    sessions: Arc<Mutex<HashMap<String, ProxySession>>>,
    base_url: Mutex<Option<String>>,
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
                let removed = self
                    .sessions
                    .lock()
                    .map_err(|_| PlaybackProxyError::Request("proxy state poisoned".to_string()))?
                    .remove(&payload.session_id);
                if removed.is_none() {
                    return Err(PlaybackProxyError::NotFound);
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
        tokio::spawn(async move { run_server(listener, sessions).await });
        Ok(base_url)
    }
}

async fn run_server(listener: TcpListener, sessions: Arc<Mutex<HashMap<String, ProxySession>>>) {
    while let Ok((stream, _)) = listener.accept().await {
        let sessions = sessions.clone();
        tokio::spawn(async move {
            let _ = serve_connection(stream, sessions).await;
        });
    }
}

async fn serve_connection(
    mut stream: TcpStream,
    sessions: Arc<Mutex<HashMap<String, ProxySession>>>,
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
    if method != "GET" && method != "HEAD" {
        write_error(&mut stream, 405, "Method Not Allowed").await?;
        return Ok(());
    }
    let token = path.strip_prefix("/__qx_playback/").unwrap_or_default();
    let session = sessions
        .lock()
        .map_err(|_| PlaybackProxyError::Request("proxy state poisoned".to_string()))?
        .get(token)
        .cloned();
    let Some(session) = session else {
        write_error(&mut stream, 404, "Not Found").await?;
        return Ok(());
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
    let mut upstream = client.get(session.url).headers(session.headers);
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
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        write_error(&mut stream, 413, "Upstream response too large").await?;
        return Ok(());
    }
    let status_code = status.as_u16();
    let header = format!(
        "HTTP/1.1 {status_code} {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status.canonical_reason().unwrap_or("Upstream"),
        bytes.len()
    );
    stream
        .write_all(header.as_bytes())
        .await
        .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
    if method != "HEAD" {
        stream
            .write_all(&bytes)
            .await
            .map_err(|error| PlaybackProxyError::Request(error.to_string()))?;
    }
    Ok(())
}

async fn write_error(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
) -> Result<(), PlaybackProxyError> {
    let body = format!("{status} {reason}");
    let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    stream
        .write_all(response.as_bytes())
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
        let blocked = match address {
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
        };
        if blocked {
            return Err(PlaybackProxyError::Invalid(
                "private or local playback targets are not allowed".to_string(),
            ));
        }
    }
    Ok(url.to_string())
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
    use super::{media_type, PlaybackProxyPayload, PlaybackProxyState};

    #[test]
    fn identifies_supported_media_types() {
        assert_eq!(media_type("https://example.test/a.m3u8"), "hls");
        assert_eq!(media_type("https://example.test/a.mpd"), "dash");
        assert_eq!(media_type("https://example.test/a.mp4"), "progressive");
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
}
