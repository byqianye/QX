use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerWindowPayload {
    pub action: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerWindowSnapshot {
    pub schema_version: String,
    pub state: Value,
}

#[derive(Debug)]
pub enum PlayerWindowError {
    Invalid(String),
    Window(String),
    Storage(String),
}

#[derive(Default)]
pub struct PlayerWindowState {
    state: Mutex<Value>,
}

impl PlayerWindowState {
    pub async fn handle(
        &self,
        app: &AppHandle,
        payload: &PlayerWindowPayload,
    ) -> Result<PlayerWindowSnapshot, PlayerWindowError> {
        match payload.action.as_str() {
            "open" => {
                let player = payload.value.get("player").cloned().ok_or_else(|| {
                    PlayerWindowError::Invalid("PLAYER_STATE_REQUIRED".to_string())
                })?;
                let session = payload.value.get("session").cloned().unwrap_or(Value::Null);
                *self.state.lock().map_err(|_| {
                    PlayerWindowError::Storage("player window state poisoned".to_string())
                })? = json!({"player": player, "session": session});
                if app.get_webview_window("player").is_none() {
                    WebviewWindowBuilder::new(
                        app,
                        "player",
                        WebviewUrl::App("index.html?player-window=1".into()),
                    )
                    .title("QX影视播放器")
                    .inner_size(1280.0, 760.0)
                    .min_inner_size(800.0, 480.0)
                    .build()
                    .map_err(|error| PlayerWindowError::Window(error.to_string()))?;
                }
                self.snapshot()
            }
            "sync" => {
                let mut state = self.state.lock().map_err(|_| {
                    PlayerWindowError::Storage("player window state poisoned".to_string())
                })?;
                let player = state["player"].as_object_mut().ok_or_else(|| {
                    PlayerWindowError::Invalid("PLAYER_STATE_NOT_OPEN".to_string())
                })?;
                for key in [
                    "status",
                    "currentTime",
                    "duration",
                    "volume",
                    "muted",
                    "error",
                ] {
                    if let Some(value) = payload.value.get(key) {
                        player.insert(key.to_string(), value.clone());
                    }
                }
                Ok(PlayerWindowSnapshot {
                    schema_version: "v1".to_string(),
                    state: state.clone(),
                })
            }
            "attach" | "close" | "stop" => {
                if payload.action != "attach" {
                    if let Ok(mut state) = self.state.lock() {
                        *state = Value::Null;
                    }
                }
                if let Some(window) = app.get_webview_window("player") {
                    window
                        .close()
                        .map_err(|error| PlayerWindowError::Window(error.to_string()))?;
                }
                self.snapshot()
            }
            "snapshot" => self.snapshot(),
            _ => Err(PlayerWindowError::Invalid(format!(
                "PLAYER_WINDOW_ACTION_UNSUPPORTED:{}",
                payload.action
            ))),
        }
    }

    fn snapshot(&self) -> Result<PlayerWindowSnapshot, PlayerWindowError> {
        let state = self
            .state
            .lock()
            .map_err(|_| PlayerWindowError::Storage("player window state poisoned".to_string()))?
            .clone();
        Ok(PlayerWindowSnapshot {
            schema_version: "v1".to_string(),
            state,
        })
    }
}
