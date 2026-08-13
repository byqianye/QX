use std::fs;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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

    let data_directory = match app.path().app_local_data_dir() {
        Ok(path) => path,
        Err(error) => {
            return Err(failure(
                &request,
                BackendError {
                    category: BackendErrorCategory::InvalidConfig,
                    reason_code: error.to_string(),
                    retryable: false,
                    diagnostic_id: "app-local-data-unavailable".to_string(),
                    safe_details: std::collections::BTreeMap::new(),
                },
            ))
        }
    };
    if let Err(error) = fs::create_dir_all(&data_directory) {
        return Err(failure(
            &request,
            BackendError {
                category: BackendErrorCategory::InvalidConfig,
                reason_code: error.to_string(),
                retryable: true,
                diagnostic_id: "app-local-data-create-failed".to_string(),
                safe_details: std::collections::BTreeMap::new(),
            },
        ));
    }
    let database_path = data_directory.join("qx-v1.sqlite3");

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
        .invoke_handler(tauri::generate_handler![backend_app_snapshot])
        .run(tauri::generate_context!())
        .expect("error while running QX影视 Tauri application");
}

#[cfg(test)]
mod tests {
    use super::{AppSnapshot, BACKEND_RPC_VERSION};

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
