use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{json, Value};

const DOUBAN_API_KEY: &str = "0ac44ae016490db2204ce0a042db2916";
const DOUBAN_BASE: &str = "https://frodo.douban.com/api/v2";
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub enum NativeSourceError {
    Unsupported(String),
    Request(String),
}

pub fn is_native_api(api: &str) -> bool {
    matches!(
        api.to_ascii_lowercase().as_str(),
        "csp_douban" | "csp_jianpian"
    )
}

pub fn capabilities(api: &str) -> Option<super::source_session::SourceCapabilities> {
    match api.to_ascii_lowercase().as_str() {
        "csp_douban" => Some(super::source_session::SourceCapabilities {
            home: true,
            category: true,
            search: true,
            detail: true,
            playback: false,
            local_proxy: false,
            filters: true,
            pagination: true,
            engine: "native".to_string(),
        }),
        "csp_jianpian" => Some(super::source_session::SourceCapabilities {
            home: true,
            category: true,
            search: true,
            detail: true,
            playback: true,
            local_proxy: false,
            filters: true,
            pagination: true,
            engine: "native".to_string(),
        }),
        _ => None,
    }
}

pub async fn call(
    api: &str,
    method: &str,
    params: Option<&Value>,
    ext: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, NativeSourceError> {
    match api.to_ascii_lowercase().as_str() {
        "csp_douban" => call_douban(method, params, headers, timeout, cancelled).await,
        "csp_jianpian" => super::jianpian::call(method, params, ext, headers, timeout, cancelled)
            .await
            .map_err(|error| match error {
                super::jianpian::JianpianError::Unsupported(message) => {
                    NativeSourceError::Unsupported(message)
                }
                super::jianpian::JianpianError::Request(message) => {
                    NativeSourceError::Request(message)
                }
            }),
        _ => Err(NativeSourceError::Unsupported(format!(
            "native source is unavailable: {api}"
        ))),
    }
}

async fn call_douban(
    method: &str,
    params: Option<&Value>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, NativeSourceError> {
    let (url, transform) = match method {
        "home" => (
            format!("{DOUBAN_BASE}/subject_collection/subject_real_time_hotest/items"),
            Transform::Home,
        ),
        "category" => category_url(params)?,
        "search" => (
            "https://frodo.douban.com/rexxar/api/v2/search/subjects".to_string(),
            Transform::Search,
        ),
        "detail" => detail_url(params)?,
        _ => {
            return Err(NativeSourceError::Unsupported(format!(
                "Douban method is unavailable: {method}"
            )))
        }
    };
    let mut url =
        reqwest::Url::parse(&url).map_err(|error| NativeSourceError::Request(error.to_string()))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("apikey", DOUBAN_API_KEY);
        if method == "search" {
            let key = params
                .and_then(|value| value.get("key"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let page = params
                .and_then(|value| value.get("page"))
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .max(1);
            query.append_pair("q", key);
            query.append_pair("start", &((page - 1) * 20).to_string());
            query.append_pair("count", "20");
        }
    }
    let mut request_headers = headers.clone();
    if !request_headers.contains_key("user-agent") {
        request_headers.insert(
            HeaderName::from_static("user-agent"),
            HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) QX-Yingshi/1.0"),
        );
    }
    if !request_headers.contains_key("referer") {
        request_headers.insert(
            HeaderName::from_static("referer"),
            HeaderValue::from_static("https://movie.douban.com/"),
        );
    }
    let client = reqwest::Client::builder()
        .default_headers(request_headers)
        .timeout(timeout)
        .build()
        .map_err(|error| NativeSourceError::Request(error.to_string()))?;
    let response = tokio::select! {
        result = client.get(url).send() => result.map_err(|error| NativeSourceError::Request(error.to_string()))?,
        _ = wait_for_cancel(cancelled.clone()) => return Err(NativeSourceError::Request("native source request cancelled".to_string())),
    };
    let status = response.status();
    let body = response
        .bytes()
        .await
        .map_err(|error| NativeSourceError::Request(error.to_string()))?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(NativeSourceError::Request(
            "native source response is too large".to_string(),
        ));
    }
    if !status.is_success() {
        return Err(NativeSourceError::Request(format!(
            "native source returned {status}"
        )));
    }
    let value: Value = serde_json::from_slice(&body).map_err(|error| {
        NativeSourceError::Request(format!("native source JSON is invalid: {error}"))
    })?;
    Ok(transform.apply(value))
}

enum Transform {
    Home,
    Category,
    Search,
    Detail,
}

impl Transform {
    fn apply(self, value: Value) -> Value {
        match self {
            Self::Home => json!({
                "class": [
                    { "type_id": "hot_gaia", "type_name": "热门电影" },
                    { "type_id": "tv_hot", "type_name": "热播剧集" },
                    { "type_id": "show_hot", "type_name": "热播综艺" },
                    { "type_id": "movie", "type_name": "电影筛选" },
                    { "type_id": "tv", "type_name": "电视筛选" },
                ],
                "list": value.get("subject_collection_items").map(|items| map_items(items)).unwrap_or_else(|| json!([])),
            }),
            Self::Category => {
                json!({ "list": value.get("items").or_else(|| value.get("subject_collection_items")).map(|items| map_items(items)).unwrap_or_else(|| json!([])), "total": value.get("total").cloned().unwrap_or(json!(0)) })
            }
            Self::Search => {
                json!({ "list": value.get("subjects").and_then(|items| items.get("items")).map(|items| map_items(items)).unwrap_or_else(|| json!([])), "total": value.get("subjects").and_then(|items| items.get("total")).cloned().unwrap_or(json!(0)) })
            }
            Self::Detail => value,
        }
    }
}

fn map_items(value: &Value) -> Value {
    let Some(items) = value.as_array() else {
        return json!([]);
    };
    Value::Array(items.iter().map(|item| {
        json!({
            "vod_id": item.get("id").map(|id| format!("msearch:{}", id.as_str().unwrap_or(&id.to_string()))).unwrap_or_default(),
            "vod_name": item.get("title").cloned().unwrap_or(Value::String(String::new())),
            "vod_pic": item.get("pic").and_then(|pic| pic.get("normal")).or_else(|| item.get("cover_url")).cloned().unwrap_or(Value::String(String::new())),
            "vod_remarks": item.get("rating").and_then(|rating| rating.get("value")).map(|rating| format!("评分：{rating}")).unwrap_or_default(),
        })
    }).collect())
}

fn category_url(params: Option<&Value>) -> Result<(String, Transform), NativeSourceError> {
    let type_id = params
        .and_then(|value| value.get("typeId"))
        .and_then(Value::as_str)
        .unwrap_or("hot_gaia");
    let page = params
        .and_then(|value| value.get("page"))
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .max(1);
    let start = (page - 1) * 20;
    let url = match type_id {
        "hot_gaia" => format!("{DOUBAN_BASE}/movie/hot_gaia?start={start}&count=20"),
        "tv_hot" | "show_hot" => format!("{DOUBAN_BASE}/subject_collection/subject_real_time_hotest/items?start={start}&count=20"),
        "movie" => format!("{DOUBAN_BASE}/movie/recommend?start={start}&count=20"),
        "tv" => format!("{DOUBAN_BASE}/tv/recommend?start={start}&count=20"),
        _ => return Err(NativeSourceError::Unsupported(format!("Douban category is unavailable: {type_id}"))),
    };
    Ok((url, Transform::Category))
}

fn detail_url(params: Option<&Value>) -> Result<(String, Transform), NativeSourceError> {
    let id = params
        .and_then(|value| value.get("ids"))
        .and_then(Value::as_array)
        .and_then(|ids| ids.first())
        .and_then(Value::as_str)
        .unwrap_or_default();
    let id = id.strip_prefix("msearch:").unwrap_or(id);
    if id.is_empty() {
        return Err(NativeSourceError::Request(
            "Douban detail id is required".to_string(),
        ));
    }
    Ok((format!("{DOUBAN_BASE}/movie/{id}"), Transform::Detail))
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
    use super::{capabilities, is_native_api, map_items};
    use serde_json::json;

    #[test]
    fn exposes_only_explicit_native_source_bindings() {
        assert!(is_native_api("csp_Douban"));
        assert!(is_native_api("csp_Jianpian"));
        assert!(!is_native_api("csp_Unknown"));
        assert_eq!(
            capabilities("csp_Douban")
                .expect("Douban capabilities")
                .playback,
            false
        );
        assert_eq!(
            capabilities("csp_Jianpian")
                .expect("Jianpian capabilities")
                .engine,
            "native"
        );
    }

    #[test]
    fn maps_known_douban_item_fields_without_claiming_playback() {
        let result = map_items(
            &json!([{ "id": "1", "title": "Movie", "pic": { "normal": "https://img.invalid/a.jpg" }, "rating": { "value": 8.2 } }]),
        );
        assert_eq!(result[0]["vod_id"], "msearch:1");
        assert_eq!(result[0]["vod_name"], "Movie");
        assert_eq!(result[0]["vod_remarks"], "评分：8.2");
    }
}
