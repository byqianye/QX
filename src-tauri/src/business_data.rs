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
        value: Some(Value::Object(backup)),
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

#[cfg(test)]
mod tests {
    use super::{backup_connection, read_connection, upsert_connection, BusinessDataPayload};
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
    }
}
