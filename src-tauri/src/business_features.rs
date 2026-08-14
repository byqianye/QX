use std::collections::BTreeMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use super::business_data;

const DEFAULT_GROUP_ID: &str = "default";
const DEFAULT_GROUP_NAME: &str = "默认收藏";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeaturePayload {
    pub action: String,
    pub feature: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureSnapshot {
    pub schema_version: String,
    pub feature: String,
    pub state: Value,
}

#[derive(Debug)]
pub enum FeatureError {
    Invalid(String),
    Storage(String),
}

pub fn handle(
    path: &std::path::Path,
    payload: &FeaturePayload,
) -> Result<FeatureSnapshot, FeatureError> {
    let connection =
        Connection::open(path).map_err(|error| FeatureError::Storage(error.to_string()))?;
    business_data::ensure_schema(&connection).map_err(map_business_error)?;
    let feature = normalize_feature(&payload.feature)?;
    match (feature, payload.action.as_str()) {
        ("history", "snapshot") => snapshot(&connection, "history"),
        ("history", "upsert") => {
            let value = normalize_history_value(&payload.value)?;
            upsert_record(
                &connection,
                "history",
                &payload.id,
                payload.source_id.as_deref(),
                &value,
            )?;
            snapshot(&connection, "history")
        }
        ("history", "delete") => {
            remove_record(&connection, "history", &payload.id)?;
            snapshot(&connection, "history")
        }
        ("history", "delete-progress") => {
            let mut value = record(&connection, "history", &payload.id)?
                .ok_or_else(|| FeatureError::Invalid("HISTORY_NOT_FOUND".to_string()))?;
            let object = value
                .as_object_mut()
                .ok_or_else(|| FeatureError::Invalid("HISTORY_RECORD_INVALID".to_string()))?;
            object.insert("position".to_string(), json!(0));
            object.insert("duration".to_string(), json!(0));
            object.insert("completed".to_string(), json!(false));
            object.insert("updatedAt".to_string(), json!(now_millis()));
            upsert_record(
                &connection,
                "history",
                &payload.id,
                payload.source_id.as_deref(),
                &value,
            )?;
            snapshot(&connection, "history")
        }
        ("history", "clear") => {
            let identities = string_array_optional(&payload.value, "identities")?;
            if identities.is_empty() {
                clear_records(&connection, "history")?;
            } else {
                for identity in identities {
                    remove_record(&connection, "history", &identity)?;
                }
            }
            snapshot(&connection, "history")
        }
        ("history", "pause") => {
            upsert_record(
                &connection,
                "feature_settings",
                "history_paused",
                None,
                &json!({ "paused": payload.value.get("paused").and_then(Value::as_bool).unwrap_or(false) }),
            )?;
            snapshot(&connection, "history")
        }
        ("favorites", "snapshot") => snapshot(&connection, "favorites"),
        ("favorites", "toggle") => toggle_favorite(&connection, payload),
        ("favorites", "delete") => {
            remove_record(&connection, "favorite", &payload.id)?;
            snapshot(&connection, "favorites")
        }
        ("favorites", "move") => {
            let group_id = required_string(&payload.value, "groupId")?;
            if record(&connection, "favorite_group", &group_id)?.is_none() {
                return Err(FeatureError::Invalid(
                    "FAVORITE_GROUP_NOT_FOUND".to_string(),
                ));
            }
            let mut value = record(&connection, "favorite", &payload.id)?
                .ok_or_else(|| FeatureError::Invalid("FAVORITE_NOT_FOUND".to_string()))?;
            value["groupId"] = Value::String(group_id);
            value["updatedAt"] = json!(now_millis());
            upsert_record(&connection, "favorite", &payload.id, None, &value)?;
            snapshot(&connection, "favorites")
        }
        ("favorites", "reorder") => reorder_favorites(&connection, payload),
        ("favorites", "group-create") => create_group(&connection, payload),
        ("favorites", "group-rename") => rename_group(&connection, payload),
        ("favorites", "group-delete") => delete_group(&connection, payload),
        ("favorites", "group-reorder") => reorder_groups(&connection, payload),
        ("follow", "snapshot") => snapshot(&connection, "follow"),
        ("follow", "upsert") => {
            let value = normalize_follow_value(&payload.value)?;
            upsert_record(
                &connection,
                "follow",
                &payload.id,
                payload.source_id.as_deref(),
                &value,
            )?;
            snapshot(&connection, "follow")
        }
        ("follow", "delete") => {
            remove_record(&connection, "follow", &payload.id)?;
            snapshot(&connection, "follow")
        }
        ("follow", "mark-watched") => mark_follow(&connection, &payload.id, true),
        ("follow", "mark-unwatched") => mark_follow(&connection, &payload.id, false),
        _ => Err(FeatureError::Invalid(format!(
            "unsupported business feature action: {}:{}",
            payload.feature, payload.action
        ))),
    }
}

fn snapshot(connection: &Connection, feature: &str) -> Result<FeatureSnapshot, FeatureError> {
    let state = match feature {
        "history" => {
            let mut items = records(connection, "history")?;
            items.sort_by(|left, right| number(right, "updatedAt").cmp(&number(left, "updatedAt")));
            json!({
                "history": {
                    "items": items,
                    "paused": record(connection, "feature_settings", "history_paused")?
                        .and_then(|value| value.get("paused").and_then(Value::as_bool))
                        .unwrap_or(false),
                }
            })
        }
        "favorites" => {
            ensure_default_group(connection)?;
            let mut items = records(connection, "favorite")?;
            items.sort_by(|left, right| {
                string(left, "groupId")
                    .cmp(&string(right, "groupId"))
                    .then(number(left, "sortOrder").cmp(&number(right, "sortOrder")))
                    .then(number(right, "addedAt").cmp(&number(left, "addedAt")))
            });
            let groups = records(connection, "favorite_group")?;
            let items = items
                .into_iter()
                .map(|mut value| {
                    value["sourceAvailable"] = json!(true);
                    value["recentWatchedAt"] = Value::Null;
                    value
                })
                .collect::<Vec<_>>();
            let groups = groups
                .into_iter()
                .map(|mut value| {
                    let id = string(&value, "groupId");
                    value["count"] = json!(items
                        .iter()
                        .filter(|item| string(item, "groupId") == id)
                        .count());
                    value
                })
                .collect::<Vec<_>>();
            json!({ "favorites": { "items": items, "groups": groups, "defaultGroupId": DEFAULT_GROUP_ID } })
        }
        "follow" => {
            let items = records(connection, "follow")?
                .into_iter()
                .map(|mut value| {
                    value["sourceAvailable"] = json!(true);
                    value["status"] = if value
                        .get("checkError")
                        .and_then(Value::as_str)
                        .is_some_and(|v| !v.is_empty())
                    {
                        json!("error")
                    } else if value
                        .get("updateAvailable")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        json!("updated")
                    } else {
                        json!("caught-up")
                    };
                    value
                })
                .collect::<Vec<_>>();
            let update_count = items
                .iter()
                .filter(|item| {
                    item.get("updateAvailable")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
                .count();
            json!({ "follow": { "items": items, "checking": false, "updateCount": update_count } })
        }
        _ => {
            return Err(FeatureError::Invalid(
                "unsupported business feature".to_string(),
            ))
        }
    };
    Ok(FeatureSnapshot {
        schema_version: "v1".to_string(),
        feature: feature.to_string(),
        state,
    })
}

fn toggle_favorite(
    connection: &Connection,
    payload: &FeaturePayload,
) -> Result<FeatureSnapshot, FeatureError> {
    ensure_default_group(connection)?;
    let source_id = required_string(&payload.value, "sourceId")?;
    let vod_id = required_string(&payload.value, "vodId")?;
    let existing = records(connection, "favorite")?
        .into_iter()
        .find(|value| string(value, "sourceId") == source_id && string(value, "vodId") == vod_id);
    if let Some(existing) = existing {
        remove_record(connection, "favorite", &string(&existing, "favoriteId"))?;
    } else {
        let now = now_millis();
        let favorite_id = if payload.id.trim().is_empty() {
            format!("favorite:{}", Uuid::new_v4())
        } else {
            payload.id.clone()
        };
        let sort_order = records(connection, "favorite")?
            .into_iter()
            .filter(|value| string(value, "groupId") == DEFAULT_GROUP_ID)
            .map(|value| number(&value, "sortOrder"))
            .max()
            .unwrap_or(-1)
            + 1;
        let value = json!({
            "favoriteId": favorite_id,
            "sourceId": source_id,
            "vodId": vod_id,
            "title": optional_string(&payload.value, "title").unwrap_or_else(|| vod_id.clone()),
            "poster": payload.value.get("poster").cloned().unwrap_or(Value::Null),
            "year": payload.value.get("year").cloned().unwrap_or(Value::Null),
            "category": payload.value.get("category").cloned().unwrap_or(Value::Null),
            "sourceName": payload.value.get("sourceName").cloned().unwrap_or(Value::Null),
            "groupId": DEFAULT_GROUP_ID,
            "sortOrder": sort_order,
            "metadata": payload.value.get("metadata").cloned().unwrap_or(Value::Null),
            "addedAt": now,
            "updatedAt": now,
        });
        upsert_record(
            connection,
            "favorite",
            &favorite_id,
            Some(&source_id),
            &value,
        )?;
    }
    snapshot(connection, "favorites")
}

fn reorder_favorites(
    connection: &Connection,
    payload: &FeaturePayload,
) -> Result<FeatureSnapshot, FeatureError> {
    let group_id = required_string(&payload.value, "groupId")?;
    let ids = string_array(&payload.value, "favoriteIds")?;
    let known = records(connection, "favorite")?;
    let mut by_id = known
        .into_iter()
        .map(|value| (string(&value, "favoriteId"), value))
        .collect::<BTreeMap<_, _>>();
    if ids.len()
        != by_id
            .values()
            .filter(|value| string(value, "groupId") == group_id)
            .count()
        || ids.iter().any(|id| {
            by_id
                .get(id)
                .map_or(true, |value| string(value, "groupId") != group_id)
        })
    {
        return Err(FeatureError::Invalid("FAVORITE_SORT_INVALID".to_string()));
    }
    for (index, id) in ids.iter().enumerate() {
        let value = by_id.get_mut(id).expect("validated favorite id");
        value["sortOrder"] = json!(index as i64);
        value["updatedAt"] = json!(now_millis());
        upsert_record(connection, "favorite", id, None, value)?;
    }
    snapshot(connection, "favorites")
}

fn create_group(
    connection: &Connection,
    payload: &FeaturePayload,
) -> Result<FeatureSnapshot, FeatureError> {
    let name = required_string(&payload.value, "name")?;
    if records(connection, "favorite_group")?
        .iter()
        .any(|value| string(value, "name") == name)
    {
        return Err(FeatureError::Invalid("FAVORITE_GROUP_EXISTS".to_string()));
    }
    let id = if payload.id.trim().is_empty() {
        format!("favorite-group:{}", Uuid::new_v4())
    } else {
        payload.id.clone()
    };
    let sort_order = records(connection, "favorite_group")?
        .into_iter()
        .map(|value| number(&value, "sortOrder"))
        .max()
        .unwrap_or(0)
        + 1;
    upsert_record(
        connection,
        "favorite_group",
        &id,
        None,
        &json!({ "groupId": id, "name": name, "sortOrder": sort_order, "createdAt": now_millis(), "updatedAt": now_millis() }),
    )?;
    snapshot(connection, "favorites")
}

fn rename_group(
    connection: &Connection,
    payload: &FeaturePayload,
) -> Result<FeatureSnapshot, FeatureError> {
    let id = required_id(payload)?;
    if id == DEFAULT_GROUP_ID {
        return Err(FeatureError::Invalid(
            "FAVORITE_DEFAULT_GROUP_PROTECTED".to_string(),
        ));
    }
    let mut value = record(connection, "favorite_group", &id)?
        .ok_or_else(|| FeatureError::Invalid("FAVORITE_GROUP_NOT_FOUND".to_string()))?;
    value["name"] = Value::String(required_string(&payload.value, "name")?);
    value["updatedAt"] = json!(now_millis());
    upsert_record(connection, "favorite_group", &id, None, &value)?;
    snapshot(connection, "favorites")
}

fn delete_group(
    connection: &Connection,
    payload: &FeaturePayload,
) -> Result<FeatureSnapshot, FeatureError> {
    let id = required_id(payload)?;
    if id == DEFAULT_GROUP_ID {
        return Err(FeatureError::Invalid(
            "FAVORITE_DEFAULT_GROUP_PROTECTED".to_string(),
        ));
    }
    let count = records(connection, "favorite")?
        .iter()
        .filter(|value| string(value, "groupId") == id)
        .count();
    let disposition = optional_string(&payload.value, "disposition");
    if count > 0 && disposition.is_none() {
        return Err(FeatureError::Invalid(
            "FAVORITE_GROUP_DISPOSITION_REQUIRED".to_string(),
        ));
    }
    for value in records(connection, "favorite")? {
        if string(&value, "groupId") != id {
            continue;
        }
        if disposition.as_deref() == Some("delete") {
            remove_record(connection, "favorite", &string(&value, "favoriteId"))?;
        } else {
            let mut moved = value;
            moved["groupId"] = json!(DEFAULT_GROUP_ID);
            upsert_record(
                connection,
                "favorite",
                &string(&moved, "favoriteId"),
                None,
                &moved,
            )?;
        }
    }
    remove_record(connection, "favorite_group", &id)?;
    snapshot(connection, "favorites")
}

fn reorder_groups(
    connection: &Connection,
    payload: &FeaturePayload,
) -> Result<FeatureSnapshot, FeatureError> {
    let ids = string_array(&payload.value, "groupIds")?;
    let known_ids = records(connection, "favorite_group")?
        .iter()
        .map(|value| string(value, "groupId"))
        .collect::<std::collections::BTreeSet<_>>();
    let unique_ids = ids
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    if ids.len() != unique_ids.len() || unique_ids != known_ids {
        return Err(FeatureError::Invalid(
            "FAVORITE_GROUP_SORT_INVALID".to_string(),
        ));
    }
    for (index, id) in ids.iter().enumerate() {
        let mut value = record(connection, "favorite_group", id)?
            .ok_or_else(|| FeatureError::Invalid("FAVORITE_GROUP_SORT_INVALID".to_string()))?;
        value["sortOrder"] = json!(index as i64);
        upsert_record(connection, "favorite_group", id, None, &value)?;
    }
    snapshot(connection, "favorites")
}

fn mark_follow(
    connection: &Connection,
    id: &str,
    watched: bool,
) -> Result<FeatureSnapshot, FeatureError> {
    let mut value = record(connection, "follow", id)?
        .ok_or_else(|| FeatureError::Invalid("FOLLOW_NOT_FOUND".to_string()))?;
    if watched {
        value["watchedEpisodeId"] = value.get("latestEpisodeId").cloned().unwrap_or(Value::Null);
        value["watchedEpisodeName"] = value
            .get("latestEpisodeName")
            .cloned()
            .unwrap_or(Value::Null);
        value["updateAvailable"] = json!(false);
    } else {
        value["updateAvailable"] = json!(
            value.get("latestEpisodeId").is_some_and(|v| !v.is_null())
                || value.get("latestEpisodeName").is_some_and(|v| !v.is_null())
        );
    }
    upsert_record(connection, "follow", id, None, &value)?;
    snapshot(connection, "follow")
}

fn ensure_default_group(connection: &Connection) -> Result<(), FeatureError> {
    if record(connection, "favorite_group", DEFAULT_GROUP_ID)?.is_some() {
        return Ok(());
    }
    let now = now_millis();
    upsert_record(
        connection,
        "favorite_group",
        DEFAULT_GROUP_ID,
        None,
        &json!({ "groupId": DEFAULT_GROUP_ID, "name": DEFAULT_GROUP_NAME, "sortOrder": 0, "createdAt": now, "updatedAt": now }),
    )
}

fn records(connection: &Connection, entity: &str) -> Result<Vec<Value>, FeatureError> {
    let snapshot =
        business_data::list_connection(connection, entity).map_err(map_business_error)?;
    Ok(snapshot
        .value
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
        .into_values()
        .collect())
}

fn record(connection: &Connection, entity: &str, id: &str) -> Result<Option<Value>, FeatureError> {
    Ok(business_data::read_connection(connection, entity, id)
        .map_err(map_business_error)?
        .value)
}

fn upsert_record(
    connection: &Connection,
    entity: &str,
    id: &str,
    source_id: Option<&str>,
    value: &Value,
) -> Result<(), FeatureError> {
    if id.trim().is_empty() {
        return Err(FeatureError::Invalid(
            "business feature id is required".to_string(),
        ));
    }
    business_data::upsert_connection(
        connection,
        &business_data::BusinessDataPayload {
            action: "upsert".to_string(),
            entity: entity.to_string(),
            id: id.to_string(),
            source_id: source_id.map(str::to_string),
            value: value.clone(),
        },
    )
    .map(|_| ())
    .map_err(map_business_error)
}

fn remove_record(connection: &Connection, entity: &str, id: &str) -> Result<(), FeatureError> {
    business_data::remove_connection(connection, entity, id)
        .map(|_| ())
        .map_err(map_business_error)
}

fn clear_records(connection: &Connection, entity: &str) -> Result<(), FeatureError> {
    for value in records(connection, entity)? {
        remove_record(connection, entity, &record_id(entity, &value))?;
    }
    Ok(())
}

fn record_id(entity: &str, value: &Value) -> String {
    let key = match entity {
        "history" => "identity",
        "favorite" => "favoriteId",
        "favorite_group" => "groupId",
        "follow" => "identity",
        _ => "id",
    };
    string(value, key)
}

fn normalize_feature(value: &str) -> Result<&str, FeatureError> {
    match value.trim() {
        "history" | "favorites" | "follow" => Ok(value.trim()),
        _ => Err(FeatureError::Invalid(format!(
            "unsupported business feature: {value}"
        ))),
    }
}

fn normalize_history_value(value: &Value) -> Result<Value, FeatureError> {
    let object = value
        .as_object()
        .ok_or_else(|| FeatureError::Invalid("HISTORY_RECORD_INVALID".to_string()))?;
    for key in ["identity", "sourceId", "vodId", "seasonId", "episodeId"] {
        if let Some(candidate) = object.get(key).and_then(Value::as_str) {
            if looks_like_temporary_url(candidate) {
                return Err(FeatureError::Invalid(
                    "HISTORY_ID_MUST_NOT_BE_MEDIA_URL".to_string(),
                ));
            }
        }
    }
    Ok(value.clone())
}

fn normalize_follow_value(value: &Value) -> Result<Value, FeatureError> {
    let mut value = value
        .as_object()
        .cloned()
        .map(Value::Object)
        .ok_or_else(|| FeatureError::Invalid("FOLLOW_RECORD_INVALID".to_string()))?;
    let Some(episodes) = value.get("episodes").and_then(Value::as_array).cloned() else {
        return Ok(value);
    };
    value["knownEpisodeCount"] = json!(episodes.len());
    if let Some(latest) = episodes.last().and_then(Value::as_object).cloned() {
        value["latestEpisodeId"] = latest.get("id").cloned().unwrap_or(Value::Null);
        value["latestEpisodeName"] = latest.get("name").cloned().unwrap_or(Value::Null);
    } else {
        value["latestEpisodeId"] = Value::Null;
        value["latestEpisodeName"] = Value::Null;
    }
    Ok(value)
}

fn looks_like_temporary_url(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with("file:")
        || value.starts_with("data:")
        || value.starts_with("blob:")
        || value.contains('?')
        || value.contains('#')
}

fn required_id(payload: &FeaturePayload) -> Result<String, FeatureError> {
    if payload.id.trim().is_empty() {
        return Err(FeatureError::Invalid(
            "business feature id is required".to_string(),
        ));
    }
    Ok(payload.id.clone())
}

fn required_string(value: &Value, key: &str) -> Result<String, FeatureError> {
    optional_string(value, key)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| FeatureError::Invalid(format!("{key} is required")))
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn string_array(value: &Value, key: &str) -> Result<Vec<String>, FeatureError> {
    value
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| FeatureError::Invalid(format!("{key} must be an array")))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| FeatureError::Invalid(format!("{key} contains an invalid id")))
        })
        .collect()
}

fn string_array_optional(value: &Value, key: &str) -> Result<Vec<String>, FeatureError> {
    if value.get(key).is_none() {
        return Ok(Vec::new());
    }
    string_array(value, key)
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

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn map_business_error(error: business_data::BusinessDataError) -> FeatureError {
    match error {
        business_data::BusinessDataError::Invalid(message) => FeatureError::Invalid(message),
        business_data::BusinessDataError::Storage(message) => FeatureError::Storage(message),
    }
}

#[cfg(test)]
mod tests {
    use super::{handle, FeaturePayload};
    use serde_json::{json, Value};
    use std::fs::remove_file;

    #[test]
    fn persists_history_favorites_and_follow_through_the_rust_feature_boundary() {
        let path = std::env::temp_dir().join(format!(
            "qx-business-features-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let history = FeaturePayload {
            action: "upsert".to_string(),
            feature: "history".to_string(),
            id: "history-1".to_string(),
            source_id: Some("source-1".to_string()),
            value: json!({ "identity": "history-1", "sourceId": "source-1", "vodId": "vod-1", "title": "Title", "position": 12, "updatedAt": 2 }),
        };
        handle(&path, &history).expect("history upsert");
        let snapshot = handle(
            &path,
            &FeaturePayload {
                action: "snapshot".to_string(),
                feature: "history".to_string(),
                id: String::new(),
                source_id: None,
                value: Value::Null,
            },
        )
        .expect("history snapshot");
        assert_eq!(snapshot.state["history"]["items"][0]["position"], 12);

        let favorite = FeaturePayload {
            action: "toggle".to_string(),
            feature: "favorites".to_string(),
            id: "favorite-1".to_string(),
            source_id: None,
            value: json!({ "sourceId": "source-1", "vodId": "vod-1", "title": "Title" }),
        };
        handle(&path, &favorite).expect("favorite toggle");
        let favorite_snapshot = handle(
            &path,
            &FeaturePayload {
                action: "snapshot".to_string(),
                feature: "favorites".to_string(),
                id: String::new(),
                source_id: None,
                value: Value::Null,
            },
        )
        .expect("favorite snapshot");
        assert_eq!(
            favorite_snapshot.state["favorites"]["items"]
                .as_array()
                .map(Vec::len),
            Some(1)
        );
        let invalid_move = FeaturePayload {
            action: "move".to_string(),
            feature: "favorites".to_string(),
            id: "favorite-1".to_string(),
            source_id: None,
            value: json!({ "groupId": "missing" }),
        };
        assert!(format!(
            "{:?}",
            handle(&path, &invalid_move).expect_err("missing group")
        )
        .contains("FAVORITE_GROUP_NOT_FOUND"));

        let follow = FeaturePayload {
            action: "upsert".to_string(),
            feature: "follow".to_string(),
            id: "follow-1".to_string(),
            source_id: Some("source-1".to_string()),
            value: json!({ "identity": "follow-1", "sourceId": "source-1", "vodId": "vod-1", "title": "Title", "episodes": [{ "id": "episode-1", "name": "Episode 1" }], "updateAvailable": true }),
        };
        handle(&path, &follow).expect("follow upsert");
        let follow_snapshot = handle(
            &path,
            &FeaturePayload {
                action: "snapshot".to_string(),
                feature: "follow".to_string(),
                id: String::new(),
                source_id: None,
                value: Value::Null,
            },
        )
        .expect("follow snapshot");
        assert_eq!(follow_snapshot.state["follow"]["updateCount"], 1);
        assert_eq!(
            follow_snapshot.state["follow"]["items"][0]["latestEpisodeId"],
            "episode-1"
        );
        let invalid_history = FeaturePayload {
            action: "upsert".to_string(),
            feature: "history".to_string(),
            id: "history-url".to_string(),
            source_id: None,
            value: json!({ "identity": "https://media.example.test/episode.m3u8", "vodId": "vod-1", "episodeId": "episode-1" }),
        };
        assert!(format!(
            "{:?}",
            handle(&path, &invalid_history).expect_err("media URL identity")
        )
        .contains("HISTORY_ID_MUST_NOT_BE_MEDIA_URL"));
        let clear_selected = FeaturePayload {
            action: "clear".to_string(),
            feature: "history".to_string(),
            id: String::new(),
            source_id: None,
            value: json!({ "identities": ["history-1"] }),
        };
        let cleared = handle(&path, &clear_selected).expect("clear selected history");
        assert_eq!(
            cleared.state["history"]["items"].as_array().map(Vec::len),
            Some(0)
        );
        let _ = rusqlite::Connection::open(&path).expect("database remains readable");
        let _ = remove_file(path);
    }
}
