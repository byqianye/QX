use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use aes::Aes128;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

type Aes128CbcDecryptor = cbc::Decryptor<Aes128>;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigCatalogPayload {
    pub source: String,
    pub source_kind: String,
    pub raw: String,
    #[serde(default)]
    pub fetch_remote: bool,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigCatalogSnapshot {
    pub schema_version: String,
    pub source: String,
    pub source_kind: String,
    pub version_hash: String,
    pub site_count: usize,
    pub used_cache: bool,
    pub valid_version_count: usize,
    pub warning_code: Option<String>,
    pub sites: Vec<ConfigSiteSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigCatalogHistorySnapshot {
    pub schema_version: String,
    pub source: String,
    pub active_version_hash: Option<String>,
    pub versions: Vec<ConfigCatalogVersionSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigCatalogVersionSummary {
    pub version_hash: String,
    pub source_kind: String,
    pub site_count: usize,
    pub created_at: i64,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSiteSummary {
    pub key: String,
    pub name: String,
    pub api: String,
    pub site_type: u8,
    pub ext: Option<String>,
}

#[derive(Debug)]
pub struct CatalogError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl CatalogError {
    fn invalid(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable: false,
        }
    }

    fn storage(message: impl Into<String>) -> Self {
        Self {
            code: "STORAGE_SQL_ERROR".to_string(),
            message: message.into(),
            retryable: true,
        }
    }
}

pub fn ingest(
    path: &Path,
    payload: &ConfigCatalogPayload,
) -> Result<ConfigCatalogSnapshot, CatalogError> {
    let connection =
        Connection::open(path).map_err(|error| CatalogError::storage(error.to_string()))?;
    ingest_connection(&connection, payload)
}

pub fn ingest_connection(
    connection: &Connection,
    payload: &ConfigCatalogPayload,
) -> Result<ConfigCatalogSnapshot, CatalogError> {
    ensure_schema(connection)?;
    let source = normalize_source(&payload.source);
    validate_payload(&source, &payload.source_kind)?;

    if payload.source_kind == "multi" {
        return ingest_multi_connection(connection, payload, &source);
    }

    let parsed = parse_config(&payload.raw);
    let (version_hash, site_count, used_cache, sites) = match parsed {
        Ok((decoded, site_count, sites)) => {
            let version_hash = digest(&payload.raw);
            connection
                .execute(
                    "INSERT OR IGNORE INTO config_versions
                     (source, source_kind, version_hash, raw_json, site_count, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        source,
                        payload.source_kind,
                        version_hash,
                        decoded,
                        site_count as i64,
                        now_millis(),
                    ],
                )
                .map_err(|error| CatalogError::storage(error.to_string()))?;
            connection
                .execute(
                    "INSERT INTO config_sources
                     (source, source_kind, active_version_hash, updated_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(source) DO UPDATE SET
                       source_kind = excluded.source_kind,
                       active_version_hash = excluded.active_version_hash,
                       updated_at = excluded.updated_at",
                    params![source, payload.source_kind, version_hash, now_millis()],
                )
                .map_err(|error| CatalogError::storage(error.to_string()))?;
            connection
                .execute(
                    "DELETE FROM config_versions
                     WHERE source = ?1 AND rowid NOT IN (
                       SELECT rowid FROM config_versions
                       WHERE source = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 3
                     )",
                    params![source],
                )
                .map_err(|error| CatalogError::storage(error.to_string()))?;
            (version_hash, site_count, false, sites)
        }
        Err(error) => match latest_version(connection, &source)? {
            Some((version_hash, site_count, raw_json)) => {
                let sites = extract_site_summaries(&raw_json).unwrap_or_default();
                (version_hash, site_count, true, sites)
            }
            None => return Err(error),
        },
    };

    let valid_version_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM config_versions WHERE source = ?1",
            params![source],
            |row| row.get(0),
        )
        .map_err(|error| CatalogError::storage(error.to_string()))?;

    let warning_code = http_warning(&source);
    Ok(ConfigCatalogSnapshot {
        schema_version: "v1".to_string(),
        source,
        source_kind: payload.source_kind.clone(),
        version_hash,
        site_count,
        used_cache,
        valid_version_count: valid_version_count as usize,
        warning_code,
        sites,
    })
}

pub fn history(path: &Path, source: &str) -> Result<ConfigCatalogHistorySnapshot, CatalogError> {
    let connection =
        Connection::open(path).map_err(|error| CatalogError::storage(error.to_string()))?;
    history_connection(&connection, source)
}

pub fn history_connection(
    connection: &Connection,
    source: &str,
) -> Result<ConfigCatalogHistorySnapshot, CatalogError> {
    ensure_schema(connection)?;
    let source = normalized_source_required(source)?;
    let active_version_hash = connection
        .query_row(
            "SELECT active_version_hash FROM config_sources WHERE source = ?1",
            params![source],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| CatalogError::storage(error.to_string()))?
        .flatten();
    let mut statement = connection
        .prepare(
            "SELECT version_hash, source_kind, site_count, created_at
             FROM config_versions WHERE source = ?1 ORDER BY created_at DESC, rowid DESC",
        )
        .map_err(|error| CatalogError::storage(error.to_string()))?;
    let rows = statement
        .query_map(params![source], |row| {
            let version_hash = row.get::<_, String>(0)?;
            Ok(ConfigCatalogVersionSummary {
                active: active_version_hash.as_deref() == Some(version_hash.as_str()),
                version_hash,
                source_kind: row.get(1)?,
                site_count: row.get::<_, i64>(2)? as usize,
                created_at: row.get(3)?,
            })
        })
        .map_err(|error| CatalogError::storage(error.to_string()))?;
    let versions = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| CatalogError::storage(error.to_string()))?;
    Ok(ConfigCatalogHistorySnapshot {
        schema_version: "v1".to_string(),
        source,
        active_version_hash,
        versions,
    })
}

pub fn activate(
    path: &Path,
    source: &str,
    version_hash: &str,
) -> Result<ConfigCatalogSnapshot, CatalogError> {
    let connection =
        Connection::open(path).map_err(|error| CatalogError::storage(error.to_string()))?;
    activate_connection(&connection, source, version_hash)
}

pub fn activate_connection(
    connection: &Connection,
    source: &str,
    version_hash: &str,
) -> Result<ConfigCatalogSnapshot, CatalogError> {
    ensure_schema(connection)?;
    let source = normalized_source_required(source)?;
    if version_hash.trim().is_empty() {
        return Err(CatalogError::invalid(
            "CONFIG_VERSION_HASH_EMPTY",
            "configuration version hash is empty",
        ));
    }
    let version = connection
        .query_row(
            "SELECT source_kind, raw_json, site_count FROM config_versions
             WHERE source = ?1 AND version_hash = ?2",
            params![source, version_hash],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)? as usize,
                ))
            },
        )
        .optional()
        .map_err(|error| CatalogError::storage(error.to_string()))?
        .ok_or_else(|| {
            CatalogError::invalid(
                "CONFIG_VERSION_NOT_FOUND",
                "configuration version was not found",
            )
        })?;
    connection
        .execute(
            "INSERT INTO config_sources(source, source_kind, active_version_hash, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(source) DO UPDATE SET
               source_kind = excluded.source_kind,
               active_version_hash = excluded.active_version_hash,
               updated_at = excluded.updated_at",
            params![source, version.0, version_hash, now_millis()],
        )
        .map_err(|error| CatalogError::storage(error.to_string()))?;
    snapshot_from_version(
        connection,
        &source,
        version_hash,
        &version.0,
        &version.1,
        version.2,
        true,
    )
}

pub async fn ingest_remote(
    path: &Path,
    payload: &ConfigCatalogPayload,
) -> Result<ConfigCatalogSnapshot, CatalogError> {
    let source = normalize_source(&payload.source);
    validate_payload(&source, &payload.source_kind)?;
    if payload.source_kind != "url" {
        return ingest(path, payload);
    }
    let timeout =
        std::time::Duration::from_millis(payload.timeout_ms.unwrap_or(30_000).clamp(1_000, 60_000));
    let client = super::source_session::client_builder_for_url(reqwest::Client::builder(), &source)
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| CatalogError::storage(error.to_string()))?;
    let retry_allowed = !super::source_session::is_loopback_target(&source);
    let fetched = fetch_remote_config(&source, &client, timeout, retry_allowed).await;

    match fetched {
        Ok(raw) => {
            let mut refreshed = payload.clone();
            refreshed.raw = raw;
            refreshed.fetch_remote = false;
            ingest(path, &refreshed)
        }
        Err(error) => {
            let connection = Connection::open(path)
                .map_err(|storage| CatalogError::storage(storage.to_string()))?;
            ensure_schema(&connection)?;
            let Some((version_hash, site_count, raw_json)) = latest_version(&connection, &source)?
            else {
                return Err(error);
            };
            let valid_version_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM config_versions WHERE source = ?1",
                    params![source],
                    |row| row.get(0),
                )
                .map_err(|storage| CatalogError::storage(storage.to_string()))?;
            let warning_code = http_warning(&source);
            Ok(ConfigCatalogSnapshot {
                schema_version: "v1".to_string(),
                source,
                source_kind: payload.source_kind.clone(),
                version_hash,
                site_count,
                used_cache: true,
                valid_version_count: valid_version_count as usize,
                warning_code,
                sites: extract_site_summaries(&raw_json).unwrap_or_default(),
            })
        }
    }
}

async fn fetch_remote_config(
    source: &str,
    client: &reqwest::Client,
    timeout: std::time::Duration,
    retry_allowed: bool,
) -> Result<String, CatalogError> {
    let build_request = |client: &reqwest::Client| {
        client
            .get(source)
            .header(reqwest::header::USER_AGENT, "QX-Yingshi/1.0 config-catalog")
    };
    let first = build_request(client).send().await;
    let should_retry = match &first {
        Ok(response) => matches!(
            response.status(),
            reqwest::StatusCode::BAD_GATEWAY
                | reqwest::StatusCode::SERVICE_UNAVAILABLE
                | reqwest::StatusCode::GATEWAY_TIMEOUT
                | reqwest::StatusCode::TOO_MANY_REQUESTS
                | reqwest::StatusCode::INTERNAL_SERVER_ERROR
        ),
        Err(error) => error.is_connect() || error.is_timeout(),
    };
    let response = if retry_allowed && should_retry {
        let first_description = match &first {
            Ok(response) => format!("remote configuration returned {}", response.status()),
            Err(error) => error.to_string(),
        };
        let direct = reqwest::Client::builder()
            .no_proxy()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|error| CatalogError {
                code: "CONFIG_REMOTE_FETCH_FAILED".to_string(),
                message: format!("{first_description}; direct retry client failed: {error}"),
                retryable: true,
            })?;
        build_request(&direct)
            .send()
            .await
            .map_err(|error| CatalogError {
                code: "CONFIG_REMOTE_FETCH_FAILED".to_string(),
                message: format!("{first_description}; direct retry failed: {error}"),
                retryable: true,
            })?
    } else {
        first.map_err(|error| CatalogError {
            code: "CONFIG_REMOTE_FETCH_FAILED".to_string(),
            message: error.to_string(),
            retryable: true,
        })?
    };
    let first_status_success = response.status().is_success();
    let first_result = read_remote_config_response(response).await;
    match first_result {
        Ok(raw) => Ok(raw),
        Err(error) if retry_allowed && first_status_success && error.retryable => {
            let direct = reqwest::Client::builder()
                .no_proxy()
                .timeout(timeout)
                .redirect(reqwest::redirect::Policy::limited(5))
                .build()
                .map_err(|direct_error| CatalogError {
                    code: "CONFIG_REMOTE_FETCH_FAILED".to_string(),
                    message: format!("{}; direct retry client failed: {direct_error}", error.message),
                    retryable: true,
                })?;
            let response = build_request(&direct)
                .send()
                .await
                .map_err(|direct_error| CatalogError {
                    code: "CONFIG_REMOTE_FETCH_FAILED".to_string(),
                    message: format!("{}; direct retry failed: {direct_error}", error.message),
                    retryable: true,
                })?;
            read_remote_config_response(response).await
        }
        Err(error) => Err(error),
    }
}

async fn read_remote_config_response(
    response: reqwest::Response,
) -> Result<String, CatalogError> {
    if !response.status().is_success() {
        return Err(CatalogError {
            code: "CONFIG_REMOTE_FETCH_FAILED".to_string(),
            message: format!("remote configuration returned {}", response.status()),
            retryable: false,
        });
    }
    let bytes = super::source_session::read_bounded_response(response)
        .await
        .map_err(|error| match error {
            super::source_session::BoundedResponseError::TooLarge => CatalogError {
                code: "CONFIG_REMOTE_RESPONSE_TOO_LARGE".to_string(),
                message: "remote configuration exceeds 8 MiB".to_string(),
                retryable: false,
            },
            super::source_session::BoundedResponseError::Request(message) => CatalogError {
                code: "CONFIG_REMOTE_FETCH_FAILED".to_string(),
                message,
                retryable: true,
            },
        })?;
    String::from_utf8(bytes).map_err(|error| CatalogError {
        code: "CONFIG_REMOTE_UTF8_INVALID".to_string(),
        message: error.to_string(),
        retryable: false,
    })
}

fn ingest_multi_connection(
    connection: &Connection,
    payload: &ConfigCatalogPayload,
    source: &str,
) -> Result<ConfigCatalogSnapshot, CatalogError> {
    let value: Value = serde_json::from_str(&payload.raw)
        .map_err(|error| CatalogError::invalid("CONFIG_MULTI_INVALID", error.to_string()))?;
    let repositories = value
        .get("repositories")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CatalogError::invalid(
                "CONFIG_MULTI_INVALID",
                "multi configuration requires a repositories array",
            )
        })?;
    if repositories.is_empty() {
        return Err(CatalogError::invalid(
            "CONFIG_MULTI_EMPTY",
            "multi configuration requires at least one repository",
        ));
    }
    let mut site_count = 0_usize;
    let mut sites = Vec::new();
    for repository in repositories {
        let child = ConfigCatalogPayload {
            source: repository
                .get("source")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    CatalogError::invalid("CONFIG_MULTI_INVALID", "repository source is required")
                })?
                .to_string(),
            source_kind: repository
                .get("sourceKind")
                .or_else(|| repository.get("source_kind"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    CatalogError::invalid(
                        "CONFIG_MULTI_INVALID",
                        "repository sourceKind is required",
                    )
                })?
                .to_string(),
            raw: repository
                .get("raw")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    CatalogError::invalid("CONFIG_MULTI_INVALID", "repository raw is required")
                })?
                .to_string(),
            fetch_remote: false,
            timeout_ms: payload.timeout_ms,
        };
        let child_snapshot = ingest_connection(connection, &child)?;
        site_count += child_snapshot.site_count;
        sites.extend(child_snapshot.sites);
    }
    let version_hash = digest(&payload.raw);
    connection
        .execute(
            "INSERT OR IGNORE INTO config_versions
             (source, source_kind, version_hash, raw_json, site_count, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                source,
                payload.source_kind,
                version_hash,
                payload.raw,
                site_count as i64,
                now_millis(),
            ],
        )
        .map_err(|error| CatalogError::storage(error.to_string()))?;
    connection
        .execute(
            "INSERT INTO config_sources
             (source, source_kind, active_version_hash, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(source) DO UPDATE SET
               source_kind = excluded.source_kind,
               active_version_hash = excluded.active_version_hash,
               updated_at = excluded.updated_at",
            params![source, payload.source_kind, version_hash, now_millis()],
        )
        .map_err(|error| CatalogError::storage(error.to_string()))?;
    connection
        .execute(
            "DELETE FROM config_versions
             WHERE source = ?1 AND rowid NOT IN (
               SELECT rowid FROM config_versions
               WHERE source = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 3
             )",
            params![source],
        )
        .map_err(|error| CatalogError::storage(error.to_string()))?;
    let valid_version_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM config_versions WHERE source = ?1",
            params![source],
            |row| row.get(0),
        )
        .map_err(|error| CatalogError::storage(error.to_string()))?;
    Ok(ConfigCatalogSnapshot {
        schema_version: "v1".to_string(),
        source: source.to_string(),
        source_kind: payload.source_kind.clone(),
        version_hash,
        site_count,
        used_cache: false,
        valid_version_count: valid_version_count as usize,
        warning_code: None,
        sites,
    })
}

pub fn ensure_schema(connection: &Connection) -> Result<(), CatalogError> {
    connection
        .execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
               version INTEGER PRIMARY KEY
             );
             INSERT OR IGNORE INTO schema_migrations(version) VALUES ({});
             CREATE TABLE IF NOT EXISTS config_sources (
               source TEXT PRIMARY KEY,
               source_kind TEXT NOT NULL,
               active_version_hash TEXT,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS config_versions (
               source TEXT NOT NULL,
               source_kind TEXT NOT NULL,
               version_hash TEXT NOT NULL,
               raw_json TEXT NOT NULL,
               site_count INTEGER NOT NULL,
               created_at INTEGER NOT NULL,
               PRIMARY KEY (source, version_hash)
             );
             CREATE INDEX IF NOT EXISTS idx_config_versions_source_time
                ON config_versions(source, created_at DESC);",
            SCHEMA_VERSION,
        ))
        .map_err(|error| CatalogError::storage(error.to_string()))
}

pub fn parse_config(input: &str) -> Result<(String, usize, Vec<ConfigSiteSummary>), CatalogError> {
    let decoded = decode_config_payload(input)?;
    let (normalized, value) = parse_json_payload(&decoded)?;
    let object = value.as_object().ok_or_else(|| {
        CatalogError::invalid(
            "CONFIG_OBJECT_REQUIRED",
            "configuration must be a JSON object",
        )
    })?;
    let site_count = object
        .get("sites")
        .map(|sites| {
            sites.as_array().ok_or_else(|| {
                CatalogError::invalid(
                    "CONFIG_SITES_INVALID",
                    "configuration sites must be an array",
                )
            })
        })
        .transpose()?
        .map_or(0, Vec::len);
    let sites = extract_site_summaries_from_value(&value);
    Ok((normalized, site_count, sites))
}

fn extract_site_summaries(input: &str) -> Result<Vec<ConfigSiteSummary>, CatalogError> {
    let (_, value) = parse_json_payload(input)?;
    Ok(extract_site_summaries_from_value(&value))
}

fn extract_site_summaries_from_value(value: &Value) -> Vec<ConfigSiteSummary> {
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    let Some(sites) = object.get("sites") else {
        return Vec::new();
    };
    let Some(sites) = sites.as_array() else {
        return Vec::new();
    };
    let mut summaries = Vec::new();
    for (index, site) in sites.iter().enumerate() {
        let Some(site) = site.as_object() else {
            continue;
        };
        let api = site
            .get("api")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if api.is_empty() {
            continue;
        }
        let key = site
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let key = if key.is_empty() {
            api.to_string()
        } else {
            key.to_string()
        };
        let name = site
            .get("name")
            .or_else(|| site.get("title"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let name = if name.is_empty() {
            if key.is_empty() {
                format!("site-{}", index + 1)
            } else {
                key.clone()
            }
        } else {
            name.to_string()
        };
        let site_type = site
            .get("type")
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value).ok())
            .unwrap_or_else(|| infer_site_type(api));
        let ext = site
            .get("ext")
            .and_then(value_string)
            .filter(|value| !value.is_empty());
        summaries.push(ConfigSiteSummary {
            key,
            name,
            api: api.to_string(),
            site_type,
            ext,
        });
    }
    summaries
}

fn parse_json_payload(input: &str) -> Result<(String, Value), CatalogError> {
    match serde_json::from_str(input) {
        Ok(value) => Ok((input.to_string(), value)),
        Err(strict_error) => {
            let normalized = strip_json_comments(input)?;
            let value = serde_json::from_str(&normalized).map_err(|_| {
                CatalogError::invalid("CONFIG_JSON_INVALID", strict_error.to_string())
            })?;
            Ok((normalized, value))
        }
    }
}

fn strip_json_comments(input: &str) -> Result<String, CatalogError> {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let mut in_string = false;
    let mut escaped = false;

    while index < bytes.len() {
        let current = bytes[index];
        if in_string {
            output.push(current);
            if escaped {
                escaped = false;
            } else if current == b'\\' {
                escaped = true;
            } else if current == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }

        if current == b'"' {
            in_string = true;
            output.push(current);
            index += 1;
            continue;
        }

        if current == b'/' && bytes.get(index + 1) == Some(&b'/') {
            output.push(b' ');
            index += 2;
            while index < bytes.len() && bytes[index] != b'\r' && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }

        if current == b'/' && bytes.get(index + 1) == Some(&b'*') {
            output.push(b' ');
            index += 2;
            let mut closed = false;
            while index < bytes.len() {
                if bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/') {
                    index += 2;
                    closed = true;
                    break;
                }
                index += 1;
            }
            if !closed {
                return Err(CatalogError::invalid(
                    "CONFIG_JSON_INVALID",
                    "unterminated JSON block comment",
                ));
            }
            continue;
        }

        if current == b'#' {
            output.push(b' ');
            index += 1;
            while index < bytes.len() && bytes[index] != b'\r' && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }

        output.push(current);
        index += 1;
    }

    String::from_utf8(output)
        .map_err(|error| CatalogError::invalid("CONFIG_JSON_INVALID", error.to_string()))
}

fn value_string(value: &Value) -> Option<String> {
    if let Some(value) = value.as_str() {
        return Some(value.trim().to_string());
    }
    if value.is_object() || value.is_array() {
        return serde_json::to_string(value).ok();
    }
    None
}

fn infer_site_type(api: &str) -> u8 {
    if api.starts_with("http://") || api.starts_with("https://") {
        1
    } else {
        3
    }
}

pub fn decode_config_payload(input: &str) -> Result<String, CatalogError> {
    let trimmed = input.trim().trim_start_matches('\u{feff}');
    if trimmed.to_ascii_lowercase().starts_with("tvbox://") {
        return decode_base64(&trimmed["tvbox://".len()..]);
    }
    if trimmed.starts_with("2423") {
        return decode_fongmi_cbc(trimmed);
    }
    if let Some(marker_index) = double_star_marker(trimmed) {
        return decode_base64(&trimmed[marker_index + 2..]);
    }
    Ok(trimmed.to_string())
}

fn validate_payload(source: &str, source_kind: &str) -> Result<(), CatalogError> {
    normalized_source_required(source)?;
    if !matches!(source_kind, "url" | "file" | "json" | "multi") {
        return Err(CatalogError::invalid(
            "CONFIG_SOURCE_KIND_INVALID",
            "unsupported configuration source kind",
        ));
    }
    Ok(())
}

fn normalized_source_required(source: &str) -> Result<String, CatalogError> {
    let source = normalize_source(source);
    if source.is_empty() {
        return Err(CatalogError::invalid(
            "CONFIG_SOURCE_EMPTY",
            "configuration source is empty",
        ));
    }
    Ok(source)
}

fn latest_version(
    connection: &Connection,
    source: &str,
) -> Result<Option<(String, usize, String)>, CatalogError> {
    connection
        .query_row(
            "SELECT version_hash, site_count, raw_json FROM config_versions
             WHERE source = ?1
             ORDER BY CASE WHEN version_hash = (
               SELECT active_version_hash FROM config_sources WHERE source = ?1
             ) THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT 1",
            params![source],
            |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as usize, row.get(2)?)),
        )
        .optional()
        .map_err(|error| CatalogError::storage(error.to_string()))
}

fn snapshot_from_version(
    connection: &Connection,
    source: &str,
    version_hash: &str,
    source_kind: &str,
    raw_json: &str,
    stored_site_count: usize,
    used_cache: bool,
) -> Result<ConfigCatalogSnapshot, CatalogError> {
    let (_, parsed_site_count, sites) = parse_config(raw_json)?;
    let valid_version_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM config_versions WHERE source = ?1",
            params![source],
            |row| row.get(0),
        )
        .map_err(|error| CatalogError::storage(error.to_string()))?;
    Ok(ConfigCatalogSnapshot {
        schema_version: "v1".to_string(),
        source: source.to_string(),
        source_kind: source_kind.to_string(),
        version_hash: version_hash.to_string(),
        site_count: if parsed_site_count == 0 {
            stored_site_count
        } else {
            parsed_site_count
        },
        used_cache,
        valid_version_count: valid_version_count as usize,
        warning_code: http_warning(source),
        sites,
    })
}

fn decode_base64(value: &str) -> Result<String, CatalogError> {
    let mut normalized = value.replace('-', "+").replace('_', "/");
    while normalized.len() % 4 != 0 {
        normalized.push('=');
    }
    let bytes = STANDARD
        .decode(normalized)
        .map_err(|error| CatalogError::invalid("CONFIG_BASE64_INVALID", error.to_string()))?;
    String::from_utf8(bytes)
        .map_err(|error| CatalogError::invalid("CONFIG_UTF8_INVALID", error.to_string()))
}

fn decode_fongmi_cbc(input: &str) -> Result<String, CatalogError> {
    let compact: String = input
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    if compact.len() % 2 != 0 || !compact.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CatalogError::invalid(
            "CONFIG_FONGMI_HEX_INVALID",
            "FongMi envelope must be even-length hexadecimal",
        ));
    }
    let decoded = hex_decode(&compact)?;
    let key_start = find_bytes(&decoded, b"$#").ok_or_else(|| {
        CatalogError::invalid(
            "CONFIG_FONGMI_KEY_MISSING",
            "FongMi envelope is missing its key marker",
        )
    })?;
    let key_end = find_bytes(&decoded, b"#$").ok_or_else(|| {
        CatalogError::invalid(
            "CONFIG_FONGMI_KEY_MISSING",
            "FongMi envelope is missing its key marker",
        )
    })?;
    if key_end <= key_start + 2 {
        return Err(CatalogError::invalid(
            "CONFIG_FONGMI_KEY_INVALID",
            "FongMi envelope key is empty",
        ));
    }
    let key = pad16(&decoded[key_start + 2..key_end])?;
    let iv_start = decoded.len().saturating_sub(13);
    let iv = pad16(&decoded[iv_start..])?;
    let cipher_start = compact.find("2324").ok_or_else(|| {
        CatalogError::invalid(
            "CONFIG_FONGMI_CIPHER_MISSING",
            "FongMi envelope is missing ciphertext",
        )
    })?;
    let cipher_end = compact.len().saturating_sub(26);
    if cipher_end <= cipher_start + 4 {
        return Err(CatalogError::invalid(
            "CONFIG_FONGMI_CIPHER_INVALID",
            "FongMi ciphertext is empty",
        ));
    }
    let mut ciphertext = hex_decode(&compact[cipher_start + 4..cipher_end])?;
    let decrypted = Aes128CbcDecryptor::new_from_slices(&key, &iv)
        .map_err(|error| CatalogError::invalid("CONFIG_FONGMI_CIPHER_INVALID", error.to_string()))?
        .decrypt_padded_mut::<Pkcs7>(&mut ciphertext)
        .map_err(|error| {
            CatalogError::invalid("CONFIG_FONGMI_DECRYPT_FAILED", error.to_string())
        })?;
    String::from_utf8(decrypted.to_vec())
        .map_err(|error| CatalogError::invalid("CONFIG_UTF8_INVALID", error.to_string()))
}

fn double_star_marker(input: &str) -> Option<usize> {
    let marker = input.find("**")?;
    if marker < 8 {
        return None;
    }
    let prefix = &input.as_bytes()[marker - 8..marker];
    prefix
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric())
        .then_some(marker)
}

fn hex_decode(value: &str) -> Result<Vec<u8>, CatalogError> {
    if value.len() % 2 != 0 {
        return Err(CatalogError::invalid(
            "CONFIG_HEX_INVALID",
            "hex value has odd length",
        ));
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = (pair[0] as char)
                .to_digit(16)
                .ok_or_else(|| CatalogError::invalid("CONFIG_HEX_INVALID", "invalid hex value"))?;
            let low = (pair[1] as char)
                .to_digit(16)
                .ok_or_else(|| CatalogError::invalid("CONFIG_HEX_INVALID", "invalid hex value"))?;
            Ok(((high << 4) | low) as u8)
        })
        .collect()
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn pad16(value: &[u8]) -> Result<Vec<u8>, CatalogError> {
    if value.len() > 16 {
        return Err(CatalogError::invalid(
            "CONFIG_FONGMI_KEY_INVALID",
            "FongMi key or IV is longer than 16 bytes",
        ));
    }
    let mut padded = value.to_vec();
    padded.resize(16, b'0');
    Ok(padded)
}

fn digest(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn normalize_source(source: &str) -> String {
    let source = source.trim();
    let Some(query_index) = source.find('?') else {
        return source.to_string();
    };
    let (base, query) = source.split_at(query_index);
    let safe_query = query[1..]
        .split('&')
        .filter(|part| {
            let key = part
                .split('=')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            !matches!(
                key.as_str(),
                "token" | "access_token" | "refresh_token" | "api_key"
            )
        })
        .collect::<Vec<_>>();
    if safe_query.is_empty() {
        base.to_string()
    } else {
        format!("{base}?{}", safe_query.join("&"))
    }
}

fn http_warning(source: &str) -> Option<String> {
    reqwest::Url::parse(source)
        .ok()
        .filter(|url| url.scheme().eq_ignore_ascii_case("http"))
        .map(|_| "CONFIG_HTTP_UNAUTHENTICATED".to_string())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        activate_connection, decode_config_payload, fetch_remote_config, history_connection,
        ingest_connection, ingest_remote, parse_config, ConfigCatalogPayload,
    };
    use crate::{app_get, jianpian, test_support::bind_loopback_tcp};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
    use rusqlite::Connection;
    use serde_json::json;
    use std::sync::{atomic::AtomicBool, Arc};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn decodes_plain_tvbox_and_double_star_payloads() {
        let json = r#"{"sites":[{"key":"fixture"}]}"#;
        assert_eq!(parse_config(json).expect("plain config").1, 1);
        let encoded = STANDARD.encode(json);
        assert_eq!(
            parse_config(&format!("tvbox://{encoded}"))
                .expect("tvbox config")
                .1,
            1
        );
        assert_eq!(
            parse_config(&format!("ABCDEFGH**{encoded}"))
                .expect("double star config")
                .1,
            1
        );
    }

    #[test]
    fn accepts_public_catalog_comments_without_touching_url_fragments() {
        let raw = r##"{
          // optional spider
          # public catalog note
          /* a block comment between fields */
          "sites": [
            {
              "key": "肥猫",
              "api": "csp_AppGet",
              "ext": "https://bind.315999.xyz/89.txt|#getapp@TMD@2025|120",
              "note": "keep https://example.invalid/#fragment // inside strings"
            } // trailing line comment
          ]
        }"##;

        let (normalized, site_count, sites) = parse_config(raw).expect("commented config");
        assert_eq!(site_count, 1);
        assert_eq!(sites[0].key, "肥猫");
        assert_eq!(
            sites[0].ext.as_deref(),
            Some("https://bind.315999.xyz/89.txt|#getapp@TMD@2025|120")
        );
        assert!(!normalized.contains("optional spider"));
        assert!(normalized.contains("#getapp@TMD@2025"));
    }

    #[test]
    fn rejects_unterminated_public_catalog_comments() {
        let error = parse_config(r#"{"sites":[]} /* unterminated"#)
            .expect_err("unterminated comment must fail closed");
        assert_eq!(error.code, "CONFIG_JSON_INVALID");
    }

    #[test]
    fn rejects_invalid_config_and_falls_back_to_three_latest_versions() {
        let connection = Connection::open_in_memory().expect("memory database");
        for index in 0..4 {
            let payload = ConfigCatalogPayload {
                source: "inline:fixture".to_string(),
                source_kind: "json".to_string(),
                raw: format!(r#"{{"sites":[{{"key":"{index}"}}]}}"#),
                fetch_remote: false,
                timeout_ms: None,
            };
            ingest_connection(&connection, &payload).expect("valid config");
        }
        let fallback = ingest_connection(
            &connection,
            &ConfigCatalogPayload {
                source: "inline:fixture".to_string(),
                source_kind: "json".to_string(),
                raw: "not-json".to_string(),
                fetch_remote: false,
                timeout_ms: None,
            },
        )
        .expect("fallback config");
        assert!(fallback.used_cache);
        assert_eq!(fallback.valid_version_count, 3);
        assert_eq!(fallback.site_count, 1);
    }

    #[test]
    fn lists_versions_and_activates_a_previous_version_for_cache_reads() {
        let connection = Connection::open_in_memory().expect("memory database");
        let first = ingest_connection(
            &connection,
            &ConfigCatalogPayload {
                source: "inline:fixture".to_string(),
                source_kind: "json".to_string(),
                raw: r#"{"sites":[{"key":"first","api":"csp_First"}]}"#.to_string(),
                fetch_remote: false,
                timeout_ms: None,
            },
        )
        .expect("first config");
        let second = ingest_connection(
            &connection,
            &ConfigCatalogPayload {
                source: "inline:fixture".to_string(),
                source_kind: "json".to_string(),
                raw: r#"{"sites":[{"key":"second","api":"csp_Second"}]}"#.to_string(),
                fetch_remote: false,
                timeout_ms: None,
            },
        )
        .expect("second config");

        let history = history_connection(&connection, "inline:fixture").expect("history");
        assert_eq!(history.versions.len(), 2);
        assert_eq!(
            history.active_version_hash.as_deref(),
            Some(second.version_hash.as_str())
        );
        assert!(history
            .versions
            .iter()
            .any(|version| version.version_hash == first.version_hash && !version.active));

        let activated = activate_connection(&connection, "inline:fixture", &first.version_hash)
            .expect("activate previous config");
        assert_eq!(activated.version_hash, first.version_hash);
        assert_eq!(activated.sites[0].key, "first");

        let cached = ingest_connection(
            &connection,
            &ConfigCatalogPayload {
                source: "inline:fixture".to_string(),
                source_kind: "json".to_string(),
                raw: "not-json".to_string(),
                fetch_remote: false,
                timeout_ms: None,
            },
        )
        .expect("selected cache");
        assert!(cached.used_cache);
        assert_eq!(cached.version_hash, first.version_hash);
        assert_eq!(
            history_connection(&connection, "inline:fixture")
                .expect("updated history")
                .active_version_hash
                .as_deref(),
            Some(first.version_hash.as_str())
        );
    }

    #[test]
    fn strips_credential_query_parameters_before_persisting_source() {
        let connection = Connection::open_in_memory().expect("memory database");
        let snapshot = ingest_connection(
            &connection,
            &ConfigCatalogPayload {
                source: "https://example.invalid/config.json?token=secret&lang=zh".to_string(),
                source_kind: "url".to_string(),
                raw: r#"{"sites":[]}"#.to_string(),
                fetch_remote: false,
                timeout_ms: None,
            },
        )
        .expect("config");
        assert_eq!(
            snapshot.source,
            "https://example.invalid/config.json?lang=zh"
        );
    }

    #[test]
    fn keeps_a_v1_schema_marker() {
        let connection = Connection::open_in_memory().expect("memory database");
        ingest_connection(
            &connection,
            &ConfigCatalogPayload {
                source: "inline:fixture".to_string(),
                source_kind: "json".to_string(),
                raw: r#"{"sites":[]}"#.to_string(),
                fetch_remote: false,
                timeout_ms: None,
            },
        )
        .expect("config");
        let version: i64 = connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("schema marker");
        assert_eq!(version, 1);
    }

    #[test]
    fn removes_the_bom_from_plain_json() {
        assert_eq!(
            decode_config_payload("\u{feff}{\"sites\":[]}").expect("bom"),
            "{\"sites\":[]}"
        );
    }

    #[test]
    fn ingests_multiple_repositories_and_sums_their_site_counts() {
        let connection = Connection::open_in_memory().expect("memory database");
        let raw = json!({
            "repositories": [
                { "source": "inline:one", "sourceKind": "json", "raw": "{\"sites\":[{\"key\":\"one\"}]}" },
                { "source": "inline:two", "sourceKind": "json", "raw": "{\"sites\":[{\"key\":\"two\"},{\"key\":\"three\"}]}" }
            ]
        })
        .to_string();
        let snapshot = ingest_connection(
            &connection,
            &ConfigCatalogPayload {
                source: "multi:fixture".to_string(),
                source_kind: "multi".to_string(),
                raw,
                fetch_remote: false,
                timeout_ms: None,
            },
        )
        .expect("multi config");
        assert_eq!(snapshot.site_count, 3);
        assert_eq!(snapshot.source_kind, "multi");
        assert_eq!(snapshot.valid_version_count, 1);
    }

    #[test]
    fn marks_plain_http_config_as_unauthenticated_warning() {
        let connection = Connection::open_in_memory().expect("memory database");
        let snapshot = ingest_connection(
            &connection,
            &ConfigCatalogPayload {
                source: "http://example.invalid/config.json".to_string(),
                source_kind: "url".to_string(),
                raw: r#"{"sites":[]}"#.to_string(),
                fetch_remote: false,
                timeout_ms: None,
            },
        )
        .expect("config");
        assert_eq!(
            snapshot.warning_code.as_deref(),
            Some("CONFIG_HTTP_UNAUTHENTICATED")
        );
    }

    #[tokio::test]
    async fn remote_refresh_uses_the_last_good_cache_when_fetch_fails() {
        let path = std::env::temp_dir().join(format!("qx-config-{}.sqlite3", uuid::Uuid::new_v4()));
        let cached = ConfigCatalogPayload {
            source: "http://127.0.0.1:1/config.json".to_string(),
            source_kind: "url".to_string(),
            raw: r#"{"sites":[{"key":"cached"}]}"#.to_string(),
            fetch_remote: false,
            timeout_ms: Some(1_000),
        };
        ingest_connection(&Connection::open(&path).expect("cache database"), &cached)
            .expect("cache config");
        let refreshed = ingest_remote(
            &path,
            &ConfigCatalogPayload {
                raw: String::new(),
                fetch_remote: true,
                ..cached.clone()
            },
        )
        .await
        .expect("cached refresh");
        assert!(refreshed.used_cache);
        assert_eq!(refreshed.site_count, 1);
        assert_eq!(
            refreshed.warning_code.as_deref(),
            Some("CONFIG_HTTP_UNAUTHENTICATED")
        );
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn remote_config_retries_a_proxy_502_once_without_changing_the_request() {
        let origin = bind_loopback_tcp().await.expect("bind config origin");
        let origin_address = origin.local_addr().expect("config origin address");
        let proxy = bind_loopback_tcp().await.expect("bind config proxy");
        let proxy_address = proxy.local_addr().expect("config proxy address");
        let source = format!("http://{origin_address}/config.json");

        let proxy_source = source.clone();
        let proxy_task = tokio::spawn(async move {
            let (mut socket, _) = proxy.accept().await.expect("accept proxied config request");
            let mut buffer = vec![0u8; 4096];
            let read = socket
                .read(&mut buffer)
                .await
                .expect("read proxied request");
            let request = String::from_utf8_lossy(&buffer[..read]);
            assert!(request.starts_with(&format!("GET {proxy_source} HTTP/1.1\r\n")));
            assert!(request
                .to_ascii_lowercase()
                .contains("user-agent: qx-yingshi/1.0 config-catalog\r\n"));
            socket
                .write_all(
                    b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("write proxy failure");
        });

        let origin_task = tokio::spawn(async move {
            let (mut socket, _) = origin.accept().await.expect("accept direct config request");
            let mut buffer = vec![0u8; 4096];
            let read = socket.read(&mut buffer).await.expect("read direct request");
            let request = String::from_utf8_lossy(&buffer[..read]);
            assert!(request.starts_with("GET /config.json HTTP/1.1\r\n"));
            assert!(request
                .to_ascii_lowercase()
                .contains("user-agent: qx-yingshi/1.0 config-catalog\r\n"));
            let body = br#"{"sites":[{"key":"direct"}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write direct config headers");
            socket
                .write_all(body)
                .await
                .expect("write direct config body");
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_address}")).expect("proxy URL"))
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .expect("proxy config client");
        let raw = fetch_remote_config(&source, &client, Duration::from_secs(2), true)
            .await
            .expect("proxy 502 falls back to the same direct config request");
        assert_eq!(raw, r#"{"sites":[{"key":"direct"}]}"#);
        proxy_task.await.expect("proxy fixture completes");
        origin_task.await.expect("origin fixture completes");
    }

    #[tokio::test]
    async fn remote_config_follows_a_limited_redirect() {
        let origin = bind_loopback_tcp().await.expect("bind config origin");
        let origin_address = origin.local_addr().expect("config origin address");
        let redirector = bind_loopback_tcp().await.expect("bind config redirector");
        let redirector_address = redirector
            .local_addr()
            .expect("config redirector address");
        let source = format!("http://{redirector_address}/config.json");
        let target = format!("http://{origin_address}/config.json");

        let redirect_task = tokio::spawn(async move {
            let (mut socket, _) = redirector.accept().await.expect("accept redirect request");
            let mut buffer = [0u8; 4096];
            socket.read(&mut buffer).await.expect("read redirect request");
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write redirect response");
        });
        let origin_task = tokio::spawn(async move {
            let (mut socket, _) = origin.accept().await.expect("accept redirected request");
            let mut buffer = [0u8; 4096];
            socket.read(&mut buffer).await.expect("read redirected request");
            let body = br#"{"sites":[{"key":"redirected"}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write redirected config");
            socket.write_all(body).await.expect("write redirected body");
        });

        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::limited(5))
            .timeout(Duration::from_secs(2))
            .build()
            .expect("redirect config client");
        let raw = fetch_remote_config(&source, &client, Duration::from_secs(2), false)
            .await
            .expect("limited redirect should be followed");
        assert_eq!(raw, r#"{"sites":[{"key":"redirected"}]}"#);
        redirect_task.await.expect("redirect fixture completes");
        origin_task.await.expect("origin fixture completes");
    }

    #[tokio::test]
    async fn remote_config_retries_when_the_response_body_is_truncated() {
        let server = bind_loopback_tcp().await.expect("bind truncated config server");
        let address = server.local_addr().expect("truncated config address");
        let source = format!("http://{address}/config.json");
        let server_task = tokio::spawn(async move {
            for attempt in 0..2 {
                let (mut socket, _) = server.accept().await.expect("accept config request");
                let mut buffer = [0u8; 4096];
                socket.read(&mut buffer).await.expect("read config request");
                if attempt == 0 {
                    socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\n{\"sit\r\n",
                        )
                        .await
                        .expect("write truncated response");
                } else {
                    let body = br#"{"sites":[{"key":"retried"}]}"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    socket
                        .write_all(response.as_bytes())
                        .await
                        .expect("write retry headers");
                    socket.write_all(body).await.expect("write retry body");
                }
            }
        });

        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::limited(5))
            .timeout(Duration::from_secs(2))
            .build()
            .expect("truncated config client");
        let raw = fetch_remote_config(&source, &client, Duration::from_secs(2), true)
            .await
            .expect("truncated response should be retried");
        assert_eq!(raw, r#"{"sites":[{"key":"retried"}]}"#);
        server_task.await.expect("truncated config fixture completes");
    }

    #[tokio::test]
    async fn remote_config_does_not_bypass_a_non_retryable_proxy_status() {
        let origin = bind_loopback_tcp()
            .await
            .expect("bind unused config origin");
        let origin_address = origin.local_addr().expect("unused config origin address");
        let proxy = bind_loopback_tcp()
            .await
            .expect("bind rejecting config proxy");
        let proxy_address = proxy.local_addr().expect("rejecting config proxy address");
        let source = format!("http://{origin_address}/config.json");

        let proxy_task = tokio::spawn(async move {
            let (mut socket, _) = proxy
                .accept()
                .await
                .expect("accept rejected config request");
            let mut buffer = vec![0u8; 4096];
            let _ = socket
                .read(&mut buffer)
                .await
                .expect("read rejected request");
            socket
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("write rejected status");
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::http(format!("http://{proxy_address}")).expect("proxy URL"))
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .expect("rejecting proxy client");
        let error = fetch_remote_config(&source, &client, Duration::from_secs(2), true)
            .await
            .expect_err("404 must not bypass the configured proxy");
        assert_eq!(error.code, "CONFIG_REMOTE_FETCH_FAILED");
        assert!(
            error.message.contains("404 Not Found"),
            "unexpected proxy error: {}",
            error.message
        );
        proxy_task.await.expect("rejecting proxy fixture completes");
        assert!(
            tokio::time::timeout(Duration::from_millis(100), origin.accept())
                .await
                .is_err(),
            "non-retryable proxy status must not reach the direct origin"
        );
    }

    #[tokio::test]
    #[ignore = "real Feimao refresh and Jianpian playback canary; run explicitly"]
    async fn real_feimao_refreshes_three_times_and_completes_native_jianpian_chain() {
        let source = std::env::var("QX_FEIMAO_CANARY_URL")
            .unwrap_or_else(|_| "http://xn--z7x900a.net/".to_string());
        let path =
            std::env::temp_dir().join(format!("qx-feimao-canary-{}.sqlite3", uuid::Uuid::new_v4()));
        let payload = ConfigCatalogPayload {
            source,
            source_kind: "url".to_string(),
            raw: String::new(),
            fetch_remote: true,
            timeout_ms: Some(30_000),
        };

        let mut snapshots = Vec::new();
        for _ in 0..3 {
            snapshots.push(
                ingest_remote(&path, &payload)
                    .await
                    .expect("Feimao refresh"),
            );
        }
        assert!(snapshots.iter().all(|snapshot| snapshot.site_count > 0));
        assert!(snapshots
            .iter()
            .all(|snapshot| snapshot.valid_version_count <= 3));

        let jianpian_site = snapshots
            .last()
            .and_then(|snapshot| {
                snapshot
                    .sites
                    .iter()
                    .find(|site| site.api == "csp_Jianpian")
            })
            .expect("Feimao config must contain csp_Jianpian");
        let endpoint = jianpian_site.ext.as_deref().expect("Jianpian ext");
        let cancelled = Arc::new(AtomicBool::new(false));
        let headers = HeaderMap::new();
        let timeout = Duration::from_secs(30);
        jianpian::call("init", None, endpoint, &headers, timeout, cancelled.clone())
            .await
            .expect("Jianpian init");
        let home = jianpian::call("home", None, endpoint, &headers, timeout, cancelled.clone())
            .await
            .expect("Jianpian home");
        let home_card = home["list"]
            .as_array()
            .and_then(|items| items.first())
            .expect("Jianpian home card");
        assert!(home_card["vod_id"]
            .as_str()
            .is_some_and(|value| !value.trim().is_empty()));
        assert!(home_card["vod_name"]
            .as_str()
            .is_some_and(|value| !value.trim().is_empty()));
        let poster = home_card["vod_pic"]
            .as_str()
            .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
            .expect("Jianpian absolute home poster");
        let image_response = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout)
            .build()
            .expect("Jianpian image client")
            .get(poster)
            .send()
            .await
            .expect("Jianpian home poster request");
        assert!(
            image_response.status().is_success(),
            "Jianpian home poster returned {}",
            image_response.status()
        );
        let image_bytes = image_response
            .bytes()
            .await
            .expect("Jianpian home poster bytes");
        assert!(
            image_bytes.starts_with(&[0xff, 0xd8, 0xff])
                || image_bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
                || image_bytes.starts_with(b"GIF87a")
                || image_bytes.starts_with(b"GIF89a")
                || (image_bytes.len() >= 12
                    && image_bytes.starts_with(b"RIFF")
                    && &image_bytes[8..12] == b"WEBP"),
            "Jianpian home poster must contain recognized image bytes"
        );
        let search = jianpian::call(
            "search",
            Some(&json!({ "key": "流浪地球", "page": 1 })),
            endpoint,
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("Jianpian search");
        let id = search["list"][0]["vod_id"]
            .as_str()
            .expect("Jianpian search id");
        let detail = jianpian::call(
            "detail",
            Some(&json!({ "ids": [id] })),
            endpoint,
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("Jianpian detail");
        let episode = detail["list"][0]["vod_play_url"]
            .as_str()
            .and_then(|value| value.split('$').nth(1))
            .expect("Jianpian episode");
        let player = jianpian::call(
            "player",
            Some(&json!({ "id": episode })),
            endpoint,
            &headers,
            timeout,
            cancelled,
        )
        .await
        .expect("Jianpian player");
        assert_eq!(player["parse"], 0);
        assert!(player["url"]
            .as_str()
            .is_some_and(|url| url.starts_with("http")));
        let media_url = player["url"].as_str().expect("Jianpian player URL");
        let mut media_headers = HeaderMap::new();
        for (name, value) in player["header"].as_object().into_iter().flatten() {
            let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
                continue;
            };
            let Some(value) = value.as_str() else {
                continue;
            };
            let Ok(value) = HeaderValue::from_str(value) else {
                continue;
            };
            media_headers.insert(name, value);
        }
        let media_client = reqwest::Client::builder()
            .default_headers(media_headers)
            .timeout(timeout)
            .build()
            .expect("Jianpian media client");
        let mut media_response = media_client
            .get(media_url)
            .send()
            .await
            .expect("Jianpian media request");
        assert!(
            media_response.status().is_success()
                || media_response.status() == reqwest::StatusCode::PARTIAL_CONTENT,
            "Jianpian media returned {}",
            media_response.status()
        );
        let content_type = media_response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let first_chunk = media_response
            .chunk()
            .await
            .expect("Jianpian media first chunk")
            .expect("Jianpian media must return a non-empty first chunk");
        let is_hls = content_type.contains("mpegurl") || first_chunk.starts_with(b"#EXTM3U");
        if is_hls {
            let mut playlist_url =
                reqwest::Url::parse(media_url).expect("Jianpian media URL parses");
            let mut playlist =
                read_bounded_body(&mut media_response, first_chunk.to_vec(), 1024 * 1024)
                    .await
                    .expect("Jianpian HLS manifest body");
            let mut media_sample = None;
            let mut media_content_type = String::new();
            let mut encryption_key = None;
            for _ in 0..3 {
                let manifest =
                    std::str::from_utf8(&playlist).expect("Jianpian HLS manifest must be UTF-8");
                assert!(
                    manifest.contains("#EXTM3U"),
                    "Jianpian HLS response must contain an HLS manifest"
                );
                if let Some(key_line) = manifest
                    .lines()
                    .map(str::trim)
                    .find(|line| line.starts_with("#EXT-X-KEY:"))
                {
                    let method = key_line
                        .split_once("METHOD=")
                        .and_then(|(_, value)| value.split([',', '\n']).next())
                        .unwrap_or_default();
                    assert_eq!(method, "AES-128", "Jianpian HLS key method must be AES-128");
                    let key_uri = key_line
                        .split_once("URI=\"")
                        .and_then(|(_, value)| value.split('\"').next())
                        .expect("Jianpian HLS AES key URI");
                    let key_url = playlist_url
                        .join(key_uri)
                        .expect("Jianpian HLS key URI resolves");
                    let key_response = media_client
                        .get(key_url)
                        .send()
                        .await
                        .expect("Jianpian HLS key request")
                        .error_for_status()
                        .expect("Jianpian HLS key status");
                    let key_bytes = key_response.bytes().await.expect("Jianpian HLS key bytes");
                    assert_eq!(
                        key_bytes.len(),
                        16,
                        "Jianpian HLS AES-128 key must be 16 bytes"
                    );
                    encryption_key = Some(key_bytes.len());
                }
                let uri = manifest
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty() && !line.starts_with('#'))
                    .expect("Jianpian HLS manifest must contain a media URI");
                let next_url = playlist_url.join(uri).expect("Jianpian HLS URI resolves");
                let response = media_client
                    .get(next_url.clone())
                    .send()
                    .await
                    .expect("Jianpian HLS child request");
                assert!(
                    response.status().is_success()
                        || response.status() == reqwest::StatusCode::PARTIAL_CONTENT,
                    "Jianpian HLS child returned {}",
                    response.status()
                );
                let child_type = response
                    .headers()
                    .get(CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let mut response = response;
                let first_child = response
                    .chunk()
                    .await
                    .expect("Jianpian HLS child first chunk")
                    .expect("Jianpian HLS child body is empty");
                let child_is_playlist = next_url.path().to_ascii_lowercase().ends_with(".m3u8")
                    || child_type.contains("mpegurl")
                    || child_type.contains("x-mpegurl")
                    || first_child.starts_with(b"#EXTM3U");
                if child_is_playlist {
                    playlist_url = next_url;
                    playlist = read_bounded_body(&mut response, first_child.to_vec(), 1024 * 1024)
                        .await
                        .expect("Jianpian HLS child manifest body");
                    continue;
                }
                media_content_type = child_type;
                media_sample = Some(first_child.to_vec());
                break;
            }
            let sample = media_sample.expect("Jianpian HLS must reach a media segment");
            if encryption_key.is_some() {
                assert!(
                    !sample.is_empty(),
                    "Jianpian encrypted HLS media segment is empty"
                );
            } else {
                assert!(
                    recognized_media_sample(&media_content_type, &sample),
                    "Jianpian HLS media segment must have a recognized media signature"
                );
            }
        } else {
            assert!(
                recognized_media_sample(&content_type, &first_chunk),
                "Jianpian media must return a recognized progressive media response, not {content_type:?}"
            );
        }
        let _ = std::fs::remove_file(path);
    }

    async fn read_bounded_body(
        response: &mut reqwest::Response,
        mut body: Vec<u8>,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        if body.len() > limit
            || response
                .content_length()
                .is_some_and(|length| length > limit as u64)
        {
            return Err(format!("response exceeds {limit} bytes"));
        }
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            if body.len().saturating_add(chunk.len()) > limit {
                return Err(format!("response exceeds {limit} bytes"));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }

    fn recognized_media_sample(content_type: &str, sample: &[u8]) -> bool {
        content_type.starts_with("video/")
            || content_type.starts_with("audio/")
            || sample.starts_with(&[0x47])
            || (sample.len() >= 8
                && (&sample[4..8] == b"ftyp"
                    || &sample[4..8] == b"styp"
                    || &sample[4..8] == b"moof"))
            || sample.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
            || sample.starts_with(b"ID3")
            || sample.starts_with(&[0xff, 0xf1])
            || sample.starts_with(&[0xff, 0xf9])
    }

    #[tokio::test]
    #[ignore = "real Feimao AppGet search/detail/player canary; run explicitly"]
    async fn real_feimao_config_completes_appget_read_and_player_chain() {
        let source = std::env::var("QX_FEIMAO_CANARY_URL")
            .unwrap_or_else(|_| "http://xn--z7x900a.net/".to_string());
        let path =
            std::env::temp_dir().join(format!("qx-feimao-appget-{}.sqlite3", uuid::Uuid::new_v4()));
        let snapshot = ingest_remote(
            &path,
            &ConfigCatalogPayload {
                source,
                source_kind: "url".to_string(),
                raw: String::new(),
                fetch_remote: true,
                timeout_ms: Some(30_000),
            },
        )
        .await
        .expect("Feimao refresh");
        let app_get_sites = snapshot
            .sites
            .iter()
            .filter(|site| site.api.eq_ignore_ascii_case("csp_AppGet"))
            .collect::<Vec<_>>();
        assert!(
            !app_get_sites.is_empty(),
            "Feimao config must contain csp_AppGet sites"
        );
        for site in &app_get_sites {
            app_get::from_ext(site.ext.as_deref().expect("AppGet ext"))
                .expect("AppGet ext parses")
                .expect("AppGet ext contains a fixed AES key");
        }
        let requested_site = std::env::var("QX_APPGET_CANARY_SITE").ok();
        let site = app_get_sites
            .into_iter()
            .find(|site| {
                requested_site.as_deref().map_or_else(
                    || site.name.contains("肥猫"),
                    |name| site.name.contains(name),
                )
            })
            .unwrap_or_else(|| {
                panic!(
                    "Feimao config must contain the requested csp_AppGet site: {}",
                    requested_site.as_deref().unwrap_or("肥猫")
                )
            });
        let config = app_get::from_ext(site.ext.as_deref().expect("AppGet ext"))
            .expect("AppGet ext parses")
            .expect("AppGet ext contains a fixed AES key");
        let headers = HeaderMap::new();
        let timeout = Duration::from_secs(30);
        let cancelled = Arc::new(AtomicBool::new(false));

        let home = app_get::call(&config, "home", None, &headers, timeout, cancelled.clone())
            .await
            .expect("AppGet home");
        assert!(home["class"].is_array());

        let explicit_search_key = std::env::var("QX_APPGET_CANARY_KEY").ok();
        let mut search_keys = explicit_search_key.clone().into_iter().collect::<Vec<_>>();
        if search_keys.is_empty() {
            search_keys.extend(["流浪地球", "斗破苍穹"].into_iter().map(str::to_string));
            if let Some(home_title) = home["list"]
                .as_array()
                .and_then(|items| items.first())
                .and_then(|item| item["vod_name"].as_str())
                .filter(|value| !value.trim().is_empty())
            {
                search_keys.push(home_title.to_string());
            }
        }
        let mut search = None;
        let mut last_search_error = None;
        for search_key in &search_keys {
            match app_get::call(
                &config,
                "search",
                Some(&json!({"key":search_key,"page":1})),
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            {
                Ok(value)
                    if value["list"]
                        .as_array()
                        .is_some_and(|items| !items.is_empty()) =>
                {
                    search = Some(value);
                    break;
                }
                Ok(_) => {
                    last_search_error = Some(format!("{search_key}: empty result"));
                }
                Err(error) => {
                    let message = format!("{error:?}");
                    if message.contains("_AUTH_REQUIRED") || explicit_search_key.is_some() {
                        panic!("AppGet search ({search_key}): {message}");
                    }
                    last_search_error = Some(format!("{search_key}: {message}"));
                }
            }
        }
        let search = search.unwrap_or_else(|| {
            panic!(
                "AppGet site {} returned no search result; tried {:?}; last error: {}",
                site.name,
                search_keys,
                last_search_error.unwrap_or_else(|| "unknown".to_string())
            )
        });
        let id = search["list"][0]["vod_id"]
            .as_str()
            .expect("AppGet search id");
        let detail = app_get::call(
            &config,
            "detail",
            Some(&json!({"ids":[id]})),
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("AppGet detail");
        let episodes = detail["vod_play_url"]
            .as_str()
            .expect("AppGet play URLs")
            .split("$$$")
            .flat_map(|line| line.split('#'))
            .take(256)
            .collect::<Vec<_>>();
        assert!(!episodes.is_empty(), "AppGet detail must contain episodes");
        let mut resolved = None;
        let mut last_player_error = None;
        for episode in episodes {
            match app_get::call(
                &config,
                "player",
                Some(&json!({"id":episode})),
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            {
                Ok(player)
                    if player["parse"] == 0
                        && player["url"].as_str().is_some_and(|url| {
                            url.starts_with("http://") || url.starts_with("https://")
                        }) =>
                {
                    resolved = Some(player);
                    break;
                }
                Ok(_) => last_player_error = Some("player returned no direct URL".to_string()),
                Err(error) => last_player_error = Some(format!("{error:?}")),
            }
        }
        assert!(
            resolved.is_some(),
            "AppGet site {} did not expose a playable episode within the bounded canary; last player result: {}",
            site.name,
            last_player_error.unwrap_or_else(|| "none".to_string())
        );
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    #[ignore = "real public AppGet mirror read/detail/player/media canary; network-dependent"]
    async fn real_public_appget_mirror_completes_read_detail_and_media_chain() {
        let config = app_get::from_ext("https://bind.315999.xyz/89.txt|#getapp@TMD@2025|120")
            .expect("public AppGet mirror ext parses")
            .expect("public AppGet mirror ext contains a fixed AES key");
        let headers = HeaderMap::new();
        let timeout = Duration::from_secs(30);
        let cancelled = Arc::new(AtomicBool::new(false));

        let home = app_get::call(&config, "home", None, &headers, timeout, cancelled.clone())
            .await
            .expect("public AppGet mirror home");
        assert!(home["class"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));

        let mut search = None;
        for key in ["流浪地球", "斗破苍穹", "凡人修仙传"] {
            match app_get::call(
                &config,
                "search",
                Some(&json!({"key": key, "page": 1})),
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            {
                Ok(value)
                    if value["list"]
                        .as_array()
                        .is_some_and(|items| !items.is_empty()) =>
                {
                    search = Some(value);
                    break;
                }
                Ok(_) | Err(_) => {}
            }
        }
        let search = search.expect("public AppGet mirror search result");
        let mut episodes = Vec::new();
        for item in search["list"].as_array().into_iter().flatten().take(12) {
            let Some(id) = item["vod_id"].as_str() else {
                continue;
            };
            let Ok(detail) = app_get::call(
                &config,
                "detail",
                Some(&json!({"ids": [id]})),
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            else {
                continue;
            };
            let Some(value) = detail["vod_play_url"].as_str() else {
                continue;
            };
            episodes = value
                .split("$$$")
                .flat_map(|line| line.split('#'))
                .filter(|episode| !episode.trim().is_empty())
                .map(str::to_string)
                .take(32)
                .collect();
            if !episodes.is_empty() {
                break;
            }
        }
        assert!(
            !episodes.is_empty(),
            "public AppGet mirror detail has no episodes"
        );

        let media_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout)
            .build()
            .expect("public AppGet mirror media client");
        let mut verified = false;
        for episode in episodes {
            let Ok(player) = app_get::call(
                &config,
                "player",
                Some(&json!({"id": episode})),
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            else {
                continue;
            };
            let Some(url) = player["url"].as_str() else {
                continue;
            };
            if player["parse"] != 0 || !(url.starts_with("http://") || url.starts_with("https://"))
            {
                continue;
            }
            let Ok(mut response) = media_client
                .get(url)
                .header("range", "bytes=0-31")
                .send()
                .await
            else {
                continue;
            };
            if !(response.status().is_success()
                || response.status() == reqwest::StatusCode::PARTIAL_CONTENT)
            {
                continue;
            }
            let status = response.status();
            let first_chunk_bytes = response
                .chunk()
                .await
                .ok()
                .flatten()
                .map(|chunk| chunk.len())
                .unwrap_or_default();
            if first_chunk_bytes > 0 {
                eprintln!(
                    "public AppGet mirror media range verified: status={} bytes={first_chunk_bytes}",
                    status.as_u16()
                );
                verified = true;
                break;
            }
        }
        assert!(
            verified,
            "public AppGet mirror did not expose a direct media URL with a readable first range"
        );
    }

    #[tokio::test]
    #[ignore = "real Feimao AppQi home/category/search/detail/player canary; run explicitly"]
    async fn real_feimao_config_completes_appqi_read_and_player_chains() {
        let source = std::env::var("QX_FEIMAO_CANARY_URL")
            .unwrap_or_else(|_| "http://xn--z7x900a.net/".to_string());
        let path =
            std::env::temp_dir().join(format!("qx-feimao-appqi-{}.sqlite3", uuid::Uuid::new_v4()));
        let snapshot = ingest_remote(
            &path,
            &ConfigCatalogPayload {
                source,
                source_kind: "url".to_string(),
                raw: String::new(),
                fetch_remote: true,
                timeout_ms: Some(30_000),
            },
        )
        .await
        .expect("Feimao refresh");
        let requested_site = std::env::var("QX_APPQI_CANARY_SITE").ok();
        let sites = snapshot
            .sites
            .iter()
            .filter(|site| site.api.eq_ignore_ascii_case("csp_AppQi"))
            .filter(|site| {
                requested_site
                    .as_deref()
                    .is_none_or(|name| site.name.contains(name))
            })
            .collect::<Vec<_>>();
        if requested_site.is_none() {
            assert_eq!(
                sites.len(),
                2,
                "Feimao config must contain both AppQi sites"
            );
        } else {
            assert!(!sites.is_empty(), "requested AppQi site must exist");
        }

        let headers = HeaderMap::new();
        let timeout = Duration::from_secs(30);
        for site in sites {
            eprintln!("AppQi canary site: {}", site.name);
            let config =
                app_get::from_ext_for("csp_AppQi", site.ext.as_deref().expect("AppQi ext"))
                    .expect("AppQi ext parses")
                    .expect("AppQi ext contains a fixed AES key");
            let cancelled = Arc::new(AtomicBool::new(false));
            let home = app_get::call(&config, "home", None, &headers, timeout, cancelled.clone())
                .await
                .unwrap_or_else(|error| panic!("AppQi {} home: {error:?}", site.name));
            let type_id = home["class"][0]["type_id"]
                .as_str()
                .expect("AppQi home type id");
            let category = app_get::call(
                &config,
                "category",
                Some(&json!({"typeId":type_id,"page":1})),
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            .expect("AppQi category");
            assert!(category["list"].is_array());

            let search_key = home["list"][0]["vod_name"]
                .as_str()
                .expect("AppQi home title");
            let search = app_get::call(
                &config,
                "search",
                Some(&json!({"key":search_key,"page":1})),
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            .expect("AppQi search");
            let id = search["list"][0]["vod_id"]
                .as_str()
                .expect("AppQi search id");
            let detail = app_get::call(
                &config,
                "detail",
                Some(&json!({"ids":[id]})),
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            .expect("AppQi detail");
            let episodes = detail["vod_play_url"]
                .as_str()
                .expect("AppQi play URLs")
                .split("$$$")
                .flat_map(|line| line.split('#'))
                .take(24)
                .collect::<Vec<_>>();
            assert!(!episodes.is_empty(), "AppQi detail must contain episodes");

            let mut resolved = None;
            for episode in episodes {
                if let Ok(player) = app_get::call(
                    &config,
                    "player",
                    Some(&json!({"id":episode})),
                    &headers,
                    timeout,
                    cancelled.clone(),
                )
                .await
                {
                    if player["parse"] == 0
                        && player["url"].as_str().is_some_and(|url| {
                            url.starts_with("http://") || url.starts_with("https://")
                        })
                    {
                        resolved = Some(player);
                        break;
                    }
                }
            }
            assert!(
                resolved.is_some(),
                "AppQi site {} did not expose a playable episode within the bounded canary",
                site.name
            );
        }
        let _ = std::fs::remove_file(path);
    }
}
