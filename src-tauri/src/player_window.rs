use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use super::business_features::{self, FeaturePayload};

const HISTORY_COMPLETION_RATIO: f64 = 0.9;
const HISTORY_COMPLETION_REMAINING_SECONDS: f64 = 90.0;
const HISTORY_COMPLETION_MIN_DURATION_SECONDS: f64 = 60.0;
const HISTORY_COMPLETION_REMAINING_MIN_DURATION_SECONDS: f64 = 300.0;

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

#[derive(Debug)]
struct PlayerHistoryState {
    record: Value,
    identity: String,
    source_id: String,
    started: bool,
    dirty: bool,
}

#[derive(Debug)]
struct StoredPlayerWindow {
    snapshot: Value,
    history: Option<PlayerHistoryState>,
}

impl Default for StoredPlayerWindow {
    fn default() -> Self {
        Self {
            snapshot: Value::Null,
            history: None,
        }
    }
}

#[derive(Default)]
pub struct PlayerWindowState {
    state: Arc<Mutex<StoredPlayerWindow>>,
}

impl PlayerWindowState {
    pub async fn handle(
        &self,
        app: &AppHandle,
        payload: &PlayerWindowPayload,
    ) -> Result<PlayerWindowSnapshot, PlayerWindowError> {
        match payload.action.as_str() {
            "open" => {
                self.open(&payload.value)?;
                if app.get_webview_window("player").is_none() {
                    let mut window_builder = WebviewWindowBuilder::new(
                        app,
                        "player",
                        WebviewUrl::App("index.html?player-window=1".into()),
                    )
                    .title("QX影视播放器")
                    .decorations(false)
                    .inner_size(1280.0, 760.0)
                    .min_inner_size(800.0, 480.0);
                    if std::env::var("QX_TAURI_E2E").as_deref() == Ok("1") {
                        if let Ok(path) = std::env::var("QX_TAURI_E2E_WEBVIEW_DATA_DIR") {
                            let path = PathBuf::from(path);
                            std::fs::create_dir_all(&path)
                                .map_err(|error| PlayerWindowError::Window(error.to_string()))?;
                            window_builder = window_builder.data_directory(path);
                        }
                        if let Ok(port) = std::env::var("QX_TAURI_E2E_CDP_PORT") {
                            let port = port.parse::<u16>().map_err(|_| {
                                PlayerWindowError::Window(
                                    "QX_TAURI_E2E_CDP_PORT must be a valid TCP port".to_string(),
                                )
                            })?;
                            let runner_arguments = std::env::var("QX_TAURI_E2E_WEBVIEW_ARGS").ok();
                            window_builder = window_builder.additional_browser_args(
                                &super::e2e_browser_arguments(port, runner_arguments.as_deref()),
                            );
                        }
                    }
                    let window = window_builder
                        .build()
                        .map_err(|error| PlayerWindowError::Window(error.to_string()))?;
                    let database_path = database_path(app)?;
                    let state = Arc::clone(&self.state);
                    let handle = app.clone();
                    window.on_window_event(move |event| {
                        if matches!(
                            event,
                            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                        ) {
                            let _ = flush_shared_history(&state, &database_path);
                        }
                        if matches!(event, WindowEvent::Destroyed) {
                            let stopped = state.lock().ok().is_some_and(|mut stored| {
                                if stored.snapshot["session"]["host"] != "detached" { return false; }
                                *stored = StoredPlayerWindow::default();
                                true
                            });
                            if stopped { let _ = handle.emit_to("main", "qx-player-stopped", ()); }
                        }
                    });
                }
                self.snapshot()
            }
            "sync" => {
                let database_path = database_path(app)?;
                self.sync(&database_path, &payload.value)
            }
            "attach" | "close" | "stop" => {
                let database_path = database_path(app)?;
                self.finish(&database_path, payload.action != "attach")?;
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

    fn open(&self, value: &Value) -> Result<(), PlayerWindowError> {
        let player = value
            .get("player")
            .cloned()
            .ok_or_else(|| PlayerWindowError::Invalid("PLAYER_STATE_REQUIRED".to_string()))?;
        let session = value.get("session").cloned().unwrap_or(Value::Null);
        let started = matches!(
            player.get("status").and_then(Value::as_str),
            Some("playing" | "paused" | "ended")
        );
        let history = value
            .get("history")
            .filter(|value| !value.is_null())
            .map(|value| PlayerHistoryState::from_value(value, started))
            .transpose()?;
        let mut state = self.lock_state()?;
        state.snapshot = json!({"player": player, "session": session, "theme":if value["theme"] == "light" { "light" } else { "dark" }});
        state.history = history;
        Ok(())
    }

    fn sync(
        &self,
        database_path: &Path,
        value: &Value,
    ) -> Result<PlayerWindowSnapshot, PlayerWindowError> {
        let mut state = self.lock_state()?;
        {
            let player = state.snapshot["player"]
                .as_object_mut()
                .ok_or_else(|| PlayerWindowError::Invalid("PLAYER_STATE_NOT_OPEN".to_string()))?;
            for key in [
                "status",
                "currentTime",
                "duration",
                "volume",
                "muted",
                "playbackRate",
                "error",
            ] {
                if let Some(value) = value.get(key) {
                    player.insert(key.to_string(), value.clone());
                }
            }
        }
        if let Some(history) = state.history.as_mut() {
            history.update(value);
            flush_history(database_path, history)?;
        }
        Ok(snapshot_from(&state))
    }

    fn finish(&self, database_path: &Path, clear: bool) -> Result<(), PlayerWindowError> {
        let mut state = self.lock_state()?;
        if let Some(history) = state.history.as_mut() {
            flush_history(database_path, history)?;
        }
        if clear {
            *state = StoredPlayerWindow::default();
        } else if let Some(session) = state.snapshot["session"].as_object_mut() {
            session.insert("host".into(), Value::String("embedded".into()));
        }
        Ok(())
    }

    fn snapshot(&self) -> Result<PlayerWindowSnapshot, PlayerWindowError> {
        let state = self.lock_state()?;
        Ok(snapshot_from(&state))
    }

    pub fn flush_on_exit(&self, app: &AppHandle) {
        if let Ok(path) = database_path(app) { let _ = flush_shared_history(&self.state, &path); }
    }

    fn lock_state(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, StoredPlayerWindow>, PlayerWindowError> {
        self.state
            .lock()
            .map_err(|_| PlayerWindowError::Storage("player window state poisoned".to_string()))
    }
}

impl PlayerHistoryState {
    fn from_value(value: &Value, started: bool) -> Result<Self, PlayerWindowError> {
        let record = value
            .as_object()
            .cloned()
            .map(Value::Object)
            .ok_or_else(|| {
                PlayerWindowError::Invalid("PLAYER_HISTORY_CONTEXT_INVALID".to_string())
            })?;
        let identity = required_history_string(&record, "identity")?;
        let source_id = required_history_string(&record, "sourceId")?;
        required_history_string(&record, "vodId")?;
        required_history_string(&record, "episodeId")?;
        Ok(Self {
            record,
            identity,
            source_id,
            started,
            dirty: false,
        })
    }

    fn update(&mut self, value: &Value) {
        let status = value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let event_type = value
            .get("event")
            .and_then(|event| event.get("type"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if status == "playing" || event_type == "first-frame" {
            self.started = true;
        }
        if !self.started {
            return;
        }

        let previous_position = history_number(&self.record, "position", 0.0);
        let previous_duration = history_number(&self.record, "duration", 0.0);
        let position = history_number(value, "currentTime", previous_position).max(0.0);
        let duration = history_number(value, "duration", previous_duration).max(0.0);
        let non_meaningful_reset = position <= 0.0
            && duration <= 1.0
            && status != "playing"
            && event_type != "first-frame"
            && (previous_position > 0.0 || previous_duration > 1.0);
        if !non_meaningful_reset {
            self.record["position"] = json!(position);
            self.record["duration"] = json!(duration);
        }
        let ended = status == "ended" || event_type == "completion";
        let completed = self
            .record
            .get("completed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || is_history_completed(
                history_number(&self.record, "position", 0.0),
                history_number(&self.record, "duration", 0.0),
                ended,
            );
        self.record["completed"] = json!(completed);
        self.record["updatedAt"] = json!(now_millis());
        self.dirty = true;
    }
}

fn flush_shared_history(
    state: &Arc<Mutex<StoredPlayerWindow>>,
    database_path: &Path,
) -> Result<(), PlayerWindowError> {
    let mut state = state
        .lock()
        .map_err(|_| PlayerWindowError::Storage("player window state poisoned".to_string()))?;
    if let Some(history) = state.history.as_mut() {
        flush_history(database_path, history)?;
    }
    Ok(())
}

fn flush_history(
    database_path: &Path,
    history: &mut PlayerHistoryState,
) -> Result<(), PlayerWindowError> {
    if !history.started || !history.dirty {
        return Ok(());
    }
    let settings = business_features::handle(
        database_path,
        &FeaturePayload {
            action: "snapshot".to_string(),
            feature: "history".to_string(),
            id: String::new(),
            source_id: None,
            value: Value::Null,
        },
    )
    .map_err(map_feature_error)?;
    if settings.state["history"]["paused"] == Value::Bool(true) {
        history.dirty = false;
        return Ok(());
    }
    business_features::handle(
        database_path,
        &FeaturePayload {
            action: "upsert".to_string(),
            feature: "history".to_string(),
            id: history.identity.clone(),
            source_id: Some(history.source_id.clone()),
            value: history.record.clone(),
        },
    )
    .map_err(map_feature_error)?;
    history.dirty = false;
    Ok(())
}

fn snapshot_from(state: &StoredPlayerWindow) -> PlayerWindowSnapshot {
    PlayerWindowSnapshot {
        schema_version: "v1".to_string(),
        state: state.snapshot.clone(),
    }
}

fn required_history_string(value: &Value, key: &str) -> Result<String, PlayerWindowError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| PlayerWindowError::Invalid(format!("PLAYER_HISTORY_{key}_REQUIRED")))
}

fn history_number(value: &Value, key: &str, fallback: f64) -> f64 {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn is_history_completed(position: f64, duration: f64, ended: bool) -> bool {
    if ended {
        return true;
    }
    if !position.is_finite() || !duration.is_finite() {
        return false;
    }
    let position = position.max(0.0);
    let duration = duration.max(0.0);
    if duration < HISTORY_COMPLETION_MIN_DURATION_SECONDS || position <= 0.0 {
        return false;
    }
    position / duration >= HISTORY_COMPLETION_RATIO
        || (duration >= HISTORY_COMPLETION_REMAINING_MIN_DURATION_SECONDS
            && duration - position <= HISTORY_COMPLETION_REMAINING_SECONDS)
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn database_path(app: &AppHandle) -> Result<PathBuf, PlayerWindowError> {
    super::app_data_paths(app)
        .map(|(_, database_path)| database_path)
        .map_err(|error| PlayerWindowError::Storage(error.reason_code))
}

fn map_feature_error(error: business_features::FeatureError) -> PlayerWindowError {
    match error {
        business_features::FeatureError::Invalid(message) => PlayerWindowError::Invalid(message),
        business_features::FeatureError::Storage(message) => PlayerWindowError::Storage(message),
    }
}

#[cfg(test)]
mod tests {
    use super::PlayerWindowState;
    use crate::business_features::{handle, FeaturePayload};
    use serde_json::{json, Value};

    #[test]
    fn records_detached_playback_after_first_frame_and_flushes_on_close() {
        let path = std::env::temp_dir().join(format!(
            "qx-player-window-history-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let state = PlayerWindowState::default();
        state
            .open(&json!({
                "player": { "status": "loading", "currentTime": 0, "duration": 0, "volume": 1, "muted": false },
                "session": { "id": "session-1", "host": "detached" },
                "history": {
                    "identity": "source-1:vod-1:episode-1", "sourceId": "source-1", "vodId": "vod-1", "seasonId": null, "episodeId": "episode-1",
                    "title": "Fixture title", "poster": null, "episode": 1, "episodeName": "Episode 1", "playbackLine": "Main",
                    "position": 0, "duration": 0, "completed": false, "sourceDisplayName": "Fixture", "sourceType": "remote"
                }
            }))
            .expect("open player window state");
        state
            .sync(
                &path,
                &json!({ "status": "loading", "currentTime": 0, "duration": 120 }),
            )
            .expect("pre-frame sync");
        assert!(history_items(&path).is_empty());
        state.sync(&path, &json!({ "status": "playing", "currentTime": 12, "duration": 120, "event": { "type": "first-frame" } })).expect("first frame sync");
        assert_eq!(history_items(&path)[0]["position"], 12.0);
        state
            .sync(
                &path,
                &json!({ "status": "paused", "currentTime": 42, "duration": 120 }),
            )
            .expect("pause sync");
        state.finish(&path, true).expect("close flush");
        let items = history_items(&path);
        assert_eq!(items[0]["position"], 42.0);
        assert_eq!(items[0]["duration"], 120.0);
        assert_eq!(items[0]["completed"], false);
        let stored = state.state.lock().expect("player state");
        assert!(stored.snapshot.is_null());
        assert!(stored.history.is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn uses_the_shared_completion_rule_for_detached_playback() {
        let path = std::env::temp_dir().join(format!(
            "qx-player-window-completion-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let state = PlayerWindowState::default();
        state.open(&json!({
            "player": { "status": "loading" }, "session": { "id": "session-2", "host": "detached" },
            "history": { "identity": "source-1:vod-1:episode-2", "sourceId": "source-1", "vodId": "vod-1", "episodeId": "episode-2", "title": "Fixture title", "position": 0, "duration": 0, "completed": false }
        })).expect("open player window state");
        state
            .sync(
                &path,
                &json!({ "status": "playing", "currentTime": 108, "duration": 120 }),
            )
            .expect("completion sync");
        assert_eq!(history_items(&path)[0]["completed"], true);
        let _ = std::fs::remove_file(path);
    }

    fn history_items(path: &std::path::Path) -> Vec<Value> {
        handle(
            path,
            &FeaturePayload {
                action: "snapshot".to_string(),
                feature: "history".to_string(),
                id: String::new(),
                source_id: None,
                value: Value::Null,
            },
        )
        .expect("history snapshot")
        .state["history"]["items"]
            .as_array()
            .cloned()
            .expect("history items")
    }
}
