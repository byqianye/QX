use std::collections::HashSet;

use serde_json::{Map, Value};

/// Normalizes source-provided subtitle metadata before it crosses the Tauri
/// renderer boundary. Parsing and rendering remain separate concerns.
pub fn normalize_result(value: &mut Value) {
    if value.is_object() {
        if let Some(items) = value.get_mut("list").and_then(Value::as_array_mut) {
            for item in items {
                normalize_record(item);
            }
        }
        normalize_record(value);
    }
}

fn normalize_record(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let source = object
        .get("subtitles")
        .or_else(|| object.get("subtitleTracks"))
        .or_else(|| object.get("subtitle"))
        .cloned();
    let Some(source) = source else {
        return;
    };
    let tracks = normalize_tracks(&source);
    if !tracks.is_empty() {
        object.insert("subtitles".to_string(), Value::Array(tracks));
    }
}

fn normalize_tracks(value: &Value) -> Vec<Value> {
    let candidates = value
        .as_array()
        .cloned()
        .or_else(|| value.get("tracks").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let mut ids = HashSet::new();
    let mut tracks = Vec::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let Some(object) = candidate.as_object() else {
            continue;
        };
        let url = object
            .get("url")
            .and_then(Value::as_str)
            .filter(|value| is_allowed_url(value))
            .map(str::to_string);
        let local_path = object
            .get("localPath")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let format = object
            .get("format")
            .and_then(Value::as_str)
            .and_then(normalize_format)
            .or_else(|| url.as_deref().and_then(format_from_name))
            .or_else(|| local_path.as_deref().and_then(format_from_name));
        if format.is_none() || (url.is_none() && local_path.is_none()) {
            continue;
        }
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("subtitle-{}", index + 1));
        if !ids.insert(id.clone()) {
            continue;
        }
        let label = text_or(object.get("label"), &id);
        let language = text_or(object.get("language"), "und");
        let mut track = Map::new();
        track.insert("id".to_string(), Value::String(id));
        track.insert("label".to_string(), Value::String(label));
        track.insert("language".to_string(), Value::String(language));
        track.insert(
            "format".to_string(),
            Value::String(format.expect("format checked above").to_string()),
        );
        if let Some(url) = url {
            track.insert("url".to_string(), Value::String(url));
        }
        if let Some(local_path) = local_path {
            track.insert("localPath".to_string(), Value::String(local_path));
        }
        if let Some(headers) = object.get("headers").and_then(Value::as_object) {
            let headers = headers
                .iter()
                .filter_map(|(key, value)| {
                    value
                        .as_str()
                        .map(|value| (key.clone(), Value::String(value.to_string())))
                })
                .collect::<Map<String, Value>>();
            if !headers.is_empty() {
                track.insert("headers".to_string(), Value::Object(headers));
            }
        }
        track.insert(
            "default".to_string(),
            Value::Bool(
                object
                    .get("default")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            ),
        );
        track.insert(
            "forced".to_string(),
            Value::Bool(
                object
                    .get("forced")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            ),
        );
        if let Some(source) = object
            .get("source")
            .and_then(Value::as_str)
            .filter(|source| {
                matches!(
                    *source,
                    "source" | "jellyfin" | "local" | "local-proxy" | "fixture"
                )
            })
        {
            track.insert("source".to_string(), Value::String(source.to_string()));
        }
        tracks.push(Value::Object(track));
        if tracks.len() >= 32 {
            break;
        }
    }
    tracks
}

fn text_or(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn normalize_format(value: &str) -> Option<&'static str> {
    let value = value.trim().to_ascii_lowercase();
    let value = value.strip_prefix("text/").unwrap_or(&value);
    match value {
        "webvtt" | "vtt" => Some("vtt"),
        "srt" => Some("srt"),
        "ass" => Some("ass"),
        "ssa" => Some("ssa"),
        _ => None,
    }
}

fn format_from_name(value: &str) -> Option<&'static str> {
    let value = value
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    match value.as_str() {
        "webvtt" | "vtt" => Some("vtt"),
        "srt" => Some("srt"),
        "ass" => Some("ass"),
        "ssa" => Some("ssa"),
        _ => None,
    }
}

fn is_allowed_url(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with("blob:")
        || value.starts_with("data:")
}

#[cfg(test)]
mod tests {
    use super::normalize_result;
    use serde_json::json;

    #[test]
    fn normalizes_nested_source_tracks_and_infers_format() {
        let mut value = json!({
            "list": [{
                "vod_id": "movie-1",
                "subtitleTracks": [
                    { "id": "zh", "label": "中文", "language": "zh-CN", "url": "https://media.test/a.vtt", "default": true },
                    { "id": "zh", "url": "https://media.test/duplicate.srt" },
                    { "id": "bad", "url": "file:///secret.srt" }
                ]
            }]
        });
        normalize_result(&mut value);
        let track = &value["list"][0]["subtitles"][0];
        assert_eq!(track["format"], "vtt");
        assert_eq!(track["default"], true);
        assert_eq!(value["list"][0]["subtitles"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn keeps_safe_headers_and_drops_invalid_tracks_without_claiming_local_urls() {
        let mut value = json!({
            "subtitles": {
                "tracks": [
                    { "url": "https://media.test/a.srt", "headers": { "X-Test": "ok", "Ignored": 1 }, "source": "source" },
                    { "url": "file:///secret.srt", "format": "srt" },
                    { "localPath": "C:\\selected\\a.ass", "format": "ass", "source": "local" }
                ]
            }
        });
        normalize_result(&mut value);
        assert_eq!(value["subtitles"][0]["format"], "srt");
        assert_eq!(value["subtitles"][0]["headers"]["X-Test"], "ok");
        assert_eq!(value["subtitles"][1]["format"], "ass");
        assert_eq!(value["subtitles"].as_array().unwrap().len(), 2);
    }
}
