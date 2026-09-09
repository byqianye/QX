//! Explicit live network measurement; never compiled into the application.
use crate::config_catalog::parse_config;
use crate::source_session::{SourceSessionPayload, SourceSessionState};
use serde_json::{json, Value};
use std::time::Instant;

#[tokio::test]
#[ignore = "live upstream benchmark; run explicitly with QX_SOURCE_BENCH_INPUT and QX_SOURCE_BENCH_OUTPUT"]
async fn measure_catalog_home() {
    let input = std::env::var("QX_SOURCE_BENCH_INPUT").expect("input path");
    let output = std::env::var("QX_SOURCE_BENCH_OUTPUT").expect("output path");
    let rounds = std::env::var("QX_SOURCE_BENCH_ROUNDS").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(1);
    let keys = std::env::var("QX_SOURCE_BENCH_KEYS").unwrap_or_default();
    let result_index = std::env::var("QX_SOURCE_BENCH_RESULT").ok().map(|v|v.parse::<usize>().expect("result index")).unwrap_or(0);
    let line_index = std::env::var("QX_SOURCE_BENCH_LINE").ok().map(|v|v.parse::<usize>().expect("line index")).unwrap_or(0);
    let episode_index = std::env::var("QX_SOURCE_BENCH_EPISODE").ok().map(|v|v.parse::<usize>().expect("episode index")).unwrap_or(0);
    let (_, _, sites) = parse_config(&std::fs::read_to_string(input).unwrap()).unwrap();
    let mut measurements = Vec::new();
    for round in 0..rounds {
        for site in &sites {
            if !keys.is_empty() && !keys.split(',').any(|key| key == site.key) { continue; }
            let state = SourceSessionState::default();
            let mut payload: SourceSessionPayload = serde_json::from_value(json!({
                "action":"open", "sessionId":uuid::Uuid::new_v4().to_string(),
                "sourceId":"benchmark", "siteKey":site.key, "api":site.api,
                "siteType":site.site_type, "ext":site.ext, "timeoutMs":6000
            })).unwrap();
            let started = Instant::now();
            let result = async {
                let opened = state.open(&payload)?;
                if site.api.eq_ignore_ascii_case("csp_Jianpian") {
                    payload.method = Some("init".into());
                    state.call(&payload).await?;
                }
                payload.method = Some("home".into());
                let home = state.call(&payload).await?;
                Ok::<_, crate::source_session::SourceSessionError>((opened, home.result.unwrap_or(Value::Null)))
            }.await;
            let elapsed = started.elapsed().as_millis();
            let entry = match result {
                Ok((opened, home)) => {
                    let mut posters = Vec::new();
                    if std::env::var("QX_SOURCE_BENCH_IMAGES").as_deref() == Ok("1") {
                        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(6)).build().unwrap();
                        for card in home["list"].as_array().into_iter().flatten().take(3) {
                            let start = Instant::now();
                            let image = async {
                                let response = client.get(card["vod_pic"].as_str().ok_or(())?).send().await.map_err(|_|())?.error_for_status().map_err(|_|())?;
                                let bytes = crate::source_session::read_bounded_response(response).await.map_err(|_|())?;
                                Ok::<_, ()>(bytes.starts_with(b"\xff\xd8\xff") || bytes.starts_with(b"\x89PNG") || bytes.starts_with(b"GIF8") || (bytes.starts_with(b"RIFF") && bytes.get(8..12)==Some(b"WEBP")))
                            }.await;
                            posters.push(json!({"ms":start.elapsed().as_millis(), "imageSignature":image.unwrap_or(false)}));
                        }
                    }
                    json!({"key":site.key,"round":round+1,"ms":elapsed,
                        "status":"ok","playbackCapability":opened.capabilities.playback,
                        "cards":home["list"].as_array().map_or(0, Vec::len), "posters":posters,
                        "firstTitle":home["list"][0]["vod_name"]})
                },
                Err(error) => {
                    let raw = format!("{error:?}");
                    // Keep error classes, never upstream addresses or credentials.
                    let reason = raw.split("http").next().unwrap_or("request failed").chars().take(180).collect::<String>();
                    json!({"key":site.key,"round":round+1,"ms":elapsed,"status":"failed","reason":reason})
                }
            };
            if std::env::var("QX_SOURCE_BENCH_CHAIN").as_deref() == Ok("1") && entry["status"] == "ok" {
                let mut previous = Value::Null;
                for method in ["search", "detail", "player"] {
                    payload.method = Some(method.into());
                    payload.params = Some(match method {
                        "search" => json!({"key":std::env::var("QX_SOURCE_BENCH_QUERY").unwrap_or_else(|_| "流浪地球".into()),"page":1}),
                        "detail" => json!({"ids":[previous["list"][result_index]["vod_id"]]}),
                        _ => {
                            let detail = previous["list"].as_array().and_then(|items|items.first()).unwrap_or(&previous);
                            json!({"id":detail["vod_play_url"].as_str().unwrap_or("").split("$$$").nth(line_index).unwrap_or("").split('#').nth(episode_index).unwrap_or("").split_once('$').map(|x| x.1).unwrap_or(""), "flag":detail["vod_play_from"].as_str().unwrap_or("").split("$$$").nth(line_index).unwrap_or("")})
                        }
                    });
                    let stage_start = Instant::now();
                    match state.call(&payload).await {
                        Ok(response) => {
                            previous = response.result.unwrap_or(Value::Null);
                            let detail = previous["list"].as_array().and_then(|items|items.first()).unwrap_or(&previous);
                            let stage = json!({"key":site.key,"stage":method,"ms":stage_start.elapsed().as_millis(),"cards":previous["list"].as_array().map_or(0, Vec::len), "vodId":detail["vod_id"], "title":detail["vod_name"], "parse":previous["parse"], "mediaHost":previous["url"].as_str().and_then(|u|reqwest::Url::parse(u).ok()).and_then(|u|u.host_str().map(str::to_string)),"hasEpisodes":detail["vod_play_url"].as_str().is_some_and(|s|!s.is_empty())});
                            println!("{stage}"); measurements.push(stage);
                            if method == "search" {
                                measurements.push(json!({"key":site.key,"stage":"search-candidates","selectedIndex":result_index,
                                    "items":previous["list"].as_array().into_iter().flatten().map(|item|json!({"vodId":item["vod_id"],"title":item["vod_name"],"year":item["vod_year"]})).collect::<Vec<_>>()}));
                            } else if method == "detail" {
                                measurements.push(json!({"key":site.key,"stage":"episode-candidates","lineIndex":line_index,"episodeIndex":episode_index,
                                    "lines":detail["vod_play_from"].as_str().unwrap_or("").split("$$$").collect::<Vec<_>>(),
                                    "episodeNames":detail["vod_play_url"].as_str().unwrap_or("").split("$$$").map(|line|line.split('#').map(|episode|episode.split('$').next().unwrap_or("")).collect::<Vec<_>>()).collect::<Vec<_>>()}));
                            }
                            if method == "player" && std::env::var("QX_SOURCE_BENCH_MEDIA").as_deref() == Ok("1") {
                                use crate::playback_proxy::{PlaybackProxyState, PlaybackProxyPayload};
                                let proxy = PlaybackProxyState::default();
                                let start = Instant::now();
                                let request: PlaybackProxyPayload = serde_json::from_value(json!({"action":"start","sessionId":"benchmark-media","url":previous["url"],"headers":previous["header"]})).unwrap();
                                let outcome = async {
                                    let opened = proxy.handle(&request).await.map_err(|e|format!("{e:?}"))?;
                                    let client = reqwest::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(12)).build().unwrap();
                                    let full_manifest = std::env::var("QX_SOURCE_BENCH_MANIFEST").as_deref() == Ok("1");
                                    let proxy_url = opened.proxy_url.unwrap();
                                    let mut request = client.get(&proxy_url);
                                    if !full_manifest { request = request.header("range", "bytes=0-8191"); }
                                    let mut response = request.send().await.map_err(|_| "PROXY_HTTP_FAILED".to_string())?;
                                    let status = response.status().as_u16();
                                    let expected_bytes = response.content_length();
                                    let mime = response.headers().get("content-type").and_then(|s|s.to_str().ok()).unwrap_or("").to_string();
                                    let mut prefix = Vec::new();
                                    let limit = if full_manifest { 4 * 1024 * 1024 } else { 8192 };
                                    while prefix.len() < limit {
                                        match response.chunk().await.map_err(|_|format!("PROXY_BODY_FAILED:read={}:expected={expected_bytes:?}",prefix.len()))? { Some(chunk) => prefix.extend_from_slice(&chunk[..chunk.len().min(limit-prefix.len())]), None=>break }
                                    }
                                    let mut segment = Value::Null;
                                    if full_manifest && prefix.starts_with(b"#EXTM3U") {
                                        let text = String::from_utf8_lossy(&prefix);
                                        if let Some(url) = text.lines().find(|line|!line.starts_with('#') && !line.trim().is_empty()) {
                                            let clock = Instant::now();
                                            segment = match client.get(url).send().await {
                                                Ok(mut response) => {
                                                    let status = response.status().as_u16();
                                                    let declared = response.content_length();
                                                    let mut bytes = 0usize;
                                                    let mut complete = false;
                                                    let mut first_byte_ms = None;
                                                    let mut failure = None;
                                                    loop {
                                                        match response.chunk().await {
                                                            Ok(Some(chunk)) => {
                                                                first_byte_ms.get_or_insert(clock.elapsed().as_millis());
                                                                bytes += chunk.len();
                                                                if bytes > 64 * 1024 * 1024 { failure = Some("BODY_TOO_LARGE"); break; }
                                                            }
                                                            Ok(None) => { complete = declared.is_none_or(|expected| expected == bytes as u64); break; }
                                                            Err(_) => { failure = Some("SEGMENT_BODY_FAILED"); break; }
                                                        }
                                                    }
                                                    json!({"status":status,"ms":clock.elapsed().as_millis(),"firstByteMs":first_byte_ms,"bytes":bytes,"complete":complete,"failure":failure,"decoded":false})
                                                },
                                                Err(_) => json!({"status":"failed","ms":clock.elapsed().as_millis()})
                                            };
                                        }
                                    }
                                    Ok::<_,String>(json!({"status":status,"mime":mime,"prefixBytes":prefix.len(),"hls":prefix.starts_with(b"#EXTM3U"),"manifestEnd":prefix.ends_with(b"#EXT-X-ENDLIST\n"),"firstSegment":segment,"mp4":prefix.windows(4).take(128).any(|w|w==b"ftyp"),"errorBody":if status>=400 {String::from_utf8_lossy(&prefix).chars().take(80).collect::<String>()}else{String::new()}}))
                                }.await;
                                let stage = json!({"key":site.key,"stage":"media-prefix","ms":start.elapsed().as_millis(),"outcome":outcome});
                                println!("{stage}"); measurements.push(stage);
                                let _ = proxy.handle(&PlaybackProxyPayload{action:"close".into(),session_id:"benchmark-media".into(),url:None,headers:None}).await;
                            }
                        },
                        Err(error) => {
                            let reason = format!("{error:?}").split("http").next().unwrap_or("request failed").chars().take(180).collect::<String>();
                            let stage = json!({"key":site.key,"stage":method,"status":"failed", "reason":reason});
                            println!("{stage}"); measurements.push(stage); break;
                        }
                    }
                }
            }
            let _ = state.close(&payload.session_id);
            println!("{entry}");
            measurements.push(entry);
            std::fs::write(&output, serde_json::to_string_pretty(&json!({"realHttp":true,"mockUsed":false,"measurements":measurements})).unwrap()).unwrap();
        }
    }
}
