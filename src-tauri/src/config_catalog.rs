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
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| CatalogError::storage(error.to_string()))?;
    let fetched = async {
        let response = client
            .get(&source)
            .header(reqwest::header::USER_AGENT, "QX-Yingshi/1.0 config-catalog")
            .send()
            .await
            .map_err(|error| CatalogError {
                code: "CONFIG_REMOTE_FETCH_FAILED".to_string(),
                message: error.to_string(),
                retryable: true,
            })?;
        if !response.status().is_success() {
            return Err(CatalogError {
                code: "CONFIG_REMOTE_FETCH_FAILED".to_string(),
                message: format!("remote configuration returned {}", response.status()),
                retryable: true,
            });
        }
        let bytes = response.bytes().await.map_err(|error| CatalogError {
            code: "CONFIG_REMOTE_FETCH_FAILED".to_string(),
            message: error.to_string(),
            retryable: true,
        })?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(CatalogError {
                code: "CONFIG_REMOTE_RESPONSE_TOO_LARGE".to_string(),
                message: "remote configuration exceeds 8 MiB".to_string(),
                retryable: false,
            });
        }
        String::from_utf8(bytes.to_vec()).map_err(|error| CatalogError {
            code: "CONFIG_REMOTE_UTF8_INVALID".to_string(),
            message: error.to_string(),
            retryable: false,
        })
    }
    .await;

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
    let value: Value = serde_json::from_str(&decoded)
        .map_err(|error| CatalogError::invalid("CONFIG_JSON_INVALID", error.to_string()))?;
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
    let sites = extract_site_summaries(&decoded)?;
    Ok((decoded, site_count, sites))
}

fn extract_site_summaries(input: &str) -> Result<Vec<ConfigSiteSummary>, CatalogError> {
    let value: Value = serde_json::from_str(input)
        .map_err(|error| CatalogError::invalid("CONFIG_JSON_INVALID", error.to_string()))?;
    let object = value.as_object().ok_or_else(|| {
        CatalogError::invalid(
            "CONFIG_OBJECT_REQUIRED",
            "configuration must be a JSON object",
        )
    })?;
    let Some(sites) = object.get("sites") else {
        return Ok(Vec::new());
    };
    let sites = sites.as_array().ok_or_else(|| {
        CatalogError::invalid(
            "CONFIG_SITES_INVALID",
            "configuration sites must be an array",
        )
    })?;
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
    Ok(summaries)
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
    if source.is_empty() {
        return Err(CatalogError::invalid(
            "CONFIG_SOURCE_EMPTY",
            "configuration source is empty",
        ));
    }
    if !matches!(source_kind, "url" | "file" | "json" | "multi") {
        return Err(CatalogError::invalid(
            "CONFIG_SOURCE_KIND_INVALID",
            "unsupported configuration source kind",
        ));
    }
    Ok(())
}

fn latest_version(
    connection: &Connection,
    source: &str,
) -> Result<Option<(String, usize, String)>, CatalogError> {
    connection
        .query_row(
            "SELECT version_hash, site_count, raw_json FROM config_versions
             WHERE source = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1",
            params![source],
            |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as usize, row.get(2)?)),
        )
        .optional()
        .map_err(|error| CatalogError::storage(error.to_string()))
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
        decode_config_payload, ingest_connection, ingest_remote, parse_config, ConfigCatalogPayload,
    };
    use crate::jianpian;
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use reqwest::header::HeaderMap;
    use rusqlite::Connection;
    use serde_json::json;
    use std::sync::{atomic::AtomicBool, Arc};
    use std::time::Duration;

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
        let _ = std::fs::remove_file(path);
    }
}
