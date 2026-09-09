use reqwest::Url;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy)]
enum Profile {
    YgpTrailer,
    Config,
    JpysCms,
    Gz360Cms,
    Sp360Cms,
    Push,
}

/// Small, compiled result semantics for sources whose upstream contract is
/// supplied by an explicit adapter or by the bounded HTTP fallback. This
/// module never creates a request and never invents a playback URL.
pub(super) fn apply(api: &str, method: &str, mut value: Value) -> Value {
    let Some(profile) = profile(api) else {
        return value;
    };
    if (method.eq_ignore_ascii_case("player") || method.eq_ignore_ascii_case("playback"))
        && matches!(profile, Profile::YgpTrailer | Profile::Config)
    {
        return value;
    }

    match profile {
        Profile::YgpTrailer => apply_list(&mut value, normalize_ygp_item, true),
        Profile::Config => apply_list(&mut value, normalize_config_item, true),
        Profile::JpysCms | Profile::Gz360Cms | Profile::Sp360Cms => {
            apply_list(&mut value, normalize_cms_item, false)
        }
        Profile::Push => apply_list(&mut value, normalize_push_item, true),
    }
    value
}

/// Normalize the result that has already crossed the isolated AppGet/AppQi
/// protocol adapter. This is deliberately a result-only step: it does not
/// decrypt, request, resolve, or invent a playback URL.
pub(super) fn apply_appget(method: &str, mut value: Value) -> Value {
    if method.eq_ignore_ascii_case("player") || method.eq_ignore_ascii_case("playback") {
        normalize_appget_player(&mut value);
        return value;
    }
    apply_list(&mut value, normalize_appget_item, false);
    value
}

pub(super) fn supports_direct_playback(api: &str) -> bool {
    matches!(
        profile(api),
        Some(
            Profile::YgpTrailer
                | Profile::JpysCms
                | Profile::Gz360Cms
                | Profile::Sp360Cms
                | Profile::Push
        )
    )
}

/// Build the smallest player result for a URL that was already returned by a
/// source. The caller uses this only when the adapter has no player operation.
pub(super) fn direct_player(api: &str, params: Option<&Value>) -> Option<Value> {
    if !supports_direct_playback(api) {
        return None;
    }
    let url = params
        .and_then(|value| value.get("id").or_else(|| value.get("url")))
        .and_then(Value::as_str)
        .and_then(valid_http_url)?;
    let mut result = Map::new();
    result.insert("parse".to_string(), Value::from(0));
    result.insert("url".to_string(), Value::String(url));
    result.insert("header".to_string(), Value::Object(Map::new()));
    Some(Value::Object(result))
}

fn profile(api: &str) -> Option<Profile> {
    let api = api.trim();
    if api.eq_ignore_ascii_case("csp_YGP") {
        Some(Profile::YgpTrailer)
    } else if api.eq_ignore_ascii_case("csp_Config") {
        Some(Profile::Config)
    } else if api.eq_ignore_ascii_case("csp_Jpys") {
        Some(Profile::JpysCms)
    } else if api.eq_ignore_ascii_case("csp_Gz360") {
        Some(Profile::Gz360Cms)
    } else if api.eq_ignore_ascii_case("csp_SP360") {
        Some(Profile::Sp360Cms)
    } else if api.eq_ignore_ascii_case("csp_Push") {
        Some(Profile::Push)
    } else {
        None
    }
}

fn apply_list(value: &mut Value, transform: fn(&mut Value) -> bool, filter_matches: bool) {
    if let Some(items) = find_list_mut(value) {
        let original = std::mem::take(items);
        let mut transformed = Vec::with_capacity(original.len());
        let mut has_match = false;
        for mut item in original {
            let matched = transform(&mut item);
            has_match |= matched;
            transformed.push((item, matched));
        }
        *items = if filter_matches && has_match {
            transformed
                .into_iter()
                .filter_map(|(item, matched)| matched.then_some(item))
                .collect()
        } else {
            transformed.into_iter().map(|(item, _)| item).collect()
        };
        return;
    }

    // Detail responses are sometimes a single object rather than {list: []}.
    // Apply only field normalization in that case; a single object cannot be
    // filtered without turning a valid response into an invented empty one.
    if !matches!(value, Value::Array(_)) {
        let _ = transform(value);
    }
}

fn find_list_mut(value: &mut Value) -> Option<&mut Vec<Value>> {
    match value {
        Value::Array(items) => Some(items),
        Value::Object(object) => {
            if object.get("list").is_some_and(Value::is_array) {
                return object.get_mut("list").and_then(Value::as_array_mut);
            }
            if object.get("items").is_some_and(Value::is_array) {
                return object.get_mut("items").and_then(Value::as_array_mut);
            }
            let nested_key = if object.contains_key("data") {
                Some("data")
            } else if object.contains_key("result") {
                Some("result")
            } else {
                None
            };
            nested_key.and_then(|key| object.get_mut(key).and_then(find_list_mut))
        }
        _ => None,
    }
}

fn normalize_ygp_item(value: &mut Value) -> bool {
    let Some(item) = value.as_object_mut() else {
        return false;
    };
    normalize_media_fields(item);
    normalize_explicit_playback(item, "YGP");
    let is_trailer = contains_any(
        &item_text(item),
        &[
            "预告片",
            "预告",
            "片花",
            "先导",
            "花絮",
            "trailer",
            "teaser",
            "pv",
        ],
    );
    if is_trailer && !has_value(item, "vod_type") {
        item.insert("vod_type".to_string(), Value::String("预告".to_string()));
    }
    is_trailer
}

fn normalize_appget_item(value: &mut Value) -> bool {
    let Some(item) = value.as_object_mut() else {
        return false;
    };
    normalize_media_fields(item);
    true
}

fn normalize_appget_player(value: &mut Value) {
    let Some(item) = value.as_object_mut() else {
        return;
    };
    let direct = item.get("parse").and_then(Value::as_i64) == Some(0)
        && item
            .get("url")
            .and_then(Value::as_str)
            .and_then(valid_http_url)
            .is_some();
    if direct && !item.contains_key("header") {
        item.insert("header".to_string(), Value::Object(Map::new()));
    }
}

fn normalize_config_item(value: &mut Value) -> bool {
    let Some(item) = value.as_object_mut() else {
        return false;
    };
    let has_endpoint = has_any_value(item, &["api", "url", "baseUrl", "base_url", "ext"]);
    let has_identity = has_any_value(item, &["key", "siteKey", "site_key", "id", "name", "title"]);
    let is_config = has_endpoint || (has_identity && has_any_value(item, &["type", "sourceType"]));
    if is_config {
        copy_alias(item, "vod_id", &["key", "siteKey", "site_key", "api", "id"]);
        copy_alias(item, "vod_name", &["name", "title", "label", "api"]);
    }
    is_config
}

fn normalize_cms_item(value: &mut Value) -> bool {
    let Some(item) = value.as_object_mut() else {
        return false;
    };
    let has_media_shape =
        has_any_value(item, &["vod_id", "id", "key", "vod_name", "name", "title"]);
    normalize_media_fields(item);
    normalize_explicit_playback(item, "HTTP");
    has_media_shape
}

fn normalize_push_item(value: &mut Value) -> bool {
    if let Value::String(raw) = value {
        let Some(url) = valid_http_url(raw) else {
            return false;
        };
        let mut item = Map::new();
        item.insert("vod_id".to_string(), Value::String(url.clone()));
        item.insert("vod_name".to_string(), Value::String("Push".to_string()));
        item.insert(
            "vod_play_from".to_string(),
            Value::String("Push".to_string()),
        );
        item.insert("vod_play_url".to_string(), Value::String(url));
        *value = Value::Object(item);
        return true;
    }

    let Some(item) = value.as_object_mut() else {
        return false;
    };
    let Some(url) = explicit_url_from_keys(
        item,
        &[
            "vod_play_url",
            "play_url",
            "playUrl",
            "stream",
            "m3u8",
            "mp4",
            "url",
            "link",
            "content",
        ],
    ) else {
        return false;
    };
    normalize_media_fields(item);
    if !has_value(item, "vod_id") {
        item.insert("vod_id".to_string(), Value::String(url.clone()));
    }
    if !has_value(item, "vod_name") {
        item.insert("vod_name".to_string(), Value::String("Push".to_string()));
    }
    if !has_value(item, "vod_play_from") {
        item.insert(
            "vod_play_from".to_string(),
            Value::String("Push".to_string()),
        );
    }
    if explicit_url_from_keys(item, &["vod_play_url"]).is_none() {
        item.insert("vod_play_url".to_string(), Value::String(url));
    }
    true
}

fn normalize_explicit_playback(item: &mut Map<String, Value>, line_name: &str) {
    let Some(url) = explicit_url_from_keys(
        item,
        &[
            "vod_play_url",
            "play_url",
            "playUrl",
            "stream",
            "m3u8",
            "mp4",
        ],
    ) else {
        return;
    };
    if !has_value(item, "vod_play_from") {
        item.insert(
            "vod_play_from".to_string(),
            Value::String(line_name.to_string()),
        );
    }
    if explicit_url_from_keys(item, &["vod_play_url"]).is_none() {
        let label =
            first_text(item, &["vod_name", "name", "title"]).unwrap_or_else(|| "播放".to_string());
        item.insert(
            "vod_play_url".to_string(),
            Value::String(format!("{label}${url}")),
        );
    }
}

fn normalize_media_fields(item: &mut Map<String, Value>) {
    copy_alias(item, "vod_id", &["id", "key", "code"]);
    copy_alias(item, "vod_name", &["name", "title", "label"]);
    copy_alias(item, "vod_pic", &["pic", "cover", "image", "poster"]);
    copy_alias(
        item,
        "vod_type",
        &["type_name", "typeName", "category", "categoryName"],
    );
    copy_alias(
        item,
        "vod_remarks",
        &["remarks", "remark", "desc", "description"],
    );
}

fn copy_alias(item: &mut Map<String, Value>, target: &str, aliases: &[&str]) {
    if has_value(item, target) {
        return;
    }
    for alias in aliases {
        if let Some(value) = item.get(*alias).filter(|value| meaningful(value)) {
            item.insert(target.to_string(), value.clone());
            return;
        }
    }
}

fn has_any_value(item: &Map<String, Value>, keys: &[&str]) -> bool {
    keys.iter()
        .any(|key| item.get(*key).is_some_and(meaningful))
}

fn has_value(item: &Map<String, Value>, key: &str) -> bool {
    item.get(key).is_some_and(meaningful)
}

fn meaningful(value: &Value) -> bool {
    match value {
        Value::String(value) => !value.trim().is_empty(),
        Value::Null => false,
        _ => true,
    }
}

fn first_text(item: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        item.get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn item_text(item: &Map<String, Value>) -> String {
    [
        "vod_name",
        "name",
        "title",
        "vod_type",
        "type",
        "type_name",
        "category",
        "categoryName",
        "tag",
        "tags",
        "vod_remarks",
        "remarks",
        "remark",
        "desc",
        "description",
    ]
    .iter()
    .filter_map(|key| item.get(*key).and_then(Value::as_str))
    .collect::<Vec<_>>()
    .join(" ")
    .to_ascii_lowercase()
}

fn contains_any(value: &str, keywords: &[&str]) -> bool {
    keywords.iter().any(|keyword| value.contains(keyword))
}

fn explicit_url_from_keys(item: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| item.get(*key).and_then(explicit_url))
}

fn explicit_url(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => {
            if let Some(url) = valid_http_url(value) {
                return Some(url);
            }
            value
                .split(|character: char| matches!(character, '$' | '#' | '|' | '\n' | '\r'))
                .find_map(valid_http_url)
        }
        Value::Array(values) => values.iter().find_map(explicit_url),
        _ => None,
    }
}

fn valid_http_url(value: &str) -> Option<String> {
    let value = value
        .trim()
        .trim_matches(|character: char| "\"'[]{}(),<>".contains(character));
    if value.len() > 4096 {
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
    Some(value.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{apply, apply_appget, direct_player, supports_direct_playback};

    #[test]
    fn appget_semantics_only_normalize_results_and_preserve_parser_episodes() {
        let detail = apply_appget(
            "detail",
            json!({
                "list": [{
                    "id": "movie-1",
                    "title": "公开源影片",
                    "vod_play_from": "解析线",
                    "vod_play_url": "第一集$parse_api=p&url=opaque-token&token=t"
                }]
            }),
        );
        assert_eq!(detail["list"][0]["vod_id"], "movie-1");
        assert_eq!(detail["list"][0]["vod_name"], "公开源影片");
        assert_eq!(
            detail["list"][0]["vod_play_url"],
            "第一集$parse_api=p&url=opaque-token&token=t"
        );

        let player = apply_appget(
            "player",
            json!({"parse": 0, "url": "https://media.example/movie.m3u8"}),
        );
        assert_eq!(player["parse"], 0);
        assert_eq!(player["url"], "https://media.example/movie.m3u8");
        assert_eq!(player["header"], json!({}));
    }

    #[test]
    fn appget_semantics_does_not_turn_invalid_player_values_into_success() {
        let value = json!({"parse": 1, "url": "/relative/player"});
        assert_eq!(apply_appget("player", value.clone()), value);
    }

    #[test]
    fn ygp_keeps_only_detected_trailers_when_markers_exist() {
        let value = apply(
            "csp_YGP",
            "search",
            json!({
                "list": [
                    {"id": "normal", "title": "正片"},
                    {"id": "trailer", "title": "新片预告"},
                    {"id": "pv", "title": "PV Trailer"}
                ]
            }),
        );
        assert_eq!(value["list"].as_array().expect("list").len(), 2);
        assert_eq!(value["list"][0]["vod_id"], "trailer");
        assert_eq!(value["list"][0]["vod_type"], "预告");
    }

    #[test]
    fn ygp_does_not_empty_a_source_when_the_upstream_uses_no_marker() {
        let value = apply(
            "csp_ygp",
            "home",
            json!({"list": [{"id": "1", "title": "新片"}]}),
        );
        assert_eq!(value["list"].as_array().expect("list").len(), 1);
    }

    #[test]
    fn config_keeps_source_shaped_entries_only() {
        let value = apply(
            "csp_Config",
            "home",
            json!({"list": [
                {"key": "bili", "name": "B站", "api": "csp_Bili"},
                {"name": "not a source", "description": "content"}
            ]}),
        );
        assert_eq!(value["list"].as_array().expect("list").len(), 1);
        assert_eq!(value["list"][0]["vod_name"], "B站");
    }

    #[test]
    fn push_rejects_local_paths_and_keeps_http_urls() {
        let value = apply(
            "csp_Push",
            "home",
            json!({"list": [
                {"name": "local", "url": "C:\\video.mp4"},
                {"name": "remote", "url": "https://media.test/movie.mp4"}
            ]}),
        );
        assert_eq!(value["list"].as_array().expect("list").len(), 1);
        assert_eq!(
            value["list"][0]["vod_play_url"],
            "https://media.test/movie.mp4"
        );
    }

    #[test]
    fn direct_player_accepts_only_an_explicit_http_url() {
        let result = direct_player(
            "csp_Gz360",
            Some(&json!({"id": "https://media.test/movie.m3u8"})),
        )
        .expect("direct URL player result");
        assert_eq!(result["parse"], 0);
        assert_eq!(result["url"], "https://media.test/movie.m3u8");
        assert!(direct_player("csp_Gz360", Some(&json!({"id": "/play/1"}))).is_none());
        assert!(direct_player(
            "csp_Unknown",
            Some(&json!({"id": "https://media.test/a.mp4"}))
        )
        .is_none());
        assert!(direct_player(
            "csp_Config",
            Some(&json!({"id": "https://media.test/config-action"}))
        )
        .is_none());
        assert!(!supports_direct_playback("csp_Config"));
    }

    #[test]
    fn cms_profiles_expose_only_explicit_playback_fields() {
        for api in ["csp_Jpys", "csp_Gz360", "csp_SP360"] {
            let value = apply(
                api,
                "detail",
                json!({"list": [{
                    "id": "movie-1",
                    "title": "电影",
                    "playUrl": "https://media.test/movie.mp4"
                }]}),
            );
            assert_eq!(value["list"][0]["vod_id"], "movie-1");
            assert_eq!(
                value["list"][0]["vod_play_url"],
                "电影$https://media.test/movie.mp4"
            );
        }
    }

    #[test]
    fn unknown_source_is_unchanged() {
        let value = json!({"list": [{"id": "1", "title": "内容"}]});
        assert_eq!(apply("csp_Unknown", "search", value.clone()), value);
        assert!(!supports_direct_playback("csp_GuaziTY"));
    }
}
