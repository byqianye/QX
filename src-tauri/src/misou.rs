use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Url;
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

use super::source_session::{client_builder_for_url, read_bounded_response, SourceCapabilities};

const API: &str = "csp_misou";
const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) QX-Yingshi/1.0";
const CANDIDATE_BASES: &[&str] = &[
    "http://www.misoso.shop",
    "http://misoso.shop",
    "http://misopan.fun",
];
const MAX_PAGE: u64 = 100_000;

#[derive(Clone, Debug)]
pub struct MisouConfig {
    candidates: Arc<Vec<String>>,
    resolved_base: Arc<Mutex<Option<String>>>,
}

impl Default for MisouConfig {
    fn default() -> Self {
        Self::new()
    }
}

impl MisouConfig {
    pub fn new() -> Self {
        Self::for_candidates(
            CANDIDATE_BASES
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
        )
    }

    fn for_candidates(candidates: Vec<String>) -> Self {
        let candidates = candidates
            .into_iter()
            .filter_map(|candidate| normalize_base(&candidate))
            .collect();
        Self {
            candidates: Arc::new(candidates),
            resolved_base: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(Debug)]
pub enum MisouError {
    Unsupported(String),
    Request(String),
}

pub fn is_supported(api: &str) -> bool {
    api.trim().eq_ignore_ascii_case(API)
}

pub fn capabilities() -> SourceCapabilities {
    SourceCapabilities {
        home: true,
        category: true,
        search: true,
        // MiSou's detail/play branches are provider-specific WangPan code. They
        // need cloud credentials and a local proxy, so the Rust HTTP contract
        // deliberately does not advertise them.
        detail: false,
        playback: false,
        local_proxy: false,
        filters: false,
        pagination: true,
        engine: "http-misou-search".to_string(),
    }
}

pub async fn call(
    method: &str,
    params: Option<&Value>,
    config: &MisouConfig,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, MisouError> {
    match method.to_ascii_lowercase().as_str() {
        "home" => {
            let list = fetch_list(config, 1, None, headers, timeout, cancelled).await?;
            Ok(json!({
                "class": [{"type_id": "1", "type_name": "所有"}],
                "list": list,
            }))
        }
        "category" => {
            let page = page_param(params);
            let list = fetch_list(config, page, None, headers, timeout, cancelled).await?;
            Ok(json!({"list": list}))
        }
        "search" => {
            let key = params
                .and_then(|value| value.get("key"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if key.is_empty() {
                return Err(MisouError::Request("MISOU_SEARCH_KEY_REQUIRED".to_string()));
            }
            // The Android implementation intentionally searches page 1 even
            // when the host supplies a page argument.
            let list = fetch_list(config, 1, Some(key), headers, timeout, cancelled).await?;
            Ok(json!({"list": list}))
        }
        "detail" => Err(MisouError::Unsupported(
            "MISOU_PROVIDER_DETAIL_UNSUPPORTED".to_string(),
        )),
        "player" | "playback" => Err(MisouError::Unsupported(
            "MISOU_PROVIDER_PLAYBACK_UNSUPPORTED".to_string(),
        )),
        other => Err(MisouError::Unsupported(format!(
            "MISOU_METHOD_UNAVAILABLE:{other}"
        ))),
    }
}

async fn fetch_list(
    config: &MisouConfig,
    page: u64,
    keyword: Option<&str>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<Value>, MisouError> {
    let mut failed_bases = Vec::<String>::new();
    let mut last_error = None;
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(MisouError::Request("MISOU_REQUEST_CANCELLED".to_string()));
        }

        let cached = config.resolved_base.lock().await.clone();
        if let Some(base) = cached {
            if !failed_bases.iter().any(|failed| failed == &base) {
                match fetch_once(&base, page, keyword, headers, timeout, cancelled.clone()).await {
                    Ok(list) => return Ok(list),
                    Err(error) if error == "MISOU_REQUEST_CANCELLED" => {
                        return Err(MisouError::Request(error));
                    }
                    Err(error) => {
                        failed_bases.push(base);
                        last_error = Some(error);
                    }
                }
            }
        }

        let mut guard = config.resolved_base.lock().await;
        if let Some(current) = guard.as_ref() {
            if failed_bases.iter().any(|failed| failed == current) {
                *guard = None;
            } else {
                drop(guard);
                continue;
            }
        }

        let mut attempted = false;
        for base in config
            .candidates
            .iter()
            .filter(|base| !failed_bases.iter().any(|failed| failed == *base))
        {
            attempted = true;
            if cancelled.load(Ordering::Acquire) {
                return Err(MisouError::Request("MISOU_REQUEST_CANCELLED".to_string()));
            }
            match fetch_once(base, page, keyword, headers, timeout, cancelled.clone()).await {
                Ok(list) => {
                    *guard = Some(base.clone());
                    return Ok(list);
                }
                Err(error) if error == "MISOU_REQUEST_CANCELLED" => {
                    return Err(MisouError::Request(error));
                }
                Err(error) => last_error = Some(error),
            }
        }

        if !attempted && last_error.is_none() {
            return Err(MisouError::Request("MISOU_ENDPOINTS_EMPTY".to_string()));
        }
        return Err(MisouError::Request(
            last_error.unwrap_or_else(|| "MISOU_HTTP_FAILED".to_string()),
        ));
    }
}

async fn fetch_once(
    base: &str,
    page: u64,
    keyword: Option<&str>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<Value>, String> {
    let mut url = Url::parse(base)
        .map_err(|_| "MISOU_ENDPOINT_INVALID".to_string())?
        .join("/api/disks")
        .map_err(|_| "MISOU_ENDPOINT_INVALID".to_string())?;
    url.query_pairs_mut()
        .append_pair("page", &page.max(1).min(MAX_PAGE).to_string());
    if let Some(keyword) = keyword {
        url.query_pairs_mut().append_pair("keyword", keyword);
    }

    let mut request_headers = headers.clone();
    if !request_headers.contains_key("user-agent") {
        request_headers.insert(
            HeaderName::from_static("user-agent"),
            HeaderValue::from_static(DEFAULT_USER_AGENT),
        );
    }
    if !request_headers.contains_key("accept") {
        request_headers.insert(
            HeaderName::from_static("accept"),
            HeaderValue::from_static("application/json"),
        );
    }

    let client = client_builder_for_url(reqwest::Client::builder(), url.as_str())
        .default_headers(request_headers)
        .redirect(reqwest::redirect::Policy::limited(2))
        .timeout(timeout)
        .build()
        .map_err(|_| "MISOU_CLIENT_INIT_FAILED".to_string())?;
    let response = tokio::select! {
        result = client.get(url).send() => result.map_err(|_| "MISOU_HTTP_FAILED".to_string())?,
        _ = wait_for_cancel(cancelled.clone()) => return Err("MISOU_REQUEST_CANCELLED".to_string()),
    };
    let status = response.status();
    let bytes = tokio::select! {
        result = read_bounded_response(response) => result.map_err(|error| match error {
            super::source_session::BoundedResponseError::TooLarge => "MISOU_RESPONSE_TOO_LARGE".to_string(),
            super::source_session::BoundedResponseError::Request(_) => "MISOU_HTTP_FAILED".to_string(),
        })?,
        _ = wait_for_cancel(cancelled) => return Err("MISOU_REQUEST_CANCELLED".to_string()),
    };
    if !status.is_success() {
        return Err(format!("MISOU_HTTP_STATUS:{}", status.as_u16()));
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "MISOU_RESPONSE_INVALID".to_string())?;
    let list = value
        .get("list")
        .and_then(Value::as_array)
        .ok_or_else(|| "MISOU_LIST_REQUIRED".to_string())?;
    Ok(list.iter().map(map_item).collect())
}

fn map_item(value: &Value) -> Value {
    let object = value.as_object();
    let mut item = Map::new();
    for key in ["vod_id", "vod_name", "vod_pic", "vod_remarks"] {
        item.insert(
            key.to_string(),
            Value::String(
                object
                    .and_then(|value| scalar_text(value.get(key)))
                    .unwrap_or_default(),
            ),
        );
    }
    Value::Object(item)
}

fn scalar_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn page_param(params: Option<&Value>) -> u64 {
    params
        .and_then(|value| value.get("page"))
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(1)
        .max(1)
        .min(MAX_PAGE)
}

fn normalize_base(value: &str) -> Option<String> {
    let url = Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url.to_string().trim_end_matches('/').to_string())
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
    use super::{call, capabilities, MisouConfig, MisouError};
    use crate::test_support::bind_loopback_tcp;
    use serde_json::json;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn fixture_server(
        listener: tokio::net::TcpListener,
        requests: usize,
        status: &str,
    ) -> (tokio::task::JoinHandle<Vec<String>>, String) {
        let address = listener.local_addr().expect("fixture address");
        let body = r#"{"list":[{"vod_id":"https://pan.quark.cn/s/abc","vod_name":"示例","vod_pic":"https://img.test/p.jpg","vod_remarks":"4K"}]}"#;
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let task = tokio::spawn(async move {
            let mut captured = Vec::new();
            for _ in 0..requests {
                let (mut socket, _) = listener.accept().await.expect("accept fixture request");
                let mut bytes = vec![0_u8; 8192];
                let length = socket.read(&mut bytes).await.expect("read fixture request");
                bytes.truncate(length);
                captured.push(String::from_utf8_lossy(&bytes).to_string());
                socket
                    .write_all(response.as_bytes())
                    .await
                    .expect("write fixture response");
            }
            captured
        });
        (task, format!("http://{address}"))
    }

    async fn concurrent_fixture_server(
        listener: tokio::net::TcpListener,
    ) -> (tokio::task::JoinHandle<()>, String) {
        let address = listener.local_addr().expect("fixture address");
        let body = r#"{"list":[]}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let task = tokio::spawn(async move {
            let (mut prime, _) = listener.accept().await.expect("accept prime request");
            let mut bytes = vec![0_u8; 8192];
            prime.read(&mut bytes).await.expect("read prime request");
            prime
                .write_all(response.as_bytes())
                .await
                .expect("write prime response");

            let (mut first, _) = listener
                .accept()
                .await
                .expect("accept first cached request");
            first
                .read(&mut bytes)
                .await
                .expect("read first cached request");
            let (mut second, _) = tokio::time::timeout(Duration::from_secs(1), listener.accept())
                .await
                .expect("cached requests should connect concurrently")
                .expect("accept second cached request");
            second
                .read(&mut bytes)
                .await
                .expect("read second cached request");
            first
                .write_all(response.as_bytes())
                .await
                .expect("write first cached response");
            second
                .write_all(response.as_bytes())
                .await
                .expect("write second cached response");
        });
        (task, format!("http://{address}"))
    }

    #[tokio::test]
    async fn maps_misou_home_category_and_search_contract() {
        let listener = bind_loopback_tcp().await.expect("bind fixture");
        let (server, base) = fixture_server(listener, 3, "200 OK").await;
        let config = MisouConfig::for_candidates(vec![base]);
        let headers = reqwest::header::HeaderMap::new();
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let home = call(
            "home",
            None,
            &config,
            &headers,
            Duration::from_secs(2),
            cancelled.clone(),
        )
        .await
        .expect("home");
        assert_eq!(home["class"][0]["type_id"], "1");
        assert_eq!(home["list"][0]["vod_name"], "示例");

        let category = call(
            "category",
            Some(&json!({"page": 3})),
            &config,
            &headers,
            Duration::from_secs(2),
            cancelled.clone(),
        )
        .await
        .expect("category");
        assert_eq!(category["list"][0]["vod_id"], "https://pan.quark.cn/s/abc");

        let search = call(
            "search",
            Some(&json!({"key": "斗破苍穹"})),
            &config,
            &headers,
            Duration::from_secs(2),
            cancelled,
        )
        .await
        .expect("search");
        assert_eq!(search["list"][0]["vod_remarks"], "4K");

        let requests = server.await.expect("fixture server");
        assert!(requests[0].contains("/api/disks?page=1"));
        assert!(requests[1].contains("/api/disks?page=3"));
        assert!(requests[2].contains("/api/disks?page=1&keyword="));
    }

    #[tokio::test]
    async fn caches_a_working_misou_base_after_fallback() {
        let bad_listener = bind_loopback_tcp().await.expect("bind bad fixture");
        let good_listener = bind_loopback_tcp().await.expect("bind good fixture");
        let (bad_server, bad_base) = fixture_server(bad_listener, 1, "502 Bad Gateway").await;
        let (good_server, good_base) = fixture_server(good_listener, 2, "200 OK").await;
        let config = MisouConfig::for_candidates(vec![bad_base, good_base]);
        let headers = reqwest::header::HeaderMap::new();
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));

        call(
            "home",
            None,
            &config,
            &headers,
            Duration::from_secs(2),
            cancelled.clone(),
        )
        .await
        .expect("fallback home");
        call(
            "home",
            None,
            &config,
            &headers,
            Duration::from_secs(2),
            cancelled,
        )
        .await
        .expect("cached home");

        assert_eq!(bad_server.await.expect("bad server").len(), 1);
        assert_eq!(good_server.await.expect("good server").len(), 2);
    }

    #[tokio::test]
    async fn cached_misou_requests_do_not_hold_the_resolution_lock() {
        let listener = bind_loopback_tcp().await.expect("bind fixture");
        let (server, base) = concurrent_fixture_server(listener).await;
        let config = MisouConfig::for_candidates(vec![base]);
        let headers = reqwest::header::HeaderMap::new();
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));

        call(
            "home",
            None,
            &config,
            &headers,
            Duration::from_secs(2),
            cancelled.clone(),
        )
        .await
        .expect("prime resolved base");

        let first_params = json!({"key": "一"});
        let second_params = json!({"key": "二"});
        let (first, second) = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(
                call(
                    "search",
                    Some(&first_params),
                    &config,
                    &headers,
                    Duration::from_secs(2),
                    cancelled.clone(),
                ),
                call(
                    "search",
                    Some(&second_params),
                    &config,
                    &headers,
                    Duration::from_secs(2),
                    cancelled,
                )
            )
        })
        .await
        .expect("cached requests complete without serialization");
        first.expect("first cached request");
        second.expect("second cached request");
        server.await.expect("fixture server");
    }

    #[tokio::test]
    async fn clears_a_cached_misou_base_after_all_candidates_fail() {
        let listener = bind_loopback_tcp().await.expect("bind fixture");
        let (server, base) = fixture_server(listener, 1, "502 Bad Gateway").await;
        let config = MisouConfig::for_candidates(vec![base.clone()]);
        *config.resolved_base.lock().await = Some(base);

        let error = call(
            "home",
            None,
            &config,
            &reqwest::header::HeaderMap::new(),
            Duration::from_secs(2),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .await
        .expect_err("failed cached base should fail the request");
        assert!(matches!(
            error,
            MisouError::Request(message) if message == "MISOU_HTTP_STATUS:502"
        ));
        assert!(config.resolved_base.lock().await.is_none());
        assert_eq!(server.await.expect("fixture server").len(), 1);
    }

    #[tokio::test]
    async fn stale_cached_failure_does_not_clear_a_newer_resolution() {
        let old_listener = bind_loopback_tcp().await.expect("bind old fixture");
        let old_address = old_listener.local_addr().expect("old fixture address");
        let old_base = format!("http://{old_address}");
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let old_server = tokio::spawn(async move {
            let (mut socket, _) = old_listener.accept().await.expect("accept old request");
            let mut bytes = vec![0_u8; 8192];
            socket.read(&mut bytes).await.expect("read old request");
            started_tx.send(()).expect("signal old request");
            release_rx.await.expect("release old response");
            socket
                .write_all(
                    b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("write old response");
        });

        let new_listener = bind_loopback_tcp().await.expect("bind new fixture");
        let (new_server, new_base) = fixture_server(new_listener, 1, "200 OK").await;
        let config = MisouConfig::for_candidates(vec![old_base.clone(), new_base.clone()]);
        *config.resolved_base.lock().await = Some(old_base);

        let request_config = config.clone();
        let request = tokio::spawn(async move {
            call(
                "home",
                None,
                &request_config,
                &reqwest::header::HeaderMap::new(),
                Duration::from_secs(2),
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
            )
            .await
        });
        started_rx.await.expect("old request starts");
        let mut guard = tokio::time::timeout(Duration::from_secs(1), config.resolved_base.lock())
            .await
            .expect("cached request must not hold the resolution lock");
        *guard = Some(new_base.clone());
        drop(guard);
        release_tx.send(()).expect("release old request");

        request
            .await
            .expect("request task")
            .expect("request retries the newer base");
        assert_eq!(
            config.resolved_base.lock().await.as_deref(),
            Some(new_base.as_str())
        );
        old_server.await.expect("old fixture server");
        assert_eq!(new_server.await.expect("new fixture server").len(), 1);
    }

    #[tokio::test]
    #[ignore = "real MiSou search canary; network-dependent"]
    async fn real_misou_search_chain_keeps_provider_playback_closed() {
        let config = MisouConfig::new();
        let headers = reqwest::header::HeaderMap::new();
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let timeout = Duration::from_secs(20);

        let home = call("home", None, &config, &headers, timeout, cancelled.clone())
            .await
            .expect("MiSou home");
        assert!(home["list"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));

        let search = call(
            "search",
            Some(&json!({"key":"流浪地球"})),
            &config,
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("MiSou search");
        let id = search["list"]
            .as_array()
            .and_then(|items| items.first())
            .and_then(|item| item["vod_id"].as_str())
            .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
            .expect("MiSou search must expose a public share URL");

        let detail = call(
            "detail",
            Some(&json!({"ids":[id]})),
            &config,
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect_err("MiSou provider detail must stay closed");
        assert!(
            matches!(detail, MisouError::Unsupported(message) if message == "MISOU_PROVIDER_DETAIL_UNSUPPORTED")
        );
        let playback = call(
            "player",
            Some(&json!({"id":id})),
            &config,
            &headers,
            timeout,
            cancelled,
        )
        .await
        .expect_err("MiSou provider playback must stay closed");
        assert!(
            matches!(playback, MisouError::Unsupported(message) if message == "MISOU_PROVIDER_PLAYBACK_UNSUPPORTED")
        );
        eprintln!("MiSou search verified: {id}; provider detail/playback remains credential-gated");
    }

    #[test]
    fn keeps_provider_detail_and_playback_closed() {
        let value = capabilities();
        assert!(value.home);
        assert!(value.category);
        assert!(value.search);
        assert!(!value.detail);
        assert!(!value.playback);
        assert_eq!(value.engine, "http-misou-search");
        assert!(matches!(
            MisouError::Unsupported("x".to_string()),
            MisouError::Unsupported(_)
        ));
    }
}
