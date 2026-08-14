use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout};
use uuid::Uuid;

const MPV_COMPONENT_ID: &str = "mpv";
const IPC_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(750);
const MAX_IPC_LINE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvPayload {
    pub action: String,
    pub session_id: String,
    pub source: Option<String>,
    pub command: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvSnapshot {
    pub session_id: String,
    pub state: String,
    pub reason_code: Option<String>,
}

#[derive(Debug)]
pub enum MpvError {
    Invalid(String),
    Missing(String),
    Request(String),
}

struct MpvSession {
    session_id: String,
    child: Child,
    pipe: BufReader<NamedPipeClient>,
    next_request_id: u64,
}

#[derive(Default)]
pub struct MpvState {
    session: Mutex<Option<MpvSession>>,
}

impl Drop for MpvState {
    fn drop(&mut self) {
        if let Ok(mut session) = self.session.try_lock() {
            if let Some(mut session) = session.take() {
                let _ = session.child.start_kill();
            }
        }
    }
}

impl MpvState {
    pub async fn handle(
        &self,
        app: &tauri::AppHandle,
        payload: &MpvPayload,
    ) -> Result<MpvSnapshot, MpvError> {
        validate_session_id(&payload.session_id)?;
        match payload.action.as_str() {
            "start" => self.start(app, payload).await,
            "command" => self.command(payload).await,
            "close" => self.close(&payload.session_id).await,
            _ => Err(MpvError::Invalid(
                "mpv action must be start, command, or close".to_string(),
            )),
        }
    }

    async fn start(
        &self,
        app: &tauri::AppHandle,
        payload: &MpvPayload,
    ) -> Result<MpvSnapshot, MpvError> {
        let source = validate_source(payload.source.as_deref().unwrap_or_default())?;
        let (data_directory, _) = super::app_data_paths(app)
            .map_err(|error| MpvError::Request(error.reason_code.clone()))?;
        let executable = component_payload_path(&data_directory);
        if !executable.is_file() {
            return Err(MpvError::Missing(
                "verified mpv component is not installed".to_string(),
            ));
        }

        let mut guard = self.session.lock().await;
        close_session(guard.take()).await;

        let pipe_name = format!(r"\\.\pipe\qx-mpv-{}", Uuid::new_v4());
        let mut command = Command::new(&executable);
        command.args([
            "--no-config",
            "--idle=yes",
            "--force-window=yes",
            "--terminal=no",
            &format!("--input-ipc-server={pipe_name}"),
        ]);
        let child = command
            .spawn()
            .map_err(|error| MpvError::Request(format!("mpv process failed to start: {error}")))?;
        let mut child = child;
        let pipe = match connect_pipe(&pipe_name).await {
            Ok(pipe) => pipe,
            Err(error) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(error);
            }
        };
        let mut session = MpvSession {
            session_id: payload.session_id.clone(),
            child,
            pipe: BufReader::new(pipe),
            next_request_id: 1,
        };
        if let Err(error) = send_command(
            &mut session,
            vec![json!("loadfile"), json!(source), json!("replace")],
        )
        .await
        {
            close_session(Some(session)).await;
            return Err(error);
        }
        *guard = Some(session);
        Ok(MpvSnapshot {
            session_id: payload.session_id.clone(),
            state: "ready".to_string(),
            reason_code: None,
        })
    }

    async fn command(&self, payload: &MpvPayload) -> Result<MpvSnapshot, MpvError> {
        let mut guard = self.session.lock().await;
        let session = guard
            .as_mut()
            .ok_or_else(|| MpvError::Missing("mpv session is not running".to_string()))?;
        if session.session_id != payload.session_id {
            return Err(MpvError::Missing("mpv session was replaced".to_string()));
        }
        let command = payload
            .command
            .clone()
            .ok_or_else(|| MpvError::Invalid("mpv command is required".to_string()))?;
        validate_command(&command)?;
        send_command(session, command).await?;
        Ok(MpvSnapshot {
            session_id: payload.session_id.clone(),
            state: "ready".to_string(),
            reason_code: None,
        })
    }

    async fn close(&self, session_id: &str) -> Result<MpvSnapshot, MpvError> {
        let mut guard = self.session.lock().await;
        if let Some(session) = guard.as_ref() {
            if session.session_id != session_id {
                return Err(MpvError::Missing("mpv session was replaced".to_string()));
            }
        }
        close_session(guard.take()).await;
        Ok(MpvSnapshot {
            session_id: session_id.to_string(),
            state: "closed".to_string(),
            reason_code: None,
        })
    }
}

fn component_payload_path(data_directory: &Path) -> PathBuf {
    data_directory
        .join("component-manager-v1")
        .join("components")
        .join(MPV_COMPONENT_ID)
        .join("active")
        .join("payload")
}

async fn connect_pipe(name: &str) -> Result<NamedPipeClient, MpvError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        match ClientOptions::new().open(name) {
            Ok(pipe) => return Ok(pipe),
            Err(error) if tokio::time::Instant::now() < deadline => {
                let _ = error;
                sleep(Duration::from_millis(50)).await;
            }
            Err(error) => {
                return Err(MpvError::Request(format!(
                    "mpv IPC pipe unavailable: {error}"
                )))
            }
        }
    }
}

async fn send_command(session: &mut MpvSession, command: Vec<Value>) -> Result<(), MpvError> {
    let request_id = session.next_request_id;
    session.next_request_id = session.next_request_id.saturating_add(1);
    let request = json!({ "command": command, "request_id": request_id });
    let bytes =
        serde_json::to_vec(&request).map_err(|error| MpvError::Request(error.to_string()))?;
    if bytes.len() > MAX_IPC_LINE_BYTES {
        return Err(MpvError::Invalid(
            "mpv IPC command is too large".to_string(),
        ));
    }
    session
        .pipe
        .get_mut()
        .write_all(&bytes)
        .await
        .map_err(|error| MpvError::Request(error.to_string()))?;
    session
        .pipe
        .get_mut()
        .write_all(b"\n")
        .await
        .map_err(|error| MpvError::Request(error.to_string()))?;
    session
        .pipe
        .get_mut()
        .flush()
        .await
        .map_err(|error| MpvError::Request(error.to_string()))?;

    let mut line = String::new();
    loop {
        line.clear();
        let read = timeout(IPC_TIMEOUT, session.pipe.read_line(&mut line))
            .await
            .map_err(|_| MpvError::Request("mpv IPC response timed out".to_string()))?
            .map_err(|error| MpvError::Request(error.to_string()))?;
        if read == 0 || line.len() > MAX_IPC_LINE_BYTES {
            return Err(MpvError::Request(
                "mpv IPC closed or returned an oversized response".to_string(),
            ));
        }
        let response: Value = serde_json::from_str(&line).map_err(|error| {
            MpvError::Request(format!("mpv IPC returned invalid JSON: {error}"))
        })?;
        if response.get("request_id").and_then(Value::as_u64) != Some(request_id) {
            continue;
        }
        if response
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|value| value != "success")
        {
            return Err(MpvError::Request("mpv rejected the command".to_string()));
        }
        return Ok(());
    }
}

async fn close_session(mut session: Option<MpvSession>) {
    let Some(mut session) = session.take() else {
        return;
    };
    let _ = send_command(&mut session, vec![json!("quit")]).await;
    let exited = timeout(SHUTDOWN_TIMEOUT, session.child.wait())
        .await
        .is_ok();
    if !exited {
        let _ = session.child.kill().await;
    }
}

fn validate_session_id(value: &str) -> Result<(), MpvError> {
    if value.trim().is_empty() || value.len() > 128 || value.contains(['\r', '\n']) {
        return Err(MpvError::Invalid("mpv sessionId is invalid".to_string()));
    }
    Ok(())
}

fn validate_source(value: &str) -> Result<String, MpvError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 8 * 1024 || value.contains(['\r', '\n']) {
        return Err(MpvError::Invalid("mpv source is invalid".to_string()));
    }
    Ok(value.to_string())
}

fn validate_command(command: &[Value]) -> Result<(), MpvError> {
    let name = command.first().and_then(Value::as_str).unwrap_or_default();
    if !matches!(
        name,
        "loadfile" | "stop" | "set_property" | "seek" | "sub-add" | "quit"
    ) {
        return Err(MpvError::Invalid(format!(
            "mpv command is not allowed: {name}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validate_command, validate_source};
    use serde_json::json;

    #[test]
    fn accepts_local_or_http_sources_without_newlines() {
        assert!(validate_source("C:/media/movie.mkv").is_ok());
        assert!(validate_source("https://media.example.test/movie.m3u8").is_ok());
        assert!(validate_source("C:/media/movie\n.mkv").is_err());
    }

    #[test]
    fn limits_mpv_commands_to_playback_operations() {
        assert!(
            validate_command(&[json!("loadfile"), json!("movie.mkv"), json!("replace")]).is_ok()
        );
        assert!(validate_command(&[json!("run"), json!("cmd.exe")]).is_err());
    }
}
