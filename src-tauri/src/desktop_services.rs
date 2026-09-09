use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use reqwest::blocking::Client;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::business_data;

const MAX_LOCAL_FILES: usize = 10_000;
const MAX_LOCAL_DEPTH: usize = 8;
const MAX_DOWNLOAD_BYTES: usize = 2 * 1024 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_CACHE_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const IMAGE_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopServicePayload {
    pub action: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug)]
pub enum DesktopServiceError {
    Invalid(String),
    Storage(String),
}

pub fn handle(
    data_root: &Path,
    database_path: &Path,
    payload: &DesktopServicePayload,
) -> Result<Value, DesktopServiceError> {
    let connection = Connection::open(database_path)
        .map_err(|error| DesktopServiceError::Storage(error.to_string()))?;
    business_data::ensure_schema(&connection).map_err(map_business_error)?;
    match payload.action.as_str() {
        "cache-image" => cache_image(data_root, &connection, &payload.value)
            .and_then(|image| snapshot_with_cache_image(data_root, database_path, image)),
        "cache-snapshot" => snapshot_all(data_root, database_path),
        "cache-refresh" => {
            prune_cache(data_root, &connection, MAX_CACHE_BYTES)?;
            snapshot_all(data_root, database_path)
        }
        "cache-clear" => {
            clear_cache(
                data_root,
                &connection,
                payload.value.get("scope").and_then(Value::as_str),
            )?;
            snapshot_all(data_root, database_path)
        }
        "storage-refresh" => snapshot_all(data_root, database_path),
        "storage-open" => {
            open_directory(data_root)?;
            snapshot_all(data_root, database_path)
        }
        "storage-switch" => {
            let mode = payload
                .value
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("normal");
            if mode != "normal" {
                return Err(DesktopServiceError::Invalid(
                    "STORAGE_MODE_UNSUPPORTED".to_string(),
                ));
            }
            snapshot_all(data_root, database_path)
        }
        "backup-create" => backup_create(
            data_root,
            &connection,
            payload
                .value
                .get("includeCache")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
        "backup-pick" => backup_pick(data_root),
        "backup-apply" => backup_apply(data_root, &connection),
        "backup-clear" => backup_clear(data_root),
        "backup-open" => {
            open_directory(&data_root.join("backups"))?;
            backup_pick(data_root)
        }
        "danmaku-snapshot" | "danmaku-load" | "danmaku-settings" | "danmaku-clear"
        | "danmaku-sync" => handle_danmaku(&connection, payload),
        "player-fallback-snapshot"
        | "player-fallback-mode"
        | "player-fallback-approve"
        | "player-fallback-cancel"
        | "player-sync" => handle_fallback(&connection, payload),
        "local-snapshot"
        | "local-rescan"
        | "local-cancel-scan"
        | "local-active"
        | "local-remove-folder"
        | "local-remove-item"
        | "local-locate"
        | "local-open-file"
        | "local-add-folder"
        | "local-drop"
        | "local-play" => handle_local(&connection, payload),
        "download-snapshot"
        | "download-refresh"
        | "download-select-folder"
        | "download-add"
        | "download-pause"
        | "download-resume"
        | "download-cancel"
        | "download-retry"
        | "download-remove"
        | "download-open-folder" => handle_download(&connection, payload),
        _ => Err(DesktopServiceError::Invalid(format!(
            "DESKTOP_ACTION_UNSUPPORTED:{}",
            payload.action
        ))),
    }
}

pub async fn handle_async(
    data_root: PathBuf,
    database_path: PathBuf,
    payload: DesktopServicePayload,
) -> Result<Value, DesktopServiceError> {
    tokio::task::spawn_blocking(move || handle(&data_root, &database_path, &payload))
        .await
        .map_err(|_| DesktopServiceError::Storage("DESKTOP_WORKER_FAILED".to_string()))?
}

fn snapshot_all(data_root: &Path, database_path: &Path) -> Result<Value, DesktopServiceError> {
    let connection = Connection::open(database_path)
        .map_err(|error| DesktopServiceError::Storage(error.to_string()))?;
    business_data::ensure_schema(&connection).map_err(map_business_error)?;
    Ok(json!({
        "cache": cache_snapshot(data_root, &connection)?,
        "storage": storage_snapshot(data_root, database_path, &connection)?,
        "backup": backup_preview(data_root)?,
        "localMedia": local_snapshot(&connection)?,
        "downloads": download_snapshot(&connection)?,
        "danmaku": danmaku_snapshot(&connection)?,
        "fallback": fallback_snapshot(&connection)?,
    }))
}

fn snapshot_with_cache_image(
    data_root: &Path,
    database_path: &Path,
    image: Value,
) -> Result<Value, DesktopServiceError> {
    let mut snapshot = snapshot_all(data_root, database_path)?;
    if let Some(object) = snapshot.as_object_mut() {
        if let Some(image_object) = image.as_object() {
            for (key, value) in image_object {
                object.insert(key.clone(), value.clone());
            }
        }
    }
    Ok(snapshot)
}

fn cache_image(
    data_root: &Path,
    connection: &Connection,
    value: &Value,
) -> Result<Value, DesktopServiceError> {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("poster")
        .trim()
        .to_ascii_lowercase();
    if !matches!(kind.as_str(), "poster" | "backdrop") {
        return Ok(image_placeholder("CACHE_IMAGE_TYPE_INVALID"));
    }
    let url = value
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if url.is_empty() {
        return Ok(image_placeholder("CACHE_IMAGE_DOWNLOAD_FAILED"));
    }
    let parsed = match reqwest::Url::parse(&url) {
        Ok(parsed) if matches!(parsed.scheme(), "http" | "https") => parsed,
        _ => return Ok(image_placeholder("CACHE_IMAGE_DOWNLOAD_FAILED")),
    };
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some_and(sensitive_query)
    {
        return Ok(image_placeholder("CACHE_IMAGE_DOWNLOAD_FAILED"));
    }

    let key = value
        .get("key")
        .and_then(Value::as_str)
        .filter(|key| !key.trim().is_empty())
        .unwrap_or(&url);
    let key_digest = sha256_hex(key.as_bytes());
    if let Some(existing) = records(connection, "cache_entry")?
        .into_iter()
        .find(|entry| string(entry, "type") == kind && string(entry, "keyDigest") == key_digest)
    {
        let expired = existing
            .get("expiresAt")
            .and_then(Value::as_i64)
            .is_some_and(|expires_at| expires_at <= now_millis());
        if !expired {
            if let Some(path) = cache_entry_path(data_root, &existing) {
                if let Ok(bytes) = fs::read(&path) {
                    if let Some(mime) = image_signature(&bytes) {
                        let mut refreshed = existing.clone();
                        refreshed["accessedAt"] = json!(now_millis());
                        upsert(
                            connection,
                            "cache_entry",
                            &string(&existing, "id"),
                            &refreshed,
                        )?;
                        return Ok(image_result(&kind, true, &path, &bytes, &mime, &refreshed));
                    }
                }
            }
        }
        remove_cache_entry_file(data_root, &existing);
        remove(connection, "cache_entry", &string(&existing, "id"))?;
    }

    let mut client_builder = Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none());
    if parsed.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<IpAddr>()
                .map(|address| address.is_loopback())
                .unwrap_or(false)
    }) {
        client_builder = client_builder.no_proxy();
    }
    let response = match client_builder
        .build()
        .and_then(|client| client.get(parsed).send())
    {
        Ok(response) if response.status().is_success() => response,
        _ => return Ok(image_placeholder("CACHE_IMAGE_DOWNLOAD_FAILED")),
    };
    if response
        .content_length()
        .is_some_and(|size| size > MAX_CACHE_IMAGE_BYTES as u64)
    {
        return Ok(image_placeholder("CACHE_IMAGE_TOO_LARGE"));
    }
    let declared_mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|value| !value.is_empty());
    if declared_mime
        .as_deref()
        .is_some_and(|mime| !mime.starts_with("image/"))
    {
        return Ok(image_placeholder("CACHE_IMAGE_MIME_INVALID"));
    }
    let mut bytes = Vec::new();
    let mut limited = response.take((MAX_CACHE_IMAGE_BYTES + 1) as u64);
    if limited.read_to_end(&mut bytes).is_err() {
        return Ok(image_placeholder("CACHE_IMAGE_DOWNLOAD_FAILED"));
    }
    if bytes.len() > MAX_CACHE_IMAGE_BYTES {
        return Ok(image_placeholder("CACHE_IMAGE_TOO_LARGE"));
    }
    let Some(detected_mime) = image_signature(&bytes) else {
        return Ok(image_placeholder("CACHE_IMAGE_DECODE_FAILED"));
    };
    if declared_mime
        .as_deref()
        .is_some_and(|mime| mime != detected_mime)
    {
        return Ok(image_placeholder("CACHE_IMAGE_MIME_MISMATCH"));
    }

    let content_hash = sha256_hex(&bytes);
    let extension = image_extension(detected_mime);
    let relative_path = format!("cache/{kind}/{key_digest}-{content_hash}.{extension}");
    let path = data_root.join(&relative_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| DesktopServiceError::Storage(error.to_string()))?;
    }
    let temporary = path.with_extension(format!("{extension}.{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, &bytes)
        .map_err(|error| DesktopServiceError::Storage(error.to_string()))?;
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(DesktopServiceError::Storage(error.to_string()));
    }
    let created_at = now_millis();
    let id = format!("cache-image-{kind}-{key_digest}");
    let entry = json!({
        "id": id,
        "type": kind,
        "keyDigest": key_digest,
        "path": relative_path,
        "bytes": bytes.len(),
        "mime": detected_mime,
        "contentHash": content_hash,
        "sourceId": value.get("sourceId").cloned().unwrap_or(Value::Null),
        "createdAt": created_at,
        "accessedAt": created_at,
        "expiresAt": created_at + IMAGE_TTL_MS,
    });
    upsert(connection, "cache_entry", &id, &entry)?;
    prune_cache(data_root, connection, MAX_CACHE_BYTES)?;
    Ok(image_result(
        &kind,
        false,
        &path,
        &bytes,
        detected_mime,
        &entry,
    ))
}

fn image_placeholder(error_code: &str) -> Value {
    json!({
        "status": "placeholder",
        "hit": false,
        "assetUrl": Value::Null,
        "errorCode": error_code,
    })
}

fn image_result(
    kind: &str,
    hit: bool,
    path: &Path,
    bytes: &[u8],
    mime: &str,
    entry: &Value,
) -> Value {
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    json!({
        "status": "stored",
        "type": kind,
        "hit": hit,
        "assetUrl": format!("data:{mime};base64,{encoded}"),
        "path": path.to_string_lossy(),
        "errorCode": Value::Null,
        "record": entry,
    })
}

fn image_signature(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn image_extension(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "bin",
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn cache_entry_path(data_root: &Path, entry: &Value) -> Option<PathBuf> {
    let relative = entry.get("path").and_then(Value::as_str)?;
    let root = fs::canonicalize(data_root).ok()?;
    let path = data_root.join(relative);
    let canonical = fs::canonicalize(&path).ok()?;
    canonical
        .starts_with(root.join("cache"))
        .then_some(canonical)
}

fn cache_entry_file_size(data_root: &Path, entry: &Value) -> Option<u64> {
    let path = cache_entry_path(data_root, entry)?;
    fs::metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
}

fn remove_cache_entry_file(data_root: &Path, entry: &Value) {
    if let Some(path) = cache_entry_path(data_root, entry) {
        let _ = fs::remove_file(path);
    }
}

fn prune_cache(
    data_root: &Path,
    connection: &Connection,
    max_bytes: u64,
) -> Result<(), DesktopServiceError> {
    let now = now_millis();
    let mut retained = Vec::new();
    for entry in records(connection, "cache_entry")? {
        let id = string(&entry, "id");
        let Some(size) = cache_entry_file_size(data_root, &entry) else {
            remove(connection, "cache_entry", &id)?;
            continue;
        };
        let expired = entry
            .get("expiresAt")
            .and_then(Value::as_i64)
            .is_some_and(|expires_at| expires_at <= now);
        if expired {
            remove_cache_entry_file(data_root, &entry);
            remove(connection, "cache_entry", &id)?;
        } else {
            retained.push((entry, size));
        }
    }

    let mut total_bytes = retained.iter().map(|(_, size)| *size).sum::<u64>();
    retained.sort_by(|(left, _), (right, _)| {
        number(left, "accessedAt")
            .cmp(&number(right, "accessedAt"))
            .then(number(left, "createdAt").cmp(&number(right, "createdAt")))
            .then(string(left, "id").cmp(&string(right, "id")))
    });
    for (entry, size) in retained {
        if total_bytes <= max_bytes {
            break;
        }
        remove_cache_entry_file(data_root, &entry);
        remove(connection, "cache_entry", &string(&entry, "id"))?;
        total_bytes = total_bytes.saturating_sub(size);
    }
    Ok(())
}

fn cache_snapshot(data_root: &Path, connection: &Connection) -> Result<Value, DesktopServiceError> {
    let mut by_type: BTreeMap<String, (usize, u64)> = BTreeMap::new();
    for entry in records(connection, "cache_entry")? {
        let kind = string(&entry, "type");
        let Some(size) = cache_entry_file_size(data_root, &entry) else {
            continue;
        };
        let current = by_type.entry(kind).or_default();
        current.0 += 1;
        current.1 += size;
    }
    let entries = by_type.values().map(|value| value.0).sum::<usize>();
    let total_bytes = by_type.values().map(|value| value.1).sum::<u64>();
    Ok(json!({
        "totalBytes": total_bytes,
        "maxBytes": MAX_CACHE_BYTES,
        "entries": entries,
        "byType": by_type.into_iter().map(|(kind, (count, bytes))| json!({"type": kind, "count": count, "bytes": bytes})).collect::<Vec<_>>(),
    }))
}

fn clear_cache(
    data_root: &Path,
    connection: &Connection,
    scope: Option<&str>,
) -> Result<(), DesktopServiceError> {
    let scope = scope
        .ok_or_else(|| DesktopServiceError::Invalid("CACHE_CLEAR_SCOPE_INVALID".to_string()))?;
    if !matches!(scope, "expired" | "images" | "search" | "all") {
        return Err(DesktopServiceError::Invalid(
            "CACHE_CLEAR_SCOPE_INVALID".to_string(),
        ));
    }
    for entry in records(connection, "cache_entry")? {
        let kind = string(&entry, "type");
        let should_remove = match scope {
            "all" => true,
            "images" => matches!(kind.as_str(), "poster" | "backdrop"),
            "search" => matches!(kind.as_str(), "home" | "category" | "search" | "detail"),
            "expired" => entry
                .get("expiresAt")
                .and_then(Value::as_i64)
                .is_some_and(|value| value <= now_millis()),
            _ => false,
        };
        if should_remove {
            remove_cache_entry_file(data_root, &entry);
            remove(connection, "cache_entry", &string(&entry, "id"))?;
        }
    }
    Ok(())
}

fn storage_snapshot(
    data_root: &Path,
    database_path: &Path,
    connection: &Connection,
) -> Result<Value, DesktopServiceError> {
    let database_bytes = fs::metadata(database_path)
        .map(|value| value.len())
        .unwrap_or(0);
    let cache_bytes = cache_snapshot(data_root, connection)?["totalBytes"]
        .as_u64()
        .unwrap_or(0);
    let history = records(connection, "history")?.len();
    let favorites = records(connection, "favorite")?.len();
    let follow = records(connection, "follow")?.len();
    Ok(json!({
        "mode": "normal", "dataRoot": data_root.to_string_lossy(), "normalRoot": data_root.to_string_lossy(), "portableRoot": "",
        "databaseBytes": database_bytes, "cacheBytes": cache_bytes, "totalBytes": database_bytes + cache_bytes,
        "historyCount": history, "favoritesCount": favorites, "followCount": follow, "writable": is_writable(data_root), "switching": false, "error": Value::Null,
    }))
}

fn backup_path(data_root: &Path) -> PathBuf {
    data_root.join("backups").join("qx-backup-v1.json")
}

fn backup_create(
    data_root: &Path,
    connection: &Connection,
    include_cache: bool,
) -> Result<Value, DesktopServiceError> {
    let mut records_to_backup = Map::new();
    for (entity, id, value) in all_records(connection)? {
        if entity == "local_media_path"
            || entity == "download_request"
            || entity == "download_target"
            || (!include_cache && entity == "cache_entry")
        {
            continue;
        }
        records_to_backup.insert(format!("{entity}/{id}"), value);
    }
    let created_at = now_millis();
    let payload = json!({
        "formatVersion": 1, "appVersion": "0.9.0-rc.1", "createdAt": created_at,
        "databaseSchemaVersion": 1, "includeCache": include_cache, "records": records_to_backup,
    });
    let path = backup_path(data_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| DesktopServiceError::Storage(error.to_string()))?;
    }
    let serialized = serde_json::to_vec_pretty(&payload)
        .map_err(|error| DesktopServiceError::Storage(error.to_string()))?;
    fs::write(&path, &serialized)
        .map_err(|error| DesktopServiceError::Storage(error.to_string()))?;
    backup_ui(
        &payload,
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("qx-backup-v1.json"),
        serialized.len(),
    )
}

fn backup_pick(data_root: &Path) -> Result<Value, DesktopServiceError> {
    let path = backup_path(data_root);
    if !path.exists() {
        return Ok(
            json!({"backup": {"status":"idle", "lastBackup":null, "preview":null, "error":null}}),
        );
    }
    let bytes = fs::read(&path).map_err(|error| DesktopServiceError::Storage(error.to_string()))?;
    let payload: Value = serde_json::from_slice(&bytes)
        .map_err(|error| DesktopServiceError::Invalid(format!("BACKUP_INVALID:{error}")))?;
    backup_ui(
        &payload,
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("qx-backup-v1.json"),
        bytes.len(),
    )
}

fn backup_apply(data_root: &Path, connection: &Connection) -> Result<Value, DesktopServiceError> {
    let path = backup_path(data_root);
    let bytes = fs::read(&path)
        .map_err(|_| DesktopServiceError::Invalid("BACKUP_NOT_FOUND".to_string()))?;
    let payload: Value = serde_json::from_slice(&bytes)
        .map_err(|error| DesktopServiceError::Invalid(format!("BACKUP_INVALID:{error}")))?;
    let records = payload
        .get("records")
        .ok_or_else(|| DesktopServiceError::Invalid("BACKUP_RECORDS_MISSING".to_string()))?;
    business_data::restore_connection(connection, records).map_err(map_business_error)?;
    backup_ui(
        &payload,
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("qx-backup-v1.json"),
        bytes.len(),
    )
}

fn backup_clear(data_root: &Path) -> Result<Value, DesktopServiceError> {
    let path = backup_path(data_root);
    if path.exists() {
        fs::remove_file(path).map_err(|error| DesktopServiceError::Storage(error.to_string()))?;
    }
    Ok(json!({"backup": {"status":"idle", "lastBackup":null, "preview":null, "error":null}}))
}

fn backup_preview(data_root: &Path) -> Result<Value, DesktopServiceError> {
    Ok(backup_pick(data_root)?["backup"].clone())
}

fn backup_ui(payload: &Value, file_name: &str, size: usize) -> Result<Value, DesktopServiceError> {
    let records = payload
        .get("records")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let count = |entity: &str| {
        records
            .keys()
            .filter(|key| key.starts_with(&format!("{entity}/")))
            .count()
    };
    let summary = json!({"settings": count("view_state"), "history": count("history"), "favorites": count("favorite"), "following": count("follow")});
    let preview = json!({"formatVersion": payload.get("formatVersion").cloned().unwrap_or(json!(1)), "appVersion": payload.get("appVersion").cloned().unwrap_or(json!("0.9.0-rc.1")), "createdAt": payload.get("createdAt").cloned().unwrap_or(json!(0)), "sections": ["settings", "history", "favorites", "follow"], "databaseSchemaVersion": 1, "summary": summary, "includeCache": payload.get("includeCache").cloned().unwrap_or(json!(false)), "compatibility": "compatible"});
    Ok(
        json!({"backup": {"status":"preview", "lastBackup": {"fileName": file_name, "size": size, "createdAt": payload.get("createdAt").cloned().unwrap_or(json!(0)), "includeCache": payload.get("includeCache").cloned().unwrap_or(json!(false)), "summary": preview["summary"].clone()}, "preview": preview, "error": null}}),
    )
}

fn handle_danmaku(
    connection: &Connection,
    payload: &DesktopServicePayload,
) -> Result<Value, DesktopServiceError> {
    let mut state = record(connection, "danmaku_state", "active")?.unwrap_or_else(empty_danmaku);
    match payload.action.as_str() {
        "danmaku-load" => {
            let data = payload
                .value
                .get("data")
                .or_else(|| payload.value.get("content"))
                .or_else(|| payload.value.get("items"))
                .cloned()
                .unwrap_or(Value::Null);
            let items = parse_danmaku_items(data)?;
            state["status"] = json!("ready");
            state["source"] = payload
                .value
                .get("source")
                .cloned()
                .unwrap_or_else(|| json!("user-provided"));
            state["timeline"] = json!("vod");
            state["items"] = Value::Array(items);
            state["totalCount"] = json!(state["items"].as_array().map(Vec::len).unwrap_or(0));
            state["sources"] = json!([state["source"].clone()]);
        }
        "danmaku-settings" => {
            let mut settings = state["settings"].as_object().cloned().unwrap_or_default();
            for key in [
                "enabled",
                "opacity",
                "fontSize",
                "speed",
                "density",
                "displayArea",
                "types",
                "sources",
                "keyword",
                "regex",
                "maxActive",
                "maxPerSecond",
                "trackCount",
            ] {
                if let Some(value) = payload.value.get(key) {
                    settings.insert(key.to_string(), value.clone());
                }
            }
            state["settings"] = Value::Object(settings);
        }
        "danmaku-clear" => state = empty_danmaku(),
        "danmaku-sync" => {
            if let Some(value) = payload.value.get("currentTime").and_then(Value::as_f64) {
                state["currentTimeMs"] = json!((value.max(0.0) * 1000.0) as i64);
            }
            if let Some(status) = payload.value.get("status").and_then(Value::as_str) {
                state["playing"] = json!(status == "playing");
            }
        }
        _ => {}
    }
    upsert(connection, "danmaku_state", "active", &state)?;
    Ok(json!({"danmaku": state}))
}

fn danmaku_snapshot(connection: &Connection) -> Result<Value, DesktopServiceError> {
    Ok(record(connection, "danmaku_state", "active")?.unwrap_or_else(empty_danmaku))
}

fn empty_danmaku() -> Value {
    json!({"status":"idle","settings":{"enabled":true,"opacity":0.86,"fontSize":24,"speed":1,"density":1,"displayArea":0.82,"types":["scroll","top","bottom","reverse"],"sources":[],"keyword":"","regex":"","maxActive":120,"maxPerSecond":60,"trackCount":12},"source":null,"timeline":"vod","playing":false,"totalCount":0,"sources":[],"items":[],"currentTimeMs":0,"generation":0,"error":null})
}

fn parse_danmaku_items(data: Value) -> Result<Vec<Value>, DesktopServiceError> {
    let data = if let Value::String(value) = data {
        let trimmed = value.trim_start();
        if trimmed.starts_with('<') {
            return parse_danmaku_xml(trimmed);
        }
        serde_json::from_str::<Value>(&value)
            .map_err(|_| DesktopServiceError::Invalid("DANMAKU_JSON_INVALID".to_string()))?
    } else {
        data
    };
    let values = data
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| data.as_array().cloned())
        .ok_or_else(|| DesktopServiceError::Invalid("DANMAKU_INVALID_PAYLOAD".to_string()))?;
    let mut items = Vec::new();
    for (index, value) in values.into_iter().take(100_000).enumerate() {
        let Some(object) = value.as_object() else {
            continue;
        };
        let time_ms = object
            .get("timeMs")
            .and_then(Value::as_f64)
            .or_else(|| {
                object
                    .get("time")
                    .and_then(Value::as_f64)
                    .map(|value| value * 1000.0)
            })
            .unwrap_or(-1.0);
        let text = object
            .get("text")
            .or_else(|| object.get("content"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if time_ms < 0.0 || text.is_empty() {
            continue;
        }
        let text = text.chars().take(500).collect::<String>();
        let item_type = object
            .get("type")
            .or_else(|| object.get("mode"))
            .and_then(Value::as_str)
            .unwrap_or("scroll");
        let item_type = match item_type {
            "top" | "bottom" | "reverse" => item_type,
            _ => "scroll",
        };
        items.push(json!({"id": object.get("id").cloned().unwrap_or_else(|| json!(format!("danmaku-{index}"))), "timeMs": time_ms.floor() as i64, "text": text, "type": item_type, "color": object.get("color").cloned().unwrap_or(Value::Null), "fontSize": object.get("fontSize").cloned().unwrap_or(Value::Null), "source": object.get("source").cloned().unwrap_or_else(|| json!("user-provided"))}));
    }
    items.sort_by_key(|value| {
        value
            .get("timeMs")
            .and_then(Value::as_i64)
            .unwrap_or_default()
    });
    Ok(items)
}

fn parse_danmaku_xml(data: &str) -> Result<Vec<Value>, DesktopServiceError> {
    let mut reader = quick_xml::Reader::from_str(data);
    reader.config_mut().trim_text(false);
    let mut buffer = Vec::new();
    let mut current: Option<(String, String)> = None;
    let mut items = Vec::new();
    let mut index = 0usize;
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(quick_xml::events::Event::Start(event))
                if event.name().as_ref().eq_ignore_ascii_case(b"d") =>
            {
                let mut metadata = String::new();
                for attribute in event.attributes().with_checks(false) {
                    let attribute = attribute.map_err(|error| {
                        DesktopServiceError::Invalid(format!("DANMAKU_XML_INVALID:{error}"))
                    })?;
                    if attribute.key.as_ref().eq_ignore_ascii_case(b"p") {
                        metadata = attribute
                            .decoded_and_normalized_value(
                                quick_xml::XmlVersion::Implicit1_0,
                                reader.decoder(),
                            )
                            .map_err(|error| {
                                DesktopServiceError::Invalid(format!("DANMAKU_XML_INVALID:{error}"))
                            })?
                            .into_owned();
                    }
                }
                current = Some((metadata, String::new()));
            }
            Ok(quick_xml::events::Event::Text(event)) => {
                if let Some((_, text)) = current.as_mut() {
                    let decoded = event.decode().map_err(|error| {
                        DesktopServiceError::Invalid(format!("DANMAKU_XML_INVALID:{error}"))
                    })?;
                    let decoded = quick_xml::escape::unescape(&decoded).map_err(|error| {
                        DesktopServiceError::Invalid(format!("DANMAKU_XML_INVALID:{error}"))
                    })?;
                    text.push_str(&decoded);
                    if text.chars().count() > 500 {
                        *text = text.chars().take(500).collect();
                    }
                }
            }
            Ok(quick_xml::events::Event::CData(event)) => {
                if let Some((_, text)) = current.as_mut() {
                    let decoded = event.decode().map_err(|error| {
                        DesktopServiceError::Invalid(format!("DANMAKU_XML_INVALID:{error}"))
                    })?;
                    text.push_str(&decoded);
                    if text.chars().count() > 500 {
                        *text = text.chars().take(500).collect();
                    }
                }
            }
            Ok(quick_xml::events::Event::GeneralRef(event)) => {
                if let Some((_, text)) = current.as_mut() {
                    let name = event.decode().map_err(|error| {
                        DesktopServiceError::Invalid(format!("DANMAKU_XML_INVALID:{error}"))
                    })?;
                    let replacement = match name.as_ref() {
                        "amp" => "&",
                        "lt" => "<",
                        "gt" => ">",
                        "quot" => "\"",
                        "apos" => "'",
                        _ => "",
                    };
                    text.push_str(replacement);
                }
            }
            Ok(quick_xml::events::Event::End(event))
                if event.name().as_ref().eq_ignore_ascii_case(b"d") =>
            {
                if let Some((metadata, text)) = current.take() {
                    if let Some(item) = danmaku_xml_item(&metadata, &text, index) {
                        items.push(item);
                        index += 1;
                    }
                }
                if items.len() >= 100_000 {
                    break;
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(error) => {
                return Err(DesktopServiceError::Invalid(format!(
                    "DANMAKU_XML_INVALID:{error}"
                )))
            }
            _ => {}
        }
        buffer.clear();
    }
    items.sort_by_key(|value| {
        value
            .get("timeMs")
            .and_then(Value::as_i64)
            .unwrap_or_default()
    });
    Ok(items)
}

fn danmaku_xml_item(metadata: &str, text: &str, index: usize) -> Option<Value> {
    let mut fields = metadata.split(',');
    let seconds = fields.next()?.parse::<f64>().ok()?;
    if !seconds.is_finite() || seconds < 0.0 || text.trim().is_empty() {
        return None;
    }
    let mode = fields.next().and_then(|value| value.parse::<u8>().ok());
    let font_size = fields.next().and_then(|value| value.parse::<u64>().ok());
    let color = fields.next().and_then(|value| value.parse::<u32>().ok());
    let item_type = match mode {
        Some(5) => "top",
        Some(4) => "bottom",
        Some(6) => "reverse",
        _ => "scroll",
    };
    Some(json!({
        "id": format!("danmaku-{index}"),
        "timeMs": (seconds * 1000.0).floor() as i64,
        "text": text.trim(),
        "type": item_type,
        "color": color.map(|value| format!("#{value:06x}")),
        "fontSize": font_size,
        "source": "xml",
    }))
}

fn handle_fallback(
    connection: &Connection,
    payload: &DesktopServicePayload,
) -> Result<Value, DesktopServiceError> {
    let mut state = fallback_snapshot(connection)?;
    match payload.action.as_str() {
        "player-fallback-mode" => {
            let mode = required_value_string(&payload.value, "mode")?;
            if !matches!(mode.as_str(), "off" | "prompt" | "auto") {
                return Err(DesktopServiceError::Invalid(
                    "PLAYER_FALLBACK_MODE_INVALID".to_string(),
                ));
            }
            state["mode"] = json!(mode);
            state["status"] = if mode == "off" {
                json!("disabled")
            } else {
                json!("idle")
            };
        }
        "player-fallback-cancel" => {
            state["status"] = json!("cancelled");
            state["next"] = Value::Null;
        }
        "player-fallback-approve" => {
            state["status"] = json!("trying");
        }
        "player-sync" => {
            if payload.value.get("status").and_then(Value::as_str) == Some("error") {
                state["trigger"] = payload
                    .value
                    .get("event")
                    .cloned()
                    .unwrap_or_else(|| json!("playback-error"));
                state["reason"] = payload
                    .value
                    .get("error")
                    .cloned()
                    .unwrap_or_else(|| json!("playback error"));
                state["status"] = match string(&state, "mode").as_str() {
                    "auto" => "trying",
                    "prompt" => "prompt",
                    _ => "disabled",
                }
                .into();
            }
        }
        _ => {}
    }
    upsert(connection, "playback_fallback", "active", &state)?;
    Ok(json!({"fallback": state}))
}

fn fallback_snapshot(connection: &Connection) -> Result<Value, DesktopServiceError> {
    Ok(record(connection, "playback_fallback", "active")?.unwrap_or_else(|| json!({"mode":"prompt","status":"idle","trigger":null,"reason":null,"current":null,"next":null,"attempts":0,"tried":[]})))
}

fn handle_local(
    connection: &Connection,
    payload: &DesktopServicePayload,
) -> Result<Value, DesktopServiceError> {
    match payload.action.as_str() {
        "local-open-file" | "local-add-folder" => {
            let paths = string_list(payload.value.get("paths"));
            if paths.is_empty() {
                return Err(DesktopServiceError::Invalid(
                    "LOCAL_MEDIA_PICKER_REQUIRED".to_string(),
                ));
            }
            import_local_paths(connection, paths)
        }
        "local-drop" => import_local_paths(connection, string_list(payload.value.get("paths"))),
        "local-rescan" => {
            let root_id = payload.value.get("rootId").and_then(Value::as_str);
            let folders = records(connection, "local_media_root")?;
            for folder in folders {
                if root_id.is_none() || root_id == Some(string(&folder, "id").as_str()) {
                    scan_local_root(connection, &folder)?;
                }
            }
            local_snapshot(connection)
        }
        "local-cancel-scan" => local_snapshot(connection),
        "local-remove-folder" => {
            let id = required_value_string(&payload.value, "rootId")?;
            for item in records(connection, "local_media")? {
                if string(&item, "rootId") == id {
                    remove(connection, "local_media", &string(&item, "id"))?;
                    remove(connection, "local_media_path", &string(&item, "id"))?;
                }
            }
            remove(connection, "local_media_root", &id)?;
            local_snapshot(connection)
        }
        "local-remove-item" => {
            let id = required_value_string(&payload.value, "itemId")?;
            remove(connection, "local_media", &id)?;
            remove(connection, "local_media_path", &id)?;
            local_snapshot(connection)
        }
        "local-active" => {
            let id = payload
                .value
                .get("itemId")
                .and_then(Value::as_str)
                .unwrap_or("");
            upsert(
                connection,
                "local_media_active",
                "active",
                &json!({"id":"active", "itemId": if id.is_empty() { Value::Null } else { json!(id) }}),
            )?;
            local_snapshot(connection)
        }
        "local-locate" => {
            let item_id = required_value_string(&payload.value, "itemId")?;
            let paths = string_list(payload.value.get("paths"));
            if paths.len() != 1 {
                return Err(DesktopServiceError::Invalid(
                    "LOCAL_MEDIA_LOCATE_PATH_REQUIRED".to_string(),
                ));
            }
            let path = canonical_existing(Path::new(&paths[0]))?;
            upsert(
                connection,
                "local_media_path",
                &item_id,
                &json!({"id": item_id, "path": path.to_string_lossy()}),
            )?;
            local_snapshot(connection)
        }
        "local-play" => {
            let id = required_value_string(&payload.value, "itemId")?;
            if record(connection, "local_media", &id)?.is_none()
                || record(connection, "local_media_path", &id)?.is_none()
            {
                return Err(DesktopServiceError::Invalid(
                    "LOCAL_MEDIA_ITEM_NOT_FOUND".to_string(),
                ));
            }
            upsert(
                connection,
                "local_media_active",
                "active",
                &json!({"id":"active", "itemId":id}),
            )?;
            let path = record(connection, "local_media_path", &id)?.ok_or_else(|| {
                DesktopServiceError::Invalid("LOCAL_MEDIA_ITEM_NOT_FOUND".to_string())
            })?;
            let mut state = local_snapshot(connection)?;
            state["localPlaybackPath"] = json!(string(&path, "path"));
            Ok(state)
        }
        _ => local_snapshot(connection),
    }
}

fn import_local_paths(
    connection: &Connection,
    paths: Vec<String>,
) -> Result<Value, DesktopServiceError> {
    if paths.len() > 100 {
        return Err(DesktopServiceError::Invalid(
            "LOCAL_MEDIA_DROP_LIMIT".to_string(),
        ));
    }
    for raw in paths {
        let path = canonical_existing(Path::new(&raw))?;
        if path.is_dir() {
            let root_id = opaque_id("root", &path);
            upsert(
                connection,
                "local_media_root",
                &root_id,
                &json!({"id":root_id,"displayName":path.file_name().and_then(|value| value.to_str()).unwrap_or("Media"),"path":path.to_string_lossy(),"createdAt":now_millis(),"updatedAt":now_millis(),"lastScanAt":Value::Null,"scanStatus":"idle","error":Value::Null}),
            )?;
            scan_local_root(
                connection,
                &record(connection, "local_media_root", &root_id)?.ok_or_else(|| {
                    DesktopServiceError::Storage("LOCAL_MEDIA_ROOT_SAVE_FAILED".to_string())
                })?,
            )?;
        } else if is_media_file(&path) {
            let root_id = opaque_id("root", path.parent().unwrap_or(&path));
            let root = json!({"id":root_id,"displayName":path.parent().and_then(Path::file_name).and_then(|value| value.to_str()).unwrap_or("Media"),"path":path.parent().unwrap_or(&path).to_string_lossy(),"createdAt":now_millis(),"updatedAt":now_millis(),"lastScanAt":now_millis(),"scanStatus":"idle","error":Value::Null});
            upsert(connection, "local_media_root", &root_id, &root)?;
            save_local_file(connection, &path, &root_id)?;
        }
    }
    local_snapshot(connection)
}

fn scan_local_root(connection: &Connection, root: &Value) -> Result<(), DesktopServiceError> {
    let root_id = string(root, "id");
    let path = PathBuf::from(string(root, "path"));
    if !path.is_dir() {
        return Err(DesktopServiceError::Invalid(
            "LOCAL_MEDIA_ROOT_MISSING".to_string(),
        ));
    }
    let mut queue = vec![(path, 0usize)];
    let mut visited = 0usize;
    while let Some((current, depth)) = queue.pop() {
        if depth > MAX_LOCAL_DEPTH || visited >= MAX_LOCAL_FILES {
            break;
        }
        let entries = fs::read_dir(&current)
            .map_err(|error| DesktopServiceError::Storage(error.to_string()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                queue.push((path, depth + 1));
                continue;
            }
            if metadata.is_file() && is_media_file(&path) {
                save_local_file(connection, &path, &root_id)?;
                visited += 1;
            }
            if visited >= MAX_LOCAL_FILES {
                break;
            }
        }
    }
    let mut updated = root.clone();
    updated["lastScanAt"] = json!(now_millis());
    updated["scanStatus"] = json!("idle");
    updated["updatedAt"] = json!(now_millis());
    upsert(connection, "local_media_root", &root_id, &updated)
}

fn save_local_file(
    connection: &Connection,
    path: &Path,
    root_id: &str,
) -> Result<(), DesktopServiceError> {
    let metadata =
        fs::metadata(path).map_err(|error| DesktopServiceError::Storage(error.to_string()))?;
    let id = opaque_id("media", path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let item = json!({"id":id,"pathIdentity":id,"fileReference":format!("local:{id}"),"displayName":path.file_name().and_then(|value| value.to_str()).unwrap_or("media"),"extension":extension,"size":metadata.len(),"modifiedAt":metadata.modified().ok().and_then(|value| value.duration_since(UNIX_EPOCH).ok()).map(|value| value.as_millis() as i64).unwrap_or(0),"mediaType":if matches!(extension.as_str(),"mp3"|"aac"|"flac"|"wav"|"m4a") {"audio"} else {"video"},"createdAt":now_millis(),"updatedAt":now_millis(),"missing":false,"rootId":root_id,"subtitleTracks":[]});
    upsert(connection, "local_media", &id, &item)?;
    upsert(
        connection,
        "local_media_path",
        &id,
        &json!({"id":id,"path":path.to_string_lossy()}),
    )?;
    Ok(())
}

fn local_snapshot(connection: &Connection) -> Result<Value, DesktopServiceError> {
    let items = records(connection, "local_media")?;
    let roots = records(connection, "local_media_root")?;
    let active = record(connection, "local_media_active", "active")?
        .and_then(|value| value.get("itemId").cloned())
        .unwrap_or(Value::Null);
    let folders = roots.iter().map(|root| json!({
        "id": string(root, "id"),
        "displayName": string(root, "displayName"),
        "itemCount": items.iter().filter(|item| string(item, "rootId") == string(root, "id")).count(),
        "createdAt": number(root, "createdAt"),
        "updatedAt": number(root, "updatedAt"),
        "lastScanAt": root.get("lastScanAt").cloned().unwrap_or(Value::Null),
        "scanStatus": string_or(root, "scanStatus", "idle"),
        "error": root.get("error").cloned().unwrap_or(Value::Null),
    })).collect::<Vec<_>>();
    Ok(
        json!({"localMedia": {"ready": true, "folders": folders, "items": items, "activeItemId": active, "scan": {"rootId": null, "status": "idle", "visitedFiles": 0, "skippedFiles": 0}, "error": null, "limits": {"maxDepth": MAX_LOCAL_DEPTH, "maxFiles": MAX_LOCAL_FILES, "maxDropFiles": 100}}}),
    )
}

fn handle_download(
    connection: &Connection,
    payload: &DesktopServicePayload,
) -> Result<Value, DesktopServiceError> {
    match payload.action.as_str() {
        "download-select-folder" => {
            let path = payload
                .value
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| string_list(payload.value.get("paths")).into_iter().next())
                .ok_or_else(|| {
                    DesktopServiceError::Invalid("DOWNLOAD_TARGET_INVALID".to_string())
                })?;
            let directory = canonical_existing(Path::new(&path))?;
            if !directory.is_dir() {
                return Err(DesktopServiceError::Invalid(
                    "DOWNLOAD_TARGET_INVALID".to_string(),
                ));
            }
            let id = opaque_id("download-dir", &directory);
            upsert(
                connection,
                "download_target",
                &id,
                &json!({"id":id,"displayName":directory.file_name().and_then(|value| value.to_str()).unwrap_or("Downloads"),"path":directory.to_string_lossy(),"createdAt":now_millis(),"updatedAt":now_millis()}),
            )?;
            download_snapshot(connection)
        }
        "download-add" => download_add(connection, &payload.value),
        "download-refresh" => {
            process_downloads(connection)?;
            download_snapshot(connection)
        }
        "download-pause" | "download-resume" | "download-cancel" | "download-retry"
        | "download-remove" => download_transition(connection, payload),
        "download-open-folder" => {
            let target_id = required_value_string(&payload.value, "targetDirectoryId")?;
            let target = record(connection, "download_target", &target_id)?.ok_or_else(|| {
                DesktopServiceError::Invalid("DOWNLOAD_TARGET_INVALID".to_string())
            })?;
            open_directory(Path::new(&string(&target, "path")))?;
            download_snapshot(connection)
        }
        _ => download_snapshot(connection),
    }
}

fn download_add(connection: &Connection, value: &Value) -> Result<Value, DesktopServiceError> {
    let title = required_value_string(value, "title")?;
    let url = required_value_string(value, "url")?;
    validate_download_url(&url)?;
    let target = required_value_string(value, "targetDirectoryId")?;
    let target_record = record(connection, "download_target", &target)?
        .ok_or_else(|| DesktopServiceError::Invalid("DOWNLOAD_TARGET_INVALID".to_string()))?;
    let filename = safe_filename(
        value
            .get("filename")
            .and_then(Value::as_str)
            .unwrap_or(&title),
    );
    let id = format!("download-{}", Uuid::new_v4());
    let request_reference = format!("download:{}", opaque_id("request", Path::new(&url)));
    upsert(
        connection,
        "download_request",
        &id,
        &json!({"id":id,"url":url,"targetDirectoryId":target,"filename":filename}),
    )?;
    upsert(
        connection,
        "download",
        &id,
        &json!({"id":id,"sourceId":null,"contentId":null,"title":title,"targetDirectoryId":string(&target_record,"id"),"suggestedFilename":filename,"requestReference":request_reference,"status":"queued","totalBytes":null,"completedBytes":0,"speed":null,"createdAt":now_millis(),"startedAt":null,"completedAt":null,"updatedAt":now_millis(),"error":null}),
    )?;
    process_downloads(connection)?;
    download_snapshot(connection)
}

fn download_transition(
    connection: &Connection,
    payload: &DesktopServicePayload,
) -> Result<Value, DesktopServiceError> {
    let id = required_value_string(&payload.value, "taskId")?;
    let mut task = record(connection, "download", &id)?
        .ok_or_else(|| DesktopServiceError::Invalid("DOWNLOAD_TASK_NOT_FOUND".to_string()))?;
    let status = match payload.action.as_str() {
        "download-pause" => "paused",
        "download-resume" | "download-retry" => "queued",
        "download-cancel" => "cancelled",
        "download-remove" => "removed",
        _ => "queued",
    };
    task["status"] = json!(status);
    task["updatedAt"] = json!(now_millis());
    upsert(connection, "download", &id, &task)?;
    if status == "queued" {
        process_downloads(connection)?;
    }
    download_snapshot(connection)
}

fn process_downloads(connection: &Connection) -> Result<(), DesktopServiceError> {
    for task in records(connection, "download")? {
        if string(&task, "status") != "queued" {
            continue;
        }
        let id = string(&task, "id");
        let Some(request) = record(connection, "download_request", &id)? else {
            continue;
        };
        let mut task = task;
        task["status"] = json!("downloading");
        task["startedAt"] = json!(now_millis());
        upsert(connection, "download", &id, &task)?;
        let result = fetch_download(connection, &request, &mut task);
        match result {
            Ok(()) => {
                task["status"] = json!("completed");
                task["completedAt"] = json!(now_millis());
                task["error"] = Value::Null;
            }
            Err(error) => {
                task["status"] = json!("failed");
                task["error"] = json!(error);
            }
        }
        task["updatedAt"] = json!(now_millis());
        upsert(connection, "download", &id, &task)?;
    }
    Ok(())
}

fn fetch_download(
    connection: &Connection,
    request: &Value,
    task: &mut Value,
) -> Result<(), String> {
    let url = string(request, "url");
    let parsed_url = reqwest::Url::parse(&url).map_err(|error| error.to_string())?;
    let mut client_builder = Client::builder()
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none());
    if parsed_url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<IpAddr>()
                .map(|address| address.is_loopback())
                .unwrap_or(false)
    }) {
        client_builder = client_builder.no_proxy();
    }
    let client = client_builder.build().map_err(|error| error.to_string())?;
    let response = client
        .get(parsed_url)
        .send()
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("DOWNLOAD_HTTP_{}", response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_DOWNLOAD_BYTES as u64)
    {
        return Err("DOWNLOAD_TOO_LARGE".to_string());
    }
    let bytes = response.bytes().map_err(|error| error.to_string())?;
    if bytes.len() > MAX_DOWNLOAD_BYTES {
        return Err("DOWNLOAD_TOO_LARGE".to_string());
    }
    let target = record(
        connection,
        "download_target",
        &string(request, "targetDirectoryId"),
    )
    .map_err(|error| format!("{error:?}"))?
    .ok_or_else(|| "DOWNLOAD_TARGET_INVALID".to_string())?;
    let path =
        PathBuf::from(string(&target, "path")).join(safe_filename(&string(request, "filename")));
    write_download_atomically(&path, &bytes)?;
    task["totalBytes"] = json!(bytes.len());
    task["completedBytes"] = json!(bytes.len());
    task["speed"] = json!(null);
    Ok(())
}

fn write_download_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "DOWNLOAD_TARGET_INVALID".to_string())?;
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download.bin");
    let temporary = parent.join(format!(".{filename}.{}.part", Uuid::new_v4()));

    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);

        match fs::rename(&temporary, path) {
            Ok(()) => Ok(()),
            Err(_error) if path.exists() => {
                fs::remove_file(path).map_err(|replace_error| replace_error.to_string())?;
                fs::rename(&temporary, path).map_err(|replace_error| replace_error.to_string())
            }
            Err(error) => Err(error.to_string()),
        }
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn download_snapshot(connection: &Connection) -> Result<Value, DesktopServiceError> {
    let tasks = records(connection, "download")?;
    let targets = records(connection, "download_target")?.into_iter().map(|target| json!({"id":string(&target,"id"),"displayName":string(&target,"displayName"),"createdAt":number(&target,"createdAt"),"updatedAt":number(&target,"updatedAt"),"taskCount":tasks.iter().filter(|task| string(task,"targetDirectoryId")==string(&target,"id")).count()})).collect::<Vec<_>>();
    Ok(
        json!({"downloads":{"tasks":tasks,"targetDirectories":targets,"backend":"native-http","aria2Available":false,"error":null}}),
    )
}

fn validate_download_url(value: &str) -> Result<(), DesktopServiceError> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| DesktopServiceError::Invalid("DOWNLOAD_URL_INVALID".to_string()))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some_and(sensitive_query)
        || value.to_ascii_lowercase().contains(".m3u8")
        || value.to_ascii_lowercase().contains(".mpd")
    {
        return Err(DesktopServiceError::Invalid(
            "DOWNLOAD_URL_UNSUPPORTED".to_string(),
        ));
    }
    Ok(())
}

fn safe_filename(value: &str) -> String {
    value
        .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_")
        .trim()
        .trim_matches('.')
        .chars()
        .take(180)
        .collect::<String>()
        .if_empty_then("download.bin")
}

trait StringFallback {
    fn if_empty_then(self, fallback: &str) -> String;
}
impl StringFallback for String {
    fn if_empty_then(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

fn canonical_existing(path: &Path) -> Result<PathBuf, DesktopServiceError> {
    fs::canonicalize(path).map_err(|_| DesktopServiceError::Invalid("PATH_NOT_FOUND".to_string()))
}
fn is_media_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "mp4" | "mkv" | "webm" | "mov" | "avi" | "m4v" | "mp3" | "aac" | "flac" | "wav" | "m4a"
    )
}
fn opaque_id(prefix: &str, path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(path.to_string_lossy().as_bytes());
    format!(
        "{prefix}-{}",
        digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}
fn is_writable(path: &Path) -> bool {
    let probe = path.join(format!(".qx-write-{}", Uuid::new_v4()));
    fs::write(&probe, b"probe")
        .and_then(|_| fs::remove_file(probe))
        .is_ok()
}
fn open_directory(path: &Path) -> Result<(), DesktopServiceError> {
    if !path.exists() {
        return Err(DesktopServiceError::Invalid(
            "DIRECTORY_NOT_FOUND".to_string(),
        ));
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(path)
            .spawn()
            .map_err(|error| DesktopServiceError::Storage(error.to_string()))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
    }
    Ok(())
}
fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default()
}
fn required_value_string(value: &Value, key: &str) -> Result<String, DesktopServiceError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| DesktopServiceError::Invalid(format!("{key} is required")))
}
fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
fn string_or(value: &Value, key: &str, fallback: &str) -> String {
    let value = string(value, key);
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}
fn number(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or_default()
}
fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}
fn sensitive_query(query: &str) -> bool {
    query.split('&').any(|part| {
        part.split_once('=')
            .map(|(key, _)| {
                matches!(
                    key.to_ascii_lowercase().as_str(),
                    "token" | "access_token" | "authorization" | "cookie" | "password" | "secret"
                )
            })
            .unwrap_or(false)
    })
}

fn records(connection: &Connection, entity: &str) -> Result<Vec<Value>, DesktopServiceError> {
    Ok(business_data::list_connection(connection, entity)
        .map_err(map_business_error)?
        .value
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
        .into_values()
        .collect())
}
fn all_records(
    connection: &Connection,
) -> Result<Vec<(String, String, Value)>, DesktopServiceError> {
    let mut result = Vec::new();
    for entity in [
        "view_state",
        "history",
        "favorite",
        "favorite_group",
        "follow",
        "cache_entry",
        "download",
        "local_media",
        "local_media_root",
    ] {
        for (id, value) in business_data::list_connection(connection, entity)
            .map_err(map_business_error)?
            .value
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default()
        {
            result.push((entity.to_string(), id, value));
        }
    }
    Ok(result)
}
fn record(
    connection: &Connection,
    entity: &str,
    id: &str,
) -> Result<Option<Value>, DesktopServiceError> {
    Ok(business_data::read_connection(connection, entity, id)
        .map_err(map_business_error)?
        .value)
}
fn upsert(
    connection: &Connection,
    entity: &str,
    id: &str,
    value: &Value,
) -> Result<(), DesktopServiceError> {
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
fn remove(connection: &Connection, entity: &str, id: &str) -> Result<(), DesktopServiceError> {
    business_data::remove_connection(connection, entity, id)
        .map(|_| ())
        .map_err(map_business_error)
}
fn map_business_error(error: business_data::BusinessDataError) -> DesktopServiceError {
    match error {
        business_data::BusinessDataError::Invalid(message) => DesktopServiceError::Invalid(message),
        business_data::BusinessDataError::Storage(message) => DesktopServiceError::Storage(message),
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::bind_loopback_tcp_std;
    use super::{
        handle, handle_async, prune_cache, record, upsert, write_download_atomically,
        DesktopServicePayload, MAX_CACHE_IMAGE_BYTES,
    };
    use rusqlite::Connection;
    use serde_json::{json, Value};
    use std::fs;
    use std::io::{Read, Write};
    use std::thread;

    fn fixture_root(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "qx-desktop-services-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("fixture root");
        root
    }

    fn serve_image_response(
        content_type: &str,
        content_length: Option<usize>,
        body: Vec<u8>,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = bind_loopback_tcp_std().expect("local HTTP listener");
        let address = listener.local_addr().expect("listener address");
        let content_type = content_type.to_string();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("image request");
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).expect("image request bytes");
            let content_length = content_length
                .map(|length| format!("Content-Length: {length}\r\n"))
                .unwrap_or_default();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\n{content_length}Connection: close\r\n\r\n"
            )
            .expect("image response headers");
            let _ = stream.write_all(&body);
        });
        (format!("http://{address}/image"), server)
    }

    #[test]
    fn imports_local_media_without_exposing_paths_and_round_trips_backup() {
        let root = fixture_root("local");
        let media = root.join("movie.mp4");
        fs::write(&media, b"fixture-media").expect("media");
        let database = root.join("qx.sqlite3");
        let imported = handle(
            &root,
            &database,
            &DesktopServicePayload {
                action: "local-drop".to_string(),
                value: json!({"paths":[media.to_string_lossy()]}),
            },
        )
        .expect("local import");
        assert_eq!(
            imported["localMedia"]["items"].as_array().map(Vec::len),
            Some(1)
        );
        assert!(!imported
            .to_string()
            .contains(media.to_string_lossy().as_ref()));
        let backup = handle(
            &root,
            &database,
            &DesktopServicePayload {
                action: "backup-create".to_string(),
                value: json!({"includeCache":false}),
            },
        )
        .expect("backup");
        assert_eq!(backup["backup"]["preview"]["compatibility"], "compatible");
        assert!(!fs::read_to_string(root.join("backups/qx-backup-v1.json"))
            .expect("backup file")
            .contains(media.to_string_lossy().as_ref()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_playback_and_credential_urls_as_downloads() {
        let root = fixture_root("download");
        let database = root.join("qx.sqlite3");
        let error = handle(&root, &database, &DesktopServicePayload { action: "download-add".to_string(), value: json!({"title":"Stream","url":"https://media.example.test/stream.m3u8","targetDirectoryId":"missing"}) }).expect_err("stream rejected");
        assert!(format!("{error:?}").contains("DOWNLOAD_URL_UNSUPPORTED"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn writes_download_atomically_and_replaces_existing_file() {
        let root = fixture_root("download-atomic");
        let destination = root.join("episode.mp4");
        fs::write(&destination, b"old").expect("existing file");

        write_download_atomically(&destination, b"new-content").expect("atomic write");

        assert_eq!(
            fs::read(&destination).expect("download file"),
            b"new-content"
        );
        assert_eq!(fs::read_dir(&root).expect("download directory").count(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn downloads_native_http_file_and_reports_completed_progress() {
        let root = fixture_root("download-http");
        let database = root.join("qx.sqlite3");
        let target = root.join("downloads");
        fs::create_dir_all(&target).expect("download target");
        let target_snapshot = handle(
            &root,
            &database,
            &DesktopServicePayload {
                action: "download-select-folder".to_string(),
                value: json!({"path": target}),
            },
        )
        .expect("download target");
        let target_id = target_snapshot["downloads"]["targetDirectories"][0]["id"]
            .as_str()
            .expect("target id")
            .to_string();

        let body = b"native-download-fixture".to_vec();
        let listener = bind_loopback_tcp_std().expect("local HTTP listener");
        let address = listener.local_addr().expect("listener address");
        let server = thread::spawn({
            let body = body.clone();
            move || {
                let (mut stream, _) = listener.accept().expect("HTTP request");
                let mut request = [0_u8; 1024];
                let _ = stream.read(&mut request).expect("HTTP request bytes");
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .expect("HTTP response headers");
                stream.write_all(&body).expect("HTTP response body");
            }
        });

        let snapshot = handle(
            &root,
            &database,
            &DesktopServicePayload {
                action: "download-add".to_string(),
                value: json!({
                    "title": "Episode",
                    "url": format!("http://{address}/episode.mp4"),
                    "filename": "episode.mp4",
                    "targetDirectoryId": target_id,
                }),
            },
        )
        .expect("native download");
        server.join().expect("HTTP server");

        let task = &snapshot["downloads"]["tasks"][0];
        assert_eq!(task["status"], "completed", "{task}");
        assert_eq!(task["totalBytes"], body.len());
        assert_eq!(task["completedBytes"], body.len());
        assert_eq!(
            fs::read(target.join("episode.mp4")).expect("downloaded file"),
            body
        );
        assert_eq!(
            fs::read_dir(&target).expect("download directory").count(),
            1
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn caches_valid_images_and_reuses_the_existing_file() {
        let root = fixture_root("cache-image-hit");
        let database = root.join("qx.sqlite3");
        let png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        let listener = bind_loopback_tcp_std().expect("local HTTP listener");
        let address = listener.local_addr().expect("listener address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("image request");
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).expect("image request bytes");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                png.len()
            )
            .expect("image response headers");
            stream.write_all(&png).expect("image response body");
        });
        let url = format!("http://{address}/poster.png");

        let first = handle(
            &root,
            &database,
            &DesktopServicePayload {
                action: "cache-image".to_string(),
                value: json!({"type":"poster","url":url,"sourceId":"source-a"}),
            },
        )
        .expect("cache image");
        server.join().expect("image server");
        let second = handle(
            &root,
            &database,
            &DesktopServicePayload {
                action: "cache-image".to_string(),
                value: json!({"type":"poster","url":url,"sourceId":"source-a"}),
            },
        )
        .expect("cached image");

        assert_eq!(first["hit"], false, "{first}");
        assert_eq!(first["errorCode"], Value::Null, "{first}");
        assert_eq!(second["hit"], true, "{second}");
        assert_eq!(second["assetUrl"], first["assetUrl"]);
        assert_eq!(
            fs::read_dir(root.join("cache/poster"))
                .expect("poster cache")
                .count(),
            1
        );
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn async_boundary_caches_images_without_dropping_a_runtime() {
        let root = fixture_root("cache-image-async-boundary");
        let database = root.join("qx.sqlite3");
        let png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        let (url, server) = serve_image_response("image/png", Some(png.len()), png);

        let snapshot = handle_async(
            root.clone(),
            database,
            DesktopServicePayload {
                action: "cache-image".to_string(),
                value: json!({"type":"poster","url":url,"sourceId":"source-a"}),
            },
        )
        .await
        .expect("async cache image");
        server.join().expect("image server");

        assert_eq!(snapshot["status"], "stored", "{snapshot}");
        assert_eq!(snapshot["hit"], false, "{snapshot}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn expires_cached_images_before_reusing_the_file() {
        let root = fixture_root("cache-image-expired");
        let database = root.join("qx.sqlite3");
        let png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        let (url, server) = serve_image_response("image/png", Some(png.len()), png);
        let first = handle(
            &root,
            &database,
            &DesktopServicePayload {
                action: "cache-image".to_string(),
                value: json!({"type":"poster","url":url,"key":"expired-poster"}),
            },
        )
        .expect("cache image");
        server.join().expect("image server");

        let connection = Connection::open(&database).expect("cache database");
        let id = first["record"]["id"].as_str().expect("cache id");
        let mut entry = record(&connection, "cache_entry", id)
            .expect("read cache entry")
            .expect("cache entry");
        entry["expiresAt"] = json!(0);
        upsert(&connection, "cache_entry", id, &entry).expect("expire cache entry");
        drop(connection);

        let expired = handle(
            &root,
            &database,
            &DesktopServicePayload {
                action: "cache-image".to_string(),
                value: json!({
                    "type":"poster",
                    "url":"http://127.0.0.1:1/unavailable.png",
                    "key":"expired-poster"
                }),
            },
        )
        .expect("expired cache falls back");
        assert_eq!(expired["status"], "placeholder", "{expired}");
        assert_eq!(expired["hit"], false, "{expired}");
        assert_eq!(expired["cache"]["entries"], 0, "{expired}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prunes_expired_entries_before_least_recently_used_entries() {
        let root = fixture_root("cache-prune-order");
        let database = root.join("qx.sqlite3");
        handle(
            &root,
            &database,
            &DesktopServicePayload {
                action: "cache-snapshot".to_string(),
                value: Value::Null,
            },
        )
        .expect("initialize cache database");
        let cache_dir = root.join("cache/poster");
        fs::create_dir_all(&cache_dir).expect("cache directory");
        let connection = Connection::open(&database).expect("cache database");
        for (id, accessed_at, expires_at) in [
            ("expired", 30, 0),
            ("least-recent", 10, i64::MAX),
            ("most-recent", 20, i64::MAX),
        ] {
            let relative_path = format!("cache/poster/{id}.png");
            fs::write(root.join(&relative_path), [1_u8, 2, 3, 4]).expect("cache file");
            upsert(
                &connection,
                "cache_entry",
                id,
                &json!({
                    "id": id,
                    "type": "poster",
                    "path": relative_path,
                    "bytes": 4,
                    "createdAt": accessed_at,
                    "accessedAt": accessed_at,
                    "expiresAt": expires_at,
                }),
            )
            .expect("cache entry");
        }

        drop(connection);
        let refreshed = handle(
            &root,
            &database,
            &DesktopServicePayload {
                action: "cache-refresh".to_string(),
                value: Value::Null,
            },
        )
        .expect("refresh cache");
        assert_eq!(refreshed["cache"]["entries"], 2, "{refreshed}");
        assert!(!root.join("cache/poster/expired.png").exists());

        let connection = Connection::open(&database).expect("cache database");
        prune_cache(&root, &connection, 4).expect("prune cache");

        assert!(!root.join("cache/poster/least-recent.png").exists());
        assert!(root.join("cache/poster/most-recent.png").exists());
        assert!(record(&connection, "cache_entry", "expired")
            .expect("expired record")
            .is_none());
        assert!(record(&connection, "cache_entry", "least-recent")
            .expect("least recent record")
            .is_none());
        assert!(record(&connection, "cache_entry", "most-recent")
            .expect("most recent record")
            .is_some());
        drop(connection);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_invalid_or_oversized_image_responses_without_caching_them() {
        let root = fixture_root("cache-image-invalid");
        let database = root.join("qx.sqlite3");
        let png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        let cases = [
            (
                "text/html",
                Some(png.len()),
                png.clone(),
                "CACHE_IMAGE_MIME_INVALID",
            ),
            (
                "image/jpeg",
                Some(png.len()),
                png,
                "CACHE_IMAGE_MIME_MISMATCH",
            ),
            (
                "image/png",
                None,
                vec![0_u8; MAX_CACHE_IMAGE_BYTES + 1],
                "CACHE_IMAGE_TOO_LARGE",
            ),
        ];

        for (index, (content_type, content_length, body, error_code)) in
            cases.into_iter().enumerate()
        {
            let (url, server) = serve_image_response(content_type, content_length, body);
            let snapshot = handle(
                &root,
                &database,
                &DesktopServicePayload {
                    action: "cache-image".to_string(),
                    value: json!({"type":"poster","url":url,"key":format!("invalid-{index}")}),
                },
            )
            .expect("invalid image returns placeholder");
            server.join().expect("image server");
            assert_eq!(snapshot["status"], "placeholder", "{snapshot}");
            assert_eq!(snapshot["errorCode"], error_code, "{snapshot}");
            assert_eq!(snapshot["cache"]["entries"], 0, "{snapshot}");
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_bilibili_xml_danmaku_with_bounded_fields() {
        let root = fixture_root("danmaku");
        let database = root.join("qx.sqlite3");
        let snapshot = handle(
            &root,
            &database,
            &DesktopServicePayload {
                action: "danmaku-load".to_string(),
                value: json!({"data":"<i><d p=\"1.25,5,32,16711680,0,0,0,0\">&amp;hello</d><d p=\"2,4,24,255,0,0,0,0\"><![CDATA[bottom]]></d></i>"}),
            },
        )
        .expect("xml danmaku");
        assert_eq!(snapshot["danmaku"]["totalCount"], 2);
        assert_eq!(snapshot["danmaku"]["items"][0]["timeMs"], 1250);
        assert_eq!(snapshot["danmaku"]["items"][0]["type"], "top");
        assert_eq!(snapshot["danmaku"]["items"][0]["text"], "&hello");
        assert_eq!(snapshot["danmaku"]["items"][1]["type"], "bottom");
        let _ = fs::remove_dir_all(root);
    }
}
