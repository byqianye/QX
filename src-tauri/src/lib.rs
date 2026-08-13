use std::fs;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

mod config_catalog;
mod native_sources;
mod runtime_capability;
mod source_session;

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
    let data_directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| BackendError {
            category: BackendErrorCategory::InvalidConfig,
            reason_code: error.to_string(),
            retryable: false,
            diagnostic_id: "app-local-data-unavailable".to_string(),
            safe_details: std::collections::BTreeMap::new(),
        })?;
    fs::create_dir_all(&data_directory).map_err(|error| BackendError {
        category: BackendErrorCategory::InvalidConfig,
        reason_code: error.to_string(),
        retryable: true,
        diagnostic_id: "app-local-data-create-failed".to_string(),
        safe_details: std::collections::BTreeMap::new(),
    })?;
    let database_path = data_directory.join("qx-v1.sqlite3");
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
fn backend_config_catalog(
    app: AppHandle,
    request: BackendRequest,
) -> Result<BackendResponse<config_catalog::ConfigCatalogSnapshot>, BackendFailure> {
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
    let (_, database_path) = app_data_paths(&app).map_err(|error| failure(&request, error))?;
    let snapshot = config_catalog::ingest(&database_path, &payload).map_err(|error| {
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
    let result = match payload.action.as_str() {
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
        .invoke_handler(tauri::generate_handler![
            backend_app_snapshot,
            backend_config_catalog,
            backend_source_session,
            backend_runtime_capability
        ])
        .manage(source_session::SourceSessionState::default())
        .run(tauri::generate_context!())
        .expect("error while running QX影视 Tauri application");
}

#[cfg(test)]
mod tests {
    use super::{AppSnapshot, BACKEND_EVENT_VERSION, BACKEND_RPC_VERSION};

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
}
