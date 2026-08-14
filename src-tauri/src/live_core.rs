use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::Duration;

use reqwest::blocking::Client;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use super::business_data;

const MAX_SOURCE_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePayload {
    pub action: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSnapshot {
    pub schema_version: String,
    pub state: Value,
}

#[derive(Debug)]
pub enum LiveError {
    Invalid(String),
    Request(String),
    Storage(String),
}

#[derive(Default)]
pub struct LiveCoreState {
    pending: Mutex<HashMap<String, Value>>,
}

impl LiveCoreState {
    pub fn handle(
        &self,
        path: &std::path::Path,
        payload: &LivePayload,
    ) -> Result<LiveSnapshot, LiveError> {
        let connection =
            Connection::open(path).map_err(|error| LiveError::Storage(error.to_string()))?;
        business_data::ensure_schema(&connection).map_err(map_business_error)?;
        match payload.action.as_str() {
            "snapshot" | "refresh" => {
                if payload.action == "refresh" {
                    self.refresh(&connection, &payload.id)?;
                }
                snapshot(&connection)
            }
            "preview" => self.preview(&connection, &payload.value),
            "apply" => self.apply(&connection, &payload.id),
            "toggle" => {
                let id = required_string(&payload.value, "sourceId")?;
                let mut source = record(&connection, "live_source", &id)?
                    .ok_or_else(|| LiveError::Invalid("LIVE_SOURCE_NOT_FOUND".to_string()))?;
                source["enabled"] = json!(payload
                    .value
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false));
                source["updatedAt"] = json!(now_millis());
                upsert(&connection, "live_source", &id, &source)?;
                snapshot(&connection)
            }
            "remove" => {
                let id = required_id(payload)?;
                remove_source(&connection, &id)?;
                snapshot(&connection)
            }
            "clear-preview" => {
                self.pending
                    .lock()
                    .map_err(|_| LiveError::Storage("live pending state poisoned".to_string()))?
                    .clear();
                let mut state = snapshot(&connection)?;
                state.state["live"]["preview"] = Value::Null;
                Ok(state)
            }
            "play" => play(&connection, payload),
            "line" => switch_line(&connection, payload),
            "stop" => stop(&connection, payload),
            "sync" => sync(&connection, payload),
            "smart-create" => smart_create(&connection, payload),
            "smart-update" => smart_update(&connection, payload),
            "smart-delete" => smart_delete(&connection, payload),
            "smart-member-add" => smart_member_add(&connection, payload),
            "smart-member-remove" => smart_member_remove(&connection, payload),
            "smart-member-update" | "smart-member-priority" | "smart-member-enable" => {
                smart_member_update(&connection, payload)
            }
            "smart-member-reorder" => smart_member_reorder(&connection, payload),
            "smart-select" => smart_select(&connection, payload),
            "smart-play" => smart_play(&connection, payload),
            "smart-epg" => smart_epg(&connection, payload),
            "smart-member-health" => smart_member_health(&connection, payload),
            "failover-mode" => set_failover_mode(&connection, payload),
            "failover-approve" | "failover-cancel" | "failover-stay" | "failover-return" => {
                failover_transition(&connection, payload)
            }
            _ => Err(LiveError::Invalid(format!(
                "LIVE_ACTION_UNSUPPORTED:{}",
                payload.action
            ))),
        }
    }

    fn preview(&self, _connection: &Connection, value: &Value) -> Result<LiveSnapshot, LiveError> {
        let kind = required_string(value, "type")?;
        let name = required_string(value, "name")?;
        let location = optional_string(value, "location").unwrap_or_else(|| {
            optional_string(value, "fileName")
                .map(|name| format!("file:{name}"))
                .unwrap_or_default()
        });
        let format = if kind == "txt-url"
            || kind == "txt-file"
            || value.get("format").and_then(Value::as_str) == Some("txt")
        {
            "txt"
        } else {
            "m3u"
        };
        let (content, resolved_location, base_url) = load_source_content(value, &kind, &location)?;
        let (channels, issues) = parse_live_content(&content, format, base_url.as_deref())?;
        let preview_id = format!("preview-{}", Uuid::new_v4());
        let source_id = format!("pending:{}", preview_id);
        let source = json!({
            "id": source_id,
            "name": name,
            "type": kind,
            "location": resolved_location,
            "enabled": true,
            "refreshMode": "manual",
            "lastUpdatedAt": Value::Null,
            "lastSuccessAt": Value::Null,
            "lastError": Value::Null,
            "contentHash": sha256_hex(&content),
            "etag": Value::Null,
            "lastModified": Value::Null,
            "content": if kind.ends_with("-url") { Value::Null } else { json!(content) },
        });
        let stats = stats(&channels, issues.len());
        let preview = json!({
            "id": preview_id,
            "source": source,
            "channels": channels,
            "issues": issues,
            "stats": stats,
            "contentHash": sha256_hex(&content),
            "etag": Value::Null,
            "lastModified": Value::Null,
        });
        let preview_id = preview["id"].as_str().unwrap_or_default().to_string();
        self.pending
            .lock()
            .map_err(|_| LiveError::Storage("live pending state poisoned".to_string()))?
            .insert(preview_id, preview.clone());
        let mut state = empty_snapshot();
        state.state["live"]["preview"] = preview_to_ui(&preview);
        state.state["live"]["loading"] = json!(false);
        Ok(state)
    }

    fn apply(&self, connection: &Connection, preview_id: &str) -> Result<LiveSnapshot, LiveError> {
        let preview = self
            .pending
            .lock()
            .map_err(|_| LiveError::Storage("live pending state poisoned".to_string()))?
            .remove(preview_id)
            .ok_or_else(|| LiveError::Invalid("LIVE_PREVIEW_NOT_FOUND".to_string()))?;
        let pending_id = preview["source"]["id"]
            .as_str()
            .ok_or_else(|| LiveError::Invalid("LIVE_PREVIEW_SOURCE_INVALID".to_string()))?;
        let source_id = if pending_id.starts_with("pending:") {
            format!("live-{}", Uuid::new_v4())
        } else {
            pending_id.to_string()
        };
        let mut source = preview["source"].clone();
        source["id"] = json!(source_id);
        source["lastUpdatedAt"] = json!(now_millis());
        source["lastSuccessAt"] = json!(now_millis());
        source["lastError"] = Value::Null;
        upsert(connection, "live_source", &source_id, &source)?;
        if let Some(channels) = preview["channels"].as_array() {
            for channel in channels {
                let channel_id = format!("{}:channel:{}", source_id, Uuid::new_v4());
                let mut stored = channel.clone();
                stored["id"] = json!(channel_id.clone());
                stored["sourceId"] = json!(source_id.clone());
                upsert(connection, "live_channel", &channel_id, &stored)?;
            }
        }
        snapshot(connection)
    }

    fn refresh(&self, connection: &Connection, source_id: &str) -> Result<(), LiveError> {
        let source = record(connection, "live_source", source_id)?
            .ok_or_else(|| LiveError::Invalid("LIVE_SOURCE_NOT_FOUND".to_string()))?;
        if source.get("enabled").and_then(Value::as_bool) == Some(false) {
            return Err(LiveError::Invalid("LIVE_SOURCE_DISABLED".to_string()));
        }
        let kind = required_string(&source, "type")?;
        let location = required_string(&source, "location")?;
        let format = if kind == "txt-url" || kind == "txt-file" {
            "txt"
        } else {
            "m3u"
        };
        let (content, _, base_url) = load_source_content(&source, &kind, &location)?;
        let (channels, _issues) = parse_live_content(&content, format, base_url.as_deref())?;
        for value in records(connection, "live_channel")? {
            if string(&value, "sourceId") == source_id {
                remove(connection, "live_channel", &string(&value, "id"))?;
            }
        }
        for channel in channels {
            let channel_id = format!("{}:channel:{}", source_id, Uuid::new_v4());
            let mut stored = channel;
            stored["id"] = json!(channel_id.clone());
            stored["sourceId"] = json!(source_id);
            upsert(connection, "live_channel", &channel_id, &stored)?;
        }
        let mut updated = source;
        updated["lastUpdatedAt"] = json!(now_millis());
        updated["lastSuccessAt"] = json!(now_millis());
        updated["lastError"] = Value::Null;
        updated["contentHash"] = json!(sha256_hex(&content));
        upsert(connection, "live_source", source_id, &updated)
    }
}

fn snapshot(connection: &Connection) -> Result<LiveSnapshot, LiveError> {
    let sources = records(connection, "live_source")?;
    let channels = records(connection, "live_channel")?;
    let mut source_names = BTreeMap::new();
    let source_ui = sources
        .iter()
        .map(|source| {
            let id = string(source, "id");
            source_names.insert(id.clone(), string(source, "name"));
            json!({
                "id": id,
                "name": string(source, "name"),
                "type": string(source, "type"),
                "location": string(source, "location"),
                "enabled": source.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                "refreshMode": string_or(&source, "refreshMode", "manual"),
                "lastUpdatedAt": source.get("lastUpdatedAt").cloned().unwrap_or(Value::Null),
                "lastSuccessAt": source.get("lastSuccessAt").cloned().unwrap_or(Value::Null),
                "lastError": source.get("lastError").cloned().unwrap_or(Value::Null),
                "contentHash": source.get("contentHash").cloned().unwrap_or(Value::Null),
                "etag": source.get("etag").cloned().unwrap_or(Value::Null),
                "lastModified": source.get("lastModified").cloned().unwrap_or(Value::Null),
                "channelCount": channels.iter().filter(|channel| string(channel, "sourceId") == id).count(),
                "groupCount": channels.iter().filter(|channel| string(channel, "sourceId") == id).map(|channel| string(channel, "group")).filter(|group| !group.is_empty()).collect::<std::collections::BTreeSet<_>>().len(),
                "streamCount": channels.iter().filter(|channel| string(channel, "sourceId") == id).map(|channel| channel.get("streams").and_then(Value::as_array).map(Vec::len).unwrap_or(0)).sum::<usize>(),
            })
        })
        .collect::<Vec<_>>();
    let channel_ui = channels
        .iter()
        .map(|channel| {
            let id = string(channel, "id");
            let source_id = string(channel, "sourceId");
            let streams = channel.get("streams").and_then(Value::as_array).cloned().unwrap_or_default();
            json!({
                "id": id,
                "sourceId": source_id,
                "sourceName": source_names.get(&source_id).cloned().unwrap_or_default(),
                "name": string(channel, "name"),
                "group": channel.get("group").cloned().unwrap_or(Value::Null),
                "logo": channel.get("logo").cloned().unwrap_or(Value::Null),
                "channelNumber": channel.get("tvgChno").cloned().unwrap_or(Value::Null),
                "streamCount": streams.len(),
                "streams": streams.iter().enumerate().map(|(index, stream)| json!({
                    "id": format!("{}:stream:{}", id, index),
                    "label": stream.get("label").cloned().unwrap_or_else(|| json!(format!("线路 {}", index + 1))),
                    "protocol": string_or(stream, "protocol", "HTTP"),
                    "status": "ready",
                    "health": Value::Null,
                })).collect::<Vec<_>>(),
                "epgStatus": "unmapped",
                "currentProgramme": Value::Null,
                "nextProgramme": Value::Null,
                "health": Value::Null,
            })
        })
        .collect::<Vec<_>>();
    let mut groups = BTreeMap::<String, usize>::new();
    for channel in &channel_ui {
        let group = channel
            .get("group")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if !group.is_empty() {
            *groups.entry(group).or_default() += 1;
        }
    }
    let state = json!({
        "live": {
            "sources": source_ui,
            "preview": Value::Null,
            "loading": false,
            "error": Value::Null,
            "catalog": {
                "groups": groups.into_iter().enumerate().map(|(index, (name, count))| json!({"id": name, "name": name, "channelCount": count, "sortOrder": index})).collect::<Vec<_>>(),
                "channels": channel_ui,
                "recent": [],
            },
            "session": record(connection, "live_session", "active")?.map(|value| value),
            "player": record(connection, "live_player", "active")?.unwrap_or_else(|| json!({"status":"idle","source":null,"currentTime":0,"duration":0,"volume":1,"muted":false,"fullscreen":false,"error":null})),
            "epg": empty_epg(),
            "smartChannels": smart_channels_ui(&channel_ui, &source_names, connection)?,
            "smartSuggestions": [],
            "activeSmartChannel": Value::Null,
            "health": Value::Null,
            "failover": failover_state(connection)?,
        }
    });
    Ok(LiveSnapshot {
        schema_version: "v1".to_string(),
        state,
    })
}

fn play(connection: &Connection, payload: &LivePayload) -> Result<LiveSnapshot, LiveError> {
    let channel_id = required_string(&payload.value, "channelId")?;
    let channel = record(connection, "live_channel", &channel_id)?
        .ok_or_else(|| LiveError::Invalid("LIVE_CHANNEL_NOT_FOUND".to_string()))?;
    let streams = channel
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if streams.is_empty() {
        return Err(LiveError::Invalid("LIVE_STREAM_NOT_FOUND".to_string()));
    }
    let requested = optional_string(&payload.value, "streamId");
    let index = requested
        .as_deref()
        .and_then(|id| {
            id.rsplit_once(":stream:")
                .and_then(|(_, value)| value.parse::<usize>().ok())
        })
        .unwrap_or(0);
    let stream = streams
        .get(index)
        .cloned()
        .unwrap_or_else(|| streams[0].clone());
    let session = json!({
        "sessionId": format!("live-session-{}", Uuid::new_v4()),
        "sourceId": string(&channel, "sourceId"),
        "channelId": channel_id,
        "streamId": format!("{}:stream:{}", string(&channel, "id"), index.min(streams.len() - 1)),
        "smartChannelId": Value::Null,
        "smartMemberId": Value::Null,
        "state": "loading",
        "backend": if string_or(&stream, "protocol", "HTTP") == "HLS" { "hls-js" } else { "html-video" },
        "startedAt": now_millis(),
        "firstFrameAt": Value::Null,
        "error": Value::Null,
        "generation": 1,
    });
    let player = json!({
        "status": "loading",
        "source": {"parse": 0, "url": string(&stream, "url"), "headers": safe_headers(stream.get("headers"))},
        "currentTime": 0,
        "duration": 0,
        "volume": 1,
        "muted": false,
        "fullscreen": false,
        "error": Value::Null,
    });
    upsert(connection, "live_session", "active", &session)?;
    upsert(connection, "live_player", "active", &player)?;
    snapshot(connection)
}

fn switch_line(connection: &Connection, payload: &LivePayload) -> Result<LiveSnapshot, LiveError> {
    let session = record(connection, "live_session", "active")?
        .ok_or_else(|| LiveError::Invalid("LIVE_SESSION_NOT_FOUND".to_string()))?;
    let channel_id = string(&session, "channelId");
    let mut value = payload.value.clone();
    value["channelId"] = json!(channel_id);
    let payload = LivePayload {
        action: "play".to_string(),
        id: String::new(),
        value,
    };
    play(connection, &payload)
}

fn stop(connection: &Connection, _payload: &LivePayload) -> Result<LiveSnapshot, LiveError> {
    remove(connection, "live_session", "active")?;
    remove(connection, "live_player", "active")?;
    snapshot(connection)
}

fn smart_create(connection: &Connection, payload: &LivePayload) -> Result<LiveSnapshot, LiveError> {
    let name = required_string(&payload.value, "name")?;
    let id = format!("smart-{}", Uuid::new_v4());
    let value = json!({
        "id": id,
        "name": name,
        "logo": payload.value.get("logo").cloned().unwrap_or(Value::Null),
        "group": payload.value.get("group").cloned().unwrap_or(Value::Null),
        "sortOrder": records(connection, "smart_channel")?.len(),
        "preferredMemberId": Value::Null,
        "epgSourceId": Value::Null,
        "epgChannelId": Value::Null,
        "createdAt": now_millis(),
        "updatedAt": now_millis(),
    });
    let smart_id = string(&value, "id");
    upsert(connection, "smart_channel", &smart_id, &value)?;
    for (priority, live_channel_id) in string_list(payload.value.get("memberIds"))
        .into_iter()
        .enumerate()
    {
        require_live_channel(connection, &live_channel_id)?;
        let member = json!({
            "id": format!("smart-member-{}", Uuid::new_v4()),
            "smartChannelId": smart_id,
            "liveChannelId": live_channel_id,
            "priority": priority,
            "enabled": true,
        });
        upsert(connection, "smart_member", &string(&member, "id"), &member)?;
    }
    snapshot(connection)
}

fn smart_update(connection: &Connection, payload: &LivePayload) -> Result<LiveSnapshot, LiveError> {
    let id = required_id(payload)?;
    let mut value = record(connection, "smart_channel", &id)?
        .ok_or_else(|| LiveError::Invalid("SMART_CHANNEL_NOT_FOUND".to_string()))?;
    for key in ["name", "logo", "group", "sortOrder"] {
        if let Some(next) = payload.value.get(key) {
            value[key] = next.clone();
        }
    }
    if value
        .get("name")
        .and_then(Value::as_str)
        .is_none_or(|name| name.trim().is_empty())
    {
        return Err(LiveError::Invalid("SMART_CHANNEL_NAME_INVALID".to_string()));
    }
    value["updatedAt"] = json!(now_millis());
    upsert(connection, "smart_channel", &id, &value)?;
    snapshot(connection)
}

fn smart_delete(connection: &Connection, payload: &LivePayload) -> Result<LiveSnapshot, LiveError> {
    let id = required_id(payload)?;
    if record(connection, "smart_channel", &id)?.is_none() {
        return Err(LiveError::Invalid("SMART_CHANNEL_NOT_FOUND".to_string()));
    }
    for member in records(connection, "smart_member")? {
        if string(&member, "smartChannelId") == id {
            remove(connection, "smart_member", &string(&member, "id"))?;
        }
    }
    remove(connection, "smart_channel", &id)?;
    snapshot(connection)
}

fn smart_member_add(
    connection: &Connection,
    payload: &LivePayload,
) -> Result<LiveSnapshot, LiveError> {
    let smart_id = required_string(&payload.value, "smartChannelId")?;
    require_smart_channel(connection, &smart_id)?;
    let live_channel_id = required_string(&payload.value, "liveChannelId")?;
    require_live_channel(connection, &live_channel_id)?;
    if records(connection, "smart_member")?.iter().any(|member| {
        string(member, "smartChannelId") == smart_id
            && string(member, "liveChannelId") == live_channel_id
    }) {
        return Err(LiveError::Invalid(
            "SMART_CHANNEL_MEMBER_EXISTS".to_string(),
        ));
    }
    let priority = payload
        .value
        .get("priority")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| {
            records(connection, "smart_member")
                .map(|members| {
                    members
                        .iter()
                        .filter(|member| string(member, "smartChannelId") == smart_id)
                        .count() as i64
                })
                .unwrap_or_default()
        });
    let member = json!({
        "id": format!("smart-member-{}", Uuid::new_v4()),
        "smartChannelId": smart_id,
        "liveChannelId": live_channel_id,
        "priority": priority.max(0),
        "enabled": true,
    });
    upsert(connection, "smart_member", &string(&member, "id"), &member)?;
    snapshot(connection)
}

fn smart_member_remove(
    connection: &Connection,
    payload: &LivePayload,
) -> Result<LiveSnapshot, LiveError> {
    let smart_id = required_string(&payload.value, "smartChannelId")?;
    let member_id = required_string(&payload.value, "memberId")?;
    require_smart_member(connection, &smart_id, &member_id)?;
    remove(connection, "smart_member", &member_id)?;
    if record(connection, "smart_channel", &smart_id)?
        .and_then(|value| value.get("preferredMemberId").cloned())
        .as_ref()
        .and_then(Value::as_str)
        == Some(member_id.as_str())
    {
        let mut smart = require_smart_channel(connection, &smart_id)?;
        smart["preferredMemberId"] = Value::Null;
        smart["updatedAt"] = json!(now_millis());
        upsert(connection, "smart_channel", &smart_id, &smart)?;
    }
    snapshot(connection)
}

fn smart_member_update(
    connection: &Connection,
    payload: &LivePayload,
) -> Result<LiveSnapshot, LiveError> {
    let smart_id = required_string(&payload.value, "smartChannelId")?;
    let member_id = required_string(&payload.value, "memberId")?;
    let mut member = require_smart_member(connection, &smart_id, &member_id)?;
    if let Some(priority) = payload.value.get("priority").and_then(Value::as_i64) {
        member["priority"] = json!(priority.max(0));
    }
    if let Some(enabled) = payload.value.get("enabled").and_then(Value::as_bool) {
        member["enabled"] = json!(enabled);
    }
    upsert(connection, "smart_member", &member_id, &member)?;
    snapshot(connection)
}

fn smart_member_reorder(
    connection: &Connection,
    payload: &LivePayload,
) -> Result<LiveSnapshot, LiveError> {
    let smart_id = required_string(&payload.value, "smartChannelId")?;
    let expected = records(connection, "smart_member")?
        .into_iter()
        .filter(|member| string(member, "smartChannelId") == smart_id)
        .collect::<Vec<_>>();
    let member_ids = string_list(payload.value.get("memberIds"));
    if expected.len() != member_ids.len()
        || member_ids
            .iter()
            .any(|id| !expected.iter().any(|member| string(member, "id") == *id))
    {
        return Err(LiveError::Invalid(
            "SMART_CHANNEL_MEMBER_ORDER_INVALID".to_string(),
        ));
    }
    for (priority, member_id) in member_ids.iter().enumerate() {
        let mut member = require_smart_member(connection, &smart_id, member_id)?;
        member["priority"] = json!(priority);
        upsert(connection, "smart_member", member_id, &member)?;
    }
    snapshot(connection)
}

fn smart_select(connection: &Connection, payload: &LivePayload) -> Result<LiveSnapshot, LiveError> {
    let smart_id = required_string(&payload.value, "smartChannelId")?;
    let mut smart = require_smart_channel(connection, &smart_id)?;
    match payload.value.get("memberId") {
        Some(Value::Null) | None => smart["preferredMemberId"] = Value::Null,
        Some(value) => {
            let member_id = value
                .as_str()
                .ok_or_else(|| LiveError::Invalid("SMART_CHANNEL_MEMBER_INVALID".to_string()))?;
            require_smart_member(connection, &smart_id, member_id)?;
            smart["preferredMemberId"] = json!(member_id);
        }
    }
    smart["updatedAt"] = json!(now_millis());
    upsert(connection, "smart_channel", &smart_id, &smart)?;
    snapshot(connection)
}

fn smart_play(connection: &Connection, payload: &LivePayload) -> Result<LiveSnapshot, LiveError> {
    let smart_id = required_string(&payload.value, "smartChannelId")?;
    let member = select_smart_member(
        connection,
        &smart_id,
        optional_string(&payload.value, "memberId"),
    )?;
    let mut value = payload.value.clone();
    value["channelId"] = json!(string(&member, "liveChannelId"));
    let selected = LivePayload {
        action: "play".to_string(),
        id: String::new(),
        value,
    };
    play(connection, &selected)?;
    let mut session = record(connection, "live_session", "active")?
        .ok_or_else(|| LiveError::Invalid("LIVE_SESSION_NOT_FOUND".to_string()))?;
    session["smartChannelId"] = json!(smart_id);
    session["smartMemberId"] = json!(string(&member, "id"));
    upsert(connection, "live_session", "active", &session)?;
    snapshot(connection)
}

fn smart_epg(connection: &Connection, payload: &LivePayload) -> Result<LiveSnapshot, LiveError> {
    let smart_id = required_string(&payload.value, "smartChannelId")?;
    let mut smart = require_smart_channel(connection, &smart_id)?;
    smart["epgSourceId"] = payload
        .value
        .get("epgSourceId")
        .cloned()
        .unwrap_or(Value::Null);
    smart["epgChannelId"] = payload
        .value
        .get("epgChannelId")
        .cloned()
        .unwrap_or(Value::Null);
    smart["updatedAt"] = json!(now_millis());
    upsert(connection, "smart_channel", &smart_id, &smart)?;
    snapshot(connection)
}

fn smart_member_health(
    connection: &Connection,
    payload: &LivePayload,
) -> Result<LiveSnapshot, LiveError> {
    let live_channel_id = required_string(&payload.value, "liveChannelId")?;
    let score = payload
        .value
        .get("score")
        .and_then(Value::as_f64)
        .map(|value| value.clamp(0.0, 100.0));
    let value = json!({"id": live_channel_id, "liveChannelId": live_channel_id, "score": score, "updatedAt": now_millis()});
    upsert(connection, "smart_health", &live_channel_id, &value)?;
    snapshot(connection)
}

fn require_smart_channel(connection: &Connection, id: &str) -> Result<Value, LiveError> {
    record(connection, "smart_channel", id)?
        .ok_or_else(|| LiveError::Invalid("SMART_CHANNEL_NOT_FOUND".to_string()))
}

fn require_live_channel(connection: &Connection, id: &str) -> Result<Value, LiveError> {
    record(connection, "live_channel", id)?
        .ok_or_else(|| LiveError::Invalid("LIVE_CHANNEL_NOT_FOUND".to_string()))
}

fn require_smart_member(
    connection: &Connection,
    smart_id: &str,
    member_id: &str,
) -> Result<Value, LiveError> {
    let member = record(connection, "smart_member", member_id)?
        .ok_or_else(|| LiveError::Invalid("SMART_CHANNEL_MEMBER_NOT_FOUND".to_string()))?;
    if string(&member, "smartChannelId") != smart_id {
        return Err(LiveError::Invalid(
            "SMART_CHANNEL_MEMBER_NOT_FOUND".to_string(),
        ));
    }
    Ok(member)
}

fn select_smart_member(
    connection: &Connection,
    smart_id: &str,
    requested: Option<String>,
) -> Result<Value, LiveError> {
    let smart = require_smart_channel(connection, smart_id)?;
    let mut members = records(connection, "smart_member")?
        .into_iter()
        .filter(|member| {
            string(member, "smartChannelId") == smart_id
                && member
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
        })
        .filter(|member| {
            record(connection, "live_channel", &string(member, "liveChannelId"))
                .ok()
                .flatten()
                .is_some()
        })
        .collect::<Vec<_>>();
    if let Some(member_id) = requested {
        return members
            .into_iter()
            .find(|member| string(member, "id") == member_id)
            .ok_or_else(|| LiveError::Invalid("SMART_CHANNEL_MEMBER_UNAVAILABLE".to_string()));
    }
    let preferred = string(&smart, "preferredMemberId");
    members.sort_by_key(|member| number(member, "priority"));
    let selected = members
        .iter()
        .find(|member| string(member, "id") == preferred)
        .or_else(|| members.first());
    selected
        .cloned()
        .ok_or_else(|| LiveError::Invalid("SMART_CHANNEL_UNAVAILABLE".to_string()))
}

fn smart_channels_ui(
    channel_ui: &[Value],
    source_names: &BTreeMap<String, String>,
    connection: &Connection,
) -> Result<Vec<Value>, LiveError> {
    let by_channel = channel_ui
        .iter()
        .map(|channel| (string(channel, "id"), channel))
        .collect::<BTreeMap<_, _>>();
    records(connection, "smart_channel")?.into_iter().map(|smart| {
        let smart_id = string(&smart, "id");
        let mut members = records(connection, "smart_member")?.into_iter().filter(|member| string(member, "smartChannelId") == smart_id).collect::<Vec<_>>();
        members.sort_by_key(|member| number(member, "priority"));
        let member_ui = members.iter().map(|member| {
            let live_id = string(member, "liveChannelId");
            let channel = by_channel.get(&live_id).copied();
            let health = record(connection, "smart_health", &live_id).ok().flatten().and_then(|value| value.get("score").cloned()).unwrap_or(Value::Null);
            json!({
                "id": string(member, "id"), "smartChannelId": smart_id, "liveChannelId": live_id,
                "priority": number(member, "priority"), "enabled": member.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                "channelName": channel.map(|value| string(value, "name")).unwrap_or_else(|| "频道来源不可用".to_string()),
                "sourceName": channel.and_then(|value| source_names.get(&string(value, "sourceId"))).cloned().unwrap_or_else(|| "来源已删除".to_string()),
                "available": channel.is_some(), "healthScore": health,
            })
        }).collect::<Vec<_>>();
        let preferred = string(&smart, "preferredMemberId");
        let current = member_ui.iter().find(|member| member.get("id").and_then(Value::as_str) == Some(preferred.as_str()) && member.get("available") == Some(&json!(true))).or_else(|| member_ui.iter().find(|member| member.get("available") == Some(&json!(true))));
        let epg_source_id = smart.get("epgSourceId").cloned().unwrap_or(Value::Null);
        let epg_channel_id = smart.get("epgChannelId").cloned().unwrap_or(Value::Null);
        Ok(json!({
            "id": smart_id, "name": string(&smart, "name"), "logo": smart.get("logo").cloned().unwrap_or(Value::Null), "group": smart.get("group").cloned().unwrap_or(Value::Null),
            "sortOrder": number(&smart, "sortOrder"), "preferredMemberId": if preferred.is_empty() { Value::Null } else { json!(preferred) },
            "currentMemberId": current.and_then(|value| value.get("id")).cloned().unwrap_or(Value::Null), "currentSourceName": current.and_then(|value| value.get("sourceName")).cloned().unwrap_or(Value::Null),
            "available": current.is_some(), "members": member_ui,
            "epg": {"mode": if epg_source_id.is_null() || epg_channel_id.is_null() {"unmapped"} else {"explicit"}, "sourceId": epg_source_id, "channelId": epg_channel_id, "sourceName": Value::Null, "channelName": Value::Null, "currentProgramme": Value::Null, "nextProgramme": Value::Null},
        }))
    }).collect()
}

fn sync(connection: &Connection, payload: &LivePayload) -> Result<LiveSnapshot, LiveError> {
    let mut player = record(connection, "live_player", "active")?
        .ok_or_else(|| LiveError::Invalid("LIVE_SESSION_NOT_FOUND".to_string()))?;
    for key in ["status", "currentTime", "duration", "volume", "muted"] {
        if let Some(value) = payload.value.get(key) {
            player[key] = value.clone();
        }
    }
    upsert(connection, "live_player", "active", &player)?;
    if payload.value.get("status").and_then(Value::as_str) == Some("playing") {
        if let Some(mut session) = record(connection, "live_session", "active")? {
            session["state"] = json!("playing");
            session["firstFrameAt"] = session
                .get("firstFrameAt")
                .cloned()
                .filter(|value| !value.is_null())
                .unwrap_or_else(|| json!(now_millis()));
            upsert(connection, "live_session", "active", &session)?;
        }
    }
    trigger_failover_if_needed(connection, payload)?;
    snapshot(connection)
}

fn set_failover_mode(
    connection: &Connection,
    payload: &LivePayload,
) -> Result<LiveSnapshot, LiveError> {
    let mode = required_string(&payload.value, "mode")?;
    if !matches!(mode.as_str(), "off" | "ask" | "auto") {
        return Err(LiveError::Invalid("LIVE_FAILOVER_MODE_INVALID".to_string()));
    }
    let mut state = failover_state(connection)?;
    state["mode"] = json!(mode);
    upsert(connection, "live_settings", "failover", &state)?;
    snapshot(connection)
}

fn failover_transition(
    connection: &Connection,
    payload: &LivePayload,
) -> Result<LiveSnapshot, LiveError> {
    let mut state = failover_state(connection)?;
    if payload.action == "failover-approve" {
        attempt_failover(connection, &mut state)?;
    }
    state["status"] = match payload.action.as_str() {
        "failover-approve" => json!("recovered"),
        "failover-cancel" => json!("cancelled"),
        "failover-stay" => json!("idle"),
        "failover-return" => json!("recovered"),
        _ => json!("idle"),
    };
    upsert(connection, "live_settings", "failover", &state)?;
    snapshot(connection)
}

fn trigger_failover_if_needed(
    connection: &Connection,
    payload: &LivePayload,
) -> Result<(), LiveError> {
    let event_type = payload
        .value
        .get("event")
        .and_then(|event| event.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let failed = payload.value.get("status").and_then(Value::as_str) == Some("error")
        || matches!(
            event_type,
            "fatal-error" | "segment-failure" | "playlist-refresh-failure" | "disconnect"
        );
    if !failed {
        return Ok(());
    }
    let mut state = failover_state(connection)?;
    let session = record(connection, "live_session", "active")?;
    let Some(session) = session else {
        return Ok(());
    };
    let smart_id = string(&session, "smartChannelId");
    if smart_id.is_empty() {
        return Ok(());
    }
    state["trigger"] = json!(event_type);
    state["reason"] = payload
        .value
        .get("error")
        .cloned()
        .unwrap_or_else(|| json!("playback failure"));
    state["current"] = json!({"smartChannelId": smart_id, "memberId": string(&session, "smartMemberId"), "channelId": string(&session, "channelId"), "streamId": string(&session, "streamId")});
    if string(&state, "mode") == "auto" {
        attempt_failover(connection, &mut state)?;
        state["status"] = json!("recovered");
    } else if string(&state, "mode") == "ask" {
        state["status"] = json!("pending");
    } else {
        state["status"] = json!("idle");
    }
    upsert(connection, "live_settings", "failover", &state)
}

fn attempt_failover(connection: &Connection, state: &mut Value) -> Result<(), LiveError> {
    let current = state.get("current").cloned().unwrap_or(Value::Null);
    let smart_id = required_string(&current, "smartChannelId")?;
    let current_member = string(&current, "memberId");
    let members = records(connection, "smart_member")?
        .into_iter()
        .filter(|member| {
            string(member, "smartChannelId") == smart_id
                && string(member, "id") != current_member
                && member
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
        })
        .filter(|member| {
            record(connection, "live_channel", &string(member, "liveChannelId"))
                .ok()
                .flatten()
                .is_some()
        })
        .collect::<Vec<_>>();
    let next = members
        .into_iter()
        .min_by_key(|member| number(member, "priority"));
    let Some(next) = next else {
        state["next"] = Value::Null;
        state["status"] = json!("exhausted");
        return Ok(());
    };
    let channel_id = string(&next, "liveChannelId");
    let selected = LivePayload {
        action: "play".to_string(),
        id: String::new(),
        value: json!({"channelId": channel_id}),
    };
    play(connection, &selected)?;
    let mut session = record(connection, "live_session", "active")?
        .ok_or_else(|| LiveError::Invalid("LIVE_SESSION_NOT_FOUND".to_string()))?;
    session["smartChannelId"] = json!(smart_id);
    session["smartMemberId"] = json!(string(&next, "id"));
    upsert(connection, "live_session", "active", &session)?;
    state["next"] = json!({"smartChannelId": smart_id, "memberId": string(&next, "id"), "channelId": channel_id, "streamId": string(&session, "streamId")});
    let mut tried = state
        .get("tried")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    tried.push(json!(string(&next, "id")));
    state["tried"] = Value::Array(tried);
    state["attempts"] = json!(number(state, "attempts") + 1);
    Ok(())
}

fn remove_source(connection: &Connection, source_id: &str) -> Result<(), LiveError> {
    for value in records(connection, "live_channel")? {
        if string(&value, "sourceId") == source_id {
            remove(connection, "live_channel", &string(&value, "id"))?;
        }
    }
    remove(connection, "live_source", source_id)
}

fn load_source_content(
    value: &Value,
    kind: &str,
    location: &str,
) -> Result<(String, String, Option<String>), LiveError> {
    if let Some(content) = value.get("content").and_then(Value::as_str) {
        if content.len() > MAX_SOURCE_BYTES {
            return Err(LiveError::Invalid("LIVE_SOURCE_TOO_LARGE".to_string()));
        }
        return Ok((content.to_string(), location.to_string(), None));
    }
    if kind == "fixture" {
        return Err(LiveError::Invalid(
            "LIVE_SOURCE_CONTENT_REQUIRED".to_string(),
        ));
    }
    let url = reqwest::Url::parse(location)
        .map_err(|_| LiveError::Invalid("LIVE_SOURCE_LOCATION_INVALID".to_string()))?;
    if url.scheme() != "http" && url.scheme() != "https" || url.username() != "" {
        return Err(LiveError::Invalid(
            "LIVE_SOURCE_LOCATION_UNSAFE".to_string(),
        ));
    }
    if url.query().is_some_and(|query| sensitive_query(query)) {
        return Err(LiveError::Invalid(
            "LIVE_SOURCE_LOCATION_CREDENTIALS".to_string(),
        ));
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("QX-Yingshi/1.0 live-core")
        .build()
        .map_err(|error| LiveError::Request(error.to_string()))?;
    let response = client
        .get(url.clone())
        .send()
        .map_err(|error| LiveError::Request(error.to_string()))?;
    if !response.status().is_success() {
        return Err(LiveError::Request(format!(
            "LIVE_SOURCE_HTTP_{}",
            response.status().as_u16()
        )));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_SOURCE_BYTES as u64)
    {
        return Err(LiveError::Invalid("LIVE_SOURCE_TOO_LARGE".to_string()));
    }
    let bytes = response
        .bytes()
        .map_err(|error| LiveError::Request(error.to_string()))?;
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err(LiveError::Invalid("LIVE_SOURCE_TOO_LARGE".to_string()));
    }
    let content = String::from_utf8(bytes.to_vec())
        .map_err(|_| LiveError::Invalid("LIVE_SOURCE_UTF8_INVALID".to_string()))?;
    Ok((content, url.to_string(), Some(url.to_string())))
}

fn parse_live_content(
    content: &str,
    format: &str,
    base_url: Option<&str>,
) -> Result<(Vec<Value>, Vec<Value>), LiveError> {
    let content = content.trim_start_matches('\u{feff}');
    if content.trim().is_empty() {
        return Err(LiveError::Invalid("LIVE_FORMAT_UNSUPPORTED".to_string()));
    }
    if format == "txt" {
        parse_txt(content, base_url)
    } else {
        parse_m3u(content, base_url)
    }
}

fn parse_m3u(content: &str, base_url: Option<&str>) -> Result<(Vec<Value>, Vec<Value>), LiveError> {
    let mut channels = Vec::new();
    let mut issues = Vec::new();
    let mut pending: Option<Map<String, Value>> = None;
    let mut headers = Map::new();
    let mut saw_header = false;
    for (index, raw) in content.lines().enumerate() {
        let line = raw.trim();
        let line_number = index + 1;
        if line.is_empty() {
            continue;
        }
        if line.starts_with('#') {
            let upper = line.to_ascii_uppercase();
            if upper == "#EXTM3U" || upper.starts_with("#EXTM3U ") {
                saw_header = true;
            } else if upper.starts_with("#EXTINF") {
                pending = parse_extinf(line).map_err(|_| ()).ok();
                if pending.is_none() {
                    issues.push(issue(
                        line_number,
                        "LIVE_EXTINF_INVALID",
                        "EXTINF 行无法解析。",
                        line,
                    ));
                }
                headers.clear();
            } else if upper.starts_with("#EXTVLCOPT:") {
                if let Some((name, value)) = parse_vlc_option(line) {
                    headers.insert(name, json!(value));
                }
            }
            continue;
        }
        let Some(mut channel) = pending.take() else {
            issues.push(issue(
                line_number,
                "LIVE_ENTRY_WITHOUT_EXTINF",
                "播放地址前缺少频道描述。",
                line,
            ));
            continue;
        };
        if let Some(url) = resolve_stream(line, base_url) {
            let protocol = protocol_for_url(&url);
            let stream = json!({"url": url, "headers": Value::Object(headers.clone()), "priority": 0, "label": Value::Null, "protocol": protocol});
            channel.insert("streams".to_string(), json!([stream]));
            channels.push(Value::Object(channel));
        } else {
            issues.push(issue(
                line_number,
                "LIVE_STREAM_INVALID",
                "频道播放地址无效或不安全。",
                line,
            ));
        }
        headers.clear();
    }
    if !saw_header && channels.is_empty() {
        return Err(LiveError::Invalid("LIVE_FORMAT_UNSUPPORTED".to_string()));
    }
    Ok((channels, issues))
}

fn parse_txt(content: &str, base_url: Option<&str>) -> Result<(Vec<Value>, Vec<Value>), LiveError> {
    let mut channels = Vec::new();
    let mut issues = Vec::new();
    let mut group: Option<String> = None;
    for (index, raw) in content.lines().enumerate() {
        let line = raw.trim();
        let line_number = index + 1;
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if let Some(value) = line.strip_suffix(",#genre#") {
            group = Some(value.trim().to_string());
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let Some((name, urls)) = line.split_once(',') else {
            issues.push(issue(
                line_number,
                "LIVE_TXT_LINE_INVALID",
                "TXT 行缺少频道名和地址。",
                line,
            ));
            continue;
        };
        let name = name.trim();
        let mut streams = Vec::new();
        for (priority, raw_url) in urls
            .split('#')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .enumerate()
        {
            if let Some(url) = resolve_stream(raw_url, base_url) {
                streams.push(json!({"url": url, "headers": {}, "priority": priority, "label": if priority == 0 { Value::Null } else { json!(format!("线路 {}", priority + 1)) }, "protocol": protocol_for_url(&url)}));
            }
        }
        if name.is_empty() || streams.is_empty() {
            issues.push(issue(
                line_number,
                "LIVE_TXT_LINE_INVALID",
                "TXT 行的频道名或地址无效。",
                line,
            ));
            continue;
        }
        channels.push(json!({
            "externalId": Value::Null,
            "name": name,
            "normalizedName": normalize_name(name),
            "group": group,
            "logo": Value::Null,
            "tvgId": Value::Null,
            "tvgName": Value::Null,
            "tvgLogo": Value::Null,
            "tvgChno": Value::Null,
            "catchup": Value::Null,
            "attributes": {"format": "txt"},
            "streams": streams,
        }));
    }
    if channels.is_empty() && issues.is_empty() {
        return Err(LiveError::Invalid("LIVE_FORMAT_UNSUPPORTED".to_string()));
    }
    Ok((channels, issues))
}

fn parse_extinf(line: &str) -> Result<Map<String, Value>, ()> {
    let comma = find_unquoted_comma(line, 8).ok_or(())?;
    let descriptor = line[8..comma].trim();
    let name = line[comma + 1..].trim();
    if name.is_empty() {
        return Err(());
    }
    let mut parts = descriptor.splitn(2, char::is_whitespace);
    let duration = parts.next().unwrap_or_default();
    if duration.parse::<f64>().is_err() {
        return Err(());
    }
    let attributes = parse_attributes(parts.next().unwrap_or_default());
    let tvg_id = attributes.get("tvg-id").cloned();
    let group = attributes.get("group-title").cloned();
    let logo = attributes
        .get("tvg-logo")
        .and_then(|value| safe_metadata_url(value));
    Ok(Map::from_iter([
        (
            "externalId".to_string(),
            tvg_id.clone().map(Value::String).unwrap_or(Value::Null),
        ),
        ("name".to_string(), json!(name)),
        ("normalizedName".to_string(), json!(normalize_name(name))),
        (
            "group".to_string(),
            group.clone().map(Value::String).unwrap_or(Value::Null),
        ),
        (
            "logo".to_string(),
            logo.clone().map(Value::String).unwrap_or(Value::Null),
        ),
        (
            "tvgId".to_string(),
            tvg_id.map(Value::String).unwrap_or(Value::Null),
        ),
        (
            "tvgName".to_string(),
            attributes
                .get("tvg-name")
                .cloned()
                .map(Value::String)
                .unwrap_or(Value::Null),
        ),
        (
            "tvgLogo".to_string(),
            logo.map(Value::String).unwrap_or(Value::Null),
        ),
        (
            "tvgChno".to_string(),
            attributes
                .get("tvg-chno")
                .cloned()
                .map(Value::String)
                .unwrap_or(Value::Null),
        ),
        (
            "catchup".to_string(),
            attributes
                .get("catchup-source")
                .cloned()
                .or_else(|| attributes.get("catchup").cloned())
                .map(Value::String)
                .unwrap_or(Value::Null),
        ),
        ("attributes".to_string(), json!(attributes)),
    ]))
}

fn parse_attributes(value: &str) -> BTreeMap<String, String> {
    let mut attributes = BTreeMap::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        let start = index;
        while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b'=' {
            index += 1;
        }
        if start == index {
            index += 1;
            continue;
        }
        let key = value[start..index].to_ascii_lowercase();
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        let parsed = if index < bytes.len() && bytes[index] == b'=' {
            index += 1;
            while index < bytes.len() && bytes[index].is_ascii_whitespace() {
                index += 1;
            }
            if index < bytes.len() && bytes[index] == b'"' {
                index += 1;
                let start = index;
                while index < bytes.len() && bytes[index] != b'"' {
                    index += 1;
                }
                let parsed = value[start..index].to_string();
                if index < bytes.len() {
                    index += 1;
                }
                parsed
            } else {
                let start = index;
                while index < bytes.len() && !bytes[index].is_ascii_whitespace() {
                    index += 1;
                }
                value[start..index].to_string()
            }
        } else {
            "true".to_string()
        };
        attributes.insert(key, parsed);
    }
    attributes
}

fn parse_vlc_option(line: &str) -> Option<(String, String)> {
    let (raw_key, raw_value) = line.strip_prefix("#EXTVLCOPT:")?.split_once('=')?;
    let name = match raw_key.trim().to_ascii_lowercase().as_str() {
        "http-referrer" => "referer",
        "http-user-agent" => "user-agent",
        _ => return None,
    };
    let value = raw_value.trim();
    if value.is_empty() || value.contains(['\r', '\n']) || sensitive_text(value) {
        return None;
    }
    Some((name.to_string(), value.to_string()))
}

fn resolve_stream(value: &str, base_url: Option<&str>) -> Option<String> {
    let url = if let Some(base) = base_url {
        reqwest::Url::parse(base).ok()?.join(value).ok()?
    } else {
        reqwest::Url::parse(value).ok()?
    };
    if !matches!(url.scheme(), "http" | "https" | "file")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    if url.query().is_some_and(sensitive_query) {
        return None;
    }
    Some(url.to_string())
}

fn safe_metadata_url(value: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string())
}

fn protocol_for_url(value: &str) -> &'static str {
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("file:") {
        "FILE"
    } else if lower.contains(".m3u8") {
        "HLS"
    } else if lower.contains(".mp4") {
        "MP4"
    } else {
        "HTTP"
    }
}

fn normalize_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn find_unquoted_comma(value: &str, start: usize) -> Option<usize> {
    let mut quoted = false;
    for (index, character) in value.char_indices().filter(|(index, _)| *index >= start) {
        if character == '"' {
            quoted = !quoted;
        }
        if character == ',' && !quoted {
            return Some(index);
        }
    }
    None
}

fn stats(channels: &[Value], invalid_count: usize) -> Value {
    let stream_count = channels
        .iter()
        .map(|value| {
            value
                .get("streams")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0)
        })
        .sum::<usize>();
    let groups = channels
        .iter()
        .filter_map(|value| value.get("group").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    json!({"channelCount": channels.len(), "groupCount": groups, "streamCount": stream_count, "invalidCount": invalid_count, "protocolCounts": {}, "addedCount": channels.len(), "removedCount": 0, "changedCount": 0})
}

fn preview_to_ui(preview: &Value) -> Value {
    let mut source = preview["source"].clone();
    if let Some(object) = source.as_object_mut() {
        object.remove("content");
    }
    json!({"id": preview["id"], "source": source, "channelNames": preview["channels"].as_array().map(|channels| channels.iter().map(|channel| channel["name"].clone()).collect::<Vec<_>>()).unwrap_or_default(), "issues": preview["issues"], "stats": preview["stats"]})
}

fn empty_snapshot() -> LiveSnapshot {
    LiveSnapshot {
        schema_version: "v1".to_string(),
        state: json!({"live": {"sources": [], "preview": null, "loading": false, "error": null, "catalog": {"groups": [], "channels": [], "recent": []}, "session": null, "player": {"status":"idle","source":null,"currentTime":0,"duration":0,"volume":1,"muted":false,"fullscreen":false,"error":null}, "epg": empty_epg(), "smartChannels": [], "smartSuggestions": [], "activeSmartChannel": null, "health": null, "failover": failover_default()}}),
    }
}

fn empty_epg() -> Value {
    json!({"sources": [], "preview": null, "loading": false, "error": null, "retention": {"pastRetentionMs": 21600000_i64, "futureRetentionMs": 604800000_i64}, "mappings": [], "timeline": null})
}

fn failover_default() -> Value {
    json!({"mode":"ask","status":"idle","trigger":null,"reason":null,"current":null,"next":null,"attempts":0,"maxAttempts":3,"tried":[],"startedAt":null,"deadlineAt":null,"cooldownUntil":null,"manualOverrideUntil":null})
}

fn failover_state(connection: &Connection) -> Result<Value, LiveError> {
    Ok(record(connection, "live_settings", "failover")?.unwrap_or_else(failover_default))
}

fn safe_headers(value: Option<&Value>) -> Value {
    let mut result = Map::new();
    if let Some(entries) = value.and_then(Value::as_object) {
        for (key, value) in entries {
            let lower = key.to_ascii_lowercase();
            if !matches!(
                lower.as_str(),
                "cookie" | "authorization" | "proxy-authorization"
            ) && !lower.contains("token")
            {
                if let Some(value) = value.as_str() {
                    result.insert(key.clone(), json!(value));
                }
            }
        }
    }
    Value::Object(result)
}

fn issue(line: usize, code: &str, message: &str, raw: &str) -> Value {
    json!({"line": line, "code": code, "message": message, "raw": raw.chars().take(240).collect::<String>()})
}

fn records(connection: &Connection, entity: &str) -> Result<Vec<Value>, LiveError> {
    Ok(business_data::list_connection(connection, entity)
        .map_err(map_business_error)?
        .value
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
        .into_values()
        .collect())
}

fn record(connection: &Connection, entity: &str, id: &str) -> Result<Option<Value>, LiveError> {
    Ok(business_data::read_connection(connection, entity, id)
        .map_err(map_business_error)?
        .value)
}

fn upsert(connection: &Connection, entity: &str, id: &str, value: &Value) -> Result<(), LiveError> {
    business_data::upsert_connection(
        connection,
        &business_data::BusinessDataPayload {
            action: "upsert".to_string(),
            entity: entity.to_string(),
            id: id.to_string(),
            source_id: None,
            value: value.clone(),
        },
    )
    .map(|_| ())
    .map_err(map_business_error)
}

fn remove(connection: &Connection, entity: &str, id: &str) -> Result<(), LiveError> {
    business_data::remove_connection(connection, entity, id)
        .map(|_| ())
        .map_err(map_business_error)
}

fn required_id(payload: &LivePayload) -> Result<String, LiveError> {
    if payload.id.trim().is_empty() {
        return Err(LiveError::Invalid("LIVE_ID_REQUIRED".to_string()));
    }
    Ok(payload.id.clone())
}

fn required_string(value: &Value, key: &str) -> Result<String, LiveError> {
    optional_string(value, key).ok_or_else(|| LiveError::Invalid(format!("{key} is required")))
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn number(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or_default()
}

fn string_or(value: &Value, key: &str, fallback: &str) -> String {
    optional_string(value, key).unwrap_or_else(|| fallback.to_string())
}

fn sensitive_query(query: &str) -> bool {
    query.split('&').any(|part| {
        part.split_once('=')
            .map(|(key, _)| {
                matches!(
                    key.to_ascii_lowercase().as_str(),
                    "token"
                        | "access_token"
                        | "refresh_token"
                        | "api_key"
                        | "authorization"
                        | "cookie"
                        | "password"
                        | "secret"
                )
            })
            .unwrap_or(false)
    })
}

fn sensitive_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("token=")
        || lower.contains("authorization=")
        || lower.contains("cookie=")
        || lower.contains("password=")
}

fn sha256_hex(value: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(value.as_bytes());
    hex_bytes(&digest.finalize())
}

fn hex_bytes(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default()
}

fn map_business_error(error: business_data::BusinessDataError) -> LiveError {
    match error {
        business_data::BusinessDataError::Invalid(message) => LiveError::Invalid(message),
        business_data::BusinessDataError::Storage(message) => LiveError::Storage(message),
    }
}

#[cfg(test)]
mod tests {
    use super::{LiveCoreState, LivePayload};
    use serde_json::{json, Value};
    use std::fs::remove_file;

    #[test]
    fn parses_applies_and_restores_m3u_live_sources() {
        let path = std::env::temp_dir().join(format!("qx-live-{}.sqlite3", uuid::Uuid::new_v4()));
        let state = LiveCoreState::default();
        let preview = state.handle(&path, &LivePayload { action: "preview".to_string(), id: String::new(), value: json!({"name":"Fixture","type":"m3u-file","content":"#EXTM3U\n#EXTINF:-1 group-title=\"News\",News\nhttps://media.example.test/live.m3u8"}) }).expect("preview");
        let preview_id = preview.state["live"]["preview"]["id"]
            .as_str()
            .expect("preview id")
            .to_string();
        let applied = state
            .handle(
                &path,
                &LivePayload {
                    action: "apply".to_string(),
                    id: preview_id,
                    value: Value::Null,
                },
            )
            .expect("apply");
        assert_eq!(
            applied.state["live"]["sources"].as_array().map(Vec::len),
            Some(1)
        );
        assert_eq!(
            applied.state["live"]["catalog"]["channels"]
                .as_array()
                .map(Vec::len),
            Some(1)
        );
        let _ = remove_file(path);
    }

    #[test]
    fn persists_smart_channel_members_and_selects_a_live_stream() {
        let path = std::env::temp_dir().join(format!("qx-smart-{}.sqlite3", uuid::Uuid::new_v4()));
        let state = LiveCoreState::default();
        let preview = state.handle(&path, &LivePayload { action: "preview".to_string(), id: String::new(), value: json!({"name":"Fixture","type":"m3u-file","content":"#EXTM3U\n#EXTINF:-1,News\nhttps://media.example.test/live.m3u8"}) }).expect("preview");
        let preview_id = preview.state["live"]["preview"]["id"]
            .as_str()
            .expect("preview id")
            .to_string();
        let applied = state
            .handle(
                &path,
                &LivePayload {
                    action: "apply".to_string(),
                    id: preview_id,
                    value: Value::Null,
                },
            )
            .expect("apply");
        let channel_id = applied.state["live"]["catalog"]["channels"][0]["id"]
            .as_str()
            .expect("channel id")
            .to_string();
        let created = state
            .handle(
                &path,
                &LivePayload {
                    action: "smart-create".to_string(),
                    id: String::new(),
                    value: json!({"name":"News HD","memberIds":[channel_id]}),
                },
            )
            .expect("smart create");
        let smart_id = created.state["live"]["smartChannels"][0]["id"]
            .as_str()
            .expect("smart id")
            .to_string();
        assert_eq!(
            created.state["live"]["smartChannels"][0]["members"]
                .as_array()
                .map(Vec::len),
            Some(1)
        );
        let played = state
            .handle(
                &path,
                &LivePayload {
                    action: "smart-play".to_string(),
                    id: String::new(),
                    value: json!({"smartChannelId": smart_id}),
                },
            )
            .expect("smart play");
        assert_eq!(played.state["live"]["session"]["smartChannelId"], smart_id);
        let _ = remove_file(path);
    }

    #[test]
    fn auto_failover_switches_to_the_next_enabled_smart_member() {
        let path =
            std::env::temp_dir().join(format!("qx-failover-{}.sqlite3", uuid::Uuid::new_v4()));
        let state = LiveCoreState::default();
        let preview = state.handle(&path, &LivePayload { action: "preview".to_string(), id: String::new(), value: json!({"name":"Fixture","type":"m3u-file","content":"#EXTM3U\n#EXTINF:-1,One\nhttps://media.example.test/one.m3u8\n#EXTINF:-1,Two\nhttps://media.example.test/two.m3u8"}) }).expect("preview");
        let preview_id = preview.state["live"]["preview"]["id"]
            .as_str()
            .expect("preview id")
            .to_string();
        let applied = state
            .handle(
                &path,
                &LivePayload {
                    action: "apply".to_string(),
                    id: preview_id,
                    value: Value::Null,
                },
            )
            .expect("apply");
        let channels = applied.state["live"]["catalog"]["channels"]
            .as_array()
            .expect("channels");
        let first = channels[0]["id"].as_str().expect("first").to_string();
        let second = channels[1]["id"].as_str().expect("second").to_string();
        let created = state
            .handle(
                &path,
                &LivePayload {
                    action: "smart-create".to_string(),
                    id: String::new(),
                    value: json!({"name":"Failover","memberIds":[first, second]}),
                },
            )
            .expect("smart create");
        let smart_id = created.state["live"]["smartChannels"][0]["id"]
            .as_str()
            .expect("smart id")
            .to_string();
        state
            .handle(
                &path,
                &LivePayload {
                    action: "smart-play".to_string(),
                    id: String::new(),
                    value: json!({"smartChannelId": smart_id}),
                },
            )
            .expect("smart play");
        state
            .handle(
                &path,
                &LivePayload {
                    action: "failover-mode".to_string(),
                    id: String::new(),
                    value: json!({"mode":"auto"}),
                },
            )
            .expect("auto mode");
        let failed = state
            .handle(
                &path,
                &LivePayload {
                    action: "sync".to_string(),
                    id: String::new(),
                    value: json!({"status":"error","event":{"type":"fatal-error"}}),
                },
            )
            .expect("failover");
        assert_eq!(failed.state["live"]["session"]["channelId"], second);
        assert_eq!(failed.state["live"]["failover"]["status"], "recovered");
        let _ = remove_file(path);
    }
}
