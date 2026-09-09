use reqwest::Url;
use serde_json::{json, Value};

use super::source_session::SourceCapabilities;

const MAX_URL_BYTES: usize = 4096;

#[derive(Debug)]
pub enum PushSourceError {
    Unsupported(String),
    Request(String),
}

pub fn is_supported(api: &str) -> bool {
    api.trim().eq_ignore_ascii_case("csp_Push")
}

pub fn capabilities() -> SourceCapabilities {
    SourceCapabilities {
        home: false,
        category: false,
        search: false,
        detail: true,
        playback: true,
        local_proxy: false,
        filters: false,
        pagination: false,
        engine: "http-push".to_string(),
    }
}

/// The public Push spider is a URL hand-off source, not a catalog endpoint.
/// Keep only its deterministic HTTP(S) detail/direct-play branch here; sniff,
/// parser, file, YouTube and Thunder branches require another runtime.
pub async fn call(method: &str, params: Option<&Value>) -> Result<Value, PushSourceError> {
    match method.to_ascii_lowercase().as_str() {
        "detail" => detail(params),
        "player" | "playback" => player(params),
        other => Err(PushSourceError::Unsupported(format!(
            "PUSH_METHOD_UNAVAILABLE:{other}"
        ))),
    }
}

fn detail(params: Option<&Value>) -> Result<Value, PushSourceError> {
    let raw =
        raw_id(params).ok_or_else(|| PushSourceError::Request("PUSH_URL_REQUIRED".to_string()))?;
    let url = normalize_url(&raw)?;
    let title = title_for(&url);
    Ok(json!({
        "list": [{
            "vod_id": url,
            "vod_name": title,
            "vod_play_from": "直连",
            "vod_play_url": format!("{}${}", title_for(&url), url),
            "vod_pic": "",
            "vod_remarks": ""
        }]
    }))
}

fn player(params: Option<&Value>) -> Result<Value, PushSourceError> {
    let raw =
        raw_id(params).ok_or_else(|| PushSourceError::Request("PUSH_URL_REQUIRED".to_string()))?;
    let flag = params
        .and_then(|value| value.get("flag"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if !flag.is_empty()
        && !matches!(
            flag.to_ascii_lowercase().as_str(),
            "直连" | "direct" | "push"
        )
    {
        return Err(PushSourceError::Unsupported(
            "PUSH_DYNAMIC_PLAYER_UNSUPPORTED".to_string(),
        ));
    }
    let raw = raw
        .split('|')
        .next()
        .unwrap_or(raw.as_str())
        .replace("***", "#");
    let raw = raw
        .rsplit_once('$')
        .map(|(_, value)| value)
        .unwrap_or(raw.as_str())
        .trim();
    let url = normalize_url(raw)?;
    Ok(json!({"parse": 0, "jx": 0, "url": url, "header": {}}))
}

fn raw_id(params: Option<&Value>) -> Option<String> {
    params
        .and_then(|value| {
            value
                .get("id")
                .or_else(|| value.get("url"))
                .or_else(|| value.get("ids"))
        })
        .and_then(|value| {
            value
                .as_array()
                .and_then(|values| values.first())
                .or(Some(value))
        })
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn normalize_url(raw: &str) -> Result<String, PushSourceError> {
    if raw.len() > MAX_URL_BYTES {
        return Err(PushSourceError::Request("PUSH_URL_TOO_LARGE".to_string()));
    }
    let url =
        Url::parse(raw).map_err(|_| PushSourceError::Request("PUSH_URL_INVALID".to_string()))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(PushSourceError::Request("PUSH_URL_BLOCKED".to_string()));
    }
    Ok(url.to_string())
}

fn title_for(url: &str) -> String {
    let parsed = Url::parse(url).expect("normalized push URL");
    parsed
        .path_segments()
        .and_then(|segments| segments.filter(|segment| !segment.is_empty()).next_back())
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            segment
                .rsplit_once('.')
                .map(|(stem, _)| stem)
                .unwrap_or(segment)
        })
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| parsed.host_str().unwrap_or("Push"))
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{call, capabilities};
    use serde_json::json;

    #[tokio::test]
    async fn maps_an_http_url_to_detail_and_direct_player() {
        let detail = call(
            "detail",
            Some(&json!({"ids":["https://media.example.test/movie.m3u8"]})),
        )
        .await
        .expect("push detail");
        assert_eq!(detail["list"][0]["vod_play_from"], "直连");
        let episode = detail["list"][0]["vod_play_url"].as_str().expect("episode");
        let player = call("player", Some(&json!({"flag":"直连", "id":episode})))
            .await
            .expect("push player");
        assert_eq!(player["parse"], 0);
        assert_eq!(player["url"], "https://media.example.test/movie.m3u8");
    }

    #[tokio::test]
    async fn rejects_dynamic_and_credentialed_push_urls() {
        let dynamic = call(
            "player",
            Some(&json!({"flag":"嗅探", "id":"https://media.example.test/page"})),
        )
        .await
        .expect_err("sniff branch must stay closed");
        assert!(format!("{dynamic:?}").contains("PUSH_DYNAMIC_PLAYER_UNSUPPORTED"));

        let blocked = call(
            "detail",
            Some(&json!({"ids":["https://user:pass@media.example.test/movie.mp4"]})),
        )
        .await
        .expect_err("credentialed URL must stay closed");
        assert!(format!("{blocked:?}").contains("PUSH_URL_BLOCKED"));
    }

    #[test]
    fn exposes_only_detail_and_direct_playback() {
        let value = capabilities();
        assert!(!value.home);
        assert!(!value.search);
        assert!(value.detail);
        assert!(value.playback);
        assert_eq!(value.engine, "http-push");
    }
}
