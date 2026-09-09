use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use reqwest::{header::HeaderMap, Url};
use serde_json::Value;

use super::source_session::{parse_cms_xml, read_bounded_response, SourceSessionError};

const MAX_CANDIDATES: usize = 8;
const MAX_DISCOVERY_BYTES: usize = 128 * 1024;

/// These spiders are wrappers around a configured HTTP site. They are safe to
/// probe with the bounded CMS fallback, but they are not a declaration that
/// every current endpoint is alive or follows the CMS contract.
pub fn is_candidate_api(api: &str) -> bool {
    matches!(
        api.trim().to_ascii_lowercase().as_str(),
        "csp_apprj"
            | "csp_appget"
            | "csp_appqi"
            | "csp_duopan"
            | "csp_netfixtv"
            | "csp_jpys"
            | "csp_wwys"
            | "csp_saohuo"
            | "csp_gz360"
            | "csp_czsapp"
            | "csp_sp360"
            | "csp_misou"
            | "csp_config"
            | "csp_ygp"
            | "csp_push"
            | "csp_dm84"
    )
}

/// Extract only an HTTP(S) endpoint from the source extension. `URL|token`
/// and object-shaped extensions are common in TVBox configs; the opaque
/// suffix is intentionally not guessed as a header or query parameter.
pub fn endpoint_from_ext(api: &str, ext: &str) -> Option<String> {
    if !is_candidate_api(api) || ext.trim().is_empty() {
        return None;
    }
    let mut values = Vec::new();
    if let Ok(value) = serde_json::from_str::<Value>(ext) {
        collect_strings(&value, &mut values);
    } else {
        values.extend(
            ext.split(|character: char| matches!(character, '|' | '\n' | '\r' | '\t' | ',' | ';'))
                .map(str::to_string),
        );
    }
    values.into_iter().find_map(|value| valid_url(&value))
}

pub async fn call(
    base: &str,
    method: &str,
    params: Option<&Value>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, SourceSessionError> {
    if !matches!(method, "home" | "category" | "search" | "detail") {
        return Err(SourceSessionError::Unsupported(format!(
            "AUTO_HTTP_METHOD_UNSUPPORTED:{method}"
        )));
    }
    let client = super::source_session::client_builder_for_url(reqwest::Client::builder(), base)
        .default_headers(headers.clone())
        .redirect(reqwest::redirect::Policy::limited(2))
        .timeout(timeout)
        .build()
        .map_err(|error| SourceSessionError::Request(error.to_string()))?;
    let mut candidates = candidate_urls(base, method, params)?;
    let mut tried = 0;
    let mut last_status = String::from("no response");
    while let Some(url) = candidates.pop() {
        if tried >= MAX_CANDIDATES {
            break;
        }
        tried += 1;
        if cancelled.load(Ordering::Acquire) {
            return Err(SourceSessionError::Cancelled);
        }
        let response = tokio::select! {
            result = client.get(&url).send() => result.map_err(|error| SourceSessionError::Request(error.to_string()))?,
            _ = wait_for_cancel(cancelled.clone()) => return Err(SourceSessionError::Cancelled),
        };
        let status = response.status();
        last_status = status.to_string();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let bytes = tokio::select! {
            result = read_bounded_response(response) => result.map_err(|error| {
                SourceSessionError::Request(error.message("AUTO_HTTP_RESPONSE_TOO_LARGE"))
            })?,
            _ = wait_for_cancel(cancelled.clone()) => return Err(SourceSessionError::Cancelled),
        };
        let body = String::from_utf8_lossy(&bytes)
            .trim_start_matches('\u{feff}')
            .to_string();
        if !status.is_success() {
            continue;
        }
        if let Ok(value) = parse_response(&body, &content_type) {
            if looks_like_cms(&value, method) {
                return Ok(value);
            }
        }
        if bytes.len() <= MAX_DISCOVERY_BYTES {
            for discovered in discover_urls(&body) {
                append_candidate(&mut candidates, &discovered, method, params)?;
            }
        }
    }
    Err(SourceSessionError::Request(format!(
        "AUTO_HTTP_CMS_CONTRACT_NOT_FOUND:{last_status}"
    )))
}

fn collect_strings(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::String(value) => output.push(value.clone()),
        Value::Array(values) => values
            .iter()
            .for_each(|value| collect_strings(value, output)),
        Value::Object(values) => values
            .values()
            .for_each(|value| collect_strings(value, output)),
        _ => {}
    }
}

fn valid_url(value: &str) -> Option<String> {
    let value = value
        .trim()
        .trim_matches(|character: char| "\"'[]{}(),<>".contains(character));
    if value.len() > 2048 {
        return None;
    }
    let url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url.to_string())
}

fn candidate_urls(
    base: &str,
    method: &str,
    params: Option<&Value>,
) -> Result<Vec<String>, SourceSessionError> {
    let base = valid_url(base)
        .ok_or_else(|| SourceSessionError::Invalid("AUTO_HTTP_ENDPOINT_INVALID".to_string()))?;
    let parsed =
        Url::parse(&base).map_err(|error| SourceSessionError::Invalid(error.to_string()))?;
    let mut candidates = Vec::new();
    append_candidate(&mut candidates, &base, method, params)?;

    let mut origin = parsed;
    origin.set_path("");
    origin.set_query(None);
    origin.set_fragment(None);
    for path in ["/api.php/provide/vod", "/api.php", "/index.php/api/vod"] {
        let mut candidate = origin.clone();
        candidate.set_path(path);
        append_candidate(&mut candidates, candidate.as_str(), method, params)?;
    }
    Ok(candidates)
}

fn append_candidate(
    candidates: &mut Vec<String>,
    base: &str,
    method: &str,
    params: Option<&Value>,
) -> Result<(), SourceSessionError> {
    let mut url =
        Url::parse(base).map_err(|error| SourceSessionError::Invalid(error.to_string()))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair(
            "ac",
            if matches!(method, "home" | "category" | "search") {
                "videolist"
            } else {
                "detail"
            },
        );
        if method == "category" {
            if let Some(value) = params
                .and_then(|value| value.get("typeId"))
                .and_then(Value::as_str)
            {
                query.append_pair("t", value);
            }
            if let Some(value) = params
                .and_then(|value| value.get("page"))
                .and_then(Value::as_u64)
            {
                query.append_pair("pg", &value.max(1).to_string());
            }
        } else if method == "search" {
            if let Some(value) = params
                .and_then(|value| value.get("key"))
                .and_then(Value::as_str)
            {
                query.append_pair("wd", value);
            }
            if let Some(value) = params
                .and_then(|value| value.get("page"))
                .and_then(Value::as_u64)
            {
                query.append_pair("pg", &value.max(1).to_string());
            }
        } else if method == "detail" {
            let ids = params
                .and_then(|value| value.get("ids"))
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(",")
                });
            if let Some(ids) = ids {
                query.append_pair("ids", &ids);
            }
        }
    }
    let value = url.to_string();
    if !candidates.iter().any(|candidate| candidate == &value) {
        candidates.insert(0, value);
    }
    Ok(())
}

fn parse_response(body: &str, content_type: &str) -> Result<Value, SourceSessionError> {
    if content_type.contains("xml") || body.trim_start().starts_with('<') {
        parse_cms_xml(body)
    } else {
        serde_json::from_str(body).map_err(|error| {
            SourceSessionError::Request(format!("AUTO_HTTP_RESPONSE_NOT_JSON:{error}"))
        })
    }
}

fn looks_like_cms(value: &Value, method: &str) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.contains_key("rss")
        || object.get("list").is_some_and(Value::is_array)
        || object.get("class").is_some_and(Value::is_array)
        || object.get("class_name").is_some_and(Value::is_array)
    {
        return true;
    }
    if object.contains_key("code") && object.contains_key("data") {
        return true;
    }
    if object.get("data").is_some_and(|data| {
        data.is_array()
            || data.as_object().is_some_and(|data| {
                data.get("list").is_some_and(Value::is_array)
                    || data.get("class").is_some_and(Value::is_array)
            })
    }) {
        return true;
    }
    method == "detail" && (object.contains_key("vod_id") || object.contains_key("vod_name"))
}

fn discover_urls(body: &str) -> Vec<String> {
    let mut values = Vec::new();
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        collect_strings(&value, &mut values);
    }
    values.extend(body.split_whitespace().map(str::to_string));
    values
        .into_iter()
        .filter_map(|value| valid_url(&value))
        .collect()
}

async fn wait_for_cancel(cancelled: Arc<AtomicBool>) {
    let mut interval = tokio::time::interval(Duration::from_millis(25));
    loop {
        interval.tick().await;
        if cancelled.load(Ordering::Acquire) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{endpoint_from_ext, is_candidate_api};

    #[test]
    fn extracts_plain_and_object_endpoints_without_using_opaque_tokens() {
        assert_eq!(
            endpoint_from_ext("csp_AppGet", "https://example.test|opaque-token"),
            Some("https://example.test/".to_string())
        );
        assert_eq!(
            endpoint_from_ext(
                "csp_Duopan",
                r#"{"site_urls":["https://one.test","https://two.test"]}"#
            ),
            Some("https://one.test/".to_string())
        );
        assert!(is_candidate_api("csp_AppQi"));
        assert!(!is_candidate_api("csp_GuaziTY"));
        assert!(!is_candidate_api("csp_Unknown"));
    }
}
