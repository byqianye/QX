use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::AppHandle;

use super::component_manager;
use super::mpv_bridge;
use super::playback_proxy;
use super::quickjs_bridge;
use super::quickjs_session;
use super::source_session;
use super::subtitles;
use super::webview_sniffer;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStartPayload {
    pub session_id: String,
    pub source_id: Option<String>,
    pub source_api: String,
    pub site_type: Option<u8>,
    pub engine: Option<String>,
    pub line_name: String,
    pub episode_id: String,
    #[serde(default)]
    pub vip_flags: Vec<String>,
    pub fallback_subtitles: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStartResult {
    pub player_source: Value,
    pub backend: String,
    pub proxy: playback_proxy::PlaybackProxySnapshot,
}

#[derive(Debug)]
pub enum PlaybackStartError {
    Invalid(String),
    SourceSession(source_session::SourceSessionError),
    QuickJs(quickjs_session::QuickJsSessionError),
    Sniffer(webview_sniffer::WebviewSnifferError),
    Proxy(playback_proxy::PlaybackProxyError),
    Mpv(mpv_bridge::MpvError),
    Component(component_manager::ComponentManagerError),
    Storage(String),
}

pub async fn start(
    app: &AppHandle,
    source_state: &source_session::SourceSessionState,
    quickjs_state: &quickjs_session::QuickJsSessionState,
    quickjs_sidecar: &quickjs_bridge::QuickJsSidecarState,
    sniffer_state: &webview_sniffer::WebviewSnifferState,
    proxy_state: &playback_proxy::PlaybackProxyState,
    mpv_state: &mpv_bridge::MpvState,
    payload: &PlaybackStartPayload,
) -> Result<PlaybackStartResult, PlaybackStartError> {
    if payload.session_id.trim().is_empty() {
        return Err(PlaybackStartError::Invalid(
            "sessionId is required".to_string(),
        ));
    }
    if payload.line_name.trim().is_empty() || payload.episode_id.trim().is_empty() {
        return Err(PlaybackStartError::Invalid(
            "lineName and episodeId are required".to_string(),
        ));
    }

    let direct_cms = is_http_url(&payload.source_api) && is_http_url(&payload.episode_id);
    let mut raw = if direct_cms {
        json!({
            "parse": 0,
            "url": payload.episode_id,
            "header": {},
        })
    } else {
        let params = json!({
            "flag": payload.line_name,
            "id": payload.episode_id,
            "vipFlags": payload.vip_flags,
        });
        let result = if payload.engine.as_deref() == Some("quickjs") {
            quickjs_state
                .handle(
                    app,
                    quickjs_sidecar,
                    &quickjs_session::QuickJsSessionPayload {
                        action: "call".to_string(),
                        session_id: payload.session_id.clone(),
                        source_id: payload.source_id.clone(),
                        site_key: None,
                        api: Some(payload.source_api.clone()),
                        site_type: payload.site_type,
                        ext: None,
                        method: Some("player".to_string()),
                        params: Some(params),
                    },
                )
                .map_err(PlaybackStartError::QuickJs)?
                .result
                .unwrap_or(Value::Null)
        } else {
            source_state
                .call(&source_session::SourceSessionPayload {
                    action: "call".to_string(),
                    session_id: payload.session_id.clone(),
                    source_id: payload.source_id.clone(),
                    site_key: None,
                    api: Some(payload.source_api.clone()),
                    site_type: payload.site_type,
                    ext: None,
                    method: Some("player".to_string()),
                    params: Some(params),
                    timeout_ms: None,
                    headers: None,
                })
                .await
                .map_err(PlaybackStartError::SourceSession)?
                .result
                .unwrap_or(Value::Null)
        };
        result
    };
    if !raw.is_object() {
        return Err(PlaybackStartError::Invalid(
            "TAURI_PLAYBACK_PLAYER_RESULT_INVALID".to_string(),
        ));
    }
    subtitles::normalize_result(&mut raw);
    let parse = number_value(raw.get("parse"), 0);
    let mut url = string_value(
        raw.get("url")
            .or_else(|| raw.get("playUrl"))
            .or_else(|| raw.get("link")),
    );
    let mut headers = headers_value(raw.get("header").or_else(|| raw.get("headers")));
    if parse != 0 {
        let initial_url = if is_http_url(&url) {
            url.clone()
        } else if is_http_url(&payload.episode_id) {
            payload.episode_id.clone()
        } else {
            String::new()
        };
        if !is_http_url(&initial_url) {
            return Err(PlaybackStartError::Invalid(
                "TAURI_PLAYBACK_SNIFFER_URL_INVALID".to_string(),
            ));
        }
        let allowed_origins = raw
            .get("allowedOrigins")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let sniffed = sniffer_state
            .handle(
                app,
                &webview_sniffer::WebviewSnifferPayload {
                    action: "sniff".to_string(),
                    session_id: payload.session_id.clone(),
                    source_id: payload.source_id.clone(),
                    playback_session_id: Some(payload.session_id.clone()),
                    initial_url: Some(initial_url),
                    headers: headers.clone().into_iter().collect(),
                    allowed_origins,
                    max_redirects: None,
                    max_pages: None,
                    max_resources: None,
                    max_total_ms: None,
                    max_idle_ms: None,
                },
            )
            .await
            .map_err(PlaybackStartError::Sniffer)?;
        let media = sniffed.media.unwrap_or(Value::Null);
        url = string_value(media.get("url"));
        headers = headers_value(media.get("headers"));
        if !is_http_url(&url) {
            return Err(PlaybackStartError::Invalid(
                "TAURI_PLAYBACK_SNIFFER_MEDIA_INVALID".to_string(),
            ));
        }
    }
    if !is_http_url(&url) {
        return Err(PlaybackStartError::Invalid(
            "TAURI_PLAYBACK_URL_INVALID".to_string(),
        ));
    }

    let proxy = proxy_state
        .handle(&playback_proxy::PlaybackProxyPayload {
            action: "start".to_string(),
            session_id: payload.session_id.clone(),
            url: Some(url),
            headers: if headers.is_empty() {
                None
            } else {
                Some(headers.clone().into_iter().collect())
            },
        })
        .await
        .map_err(PlaybackStartError::Proxy)?;
    let proxy_url = proxy.proxy_url.clone().ok_or_else(|| {
        PlaybackStartError::Invalid("TAURI_PLAYBACK_PROXY_URL_MISSING".to_string())
    })?;
    let backend = if string_value(raw.get("backend")) == "mpv"
        || string_value(raw.get("format")).to_ascii_lowercase() == "flv"
    {
        "mpv".to_string()
    } else {
        "embedded".to_string()
    };
    if backend == "mpv" {
        if let Err(error) = install_component(app, "mpv") {
            let _ = proxy_state
                .handle(&playback_proxy::PlaybackProxyPayload {
                    action: "close".to_string(),
                    session_id: payload.session_id.clone(),
                    url: None,
                    headers: None,
                })
                .await;
            return Err(error);
        }
        if let Err(error) = mpv_state
            .handle(
                app,
                &mpv_bridge::MpvPayload {
                    action: "start".to_string(),
                    session_id: payload.session_id.clone(),
                    source: Some(proxy_url.clone()),
                    command: None,
                },
            )
            .await
        {
            let _ = proxy_state
                .handle(&playback_proxy::PlaybackProxyPayload {
                    action: "close".to_string(),
                    session_id: payload.session_id.clone(),
                    url: None,
                    headers: None,
                })
                .await;
            return Err(PlaybackStartError::Mpv(error));
        }
    }

    let mut player_source = Map::new();
    player_source.insert("parse".to_string(), json!(parse));
    player_source.insert("url".to_string(), json!(proxy_url));
    player_source.insert("headers".to_string(), json!({}));
    if backend == "mpv" {
        player_source.insert("backend".to_string(), json!("mpv"));
    }
    player_source.insert(
        "mediaType".to_string(),
        json!(match proxy.media_type.as_deref() {
            Some("hls") => "hls",
            Some("dash") => "dash",
            _ => "mp4",
        }),
    );
    if let Some(drm) = drm_value(raw.get("drm")) {
        player_source.insert("drm".to_string(), drm);
    }
    for key in ["playUrl", "format", "flag"] {
        if let Some(value) = raw.get(key).filter(|value| value.is_string()) {
            player_source.insert(key.to_string(), value.clone());
        }
    }
    let subtitle_value = raw
        .get("subtitles")
        .or_else(|| raw.get("subtitleTracks"))
        .or_else(|| raw.get("subtitle"))
        .or(payload.fallback_subtitles.as_ref());
    if let Some(value) = subtitle_value.filter(|value| value.is_array()) {
        if !value.as_array().is_some_and(Vec::is_empty) {
            player_source.insert("subtitles".to_string(), value.clone());
        }
    }
    Ok(PlaybackStartResult {
        player_source: Value::Object(player_source),
        backend,
        proxy,
    })
}

fn install_component(app: &AppHandle, component_id: &str) -> Result<(), PlaybackStartError> {
    let (data_directory, _) = super::app_data_paths(app)
        .map_err(|error| PlaybackStartError::Storage(error.reason_code))?;
    component_manager::handle(
        &data_directory.join("component-manager-v1"),
        &component_manager::ComponentManagerPayload {
            action: "install-default".to_string(),
            component_id: Some(component_id.to_string()),
            manifest_json: None,
            signature_base64: None,
            public_key_base64: None,
            artifact_base64: None,
            running: None,
        },
    )
    .map(|_| ())
    .map_err(PlaybackStartError::Component)
}

fn is_http_url(value: &str) -> bool {
    reqwest::Url::parse(value)
        .map(|url| matches!(url.scheme(), "http" | "https"))
        .unwrap_or(false)
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
            .or_else(|| value.as_f64().map(|number| number as i64))
            .unwrap_or(fallback),
        Some(Value::String(value)) => value.trim().parse().unwrap_or(fallback),
        _ => fallback,
    }
}

fn headers_value(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|values| {
            values
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn drm_value(value: Option<&Value>) -> Option<Value> {
    let object = value?.as_object()?;
    let clear_keys: BTreeMap<String, String> = headers_value(object.get("clearKeys"))
        .into_iter()
        .map(|(key, value)| (normalize_clear_key(key), normalize_clear_key(value)))
        .collect();
    let servers = headers_value(object.get("servers"));
    if clear_keys.is_empty() && servers.is_empty() {
        return None;
    }
    let mut result = Map::new();
    if !clear_keys.is_empty() {
        result.insert("clearKeys".to_string(), json!(clear_keys));
    }
    if !servers.is_empty() {
        result.insert("servers".to_string(), json!(servers));
    }
    Some(Value::Object(result))
}

fn normalize_clear_key(value: String) -> String {
    let compact = value.replace('-', "").to_ascii_lowercase();
    if compact.len() == 32
        && compact
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        compact
    } else {
        value
    }
}

pub fn error_fields(error: PlaybackStartError) -> (String, String, bool, String) {
    match error {
        PlaybackStartError::Invalid(message) => (
            "InvalidConfig".to_string(),
            "PLAYBACK_START_INVALID".to_string(),
            false,
            message,
        ),
        PlaybackStartError::Storage(message) => (
            "ComponentMissing".to_string(),
            "PLAYBACK_START_STORAGE_FAILED".to_string(),
            true,
            message,
        ),
        PlaybackStartError::SourceSession(error) => {
            let (code, message, retryable) = match error {
                source_session::SourceSessionError::Invalid(message) => {
                    ("SOURCE_SESSION_INVALID", message, false)
                }
                source_session::SourceSessionError::NotFound => (
                    "SOURCE_SESSION_NOT_FOUND",
                    "source session was not found".to_string(),
                    false,
                ),
                source_session::SourceSessionError::Cancelled => (
                    "SOURCE_SESSION_CANCELLED",
                    "source session was cancelled".to_string(),
                    false,
                ),
                source_session::SourceSessionError::Unsupported(message) => {
                    ("SOURCE_SESSION_UNSUPPORTED", message, false)
                }
                source_session::SourceSessionError::Request(message) => {
                    ("SOURCE_SESSION_REQUEST_FAILED", message, true)
                }
            };
            (
                "SourceUnavailable".to_string(),
                code.to_string(),
                retryable,
                message,
            )
        }
        PlaybackStartError::QuickJs(error) => {
            let (code, message, retryable): (String, String, bool) = match error {
                quickjs_session::QuickJsSessionError::Invalid(message) => {
                    ("QUICKJS_SESSION_INVALID".to_string(), message, false)
                }
                quickjs_session::QuickJsSessionError::Unsupported { code, message } => {
                    (code, message, false)
                }
                quickjs_session::QuickJsSessionError::NotFound => (
                    "QUICKJS_SESSION_NOT_FOUND".to_string(),
                    "QuickJS session was not found".to_string(),
                    false,
                ),
                quickjs_session::QuickJsSessionError::Component(error) => {
                    (error.reason_code().to_string(), error.message(), true)
                }
                quickjs_session::QuickJsSessionError::Sidecar(error) => {
                    quickjs_bridge::error_fields(error)
                }
                quickjs_session::QuickJsSessionError::Storage(message) => {
                    ("QUICKJS_SESSION_STORAGE_FAILED".to_string(), message, true)
                }
            };
            ("SourceUnavailable".to_string(), code, retryable, message)
        }
        PlaybackStartError::Sniffer(error) => (
            "PlaybackFailed".to_string(),
            error.reason_code().to_string(),
            error.retryable(),
            error.message(),
        ),
        PlaybackStartError::Proxy(error) => {
            let (code, message, retryable) = match error {
                playback_proxy::PlaybackProxyError::Invalid(message) => {
                    ("PLAYBACK_PROXY_INVALID", message, false)
                }
                playback_proxy::PlaybackProxyError::NotFound => (
                    "PLAYBACK_PROXY_NOT_FOUND",
                    "playback proxy session was not found".to_string(),
                    false,
                ),
                playback_proxy::PlaybackProxyError::Request(message) => {
                    ("PLAYBACK_PROXY_FAILED", message, true)
                }
            };
            (
                "PlaybackFailed".to_string(),
                code.to_string(),
                retryable,
                message,
            )
        }
        PlaybackStartError::Mpv(error) => {
            let (code, message, retryable) = match error {
                mpv_bridge::MpvError::Invalid(message) => ("MPV_INVALID", message, false),
                mpv_bridge::MpvError::Missing(message) => ("MPV_MISSING", message, true),
                mpv_bridge::MpvError::Request(message) => ("MPV_FAILED", message, true),
            };
            (
                "PlaybackFailed".to_string(),
                code.to_string(),
                retryable,
                message,
            )
        }
        PlaybackStartError::Component(error) => (
            match &error {
                component_manager::ComponentManagerError::Invalid(_) => "InvalidConfig",
                component_manager::ComponentManagerError::Untrusted(_) => "ComponentUntrusted",
                component_manager::ComponentManagerError::Storage(_) => "ComponentMissing",
            }
            .to_string(),
            error.reason_code().to_string(),
            matches!(error, component_manager::ComponentManagerError::Storage(_)),
            error.message(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::{drm_value, headers_value, is_http_url, normalize_clear_key};
    use serde_json::json;

    #[test]
    fn keeps_playback_validation_and_drm_normalization_small() {
        assert!(is_http_url("https://media.example.test/a.m3u8"));
        assert!(!is_http_url("file:///a.mp4"));
        assert_eq!(
            normalize_clear_key("00112233-4455-6677-8899-aabbccddeeff".to_string()),
            "00112233445566778899aabbccddeeff"
        );
        assert_eq!(
            headers_value(Some(&json!({"Referer": "https://example.test", "bad": 1}))).len(),
            1
        );
        assert!(drm_value(Some(&json!({"clearKeys": {"00112233445566778899aabbccddeeff": "ffeeddccbbaa99887766554433221100"}}))).is_some());
    }
}
