use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, USER_AGENT};
use serde_json::{json, Value};

const CATEGORY_ID: &str = "88";
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Linux; Android 11; Redmi K30 Pro Zoom Edition Build/RKQ1.200826.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/90.0.4430.210 Mobile Safari/537.36;webank/h5face;webank/1.0;netType:NETWORK_WIFI;appVersion:416;packageName:com.jp3.xg3";

#[derive(Debug)]
pub enum JianpianError {
    Unsupported(String),
    Request(String),
}

pub async fn call(
    method: &str,
    params: Option<&Value>,
    ext: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, JianpianError> {
    let base = normalize_base(ext)?;
    let client = client(headers, timeout)?;
    let img_base = match method {
        "init" => None,
        _ => Some(fetch_image_base(&client, &base, cancelled.clone()).await?),
    };

    match method {
        "init" => {
            let config =
                request_json(&client, &base, "/api/appAuthConfig", Vec::new(), cancelled).await?;
            Ok(json!({
                "imgDomain": config
                    .get("data")
                    .and_then(|data| data.get("imgDomain"))
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            }))
        }
        "home" => {
            let value = request_json(
                &client,
                &base,
                "/api/dyTag/list",
                vec![("category_id", CATEGORY_ID.to_string())],
                cancelled,
            )
            .await?;
            Ok(json!({
                "class": categories(),
                "list": flatten_cards(value.get("data"), img_base.as_deref()),
            }))
        }
        "homevideo" | "home_video" => {
            let value = request_json(
                &client,
                &base,
                "/api/dyTag/list",
                vec![("category_id", CATEGORY_ID.to_string())],
                cancelled,
            )
            .await?;
            Ok(json!({
                "list": flatten_cards(value.get("data"), img_base.as_deref()),
            }))
        }
        "category" => {
            let params = params.cloned().unwrap_or_else(|| json!({}));
            let type_id = string_param(&params, "typeId", "1");
            let page = number_param(&params, "page", 1).max(1);
            let extend = params.get("extend").or_else(|| params.get("filter"));
            let mut query = vec![("category_id", type_id.clone()), ("page", page.to_string())];
            if let Some(extend) = extend {
                query.push(("area", string_param(extend, "area", "0")));
                query.push(("sort", string_param(extend, "sort", "update")));
                query.push(("year", string_param(extend, "year", "0")));
                if extend.get("cateId").is_some() {
                    query.push(("category_id", string_param(extend, "cateId", &type_id)));
                }
            }
            let value = request_json(&client, &base, "/api/dyTag/list", query, cancelled).await?;
            Ok(json!({
                "page": page,
                "list": flatten_cards(value.get("data"), img_base.as_deref()),
            }))
        }
        "search" => {
            let params = params.cloned().unwrap_or_else(|| json!({}));
            let key = string_param(&params, "key", "");
            if key.trim().is_empty() {
                return Err(JianpianError::Request(
                    "Jianpian search key is required".to_string(),
                ));
            }
            let page = number_param(&params, "page", 1).max(1);
            let value = request_json(
                &client,
                &base,
                "/api/v2/search/videoV2",
                vec![
                    ("key", key),
                    ("category_id", CATEGORY_ID.to_string()),
                    ("page", page.to_string()),
                    ("pageSize", "20".to_string()),
                ],
                cancelled,
            )
            .await?;
            Ok(json!({
                "page": page,
                "list": search_cards(value.get("data"), img_base.as_deref()),
            }))
        }
        "detail" => {
            let id = params
                .and_then(|value| value.get("ids"))
                .and_then(Value::as_array)
                .and_then(|ids| ids.first())
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| {
                    JianpianError::Request("Jianpian detail id is required".to_string())
                })?;
            let value = request_json(
                &client,
                &base,
                "/api/video/detailv2",
                vec![("id", id.to_string())],
                cancelled,
            )
            .await?;
            let data = value.get("data").unwrap_or(&Value::Null);
            Ok(json!({ "list": [detail_card(data, img_base.as_deref())] }))
        }
        "player" | "playback" => player(params),
        _ => Err(JianpianError::Unsupported(format!(
            "Jianpian method is unavailable: {method}"
        ))),
    }
}

fn normalize_base(ext: &str) -> Result<String, JianpianError> {
    let base = ext.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(JianpianError::Unsupported(
            "native_jianpian_ext_required".to_string(),
        ));
    }
    let url = reqwest::Url::parse(base).map_err(|error| {
        JianpianError::Unsupported(format!("native_jianpian_ext_invalid: {error}"))
    })?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(JianpianError::Unsupported(
            "native_jianpian_ext_must_be_http_url".to_string(),
        ));
    }
    Ok(base.to_string())
}

fn client(headers: &HeaderMap, timeout: Duration) -> Result<reqwest::Client, JianpianError> {
    let mut merged = headers.clone();
    merged
        .entry(USER_AGENT)
        .or_insert_with(|| HeaderValue::from_static(DEFAULT_USER_AGENT));
    merged
        .entry(ACCEPT)
        .or_insert_with(|| HeaderValue::from_static("application/json, text/plain, */*"));
    merged
        .entry(HeaderName::from_static("x-requested-with"))
        .or_insert_with(|| HeaderValue::from_static("com.jp3.xg3"));
    reqwest::Client::builder()
        .default_headers(merged)
        .timeout(timeout)
        .build()
        .map_err(|error| JianpianError::Request(error.to_string()))
}

async fn fetch_image_base(
    client: &reqwest::Client,
    base: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<String, JianpianError> {
    let value = request_json(client, base, "/api/appAuthConfig", Vec::new(), cancelled).await?;
    let domain = value
        .get("data")
        .and_then(|data| data.get("imgDomain"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if domain.is_empty() {
        return Ok(String::new());
    }
    Ok(
        if domain.starts_with("http://") || domain.starts_with("https://") {
            domain.trim_end_matches('/').to_string()
        } else {
            format!("https://{}", domain.trim_end_matches('/'))
        },
    )
}

async fn request_json(
    client: &reqwest::Client,
    base: &str,
    path: &str,
    query: Vec<(&str, String)>,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, JianpianError> {
    let mut url =
        reqwest::Url::parse(base).map_err(|error| JianpianError::Request(error.to_string()))?;
    url.set_path(path);
    {
        let mut pairs = url.query_pairs_mut();
        pairs.clear();
        for (key, value) in query {
            pairs.append_pair(key, &value);
        }
    }
    let response = tokio::select! {
        result = client.get(url).send() => result.map_err(|error| JianpianError::Request(error.to_string()))?,
        _ = wait_for_cancel(cancelled.clone()) => return Err(JianpianError::Request("native Jianpian request cancelled".to_string())),
    };
    let status = response.status();
    let bytes = tokio::select! {
        result = response.bytes() => result.map_err(|error| JianpianError::Request(error.to_string()))?,
        _ = wait_for_cancel(cancelled) => return Err(JianpianError::Request("native Jianpian request cancelled".to_string())),
    };
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(JianpianError::Request(
            "native Jianpian response is too large".to_string(),
        ));
    }
    if !status.is_success() {
        return Err(JianpianError::Request(format!(
            "native Jianpian returned {status}"
        )));
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        JianpianError::Request(format!("native Jianpian JSON is invalid: {error}"))
    })
}

fn categories() -> Value {
    json!([
        { "type_id": "1", "type_name": "电影" },
        { "type_id": "2", "type_name": "电视剧" },
        { "type_id": "3", "type_name": "动漫" },
        { "type_id": "4", "type_name": "综艺" },
        { "type_id": "99", "type_name": "Netflix" },
        { "type_id": "50", "type_name": "纪录片" },
    ])
}

fn flatten_cards(data: Option<&Value>, image_base: Option<&str>) -> Value {
    let mut items = Vec::new();
    for group in data.and_then(Value::as_array).into_iter().flatten() {
        for item in group
            .get("dataList")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            items.push(card(item, image_base));
        }
    }
    Value::Array(items)
}

fn search_cards(data: Option<&Value>, image_base: Option<&str>) -> Value {
    Value::Array(
        data.and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|item| card(item, image_base))
            .collect(),
    )
}

fn card(item: &Value, image_base: Option<&str>) -> Value {
    let image = image_value(item, image_base);
    json!({
        "vod_id": value_string(item, "id"),
        "vod_name": value_string(item, "title"),
        "vod_pic": image,
        "vod_remarks": value_string(item, "mask"),
    })
}

fn detail_card(item: &Value, image_base: Option<&str>) -> Value {
    let title = value_string(item, "title");
    let mut play_from = Vec::new();
    let mut play_urls = Vec::new();
    for group in item
        .get("source_list_source")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = value_string(group, "name");
        let mut episodes = Vec::new();
        for (index, episode) in group
            .get("source_list")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let episode_name = non_empty_string(episode, &["source_name", "weight"])
                .unwrap_or_else(|| (index + 1).to_string());
            let url = value_string(episode, "url");
            if url.is_empty() {
                continue;
            }
            let url = if url.contains("ftp") {
                url.replace("ftp", "tvbox-xg:ftp")
            } else {
                url
            };
            episodes.push(format!("{episode_name}${url}|{}|{title}", index + 1));
        }
        if !episodes.is_empty() {
            play_from.push(name);
            play_urls.push(episodes.join("#"));
        }
    }
    json!({
        "vod_id": value_string(item, "id"),
        "vod_name": title,
        "vod_pic": image_value(item, image_base),
        "type_name": joined_titles(item.get("types")),
        "vod_year": value_string(item, "year"),
        "vod_area": value_string(item, "area"),
        "vod_remarks": value_string(item, "mask"),
        "vod_actor": joined_titles(item.get("actors")),
        "vod_director": joined_titles(item.get("directors")),
        "vod_content": value_string(item, "description").replace('\u{3000}', ""),
        "vod_play_from": play_from.join("$$$"),
        "vod_play_url": play_urls.join("$$$"),
    })
}

fn player(params: Option<&Value>) -> Result<Value, JianpianError> {
    let id = params
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| JianpianError::Request("Jianpian player id is required".to_string()))?;
    let url = id.split('|').next().unwrap_or_default().trim();
    if url.starts_with("tvbox-xg:") || url.starts_with("ftp") {
        return Err(JianpianError::Unsupported(
            "native_jianpian_ftp_requires_downloader_component".to_string(),
        ));
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(JianpianError::Request(
            "native Jianpian episode does not contain an HTTP playback URL".to_string(),
        ));
    }
    Ok(json!({
        "parse": 0,
        "jx": 0,
        "url": url,
        "header": {
            "User-Agent": DEFAULT_USER_AGENT,
            "Accept": "application/json, text/plain, */*",
            "X-Requested-With": "com.jp3.xg3",
        },
    }))
}

fn image_value(item: &Value, image_base: Option<&str>) -> String {
    let path = non_empty_string(item, &["tvimg", "path", "thumbnail"]).unwrap_or_default();
    if path.is_empty() || path.starts_with("http://") || path.starts_with("https://") {
        return path;
    }
    format!("{}{}", image_base.unwrap_or_default(), path)
}

fn joined_titles(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| non_empty_string(item, &["title", "name"]))
        .collect::<Vec<_>>()
        .join(" ")
}

fn value_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|item| {
            item.as_str()
                .map(ToString::to_string)
                .or_else(|| item.as_i64().map(|number| number.to_string()))
        })
        .unwrap_or_default()
}

fn non_empty_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .map(|key| value_string(value, key))
        .find(|value| !value.trim().is_empty())
}

fn string_param(value: &Value, key: &str, fallback: &str) -> String {
    let value = value_string(value, key);
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn number_param(value: &Value, key: &str, fallback: u64) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(fallback)
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
    use super::{call, categories, detail_card, normalize_base, player};
    use reqwest::header::HeaderMap;
    use serde_json::json;
    use std::sync::{atomic::AtomicBool, Arc};
    use std::time::Duration;

    #[test]
    fn requires_the_configured_http_endpoint() {
        assert!(normalize_base("").is_err());
        assert!(normalize_base("file:///tmp/jianpian").is_err());
        assert_eq!(
            normalize_base("https://api.ztcgi.com/").unwrap(),
            "https://api.ztcgi.com"
        );
    }

    #[test]
    fn maps_native_detail_sources_to_tvbox_playback_contract() {
        let value = json!({
            "id": 24506,
            "title": "流浪地球",
            "source_list_source": [{
                "name": "VIP线路",
                "source_list": [{
                    "source_name": "正片",
                    "url": "https://media.example.invalid/one.m3u8"
                }]
            }]
        });
        let mapped = detail_card(&value, Some("https://img.example.invalid"));
        assert_eq!(mapped["vod_id"], "24506");
        assert_eq!(mapped["vod_play_from"], "VIP线路");
        assert_eq!(
            mapped["vod_play_url"],
            "正片$https://media.example.invalid/one.m3u8|1|流浪地球"
        );
    }

    #[test]
    fn player_accepts_only_explicit_http_urls() {
        let result = player(Some(
            &json!({ "id": "https://media.example.invalid/one.m3u8|1|title" }),
        ))
        .expect("player result");
        assert_eq!(result["parse"], 0);
        assert_eq!(result["jx"], 0);
        assert_eq!(result["url"], "https://media.example.invalid/one.m3u8");
        assert!(player(Some(
            &json!({ "id": "tvbox-xg:ftp://example.invalid/file" })
        ))
        .is_err());
    }

    #[test]
    fn exposes_the_six_native_categories() {
        assert_eq!(categories().as_array().map(Vec::len), Some(6));
    }

    #[tokio::test]
    #[ignore = "real network canary; run explicitly with cargo test -- --ignored"]
    async fn real_endpoint_completes_native_search_detail_and_player_chain() {
        let endpoint = std::env::var("QX_JIANPIAN_ENDPOINT")
            .unwrap_or_else(|_| "https://api.ztcgi.com".to_string());
        let cancelled = Arc::new(AtomicBool::new(false));
        let search = call(
            "search",
            Some(&json!({ "key": "流浪地球", "page": 1 })),
            &endpoint,
            &HeaderMap::new(),
            Duration::from_secs(30),
            cancelled.clone(),
        )
        .await
        .expect("Jianpian search");
        let id = search["list"][0]["vod_id"]
            .as_str()
            .expect("search id")
            .to_string();
        let detail = call(
            "detail",
            Some(&json!({ "ids": [id] })),
            &endpoint,
            &HeaderMap::new(),
            Duration::from_secs(30),
            cancelled.clone(),
        )
        .await
        .expect("Jianpian detail");
        let episode = detail["list"][0]["vod_play_url"]
            .as_str()
            .and_then(|value| value.split('#').next())
            .and_then(|value| value.split('$').nth(1))
            .expect("direct Jianpian episode")
            .to_string();
        let playback = call(
            "player",
            Some(&json!({ "id": episode })),
            &endpoint,
            &HeaderMap::new(),
            Duration::from_secs(30),
            cancelled,
        )
        .await
        .expect("Jianpian player");
        assert_eq!(playback["parse"], 0);
        assert!(playback["url"]
            .as_str()
            .is_some_and(|value| value.starts_with("http")));
    }
}
