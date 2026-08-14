use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::source_session::{SourceSessionPayload, SourceSessionState};

const RESOLVER_TIMEOUT_MS: u64 = 8_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSourceResolvePayload {
    pub query: String,
    pub current_site_key: String,
    pub current_vod: Value,
    pub current_catalog: Option<Value>,
    pub source_id: String,
    pub session_id: String,
    pub sites: Vec<PlaybackSourceResolveSite>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSourceResolveSite {
    pub key: String,
    pub name: String,
    pub api: String,
    pub site_type: u8,
    pub ext: Option<String>,
}

pub async fn resolve(
    state: &SourceSessionState,
    payload: &PlaybackSourceResolvePayload,
) -> Result<Value, String> {
    let query = payload.query.trim();
    if query.is_empty() {
        return Err("TAURI_PLAYBACK_SOURCE_QUERY_REQUIRED".to_string());
    }
    if payload.current_site_key.trim().is_empty() {
        return Err("TAURI_SITE_NOT_FOUND".to_string());
    }
    if !payload.current_vod.is_object() {
        return Err("TAURI_PLAYBACK_SOURCE_DETAIL_INVALID".to_string());
    }
    if payload.sites.len() > 128 {
        return Err("TAURI_PLAYBACK_SOURCE_SITE_LIMIT".to_string());
    }

    let mut searched_sites = Vec::new();
    let mut successful_sites = Vec::new();
    let mut failed_sites = Vec::new();
    let mut candidates = Vec::new();
    let mut diagnostics = Vec::new();

    for site in &payload.sites {
        if site.key == payload.current_site_key {
            let catalog = payload.current_catalog.clone();
            let has_play_from = !string_value(&payload.current_vod, "vod_play_from").is_empty();
            let has_play_url = !string_value(&payload.current_vod, "vod_play_url").is_empty();
            let playable = catalog.as_ref().is_some_and(catalog_is_playable);
            searched_sites.push(site.key.clone());
            successful_sites.push(site.key.clone());
            candidates.push(candidate(
                site,
                payload.current_vod.clone(),
                catalog,
                if playable { 1.0 } else { 0.0 },
                playable,
                has_play_from,
                has_play_url,
            ));
            diagnostics.push(diagnostic(
                site,
                "success",
                "success",
                1,
                "matched",
                1.0,
                1,
                "success",
                1,
                has_play_from,
                has_play_url,
                None,
            ));
            continue;
        }

        if is_quickjs_site(&site.api) {
            diagnostics.push(diagnostic(
                site,
                "skipped",
                "skipped",
                0,
                "not_attempted",
                0.0,
                0,
                "not_attempted",
                0,
                false,
                false,
                Some("TAURI_RESOLVER_QUICKJS_SESSION_ISOLATED"),
            ));
            continue;
        }

        let resolver_session_id = format!("{}:resolver:{}", payload.session_id, site.key);
        let mut opened = false;
        let result = async {
            let open_payload = SourceSessionPayload {
                action: "open".to_string(),
                session_id: resolver_session_id.clone(),
                source_id: Some(payload.source_id.clone()),
                site_key: Some(site.key.clone()),
                api: Some(site.api.clone()),
                site_type: Some(site.site_type),
                ext: site.ext.clone(),
                method: None,
                params: None,
                timeout_ms: Some(RESOLVER_TIMEOUT_MS),
                headers: None,
            };
            let open = state.open(&open_payload).map_err(error_message)?;
            opened = true;
            if let Some(reason) = open.availability_reason {
                return Err(reason);
            }

            let search = state
                .call(&SourceSessionPayload {
                    action: "call".to_string(),
                    session_id: resolver_session_id.clone(),
                    source_id: None,
                    site_key: None,
                    api: None,
                    site_type: None,
                    ext: None,
                    method: Some("search".to_string()),
                    params: Some(json!({ "key": query, "page": 1 })),
                    timeout_ms: Some(RESOLVER_TIMEOUT_MS),
                    headers: None,
                })
                .await
                .map_err(error_message)?;
            let results = list_items(search.result.as_ref().unwrap_or(&Value::Null));
            searched_sites.push(site.key.clone());
            successful_sites.push(site.key.clone());
            let matched = results
                .iter()
                .find(|item| same_title(item, query))
                .cloned()
                .or_else(|| results.first().cloned());
            let Some(matched) = matched else {
                diagnostics.push(diagnostic(
                    site,
                    "success",
                    "empty",
                    0,
                    "not_attempted",
                    0.0,
                    0,
                    "not_attempted",
                    0,
                    false,
                    false,
                    None,
                ));
                return Ok(());
            };
            let vod_id = string_from_value(matched.get("vod_id").or_else(|| matched.get("id")));
            if vod_id.is_empty() {
                return Err("source search result has no vod id".to_string());
            }
            let detail = state
                .call(&SourceSessionPayload {
                    action: "call".to_string(),
                    session_id: resolver_session_id.clone(),
                    source_id: None,
                    site_key: None,
                    api: None,
                    site_type: None,
                    ext: None,
                    method: Some("detail".to_string()),
                    params: Some(json!({ "ids": [vod_id] })),
                    timeout_ms: Some(RESOLVER_TIMEOUT_MS),
                    headers: None,
                })
                .await
                .map_err(error_message)?;
            let matched_vod = list_items(detail.result.as_ref().unwrap_or(&Value::Null))
                .into_iter()
                .next()
                .or_else(|| detail.result.filter(Value::is_object))
                .unwrap_or(matched);
            let catalog = playback_catalog(&matched_vod);
            let has_play_from = !string_value(&matched_vod, "vod_play_from").is_empty();
            let has_play_url = !string_value(&matched_vod, "vod_play_url").is_empty();
            let playable = catalog.as_ref().is_some_and(catalog_is_playable);
            let matched_exactly = same_title(&matched_vod, query);
            candidates.push(candidate(
                site,
                matched_vod,
                catalog,
                if matched_exactly { 1.0 } else { 0.5 },
                playable,
                has_play_from,
                has_play_url,
            ));
            diagnostics.push(diagnostic(
                site,
                "success",
                "success",
                results.len(),
                "matched",
                if matched_exactly { 1.0 } else { 0.5 },
                1,
                "success",
                1,
                has_play_from,
                has_play_url,
                None,
            ));
            Ok(())
        }
        .await;

        if opened {
            let _ = state.close(&resolver_session_id);
        }
        if let Err(message) = result {
            failed_sites.push(json!({ "siteKey": site.key, "message": message }));
            diagnostics.push(diagnostic(
                site,
                if opened { "success" } else { "failed" },
                if opened { "error" } else { "skipped" },
                0,
                "not_attempted",
                0.0,
                0,
                "not_attempted",
                0,
                false,
                false,
                Some(&message),
            ));
        }
    }

    let searched_sites_value = json!(searched_sites);
    let successful_sites_value = json!(successful_sites);
    let failed_site_keys: Vec<Value> = failed_sites
        .iter()
        .filter_map(|value| value.get("siteKey").cloned())
        .collect();
    Ok(json!({
        "query": query,
        "searchedSites": searched_sites_value.clone(),
        "successfulSites": successful_sites_value.clone(),
        "failedSites": failed_sites,
        "candidates": candidates,
        "diagnostics": {
            "configSiteCount": payload.sites.len(),
            "searchableSites": payload.sites.iter().filter(|site| !is_quickjs_site(&site.api)).count(),
            "runtimeSupportedSites": payload.sites.iter().filter(|site| !is_quickjs_site(&site.api)).count(),
            "runtimePreparation": "ready",
            "runtimeWaitDurationMs": 0,
            "unsupportedSiteCount": payload.sites.iter().filter(|site| is_quickjs_site(&site.api)).count(),
            "searchedSites": searched_sites_value,
            "searchSuccessSites": successful_sites_value,
            "searchFailedSites": failed_site_keys,
            "searchResultCount": diagnostics.iter().map(|value| value.get("resultCount").and_then(Value::as_u64).unwrap_or(0)).sum::<u64>(),
            "matchedCandidateCount": candidates.len(),
            "detailSuccessCount": candidates.len(),
            "playableCandidateCount": candidates.iter().filter(|value| value.get("playable").and_then(Value::as_bool).unwrap_or(false)).count(),
            "sites": diagnostics,
        },
    }))
}

fn candidate(
    site: &PlaybackSourceResolveSite,
    vod: Value,
    catalog: Option<Value>,
    score: f64,
    playable: bool,
    has_play_from: bool,
    has_play_url: bool,
) -> Value {
    let mut value = Map::new();
    value.insert("siteKey".to_string(), json!(site.key));
    value.insert("siteName".to_string(), json!(site.name));
    value.insert("vod".to_string(), vod);
    value.insert("score".to_string(), json!(score));
    value.insert("playable".to_string(), json!(playable));
    if let Some(catalog) = catalog {
        value.insert("lines".to_string(), catalog);
    }
    value.insert("hasPlayFrom".to_string(), json!(has_play_from));
    value.insert("hasPlayUrl".to_string(), json!(has_play_url));
    Value::Object(value)
}

#[allow(clippy::too_many_arguments)]
fn diagnostic(
    site: &PlaybackSourceResolveSite,
    initialization: &str,
    search: &str,
    result_count: usize,
    matched: &str,
    match_score: f64,
    matched_candidate_count: usize,
    detail: &str,
    detail_success_count: usize,
    has_play_from: bool,
    has_play_url: bool,
    skip_reason: Option<&str>,
) -> Value {
    let api = site.api.to_ascii_lowercase();
    let engine = if api == "csp_jianpian" || api == "csp_douban" {
        "native"
    } else if is_quickjs_site(&site.api) {
        "quickjs"
    } else {
        "http"
    };
    json!({
        "siteKey": site.key,
        "siteName": site.name,
        "type": site.site_type,
        "apiType": site.site_type,
        "api": site.api,
        "engine": engine,
        "runtime": Value::Null,
        "runtimeReason": Value::Null,
        "searchable": true,
        "quickSearch": true,
        "supported": true,
        "initialization": initialization,
        "search": search,
        "resultCount": result_count,
        "matched": matched,
        "matchScore": if matched == "not_attempted" { Value::Null } else { json!(match_score) },
        "matchedCandidateCount": matched_candidate_count,
        "detail": detail,
        "detailSuccessCount": detail_success_count,
        "hasPlayFrom": has_play_from,
        "hasPlayUrl": has_play_url,
        "skipReason": skip_reason,
    })
}

fn list_items(value: &Value) -> Vec<Value> {
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    object
        .get("list")
        .or_else(|| object.get("items"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item.is_object())
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn playback_catalog(value: &Value) -> Option<Value> {
    let from = string_value(value, "vod_play_from");
    let urls = string_value(value, "vod_play_url");
    if from.is_empty() || urls.is_empty() {
        return None;
    }
    let from_lines: Vec<&str> = from.split("$$$").collect();
    let mut lines = Vec::new();
    for (index, url_line) in urls.split("$$$").enumerate() {
        let episodes: Vec<Value> = url_line
            .split('#')
            .enumerate()
            .filter_map(|(episode_index, entry)| {
                let (label, raw_id) = entry.split_once('$').unwrap_or(("", entry));
                let id = raw_id.split('|').next().unwrap_or_default().trim();
                if id.is_empty() {
                    return None;
                }
                Some(json!({
                    "index": episode_index,
                    "name": if label.trim().is_empty() { (episode_index + 1).to_string() } else { label.trim().to_string() },
                    "id": id,
                }))
            })
            .collect();
        if !episodes.is_empty() {
            let protocol = if episodes.iter().any(|episode| {
                episode
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.contains(".m3u8"))
            }) {
                "HLS"
            } else {
                "MP4"
            };
            let line_name = from_lines
                .get(index)
                .copied()
                .unwrap_or("")
                .trim()
                .to_string();
            let line_name = if line_name.is_empty() {
                format!("绾胯矾 {}", index + 1)
            } else {
                line_name
            };
            lines.push(json!({
                "index": index,
                "name": line_name,
                "protocol": protocol,
                "episodes": episodes,
            }));
        }
    }
    (!lines.is_empty()).then(|| json!({ "lines": lines }))
}

fn catalog_is_playable(value: &Value) -> bool {
    value
        .get("lines")
        .and_then(Value::as_array)
        .is_some_and(|lines| {
            lines.iter().any(|line| {
                line.get("episodes")
                    .and_then(Value::as_array)
                    .is_some_and(|episodes| !episodes.is_empty())
            })
        })
}

fn string_value(value: &Value, key: &str) -> String {
    value
        .get(key)
        .map(|value| string_from_value(Some(value)))
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn string_from_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(value) if value.is_number() || value.is_boolean() => value.to_string(),
        _ => String::new(),
    }
}

fn same_title(value: &Value, query: &str) -> bool {
    let title = string_value(value, "vod_name");
    let title = if title.is_empty() {
        string_value(value, "title")
    } else {
        title
    };
    let title = title.to_lowercase();
    let query = query.to_lowercase();
    !title.is_empty()
        && !query.is_empty()
        && (title == query || title.contains(&query) || query.contains(&title))
}

fn is_quickjs_site(api: &str) -> bool {
    let value = api.trim().to_ascii_lowercase();
    value.starts_with("js:")
        || value.ends_with(".js")
        || value.ends_with(".mjs")
        || value.contains(".js?")
        || value.contains(".js#")
        || value.contains(".mjs?")
        || value.contains(".mjs#")
}

fn error_message(error: super::source_session::SourceSessionError) -> String {
    format!("{error:?}")
}

#[cfg(test)]
mod tests {
    use super::super::source_session::SourceSessionState;
    use super::{
        catalog_is_playable, is_quickjs_site, playback_catalog, resolve, same_title,
        PlaybackSourceResolvePayload, PlaybackSourceResolveSite,
    };
    use serde_json::json;

    #[test]
    fn parses_native_vod_playback_catalog_in_rust() {
        let value = json!({
            "vod_name": "A",
            "vod_play_from": "线路一",
            "vod_play_url": "第1集$https://example.test/a.m3u8|1|A#第2集$https://example.test/b.mp4|2|A"
        });
        let catalog = playback_catalog(&value).expect("catalog");
        assert!(catalog_is_playable(&catalog));
        assert_eq!(
            catalog["lines"][0]["episodes"][0]["id"],
            "https://example.test/a.m3u8"
        );
    }

    #[test]
    fn resolver_title_matching_and_runtime_boundary_are_stable() {
        assert!(same_title(&json!({ "vod_name": "Movie 2026" }), "movie"));
        assert!(is_quickjs_site("https://example.test/source.mjs"));
        assert!(!is_quickjs_site("https://example.test/api"));
    }

    #[tokio::test]
    async fn backend_resolver_keeps_current_catalog_and_skips_quickjs_sites() {
        let result = resolve(
            &SourceSessionState::default(),
            &PlaybackSourceResolvePayload {
                query: "Movie".to_string(),
                current_site_key: "native".to_string(),
                current_vod: json!({
                    "vod_id": "movie-1",
                    "vod_name": "Movie",
                    "vod_play_from": "main",
                    "vod_play_url": "Episode$https://example.test/movie.mp4"
                }),
                current_catalog: Some(json!({
                    "lines": [{ "index": 0, "episodes": [{ "id": "https://example.test/movie.mp4" }] }]
                })),
                source_id: "source:test".to_string(),
                session_id: "session:test".to_string(),
                sites: vec![
                    PlaybackSourceResolveSite {
                        key: "native".to_string(),
                        name: "Native".to_string(),
                        api: "csp_Jianpian".to_string(),
                        site_type: 3,
                        ext: None,
                    },
                    PlaybackSourceResolveSite {
                        key: "quickjs".to_string(),
                        name: "QuickJS".to_string(),
                        api: "https://example.test/source.mjs".to_string(),
                        site_type: 3,
                        ext: None,
                    },
                ],
            },
        )
        .await
        .expect("resolver result");
        assert_eq!(result["candidates"][0]["siteKey"], "native");
        assert_eq!(result["candidates"][0]["playable"], true);
        assert_eq!(
            result["diagnostics"]["sites"][1]["skipReason"],
            "TAURI_RESOLVER_QUICKJS_SESSION_ISOLATED"
        );
    }
}
