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

    let parsed = parse_config(&payload.raw);
    let (version_hash, site_count, used_cache) = match parsed {
        Ok((decoded, site_count)) => {
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
            (version_hash, site_count, false)
        }
        Err(error) => match latest_version(connection, &source)? {
            Some((version_hash, site_count)) => (version_hash, site_count, true),
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

    Ok(ConfigCatalogSnapshot {
        schema_version: "v1".to_string(),
        source,
        source_kind: payload.source_kind.clone(),
        version_hash,
        site_count,
        used_cache,
        valid_version_count: valid_version_count as usize,
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

pub fn parse_config(input: &str) -> Result<(String, usize), CatalogError> {
    let decoded = decode_config_payload(input)?;
    let value: Value = serde_json::from_str(&decoded)
        .map_err(|error| CatalogError::invalid("CONFIG_JSON_INVALID", error.to_string()))?;
    let object = value.as_object().ok_or_else(|| {
        CatalogError::invalid(
            "CONFIG_OBJECT_REQUIRED",
            "configuration must be a JSON object",
        )
    })?;
    let site_count = match object.get("sites") {
        None => 0,
        Some(sites) => sites
            .as_array()
            .ok_or_else(|| {
                CatalogError::invalid(
                    "CONFIG_SITES_INVALID",
                    "configuration sites must be an array",
                )
            })?
            .len(),
    };
    Ok((decoded, site_count))
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
    if !matches!(source_kind, "url" | "file" | "json") {
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
) -> Result<Option<(String, usize)>, CatalogError> {
    connection
        .query_row(
            "SELECT version_hash, site_count FROM config_versions
             WHERE source = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1",
            params![source],
            |row| Ok((row.get(0)?, row.get::<_, i64>(1)? as usize)),
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

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{decode_config_payload, ingest_connection, parse_config, ConfigCatalogPayload};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use rusqlite::Connection;

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
            };
            ingest_connection(&connection, &payload).expect("valid config");
        }
        let fallback = ingest_connection(
            &connection,
            &ConfigCatalogPayload {
                source: "inline:fixture".to_string(),
                source_kind: "json".to_string(),
                raw: "not-json".to_string(),
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
}
