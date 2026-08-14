use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessDataPayload {
    pub action: String,
    pub entity: String,
    pub id: String,
    pub source_id: Option<String>,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BusinessDataSnapshot {
    pub schema_version: String,
    pub entity: String,
    pub id: String,
    pub found: bool,
    pub value: Option<Value>,
    pub record_count: usize,
}

#[derive(Debug)]
pub enum BusinessDataError {
    Invalid(String),
    Storage(String),
}

pub fn upsert(
    path: &Path,
    payload: &BusinessDataPayload,
) -> Result<BusinessDataSnapshot, BusinessDataError> {
    let connection =
        Connection::open(path).map_err(|error| BusinessDataError::Storage(error.to_string()))?;
    ensure_schema(&connection)?;
    upsert_connection(&connection, payload)
}

pub fn read(
    path: &Path,
    entity: &str,
    id: &str,
) -> Result<BusinessDataSnapshot, BusinessDataError> {
    let connection =
        Connection::open(path).map_err(|error| BusinessDataError::Storage(error.to_string()))?;
    ensure_schema(&connection)?;
    read_connection(&connection, entity, id)
}

pub fn backup(path: &Path) -> Result<BusinessDataSnapshot, BusinessDataError> {
    let connection =
        Connection::open(path).map_err(|error| BusinessDataError::Storage(error.to_string()))?;
    ensure_schema(&connection)?;
    backup_connection(&connection)
}

pub fn remove(
    path: &Path,
    entity: &str,
    id: &str,
) -> Result<BusinessDataSnapshot, BusinessDataError> {
    let connection =
        Connection::open(path).map_err(|error| BusinessDataError::Storage(error.to_string()))?;
    ensure_schema(&connection)?;
    remove_connection(&connection, entity, id)
}

pub fn list(path: &Path, entity: &str) -> Result<BusinessDataSnapshot, BusinessDataError> {
    let connection =
        Connection::open(path).map_err(|error| BusinessDataError::Storage(error.to_string()))?;
    ensure_schema(&connection)?;
    list_connection(&connection, entity)
}

pub fn restore(path: &Path, value: &Value) -> Result<BusinessDataSnapshot, BusinessDataError> {
    let connection =
        Connection::open(path).map_err(|error| BusinessDataError::Storage(error.to_string()))?;
    ensure_schema(&connection)?;
    restore_connection(&connection, value)
}

pub fn upsert_connection(
    connection: &Connection,
    payload: &BusinessDataPayload,
) -> Result<BusinessDataSnapshot, BusinessDataError> {
    ensure_schema(connection)?;
    validate_key(&payload.entity, "entity")?;
    validate_key(&payload.id, "id")?;
    if payload.action != "upsert" {
        return Err(BusinessDataError::Invalid(
            "business data action must be upsert".to_string(),
        ));
    }
    validate_business_value(&payload.entity, &payload.value)?;
    let value = sanitize_value(payload.value.clone());
    let serialized = serde_json::to_string(&value)
        .map_err(|error| BusinessDataError::Invalid(error.to_string()))?;
    connection
        .execute(
            "INSERT INTO business_records(entity, record_id, source_id, value_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, strftime('%s','now') * 1000)
             ON CONFLICT(entity, record_id) DO UPDATE SET
               source_id = excluded.source_id,
               value_json = excluded.value_json,
               updated_at = excluded.updated_at",
            params![payload.entity, payload.id, payload.source_id, serialized],
        )
        .map_err(|error| BusinessDataError::Storage(error.to_string()))?;
    read_connection(connection, &payload.entity, &payload.id)
}

pub fn read_connection(
    connection: &Connection,
    entity: &str,
    id: &str,
) -> Result<BusinessDataSnapshot, BusinessDataError> {
    ensure_schema(connection)?;
    validate_key(entity, "entity")?;
    validate_key(id, "id")?;
    let value = connection
        .query_row(
            "SELECT value_json FROM business_records WHERE entity = ?1 AND record_id = ?2",
            params![entity, id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| BusinessDataError::Storage(error.to_string()))?
        .map(|serialized| {
            serde_json::from_str(&serialized)
                .map_err(|error| BusinessDataError::Storage(error.to_string()))
        })
        .transpose()?;
    Ok(BusinessDataSnapshot {
        schema_version: "v1".to_string(),
        entity: entity.to_string(),
        id: id.to_string(),
        found: value.is_some(),
        record_count: usize::from(value.is_some()),
        value,
    })
}

pub fn backup_connection(
    connection: &Connection,
) -> Result<BusinessDataSnapshot, BusinessDataError> {
    ensure_schema(connection)?;
    let mut statement = connection
        .prepare(
            "SELECT entity, record_id, value_json
             FROM business_records ORDER BY entity, record_id",
        )
        .map_err(|error| BusinessDataError::Storage(error.to_string()))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| BusinessDataError::Storage(error.to_string()))?;
    let mut backup = serde_json::Map::new();
    for row in rows {
        let (entity, id, serialized) =
            row.map_err(|error| BusinessDataError::Storage(error.to_string()))?;
        let value: Value = serde_json::from_str(&serialized)
            .map_err(|error| BusinessDataError::Storage(error.to_string()))?;
        backup.insert(format!("{entity}/{id}"), value);
    }
    Ok(BusinessDataSnapshot {
        schema_version: "v1".to_string(),
        entity: "backup".to_string(),
        id: "v1".to_string(),
        found: true,
        record_count: backup.len(),
        value: Some(Value::Object(backup)),
    })
}

pub fn remove_connection(
    connection: &Connection,
    entity: &str,
    id: &str,
) -> Result<BusinessDataSnapshot, BusinessDataError> {
    ensure_schema(connection)?;
    validate_key(entity, "entity")?;
    validate_key(id, "id")?;
    let removed = connection
        .execute(
            "DELETE FROM business_records WHERE entity = ?1 AND record_id = ?2",
            params![entity, id],
        )
        .map_err(|error| BusinessDataError::Storage(error.to_string()))?;
    Ok(BusinessDataSnapshot {
        schema_version: "v1".to_string(),
        entity: entity.to_string(),
        id: id.to_string(),
        found: removed > 0,
        value: None,
        record_count: usize::from(removed > 0),
    })
}

pub fn list_connection(
    connection: &Connection,
    entity: &str,
) -> Result<BusinessDataSnapshot, BusinessDataError> {
    ensure_schema(connection)?;
    validate_key(entity, "entity")?;
    let mut statement = connection
        .prepare(
            "SELECT record_id, value_json FROM business_records
             WHERE entity = ?1 ORDER BY record_id",
        )
        .map_err(|error| BusinessDataError::Storage(error.to_string()))?;
    let rows = statement
        .query_map(params![entity], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| BusinessDataError::Storage(error.to_string()))?;
    let mut records = serde_json::Map::new();
    for row in rows {
        let (id, serialized) =
            row.map_err(|error| BusinessDataError::Storage(error.to_string()))?;
        let value = serde_json::from_str(&serialized)
            .map_err(|error| BusinessDataError::Storage(error.to_string()))?;
        records.insert(id, value);
    }
    let record_count = records.len();
    Ok(BusinessDataSnapshot {
        schema_version: "v1".to_string(),
        entity: entity.to_string(),
        id: "list".to_string(),
        found: record_count > 0,
        value: Some(Value::Object(records)),
        record_count,
    })
}

pub fn restore_connection(
    connection: &Connection,
    value: &Value,
) -> Result<BusinessDataSnapshot, BusinessDataError> {
    let entries = value.as_object().ok_or_else(|| {
        BusinessDataError::Invalid("business backup must be a JSON object".to_string())
    })?;
    let mut restored = 0;
    for (key, value) in entries {
        let Some((entity, id)) = key.split_once('/') else {
            return Err(BusinessDataError::Invalid(
                "business backup record key must be entity/id".to_string(),
            ));
        };
        validate_business_value(entity, value)?;
        let sanitized = sanitize_value(value.clone());
        let serialized = serde_json::to_string(&sanitized)
            .map_err(|error| BusinessDataError::Invalid(error.to_string()))?;
        validate_key(entity, "entity")?;
        validate_key(id, "id")?;
        connection
            .execute(
                "INSERT INTO business_records(entity, record_id, source_id, value_json, updated_at)
                 VALUES (?1, ?2, NULL, ?3, strftime('%s','now') * 1000)
                 ON CONFLICT(entity, record_id) DO UPDATE SET
                   value_json = excluded.value_json,
                   updated_at = excluded.updated_at",
                params![entity, id, serialized],
            )
            .map_err(|error| BusinessDataError::Storage(error.to_string()))?;
        restored += 1;
    }
    Ok(BusinessDataSnapshot {
        schema_version: "v1".to_string(),
        entity: "backup".to_string(),
        id: "restore".to_string(),
        found: restored > 0,
        value: None,
        record_count: restored,
    })
}

pub fn ensure_schema(connection: &Connection) -> Result<(), BusinessDataError> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS business_records (
               entity TEXT NOT NULL,
               record_id TEXT NOT NULL,
               source_id TEXT,
               value_json TEXT NOT NULL,
               updated_at INTEGER NOT NULL,
               PRIMARY KEY(entity, record_id)
             );
             CREATE INDEX IF NOT EXISTS idx_business_records_source
               ON business_records(source_id, updated_at DESC);",
        )
        .map_err(|error| BusinessDataError::Storage(error.to_string()))
}

fn validate_key(value: &str, label: &str) -> Result<(), BusinessDataError> {
    if value.trim().is_empty() || value.len() > 256 {
        return Err(BusinessDataError::Invalid(format!(
            "{label} is empty or too long"
        )));
    }
    Ok(())
}

fn sanitize_value(value: Value) -> Value {
    match value {
        Value::Object(entries) => Value::Object(
            entries
                .into_iter()
                .filter_map(|(key, value)| {
                    let lower = key.to_ascii_lowercase();
                    if lower.contains("token")
                        || lower.contains("cookie")
                        || lower == "authorization"
                        || lower.contains("tempurl")
                        || lower.contains("temporaryurl")
                        || lower.contains("temporary_url")
                    {
                        None
                    } else {
                        Some((key, sanitize_value(value)))
                    }
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(sanitize_value).collect()),
        other => other,
    }
}

fn validate_business_value(entity: &str, value: &Value) -> Result<(), BusinessDataError> {
    let lower = entity.to_ascii_lowercase();
    if lower == "download" {
        let has_forbidden_url = value.as_object().is_some_and(|entries| {
            entries.keys().any(|key| {
                matches!(
                    key.to_ascii_lowercase().as_str(),
                    "url" | "downloadurl" | "requesturl" | "playbackurl"
                )
            })
        });
        if has_forbidden_url {
            return Err(BusinessDataError::Invalid(
                "download records must use an opaque requestReference".to_string(),
            ));
        }
        let reference = value
            .as_object()
            .and_then(|entries| {
                entries.iter().find_map(|(key, value)| {
                    (key.eq_ignore_ascii_case("requestReference"))
                        .then(|| value.as_str())
                        .flatten()
                })
            })
            .ok_or_else(|| {
                BusinessDataError::Invalid(
                    "download records must use an opaque requestReference".to_string(),
                )
            })?;
        if reference.trim().is_empty() {
            return Err(BusinessDataError::Invalid(
                "download requestReference must not be empty".to_string(),
            ));
        }
        let normalized = reference.to_ascii_lowercase();
        if normalized.starts_with("bt:")
            || normalized.starts_with("magnet:")
            || normalized.contains("p2p")
            || normalized.ends_with(".m3u8")
            || normalized.ends_with(".mpd")
        {
            return Err(BusinessDataError::Invalid(
                "download requestReference is not an allowed HTTP download reference".to_string(),
            ));
        }
    }
    if lower == "local_media" {
        if let Some(path) = value.as_object().and_then(|entries| {
            entries.iter().find_map(|(key, value)| {
                (key.eq_ignore_ascii_case("path"))
                    .then(|| value.as_str())
                    .flatten()
            })
        }) {
            if std::path::Path::new(path).is_absolute()
                || path.contains("..\\")
                || path.contains("../")
            {
                return Err(BusinessDataError::Invalid(
                    "local media must use an authorized opaque item reference".to_string(),
                ));
            }
        }
    }
    if lower == "player_session" {
        let has_media_url = value.as_object().is_some_and(|entries| {
            entries.keys().any(|key| {
                matches!(
                    key.to_ascii_lowercase().as_str(),
                    "url" | "playbackurl" | "proxyurl" | "sourceurl"
                )
            })
        });
        if has_media_url {
            return Err(BusinessDataError::Invalid(
                "player sessions must not persist media URLs".to_string(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        backup_connection, list_connection, read, read_connection, remove_connection,
        restore_connection, upsert, upsert_connection, BusinessDataPayload,
    };
    use rusqlite::Connection;
    use serde_json::json;

    #[test]
    fn persists_business_data_and_removes_credentials_and_temporary_urls() {
        let connection = Connection::open_in_memory().expect("database");
        let result = upsert_connection(
            &connection,
            &BusinessDataPayload {
                action: "upsert".to_string(),
                entity: "history".to_string(),
                id: "history-1".to_string(),
                source_id: Some("source-1".to_string()),
                value: json!({
                    "title": "Movie",
                    "position": 12,
                    "Authorization": "Bearer secret",
                    "Cookie": "sid=secret",
                    "token": "secret",
                    "temporaryUrl": "https://temporary.invalid/one"
                }),
            },
        )
        .expect("upsert");
        assert!(result.found);
        assert_eq!(
            result.value.as_ref().and_then(|value| value.get("title")),
            Some(&json!("Movie"))
        );
        assert!(result
            .value
            .as_ref()
            .and_then(|value| value.get("token"))
            .is_none());
        let loaded = read_connection(&connection, "history", "history-1").expect("read");
        assert_eq!(
            loaded
                .value
                .as_ref()
                .and_then(|value| value.get("position")),
            Some(&json!(12))
        );
        let backup = backup_connection(&connection).expect("backup");
        let serialized = serde_json::to_string(&backup.value).expect("backup JSON");
        assert!(serialized.contains("Movie"));
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("temporary.invalid"));
        let list = list_connection(&connection, "history").expect("list");
        assert_eq!(list.record_count, 1);
        let removed = remove_connection(&connection, "history", "history-1").expect("remove");
        assert!(removed.found);
        let restored = restore_connection(
            &connection,
            &json!({ "history/history-1": { "title": "Restored" } }),
        )
        .expect("restore");
        assert_eq!(restored.record_count, 1);
        let invalid_download = upsert_connection(
            &connection,
            &BusinessDataPayload {
                action: "upsert".to_string(),
                entity: "download".to_string(),
                id: "download-1".to_string(),
                source_id: None,
                value: json!({ "url": "magnet:?xt=urn:btih:fixture" }),
            },
        )
        .expect_err("P2P download rejected");
        assert!(format!("{invalid_download:?}").contains("opaque requestReference"));
    }

    #[test]
    fn reopens_business_database_and_keeps_data_roots_isolated() {
        let root =
            std::env::temp_dir().join(format!("qx-business-restart-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("test root");
        let first = root.join("first.sqlite3");
        let second = root.join("second.sqlite3");
        upsert(
            &first,
            &BusinessDataPayload {
                action: "upsert".to_string(),
                entity: "history".to_string(),
                id: "restart-1".to_string(),
                source_id: Some("source-1".to_string()),
                value: json!({ "title": "restart" }),
            },
        )
        .expect("first root upsert");

        let reopened = read(&first, "history", "restart-1").expect("reopen first root");
        assert!(reopened.found);
        assert_eq!(reopened.value.unwrap()["title"], "restart");
        let isolated = read(&second, "history", "restart-1").expect("open second root");
        assert!(!isolated.found);

        let _ = std::fs::remove_dir_all(root);
    }
}
