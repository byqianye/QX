use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use base64::Engine as _;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub(super) const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

pub(super) fn client_builder_for_url(
    builder: reqwest::ClientBuilder,
    raw_url: &str,
) -> reqwest::ClientBuilder {
    if is_loopback_target(raw_url) {
        builder.no_proxy()
    } else {
        builder
    }
}

pub(super) fn is_loopback_target(raw_url: &str) -> bool {
    Url::parse(raw_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .is_some_and(|host| {
            let host = host.trim_start_matches('[').trim_end_matches(']');
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        })
}

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
    app_get: Option<super::app_get::AppGetConfig>,
    misou: Option<super::misou::MisouConfig>,
    first_aid: bool,
    bili: bool,
    push: bool,
    legacy_http: Option<super::legacy_http::LegacyHttpKind>,
    auto_http_base: Option<String>,
    adapter: Option<super::source_converter::CompiledSourceAdapter>,
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

#[derive(Debug)]
pub(super) enum BoundedResponseError {
    TooLarge,
    Request(String),
}

impl BoundedResponseError {
    pub(super) fn message(self, too_large: &str) -> String {
        match self {
            Self::TooLarge => too_large.to_string(),
            Self::Request(message) => message,
        }
    }
}

pub(super) async fn read_bounded_response(
    mut response: reqwest::Response,
) -> Result<Vec<u8>, BoundedResponseError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(BoundedResponseError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or(0)
            .min(MAX_RESPONSE_BYTES as u64) as usize,
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| BoundedResponseError::Request(request_error_message(error)))?
    {
        if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
            return Err(BoundedResponseError::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
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
        if api_value.eq_ignore_ascii_case("csp_Config") {
            return Err(SourceSessionError::Unsupported(
                "CONFIG_SOURCE_LOCAL_ONLY".to_string(),
            ));
        }
        let native = super::native_sources::is_native_api(api_value);
        let ext = payload.ext.clone().unwrap_or_default();
        let first_aid =
            !native && ext.trim().is_empty() && super::first_aid::is_supported(api_value);
        let bili = !native && !first_aid && super::bili::is_supported(api_value);
        let push = !native && !first_aid && !bili && super::push_source::is_supported(api_value);
        let misou =
            if !native && !first_aid && !bili && !push && super::misou::is_supported(api_value) {
                Some(super::misou::MisouConfig::new())
            } else {
                None
            };
        let legacy_http = if !native && !first_aid && !bili && !push && misou.is_none() {
            super::legacy_http::kind_for(api_value, &ext)
        } else {
            None
        };
        let app_get = if !native
            && !first_aid
            && !bili
            && !push
            && misou.is_none()
            && legacy_http.is_none()
            && (super::app_get::is_supported(api_value)
                || super::app_get::is_python_wrapper_api(api_value))
        {
            if super::app_get::is_supported(api_value) {
                super::app_get::from_ext_for(api_value, &ext)
            } else {
                super::app_get::from_python_wrapper_ext(api_value, &ext)
            }
            .map_err(SourceSessionError::Invalid)?
        } else {
            None
        };
        let auto_http_base = if !native
            && !first_aid
            && !bili
            && !push
            && misou.is_none()
            && legacy_http.is_none()
            && app_get.is_none()
        {
            super::auto_http::endpoint_from_ext(api_value, &ext)
        } else {
            None
        };
        let adapter = if !native
            && !first_aid
            && !bili
            && !push
            && misou.is_none()
            && legacy_http.is_none()
            && app_get.is_none()
            && api_value.trim().to_ascii_lowercase().starts_with("csp_")
        {
            match super::source_converter::compile_source_spec(api_value, &ext) {
                Ok(adapter) => Some(adapter),
                Err(error) if auto_http_base.is_some() => {
                    let _ = error;
                    None
                }
                Err(error) => return Err(source_converter_failure(error)),
            }
        } else {
            None
        };
        let api = if native
            || first_aid
            || bili
            || push
            || misou.is_some()
            || legacy_http.is_some()
            || app_get.is_some()
            || auto_http_base.is_some()
            || adapter.is_some()
        {
            api_value.trim().to_string()
        } else {
            validate_api(api_value)?
        };
        let site_type = payload.site_type.unwrap_or(
            if native
                || first_aid
                || bili
                || push
                || misou.is_some()
                || legacy_http.is_some()
                || app_get.is_some()
                || auto_http_base.is_some()
                || adapter.is_some()
            {
                3
            } else {
                1
            },
        );
        if (first_aid || push) && site_type != 3 {
            return Err(SourceSessionError::Invalid(if push {
                "PUSH_SOURCE_SITE_TYPE_MUST_BE_3".to_string()
            } else {
                "FIRST_AID_SITE_TYPE_MUST_BE_3".to_string()
            }));
        }
        if (misou.is_some() || app_get.is_some() || auto_http_base.is_some() || adapter.is_some())
            && site_type != 3
        {
            return Err(SourceSessionError::Invalid(
                "HTTP_ADAPTER_SITE_TYPE_MUST_BE_3".to_string(),
            ));
        }
        if !native
            && !first_aid
            && !bili
            && !push
            && misou.is_none()
            && legacy_http.is_none()
            && app_get.is_none()
            && auto_http_base.is_none()
            && adapter.is_none()
            && !matches!(site_type, 0 | 1 | 4)
        {
            return Err(SourceSessionError::Invalid(
                "CMS source type must be 0, 1, or 4".to_string(),
            ));
        }
        let capabilities = if native {
            super::native_sources::capabilities(&api).ok_or_else(|| {
                SourceSessionError::Invalid(format!("native source is unavailable: {api}"))
            })?
        } else if first_aid {
            super::first_aid::capabilities()
        } else if bili {
            super::bili::capabilities()
        } else if push {
            super::push_source::capabilities()
        } else if misou.is_some() {
            super::misou::capabilities()
        } else if let Some(kind) = legacy_http {
            super::legacy_http::capabilities(kind)
        } else if app_get.is_some() {
            super::app_get::capabilities_for(&api)
        } else if let Some(adapter) = &adapter {
            adapter_capabilities(adapter, &api)
        } else if auto_http_base.is_some() {
            SourceCapabilities {
                home: true,
                category: true,
                search: true,
                detail: true,
                playback: super::source_semantics::supports_direct_playback(&api),
                local_proxy: false,
                filters: true,
                pagination: true,
                engine: "http-auto".to_string(),
            }
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
        let availability_reason = if api.eq_ignore_ascii_case("csp_Jianpian")
            && payload.ext.as_deref().unwrap_or_default().trim().is_empty()
        {
            Some("native_jianpian_ext_required".to_string())
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
            ext,
            app_get,
            misou,
            first_aid,
            bili,
            push,
            legacy_http,
            auto_http_base,
            adapter,
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
        let mut session = self.get(&payload.session_id)?;
        if let Some(timeout_ms) = payload.timeout_ms {
            session.timeout = session.timeout.min(Duration::from_millis(timeout_ms.clamp(1, 120_000)));
        }
        let cancelled = session.cancelled.clone();
        let result = tokio::select! {
            result = tokio::time::timeout(session.timeout, self.call_with_session(payload, session)) => result,
            _ = wait_for_cancel(cancelled.clone()) => return Err(SourceSessionError::Cancelled),
        };
        if cancelled.load(Ordering::Acquire) {
            return Err(SourceSessionError::Cancelled);
        }
        match result {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(error)) => Err(normalize_timeout_error(error)),
            Err(_) => Err(SourceSessionError::Request(
                "SOURCE_SESSION_TIMEOUT".to_string(),
            )),
        }
    }

    async fn call_with_session(
        &self,
        payload: &SourceSessionPayload,
        session: SourceSession,
    ) -> Result<SourceSessionResult, SourceSessionError> {
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
                &session.ext,
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
        if session.first_aid {
            let result = super::first_aid::call(
                &method,
                payload.params.as_ref(),
                &to_header_map(&session.headers)?,
                session.timeout,
                session.cancelled.clone(),
            )
            .await
            .map_err(|error| match error {
                super::first_aid::FirstAidError::Unsupported(message) => {
                    SourceSessionError::Unsupported(message)
                }
                super::first_aid::FirstAidError::Request(message) => {
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
        if session.bili {
            let result = super::bili::call(
                &method,
                payload.params.as_ref(),
                &session.ext,
                &to_header_map(&session.headers)?,
                session.timeout,
                session.cancelled.clone(),
            )
            .await
            .map_err(|error| match error {
                super::bili::BiliError::Unsupported(message) => {
                    SourceSessionError::Unsupported(message)
                }
                super::bili::BiliError::Request(message) => SourceSessionError::Request(message),
            })?;
            return Ok(SourceSessionResult {
                session: session.snapshot,
                method: Some(method),
                result: Some(result),
                cancelled: false,
            });
        }
        if session.push {
            let result = super::push_source::call(&method, payload.params.as_ref())
                .await
                .map_err(|error| match error {
                    super::push_source::PushSourceError::Unsupported(message) => {
                        SourceSessionError::Unsupported(message)
                    }
                    super::push_source::PushSourceError::Request(message) => {
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
        if let Some(misou) = &session.misou {
            let result = super::misou::call(
                &method,
                payload.params.as_ref(),
                misou,
                &to_header_map(&session.headers)?,
                session.timeout,
                session.cancelled.clone(),
            )
            .await
            .map_err(|error| match error {
                super::misou::MisouError::Unsupported(message) => {
                    SourceSessionError::Unsupported(message)
                }
                super::misou::MisouError::Request(message) => SourceSessionError::Request(message),
            })?;
            return Ok(SourceSessionResult {
                session: session.snapshot,
                method: Some(method),
                result: Some(result),
                cancelled: false,
            });
        }
        if let Some(kind) = session.legacy_http {
            let result = super::legacy_http::call(
                kind,
                &method,
                payload.params.as_ref(),
                &session.ext,
                &to_header_map(&session.headers)?,
                session.timeout,
                session.cancelled.clone(),
            )
            .await
            .map_err(|error| match error {
                super::legacy_http::LegacyHttpError::Unsupported(message) => {
                    SourceSessionError::Unsupported(message)
                }
                super::legacy_http::LegacyHttpError::Request(message) => {
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
        if let Some(app_get) = &session.app_get {
            let result = super::app_get::call(
                app_get,
                &method,
                payload.params.as_ref(),
                &to_header_map(&session.headers)?,
                session.timeout,
                session.cancelled.clone(),
            )
            .await
            .map_err(|error| match error {
                super::app_get::AppGetError::Unsupported(message) => {
                    SourceSessionError::Unsupported(message)
                }
                super::app_get::AppGetError::Request(message) => {
                    SourceSessionError::Request(message)
                }
            })?;
            let result = super::source_semantics::apply_appget(&method, result);
            return Ok(SourceSessionResult {
                session: session.snapshot,
                method: Some(method),
                result: Some(result),
                cancelled: false,
            });
        }
        let direct_player_fallback = matches!(method.as_str(), "player" | "playback")
            && session
                .adapter
                .as_ref()
                .map_or(true, |adapter| !adapter.supports(&method));
        if direct_player_fallback {
            if let Some(result) = super::source_semantics::direct_player(
                &session.snapshot.api,
                payload.params.as_ref(),
            ) {
                return Ok(SourceSessionResult {
                    session: session.snapshot,
                    method: Some(method),
                    result: Some(result),
                    cancelled: false,
                });
            }
        }
        if let Some(adapter) = &session.adapter {
            let params = payload.params.clone().unwrap_or_else(|| json!({}));
            let adapter_request = adapter
                .build_request(&method, &params)
                .map_err(source_converter_failure)?;
            let client = client_builder_for_url(reqwest::Client::builder(), &adapter_request.url)
                .default_headers(to_header_map(&session.headers)?)
                .timeout(session.timeout)
                .build()
                .map_err(|error| SourceSessionError::Request(error.to_string()))?;
            let mut request = match adapter_request.method.as_str() {
                "GET" => client.get(&adapter_request.url),
                "POST" => client.post(&adapter_request.url),
                method => {
                    return Err(SourceSessionError::Unsupported(format!(
                        "ADAPTER_METHOD_UNSUPPORTED:{method}"
                    )))
                }
            };
            let mut adapter_headers = session.headers.clone();
            for (name, value) in adapter_request.headers {
                let value = value.as_str().ok_or_else(|| {
                    SourceSessionError::Invalid(format!("ADAPTER_HEADER_INVALID:{name}"))
                })?;
                adapter_headers.insert(name, value.to_string());
            }
            request = request.headers(to_header_map(&adapter_headers)?);
            if let Some(body) = adapter_request.body {
                request = request.json(&body);
            }
            let response = tokio::select! {
                result = request.send() => result.map_err(|error| SourceSessionError::Request(request_error_message(error)))?,
                _ = wait_for_cancel(session.cancelled.clone()) => return Err(SourceSessionError::Cancelled),
            };
            if session.cancelled.load(Ordering::Acquire) {
                return Err(SourceSessionError::Cancelled);
            }
            let status = response.status();
            let bytes = tokio::select! {
                result = read_bounded_response(response) => result.map_err(|error| {
                    SourceSessionError::Request(error.message("HTTP adapter response is too large"))
                })?,
                _ = wait_for_cancel(session.cancelled.clone()) => return Err(SourceSessionError::Cancelled),
            };
            if !status.is_success() {
                return Err(SourceSessionError::Request(format!(
                    "HTTP adapter returned {status}"
                )));
            }
            let body = String::from_utf8_lossy(&bytes)
                .trim_start_matches('\u{feff}')
                .to_string();
            let value: Value = serde_json::from_str(&body).map_err(|error| {
                SourceSessionError::Request(format!(
                    "HTTP adapter response is not valid JSON: {error}"
                ))
            })?;
            let result = adapter
                .map_response(&method, value)
                .map_err(source_converter_failure)?;
            let result = super::source_semantics::apply(&session.snapshot.api, &method, result);
            return Ok(SourceSessionResult {
                session: session.snapshot,
                method: Some(method),
                result: Some(result),
                cancelled: false,
            });
        }
        if let Some(base) = &session.auto_http_base {
            let result = super::auto_http::call(
                base,
                &method,
                payload.params.as_ref(),
                &to_header_map(&session.headers)?,
                session.timeout,
                session.cancelled.clone(),
            )
            .await?;
            let result = super::source_semantics::apply(&session.snapshot.api, &method, result);
            return Ok(SourceSessionResult {
                session: session.snapshot,
                method: Some(method),
                result: Some(result),
                cancelled: false,
            });
        }
        let url = request_url(&session, &method, payload.params.as_ref())?;
        let client = client_builder_for_url(reqwest::Client::builder(), &url)
            .default_headers(to_header_map(&session.headers)?)
            .timeout(session.timeout)
            .build()
            .map_err(|error| SourceSessionError::Request(error.to_string()))?;
        let request = client.get(url);
        let response = tokio::select! {
            result = request.send() => result.map_err(|error| SourceSessionError::Request(request_error_message(error)))?,
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
        let bytes = tokio::select! {
            result = read_bounded_response(response) => result.map_err(|error| {
                SourceSessionError::Request(error.message("HTTP source response is too large"))
            })?,
            _ = wait_for_cancel(session.cancelled.clone()) => return Err(SourceSessionError::Cancelled),
        };
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
        let result = super::source_semantics::apply(&session.snapshot.api, &method, result);
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

    #[cfg(test)]
    pub(crate) fn active_session_count(&self) -> usize {
        self.sessions
            .lock()
            .map(|sessions| sessions.len())
            .unwrap_or_default()
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

fn source_converter_failure(
    error: super::source_converter::SourceConverterError,
) -> SourceSessionError {
    match error {
        super::source_converter::SourceConverterError::Invalid(message) => {
            SourceSessionError::Invalid(message)
        }
        super::source_converter::SourceConverterError::Unsupported(message) => {
            SourceSessionError::Unsupported(message)
        }
    }
}

fn normalize_timeout_error(error: SourceSessionError) -> SourceSessionError {
    match error {
        SourceSessionError::Request(message) => {
            let lower = message.to_ascii_lowercase();
            if lower.contains("timeout") || lower.contains("timed out") {
                SourceSessionError::Request("SOURCE_SESSION_TIMEOUT".to_string())
            } else {
                SourceSessionError::Request(message)
            }
        }
        error => error,
    }
}

fn request_error_message(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "SOURCE_SESSION_TIMEOUT".to_string()
    } else {
        error.to_string()
    }
}

fn adapter_capabilities(
    adapter: &super::source_converter::CompiledSourceAdapter,
    api: &str,
) -> SourceCapabilities {
    SourceCapabilities {
        home: adapter.supports("home"),
        category: adapter.supports("category"),
        search: adapter.supports("search"),
        detail: adapter.supports("detail"),
        playback: adapter.supports("player")
            || adapter.supports("playback")
            || super::source_semantics::supports_direct_playback(api),
        local_proxy: false,
        filters: adapter.supports("category"),
        pagination: adapter.supports("category") || adapter.supports("search"),
        engine: "http-adapter".to_string(),
    }
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

pub(super) fn parse_cms_xml(body: &str) -> Result<Value, SourceSessionError> {
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
                    let decoded = event
                        .decode()
                        .map_err(|error| SourceSessionError::Request(error.to_string()))?;
                    let text = quick_xml::escape::unescape(&decoded)
                        .map_err(|error| SourceSessionError::Request(error.to_string()))?;
                    append_xml_text(value, &text)?;
                }
            }
            Ok(quick_xml::events::Event::CData(event)) => {
                if let Some((_, value)) = stack.last_mut() {
                    let text = event
                        .decode()
                        .map_err(|error| SourceSessionError::Request(error.to_string()))?;
                    append_xml_text(value, &text)?;
                }
            }
            Ok(quick_xml::events::Event::Empty(event)) => {
                let name = String::from_utf8_lossy(event.name().as_ref()).to_ascii_lowercase();
                complete_xml_node(
                    name,
                    Value::Object(Default::default()),
                    &mut stack,
                    &mut root,
                )?;
            }
            Ok(quick_xml::events::Event::End(event)) => {
                let (name, value) = stack.pop().ok_or_else(|| {
                    SourceSessionError::Request("CMS XML response is malformed".to_string())
                })?;
                let closing_name =
                    String::from_utf8_lossy(event.name().as_ref()).to_ascii_lowercase();
                if name != closing_name {
                    return Err(SourceSessionError::Request(
                        "CMS XML response is malformed".to_string(),
                    ));
                }
                complete_xml_node(name, value, &mut stack, &mut root)?;
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

fn append_xml_text(value: &mut Value, text: &str) -> Result<(), SourceSessionError> {
    if text.is_empty() {
        return Ok(());
    }
    match value {
        Value::String(existing) => existing.push_str(text),
        Value::Object(object) if object.is_empty() => *value = Value::String(text.to_string()),
        Value::Object(object) => {
            let text_value = object
                .entry("#text".to_string())
                .or_insert_with(|| Value::String(String::new()));
            let existing = text_value.as_str().ok_or_else(|| {
                SourceSessionError::Request("CMS XML response is malformed".to_string())
            })?;
            *text_value = Value::String(format!("{existing}{text}"));
        }
        _ => {
            return Err(SourceSessionError::Request(
                "CMS XML response is malformed".to_string(),
            ))
        }
    }
    Ok(())
}

fn complete_xml_node(
    name: String,
    value: Value,
    stack: &mut [(String, Value)],
    root: &mut Option<Value>,
) -> Result<(), SourceSessionError> {
    if let Some((_, parent)) = stack.last_mut() {
        if let Value::String(text) = parent {
            *parent = json!({ "#text": text.clone() });
        }
        let object = parent.as_object_mut().ok_or_else(|| {
            SourceSessionError::Request("CMS XML response is malformed".to_string())
        })?;
        insert_xml_child(object, &name, value);
    } else if root.is_none() {
        *root = Some(json!({ name: value }));
    } else {
        return Err(SourceSessionError::Request(
            "CMS XML response is malformed".to_string(),
        ));
    }
    Ok(())
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
    use super::super::test_support::bind_loopback_tcp;
    use super::{
        parse_cms_xml, SourceSessionError, SourceSessionPayload, SourceSessionState,
        MAX_RESPONSE_BYTES,
    };
    use serde_json::json;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::oneshot;

    #[test]
    fn parses_cms_xml_cdata_empty_and_mixed_content_without_panicking() {
        let value = parse_cms_xml(
            "<rss><list><video><name><![CDATA[示例影片]]></name><note/><content>前缀<em>重点</em>后缀</content></video></list></rss>",
        )
        .expect("CMS XML parses");

        assert_eq!(value["rss"]["list"]["video"]["name"], "示例影片");
        assert_eq!(value["rss"]["list"]["video"]["note"], json!({}));
        assert_eq!(
            value["rss"]["list"]["video"]["content"],
            json!({ "#text": "前缀后缀", "em": "重点" })
        );
    }

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

    #[tokio::test]
    async fn maps_native_request_cancellation_to_source_session_cancelled() {
        let listener = bind_loopback_tcp()
            .await
            .expect("bind cancellation fixture");
        let address = listener.local_addr().expect("cancellation fixture address");
        let (started_tx, started_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener
                .accept()
                .await
                .expect("accept cancellation request");
            let mut request = [0_u8; 2048];
            let _ = socket
                .read(&mut request)
                .await
                .expect("read cancellation request");
            let _ = started_tx.send(());
            tokio::time::sleep(Duration::from_millis(500)).await;
            let _ = socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await;
        });

        let state = Arc::new(SourceSessionState::default());
        let open = SourceSessionPayload {
            action: "open".to_string(),
            session_id: "cancel-native".to_string(),
            source_id: None,
            site_key: Some("jianpian".to_string()),
            api: Some("csp_Jianpian".to_string()),
            site_type: Some(3),
            ext: Some(format!("http://{address}")),
            method: None,
            params: None,
            timeout_ms: Some(5_000),
            headers: None,
        };
        state.open(&open).expect("native source opens");
        let call_payload = SourceSessionPayload {
            action: "call".to_string(),
            method: Some("search".to_string()),
            params: Some(json!({ "key": "示例", "page": 1 })),
            ..open
        };
        let call_state = Arc::clone(&state);
        let call = tokio::spawn(async move { call_state.call(&call_payload).await });
        started_rx.await.expect("native request starts");
        state.cancel("cancel-native").expect("cancel succeeds");
        let result = tokio::time::timeout(Duration::from_millis(250), call)
            .await
            .expect("cancellation returns promptly")
            .expect("cancellation task completes");
        assert!(matches!(result, Err(SourceSessionError::Cancelled)));
        server.await.expect("cancellation fixture completes");
    }

    #[test]
    fn exposes_native_douban_and_jianpian_capabilities_without_claiming_android() {
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
            ext: Some("https://api.ztcgi.com".to_string()),
            ..douban
        };
        let snapshot = state.open(&jianpian).expect("Jianpian boundary opens");
        assert!(snapshot.availability_reason.is_none());
        assert!(snapshot.capabilities.search);
        assert!(snapshot.capabilities.playback);
    }

    #[tokio::test]
    async fn routes_misou_to_its_read_only_http_contract() {
        let state = SourceSessionState::default();
        let open = SourceSessionPayload {
            action: "open".to_string(),
            session_id: "misou-read-only".to_string(),
            source_id: None,
            site_key: Some("米搜".to_string()),
            api: Some("csp_MiSou".to_string()),
            site_type: Some(3),
            ext: Some("http://127.0.0.1:9978/file/fatcat/kk.txt".to_string()),
            method: None,
            params: None,
            timeout_ms: Some(1_000),
            headers: None,
        };
        let snapshot = state.open(&open).expect("MiSou source opens");
        assert_eq!(snapshot.capabilities.engine, "http-misou-search");
        assert!(snapshot.capabilities.home);
        assert!(snapshot.capabilities.category);
        assert!(snapshot.capabilities.search);
        assert!(!snapshot.capabilities.detail);
        assert!(!snapshot.capabilities.playback);

        let error = state
            .call(&SourceSessionPayload {
                action: "call".to_string(),
                method: Some("detail".to_string()),
                params: Some(json!({"ids":["https://pan.quark.cn/s/example"]})),
                ..open
            })
            .await
            .expect_err("MiSou provider detail stays closed");
        assert!(matches!(
            error,
            SourceSessionError::Unsupported(message)
                if message == "MISOU_PROVIDER_DETAIL_UNSUPPORTED"
        ));
    }

    #[test]
    fn reports_the_local_config_source_without_treating_it_as_http() {
        let state = SourceSessionState::default();
        let error = state
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "config-local".to_string(),
                source_id: None,
                site_key: Some("config".to_string()),
                api: Some("csp_Config".to_string()),
                site_type: Some(3),
                ext: None,
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect_err("Config is a local action source, not an HTTP source");
        assert!(matches!(
            error,
            SourceSessionError::Unsupported(message)
                if message == "CONFIG_SOURCE_LOCAL_ONLY"
        ));
    }

    #[test]
    fn opens_a_csp_source_only_when_a_declarative_http_contract_is_present() {
        let state = SourceSessionState::default();
        let snapshot = state
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "converted".to_string(),
                source_id: Some("converted".to_string()),
                site_key: Some("converted".to_string()),
                api: Some("csp_Example".to_string()),
                site_type: Some(3),
                ext: Some(
                    r#"{
                      "qxAdapterVersion": 1,
                      "baseUrl": "https://example.test/api",
                      "operations": {
                        "home": {"path": "/home"},
                        "search": {"path": "/search"},
                        "detail": {"path": "/detail"},
                        "player": {"path": "/player"}
                      }
                    }"#
                    .to_string(),
                ),
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect("adapter source opens");
        assert_eq!(snapshot.capabilities.engine, "http-adapter");
        assert!(snapshot.capabilities.home);
        assert!(snapshot.capabilities.search);
        assert!(snapshot.capabilities.playback);
    }

    #[test]
    fn opens_the_explicit_first_aid_html_contract_without_dex() {
        let snapshot = SourceSessionState::default()
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "first-aid".to_string(),
                source_id: None,
                site_key: Some("first-aid".to_string()),
                api: Some("csp_FirstAid".to_string()),
                site_type: Some(3),
                ext: None,
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect("FirstAid source opens");
        assert_eq!(snapshot.capabilities.engine, "http-html");
        assert!(snapshot.capabilities.category);
        assert!(!snapshot.capabilities.search);
        assert!(snapshot.capabilities.playback);
    }

    #[test]
    fn opens_the_explicit_bilibili_http_contract_without_android_runtime() {
        let snapshot = SourceSessionState::default()
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "bili".to_string(),
                source_id: None,
                site_key: Some("bili".to_string()),
                api: Some("csp_Bili".to_string()),
                site_type: Some(3),
                ext: Some(r#"{"cookie":""}"#.to_string()),
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect("Bilibili source opens");
        assert_eq!(snapshot.capabilities.engine, "http-json");
        assert!(snapshot.capabilities.search);
        assert!(snapshot.capabilities.detail);
        assert!(snapshot.capabilities.playback);
    }

    #[test]
    fn opens_legacy_http_contracts_without_android_runtime() {
        let snapshot = SourceSessionState::default()
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "kanqiu".to_string(),
                source_id: None,
                site_key: Some("kanqiu".to_string()),
                api: Some("csp_Kanqiu".to_string()),
                site_type: None,
                ext: None,
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect("Kanqiu source opens");
        assert_eq!(snapshot.capabilities.engine, "http-html-json");
        assert!(snapshot.capabilities.category);
        assert!(!snapshot.capabilities.search);
        assert!(snapshot.capabilities.playback);

        let snapshot = SourceSessionState::default()
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "kugou".to_string(),
                source_id: None,
                site_key: Some("kugou".to_string()),
                api: Some("csp_Kugou".to_string()),
                site_type: None,
                ext: None,
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect("Kugou source opens");
        assert_eq!(snapshot.capabilities.engine, "http-html");
        assert!(snapshot.capabilities.category);
        assert!(!snapshot.capabilities.playback);

        let snapshot = SourceSessionState::default()
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "apprj".to_string(),
                source_id: None,
                site_key: Some("apprj".to_string()),
                api: Some("csp_AppRJ".to_string()),
                site_type: Some(3),
                ext: Some("http://v.rbotv.cn".to_string()),
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect("AppRJ source opens");
        assert_eq!(snapshot.capabilities.engine, "http-json-multipart");
        assert!(snapshot.capabilities.playback);

        let snapshot = SourceSessionState::default()
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "jpys".to_string(),
                source_id: None,
                site_key: Some("jpys".to_string()),
                api: Some("csp_Jpys".to_string()),
                site_type: Some(3),
                ext: None,
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect("Jpys source opens");
        assert_eq!(snapshot.capabilities.engine, "http-json-signed");
        assert!(snapshot.capabilities.search);
        assert!(snapshot.capabilities.detail);
        assert!(snapshot.capabilities.playback);

        let snapshot = SourceSessionState::default()
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "sp360".to_string(),
                source_id: None,
                site_key: Some("sp360".to_string()),
                api: Some("csp_SP360".to_string()),
                site_type: None,
                ext: None,
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect("SP360 source opens");
        assert_eq!(snapshot.capabilities.engine, "http-json-jsonp");
        assert!(snapshot.capabilities.home);
        assert!(snapshot.capabilities.category);
        assert!(snapshot.capabilities.search);
        assert!(snapshot.capabilities.detail);
        assert!(snapshot.capabilities.playback);

        let snapshot = SourceSessionState::default()
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "gz360".to_string(),
                source_id: None,
                site_key: Some("gz360".to_string()),
                api: Some("csp_Gz360".to_string()),
                site_type: None,
                ext: None,
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect("Gz360 source opens");
        assert_eq!(snapshot.capabilities.engine, "http-json-aes");
        assert!(snapshot.capabilities.home);
        assert!(snapshot.capabilities.category);
        assert!(snapshot.capabilities.search);
        assert!(snapshot.capabilities.detail);
        assert!(snapshot.capabilities.playback);

        let snapshot = SourceSessionState::default()
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "guazi-ty".to_string(),
                source_id: None,
                site_key: Some("guazi-ty".to_string()),
                api: Some("csp_GuaziTY".to_string()),
                site_type: None,
                ext: None,
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect("GuaziTY source opens");
        assert_eq!(snapshot.capabilities.engine, "http-json-aes");
        assert!(snapshot.capabilities.home);
        assert!(snapshot.capabilities.category);
        assert!(!snapshot.capabilities.search);
        assert!(snapshot.capabilities.detail);
        assert!(snapshot.capabilities.playback);

        let snapshot = SourceSessionState::default()
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "pansearch".to_string(),
                source_id: None,
                site_key: Some("pansearch".to_string()),
                api: Some("csp_PanSearch".to_string()),
                site_type: Some(3),
                ext: None,
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect("PanSearch source opens");
        assert_eq!(snapshot.capabilities.engine, "http-json-html");
        assert!(snapshot.capabilities.search);
        assert!(!snapshot.capabilities.playback);

        let snapshot = SourceSessionState::default()
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "tuxiaobei".to_string(),
                source_id: None,
                site_key: Some("儿童".to_string()),
                api: Some("https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/drpy2.min.js".to_string()),
                site_type: Some(3),
                ext: Some("https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/%E5%85%94%E5%B0%8F%E8%B4%9D.js".to_string()),
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect("TuXiaoBei source opens");
        assert_eq!(snapshot.capabilities.engine, "http-json-jsonp-html");
        assert!(snapshot.capabilities.home);
        assert!(snapshot.capabilities.category);
        assert!(snapshot.capabilities.search);
        assert!(snapshot.capabilities.detail);
        assert!(snapshot.capabilities.playback);
    }

    #[tokio::test]
    async fn routes_kanqiu_direct_playback_without_fetching_a_parser_page() {
        let state = SourceSessionState::default();
        let open = SourceSessionPayload {
            action: "open".to_string(),
            session_id: "kanqiu-player".to_string(),
            source_id: None,
            site_key: Some("kanqiu".to_string()),
            api: Some("csp_Kanqiu".to_string()),
            site_type: Some(3),
            ext: None,
            method: None,
            params: None,
            timeout_ms: Some(1_000),
            headers: None,
        };
        state.open(&open).expect("Kanqiu source opens");
        let result = state
            .call(&SourceSessionPayload {
                action: "call".to_string(),
                method: Some("player".to_string()),
                params: Some(json!({"id":"主线$https://media.test/live***1.m3u8"})),
                ..open
            })
            .await
            .expect("Kanqiu direct player succeeds");
        let value = result.result.expect("Kanqiu player result");
        assert_eq!(value["parse"], 0);
        assert_eq!(value["url"], "https://media.test/live#1.m3u8");
    }

    #[tokio::test]
    async fn routes_tuxiaobei_direct_media_through_the_static_contract() {
        let state = SourceSessionState::default();
        let open = SourceSessionPayload {
            action: "open".to_string(),
            session_id: "tuxiaobei-player".to_string(),
            source_id: None,
            site_key: Some("儿童".to_string()),
            api: Some("https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/drpy2.min.js".to_string()),
            site_type: Some(3),
            ext: Some("https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/%E5%85%94%E5%B0%8F%E8%B4%9D.js".to_string()),
            method: None,
            params: None,
            timeout_ms: Some(1_000),
            headers: None,
        };
        state.open(&open).expect("TuXiaoBei source opens");
        let result = state
            .call(&SourceSessionPayload {
                action: "call".to_string(),
                method: Some("player".to_string()),
                params: Some(json!({"id": "https://resource-cdn.tuxiaobei.com/video/test.mp4"})),
                ..open
            })
            .await
            .expect("TuXiaoBei direct player succeeds");
        let value = result.result.expect("TuXiaoBei player result");
        assert_eq!(value["parse"], 0);
        assert_eq!(value["jx"], 0);
        assert_eq!(
            value["url"],
            "https://resource-cdn.tuxiaobei.com/video/test.mp4"
        );
        assert_eq!(value["header"]["User-Agent"], "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
    }

    #[tokio::test]
    async fn opens_endpointless_push_source_and_resolves_its_direct_url() {
        let state = SourceSessionState::default();
        let open = SourceSessionPayload {
            action: "open".to_string(),
            session_id: "push-source".to_string(),
            source_id: None,
            site_key: Some("push_agent".to_string()),
            api: Some("csp_Push".to_string()),
            site_type: Some(3),
            ext: Some(".json/txt/ken.txt".to_string()),
            method: None,
            params: None,
            timeout_ms: None,
            headers: None,
        };
        let snapshot = state
            .open(&open)
            .expect("Push source opens without endpoint");
        assert_eq!(snapshot.capabilities.engine, "http-push");
        assert!(!snapshot.capabilities.home);
        assert!(snapshot.capabilities.detail);
        assert!(snapshot.capabilities.playback);

        let detail = state
            .call(&SourceSessionPayload {
                action: "call".to_string(),
                method: Some("detail".to_string()),
                params: Some(json!({"ids":["https://media.example.test/movie.m3u8"]})),
                ..open.clone()
            })
            .await
            .expect("Push detail succeeds");
        let episode = detail.result.expect("Push detail result")["list"][0]["vod_play_url"]
            .as_str()
            .expect("Push episode")
            .to_string();
        let player = state
            .call(&SourceSessionPayload {
                action: "call".to_string(),
                method: Some("player".to_string()),
                params: Some(json!({"flag":"直连", "id":episode})),
                ..open
            })
            .await
            .expect("Push player succeeds");
        assert_eq!(player.result.expect("Push player result")["parse"], 0);
    }

    #[test]
    fn rejects_an_unknown_csp_source_without_a_contract() {
        let state = SourceSessionState::default();
        let error = state
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "unknown-csp".to_string(),
                api: Some("csp_Unknown".to_string()),
                site_type: Some(3),
                ext: Some("https://example.test".to_string()),
                ..SourceSessionPayload {
                    action: "open".to_string(),
                    session_id: "unknown-csp".to_string(),
                    source_id: None,
                    site_key: None,
                    api: Some("csp_Unknown".to_string()),
                    site_type: Some(3),
                    ext: None,
                    method: None,
                    params: None,
                    timeout_ms: None,
                    headers: None,
                }
            })
            .expect_err("unknown source must not be guessed");
        assert!(format!("{error:?}").contains("ADAPTER_CONTRACT_REQUIRED"));
    }

    #[tokio::test]
    async fn calls_a_converted_source_over_http_and_maps_its_json_response() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = bind_loopback_tcp().await.expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let response_body = r#"{"data":{"items":[{"id":"v1","title":"示例"}]}}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response_body.len(),
            response_body
        );
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept test request");
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).await.expect("read test request");
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write test response");
        });

        let state = SourceSessionState::default();
        let ext = format!(
            r#"{{
              "qxAdapterVersion": 1,
              "baseUrl": "http://{address}",
              "operations": {{
                "search": {{
                  "path": "/search",
                  "query": {{"wd": "{{key}}"}},
                  "response": {{
                    "root": "/data",
                    "list": {{
                      "path": "/items",
                      "item": {{"vod_id": "/id", "vod_name": "/title"}}
                    }}
                  }}
                }}
              }}
            }}"#
        );
        let open = SourceSessionPayload {
            action: "open".to_string(),
            session_id: "converted-http".to_string(),
            source_id: None,
            site_key: Some("converted".to_string()),
            api: Some("csp_Example".to_string()),
            site_type: Some(3),
            ext: Some(ext),
            method: None,
            params: None,
            timeout_ms: Some(5_000),
            headers: None,
        };
        state.open(&open).expect("adapter source opens");
        let call = SourceSessionPayload {
            action: "call".to_string(),
            method: Some("search".to_string()),
            params: Some(json!({"key": "示例"})),
            ..open
        };
        let result = state.call(&call).await.expect("adapter call succeeds");
        assert_eq!(
            result.result.expect("mapped result")["list"][0]["vod_id"],
            "v1"
        );
        server.await.expect("test server completes");
    }

    #[tokio::test]
    async fn rejects_an_oversized_response_from_content_length_before_buffering_it() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = bind_loopback_tcp().await.expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept test request");
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).await.expect("read test request");
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{{}}",
                        MAX_RESPONSE_BYTES + 1
                    )
                    .as_bytes(),
                )
                .await
                .expect("write oversized response headers");
        });

        let state = SourceSessionState::default();
        let open = SourceSessionPayload {
            action: "open".to_string(),
            session_id: "oversized-cms".to_string(),
            source_id: None,
            site_key: Some("oversized-cms".to_string()),
            api: Some(format!("http://{address}")),
            site_type: Some(1),
            ext: None,
            method: None,
            params: None,
            timeout_ms: Some(5_000),
            headers: None,
        };
        state.open(&open).expect("CMS source opens");
        let error = state
            .call(&SourceSessionPayload {
                action: "call".to_string(),
                method: Some("home".to_string()),
                ..open
            })
            .await
            .expect_err("oversized response is rejected before buffering");

        assert!(format!("{error:?}").contains("response is too large"));
        server.await.expect("test server completes");
    }

    #[tokio::test]
    async fn calls_an_allowlisted_source_through_the_bounded_cms_fallback() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = bind_loopback_tcp().await.expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let response_body = r#"{"code":1,"page":1,"list":[{"vod_id":"v1","vod_name":"示例"}]}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response_body.len(),
            response_body
        );
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept test request");
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).await.expect("read test request");
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write test response");
        });

        let state = SourceSessionState::default();
        let open = SourceSessionPayload {
            action: "open".to_string(),
            session_id: "auto-http".to_string(),
            source_id: None,
            site_key: Some("app-get".to_string()),
            api: Some("csp_AppGet".to_string()),
            site_type: Some(3),
            ext: Some(format!("http://{address}|opaque-token")),
            method: None,
            params: None,
            timeout_ms: Some(5_000),
            headers: None,
        };
        let snapshot = state.open(&open).expect("auto HTTP source opens");
        assert_eq!(snapshot.capabilities.engine, "http-auto");
        assert!(!snapshot.capabilities.playback);

        let call = SourceSessionPayload {
            action: "call".to_string(),
            method: Some("search".to_string()),
            params: Some(json!({"key": "示例", "page": 1})),
            ..open
        };
        let result = state.call(&call).await.expect("auto HTTP call succeeds");
        assert_eq!(
            result.result.expect("mapped result")["list"][0]["vod_id"],
            "v1"
        );
        server.await.expect("test server completes");
    }

    #[tokio::test]
    async fn call_deadline_can_shorten_a_session_and_cancellation_interrupts_waiting() {
        use std::time::{Duration, Instant};
        let listener = bind_loopback_tcp().await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut sockets = Vec::new();
            loop { sockets.push(listener.accept().await.unwrap().0); }
        });
        let state = SourceSessionState::default();
        let open: SourceSessionPayload = serde_json::from_value(json!({
            "action":"open", "sessionId":"short-call", "sourceId":"fixture", "siteKey":"fixture", "api":format!("http://{address}/api"), "siteType":1, "timeoutMs":5_000
        })).unwrap();
        state.open(&open).unwrap();
        let call = SourceSessionPayload { action: "call".into(), method: Some("home".into()), timeout_ms: Some(80), ..open.clone() };
        let started = Instant::now();
        let error = state.call(&call).await.unwrap_err();
        assert!(format!("{error:?}").contains("TIMEOUT"), "{error:?}");
        assert!(started.elapsed() < Duration::from_millis(800));
        let call = SourceSessionPayload { timeout_ms: Some(5_000), ..call };
        let cancel = async { tokio::time::sleep(Duration::from_millis(30)).await; state.cancel("short-call").unwrap(); };
        let started = Instant::now();
        let (result, _) = tokio::join!(state.call(&call), cancel);
        assert!(matches!(result, Err(super::SourceSessionError::Cancelled)));
        assert!(started.elapsed() < Duration::from_millis(800));
        state.close("short-call").unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn bounds_all_auto_http_fallback_attempts_by_the_session_timeout() {
        use std::time::{Duration, Instant};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = bind_loopback_tcp().await.expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let server = tokio::spawn(async move {
            for _ in 0..4 {
                let (mut socket, _) = listener.accept().await.expect("accept fallback request");
                let mut request = [0_u8; 2048];
                let _ = socket
                    .read(&mut request)
                    .await
                    .expect("read fallback request");
                tokio::time::sleep(Duration::from_millis(400)).await;
                socket
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await
                    .expect("write fallback response");
            }
        });

        let state = SourceSessionState::default();
        let open = SourceSessionPayload {
            action: "open".to_string(),
            session_id: "auto-http-deadline".to_string(),
            source_id: None,
            site_key: Some("slow-auto-http".to_string()),
            api: Some("csp_AppGet".to_string()),
            site_type: Some(3),
            ext: Some(format!("http://{address}|opaque-token")),
            method: None,
            params: None,
            timeout_ms: Some(1_000),
            headers: None,
        };
        state.open(&open).expect("auto HTTP source opens");

        let started = Instant::now();
        let error = state
            .call(&SourceSessionPayload {
                action: "call".to_string(),
                method: Some("search".to_string()),
                params: Some(json!({"key": "slow", "page": 1})),
                ..open
            })
            .await
            .expect_err("the whole fallback chain must respect one deadline");
        let elapsed = started.elapsed();

        assert!(
            format!("{error:?}").contains("SOURCE_SESSION_TIMEOUT"),
            "unexpected error: {error:?}"
        );
        assert!(
            elapsed < Duration::from_millis(1_400),
            "fallback chain exceeded the session deadline: {elapsed:?}"
        );
        server.abort();
    }

    #[tokio::test]
    async fn routes_a_fixed_key_appget_session_through_the_encrypted_adapter() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = bind_loopback_tcp().await.expect("bind AppGet test server");
        let address = listener.local_addr().expect("AppGet test server address");
        let discovery_listener = bind_loopback_tcp()
            .await
            .expect("bind AppGet discovery server");
        let discovery_address = discovery_listener
            .local_addr()
            .expect("AppGet discovery address");
        let discovery_server = tokio::spawn(async move {
            let (mut socket, _) = discovery_listener
                .accept()
                .await
                .expect("accept AppGet discovery request");
            let mut request = [0_u8; 2048];
            let read = socket
                .read(&mut request)
                .await
                .expect("read AppGet discovery request");
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.starts_with("GET /appget.txt "));
            let body = format!("http://{address}\n");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write AppGet discovery response");
            tokio::time::timeout(
                std::time::Duration::from_millis(250),
                discovery_listener.accept(),
            )
            .await
            .is_ok()
        });
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.expect("accept AppGet request");
                let mut request = [0_u8; 4096];
                let read = socket
                    .read(&mut request)
                    .await
                    .expect("read AppGet request");
                let request = String::from_utf8_lossy(&request[..read]);
                assert!(request.starts_with("POST /api.php/getappapi.index/searchList "));
                assert!(request
                    .to_ascii_lowercase()
                    .contains("app-user-device-id: 2e714ed1a871e3291b797524842448850"));
                let response_body = r#"{"data":"ErZvo/yIG2X7d+MrYnYUN2lvAipEehEdQqTkjE20Z0A/IlWciw/ABnsOL+dsBqwhWtwds2z1N9m39KOvVP2FMw=="}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                );
                socket
                    .write_all(response.as_bytes())
                    .await
                    .expect("write AppGet response");
            }
        });

        let state = SourceSessionState::default();
        let open = SourceSessionPayload {
            action: "open".to_string(),
            session_id: "appget-encrypted".to_string(),
            source_id: None,
            site_key: Some("肥猫".to_string()),
            api: Some("csp_AppGet".to_string()),
            site_type: Some(3),
            ext: Some(format!(
                "http://{discovery_address}/appget.txt|0123456789abcdef|119|user"
            )),
            method: None,
            params: None,
            timeout_ms: Some(5_000),
            headers: None,
        };
        let snapshot = state.open(&open).expect("AppGet source opens");
        assert_eq!(snapshot.capabilities.engine, "http-appget");
        assert!(snapshot.capabilities.playback);

        let first_payload = SourceSessionPayload {
            action: "call".to_string(),
            method: Some("search".to_string()),
            params: Some(json!({"key":"示例","page":1})),
            ..open.clone()
        };
        let second_payload = SourceSessionPayload {
            action: "call".to_string(),
            method: Some("search".to_string()),
            params: Some(json!({"key":"示例","page":2})),
            ..open.clone()
        };
        let first_call = state.call(&first_payload);
        let second_call = state.call(&second_payload);
        let (first, second) = tokio::join!(first_call, second_call);
        for result in [first, second] {
            let result = result.expect("AppGet session routes through encrypted adapter");
            assert_eq!(
                result.result.expect("AppGet result")["list"][0]["vod_id"],
                "v1"
            );
        }
        assert!(
            !discovery_server
                .await
                .expect("AppGet discovery server completes"),
            "SourceSession clones must share one discovery result"
        );
        server.await.expect("AppGet test server completes");
    }

    #[test]
    fn opens_the_fixed_python_appget_wrapper_without_enabling_python_runtime() {
        let snapshot = SourceSessionState::default()
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "python-wrapper".to_string(),
                source_id: None,
                site_key: Some("肥猫".to_string()),
                api: Some("./Py/app/getapp.py".to_string()),
                site_type: Some(3),
                ext: Some(
                    r#"{"host":"https://example.test:8006","api":"/api.php/getappapi","datakey":"0123456789abcdef","dataiv":"fedcba9876543210"}"#
                        .to_string(),
                ),
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect("fixed Python wrapper opens through Rust HTTP");
        assert_eq!(snapshot.capabilities.engine, "http-appget");
        assert!(snapshot.capabilities.home);
        assert!(snapshot.capabilities.search);
        assert!(snapshot.capabilities.detail);
        assert!(snapshot.capabilities.playback);
        assert_eq!(snapshot.api, "./Py/app/getapp.py");
    }

    #[test]
    fn rejects_a_malformed_python_wrapper_instead_of_falling_back_to_python() {
        for (ext, expected) in [
            (
                r#"{"host":"https://example.test","api":"/api.php/qijiappapi","datakey":"0123456789abcdef"}"#,
                "APPGET_WRAPPER_API_PATH_INVALID",
            ),
            (
                r#"{"host":"https://example.test","api":"/api.php/getappapi","datakey":"short"}"#,
                "APPGET_KEY_INVALID",
            ),
        ] {
            let error = SourceSessionState::default()
                .open(&SourceSessionPayload {
                    action: "open".to_string(),
                    session_id: "python-wrapper-invalid".to_string(),
                    source_id: None,
                    site_key: Some("肥猫".to_string()),
                    api: Some("Py/app/getapp.py".to_string()),
                    site_type: Some(3),
                    ext: Some(ext.to_string()),
                    method: None,
                    params: None,
                    timeout_ms: None,
                    headers: None,
                })
                .expect_err("malformed wrapper must fail closed");
            assert!(matches!(error, SourceSessionError::Invalid(message) if message == expected));
        }
    }

    #[tokio::test]
    async fn caches_appget_discovery_failure_across_source_session_calls() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = bind_loopback_tcp()
            .await
            .expect("bind AppGet failure discovery server");
        let address = listener
            .local_addr()
            .expect("AppGet failure discovery address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener
                .accept()
                .await
                .expect("accept AppGet failure discovery request");
            let mut request = [0_u8; 2048];
            let _ = socket
                .read(&mut request)
                .await
                .expect("read AppGet failure discovery request");
            socket
                .write_all(
                    b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("write AppGet failure discovery response");
            tokio::time::timeout(std::time::Duration::from_millis(250), listener.accept())
                .await
                .is_ok()
        });

        let state = SourceSessionState::default();
        let open = SourceSessionPayload {
            action: "open".to_string(),
            session_id: "appget-discovery-failure".to_string(),
            source_id: None,
            site_key: Some("肥猫".to_string()),
            api: Some("csp_AppGet".to_string()),
            site_type: Some(3),
            ext: Some(format!(
                "http://{address}/appget.txt|0123456789abcdef|119|user"
            )),
            method: None,
            params: None,
            timeout_ms: Some(5_000),
            headers: None,
        };
        state.open(&open).expect("AppGet failure source opens");

        let first = state
            .call(&SourceSessionPayload {
                action: "call".to_string(),
                method: Some("home".to_string()),
                ..open.clone()
            })
            .await
            .expect_err("first discovery failure must be returned");
        let second = state
            .call(&SourceSessionPayload {
                action: "call".to_string(),
                method: Some("search".to_string()),
                params: Some(json!({"key":"示例","page":1})),
                ..open
            })
            .await
            .expect_err("cached discovery failure must be returned");
        assert_eq!(format!("{first:?}"), format!("{second:?}"));
        assert!(format!("{first:?}").contains("APPGET_DISCOVERY_HTTP_STATUS:503"));
        assert!(
            !server
                .await
                .expect("AppGet failure discovery server completes"),
            "SourceSession clones must share one failed discovery result"
        );
    }

    #[tokio::test]
    async fn routes_appget_direct_media_without_resolving_discovery() {
        let listener = bind_loopback_tcp()
            .await
            .expect("bind unused AppGet discovery listener");
        let address = listener
            .local_addr()
            .expect("unused AppGet discovery address");
        let state = SourceSessionState::default();
        let open = SourceSessionPayload {
            action: "open".to_string(),
            session_id: "appget-direct-player".to_string(),
            source_id: None,
            site_key: Some("肥猫".to_string()),
            api: Some("csp_AppGet".to_string()),
            site_type: Some(3),
            ext: Some(format!(
                "http://{address}/appget.txt|0123456789abcdef|119|user"
            )),
            method: None,
            params: None,
            timeout_ms: Some(1_000),
            headers: None,
        };
        let snapshot = state.open(&open).expect("AppGet direct source opens");
        assert!(snapshot.capabilities.playback);

        let result = state
            .call(&SourceSessionPayload {
                action: "call".to_string(),
                method: Some("player".to_string()),
                params: Some(json!({"id":"https://media.example.invalid/direct.m3u8"})),
                ..open
            })
            .await
            .expect("AppGet direct media player succeeds");
        let value = result.result.expect("AppGet direct player result");
        assert_eq!(value["parse"], 0);
        assert_eq!(value["url"], "https://media.example.invalid/direct.m3u8");
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "direct AppGet media must not request discovery"
        );
    }

    #[tokio::test]
    async fn routes_appqi_direct_media_through_its_isolated_contract() {
        let state = SourceSessionState::default();
        let open = SourceSessionPayload {
            action: "open".to_string(),
            session_id: "appqi-direct-player".to_string(),
            source_id: None,
            site_key: Some("光盘".to_string()),
            api: Some("csp_AppQi".to_string()),
            site_type: Some(3),
            ext: Some("https://example.test|0123456789abcdef|fixture-agent".to_string()),
            method: None,
            params: None,
            timeout_ms: Some(1_000),
            headers: None,
        };
        let snapshot = state.open(&open).expect("AppQi direct source opens");
        assert_eq!(snapshot.capabilities.engine, "http-appqi");
        assert!(snapshot.capabilities.playback);

        let result = state
            .call(&SourceSessionPayload {
                action: "call".to_string(),
                method: Some("player".to_string()),
                params: Some(json!({"id":"https://media.example.invalid/qi.m3u8"})),
                ..open
            })
            .await
            .expect("AppQi direct media player succeeds");
        let value = result.result.expect("AppQi direct player result");
        assert_eq!(value["parse"], 0);
        assert_eq!(value["url"], "https://media.example.invalid/qi.m3u8");
    }

    #[test]
    fn opens_ygp_without_an_android_artifact_or_extension() {
        let state = SourceSessionState::default();
        let snapshot = state
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "endpointless".to_string(),
                api: Some("csp_YGP".to_string()),
                site_type: Some(3),
                ..SourceSessionPayload {
                    action: "open".to_string(),
                    session_id: "endpointless".to_string(),
                    source_id: None,
                    site_key: None,
                    api: Some("csp_YGP".to_string()),
                    site_type: Some(3),
                    ext: None,
                    method: None,
                    params: None,
                    timeout_ms: None,
                    headers: None,
                }
            })
            .expect("YGP fixed HTML source opens");
        assert_eq!(snapshot.capabilities.engine, "http-html");
        assert!(snapshot.capabilities.home);
        assert!(snapshot.capabilities.category);
        assert!(snapshot.capabilities.search);
        assert!(snapshot.capabilities.detail);
        assert!(snapshot.capabilities.playback);
    }

    #[test]
    fn rejects_an_explicit_invalid_appget_data_iv_instead_of_using_cms_fallback() {
        let state = SourceSessionState::default();
        let error = state
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "appget-invalid-iv".to_string(),
                source_id: None,
                site_key: Some("肥猫".to_string()),
                api: Some("csp_AppGet".to_string()),
                site_type: Some(3),
                ext: Some(
                    r#"{
                      "url":"https://example.test",
                      "dataKey":"0123456789abcdef",
                      "dataIv":"short"
                    }"#
                    .to_string(),
                ),
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect_err("invalid AppGet IV must reject the source");
        assert!(matches!(
            error,
            SourceSessionError::Invalid(message) if message == "APPGET_IV_INVALID"
        ));
    }

    #[test]
    fn rejects_an_explicit_invalid_appget_data_key_instead_of_using_cms_fallback() {
        let state = SourceSessionState::default();
        let error = state
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "appget-invalid-key".to_string(),
                source_id: None,
                site_key: Some("肥猫".to_string()),
                api: Some("csp_AppGet".to_string()),
                site_type: Some(3),
                ext: Some(
                    r#"{
                      "url":"https://example.test",
                      "dataKey":"short"
                    }"#
                    .to_string(),
                ),
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect_err("invalid AppGet key must reject the source");
        assert!(matches!(
            error,
            SourceSessionError::Invalid(message) if message == "APPGET_KEY_INVALID"
        ));

        let error = SourceSessionState::default()
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "appqi-invalid-key".to_string(),
                source_id: None,
                site_key: Some("光盘".to_string()),
                api: Some("csp_AppQi".to_string()),
                site_type: Some(3),
                ext: Some(
                    r#"{
                      "url":"https://example.test",
                      "dataKey":"short"
                    }"#
                    .to_string(),
                ),
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect_err("invalid AppQi key must reject the source");
        assert!(matches!(
            error,
            SourceSessionError::Invalid(message) if message == "APPQI_KEY_INVALID"
        ));

        let snapshot = SourceSessionState::default()
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "appget-opaque-token".to_string(),
                source_id: None,
                site_key: Some("legacy-appget".to_string()),
                api: Some("csp_AppGet".to_string()),
                site_type: Some(3),
                ext: Some(r#"{"url":"https://example.test","token":"opaque-token"}"#.to_string()),
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect("opaque AppGet token keeps the bounded CMS fallback");
        assert_eq!(snapshot.capabilities.engine, "http-auto");
    }
}
