use std::collections::BTreeMap;
use std::fs;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder};

mod app_get;
mod auto_http;
mod bili;
mod business_data;
mod business_features;
mod cast_core;
mod component_manager;
mod config_catalog;
mod desktop_services;
mod first_aid;
mod jianpian;
mod legacy_http;
mod misou;
mod mpv_bridge;
mod native_sources;
mod playback_fallback;
mod playback_proxy;
mod playback_sources;
mod playback_start;
mod player_window;
mod push_core;
mod push_source;
mod quickjs_bridge;
mod quickjs_session;
mod runtime_capability;
mod source_converter;
mod source_semantics;
mod source_session;
#[cfg(test)]
mod source_benchmark;
mod subtitles;
#[cfg(test)]
mod test_support;
mod webview_sniffer;

pub const BACKEND_RPC_VERSION: &str = "qx.backend.v1";
pub const BACKEND_EVENT_VERSION: &str = "qx.event.v1";
pub const APP_NAME: &str = "QX影视";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendRequest {
    pub version: String,
    pub request_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendResponse<T> {
    pub version: String,
    pub request_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub ok: bool,
    pub payload: T,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendFailure {
    pub version: String,
    pub request_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub ok: bool,
    pub error: BackendError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendEvent<T> {
    pub version: String,
    pub event: String,
    pub request_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub payload: T,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BackendErrorCategory {
    InvalidConfig,
    UnsupportedRuntime,
    SourceUnavailable,
    ComponentMissing,
    ComponentUntrusted,
    UnsupportedDrm,
    PlaybackFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendError {
    pub category: BackendErrorCategory,
    pub reason_code: String,
    pub retryable: bool,
    pub diagnostic_id: String,
    pub safe_details: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub app_name: String,
    pub backend: String,
    pub rpc_version: String,
    pub data_directory: String,
    pub database_path: String,
}

fn app_data_paths(
    app: &AppHandle,
) -> Result<(std::path::PathBuf, std::path::PathBuf), BackendError> {
    let data_directory = match std::env::var_os("QX_TAURI_E2E_DATA_ROOT") {
        Some(value) if !value.is_empty() && std::env::var("QX_TAURI_E2E").as_deref() == Ok("1") => {
            std::path::PathBuf::from(value)
        }
        _ => app
            .path()
            .app_local_data_dir()
            .map_err(|error| BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: error.to_string(),
                retryable: false,
                diagnostic_id: "app-local-data-unavailable".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            })?,
    };
    fs::create_dir_all(&data_directory).map_err(|error| BackendError {
        category: BackendErrorCategory::InvalidConfig,
        reason_code: error.to_string(),
        retryable: true,
        diagnostic_id: "app-local-data-create-failed".to_string(),
        safe_details: std::collections::BTreeMap::new(),
    })?;
    let database_path = data_directory.join("qx-v1.sqlite3");
    rusqlite::Connection::open(&database_path).map_err(|error| BackendError {
        category: BackendErrorCategory::InvalidConfig,
        reason_code: error.to_string(),
        retryable: true,
        diagnostic_id: "app-database-open-failed".to_string(),
        safe_details: std::collections::BTreeMap::new(),
    })?;
    Ok((data_directory, database_path))
}

#[tauri::command]
fn backend_app_snapshot(
    app: AppHandle,
    request: BackendRequest,
) -> Result<BackendResponse<AppSnapshot>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }

    let (data_directory, database_path) =
        app_data_paths(&app).map_err(|error| failure(&request, error))?;

    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: AppSnapshot {
            app_name: APP_NAME.to_string(),
            backend: "tauri".to_string(),
            rpc_version: BACKEND_RPC_VERSION.to_string(),
            data_directory: data_directory.display().to_string(),
            database_path: database_path.display().to_string(),
        },
    })
}

#[tauri::command]
async fn backend_config_catalog(
    app: AppHandle,
    request: BackendRequest,
) -> Result<BackendResponse<serde_json::Value>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let (_, database_path) = app_data_paths(&app).map_err(|error| failure(&request, error))?;
    let action = request
        .payload
        .get("action")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("ingest");
    let snapshot = match action {
        "ingest" => {
            let payload: config_catalog::ConfigCatalogPayload =
                serde_json::from_value(request.payload.clone()).map_err(|error| {
                    failure(
                        &request,
                        BackendError {
                            category: BackendErrorCategory::InvalidConfig,
                            reason_code: "CONFIG_PAYLOAD_INVALID".to_string(),
                            retryable: false,
                            diagnostic_id: "config-catalog-payload-invalid".to_string(),
                            safe_details: [("error".to_string(), error.to_string())]
                                .into_iter()
                                .collect(),
                        },
                    )
                })?;
            if payload.fetch_remote
                || (payload.source_kind == "url" && payload.raw.trim().is_empty())
            {
                config_catalog::ingest_remote(&database_path, &payload)
                    .await
                    .and_then(|value| {
                        serde_json::to_value(value).map_err(|error| config_catalog::CatalogError {
                            code: "CONFIG_SNAPSHOT_SERIALIZE_FAILED".to_string(),
                            message: error.to_string(),
                            retryable: false,
                        })
                    })
            } else {
                config_catalog::ingest(&database_path, &payload).and_then(|value| {
                    serde_json::to_value(value).map_err(|error| config_catalog::CatalogError {
                        code: "CONFIG_SNAPSHOT_SERIALIZE_FAILED".to_string(),
                        message: error.to_string(),
                        retryable: false,
                    })
                })
            }
        }
        "history" => {
            let source = request
                .payload
                .get("source")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            config_catalog::history(&database_path, source).and_then(|value| {
                serde_json::to_value(value).map_err(|error| config_catalog::CatalogError {
                    code: "CONFIG_SNAPSHOT_SERIALIZE_FAILED".to_string(),
                    message: error.to_string(),
                    retryable: false,
                })
            })
        }
        "activate" => {
            let source = request
                .payload
                .get("source")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let version_hash = request
                .payload
                .get("versionHash")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            config_catalog::activate(&database_path, source, version_hash).and_then(|value| {
                serde_json::to_value(value).map_err(|error| config_catalog::CatalogError {
                    code: "CONFIG_SNAPSHOT_SERIALIZE_FAILED".to_string(),
                    message: error.to_string(),
                    retryable: false,
                })
            })
        }
        _ => Err(config_catalog::CatalogError {
            code: "CONFIG_ACTION_UNSUPPORTED".to_string(),
            message: "configuration catalog action is unsupported".to_string(),
            retryable: false,
        }),
    }
    .map_err(|error| {
        let config_catalog::CatalogError {
            code,
            message,
            retryable,
        } = error;
        failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: code,
                retryable,
                diagnostic_id: "config-catalog-error".to_string(),
                safe_details: [("message".to_string(), message)].into_iter().collect(),
            },
        )
    })?;
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: snapshot,
    })
}

#[tauri::command]
async fn backend_source_session(
    state: tauri::State<'_, source_session::SourceSessionState>,
    request: BackendRequest,
) -> Result<BackendResponse<source_session::SourceSessionResult>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: source_session::SourceSessionPayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "SOURCE_SESSION_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "source-session-payload-invalid".to_string(),
                    safe_details: [("error".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    let mut result = match payload.action.as_str() {
        "open" => source_session::SourceSessionResult {
            session: state
                .open(&payload)
                .map_err(|error| source_session_failure(&request, error))?,
            method: None,
            result: None,
            cancelled: false,
        },
        "call" => state
            .call(&payload)
            .await
            .map_err(|error| source_session_failure(&request, error))?,
        "cancel" => {
            state
                .cancel(&payload.session_id)
                .map_err(|error| source_session_failure(&request, error))?;
            source_session::SourceSessionResult {
                session: state
                    .snapshot(&payload.session_id)
                    .map_err(|error| source_session_failure(&request, error))?,
                method: None,
                result: None,
                cancelled: true,
            }
        }
        "close" => source_session::SourceSessionResult {
            session: state
                .close(&payload.session_id)
                .map_err(|error| source_session_failure(&request, error))?,
            method: None,
            result: None,
            cancelled: true,
        },
        "snapshot" => source_session::SourceSessionResult {
            session: state
                .snapshot(&payload.session_id)
                .map_err(|error| source_session_failure(&request, error))?,
            method: None,
            result: None,
            cancelled: false,
        },
        _ => {
            return Err(failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "SOURCE_SESSION_ACTION_UNSUPPORTED".to_string(),
                    retryable: false,
                    diagnostic_id: "source-session-action-unsupported".to_string(),
                    safe_details: std::collections::BTreeMap::new(),
                },
            ));
        }
    };
    if payload.action == "call" {
        if let Some(value) = result.result.as_mut() {
            subtitles::normalize_result(value);
        }
    }
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: result,
    })
}

#[tauri::command]
async fn backend_playback_sources(
    state: tauri::State<'_, source_session::SourceSessionState>,
    request: BackendRequest,
) -> Result<BackendResponse<serde_json::Value>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: playback_sources::PlaybackSourceResolvePayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "PLAYBACK_SOURCE_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "playback-source-payload-invalid".to_string(),
                    safe_details: [("error".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    let snapshot = playback_sources::resolve(&state, &payload)
        .await
        .map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::SourceUnavailable,
                    reason_code: "PLAYBACK_SOURCE_RESOLVE_FAILED".to_string(),
                    retryable: true,
                    diagnostic_id: "playback-source-resolve-failed".to_string(),
                    safe_details: [("error".to_string(), error)].into_iter().collect(),
                },
            )
        })?;
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: snapshot,
    })
}

#[tauri::command]
fn backend_playback_fallback(
    state: tauri::State<'_, playback_fallback::PlaybackFallbackRegistry>,
    request: BackendRequest,
) -> Result<BackendResponse<playback_fallback::PlaybackFallbackResult>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: playback_fallback::PlaybackFallbackPayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "PLAYBACK_FALLBACK_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "playback-fallback-payload-invalid".to_string(),
                    safe_details: [("error".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    let result = state.handle(payload).map_err(|error| {
        failure(
            &request,
            BackendError {
                category: BackendErrorCategory::PlaybackFailed,
                reason_code: "PLAYBACK_FALLBACK_ACTION_FAILED".to_string(),
                retryable: false,
                diagnostic_id: "playback-fallback-action-failed".to_string(),
                safe_details: [("error".to_string(), error)].into_iter().collect(),
            },
        )
    })?;
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: result,
    })
}

#[tauri::command]
async fn backend_webview_sniffer(
    app: AppHandle,
    state: tauri::State<'_, webview_sniffer::WebviewSnifferState>,
    request: BackendRequest,
) -> Result<BackendResponse<webview_sniffer::WebviewSnifferResult>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: webview_sniffer::WebviewSnifferPayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "WEBVIEW_SNIFFER_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "webview-sniffer-payload-invalid".to_string(),
                    safe_details: [("error".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    let result = state.handle(&app, &payload).await.map_err(|error| {
        failure(
            &request,
            BackendError {
                category: BackendErrorCategory::PlaybackFailed,
                reason_code: error.reason_code().to_string(),
                retryable: error.retryable(),
                diagnostic_id: "webview-sniffer-error".to_string(),
                safe_details: [("message".to_string(), error.message())]
                    .into_iter()
                    .collect(),
            },
        )
    })?;
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: result,
    })
}

#[tauri::command]
fn backend_runtime_capability(
    request: BackendRequest,
) -> Result<BackendResponse<runtime_capability::RuntimeCapabilitySnapshot>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: runtime_capability::RuntimeCapabilityPayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "RUNTIME_CAPABILITY_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "runtime-capability-payload-invalid".to_string(),
                    safe_details: [("error".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: runtime_capability::probe(&payload),
    })
}

#[tauri::command]
async fn backend_playback_start(
    app: AppHandle,
    source_state: tauri::State<'_, source_session::SourceSessionState>,
    quickjs_state: tauri::State<'_, quickjs_session::QuickJsSessionState>,
    quickjs_sidecar: tauri::State<'_, quickjs_bridge::QuickJsSidecarState>,
    sniffer_state: tauri::State<'_, webview_sniffer::WebviewSnifferState>,
    proxy_state: tauri::State<'_, playback_proxy::PlaybackProxyState>,
    mpv_state: tauri::State<'_, mpv_bridge::MpvState>,
    request: BackendRequest,
) -> Result<BackendResponse<playback_start::PlaybackStartResult>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: playback_start::PlaybackStartPayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "PLAYBACK_START_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "playback-start-payload-invalid".to_string(),
                    safe_details: [("message".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    let result = playback_start::start(
        &app,
        &source_state,
        &quickjs_state,
        &quickjs_sidecar,
        &sniffer_state,
        &proxy_state,
        &mpv_state,
        &payload,
    )
    .await
    .map_err(|error| {
        let (category, reason_code, retryable, message) = playback_start::error_fields(error);
        let category = match category.as_str() {
            "UnsupportedRuntime" => BackendErrorCategory::UnsupportedRuntime,
            "SourceUnavailable" => BackendErrorCategory::SourceUnavailable,
            "ComponentMissing" => BackendErrorCategory::ComponentMissing,
            "ComponentUntrusted" => BackendErrorCategory::ComponentUntrusted,
            "PlaybackFailed" => BackendErrorCategory::PlaybackFailed,
            _ => BackendErrorCategory::InvalidConfig,
        };
        failure(
            &request,
            BackendError {
                category,
                reason_code,
                retryable,
                diagnostic_id: "playback-start-error".to_string(),
                safe_details: [("message".to_string(), message)].into_iter().collect(),
            },
        )
    })?;
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: result,
    })
}

#[tauri::command]
async fn backend_playback_proxy(
    state: tauri::State<'_, playback_proxy::PlaybackProxyState>,
    request: BackendRequest,
) -> Result<BackendResponse<playback_proxy::PlaybackProxySnapshot>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: playback_proxy::PlaybackProxyPayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "PLAYBACK_PROXY_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "playback-proxy-payload-invalid".to_string(),
                    safe_details: [("error".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    let snapshot = state.handle(&payload).await.map_err(|error| {
        let (reason_code, message, category) = match error {
            playback_proxy::PlaybackProxyError::Invalid(message) => (
                "PLAYBACK_PROXY_INVALID",
                message,
                BackendErrorCategory::InvalidConfig,
            ),
            playback_proxy::PlaybackProxyError::NotFound => (
                "PLAYBACK_PROXY_NOT_FOUND",
                "playback proxy session was not found".to_string(),
                BackendErrorCategory::SourceUnavailable,
            ),
            playback_proxy::PlaybackProxyError::Request(message) => (
                "PLAYBACK_PROXY_FAILED",
                message,
                BackendErrorCategory::PlaybackFailed,
            ),
        };
        failure(
            &request,
            BackendError {
                category,
                reason_code: reason_code.to_string(),
                retryable: true,
                diagnostic_id: "playback-proxy-error".to_string(),
                safe_details: [("message".to_string(), message)].into_iter().collect(),
            },
        )
    })?;
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: snapshot,
    })
}

#[tauri::command]
async fn backend_mpv(
    app: AppHandle,
    state: tauri::State<'_, mpv_bridge::MpvState>,
    request: BackendRequest,
) -> Result<BackendResponse<mpv_bridge::MpvSnapshot>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: mpv_bridge::MpvPayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "MPV_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "mpv-payload-invalid".to_string(),
                    safe_details: [("message".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    let snapshot = state.handle(&app, &payload).await.map_err(|error| {
        let (category, reason_code, retryable) = match &error {
            mpv_bridge::MpvError::Invalid(_) => {
                (BackendErrorCategory::InvalidConfig, "MPV_INVALID", false)
            }
            mpv_bridge::MpvError::Missing(_) => (
                BackendErrorCategory::ComponentMissing,
                "MPV_COMPONENT_MISSING",
                false,
            ),
            mpv_bridge::MpvError::Request(_) => (
                BackendErrorCategory::PlaybackFailed,
                "MPV_REQUEST_FAILED",
                true,
            ),
        };
        failure(
            &request,
            BackendError {
                category,
                reason_code: reason_code.to_string(),
                retryable,
                diagnostic_id: "mpv-bridge-error".to_string(),
                safe_details: [("message".to_string(), mpv_error_message(error))]
                    .into_iter()
                    .collect(),
            },
        )
    })?;
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: snapshot,
    })
}

#[tauri::command]
async fn backend_cast(
    state: tauri::State<'_, cast_core::CastState>,
    request: BackendRequest,
) -> Result<BackendResponse<cast_core::CastSnapshot>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: cast_core::CastPayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "DLNA_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "dlna-payload-invalid".to_string(),
                    safe_details: [("message".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    let snapshot = state.handle(&payload).await.map_err(|error| {
        let (category, reason_code, retryable, message) = match error {
            cast_core::CastError::Invalid(message) => (
                BackendErrorCategory::InvalidConfig,
                "DLNA_INVALID",
                false,
                message,
            ),
            cast_core::CastError::Network(message) => (
                BackendErrorCategory::PlaybackFailed,
                "DLNA_REQUEST_FAILED",
                true,
                message,
            ),
        };
        failure(
            &request,
            BackendError {
                category,
                reason_code: reason_code.to_string(),
                retryable,
                diagnostic_id: "dlna-cast-error".to_string(),
                safe_details: [("message".to_string(), message)].into_iter().collect(),
            },
        )
    })?;
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: snapshot,
    })
}

#[tauri::command]
async fn backend_push(
    state: tauri::State<'_, push_core::PushState>,
    request: BackendRequest,
) -> Result<BackendResponse<push_core::PushSnapshot>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: push_core::PushPayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "PUSH_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "push-payload-invalid".to_string(),
                    safe_details: [("message".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    let snapshot = state.handle(&payload).await.map_err(|error| {
        let (category, reason_code, retryable, message) = match error {
            push_core::PushError::Invalid(message) => (
                BackendErrorCategory::InvalidConfig,
                "PUSH_INVALID",
                false,
                message,
            ),
            push_core::PushError::Conflict(message) => (
                BackendErrorCategory::PlaybackFailed,
                "PUSH_CONFLICT",
                false,
                message,
            ),
            push_core::PushError::Storage(message) => (
                BackendErrorCategory::InvalidConfig,
                "PUSH_STORAGE_FAILED",
                true,
                message,
            ),
        };
        failure(
            &request,
            BackendError {
                category,
                reason_code: reason_code.to_string(),
                retryable,
                diagnostic_id: "push-core-error".to_string(),
                safe_details: [("message".to_string(), message)].into_iter().collect(),
            },
        )
    })?;
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: snapshot,
    })
}

#[tauri::command]
async fn backend_desktop_services(
    app: AppHandle,
    request: BackendRequest,
) -> Result<BackendResponse<serde_json::Value>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: desktop_services::DesktopServicePayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "DESKTOP_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "desktop-payload-invalid".to_string(),
                    safe_details: [("message".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    let (data_root, database_path) =
        app_data_paths(&app).map_err(|error| failure(&request, error))?;
    let mut payload = payload;
    if payload
        .value
        .get("paths")
        .and_then(serde_json::Value::as_array)
        .is_none()
    {
        let picker_kind = match payload.action.as_str() {
            "local-open-file" | "local-locate" => Some("files"),
            "local-add-folder" | "download-select-folder" => Some("folder"),
            _ => None,
        };
        if let Some(kind) = picker_kind {
            let paths = if kind == "folder" {
                rfd::AsyncFileDialog::new()
                    .pick_folder()
                    .await
                    .map(|file| vec![file.path().to_string_lossy().to_string()])
                    .unwrap_or_default()
            } else {
                rfd::AsyncFileDialog::new()
                    .pick_files()
                    .await
                    .map(|files| {
                        files
                            .into_iter()
                            .map(|file| file.path().to_string_lossy().to_string())
                            .collect()
                    })
                    .unwrap_or_default()
            };
            payload.value["paths"] = serde_json::json!(paths);
        }
    }
    let snapshot = desktop_services::handle_async(data_root, database_path, payload)
        .await
        .map_err(|error| {
            let (category, reason_code, message, retryable) = match error {
                desktop_services::DesktopServiceError::Invalid(message) => (
                    BackendErrorCategory::InvalidConfig,
                    "DESKTOP_INVALID",
                    message,
                    false,
                ),
                desktop_services::DesktopServiceError::Storage(message) => (
                    BackendErrorCategory::InvalidConfig,
                    "DESKTOP_STORAGE_FAILED",
                    message,
                    true,
                ),
            };
            failure(
                &request,
                BackendError {
                    category,
                    reason_code: reason_code.to_string(),
                    retryable,
                    diagnostic_id: "desktop-services-error".to_string(),
                    safe_details: [("message".to_string(), message)].into_iter().collect(),
                },
            )
        })?;
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: snapshot,
    })
}

fn mpv_error_message(error: mpv_bridge::MpvError) -> String {
    match error {
        mpv_bridge::MpvError::Invalid(message)
        | mpv_bridge::MpvError::Missing(message)
        | mpv_bridge::MpvError::Request(message) => message,
    }
}

#[tauri::command]
async fn backend_player_window(
    app: AppHandle,
    state: tauri::State<'_, player_window::PlayerWindowState>,
    request: BackendRequest,
) -> Result<BackendResponse<player_window::PlayerWindowSnapshot>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: player_window::PlayerWindowPayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "PLAYER_WINDOW_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "player-window-payload-invalid".to_string(),
                    safe_details: [("message".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    let snapshot = state.handle(&app, &payload).await.map_err(|error| {
        let (category, reason_code, message) = match error {
            player_window::PlayerWindowError::Invalid(message) => (
                BackendErrorCategory::InvalidConfig,
                "PLAYER_WINDOW_INVALID",
                message,
            ),
            player_window::PlayerWindowError::Window(message) => (
                BackendErrorCategory::PlaybackFailed,
                "PLAYER_WINDOW_FAILED",
                message,
            ),
            player_window::PlayerWindowError::Storage(message) => (
                BackendErrorCategory::InvalidConfig,
                "PLAYER_WINDOW_STORAGE_FAILED",
                message,
            ),
        };
        failure(
            &request,
            BackendError {
                category,
                reason_code: reason_code.to_string(),
                retryable: true,
                diagnostic_id: "player-window-error".to_string(),
                safe_details: [("message".to_string(), message)].into_iter().collect(),
            },
        )
    })?;
    if payload.action == "attach"
        && payload
            .value
            .get("notifyMain")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
    {
        let _ = app.emit_to("main", "qx-player-attached", &snapshot);
    }
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: snapshot,
    })
}

#[tauri::command]
fn backend_business_data(
    app: AppHandle,
    request: BackendRequest,
) -> Result<BackendResponse<business_data::BusinessDataSnapshot>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: business_data::BusinessDataPayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "BUSINESS_DATA_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "business-data-payload-invalid".to_string(),
                    safe_details: [("error".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    let (_, database_path) = app_data_paths(&app).map_err(|error| failure(&request, error))?;
    let snapshot = match payload.action.as_str() {
        "read" => business_data::read(&database_path, &payload.entity, &payload.id),
        "upsert" => business_data::upsert(&database_path, &payload),
        "backup" => business_data::backup(&database_path),
        "remove" => business_data::remove(&database_path, &payload.entity, &payload.id),
        "list" => business_data::list(&database_path, &payload.entity),
        "restore" => business_data::restore(&database_path, &payload.value),
        _ => Err(business_data::BusinessDataError::Invalid(
            "business data action must be read, upsert, backup, remove, list, or restore"
                .to_string(),
        )),
    }
    .map_err(|error| {
        let (reason_code, message, retryable) = match error {
            business_data::BusinessDataError::Invalid(message) => {
                ("BUSINESS_DATA_INVALID", message, false)
            }
            business_data::BusinessDataError::Storage(message) => {
                ("BUSINESS_DATA_STORAGE_FAILED", message, true)
            }
        };
        failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: reason_code.to_string(),
                retryable,
                diagnostic_id: "business-data-error".to_string(),
                safe_details: [("message".to_string(), message)].into_iter().collect(),
            },
        )
    })?;
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: snapshot,
    })
}

#[tauri::command]
fn backend_business_features(
    app: AppHandle,
    request: BackendRequest,
) -> Result<BackendResponse<business_features::FeatureSnapshot>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: business_features::FeaturePayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "BUSINESS_FEATURE_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "business-feature-payload-invalid".to_string(),
                    safe_details: [("error".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    let (_, database_path) = app_data_paths(&app).map_err(|error| failure(&request, error))?;
    let snapshot = business_features::handle(&database_path, &payload).map_err(|error| {
        let (category, reason_code, message, retryable) = match error {
            business_features::FeatureError::Invalid(message) => (
                BackendErrorCategory::InvalidConfig,
                "BUSINESS_FEATURE_INVALID".to_string(),
                message,
                false,
            ),
            business_features::FeatureError::Storage(message) => (
                BackendErrorCategory::InvalidConfig,
                "BUSINESS_FEATURE_STORAGE_FAILED".to_string(),
                message,
                true,
            ),
        };
        failure(
            &request,
            BackendError {
                category,
                reason_code,
                retryable,
                diagnostic_id: "business-feature-error".to_string(),
                safe_details: [("message".to_string(), message)].into_iter().collect(),
            },
        )
    })?;
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: snapshot,
    })
}

#[tauri::command]
fn backend_component_manager(
    app: AppHandle,
    request: BackendRequest,
) -> Result<BackendResponse<component_manager::ComponentManagerSnapshot>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: component_manager::ComponentManagerPayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "COMPONENT_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "component-payload-invalid".to_string(),
                    safe_details: [("error".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    let (data_directory, _) = app_data_paths(&app).map_err(|error| failure(&request, error))?;
    let root = data_directory.join("component-manager-v1");
    let snapshot = component_manager::handle(&root, &payload).map_err(|error| {
        let category = match &error {
            component_manager::ComponentManagerError::Invalid(_) => {
                BackendErrorCategory::InvalidConfig
            }
            component_manager::ComponentManagerError::Untrusted(_) => {
                BackendErrorCategory::ComponentUntrusted
            }
            component_manager::ComponentManagerError::Storage(_) => {
                BackendErrorCategory::ComponentMissing
            }
        };
        failure(
            &request,
            BackendError {
                category,
                reason_code: error.reason_code().to_string(),
                retryable: matches!(&error, component_manager::ComponentManagerError::Storage(_)),
                diagnostic_id: "component-manager-error".to_string(),
                safe_details: [("message".to_string(), error.message())]
                    .into_iter()
                    .collect(),
            },
        )
    })?;
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: snapshot,
    })
}

#[tauri::command]
fn backend_quickjs_sidecar(
    app: AppHandle,
    state: tauri::State<'_, quickjs_bridge::QuickJsSidecarState>,
    request: BackendRequest,
) -> Result<BackendResponse<serde_json::Value>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: quickjs_bridge::QuickJsSidecarPayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "QUICKJS_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "quickjs-sidecar-payload-invalid".to_string(),
                    safe_details: [("message".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    let payload_value = state.handle(&app, payload).map_err(|error| {
        let (reason_code, message, retryable) = quickjs_bridge::error_fields(error);
        failure(
            &request,
            BackendError {
                category: if reason_code == "QUICKJS_INVALID_REQUEST" {
                    BackendErrorCategory::InvalidConfig
                } else {
                    BackendErrorCategory::SourceUnavailable
                },
                reason_code,
                retryable,
                diagnostic_id: "quickjs-sidecar-error".to_string(),
                safe_details: [("message".to_string(), message)].into_iter().collect(),
            },
        )
    })?;
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: payload_value,
    })
}

#[tauri::command]
fn backend_quickjs_session(
    app: AppHandle,
    state: tauri::State<'_, quickjs_session::QuickJsSessionState>,
    sidecar: tauri::State<'_, quickjs_bridge::QuickJsSidecarState>,
    request: BackendRequest,
) -> Result<BackendResponse<quickjs_session::QuickJsSessionResult>, BackendFailure> {
    if request.version != BACKEND_RPC_VERSION {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: "RPC_VERSION_UNSUPPORTED".to_string(),
                retryable: false,
                diagnostic_id: "rpc-invalid-version".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let payload: quickjs_session::QuickJsSessionPayload =
        serde_json::from_value(request.payload.clone()).map_err(|error| {
            failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: "QUICKJS_SESSION_PAYLOAD_INVALID".to_string(),
                    retryable: false,
                    diagnostic_id: "quickjs-session-payload-invalid".to_string(),
                    safe_details: [("message".to_string(), error.to_string())]
                        .into_iter()
                        .collect(),
                },
            )
        })?;
    let result = state.handle(&app, &sidecar, &payload).map_err(|error| {
        let (category, reason_code, retryable, message) = match error {
            quickjs_session::QuickJsSessionError::Invalid(message) => (
                BackendErrorCategory::InvalidConfig,
                "QUICKJS_SESSION_INVALID".to_string(),
                false,
                message,
            ),
            quickjs_session::QuickJsSessionError::Unsupported { code, message } => (
                BackendErrorCategory::UnsupportedRuntime,
                code,
                false,
                message,
            ),
            quickjs_session::QuickJsSessionError::NotFound => (
                BackendErrorCategory::SourceUnavailable,
                "QUICKJS_SESSION_NOT_FOUND".to_string(),
                false,
                "QuickJS session was not found".to_string(),
            ),
            quickjs_session::QuickJsSessionError::Component(error) => (
                match &error {
                    component_manager::ComponentManagerError::Invalid(_) => {
                        BackendErrorCategory::InvalidConfig
                    }
                    component_manager::ComponentManagerError::Untrusted(_) => {
                        BackendErrorCategory::ComponentUntrusted
                    }
                    component_manager::ComponentManagerError::Storage(_) => {
                        BackendErrorCategory::ComponentMissing
                    }
                },
                error.reason_code().to_string(),
                matches!(error, component_manager::ComponentManagerError::Storage(_)),
                error.message(),
            ),
            quickjs_session::QuickJsSessionError::Sidecar(error) => {
                let (reason_code, message, retryable) = quickjs_bridge::error_fields(error);
                (
                    if reason_code == "QUICKJS_INVALID_REQUEST" {
                        BackendErrorCategory::InvalidConfig
                    } else {
                        BackendErrorCategory::SourceUnavailable
                    },
                    reason_code,
                    retryable,
                    message,
                )
            }
            quickjs_session::QuickJsSessionError::Storage(message) => (
                BackendErrorCategory::ComponentMissing,
                "QUICKJS_SESSION_STORAGE_FAILED".to_string(),
                true,
                message,
            ),
        };
        failure(
            &request,
            BackendError {
                category,
                reason_code,
                retryable,
                diagnostic_id: "quickjs-session-error".to_string(),
                safe_details: [("message".to_string(), message)].into_iter().collect(),
            },
        )
    })?;
    Ok(BackendResponse {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id,
        session_id: request.session_id,
        sequence: request.sequence,
        ok: true,
        payload: result,
    })
}

fn source_session_failure(
    request: &BackendRequest,
    error: source_session::SourceSessionError,
) -> BackendFailure {
    let (reason_code, message, retryable, category) = match error {
        source_session::SourceSessionError::Invalid(message) => (
            "SOURCE_SESSION_INVALID",
            message,
            false,
            BackendErrorCategory::InvalidConfig,
        ),
        source_session::SourceSessionError::NotFound => (
            "SOURCE_SESSION_NOT_FOUND",
            "source session was not found".to_string(),
            false,
            BackendErrorCategory::SourceUnavailable,
        ),
        source_session::SourceSessionError::Cancelled => (
            "SOURCE_SESSION_CANCELLED",
            "source session request was cancelled".to_string(),
            true,
            BackendErrorCategory::SourceUnavailable,
        ),
        source_session::SourceSessionError::Unsupported(message) => (
            "SOURCE_RUNTIME_UNSUPPORTED",
            message,
            false,
            BackendErrorCategory::UnsupportedRuntime,
        ),
        source_session::SourceSessionError::Request(message) => (
            "SOURCE_SESSION_REQUEST_FAILED",
            message,
            true,
            BackendErrorCategory::SourceUnavailable,
        ),
    };
    failure(
        request,
        BackendError {
            category,
            reason_code: reason_code.to_string(),
            retryable,
            diagnostic_id: "source-session-error".to_string(),
            safe_details: [("message".to_string(), message)].into_iter().collect(),
        },
    )
}

fn failure(request: &BackendRequest, error: BackendError) -> BackendFailure {
    BackendFailure {
        version: BACKEND_RPC_VERSION.to_string(),
        request_id: request.request_id.clone(),
        session_id: request.session_id.clone(),
        sequence: request.sequence,
        ok: false,
        error,
    }
}

pub fn run() {
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                window.app_handle().state::<player_window::PlayerWindowState>().flush_on_exit(window.app_handle());
                // The primary close action ends detached playback and all in-process workers too.
                window.app_handle().exit(0);
            }
        })
        .setup(|app| {
            let window_config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or_else(|| "main window config is missing".to_string())?;
            create_main_window(app, window_config)?;
            start_runtime_canary(app.handle().clone());
            if std::env::var("QX_TAURI_E2E").as_deref() == Ok("1") {
                if let Ok(milliseconds) = std::env::var("QX_TAURI_E2E_EXIT_AFTER_MS")
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    .ok_or(())
                {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(milliseconds));
                        handle.exit(0);
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_app_snapshot,
            backend_config_catalog,
            backend_source_session,
            backend_playback_sources,
            backend_playback_start,
            backend_playback_fallback,
            backend_webview_sniffer,
            backend_runtime_capability,
            backend_playback_proxy,
            backend_mpv,
            backend_cast,
            backend_push,
            backend_desktop_services,
            backend_player_window,
            backend_business_data,
            backend_business_features,
            backend_component_manager,
            backend_quickjs_sidecar,
            backend_quickjs_session
        ])
        .manage(source_session::SourceSessionState::default())
        .manage(playback_fallback::PlaybackFallbackRegistry::default())
        .manage(playback_proxy::PlaybackProxyState::default())
        .manage(mpv_bridge::MpvState::default())
        .manage(cast_core::CastState::default())
        .manage(push_core::PushState::default())
        .manage(player_window::PlayerWindowState::default())
        .manage(quickjs_bridge::QuickJsSidecarState::default())
        .manage(quickjs_session::QuickJsSessionState::default())
        .manage(webview_sniffer::WebviewSnifferState::default())
        .run(tauri::generate_context!())
        .expect("error while running QX影视 Tauri application");
}

fn create_main_window(
    app: &tauri::App,
    window_config: tauri::utils::config::WindowConfig,
) -> Result<(), String> {
    let mut window_builder = WebviewWindowBuilder::from_config(app, &window_config)
        .map_err(|error| error.to_string())?;
    if std::env::var("QX_TAURI_E2E").as_deref() == Ok("1") {
        if let Ok(path) = std::env::var("QX_TAURI_E2E_WEBVIEW_DATA_DIR") {
            let path = std::path::PathBuf::from(path);
            fs::create_dir_all(&path).map_err(|error| error.to_string())?;
            window_builder = window_builder.data_directory(path);
        }
        if let Ok(port) = std::env::var("QX_TAURI_E2E_CDP_PORT") {
            let port = port
                .parse::<u16>()
                .map_err(|_| "QX_TAURI_E2E_CDP_PORT must be a valid TCP port".to_string())?;
            let runner_arguments = std::env::var("QX_TAURI_E2E_WEBVIEW_ARGS").ok();
            window_builder = window_builder
                .additional_browser_args(&e2e_browser_arguments(port, runner_arguments.as_deref()));
        }
    }
    window_builder
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn e2e_browser_arguments(port: u16, runner_arguments: Option<&str>) -> String {
    let mut arguments = format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
    );
    if let Some(runner_arguments) = runner_arguments
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        arguments.push(' ');
        arguments.push_str(runner_arguments);
    }
    arguments
}

fn start_runtime_canary(app: AppHandle) {
    let mode = match std::env::var("QX_TAURI_RUNTIME_CANARY") {
        Ok(value) if value == "mpv" || value == "sniffer" => value,
        _ => return,
    };
    let result_path = match std::env::var("QX_TAURI_CANARY_RESULT_PATH") {
        Ok(value) if !value.trim().is_empty() => std::path::PathBuf::from(value),
        _ => return,
    };
    tauri::async_runtime::spawn(async move {
        let result = if mode == "mpv" {
            run_mpv_runtime_canary(&app).await
        } else {
            run_sniffer_runtime_canary(&app).await
        };
        let exit_code = if result.get("verified").and_then(serde_json::Value::as_bool) == Some(true)
        {
            0
        } else {
            1
        };
        if let Some(parent) = result_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(
            &result_path,
            serde_json::to_vec_pretty(&result).unwrap_or_else(|_| b"{\"verified\":false}".to_vec()),
        );
        app.exit(exit_code);
    });
}

async fn run_mpv_runtime_canary(app: &AppHandle) -> serde_json::Value {
    let component_id = match std::env::var("QX_TAURI_CANARY_COMPONENT_ID") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => return serde_json::json!({"verified": false, "error": "component id is required"}),
    };
    let manifest_json = match std::env::var("QX_TAURI_CANARY_MANIFEST_JSON") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => return serde_json::json!({"verified": false, "error": "manifest is required"}),
    };
    let signature_base64 = match std::env::var("QX_TAURI_CANARY_SIGNATURE_BASE64") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => return serde_json::json!({"verified": false, "error": "signature is required"}),
    };
    let public_key_base64 = match std::env::var("QX_TAURI_CANARY_PUBLIC_KEY_BASE64") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => return serde_json::json!({"verified": false, "error": "public key is required"}),
    };
    let source = match std::env::var("QX_TAURI_CANARY_MEDIA_URL") {
        Ok(value) if value.starts_with("https://") => value,
        _ => return serde_json::json!({"verified": false, "error": "HTTPS media URL is required"}),
    };
    let session_id = format!("canary-mpv-{}", uuid::Uuid::new_v4());
    let (data_directory, _) = match app_data_paths(app) {
        Ok(paths) => paths,
        Err(error) => return serde_json::json!({"verified": false, "error": error.reason_code}),
    };
    let root = data_directory.join("component-manager-v1");
    let install_payload = component_manager::ComponentManagerPayload {
        action: "install".to_string(),
        component_id: Some(component_id),
        manifest_json: Some(manifest_json),
        signature_base64: Some(signature_base64),
        public_key_base64: Some(public_key_base64),
        artifact_base64: None,
        running: Some(false),
    };
    let install = match tauri::async_runtime::spawn_blocking(move || {
        component_manager::handle(&root, &install_payload)
    })
    .await
    {
        Ok(Ok(snapshot)) => snapshot,
        Ok(Err(error)) => {
            return serde_json::json!({"verified": false, "phase": "component-install", "error": format!("{error:?}")})
        }
        Err(error) => {
            return serde_json::json!({"verified": false, "phase": "component-install", "error": error.to_string()})
        }
    };
    let state = app.state::<mpv_bridge::MpvState>();
    let started = state
        .handle(
            app,
            &mpv_bridge::MpvPayload {
                action: "start".to_string(),
                session_id: session_id.clone(),
                source: Some(source),
                command: None,
            },
        )
        .await;
    let command = if started.is_ok() {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        Some(
            state
                .handle(
                    app,
                    &mpv_bridge::MpvPayload {
                        action: "command".to_string(),
                        session_id: session_id.clone(),
                        source: None,
                        command: Some(vec![
                            serde_json::json!("set_property"),
                            serde_json::json!("pause"),
                            serde_json::json!(false),
                        ]),
                    },
                )
                .await,
        )
    } else {
        None
    };
    let closed = state
        .handle(
            app,
            &mpv_bridge::MpvPayload {
                action: "close".to_string(),
                session_id,
                source: None,
                command: None,
            },
        )
        .await;
    serde_json::json!({"schemaVersion":"v1","evidenceType":"tauri-mpv-runtime-canary","verified":install.verified && started.is_ok() && command.as_ref().map(|value| value.is_ok()).unwrap_or(false) && closed.is_ok(),"componentInstall":install,"mpvStart":format!("{started:?}"),"mpvCommand":format!("{command:?}"),"mpvClose":format!("{closed:?}"),"notes":"Requires a real signed mpv component URL and a real HTTPS media URL; this is not a mock IPC process."})
}

async fn run_sniffer_runtime_canary(app: &AppHandle) -> serde_json::Value {
    let initial_url = match std::env::var("QX_TAURI_CANARY_SNIFFER_URL") {
        Ok(value) if value.starts_with("https://") => value,
        _ => {
            return serde_json::json!({"verified": false, "error": "HTTPS sniffer URL is required"})
        }
    };
    let allowed_origins = std::env::var("QX_TAURI_CANARY_SNIFFER_ORIGINS")
        .unwrap_or_else(|_| initial_url.split('/').take(3).collect::<Vec<_>>().join("/"))
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    let result = webview_sniffer::WebviewSnifferState::default()
        .handle(
            app,
            &webview_sniffer::WebviewSnifferPayload {
                action: "sniff".to_string(),
                session_id: format!("canary-sniffer-{}", uuid::Uuid::new_v4()),
                source_id: Some("runtime-canary".to_string()),
                playback_session_id: None,
                initial_url: Some(initial_url),
                headers: BTreeMap::new(),
                allowed_origins,
                max_redirects: Some(3),
                max_pages: Some(4),
                max_resources: Some(96),
                max_total_ms: Some(15_000),
                max_idle_ms: Some(2_500),
            },
        )
        .await;
    match result {
        Ok(snapshot) => {
            serde_json::json!({"schemaVersion":"v1","evidenceType":"tauri-webview2-sniffer-runtime-canary","verified":snapshot.media.is_some() && snapshot.candidate_count > 0 && snapshot.data_directory_removed,"snapshot":snapshot,"notes":"Requires a real HTTP(S) parse page that emits a media response; no fixture session is used."})
        }
        Err(error) => serde_json::json!({"verified": false, "error": format!("{error:?}")}),
    }
}

#[cfg(test)]
mod tests {
    use super::{e2e_browser_arguments, AppSnapshot, BACKEND_EVENT_VERSION, BACKEND_RPC_VERSION};

    #[test]
    fn contract_constants_are_stable() {
        assert_eq!(BACKEND_RPC_VERSION, "qx.backend.v1");
        assert_eq!(BACKEND_EVENT_VERSION, "qx.event.v1");
        let value = serde_json::to_value(AppSnapshot {
            app_name: "QX影视".to_string(),
            backend: "tauri".to_string(),
            rpc_version: BACKEND_RPC_VERSION.to_string(),
            data_directory: "C:/data".to_string(),
            database_path: "C:/data/qx-v1.sqlite3".to_string(),
        })
        .expect("snapshot serializes");
        assert_eq!(value["databasePath"], "C:/data/qx-v1.sqlite3");
    }

    #[test]
    fn e2e_browser_arguments_keep_runner_specific_flags() {
        let arguments =
            e2e_browser_arguments(9223, Some(" --disable-gpu --disable-gpu-compositing "));

        assert!(arguments.contains("--remote-debugging-port=9223"));
        assert!(arguments.ends_with("--disable-gpu --disable-gpu-compositing"));
    }
}
