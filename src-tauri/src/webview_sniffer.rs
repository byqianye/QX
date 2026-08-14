use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;
use uuid::Uuid;

const SCHEMA_VERSION: &str = "qx.webview-sniffer.v1";
const DEFAULT_MAX_REDIRECTS: u32 = 3;
const DEFAULT_MAX_PAGES: u32 = 4;
const DEFAULT_MAX_RESOURCES: u32 = 96;
const DEFAULT_MAX_TOTAL_MS: u64 = 15_000;
const DEFAULT_MAX_IDLE_MS: u64 = 2_500;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewSnifferPayload {
    pub action: String,
    pub session_id: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub playback_session_id: Option<String>,
    #[serde(default)]
    pub initial_url: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    #[serde(default)]
    pub max_redirects: Option<u32>,
    #[serde(default)]
    pub max_pages: Option<u32>,
    #[serde(default)]
    pub max_resources: Option<u32>,
    #[serde(default)]
    pub max_total_ms: Option<u64>,
    #[serde(default)]
    pub max_idle_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewSnifferResult {
    pub schema_version: String,
    pub session_id: String,
    pub state: String,
    pub media: Option<Value>,
    pub candidate_count: u32,
    pub rejected_count: u32,
    pub data_directory_removed: bool,
    pub platform: String,
}

#[derive(Debug)]
pub enum WebviewSnifferError {
    Invalid(String),
    Unsupported(String),
    Window(String),
    Failed(String),
    Cancelled(String),
    Timeout(String),
}

#[cfg(windows)]
struct SnifferRunState {
    candidates: u32,
    rejected: u32,
    redirects: u32,
    pages: u32,
    resources: u32,
    last_activity: Instant,
}

#[cfg(windows)]
impl Default for SnifferRunState {
    fn default() -> Self {
        Self {
            candidates: 0,
            rejected: 0,
            redirects: 0,
            pages: 0,
            resources: 0,
            last_activity: Instant::now(),
        }
    }
}

impl WebviewSnifferError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "WEBVIEW_SNIFFER_INVALID",
            Self::Unsupported(_) => "WEBVIEW_SNIFFER_UNSUPPORTED",
            Self::Window(_) => "WEBVIEW_SNIFFER_WINDOW_FAILED",
            Self::Failed(_) => "WEBVIEW_SNIFFER_FAILED",
            Self::Cancelled(_) => "WEBVIEW_SNIFFER_CANCELLED",
            Self::Timeout(_) => "WEBVIEW_SNIFFER_TIMEOUT",
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(self, Self::Window(_) | Self::Timeout(_))
    }

    pub fn message(&self) -> String {
        match self {
            Self::Invalid(message)
            | Self::Unsupported(message)
            | Self::Window(message)
            | Self::Failed(message)
            | Self::Cancelled(message)
            | Self::Timeout(message) => message.clone(),
        }
    }
}

#[derive(Default)]
pub struct WebviewSnifferState {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl WebviewSnifferState {
    pub async fn handle(
        &self,
        app: &AppHandle,
        payload: &WebviewSnifferPayload,
    ) -> Result<WebviewSnifferResult, WebviewSnifferError> {
        if payload.session_id.trim().is_empty() || payload.session_id.len() > 128 {
            return Err(WebviewSnifferError::Invalid(
                "WEBVIEW_SNIFFER_SESSION_INVALID".to_string(),
            ));
        }

        match payload.action.as_str() {
            "snapshot" => {
                let running = self
                    .active
                    .lock()
                    .map_err(|_| {
                        WebviewSnifferError::Failed("WEBVIEW_SNIFFER_STATE_POISONED".to_string())
                    })?
                    .contains_key(&payload.session_id);
                Ok(snapshot(
                    &payload.session_id,
                    if running { "running" } else { "idle" },
                    None,
                    0,
                    0,
                    false,
                ))
            }
            "cancel" => {
                let cancelled = self
                    .active
                    .lock()
                    .map_err(|_| {
                        WebviewSnifferError::Failed("WEBVIEW_SNIFFER_STATE_POISONED".to_string())
                    })?
                    .get(&payload.session_id)
                    .cloned();
                if let Some(flag) = cancelled {
                    flag.store(true, Ordering::Release);
                    Ok(snapshot(
                        &payload.session_id,
                        "cancelling",
                        None,
                        0,
                        0,
                        false,
                    ))
                } else {
                    Ok(snapshot(&payload.session_id, "idle", None, 0, 0, false))
                }
            }
            "sniff" => self.sniff(app, payload).await,
            _ => Err(WebviewSnifferError::Invalid(format!(
                "WEBVIEW_SNIFFER_ACTION_UNSUPPORTED:{}",
                payload.action
            ))),
        }
    }

    async fn sniff(
        &self,
        app: &AppHandle,
        payload: &WebviewSnifferPayload,
    ) -> Result<WebviewSnifferResult, WebviewSnifferError> {
        let initial_url = payload.initial_url.as_deref().ok_or_else(|| {
            WebviewSnifferError::Invalid("WEBVIEW_SNIFFER_URL_REQUIRED".to_string())
        })?;
        let initial = Url::parse(initial_url)
            .map_err(|_| WebviewSnifferError::Invalid("WEBVIEW_SNIFFER_URL_INVALID".to_string()))?;
        if !is_http_url(&initial) {
            return Err(WebviewSnifferError::Invalid(
                "WEBVIEW_SNIFFER_URL_SCHEME_UNSUPPORTED".to_string(),
            ));
        }

        let allowed_origins = normalized_origins(&initial, &payload.allowed_origins)?;
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut active = self.active.lock().map_err(|_| {
                WebviewSnifferError::Failed("WEBVIEW_SNIFFER_STATE_POISONED".to_string())
            })?;
            if active.contains_key(&payload.session_id) {
                return Err(WebviewSnifferError::Invalid(
                    "WEBVIEW_SNIFFER_SESSION_ALREADY_ACTIVE".to_string(),
                ));
            }
            active.insert(payload.session_id.clone(), cancel.clone());
        }

        let profile = std::env::temp_dir().join(format!("qx-webview-sniffer-{}", Uuid::new_v4()));
        let label = format!("qx-webview-sniffer-{}", Uuid::new_v4());
        let result = run_sniffer(
            app,
            &label,
            &profile,
            initial,
            allowed_origins,
            payload,
            cancel,
        )
        .await;
        let removed = remove_profile(&profile).await;
        if let Ok(mut active) = self.active.lock() {
            active.remove(&payload.session_id);
        }

        match result {
            Ok(mut result) => {
                result.data_directory_removed = removed;
                Ok(result)
            }
            Err(error) => Err(error),
        }
    }
}

fn snapshot(
    session_id: &str,
    state: &str,
    media: Option<Value>,
    candidate_count: u32,
    rejected_count: u32,
    data_directory_removed: bool,
) -> WebviewSnifferResult {
    WebviewSnifferResult {
        schema_version: SCHEMA_VERSION.to_string(),
        session_id: session_id.to_string(),
        state: state.to_string(),
        media,
        candidate_count,
        rejected_count,
        data_directory_removed,
        platform: std::env::consts::OS.to_string(),
    }
}

async fn remove_profile(path: &PathBuf) -> bool {
    const MAX_ATTEMPTS: usize = 20;
    for attempt in 0..MAX_ATTEMPTS {
        if !path.exists() {
            return true;
        }
        if std::fs::remove_dir_all(path).is_ok() || !path.exists() {
            return true;
        }
        if attempt + 1 < MAX_ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    !path.exists()
}

fn normalized_origins(
    initial: &Url,
    configured: &[String],
) -> Result<Vec<String>, WebviewSnifferError> {
    let mut origins = if configured.is_empty() {
        vec![origin(initial)?]
    } else {
        configured
            .iter()
            .map(|value| {
                let url = Url::parse(value).map_err(|_| {
                    WebviewSnifferError::Invalid("WEBVIEW_SNIFFER_ORIGIN_INVALID".to_string())
                })?;
                if !is_http_url(&url)
                    || url.path() != "/"
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    return Err(WebviewSnifferError::Invalid(
                        "WEBVIEW_SNIFFER_ORIGIN_INVALID".to_string(),
                    ));
                }
                origin(&url)
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    origins.sort();
    origins.dedup();
    Ok(origins)
}

fn origin(url: &Url) -> Result<String, WebviewSnifferError> {
    let host = url.host_str().ok_or_else(|| {
        WebviewSnifferError::Invalid("WEBVIEW_SNIFFER_ORIGIN_HOST_REQUIRED".to_string())
    })?;
    let default_port = match url.scheme() {
        "http" => 80,
        "https" => 443,
        _ => {
            return Err(WebviewSnifferError::Invalid(
                "WEBVIEW_SNIFFER_ORIGIN_SCHEME_INVALID".to_string(),
            ))
        }
    };
    Ok(match url.port() {
        Some(port) if port != default_port => format!("{}://{}:{}", url.scheme(), host, port),
        _ => format!("{}://{}", url.scheme(), host),
    })
}

fn is_http_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
}

fn is_tauri_app_url(url: &Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("tauri.localhost")
}

fn is_allowed_url(url: &Url, allowed_origins: &[String]) -> bool {
    is_http_url(url)
        && origin(url)
            .map(|value| allowed_origins.iter().any(|allowed| allowed == &value))
            .unwrap_or(false)
}

fn safe_headers(input: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    const ALLOWED: [&str; 6] = [
        "accept",
        "accept-language",
        "origin",
        "range",
        "referer",
        "user-agent",
    ];
    input
        .iter()
        .filter_map(|(name, value)| {
            let normalized = name.to_ascii_lowercase();
            if !ALLOWED.contains(&normalized.as_str())
                || value.len() > 4096
                || value.contains('\r')
                || value.contains('\n')
            {
                return None;
            }
            Some((normalized, value.clone()))
        })
        .collect()
}

fn media_score(url: &Url, content_type: Option<&str>, status: i32) -> Option<i32> {
    if !(200..300).contains(&status) {
        return None;
    }
    let path = url.path().to_ascii_lowercase();
    let content_type = content_type.unwrap_or_default().to_ascii_lowercase();
    if content_type.contains("text/html")
        || content_type.starts_with("image/")
        || content_type.contains("application/json")
    {
        return None;
    }
    let mut score = 0;
    if content_type.contains("mpegurl")
        || content_type.contains("x-mpegurl")
        || path.ends_with(".m3u8")
    {
        score += 70;
    } else if content_type.contains("dash+xml") || path.ends_with(".mpd") {
        score += 70;
    } else if content_type.starts_with("video/") || content_type.starts_with("audio/") {
        score += 62;
    } else if [
        ".mp4", ".mkv", ".webm", ".m3u", ".ts", ".m4s", ".aac", ".mp3",
    ]
    .iter()
    .any(|suffix| path.ends_with(suffix))
    {
        score += 58;
    }
    (score >= 60).then_some(score)
}

#[cfg(not(windows))]
async fn run_sniffer(
    _app: &AppHandle,
    _label: &str,
    _profile: &PathBuf,
    _initial: Url,
    _allowed_origins: Vec<String>,
    _payload: &WebviewSnifferPayload,
    _cancel: Arc<AtomicBool>,
) -> Result<WebviewSnifferResult, WebviewSnifferError> {
    Err(WebviewSnifferError::Unsupported(
        "WEBVIEW_SNIFFER_WINDOWS_ONLY".to_string(),
    ))
}

#[cfg(windows)]
async fn run_sniffer(
    app: &AppHandle,
    label: &str,
    profile: &PathBuf,
    initial: Url,
    allowed_origins: Vec<String>,
    payload: &WebviewSnifferPayload,
    cancel: Arc<AtomicBool>,
) -> Result<WebviewSnifferResult, WebviewSnifferError> {
    use tauri::webview::PlatformWebview;
    let (tx, mut rx) = oneshot::channel::<Result<Value, WebviewSnifferError>>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let run = Arc::new(Mutex::new(SnifferRunState {
        last_activity: Instant::now(),
        ..SnifferRunState::default()
    }));
    let setup_error = Arc::new(Mutex::new(None::<String>));
    let max_redirects = payload.max_redirects.unwrap_or(DEFAULT_MAX_REDIRECTS);
    let max_pages = payload.max_pages.unwrap_or(DEFAULT_MAX_PAGES);
    let max_resources = payload.max_resources.unwrap_or(DEFAULT_MAX_RESOURCES);
    let max_total = Duration::from_millis(
        payload
            .max_total_ms
            .unwrap_or(DEFAULT_MAX_TOTAL_MS)
            .min(60_000),
    );
    let max_idle = Duration::from_millis(
        payload
            .max_idle_ms
            .unwrap_or(DEFAULT_MAX_IDLE_MS)
            .min(10_000),
    );
    let request_headers = safe_headers(&payload.headers);
    let allowed_for_navigation = allowed_origins.clone();
    let window = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App("index.html?webview-sniffer=1".into()),
    )
    .title("QX playback sniffer")
    .inner_size(1.0, 1.0)
    .resizable(false)
    .skip_taskbar(true)
    .visible(false)
    .data_directory(profile.clone())
    .on_navigation(move |url| {
        (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
            || is_allowed_url(url, &allowed_for_navigation)
    })
    .build()
    .map_err(|error| WebviewSnifferError::Window(error.to_string()))?;

    let with_webview_result = window.with_webview({
        let tx = tx.clone();
        let run = run.clone();
        let setup_error = setup_error.clone();
        let allowed_origins = allowed_origins.clone();
        let cancel = cancel.clone();
        move |platform: PlatformWebview| {
            let result = configure_webview(
                platform,
                tx,
                run,
                allowed_origins,
                request_headers,
                cancel,
                max_redirects,
                max_pages,
                max_resources,
            );
            if let Err(error) = result {
                if let Ok(mut slot) = setup_error.lock() {
                    *slot = Some(error);
                }
            }
        }
    });
    if let Err(error) = with_webview_result {
        let _ = window.close();
        return Err(WebviewSnifferError::Window(error.to_string()));
    }
    if let Some(error) = setup_error.lock().ok().and_then(|slot| slot.clone()) {
        let _ = window.close();
        return Err(WebviewSnifferError::Window(error));
    }

    window
        .navigate(initial)
        .map_err(|error| WebviewSnifferError::Window(error.to_string()))?;

    let started = Instant::now();
    let result = loop {
        if cancel.load(Ordering::Acquire) {
            break Err(WebviewSnifferError::Cancelled(
                "WEBVIEW_SNIFFER_CANCELLED".to_string(),
            ));
        }
        if started.elapsed() >= max_total {
            break Err(WebviewSnifferError::Timeout(
                "WEBVIEW_SNIFFER_TOTAL_TIMEOUT".to_string(),
            ));
        }
        if run
            .lock()
            .map(|state| state.last_activity.elapsed() >= max_idle)
            .unwrap_or(true)
            && started.elapsed() >= max_idle
        {
            break Err(WebviewSnifferError::Timeout(
                "WEBVIEW_SNIFFER_IDLE_TIMEOUT".to_string(),
            ));
        }
        match tokio::time::timeout(Duration::from_millis(100), &mut rx).await {
            Ok(Ok(result)) => {
                break result.map(|media| {
                    let state = run.lock().expect("sniffer state");
                    snapshot(
                        payload.session_id.as_str(),
                        "found",
                        Some(media),
                        state.candidates,
                        state.rejected,
                        false,
                    )
                })
            }
            Ok(Err(_)) => {
                break Err(WebviewSnifferError::Failed(
                    "WEBVIEW_SNIFFER_RESULT_CHANNEL_CLOSED".to_string(),
                ))
            }
            Err(_) => continue,
        }
    };
    let _ = window.close();
    result
}

#[cfg(windows)]
fn configure_webview(
    platform: tauri::webview::PlatformWebview,
    tx: Arc<Mutex<Option<oneshot::Sender<Result<Value, WebviewSnifferError>>>>>,
    run: Arc<Mutex<SnifferRunState>>,
    allowed_origins: Vec<String>,
    request_headers: BTreeMap<String, String>,
    cancel: Arc<AtomicBool>,
    max_redirects: u32,
    max_pages: u32,
    max_resources: u32,
) -> Result<(), String> {
    use webview2_com::{
        take_pwstr, DownloadStartingEventHandler,
        Microsoft::Web::WebView2::Win32::{ICoreWebView2_2, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL},
        NavigationStartingEventHandler, NewWindowRequestedEventHandler,
        WebResourceRequestedEventHandler, WebResourceResponseReceivedEventHandler,
    };
    use windows::core::{Interface, BOOL, HSTRING, PWSTR};
    use windows::Win32::System::Com::IStream;

    let controller = platform.controller();
    let core = unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
    let environment = platform.environment();
    let filter = HSTRING::from("*");
    unsafe {
        core.AddWebResourceRequestedFilter(&filter, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
            .map_err(|error| error.to_string())?;
    }

    let send_error =
        |tx: &Arc<Mutex<Option<oneshot::Sender<Result<Value, WebviewSnifferError>>>>>,
         error: WebviewSnifferError| {
            if let Ok(mut slot) = tx.lock() {
                if let Some(sender) = slot.take() {
                    let _ = sender.send(Err(error));
                }
            }
        };

    let navigation_tx = tx.clone();
    let navigation_run = run.clone();
    let navigation_origins = allowed_origins.clone();
    let navigation_cancel = cancel.clone();
    let mut navigation_token = 0_i64;
    unsafe {
        core.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut raw_uri = PWSTR::null();
                args.Uri(&mut raw_uri)?;
                let uri = take_pwstr(raw_uri);
                let url = Url::parse(&uri).ok();
                let app_url = url
                    .as_ref()
                    .map(|value| is_tauri_app_url(value))
                    .unwrap_or(false);
                let allowed = app_url
                    || url
                        .as_ref()
                        .map(|value| is_allowed_url(value, &navigation_origins))
                        .unwrap_or(false);
                let mut redirected = BOOL::default();
                let _ = args.IsRedirected(&mut redirected);
                let redirected = redirected.as_bool();
                let over_limit = if let Ok(mut state) = navigation_run.lock() {
                    if redirected {
                        state.redirects = state.redirects.saturating_add(1);
                    }
                    if !app_url {
                        state.pages = state.pages.saturating_add(1);
                    }
                    state.last_activity = Instant::now();
                    state.redirects > max_redirects || state.pages > max_pages
                } else {
                    true
                };
                let should_cancel =
                    navigation_cancel.load(Ordering::Acquire) || !allowed || over_limit;
                args.SetCancel(should_cancel)?;
                if over_limit && !navigation_cancel.load(Ordering::Acquire) {
                    send_error(
                        &navigation_tx,
                        WebviewSnifferError::Failed("WEBVIEW_SNIFFER_NAVIGATION_LIMIT".to_string()),
                    );
                }
                Ok(())
            })),
            &mut navigation_token,
        )
        .map_err(|error| error.to_string())?;
    }

    let resource_tx = tx.clone();
    let resource_run = run.clone();
    let resource_origins = allowed_origins.clone();
    let resource_headers = request_headers.clone();
    let resource_cancel = cancel.clone();
    let resource_environment = environment.clone();
    let mut resource_token = 0_i64;
    unsafe {
        core.add_WebResourceRequested(
            &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let request = args.Request()?;
                let mut raw_uri = PWSTR::null();
                request.Uri(&mut raw_uri)?;
                let uri = take_pwstr(raw_uri);
                let allowed = Url::parse(&uri)
                    .ok()
                    .map(|url| is_tauri_app_url(&url))
                    .unwrap_or(false)
                    || Url::parse(&uri)
                        .ok()
                        .map(|url| is_allowed_url(&url, &resource_origins))
                        .unwrap_or(false);
                let over_limit = if let Ok(mut state) = resource_run.lock() {
                    state.resources = state.resources.saturating_add(1);
                    state.last_activity = Instant::now();
                    state.resources > max_resources
                } else {
                    true
                };
                if !allowed || over_limit || resource_cancel.load(Ordering::Acquire) {
                    let reason = if over_limit {
                        "Too Many Resources"
                    } else {
                        "Forbidden"
                    };
                    let reason = HSTRING::from(reason);
                    let headers = HSTRING::from("");
                    if let Ok(response) = resource_environment.CreateWebResourceResponse(
                        None::<&IStream>,
                        403,
                        &reason,
                        &headers,
                    ) {
                        let _ = args.SetResponse(&response);
                    }
                    if over_limit && !resource_cancel.load(Ordering::Acquire) {
                        send_error(
                            &resource_tx,
                            WebviewSnifferError::Failed(
                                "WEBVIEW_SNIFFER_RESOURCE_LIMIT".to_string(),
                            ),
                        );
                    }
                    return Ok(());
                }
                let headers = request.Headers()?;
                for (name, value) in &resource_headers {
                    let _ = headers.SetHeader(&HSTRING::from(name), &HSTRING::from(value));
                }
                Ok(())
            })),
            &mut resource_token,
        )
        .map_err(|error| error.to_string())?;
    }

    let response_tx = tx.clone();
    let response_run = run.clone();
    let response_origins = allowed_origins.clone();
    let response_headers = request_headers.clone();
    let mut response_token = 0_i64;
    let core2: ICoreWebView2_2 = unsafe { core.cast() }.map_err(|error| error.to_string())?;
    unsafe {
        core2
            .add_WebResourceResponseReceived(
                &WebResourceResponseReceivedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let request = args.Request()?;
                    let mut raw_uri = PWSTR::null();
                    request.Uri(&mut raw_uri)?;
                    let uri = take_pwstr(raw_uri);
                    let Some(url) = Url::parse(&uri).ok() else {
                        return Ok(());
                    };
                    if !is_allowed_url(&url, &response_origins) {
                        return Ok(());
                    }
                    let response = args.Response()?;
                    let mut status = 0_i32;
                    response.StatusCode(&mut status)?;
                    let response_header_collection = response.Headers()?;
                    let content_type = {
                        let mut raw = PWSTR::null();
                        if response_header_collection
                            .GetHeader(&HSTRING::from("Content-Type"), &mut raw)
                            .is_ok()
                        {
                            Some(take_pwstr(raw))
                        } else {
                            None
                        }
                    };
                    let Some(score) = media_score(&url, content_type.as_deref(), status) else {
                        if let Ok(mut state) = response_run.lock() {
                            state.rejected = state.rejected.saturating_add(1);
                            state.last_activity = Instant::now();
                        }
                        return Ok(());
                    };
                    let count = if let Ok(mut state) = response_run.lock() {
                        state.candidates = state.candidates.saturating_add(1);
                        state.last_activity = Instant::now();
                        state.candidates
                    } else {
                        0
                    };
                    let media = json!({
                        "parse": 0,
                        "url": uri,
                        "headers": response_headers,
                        "score": score,
                        "contentType": content_type,
                        "diagnostics": { "redacted": true, "source": "webview2-response" },
                    });
                    let _ = count;
                    if let Ok(mut slot) = response_tx.lock() {
                        if let Some(sender) = slot.take() {
                            let _ = sender.send(Ok(media));
                        }
                    }
                    Ok(())
                })),
                &mut response_token,
            )
            .map_err(|error| error.to_string())?;
    }

    let mut new_window_token = 0_i64;
    unsafe {
        core.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    args.SetHandled(true)?;
                }
                Ok(())
            })),
            &mut new_window_token,
        )
        .map_err(|error| error.to_string())?;
    }
    let core4 =
        unsafe { core.cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_4>() }
            .map_err(|error| error.to_string())?;
    let mut download_token = 0_i64;
    unsafe {
        core4
            .add_DownloadStarting(
                &DownloadStartingEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        args.SetCancel(true)?;
                        args.SetHandled(true)?;
                    }
                    Ok(())
                })),
                &mut download_token,
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_urls_are_allowed() {
        assert!(is_http_url(
            &Url::parse("https://media.example/video.m3u8").unwrap()
        ));
        assert!(!is_http_url(&Url::parse("file:///video.m3u8").unwrap()));
        assert!(!is_http_url(&Url::parse("javascript:alert(1)").unwrap()));
    }

    #[test]
    fn origins_are_exact_and_normalized() {
        let initial = Url::parse("https://media.example/start").unwrap();
        let origins =
            normalized_origins(&initial, &["https://media.example/".to_string()]).unwrap();
        assert!(is_allowed_url(
            &Url::parse("https://media.example/video.m3u8").unwrap(),
            &origins
        ));
        assert!(!is_allowed_url(
            &Url::parse("https://other.example/video.m3u8").unwrap(),
            &origins
        ));
    }

    #[test]
    fn unsafe_headers_are_dropped() {
        let input = BTreeMap::from([
            ("Cookie".to_string(), "secret".to_string()),
            ("Referer".to_string(), "https://media.example".to_string()),
            ("X-Bad".to_string(), "ignored".to_string()),
            ("Range".to_string(), "bytes=0-".to_string()),
            (
                "Origin".to_string(),
                "https://app.example\nforged: 1".to_string(),
            ),
        ]);
        let output = safe_headers(&input);
        assert_eq!(output.len(), 2);
        assert!(output.contains_key("referer"));
        assert!(output.contains_key("range"));
    }

    #[test]
    fn media_candidates_require_media_signal() {
        let playlist = Url::parse("https://media.example/path/index.m3u8").unwrap();
        let html = Url::parse("https://media.example/path/page").unwrap();
        assert!(media_score(&playlist, Some("application/vnd.apple.mpegurl"), 200).unwrap() >= 60);
        assert!(media_score(&html, Some("text/html"), 200).is_none());
        assert!(media_score(&playlist, Some("application/vnd.apple.mpegurl"), 500).is_none());
    }
}
