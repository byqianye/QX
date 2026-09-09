use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{json, Value};

use super::source_session::{read_bounded_response, SourceCapabilities};

const API: &str = "csp_firstaid";
const BASE_URL: &str = "https://m.youlai.cn";
#[derive(Debug)]
pub enum FirstAidError {
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
        search: false,
        detail: true,
        playback: true,
        local_proxy: false,
        filters: false,
        pagination: false,
        engine: "http-html".to_string(),
    }
}

pub async fn call(
    method: &str,
    params: Option<&Value>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, FirstAidError> {
    let method = method.to_ascii_lowercase();
    match method.as_str() {
        "search" => Err(FirstAidError::Unsupported(
            "FIRST_AID_SEARCH_NOT_AVAILABLE".to_string(),
        )),
        "player" | "playback" => {
            let id = params
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let url = normalize_playback_url(id).map_err(FirstAidError::Request)?;
            Ok(json!({
                "parse": 0,
                "url": url,
                "header": {"User-Agent": "Mozilla/5.0"}
            }))
        }
        "home" | "category" | "detail" => {
            let path = match method.as_str() {
                "home" | "category" => "/jijiu".to_string(),
                "detail" => {
                    let id = params
                        .and_then(|value| value.get("ids"))
                        .and_then(Value::as_array)
                        .and_then(|ids| ids.first())
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    normalize_page_url(id).map_err(FirstAidError::Request)?
                }
                _ => unreachable!(),
            };
            let body = get_html(&path, headers, timeout, cancelled).await?;
            match method.as_str() {
                "home" => Ok(home_result()),
                "category" => {
                    let index = category_index(params)?;
                    parse_category(&body, index).map_err(FirstAidError::Request)
                }
                "detail" => {
                    let id = params
                        .and_then(|value| value.get("ids"))
                        .and_then(Value::as_array)
                        .and_then(|ids| ids.first())
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    parse_detail(&body, id).map_err(FirstAidError::Request)
                }
                _ => unreachable!(),
            }
        }
        other => Err(FirstAidError::Unsupported(format!(
            "FIRST_AID_METHOD_UNAVAILABLE:{other}"
        ))),
    }
}

async fn get_html(
    path: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<String, FirstAidError> {
    let url = reqwest::Url::parse(BASE_URL)
        .and_then(|base| base.join(path))
        .map_err(|error| FirstAidError::Request(error.to_string()))?;
    let mut request_headers = headers.clone();
    if !request_headers.contains_key("user-agent") {
        request_headers.insert(
            HeaderName::from_static("user-agent"),
            HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) QX-Yingshi/1.0"),
        );
    }
    let client = reqwest::Client::builder()
        .default_headers(request_headers)
        .timeout(timeout)
        .build()
        .map_err(|error| FirstAidError::Request(error.to_string()))?;
    let response = tokio::select! {
        result = client.get(url).send() => result.map_err(|error| FirstAidError::Request(error.to_string()))?,
        _ = wait_for_cancel(cancelled.clone()) => return Err(FirstAidError::Request("FIRST_AID_REQUEST_CANCELLED".to_string())),
    };
    let status = response.status();
    let bytes = tokio::select! {
        result = read_bounded_response(response) => result.map_err(|error| {
            FirstAidError::Request(error.message("FIRST_AID_RESPONSE_TOO_LARGE"))
        })?,
        _ = wait_for_cancel(cancelled) => return Err(FirstAidError::Request("FIRST_AID_REQUEST_CANCELLED".to_string())),
    };
    if !status.is_success() {
        return Err(FirstAidError::Request(format!(
            "FIRST_AID_HTTP_STATUS:{status}"
        )));
    }
    Ok(String::from_utf8_lossy(&bytes)
        .trim_start_matches('\u{feff}')
        .to_string())
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

fn home_result() -> Value {
    json!({
        "class": [
            {"type_id": "jijiu|0", "type_name": "急救技能"},
            {"type_id": "jijiu|1", "type_name": "家庭生活"},
            {"type_id": "jijiu|2", "type_name": "急危重症"},
            {"type_id": "jijiu|3", "type_name": "常见损伤"},
            {"type_id": "jijiu|4", "type_name": "动物致伤"},
            {"type_id": "jijiu|5", "type_name": "海洋急救"},
            {"type_id": "jijiu|6", "type_name": "中毒急救"},
            {"type_id": "jijiu|7", "type_name": "意外事故"}
        ],
        "list": []
    })
}

fn category_index(params: Option<&Value>) -> Result<usize, FirstAidError> {
    let type_id = params
        .and_then(|value| value.get("typeId"))
        .and_then(Value::as_str)
        .unwrap_or("jijiu|0");
    let (prefix, index) = type_id
        .split_once('|')
        .ok_or_else(|| FirstAidError::Request("FIRST_AID_CATEGORY_ID_INVALID".to_string()))?;
    if prefix != "jijiu" {
        return Err(FirstAidError::Request(
            "FIRST_AID_CATEGORY_ID_INVALID".to_string(),
        ));
    }
    index
        .parse::<usize>()
        .ok()
        .filter(|value| *value < 8)
        .ok_or_else(|| FirstAidError::Request("FIRST_AID_CATEGORY_ID_INVALID".to_string()))
}

fn normalize_page_url(value: &str) -> Result<String, String> {
    let url = resolve_url(value)?;
    if url.host_str() != Some("m.youlai.cn")
        || !url.path().starts_with("/jijiu/")
        || url.username() != ""
        || url.password().is_some()
    {
        return Err("FIRST_AID_DETAIL_URL_INVALID".to_string());
    }
    Ok(url.to_string())
}

pub fn normalize_playback_url(value: &str) -> Result<String, String> {
    let url = resolve_url(value)?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("m.youlai.cn") | Some("vod.youlai.cn"))
        || url.username() != ""
        || url.password().is_some()
        || url.path().is_empty()
    {
        return Err("FIRST_AID_PLAYBACK_URL_INVALID".to_string());
    }
    Ok(url.to_string())
}

fn resolve_url(value: &str) -> Result<reqwest::Url, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("FIRST_AID_URL_REQUIRED".to_string());
    }
    reqwest::Url::parse(BASE_URL)
        .and_then(|base| base.join(value))
        .map_err(|error| format!("FIRST_AID_URL_INVALID:{error}"))
}

fn absolute_resource_url(value: &str) -> Result<String, String> {
    resolve_url(value).map(|url| url.to_string())
}

fn parse_category(html: &str, index: usize) -> Result<Value, String> {
    let sections = elements(html, "div", Some("jj-title-li"));
    let section = sections
        .get(index)
        .ok_or_else(|| "FIRST_AID_CATEGORY_SECTION_MISSING".to_string())?;
    let image = elements(section, "img", Some("block100"))
        .first()
        .and_then(|tag| attribute(tag, "src"))
        .map(|value| absolute_resource_url(&value))
        .transpose()?
        .unwrap_or_default();
    let mut list = Vec::new();
    for item in elements(section, "li", Some("list-br3")) {
        let Some(anchor) = opening_tags(item, "a").next() else {
            continue;
        };
        let href = attribute(anchor, "href").unwrap_or_default();
        let vod_id = normalize_page_url(&href)?;
        let title = elements(item, "div", Some("line-clamp1"))
            .first()
            .map(|value| text(value))
            .unwrap_or_else(|| text(item));
        if title.is_empty() {
            continue;
        }
        list.push(json!({
            "vod_id": vod_id,
            "vod_name": title,
            "vod_pic": image
        }));
    }
    let total = list.len();
    Ok(json!({"list": list, "page": 1, "pagecount": 1, "limit": total, "total": total}))
}

fn parse_detail(html: &str, id: &str) -> Result<Value, String> {
    let title = ["h1", "h2", "div", "span"]
        .into_iter()
        .find_map(|tag| {
            elements(html, tag, Some("video-title"))
                .first()
                .map(|value| text(value))
        })
        .unwrap_or_default();
    if title.is_empty() {
        return Err("FIRST_AID_DETAIL_TITLE_MISSING".to_string());
    }
    let pic = elements(html, "div", Some("video-cover"))
        .first()
        .and_then(|value| opening_tags(value, "img").next())
        .and_then(|tag| attribute(tag, "src"))
        .map(|value| absolute_resource_url(&value))
        .transpose()?
        .unwrap_or_default();
    let actor = elements(html, "span", Some("doc-name"))
        .first()
        .map(|value| text(value))
        .unwrap_or_default();
    let content = elements(html, "div", Some("img-text-con"))
        .first()
        .map(|value| text(value))
        .unwrap_or_default();
    let video = opening_tags(html, "video")
        .find(|tag| attribute(tag, "id").as_deref() == Some("video"))
        .ok_or_else(|| "FIRST_AID_DETAIL_VIDEO_MISSING".to_string())?;
    let play_value = attribute(video, "src")
        .or_else(|| {
            opening_tags(html, "source")
                .next()
                .and_then(|tag| attribute(tag, "src"))
        })
        .ok_or_else(|| "FIRST_AID_DETAIL_PLAYBACK_MISSING".to_string())?;
    let play_url = normalize_playback_url(&play_value)?;
    let vod_id = normalize_page_url(id)?;
    Ok(json!({
        "list": [{
            "vod_id": vod_id,
            "vod_name": title,
            "vod_pic": pic,
            "vod_actor": actor,
            "vod_area": "中国",
            "vod_content": content,
            "vod_play_from": "Qile",
            "vod_play_url": format!("{title}${play_url}")
        }]
    }))
}

fn elements<'a>(html: &'a str, tag: &str, class_token: Option<&str>) -> Vec<&'a str> {
    let mut result = Vec::new();
    let mut cursor = 0;
    while let Some((start, end, opening)) = next_opening_tag(html, cursor, tag) {
        if class_token.is_none_or(|token| has_class(opening, token)) {
            let element_end = matching_end(html, start, end, tag).unwrap_or(html.len());
            result.push(&html[start..element_end]);
            cursor = element_end;
        } else {
            cursor = end;
        }
    }
    result
}

fn opening_tags<'a>(html: &'a str, tag: &str) -> impl Iterator<Item = &'a str> {
    let mut values = Vec::new();
    let mut cursor = 0;
    while let Some((start, end, _)) = next_opening_tag(html, cursor, tag) {
        values.push(&html[start..end]);
        cursor = end;
    }
    values.into_iter()
}

fn next_opening_tag<'a>(
    html: &'a str,
    mut cursor: usize,
    wanted_tag: &str,
) -> Option<(usize, usize, &'a str)> {
    while let Some(relative) = html[cursor..].find('<') {
        let start = cursor + relative;
        let end = html[start..].find('>')? + start + 1;
        let raw = &html[start..end];
        let name = tag_name(raw)?;
        if name.eq_ignore_ascii_case(wanted_tag)
            && !raw[1..].trim_start().starts_with('/')
            && !raw.starts_with("<!--")
        {
            return Some((start, end, raw));
        }
        cursor = end;
    }
    None
}

fn matching_end(html: &str, open_start: usize, open_end: usize, tag: &str) -> Option<usize> {
    let opening = &html[open_start..open_end];
    if opening.trim_end().ends_with("/>") || matches!(tag, "img" | "source" | "meta" | "input") {
        return Some(open_end);
    }
    let mut depth = 1usize;
    let mut cursor = open_end;
    while let Some(relative) = html[cursor..].find('<') {
        let start = cursor + relative;
        let end = html[start..].find('>')? + start + 1;
        let raw = &html[start..end];
        let name = tag_name(raw);
        if name
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case(tag))
        {
            if raw[1..].trim_start().starts_with('/') {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(end);
                }
            } else if !raw.trim_end().ends_with("/>") {
                depth += 1;
            }
        }
        cursor = end;
    }
    None
}

fn tag_name(tag: &str) -> Option<String> {
    let body = tag.strip_prefix('<')?.trim_start_matches('/').trim_start();
    let end = body
        .find(|character: char| {
            character.is_ascii_whitespace() || character == '>' || character == '/'
        })
        .unwrap_or(body.len());
    (!body[..end].is_empty()).then(|| body[..end].to_ascii_lowercase())
}

fn has_class(tag: &str, expected: &str) -> bool {
    attribute(tag, "class")
        .is_some_and(|value| value.split_whitespace().any(|token| token == expected))
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let name = name.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(relative) = lower[cursor..].find(&name) {
        let start = cursor + relative;
        let before_ok = start == 0 || !lower.as_bytes()[start - 1].is_ascii_alphanumeric();
        let after_name = start + name.len();
        let after_ok =
            after_name >= lower.len() || !lower.as_bytes()[after_name].is_ascii_alphanumeric();
        if before_ok && after_ok {
            let mut value_start = after_name;
            while lower
                .as_bytes()
                .get(value_start)
                .is_some_and(u8::is_ascii_whitespace)
            {
                value_start += 1;
            }
            if lower.as_bytes().get(value_start) != Some(&b'=') {
                cursor = after_name;
                continue;
            }
            value_start += 1;
            while lower
                .as_bytes()
                .get(value_start)
                .is_some_and(u8::is_ascii_whitespace)
            {
                value_start += 1;
            }
            let quote = *tag.as_bytes().get(value_start)?;
            if quote != b'"' && quote != b'\'' {
                cursor = value_start;
                continue;
            }
            let end = tag[value_start + 1..].find(quote as char)? + value_start + 1;
            return Some(decode_entities(&tag[value_start + 1..end]));
        }
        cursor = after_name;
    }
    None
}

fn text(html: &str) -> String {
    let mut output = String::new();
    let mut in_tag = false;
    for character in html.chars() {
        match character {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(character),
            _ => {}
        }
    }
    decode_entities(&output)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

#[cfg(test)]
mod tests {
    use std::sync::{atomic::AtomicBool, Arc};
    use std::time::Duration;

    use reqwest::header::HeaderMap;
    use serde_json::json;

    use super::{normalize_playback_url, parse_category, parse_detail};

    const CATEGORY_HTML: &str = r#"
        <div class="jj-title-li"><img class="block100" src="//img.test/zero.jpg">
          <li class="list-br3"><a href="/jijiu/article/zero.html"><div class="line-clamp1">零</div></a></li>
        </div>
        <div class="jj-title-li"><img class="block100" src="//img.test/one.jpg">
          <li class="list-br3"><a href="/jijiu/article/one.html"><div class="line-clamp1">人工呼吸</div></a></li>
          <li class="list-br3"><a href="/jijiu/article/two.html"><div class="line-clamp1">心肺复苏</div></a></li>
        </div>
    "#;

    const DETAIL_HTML: &str = r#"
        <div class="video-title">人工呼吸</div>
        <div class="video-cover list-flex-in"><img src="//img.test/cover.jpg"></div>
        <span class="doc-name">急救医生</span>
        <div class="img-text-con"><p>先确认环境安全。</p></div>
        <video id="video" src="/original/demo.mp4"></video>
    "#;

    #[test]
    fn parses_a_real_first_aid_category_contract() {
        let result = parse_category(CATEGORY_HTML, 1).expect("category parses");
        assert_eq!(
            result["list"][0]["vod_id"],
            "https://m.youlai.cn/jijiu/article/one.html"
        );
        assert_eq!(result["list"][0]["vod_name"], "人工呼吸");
        assert_eq!(result["list"][0]["vod_pic"], "https://img.test/one.jpg");
        assert_eq!(result["total"], 2);
    }

    #[test]
    fn parses_first_aid_detail_and_direct_mp4_contract() {
        let result = parse_detail(DETAIL_HTML, "https://m.youlai.cn/jijiu/article/one.html")
            .expect("detail parses");
        assert_eq!(result["list"][0]["vod_name"], "人工呼吸");
        assert_eq!(result["list"][0]["vod_actor"], "急救医生");
        assert_eq!(
            result["list"][0]["vod_play_url"],
            "人工呼吸$https://m.youlai.cn/original/demo.mp4"
        );
    }

    #[test]
    fn playback_contract_rejects_an_unrelated_host() {
        assert!(normalize_playback_url("https://vod.youlai.cn/original/demo.mp4").is_ok());
        assert!(normalize_playback_url("https://example.test/demo.mp4").is_err());
    }

    #[tokio::test]
    #[ignore = "real FirstAid endpoint canary"]
    async fn real_endpoint_completes_category_detail_and_player_chain() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let category = super::call(
            "category",
            Some(&json!({"typeId": "jijiu|0", "page": 1})),
            &HeaderMap::new(),
            Duration::from_secs(15),
            cancelled.clone(),
        )
        .await
        .expect("FirstAid category");
        let id = category["list"][0]["vod_id"].as_str().expect("category id");
        let detail = super::call(
            "detail",
            Some(&json!({"ids": [id]})),
            &HeaderMap::new(),
            Duration::from_secs(15),
            cancelled.clone(),
        )
        .await
        .expect("FirstAid detail");
        let play_entry = detail["list"][0]["vod_play_url"]
            .as_str()
            .expect("play entry");
        let play_url = play_entry
            .split_once('$')
            .map(|(_, value)| value)
            .expect("play URL");
        let player = super::call(
            "player",
            Some(&json!({"id": play_url})),
            &HeaderMap::new(),
            Duration::from_secs(15),
            cancelled,
        )
        .await
        .expect("FirstAid player");
        assert_eq!(player["parse"], 0);
        assert!(player["url"]
            .as_str()
            .is_some_and(|value| value.ends_with(".mp4")));
    }
}
