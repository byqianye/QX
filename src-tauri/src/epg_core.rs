use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::blocking::Client;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use super::business_data;

const MAX_XML_BYTES: usize = 50 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgPayload {
    pub action: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgSnapshot {
    pub schema_version: String,
    pub state: Value,
}

#[derive(Debug)]
pub enum EpgError {
    Invalid(String),
    Request(String),
    Storage(String),
}

#[derive(Default)]
pub struct EpgCoreState {
    pending: Mutex<HashMap<String, Value>>,
}

impl EpgCoreState {
    pub fn handle(
        &self,
        path: &std::path::Path,
        payload: &EpgPayload,
    ) -> Result<EpgSnapshot, EpgError> {
        let connection =
            Connection::open(path).map_err(|error| EpgError::Storage(error.to_string()))?;
        business_data::ensure_schema(&connection).map_err(map_business_error)?;
        match payload.action.as_str() {
            "snapshot" | "refresh" => {
                if payload.action == "refresh" {
                    self.refresh(&connection, &payload.id)?;
                }
                snapshot(&connection)
            }
            "preview" => self.preview(&payload.value),
            "apply" => self.apply(&connection, &payload.id),
            "toggle" => {
                let id = required_string(&payload.value, "sourceId")?;
                let mut source = record(&connection, "epg_source", &id)?
                    .ok_or_else(|| EpgError::Invalid("EPG_SOURCE_NOT_FOUND".to_string()))?;
                source["enabled"] = json!(payload
                    .value
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false));
                source["lastError"] = Value::Null;
                upsert(&connection, "epg_source", &id, &source)?;
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
                    .map_err(|_| EpgError::Storage("epg pending state poisoned".to_string()))?
                    .clear();
                snapshot(&connection)
            }
            "mapping-set" | "mapping-confirm" => set_mapping(&connection, payload),
            "mapping-clear" => clear_mapping(&connection, payload),
            "mapping-confirm-high" => confirm_high(&connection),
            "alias-set" => set_alias(&connection, payload),
            "alias-remove" => remove_alias(&connection, payload),
            "timeline" => set_timeline(&connection, payload),
            "timeline-clear" => {
                remove(&connection, "epg_timeline", "active")?;
                snapshot(&connection)
            }
            _ => Err(EpgError::Invalid(format!(
                "EPG_ACTION_UNSUPPORTED:{}",
                payload.action
            ))),
        }
    }

    fn preview(&self, value: &Value) -> Result<EpgSnapshot, EpgError> {
        let kind = required_string(value, "type")?;
        let name = required_string(value, "name")?;
        let location = optional_string(value, "location").unwrap_or_else(|| {
            optional_string(value, "fileName")
                .map(|name| format!("file:{name}"))
                .unwrap_or_default()
        });
        let content = load_content(value, &kind, &location)?;
        let parsed = parse_xmltv(&content)?;
        let preview_id = format!("preview-{}", Uuid::new_v4());
        let source = json!({
            "id": format!("pending:{preview_id}"),
            "name": name,
            "type": kind,
            "location": location,
            "enabled": true,
            "lastUpdatedAt": Value::Null,
            "lastSuccessAt": Value::Null,
            "lastError": Value::Null,
            "etag": Value::Null,
            "lastModified": Value::Null,
            "contentHash": sha256_hex(&content),
            "content": content,
        });
        let stats = json!({"channelCount": parsed.channels.len(), "programmeCount": parsed.programmes.len(), "invalidCount": parsed.issues.len()});
        let preview = json!({
            "id": preview_id,
            "source": source,
            "channels": parsed.channels,
            "programmes": parsed.programmes,
            "issues": parsed.issues,
            "stats": stats,
            "contentHash": sha256_hex(&content),
            "etag": Value::Null,
            "lastModified": Value::Null,
        });
        let id = preview["id"].as_str().unwrap_or_default().to_string();
        self.pending
            .lock()
            .map_err(|_| EpgError::Storage("epg pending state poisoned".to_string()))?
            .insert(id, preview.clone());
        let mut state = empty_snapshot();
        state.state["epg"]["preview"] = preview_to_ui(&preview);
        Ok(state)
    }

    fn apply(&self, connection: &Connection, preview_id: &str) -> Result<EpgSnapshot, EpgError> {
        let preview = self
            .pending
            .lock()
            .map_err(|_| EpgError::Storage("epg pending state poisoned".to_string()))?
            .remove(preview_id)
            .ok_or_else(|| EpgError::Invalid("EPG_PREVIEW_NOT_FOUND".to_string()))?;
        let pending_source = preview["source"]["id"]
            .as_str()
            .ok_or_else(|| EpgError::Invalid("EPG_PREVIEW_SOURCE_INVALID".to_string()))?;
        let source_id = if pending_source.starts_with("pending:") {
            format!("epg-{}", Uuid::new_v4())
        } else {
            pending_source.to_string()
        };
        let mut source = preview["source"].clone();
        source["id"] = json!(source_id.clone());
        source["lastUpdatedAt"] = json!(now_millis());
        source["lastSuccessAt"] = json!(now_millis());
        source["lastError"] = Value::Null;
        upsert(connection, "epg_source", &source_id, &source)?;
        for channel in preview["channels"].as_array().cloned().unwrap_or_default() {
            let id = format!("{}:channel:{}", source_id, string(&channel, "externalId"));
            let mut stored = channel;
            stored["id"] = json!(id.clone());
            stored["sourceId"] = json!(source_id.clone());
            upsert(connection, "epg_channel", &id, &stored)?;
        }
        for programme in preview["programmes"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            let id = format!("{}:programme:{}", source_id, string(&programme, "id"));
            let mut stored = programme;
            stored["id"] = json!(id.clone());
            stored["sourceId"] = json!(source_id.clone());
            upsert(connection, "epg_programme", &id, &stored)?;
        }
        snapshot(connection)
    }

    fn refresh(&self, connection: &Connection, source_id: &str) -> Result<(), EpgError> {
        let source = record(connection, "epg_source", source_id)?
            .ok_or_else(|| EpgError::Invalid("EPG_SOURCE_NOT_FOUND".to_string()))?;
        if source.get("enabled").and_then(Value::as_bool) == Some(false) {
            return Err(EpgError::Invalid("EPG_SOURCE_DISABLED".to_string()));
        }
        let kind = required_string(&source, "type")?;
        let location = required_string(&source, "location")?;
        let content = load_content(&source, &kind, &location)?;
        let parsed = parse_xmltv(&content)?;
        for entity in ["epg_channel", "epg_programme"] {
            for value in records(connection, entity)? {
                if string(&value, "sourceId") == source_id {
                    remove(connection, entity, &string(&value, "id"))?;
                }
            }
        }
        for channel in parsed.channels {
            let id = format!("{}:channel:{}", source_id, string(&channel, "externalId"));
            let mut stored = channel;
            stored["id"] = json!(id.clone());
            stored["sourceId"] = json!(source_id);
            upsert(connection, "epg_channel", &id, &stored)?;
        }
        for programme in parsed.programmes {
            let id = format!("{}:programme:{}", source_id, string(&programme, "id"));
            let mut stored = programme;
            stored["id"] = json!(id.clone());
            stored["sourceId"] = json!(source_id);
            upsert(connection, "epg_programme", &id, &stored)?;
        }
        let mut updated = source;
        updated["lastUpdatedAt"] = json!(now_millis());
        updated["lastSuccessAt"] = json!(now_millis());
        updated["lastError"] = Value::Null;
        updated["contentHash"] = json!(sha256_hex(&content));
        upsert(connection, "epg_source", source_id, &updated)
    }
}

#[derive(Default)]
struct ParsedXmltv {
    channels: Vec<Value>,
    programmes: Vec<Value>,
    issues: Vec<Value>,
}

fn snapshot(connection: &Connection) -> Result<EpgSnapshot, EpgError> {
    let sources = records(connection, "epg_source")?;
    let channels = records(connection, "epg_channel")?;
    let programmes = records(connection, "epg_programme")?;
    let source_ui = sources
        .iter()
        .map(|source| {
            let id = string(source, "id");
            json!({
                "id": id,
                "name": string(source, "name"),
                "type": string(source, "type"),
                "location": string(source, "location"),
                "enabled": source.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                "lastUpdatedAt": source.get("lastUpdatedAt").cloned().unwrap_or(Value::Null),
                "lastSuccessAt": source.get("lastSuccessAt").cloned().unwrap_or(Value::Null),
                "lastError": source.get("lastError").cloned().unwrap_or(Value::Null),
                "etag": source.get("etag").cloned().unwrap_or(Value::Null),
                "lastModified": source.get("lastModified").cloned().unwrap_or(Value::Null),
                "contentHash": source.get("contentHash").cloned().unwrap_or(Value::Null),
                "channelCount": channels.iter().filter(|channel| string(channel, "sourceId") == id).count(),
                "programmeCount": programmes.iter().filter(|programme| string(programme, "sourceId") == id).count(),
            })
        })
        .collect::<Vec<_>>();
    let mappings = records(connection, "epg_mapping")?
        .into_iter()
        .map(|value| mapping_ui(connection, value))
        .collect::<Result<Vec<_>, _>>()?;
    let timeline = record(connection, "epg_timeline", "active")?;
    let state = json!({
        "epg": {
            "sources": source_ui,
            "preview": Value::Null,
            "loading": false,
            "error": Value::Null,
            "retention": {"pastRetentionMs": 21600000_i64, "futureRetentionMs": 604800000_i64},
            "mappings": mappings,
            "timeline": timeline,
        }
    });
    Ok(EpgSnapshot {
        schema_version: "v1".to_string(),
        state,
    })
}

fn mapping_ui(connection: &Connection, mut value: Value) -> Result<Value, EpgError> {
    let live_channel_id = string(&value, "liveChannelId");
    let live_channel = record(connection, "live_channel", &live_channel_id)?;
    value["liveChannelName"] = json!(live_channel
        .as_ref()
        .map(|value| string(value, "name"))
        .unwrap_or_default());
    value["liveSourceName"] = json!(live_channel
        .as_ref()
        .and_then(
            |channel| record(connection, "live_source", &string(channel, "sourceId"))
                .ok()
                .flatten()
        )
        .map(|source| string(&source, "name"))
        .unwrap_or_default());
    value["status"] = if value
        .get("userConfirmed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        json!("mapped")
    } else {
        json!("suggested")
    };
    value["mapping"] = json!({
        "id": value["id"],
        "liveChannelId": value["liveChannelId"],
        "epgSourceId": value["epgSourceId"],
        "epgChannelId": value["epgChannelId"],
        "method": value["method"],
        "confidence": value["confidence"],
        "userConfirmed": value["userConfirmed"],
        "updatedAt": value["updatedAt"],
    });
    value["mappingSourceName"] = record(connection, "epg_source", &string(&value, "epgSourceId"))?
        .map(|source| json!(string(&source, "name")))
        .unwrap_or(Value::Null);
    value["mappingChannelName"] =
        record(connection, "epg_channel", &string(&value, "epgChannelId"))?
            .map(|channel| json!(string(&channel, "displayName")))
            .unwrap_or(Value::Null);
    value["aliases"] = records(connection, "epg_alias")?
        .into_iter()
        .filter(|alias| string(alias, "liveChannelId") == live_channel_id)
        .map(|alias| json!(string(&alias, "alias")))
        .collect::<Vec<_>>()
        .into();
    value["candidates"] = json!([]);
    Ok(value)
}

fn set_mapping(connection: &Connection, payload: &EpgPayload) -> Result<EpgSnapshot, EpgError> {
    let live_channel_id = required_string(&payload.value, "liveChannelId")?;
    let epg_source_id = required_string(&payload.value, "epgSourceId")?;
    let epg_channel_id = required_string(&payload.value, "epgChannelId")?;
    let confirmed = payload.action == "mapping-confirm";
    let id = format!("{}:{}", live_channel_id, epg_source_id);
    let value = json!({
        "id": id,
        "liveChannelId": live_channel_id,
        "epgSourceId": epg_source_id,
        "epgChannelId": epg_channel_id,
        "method": if confirmed {"explicit"} else {"normalized-name"},
        "confidence": if confirmed {"exact"} else {"high"},
        "userConfirmed": confirmed,
        "updatedAt": now_millis(),
    });
    upsert(connection, "epg_mapping", &string(&value, "id"), &value)?;
    snapshot(connection)
}

fn clear_mapping(connection: &Connection, payload: &EpgPayload) -> Result<EpgSnapshot, EpgError> {
    let live_channel_id = required_string(&payload.value, "liveChannelId")?;
    for value in records(connection, "epg_mapping")? {
        if string(&value, "liveChannelId") == live_channel_id {
            remove(connection, "epg_mapping", &string(&value, "id"))?;
        }
    }
    snapshot(connection)
}

fn confirm_high(connection: &Connection) -> Result<EpgSnapshot, EpgError> {
    for value in records(connection, "epg_mapping")? {
        if value.get("confidence").and_then(Value::as_str) == Some("high") {
            let mut value = value;
            value["userConfirmed"] = json!(true);
            upsert(connection, "epg_mapping", &string(&value, "id"), &value)?;
        }
    }
    snapshot(connection)
}

fn set_alias(connection: &Connection, payload: &EpgPayload) -> Result<EpgSnapshot, EpgError> {
    let live_channel_id = required_string(&payload.value, "liveChannelId")?;
    let alias = required_string(&payload.value, "alias")?;
    let value = json!({"id": format!("{}:{}", live_channel_id, alias.to_lowercase()), "liveChannelId": live_channel_id, "alias": alias, "normalizedAlias": normalize_name(&alias), "updatedAt": now_millis()});
    upsert(connection, "epg_alias", &string(&value, "id"), &value)?;
    snapshot(connection)
}

fn remove_alias(connection: &Connection, payload: &EpgPayload) -> Result<EpgSnapshot, EpgError> {
    let live_channel_id = required_string(&payload.value, "liveChannelId")?;
    let alias = required_string(&payload.value, "alias")?;
    remove(
        connection,
        "epg_alias",
        &format!("{}:{}", live_channel_id, alias.to_lowercase()),
    )?;
    snapshot(connection)
}

fn set_timeline(connection: &Connection, payload: &EpgPayload) -> Result<EpgSnapshot, EpgError> {
    let channel = required_string(&payload.value, "liveChannelId")?;
    let from_at = payload
        .value
        .get("fromAt")
        .and_then(Value::as_i64)
        .unwrap_or_else(now_millis);
    let to_at = payload
        .value
        .get("toAt")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| from_at + 7 * 24 * 60 * 60 * 1000);
    let programmes = records(connection, "epg_programme")?
        .into_iter()
        .filter(|programme| {
            string(programme, "channelId") == channel
                && number(programme, "startAt") < to_at
                && number(programme, "endAt") > from_at
        })
        .collect::<Vec<_>>();
    upsert(
        connection,
        "epg_timeline",
        "active",
        &json!({"liveChannelId": channel, "fromAt": from_at, "toAt": to_at, "items": programmes}),
    )?;
    snapshot(connection)
}

fn remove_source(connection: &Connection, source_id: &str) -> Result<(), EpgError> {
    for entity in ["epg_channel", "epg_programme"] {
        for value in records(connection, entity)? {
            if string(&value, "sourceId") == source_id {
                remove(connection, entity, &string(&value, "id"))?;
            }
        }
    }
    remove(connection, "epg_source", source_id)
}

fn load_content(value: &Value, kind: &str, location: &str) -> Result<String, EpgError> {
    if let Some(content) = value.get("content").and_then(Value::as_str) {
        if content.len() > MAX_XML_BYTES {
            return Err(EpgError::Invalid("EPG_TOO_LARGE".to_string()));
        }
        return Ok(content.to_string());
    }
    if kind == "fixture" {
        return Err(EpgError::Invalid("EPG_CONTENT_REQUIRED".to_string()));
    }
    let url = reqwest::Url::parse(location)
        .map_err(|_| EpgError::Invalid("EPG_LOCATION_INVALID".to_string()))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
    {
        return Err(EpgError::Invalid("EPG_LOCATION_UNSAFE".to_string()));
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("QX-Yingshi/1.0 epg-core")
        .build()
        .map_err(|error| EpgError::Request(error.to_string()))?;
    let response = client
        .get(url)
        .send()
        .map_err(|error| EpgError::Request(error.to_string()))?;
    if !response.status().is_success() {
        return Err(EpgError::Request(format!(
            "EPG_SOURCE_HTTP_{}",
            response.status().as_u16()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_XML_BYTES as u64)
    {
        return Err(EpgError::Invalid("EPG_TOO_LARGE".to_string()));
    }
    let bytes = response
        .bytes()
        .map_err(|error| EpgError::Request(error.to_string()))?;
    if bytes.len() > MAX_XML_BYTES {
        return Err(EpgError::Invalid("EPG_TOO_LARGE".to_string()));
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| EpgError::Invalid("EPG_UTF8_INVALID".to_string()))
}

fn parse_xmltv(content: &str) -> Result<ParsedXmltv, EpgError> {
    let mut reader = Reader::from_str(content);
    reader.config_mut().trim_text(true);
    let mut result = ParsedXmltv::default();
    let mut current_channel: Option<Map<String, Value>> = None;
    let mut current_programme: Option<Map<String, Value>> = None;
    let mut current_tag = String::new();
    let mut text = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                current_tag = String::from_utf8_lossy(event.name().as_ref()).to_string();
                if current_tag == "channel" {
                    let id = attr(&event, "id").unwrap_or_default();
                    current_channel = Some(Map::from_iter([
                        ("externalId".to_string(), json!(id)),
                        ("displayName".to_string(), json!(id)),
                        ("displayNames".to_string(), json!([])),
                        ("normalizedName".to_string(), json!(normalize_name(&id))),
                        ("icon".to_string(), Value::Null),
                    ]));
                } else if current_tag == "programme" {
                    let channel_id = attr(&event, "channel").unwrap_or_default();
                    let start = attr(&event, "start").and_then(|value| parse_xmltv_time(&value));
                    let end = attr(&event, "stop").and_then(|value| parse_xmltv_time(&value));
                    if let (Some(start), Some(end)) = (start, end) {
                        current_programme = Some(Map::from_iter([
                            ("id".to_string(), json!(format!("{}:{}", channel_id, start))),
                            ("externalChannelId".to_string(), json!(channel_id)),
                            ("channelId".to_string(), json!(channel_id)),
                            ("startAt".to_string(), json!(start)),
                            ("endAt".to_string(), json!(end)),
                            ("title".to_string(), json!("")),
                            ("subTitle".to_string(), Value::Null),
                            ("description".to_string(), Value::Null),
                            ("categories".to_string(), json!([])),
                            ("icon".to_string(), Value::Null),
                        ]));
                    }
                }
                text.clear();
            }
            Ok(Event::Text(value)) => {
                text.push_str(
                    &value
                        .decode()
                        .map_err(|error| EpgError::Invalid(error.to_string()))?,
                );
            }
            Ok(Event::Empty(event)) => {
                let name = String::from_utf8_lossy(event.name().as_ref()).to_string();
                if name == "icon" {
                    if let Some(target) = current_channel
                        .as_mut()
                        .or_else(|| current_programme.as_mut())
                    {
                        if let Some(value) = attr(&event, "src") {
                            target.insert("icon".to_string(), json!(safe_url(&value)));
                        }
                    }
                }
            }
            Ok(Event::End(event)) => {
                let name = String::from_utf8_lossy(event.name().as_ref()).to_string();
                if name == "display-name" {
                    if let Some(channel) = current_channel.as_mut() {
                        channel["displayName"] = json!(text.clone());
                        channel["displayNames"] = json!([text.clone()]);
                        channel["normalizedName"] = json!(normalize_name(&text));
                    }
                } else if name == "title" {
                    if let Some(programme) = current_programme.as_mut() {
                        programme["title"] = json!(text.clone());
                    }
                } else if name == "sub-title" {
                    if let Some(programme) = current_programme.as_mut() {
                        programme["subTitle"] = json!(text.clone());
                    }
                } else if name == "desc" {
                    if let Some(programme) = current_programme.as_mut() {
                        programme["description"] = json!(text.clone());
                    }
                } else if name == "category" {
                    if let Some(programme) = current_programme.as_mut() {
                        programme["categories"] = json!([text.clone()]);
                    }
                } else if name == "channel" {
                    if let Some(channel) = current_channel.take() {
                        result.channels.push(Value::Object(channel));
                    }
                } else if name == "programme" {
                    if let Some(programme) = current_programme.take() {
                        if programme
                            .get("title")
                            .and_then(Value::as_str)
                            .is_some_and(|value| !value.trim().is_empty())
                        {
                            result.programmes.push(Value::Object(programme));
                        } else {
                            result.issues.push(json!({"code":"EPG_PROGRAMME_TITLE_REQUIRED","message":"节目缺少标题","line":null,"raw":null}));
                        }
                    }
                }
                text.clear();
                current_tag.clear();
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(EpgError::Invalid(format!("EPG_XML_INVALID:{error}"))),
            _ => {}
        }
    }
    if result.channels.is_empty() {
        return Err(EpgError::Invalid("EPG_SOURCE_EMPTY".to_string()));
    }
    Ok(result)
}

fn attr(event: &quick_xml::events::BytesStart<'_>, name: &str) -> Option<String> {
    event
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.as_ref() == name.as_bytes())
        .and_then(|attribute| {
            attribute
                .unescape_value()
                .ok()
                .map(|value| value.to_string())
        })
}

fn parse_xmltv_time(value: &str) -> Option<i64> {
    let value = value.trim();
    let digits = value.split_whitespace().next()?;
    if digits.len() < 14 {
        return None;
    }
    let year = digits[0..4].parse::<i64>().ok()?;
    let month = digits[4..6].parse::<i64>().ok()?;
    let day = digits[6..8].parse::<i64>().ok()?;
    let hour = digits[8..10].parse::<i64>().ok()?;
    let minute = digits[10..12].parse::<i64>().ok()?;
    let second = digits[12..14].parse::<i64>().ok()?;
    let mut offset = 0;
    if let Some(zone) = value.split_whitespace().nth(1) {
        if zone.len() >= 5 {
            offset = zone[1..3].parse::<i64>().ok()? * 60 + zone[3..5].parse::<i64>().ok()?;
            if zone.starts_with('-') {
                offset = -offset;
            }
        }
    }
    Some(
        (days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second
            - offset * 60)
            * 1000,
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_adjusted = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_adjusted + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146097 + day_of_era - 719468
}

fn safe_url(value: &str) -> Value {
    let Ok(mut url) = reqwest::Url::parse(value) else {
        return Value::Null;
    };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Value::Null;
    }
    url.set_query(None);
    url.set_fragment(None);
    json!(url.to_string())
}

fn preview_to_ui(preview: &Value) -> Value {
    let mut source = preview["source"].clone();
    if let Some(object) = source.as_object_mut() {
        object.remove("content");
    }
    json!({"id": preview["id"], "source": source, "channelNames": preview["channels"].as_array().map(|channels| channels.iter().map(|channel| channel["displayName"].clone()).collect::<Vec<_>>()).unwrap_or_default(), "issues": preview["issues"], "stats": preview["stats"]})
}

fn empty_snapshot() -> EpgSnapshot {
    EpgSnapshot {
        schema_version: "v1".to_string(),
        state: json!({"epg": {"sources": [], "preview": null, "loading": false, "error": null, "retention": {"pastRetentionMs":21600000_i64,"futureRetentionMs":604800000_i64}, "mappings": [], "timeline": null}}),
    }
}

fn records(connection: &Connection, entity: &str) -> Result<Vec<Value>, EpgError> {
    Ok(business_data::list_connection(connection, entity)
        .map_err(map_business_error)?
        .value
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
        .into_values()
        .collect())
}

fn record(connection: &Connection, entity: &str, id: &str) -> Result<Option<Value>, EpgError> {
    Ok(business_data::read_connection(connection, entity, id)
        .map_err(map_business_error)?
        .value)
}

fn upsert(connection: &Connection, entity: &str, id: &str, value: &Value) -> Result<(), EpgError> {
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

fn remove(connection: &Connection, entity: &str, id: &str) -> Result<(), EpgError> {
    business_data::remove_connection(connection, entity, id)
        .map(|_| ())
        .map_err(map_business_error)
}

fn required_id(payload: &EpgPayload) -> Result<String, EpgError> {
    if payload.id.trim().is_empty() {
        Err(EpgError::Invalid("EPG_ID_REQUIRED".to_string()))
    } else {
        Ok(payload.id.clone())
    }
}
fn required_string(value: &Value, key: &str) -> Result<String, EpgError> {
    optional_string(value, key).ok_or_else(|| EpgError::Invalid(format!("{key} is required")))
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
fn number(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or_default()
}
fn normalize_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn sha256_hex(value: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(value.as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default()
}
fn map_business_error(error: business_data::BusinessDataError) -> EpgError {
    match error {
        business_data::BusinessDataError::Invalid(message) => EpgError::Invalid(message),
        business_data::BusinessDataError::Storage(message) => EpgError::Storage(message),
    }
}

#[cfg(test)]
mod tests {
    use super::{EpgCoreState, EpgPayload};
    use serde_json::{json, Value};
    use std::fs::remove_file;

    #[test]
    fn parses_xmltv_applies_and_restores_source() {
        let path = std::env::temp_dir().join(format!("qx-epg-{}.sqlite3", uuid::Uuid::new_v4()));
        let state = EpgCoreState::default();
        let preview = state.handle(&path, &EpgPayload { action: "preview".to_string(), id: String::new(), value: json!({"name":"Fixture","type":"fixture","content":"<tv><channel id=\"news\"><display-name>News</display-name></channel><programme channel=\"news\" start=\"20260814090000 +0800\" stop=\"20260814100000 +0800\"><title>Morning</title></programme></tv>"}) }).expect("preview");
        let preview_id = preview.state["epg"]["preview"]["id"]
            .as_str()
            .expect("preview id")
            .to_string();
        let applied = state
            .handle(
                &path,
                &EpgPayload {
                    action: "apply".to_string(),
                    id: preview_id,
                    value: Value::Null,
                },
            )
            .expect("apply");
        assert_eq!(
            applied.state["epg"]["sources"].as_array().map(Vec::len),
            Some(1)
        );
        assert_eq!(applied.state["epg"]["sources"][0]["channelCount"], 1);
        assert_eq!(applied.state["epg"]["sources"][0]["programmeCount"], 1);
        let _ = remove_file(path);
    }
}
