use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{json, Value};

use super::source_session::{read_bounded_response, SourceCapabilities};

const API: &str = "csp_bili";
const BASE_URL: &str = "https://api.bilibili.com";
#[derive(Debug)]
pub enum BiliError {
    Unsupported(String),
    Request(String),
}

pub fn is_supported(api: &str) -> bool {
    api.trim().eq_ignore_ascii_case(API)
}

pub fn capabilities() -> SourceCapabilities {
    SourceCapabilities {
        home: true,
        category: true,
        search: true,
        detail: true,
        playback: true,
        local_proxy: false,
        filters: false,
        pagination: true,
        engine: "http-json".to_string(),
    }
}

pub async fn call(
    method: &str,
    params: Option<&Value>,
    ext: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, BiliError> {
    let method = method.to_ascii_lowercase();
    match method.as_str() {
        "home" => {
            let response = get_json(
                "/x/web-interface/popular",
                vec![("ps", "20".to_string())],
                ext,
                headers,
                timeout,
                cancelled,
            )
            .await?;
            map_popular(&response).map_err(BiliError::Request)
        }
        "category" => {
            let page = params
                .and_then(|value| value.get("page"))
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .max(1);
            let response = get_json(
                "/x/web-interface/popular",
                vec![("ps", "20".to_string()), ("pn", page.to_string())],
                ext,
                headers,
                timeout,
                cancelled,
            )
            .await?;
            map_popular(&response).map_err(BiliError::Request)
        }
        "search" => {
            let key = params
                .and_then(|value| value.get("key"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim();
            if key.is_empty() {
                return Err(BiliError::Request("BILI_SEARCH_KEY_REQUIRED".to_string()));
            }
            let page = params
                .and_then(|value| value.get("page"))
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .max(1);
            let response = get_json(
                "/x/web-interface/search/type",
                vec![
                    ("search_type", "video".to_string()),
                    ("keyword", key.to_string()),
                    ("page", page.to_string()),
                ],
                ext,
                headers,
                timeout,
                cancelled,
            )
            .await?;
            map_search(&response).map_err(BiliError::Request)
        }
        "detail" => {
            let id = params
                .and_then(|value| value.get("ids"))
                .and_then(Value::as_array)
                .and_then(|ids| ids.first())
                .and_then(Value::as_str)
                .unwrap_or_default();
            let (bvid, _) = parse_detail_id(id).map_err(BiliError::Request)?;
            let response = get_json(
                "/x/web-interface/view",
                vec![("bvid", bvid)],
                ext,
                headers,
                timeout,
                cancelled,
            )
            .await?;
            map_detail(&response, id).map_err(BiliError::Request)
        }
        "player" | "playback" => {
            let id = params
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let (aid, cid) = parse_player_id(id).map_err(BiliError::Request)?;
            let response = get_json(
                "/x/player/playurl",
                vec![
                    ("avid", aid.to_string()),
                    ("cid", cid.to_string()),
                    ("fnval", "0".to_string()),
                    ("fourk", "1".to_string()),
                ],
                ext,
                headers,
                timeout,
                cancelled,
            )
            .await?;
            map_player(&response).map_err(BiliError::Request)
        }
        other => Err(BiliError::Unsupported(format!(
            "BILI_METHOD_UNAVAILABLE:{other}"
        ))),
    }
}

async fn get_json(
    path: &str,
    query: Vec<(&str, String)>,
    ext: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, BiliError> {
    let mut url = reqwest::Url::parse(BASE_URL)
        .and_then(|base| base.join(path))
        .map_err(|error| BiliError::Request(error.to_string()))?;
    for (name, value) in query {
        url.query_pairs_mut().append_pair(name, &value);
    }
    let mut request_headers = headers.clone();
    if !request_headers.contains_key("user-agent") {
        request_headers.insert(
            HeaderName::from_static("user-agent"),
            HeaderValue::from_static("Mozilla/5.0"),
        );
    }
    if !request_headers.contains_key("referer") {
        request_headers.insert(
            HeaderName::from_static("referer"),
            HeaderValue::from_static("https://www.bilibili.com/"),
        );
    }
    if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(ext) {
        if let Some(cookie) = object.get("cookie").and_then(Value::as_str) {
            if !cookie.starts_with("http") && !cookie.contains(['\r', '\n']) {
                if let Ok(value) = HeaderValue::from_str(cookie) {
                    request_headers.insert(HeaderName::from_static("cookie"), value);
                }
            }
        }
    }
    let client = reqwest::Client::builder()
        .default_headers(request_headers)
        .http1_only()
        .timeout(timeout)
        .build()
        .map_err(|error| BiliError::Request(error.to_string()))?;
    let response = tokio::select! {
        result = client.get(url).send() => result.map_err(|error| BiliError::Request(error.to_string()))?,
        _ = wait_for_cancel(cancelled.clone()) => return Err(BiliError::Request("BILI_REQUEST_CANCELLED".to_string())),
    };
    let status = response.status();
    let bytes = tokio::select! {
        result = read_bounded_response(response) => result.map_err(|error| {
            BiliError::Request(error.message("BILI_RESPONSE_TOO_LARGE"))
        })?,
        _ = wait_for_cancel(cancelled) => return Err(BiliError::Request("BILI_REQUEST_CANCELLED".to_string())),
    };
    if !status.is_success() {
        return Err(BiliError::Request(format!("BILI_HTTP_STATUS:{status}")));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| BiliError::Request(format!("BILI_JSON_INVALID:{error}")))
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

fn map_popular(response: &Value) -> Result<Value, String> {
    let data = response_data(response)?;
    let items = data
        .get("list")
        .and_then(Value::as_array)
        .ok_or_else(|| "BILI_POPULAR_LIST_MISSING".to_string())?;
    Ok(json!({
        "list": items.iter().filter_map(map_item).collect::<Vec<_>>(),
        "total": items.len()
    }))
}

fn map_search(response: &Value) -> Result<Value, String> {
    let data = response_data(response)?;
    let items = data
        .get("result")
        .and_then(Value::as_array)
        .ok_or_else(|| "BILI_SEARCH_RESULT_MISSING".to_string())?;
    Ok(json!({
        "list": items.iter().filter_map(map_item).collect::<Vec<_>>(),
        "total": data.get("numResults").cloned().unwrap_or_else(|| json!(items.len()))
    }))
}

fn map_item(value: &Value) -> Option<Value> {
    let bvid = value
        .get("bvid")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let aid = number_text(value.get("aid"));
    if bvid.is_empty() || aid.is_empty() {
        return None;
    }
    Some(json!({
        "vod_id": format!("{bvid}@{aid}"),
        "vod_name": clean_text(value.get("title").and_then(Value::as_str).unwrap_or_default()),
        "vod_pic": normalize_image(value.get("pic").and_then(Value::as_str).unwrap_or_default()),
        "vod_remarks": value.get("duration").and_then(Value::as_str).unwrap_or_default(),
        "vod_content": clean_text(value.get("description").and_then(Value::as_str).unwrap_or_default())
    }))
}

fn map_detail(response: &Value, requested_id: &str) -> Result<Value, String> {
    let data = response_data(response)?;
    let aid = number_text(data.get("aid"));
    if aid.is_empty() {
        return Err("BILI_DETAIL_AID_MISSING".to_string());
    }
    let bvid = data
        .get("bvid")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| requested_id.split_once('@').map(|(value, _)| value))
        .ok_or_else(|| "BILI_DETAIL_BVID_MISSING".to_string())?;
    let pages = data
        .get("pages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut episodes = Vec::new();
    for page in &pages {
        let cid = number_text(page.get("cid"));
        if cid.is_empty() {
            continue;
        }
        let part = clean_text(page.get("part").and_then(Value::as_str).unwrap_or_default());
        let label = if part.is_empty() { "正片" } else { &part };
        episodes.push(format!("{label}${aid}+{cid}"));
    }
    if episodes.is_empty() {
        let cid = number_text(data.get("cid"));
        if !cid.is_empty() {
            episodes.push(format!("正片${aid}+{cid}"));
        }
    }
    if episodes.is_empty() {
        return Err("BILI_DETAIL_CID_MISSING".to_string());
    }
    let owner = data
        .get("owner")
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    Ok(json!({
        "list": [{
            "vod_id": format!("{bvid}@{aid}"),
            "vod_name": clean_text(data.get("title").and_then(Value::as_str).unwrap_or_default()),
            "vod_pic": normalize_image(data.get("pic").and_then(Value::as_str).unwrap_or_default()),
            "vod_type": data.get("tname").cloned().unwrap_or_else(|| json!("哔哩哔哩")),
            "vod_actor": owner,
            "vod_content": clean_text(data.get("desc").and_then(Value::as_str).unwrap_or_default()),
            "vod_remarks": data.get("duration").cloned().unwrap_or_else(|| json!("")),
            "vod_play_from": "B站",
            "vod_play_url": episodes.join("#")
        }]
    }))
}

fn map_player(response: &Value) -> Result<Value, String> {
    let data = response_data(response)?;
    let url = data
        .get("durl")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("url").and_then(Value::as_str))
        .map(normalize_media_url)
        .find_map(Result::ok)
        .ok_or_else(|| "BILI_PLAYER_DURL_MISSING".to_string())?;
    Ok(json!({
        "parse": 0,
        "url": url,
        "header": {
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://www.bilibili.com/"
        }
    }))
}

fn response_data(response: &Value) -> Result<&Value, String> {
    if response.get("code").and_then(Value::as_i64).unwrap_or(-1) != 0 {
        return Err(format!(
            "BILI_API_ERROR:{}",
            response
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ));
    }
    response
        .get("data")
        .ok_or_else(|| "BILI_RESPONSE_DATA_MISSING".to_string())
}

fn parse_detail_id(value: &str) -> Result<(String, u64), String> {
    let (bvid, aid) = value
        .split_once('@')
        .ok_or_else(|| "BILI_DETAIL_ID_INVALID".to_string())?;
    if !bvid.starts_with("BV") || bvid.len() < 3 {
        return Err("BILI_DETAIL_ID_INVALID".to_string());
    }
    let aid = aid
        .parse::<u64>()
        .map_err(|_| "BILI_DETAIL_ID_INVALID".to_string())?;
    Ok((bvid.to_string(), aid))
}

fn parse_player_id(value: &str) -> Result<(u64, u64), String> {
    let (aid, cid) = value
        .split_once('+')
        .ok_or_else(|| "BILI_PLAYER_ID_INVALID".to_string())?;
    let aid = aid
        .parse::<u64>()
        .map_err(|_| "BILI_PLAYER_ID_INVALID".to_string())?;
    let cid = cid
        .parse::<u64>()
        .map_err(|_| "BILI_PLAYER_ID_INVALID".to_string())?;
    if aid == 0 || cid == 0 {
        return Err("BILI_PLAYER_ID_INVALID".to_string());
    }
    Ok((aid, cid))
}

fn number_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::Number(value)) => value.to_string(),
        Some(Value::String(value)) if !value.trim().is_empty() => value.trim().to_string(),
        _ => String::new(),
    }
}

fn normalize_image(value: &str) -> String {
    if value.starts_with("//") {
        format!("https:{value}")
    } else {
        value.to_string()
    }
}

fn normalize_media_url(value: &str) -> Result<String, String> {
    let value = if value.starts_with("//") {
        format!("https:{value}")
    } else {
        value.to_string()
    };
    let url =
        reqwest::Url::parse(value.trim()).map_err(|_| "BILI_PLAYER_URL_INVALID".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || url.username() != ""
        || url.password().is_some()
    {
        return Err("BILI_PLAYER_URL_INVALID".to_string());
    }
    Ok(url.to_string())
}

fn clean_text(value: &str) -> String {
    let mut output = String::new();
    let mut in_tag = false;
    for character in value.chars() {
        match character {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(character),
            _ => {}
        }
    }
    output
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use std::sync::{atomic::AtomicBool, Arc};
    use std::time::Duration;

    use reqwest::header::HeaderMap;
    use serde_json::json;

    use super::{map_detail, map_player, map_search};

    #[test]
    fn maps_bilibili_search_items_to_stable_tvbox_ids() {
        let result = map_search(&json!({
            "code": 0,
            "data": {"result": [{"aid": 7, "bvid": "BV1test", "title": "<em>急救</em>", "pic": "//img.test/a.jpg"}]}
        }))
        .expect("search maps");
        assert_eq!(result["list"][0]["vod_id"], "BV1test@7");
        assert_eq!(result["list"][0]["vod_name"], "急救");
        assert_eq!(result["list"][0]["vod_pic"], "https://img.test/a.jpg");
    }

    #[test]
    fn maps_bilibili_pages_to_direct_mp4_episode_ids() {
        let result = map_detail(
            &json!({
                "code": 0,
                "data": {
                    "aid": 7,
                    "bvid": "BV1test",
                    "title": "急救",
                    "pic": "https://img.test/a.jpg",
                    "desc": "说明",
                    "owner": {"name": "作者"},
                    "pages": [{"cid": 8, "part": "第1集"}]
                }
            }),
            "BV1test@7",
        )
        .expect("detail maps");
        assert_eq!(result["list"][0]["vod_play_from"], "B站");
        assert_eq!(result["list"][0]["vod_play_url"], "第1集$7+8");
    }

    #[test]
    fn maps_bilibili_durl_to_a_direct_player_result() {
        let result = map_player(&json!({
            "code": 0,
            "data": {"durl": [{"url": "https://video.test/a.mp4"}]}
        }))
        .expect("player maps");
        assert_eq!(result["parse"], 0);
        assert_eq!(result["url"], "https://video.test/a.mp4");
    }

    #[tokio::test]
    #[ignore = "real Bilibili endpoint canary"]
    async fn real_endpoint_completes_search_detail_and_mp4_player_chain() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let search = super::call(
            "search",
            Some(&json!({"key": "急救", "page": 1})),
            "",
            &HeaderMap::new(),
            Duration::from_secs(15),
            cancelled.clone(),
        )
        .await
        .expect("Bilibili search");
        let id = search["list"][0]["vod_id"]
            .as_str()
            .expect("Bilibili search id");
        let detail = super::call(
            "detail",
            Some(&json!({"ids": [id]})),
            "",
            &HeaderMap::new(),
            Duration::from_secs(15),
            cancelled.clone(),
        )
        .await
        .expect("Bilibili detail");
        let entry = detail["list"][0]["vod_play_url"]
            .as_str()
            .and_then(|value| value.split_once('$'))
            .map(|(_, value)| value)
            .expect("Bilibili episode");
        let player = super::call(
            "player",
            Some(&json!({"id": entry})),
            "",
            &HeaderMap::new(),
            Duration::from_secs(15),
            cancelled,
        )
        .await
        .expect("Bilibili player");
        assert_eq!(player["parse"], 0);
        assert!(player["url"]
            .as_str()
            .is_some_and(|value| value.starts_with("http")));
    }
}
