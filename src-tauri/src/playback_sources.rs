use futures_util::{stream, StreamExt};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::time::Duration;

use super::source_session::{SourceSessionPayload, SourceSessionState};

const RESOLVER_TIMEOUT_MS: u64 = 8_000;
const RESOLVER_GLOBAL_TIMEOUT_MS: u64 = 20_000;
const RESOLVER_CONCURRENCY: usize = 4;

#[derive(Clone, Copy)]
struct ResolverLimits {
    concurrency: usize,
    per_site_timeout: Duration,
    total_timeout: Duration,
}

impl Default for ResolverLimits {
    fn default() -> Self {
        Self {
            concurrency: RESOLVER_CONCURRENCY,
            per_site_timeout: Duration::from_millis(RESOLVER_TIMEOUT_MS),
            total_timeout: Duration::from_millis(RESOLVER_GLOBAL_TIMEOUT_MS),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSourceResolvePayload {
    pub query: String,
    pub current_site_key: String,
    pub current_vod: Value,
    pub current_catalog: Option<Value>,
    pub current_playback: Option<bool>,
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
    resolve_with_limits(state, payload, ResolverLimits::default()).await
}

async fn resolve_with_limits(
    state: &SourceSessionState,
    payload: &PlaybackSourceResolvePayload,
    limits: ResolverLimits,
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

    let run_id = uuid::Uuid::new_v4().to_string();
    let global_deadline = tokio::time::Instant::now() + limits.total_timeout;
    let mut outcomes: Vec<Option<SiteOutcome>> = std::iter::repeat_with(|| None)
        .take(payload.sites.len())
        .collect();
    let mut network_sites = Vec::new();
    for (index, site) in payload.sites.iter().enumerate() {
        if site.key == payload.current_site_key || is_quickjs_site(&site.api, site.ext.as_deref()) {
            outcomes[index] = Some(
                resolve_site(
                    state,
                    payload,
                    query,
                    &run_id,
                    index,
                    site,
                    limits.per_site_timeout,
                )
                .await,
            );
        } else {
            network_sites.push((index, site.clone()));
        }
    }

    let mut globally_timed_out = false;
    if !network_sites.is_empty() {
        let concurrency = limits.concurrency.clamp(1, RESOLVER_CONCURRENCY);
        let run_id = run_id.as_str();
        let jobs = stream::iter(network_sites).map(|(index, site)| async move {
            let outcome = resolve_site_with_timeout(
                state,
                payload,
                query,
                run_id,
                index,
                &site,
                limits.per_site_timeout,
            )
            .await;
            (index, outcome)
        });
        let mut jobs = Box::pin(jobs.buffer_unordered(concurrency));
        let deadline = tokio::time::sleep_until(global_deadline);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                biased;
                _ = &mut deadline => {
                    globally_timed_out = true;
                    break;
                },
                result = jobs.next() => match result {
                    Some((index, outcome)) => outcomes[index] = Some(outcome),
                    None => break,
                },
            }
        }
        drop(jobs);
    }

    for (index, site) in payload.sites.iter().enumerate() {
        let outcome = outcomes[index].take().unwrap_or_else(|| {
            timeout_outcome(
                site,
                if globally_timed_out {
                    "TAURI_RESOLVER_GLOBAL_TIMEOUT"
                } else {
                    "TAURI_RESOLVER_SITE_TIMEOUT"
                },
            )
        });
        if outcome.searched {
            searched_sites.push(outcome.site_key.clone());
        }
        if outcome.successful {
            successful_sites.push(outcome.site_key.clone());
        }
        if let Some(message) = outcome.failure {
            failed_sites.push(json!({
                "siteKey": outcome.site_key,
                "message": message,
            }));
        }
        if let Some(candidate) = outcome.candidate {
            candidates.push(candidate);
        }
        diagnostics.push(outcome.diagnostic);
    }

    let searched_sites_value = json!(searched_sites);
    let successful_sites_value = json!(successful_sites);
    let search_failed_site_keys: Vec<Value> = diagnostics
        .iter()
        .filter(|value| {
            matches!(
                value.get("search").and_then(Value::as_str),
                Some("error" | "timeout")
            )
        })
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
            "searchableSites": payload.sites.iter().filter(|site| !is_quickjs_site(&site.api, site.ext.as_deref())).count(),
            "runtimeSupportedSites": payload.sites.iter().filter(|site| !is_quickjs_site(&site.api, site.ext.as_deref())).count(),
            "runtimePreparation": "ready",
            "runtimeWaitDurationMs": 0,
            "unsupportedSiteCount": payload.sites.iter().filter(|site| is_quickjs_site(&site.api, site.ext.as_deref())).count(),
            "searchedSites": searched_sites_value,
            "searchSuccessSites": successful_sites_value,
            "searchFailedSites": search_failed_site_keys,
            "searchResultCount": diagnostics.iter().map(|value| value.get("resultCount").and_then(Value::as_u64).unwrap_or(0)).sum::<u64>(),
            "matchedCandidateCount": diagnostics.iter().map(|value| value.get("matchedCandidateCount").and_then(Value::as_u64).unwrap_or(0)).sum::<u64>(),
            "detailSuccessCount": diagnostics.iter().map(|value| value.get("detailSuccessCount").and_then(Value::as_u64).unwrap_or(0)).sum::<u64>(),
            "playableCandidateCount": candidates.iter().filter(|value| value.get("playable").and_then(Value::as_bool).unwrap_or(false)).count(),
            "sites": diagnostics,
        },
    }))
}

struct SiteOutcome {
    site_key: String,
    searched: bool,
    successful: bool,
    failure: Option<String>,
    candidate: Option<Value>,
    diagnostic: Value,
}

struct ResolverSessionGuard<'a> {
    state: &'a SourceSessionState,
    session_id: String,
}

impl Drop for ResolverSessionGuard<'_> {
    fn drop(&mut self) {
        let _ = self.state.close(&self.session_id);
    }
}

fn timeout_outcome(site: &PlaybackSourceResolveSite, reason: &str) -> SiteOutcome {
    SiteOutcome {
        site_key: site.key.clone(),
        searched: false,
        successful: false,
        failure: Some(reason.to_string()),
        candidate: None,
        diagnostic: diagnostic(
            site,
            "failed",
            "timeout",
            0,
            "not_attempted",
            0.0,
            0,
            "not_attempted",
            0,
            false,
            false,
            Some(reason),
        ),
    }
}

async fn resolve_site_with_timeout(
    state: &SourceSessionState,
    payload: &PlaybackSourceResolvePayload,
    query: &str,
    run_id: &str,
    site_index: usize,
    site: &PlaybackSourceResolveSite,
    timeout: Duration,
) -> SiteOutcome {
    resolve_site(state, payload, query, run_id, site_index, site, timeout).await
}

async fn call_with_deadline(
    state: &SourceSessionState,
    payload: &SourceSessionPayload,
    deadline: tokio::time::Instant,
) -> Result<super::source_session::SourceSessionResult, String> {
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return Err("TAURI_RESOLVER_SITE_TIMEOUT".to_string());
    }
    match tokio::time::timeout(remaining, state.call(payload)).await {
        Ok(result) => result.map_err(error_message).map_err(|message| {
            if message.contains("SOURCE_SESSION_TIMEOUT") {
                "TAURI_RESOLVER_SITE_TIMEOUT".to_string()
            } else {
                message
            }
        }),
        Err(_) => Err("TAURI_RESOLVER_SITE_TIMEOUT".to_string()),
    }
}

async fn resolve_site(
    state: &SourceSessionState,
    payload: &PlaybackSourceResolvePayload,
    query: &str,
    run_id: &str,
    site_index: usize,
    site: &PlaybackSourceResolveSite,
    timeout: Duration,
) -> SiteOutcome {
    if site.key == payload.current_site_key {
        let catalog = payload.current_catalog.clone();
        let has_play_from = !string_value(&payload.current_vod, "vod_play_from").is_empty();
        let has_play_url = !string_value(&payload.current_vod, "vod_play_url").is_empty();
        let playback_capability = state
            .snapshot(&payload.session_id)
            .ok()
            .map(|snapshot| snapshot.capabilities.playback)
            .or(payload.current_playback);
        let playable = candidate_playable(playback_capability, catalog.as_ref());
        return SiteOutcome {
            site_key: site.key.clone(),
            searched: true,
            successful: true,
            failure: None,
            candidate: Some(candidate(
                site,
                payload.current_vod.clone(),
                catalog,
                if playable { 1.0 } else { 0.0 },
                playable,
                has_play_from,
                has_play_url,
            )),
            diagnostic: diagnostic(
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
            ),
        };
    }

    if is_quickjs_site(&site.api, site.ext.as_deref()) {
        return SiteOutcome {
            site_key: site.key.clone(),
            searched: false,
            successful: false,
            failure: None,
            candidate: None,
            diagnostic: diagnostic(
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
            ),
        };
    }

    let resolver_session_id = format!(
        "{}:resolver:{}:{}:{}",
        payload.session_id, run_id, site_index, site.key
    );
    let mut opened = false;
    let mut searched = false;
    let mut successful = false;
    let mut search_result_count = 0;
    let mut matched_candidate_count = 0;
    let mut match_score = 0.0;
    let mut detail_attempted = false;
    let mut candidate_value = None;
    let mut diagnostic_value = None;
    let site_deadline = tokio::time::Instant::now() + timeout;
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
            timeout_ms: Some(timeout.as_millis().min(u64::MAX as u128) as u64),
            headers: None,
        };
        let open = state.open(&open_payload).map_err(error_message)?;
        opened = true;
        let _session_guard = ResolverSessionGuard {
            state,
            session_id: resolver_session_id.clone(),
        };
        if let Some(reason) = open.availability_reason {
            return Err(reason);
        }

        let search = call_with_deadline(
            state,
            &SourceSessionPayload {
                action: "call".to_string(),
                session_id: resolver_session_id.clone(),
                source_id: None,
                site_key: None,
                api: None,
                site_type: None,
                ext: None,
                method: Some("search".to_string()),
                params: Some(json!({ "key": query, "page": 1 })),
                timeout_ms: Some(timeout.as_millis().min(u64::MAX as u128) as u64),
                headers: None,
            },
            site_deadline,
        )
        .await?;
        let results = list_items(search.result.as_ref().unwrap_or(&Value::Null));
        search_result_count = results.len();
        searched = true;
        successful = true;
        let matched = results
            .iter()
            .find(|item| same_title(item, query))
            .cloned()
            .or_else(|| results.first().cloned());
        let Some(matched) = matched else {
            diagnostic_value = Some(diagnostic(
                site,
                "success",
                "empty",
                search_result_count,
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
        matched_candidate_count = 1;
        match_score = if same_title(&matched, query) {
            1.0
        } else {
            0.5
        };
        let vod_id = string_from_value(matched.get("vod_id").or_else(|| matched.get("id")));
        if vod_id.is_empty() {
            return Err("source search result has no vod id".to_string());
        }
        detail_attempted = true;
        let detail = call_with_deadline(
            state,
            &SourceSessionPayload {
                action: "call".to_string(),
                session_id: resolver_session_id.clone(),
                source_id: None,
                site_key: None,
                api: None,
                site_type: None,
                ext: None,
                method: Some("detail".to_string()),
                params: Some(json!({ "ids": [vod_id] })),
                timeout_ms: Some(timeout.as_millis().min(u64::MAX as u128) as u64),
                headers: None,
            },
            site_deadline,
        )
        .await?;
        let matched_vod = list_items(detail.result.as_ref().unwrap_or(&Value::Null))
            .into_iter()
            .next()
            .or_else(|| detail.result.filter(Value::is_object))
            .unwrap_or(matched);
        let catalog = playback_catalog(&matched_vod);
        let has_play_from = !string_value(&matched_vod, "vod_play_from").is_empty();
        let has_play_url = !string_value(&matched_vod, "vod_play_url").is_empty();
        let playable = candidate_playable(Some(open.capabilities.playback), catalog.as_ref());
        let matched_exactly = same_title(&matched_vod, query);
        match_score = if matched_exactly { 1.0 } else { 0.5 };
        candidate_value = Some(candidate(
            site,
            matched_vod,
            catalog,
            match_score,
            playable,
            has_play_from,
            has_play_url,
        ));
        diagnostic_value = Some(diagnostic(
            site,
            "success",
            "success",
            search_result_count,
            "matched",
            match_score,
            matched_candidate_count,
            "success",
            1,
            has_play_from,
            has_play_url,
            None,
        ));
        Ok(())
    }
    .await;

    if let Err(message) = result {
        let search_state = if searched {
            if search_result_count == 0 {
                "empty"
            } else {
                "success"
            }
        } else if message == "TAURI_RESOLVER_SITE_TIMEOUT" {
            "timeout"
        } else if opened {
            "error"
        } else {
            "skipped"
        };
        SiteOutcome {
            site_key: site.key.clone(),
            searched,
            successful,
            failure: Some(message.clone()),
            candidate: None,
            diagnostic: diagnostic(
                site,
                if opened { "success" } else { "failed" },
                search_state,
                search_result_count,
                if matched_candidate_count > 0 {
                    "matched"
                } else {
                    "not_attempted"
                },
                match_score,
                matched_candidate_count,
                if detail_attempted {
                    "failed"
                } else {
                    "not_attempted"
                },
                0,
                false,
                false,
                Some(&message),
            ),
        }
    } else {
        SiteOutcome {
            site_key: site.key.clone(),
            searched,
            successful,
            failure: None,
            candidate: candidate_value,
            diagnostic: diagnostic_value.unwrap_or_else(|| {
                diagnostic(
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
                )
            }),
        }
    }
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
    } else if is_quickjs_site(&site.api, site.ext.as_deref()) {
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

fn candidate_playable(capabilities_playback: Option<bool>, catalog: Option<&Value>) -> bool {
    capabilities_playback.unwrap_or(true) && catalog.is_some_and(catalog_is_playable)
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

fn is_quickjs_site(api: &str, ext: Option<&str>) -> bool {
    if super::legacy_http::is_tuxiaobei(api, ext.unwrap_or_default()) {
        return false;
    }
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
    use super::super::source_session::{SourceSessionPayload, SourceSessionState};
    use super::{
        candidate_playable, catalog_is_playable, is_quickjs_site, playback_catalog, resolve,
        resolve_with_limits, same_title, PlaybackSourceResolvePayload, PlaybackSourceResolveSite,
        ResolverLimits, RESOLVER_CONCURRENCY,
    };
    use serde_json::{json, Value};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
    fn playback_capability_gate_keeps_auth_or_metadata_sources_non_playable() {
        let catalog = json!({
            "lines": [{ "episodes": [{ "id": "https://example.test/share" }] }]
        });
        assert!(!candidate_playable(Some(false), Some(&catalog)));
        assert!(candidate_playable(Some(true), Some(&catalog)));
        assert!(candidate_playable(None, Some(&catalog)));
    }

    #[tokio::test]
    async fn resolver_respects_current_session_playback_capability() {
        let state = SourceSessionState::default();
        state
            .open(&SourceSessionPayload {
                action: "open".to_string(),
                session_id: "session:douban".to_string(),
                source_id: Some("source:test".to_string()),
                site_key: Some("douban".to_string()),
                api: Some("csp_Douban".to_string()),
                site_type: Some(3),
                ext: None,
                method: None,
                params: None,
                timeout_ms: None,
                headers: None,
            })
            .expect("Douban session opens");

        let result = resolve(
            &state,
            &PlaybackSourceResolvePayload {
                query: "Movie".to_string(),
                current_site_key: "douban".to_string(),
                current_vod: json!({
                    "vod_id": "movie-1",
                    "vod_name": "Movie",
                    "vod_play_from": "share",
                    "vod_play_url": "Episode$https://example.test/share"
                }),
                current_catalog: Some(json!({
                    "lines": [{ "episodes": [{ "id": "https://example.test/share" }] }]
                })),
                current_playback: None,
                source_id: "source:test".to_string(),
                session_id: "session:douban".to_string(),
                sites: vec![PlaybackSourceResolveSite {
                    key: "douban".to_string(),
                    name: "Douban".to_string(),
                    api: "csp_Douban".to_string(),
                    site_type: 3,
                    ext: None,
                }],
            },
        )
        .await
        .expect("resolver result");

        assert_eq!(result["candidates"][0]["playable"], false);
        assert_eq!(result["diagnostics"]["playableCandidateCount"], 0);
    }

    #[test]
    fn resolver_title_matching_and_runtime_boundary_are_stable() {
        assert!(same_title(&json!({ "vod_name": "Movie 2026" }), "movie"));
        assert!(is_quickjs_site("https://example.test/source.mjs", None));
        assert!(!is_quickjs_site("https://example.test/api", None));
        assert!(!is_quickjs_site(
            "https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/drpy2.min.js",
            Some("https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/%E5%85%94%E5%B0%8F%E8%B4%9D.js")
        ));
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
                current_playback: None,
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

    #[tokio::test]
    async fn resolver_queries_independent_sites_concurrently_and_keeps_config_order() {
        let request_activity = Arc::new(RequestActivity::default());
        let keys = ["first", "second", "third", "fourth", "fifth"];
        let mut sites = vec![PlaybackSourceResolveSite {
            key: "current".to_string(),
            name: "Current".to_string(),
            api: "csp_Douban".to_string(),
            site_type: 3,
            ext: None,
        }];
        for key in keys {
            sites.push(PlaybackSourceResolveSite {
                key: key.to_string(),
                name: key.to_string(),
                api: delayed_cms_fixture(key, 100, request_activity.clone()).await,
                site_type: 1,
                ext: None,
            });
        }

        let result = resolve(
            &SourceSessionState::default(),
            &PlaybackSourceResolvePayload {
                query: "Movie".to_string(),
                current_site_key: "current".to_string(),
                current_vod: json!({ "vod_id": "current", "vod_name": "Movie" }),
                current_catalog: None,
                current_playback: Some(false),
                source_id: "source:test".to_string(),
                session_id: "session:concurrent".to_string(),
                sites,
            },
        )
        .await
        .expect("resolver result");

        assert_eq!(
            request_activity.max.load(Ordering::SeqCst),
            RESOLVER_CONCURRENCY
        );
        assert_eq!(
            result["searchedSites"],
            json!(["current", "first", "second", "third", "fourth", "fifth"])
        );
        assert_eq!(
            result["candidates"]
                .as_array()
                .expect("candidate array")
                .iter()
                .filter_map(|value| value.get("siteKey").and_then(|value| value.as_str()))
                .collect::<Vec<_>>(),
            vec!["current", "first", "second", "third", "fourth", "fifth"]
        );
    }

    #[tokio::test]
    async fn resolver_preserves_search_success_when_detail_fails() {
        let site_url = cms_detail_failure_fixture("detail-failure").await;
        let result = resolve_with_limits(
            &SourceSessionState::default(),
            &PlaybackSourceResolvePayload {
                query: "Movie".to_string(),
                current_site_key: "current".to_string(),
                current_vod: json!({ "vod_id": "current", "vod_name": "Movie" }),
                current_catalog: None,
                current_playback: Some(false),
                source_id: "source:test".to_string(),
                session_id: "session:detail-failure".to_string(),
                sites: vec![PlaybackSourceResolveSite {
                    key: "detail-failure".to_string(),
                    name: "Detail failure".to_string(),
                    api: site_url,
                    site_type: 1,
                    ext: None,
                }],
            },
            ResolverLimits {
                concurrency: 1,
                per_site_timeout: Duration::from_millis(500),
                total_timeout: Duration::from_secs(1),
            },
        )
        .await
        .expect("resolver returns detail failure diagnostics");

        assert_eq!(result["searchedSites"], json!(["detail-failure"]));
        assert_eq!(result["successfulSites"], json!(["detail-failure"]));
        assert_eq!(result["failedSites"][0]["siteKey"], "detail-failure");
        assert_eq!(result["diagnostics"]["sites"][0]["search"], "success");
        assert_eq!(result["diagnostics"]["sites"][0]["resultCount"], 1);
        assert_eq!(
            result["diagnostics"]["sites"][0]["matchedCandidateCount"],
            1
        );
        assert_eq!(result["diagnostics"]["sites"][0]["detail"], "failed");
        assert_eq!(result["diagnostics"]["sites"][0]["detailSuccessCount"], 0);
        assert_eq!(result["diagnostics"]["matchedCandidateCount"], 1);
        assert_eq!(result["diagnostics"]["detailSuccessCount"], 0);
    }

    #[tokio::test]
    async fn resolver_per_site_timeout_is_bounded_and_keeps_fast_results() {
        let fast =
            delayed_cms_fixture("fast-timeout", 5, Arc::new(RequestActivity::default())).await;
        let slow =
            delayed_cms_fixture("slow-timeout", 500, Arc::new(RequestActivity::default())).await;
        let state = SourceSessionState::default();
        let started = std::time::Instant::now();
        let result = resolve_with_limits(
            &state,
            &PlaybackSourceResolvePayload {
                query: "Movie".to_string(),
                current_site_key: "current".to_string(),
                current_vod: json!({ "vod_id": "current", "vod_name": "Movie" }),
                current_catalog: None,
                current_playback: Some(false),
                source_id: "source:test".to_string(),
                session_id: "session:site-timeout".to_string(),
                sites: vec![
                    PlaybackSourceResolveSite {
                        key: "current".to_string(),
                        name: "Current".to_string(),
                        api: "csp_Douban".to_string(),
                        site_type: 3,
                        ext: None,
                    },
                    PlaybackSourceResolveSite {
                        key: "slow-timeout".to_string(),
                        name: "Slow timeout".to_string(),
                        api: slow,
                        site_type: 1,
                        ext: None,
                    },
                    PlaybackSourceResolveSite {
                        key: "fast-timeout".to_string(),
                        name: "Fast".to_string(),
                        api: fast,
                        site_type: 1,
                        ext: None,
                    },
                ],
            },
            ResolverLimits {
                concurrency: 2,
                per_site_timeout: Duration::from_millis(80),
                total_timeout: Duration::from_secs(1),
            },
        )
        .await
        .expect("resolver returns partial site-timeout result");

        assert!(
            started.elapsed() < Duration::from_millis(350),
            "single-site timeout waited too long: {:?}",
            started.elapsed()
        );
        assert_eq!(
            result["candidates"]
                .as_array()
                .expect("candidate array")
                .iter()
                .filter_map(|value| value.get("siteKey").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            vec!["current", "fast-timeout"]
        );
        assert_eq!(result["failedSites"][0]["siteKey"], "slow-timeout");
        assert_eq!(
            result["failedSites"][0]["message"],
            "TAURI_RESOLVER_SITE_TIMEOUT"
        );
        assert_eq!(result["diagnostics"]["sites"][1]["search"], "timeout");
        assert_eq!(
            result["diagnostics"]["sites"][1]["skipReason"],
            "TAURI_RESOLVER_SITE_TIMEOUT"
        );
        assert_eq!(state.active_session_count(), 0);
    }

    #[tokio::test]
    async fn resolver_global_deadline_returns_partial_results_and_closes_sessions() {
        let fast = delayed_cms_fixture("fast", 10, Arc::new(RequestActivity::default())).await;
        let slow = delayed_cms_fixture("slow", 500, Arc::new(RequestActivity::default())).await;
        let state = SourceSessionState::default();
        let started = std::time::Instant::now();
        let result = resolve_with_limits(
            &state,
            &PlaybackSourceResolvePayload {
                query: "Movie".to_string(),
                current_site_key: "current".to_string(),
                current_vod: json!({ "vod_id": "current", "vod_name": "Movie" }),
                current_catalog: None,
                current_playback: Some(false),
                source_id: "source:test".to_string(),
                session_id: "session:deadline".to_string(),
                sites: vec![
                    PlaybackSourceResolveSite {
                        key: "current".to_string(),
                        name: "Current".to_string(),
                        api: "csp_Douban".to_string(),
                        site_type: 3,
                        ext: None,
                    },
                    PlaybackSourceResolveSite {
                        key: "fast".to_string(),
                        name: "Fast".to_string(),
                        api: fast,
                        site_type: 1,
                        ext: None,
                    },
                    PlaybackSourceResolveSite {
                        key: "slow".to_string(),
                        name: "Slow".to_string(),
                        api: slow,
                        site_type: 1,
                        ext: None,
                    },
                ],
            },
            ResolverLimits {
                concurrency: 2,
                per_site_timeout: Duration::from_secs(2),
                total_timeout: Duration::from_millis(150),
            },
        )
        .await
        .expect("resolver returns partial result");

        assert!(
            started.elapsed() < Duration::from_millis(400),
            "global deadline waited for the slow site: {:?}",
            started.elapsed()
        );

        assert_eq!(
            result["candidates"]
                .as_array()
                .expect("candidate array")
                .iter()
                .filter_map(|value| value.get("siteKey").and_then(Value::as_str))
                .collect::<Vec<_>>(),
            vec!["current", "fast"]
        );
        assert_eq!(
            result["failedSites"][0],
            json!({ "siteKey": "slow", "message": "TAURI_RESOLVER_GLOBAL_TIMEOUT" })
        );
        assert_eq!(
            result["diagnostics"]["sites"][2]["skipReason"],
            "TAURI_RESOLVER_GLOBAL_TIMEOUT"
        );
        assert_eq!(state.active_session_count(), 0);
    }

    #[tokio::test]
    async fn resolver_detail_timeout_keeps_search_progress_and_closes_session() {
        let detail_timeout_site = detail_timeout_cms_fixture(250).await;
        let state = SourceSessionState::default();
        let result = resolve_with_limits(
            &state,
            &PlaybackSourceResolvePayload {
                query: "Movie".to_string(),
                current_site_key: "current".to_string(),
                current_vod: json!({ "vod_id": "current", "vod_name": "Movie" }),
                current_catalog: None,
                current_playback: Some(false),
                source_id: "source:test".to_string(),
                session_id: "session:detail-timeout".to_string(),
                sites: vec![
                    PlaybackSourceResolveSite {
                        key: "current".to_string(),
                        name: "Current".to_string(),
                        api: "csp_Douban".to_string(),
                        site_type: 3,
                        ext: None,
                    },
                    PlaybackSourceResolveSite {
                        key: "detail-timeout".to_string(),
                        name: "Detail timeout".to_string(),
                        api: detail_timeout_site,
                        site_type: 1,
                        ext: None,
                    },
                ],
            },
            ResolverLimits {
                concurrency: 1,
                per_site_timeout: Duration::from_millis(50),
                total_timeout: Duration::from_secs(1),
            },
        )
        .await
        .expect("resolver returns partial detail-timeout result");

        assert_eq!(
            result["searchedSites"],
            json!(["current", "detail-timeout"])
        );
        assert_eq!(
            result["successfulSites"],
            json!(["current", "detail-timeout"])
        );
        assert_eq!(
            result["failedSites"][0],
            json!({
                "siteKey": "detail-timeout",
                "message": "TAURI_RESOLVER_SITE_TIMEOUT"
            })
        );
        assert_eq!(result["diagnostics"]["sites"][1]["search"], "success");
        assert_eq!(result["diagnostics"]["sites"][1]["detail"], "failed");
        assert_eq!(result["diagnostics"]["sites"][1]["resultCount"], 1);
        assert_eq!(state.active_session_count(), 0);
    }

    #[derive(Default)]
    struct RequestActivity {
        active: AtomicUsize,
        max: AtomicUsize,
    }

    async fn delayed_cms_fixture(
        site_key: &'static str,
        delay_ms: u64,
        request_activity: Arc<RequestActivity>,
    ) -> String {
        let listener = super::super::test_support::bind_loopback_tcp()
            .await
            .expect("bind CMS fixture");
        let address = listener.local_addr().expect("CMS fixture address");
        tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.expect("accept CMS request");
                let mut request = [0_u8; 2048];
                let read = socket.read(&mut request).await.expect("read CMS request");
                let request = String::from_utf8_lossy(&request[..read]);
                let body = if request.contains("ids=") {
                    json!({
                        "list": [{
                            "vod_id": format!("{site_key}-movie"),
                            "vod_name": "Movie",
                            "vod_play_from": "main",
                            "vod_play_url": format!("Episode$https://media.example.test/{site_key}.m3u8")
                        }]
                    })
                } else {
                    let active = request_activity.active.fetch_add(1, Ordering::SeqCst) + 1;
                    request_activity.max.fetch_max(active, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    request_activity.active.fetch_sub(1, Ordering::SeqCst);
                    json!({ "list": [{ "vod_id": format!("{site_key}-movie"), "vod_name": "Movie" }] })
                }
                .to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket
                    .write_all(response.as_bytes())
                    .await
                    .expect("write CMS response");
            }
        });
        format!("http://{address}/api.php")
    }

    async fn detail_timeout_cms_fixture(detail_delay_ms: u64) -> String {
        let listener = super::super::test_support::bind_loopback_tcp()
            .await
            .expect("bind detail-timeout CMS fixture");
        let address = listener
            .local_addr()
            .expect("detail-timeout CMS fixture address");
        tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener
                    .accept()
                    .await
                    .expect("accept detail-timeout CMS request");
                let mut request = [0_u8; 2048];
                let read = socket
                    .read(&mut request)
                    .await
                    .expect("read detail-timeout CMS request");
                let request = String::from_utf8_lossy(&request[..read]);
                let detail = request.contains("ids=");
                if detail {
                    tokio::time::sleep(Duration::from_millis(detail_delay_ms)).await;
                }
                let (status, body) = if detail {
                    ("500 Internal Server Error", "{}".to_string())
                } else {
                    (
                        "200 OK",
                        json!({
                            "list": [{ "vod_id": "detail-timeout-movie", "vod_name": "Movie" }]
                        })
                        .to_string(),
                    )
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        format!("http://{address}/api.php")
    }

    async fn cms_detail_failure_fixture(site_key: &'static str) -> String {
        let listener = super::super::test_support::bind_loopback_tcp()
            .await
            .expect("bind CMS detail failure fixture");
        let address = listener.local_addr().expect("CMS detail failure address");
        tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.expect("accept CMS request");
                let mut request = [0_u8; 2048];
                let read = socket.read(&mut request).await.expect("read CMS request");
                let request = String::from_utf8_lossy(&request[..read]);
                let (status, body) = if request.contains("ids=") {
                    ("500 Internal Server Error", "{}".to_string())
                } else {
                    (
                        "200 OK",
                        json!({
                            "list": [{
                                "vod_id": format!("{site_key}-movie"),
                                "vod_name": "Movie"
                            }]
                        })
                        .to_string(),
                    )
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        format!("http://{address}/api.php")
    }
}
