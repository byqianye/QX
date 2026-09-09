use std::collections::HashSet;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, OnceLock,
};
use std::time::Duration;

use aes::Aes128;
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine as _,
};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use md5::{Digest, Md5};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{json, Value};
use uuid::Uuid;

use super::source_session::{read_bounded_response, SourceCapabilities};

type Aes128CbcDecryptor = cbc::Decryptor<Aes128>;
type Aes128CbcEncryptor = cbc::Encryptor<Aes128>;

const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) QX-Yingshi/1.0";
const JPYS_BASE: &str = "https://www.hkybqufgh.com";
const JPYS_SECRET: &str = "cb808529bae6b6be45ecfab29a4889bc";
const JPYS_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36";
const KANQIU_BASE: &str = "http://www.88kanqiu.la";
const KANQIU_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36";
const CZSAPP_SEARCH_ENDPOINT: &str = "http://czzy.xn--m7r412advb92j21st65a.tk/czzysearch.php";
const CZSAPP_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";
const GUAZI_BASE: &str = "https://api.46d5umpk.com";
const GUAZI_KEY: &[u8; 16] = b"KANGEQIU@8868!~.";
const GUAZI_IV: &[u8; 16] = b"0200010900030207";
const GUAZI_UA: &str = "okhttp/3.12.0";
const GUAZI_PLAYER_UA: &str = "Lavf/57.83.100";
const GUAZI_PLAYER_REFERER: &str = "http://WJiZxLXA2.com/";
const GZ360_BASE: &str = "https://haiwaiapi.1fc8ab0.com";
const GZ360_KEY: &[u8; 16] = b"181cc88340ae5b2b";
const GZ360_IV: &[u8; 16] = b"4423d1e2773476ce";
const GZ360_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";
const GZ360_REFERER: &str = "https://gz360.tv/";
const SP360_BASE: &str = "https://api.web.360kan.com";
const SP360_SEARCH_BASE: &str = "https://api.so.360kan.com";
const SP360_UA: &str =
    "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/39.0.2171.71 Safari/537.36";
const SP360_REFERER: &str = "https://www.360kan.com/";
const YGP_BASE: &str = "https://www.6huo.com/";
const YGP_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36";
const TUXIAOBEI_BASE: &str = "https://www.tuxiaobei.com/";
const TUXIAOBEI_UA: &str =
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const SAOHUO_DISCOVERY_URL: &str = "http://shapp.us/";
const DM84_DISCOVERY_URL: &str = "http://dm84.pro/";

// SaoHuo's Android source resolves the current site from this small publish
// page before using the configured host. Cache only the validated host list so
// each source session does not repeat the discovery request.
static SAOHUO_DISCOVERY_CACHE: OnceLock<Vec<String>> = OnceLock::new();
static DM84_DISCOVERY_CACHE: OnceLock<Vec<String>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegacyHttpKind {
    Dm84,
    Kanqiu,
    Kugou,
    PanSearch,
    AppRJ,
    Jpys,
    Wwys,
    SaoHuo,
    Czsapp,
    Duopan,
    GuaziTy,
    Gz360,
    Sp360,
    Ygp,
    TuXiaoBei,
}

#[derive(Debug)]
pub enum LegacyHttpError {
    Unsupported(String),
    Request(String),
}

pub fn kind(api: &str) -> Option<LegacyHttpKind> {
    match api.trim().to_ascii_lowercase().as_str() {
        "csp_dm84" => Some(LegacyHttpKind::Dm84),
        "csp_kanqiu" => Some(LegacyHttpKind::Kanqiu),
        "csp_kugou" => Some(LegacyHttpKind::Kugou),
        "csp_pansearch" => Some(LegacyHttpKind::PanSearch),
        "csp_apprj" => Some(LegacyHttpKind::AppRJ),
        "csp_jpys" => Some(LegacyHttpKind::Jpys),
        "csp_wwys" => Some(LegacyHttpKind::Wwys),
        "csp_saohuo" => Some(LegacyHttpKind::SaoHuo),
        "csp_czsapp" => Some(LegacyHttpKind::Czsapp),
        "csp_duopan" | "csp_netfixtv" => Some(LegacyHttpKind::Duopan),
        "csp_guazity" => Some(LegacyHttpKind::GuaziTy),
        "csp_gz360" => Some(LegacyHttpKind::Gz360),
        "csp_sp360" => Some(LegacyHttpKind::Sp360),
        "csp_ygp" => Some(LegacyHttpKind::Ygp),
        _ => None,
    }
}

pub fn is_tuxiaobei(api: &str, ext: &str) -> bool {
    let api = api.trim().to_ascii_lowercase();
    let ext = ext.trim().to_ascii_lowercase();
    let drpy2 = ["/drpy2.min.js", "/drpy2.js"].iter().any(|suffix| {
        api.ends_with(suffix)
            || api.contains(&format!("{suffix}?"))
            || api.contains(&format!("{suffix}#"))
    });
    let source = [
        "/tuxiaobei.js",
        "/兔小贝.js",
        "/%e5%85%94%e5%b0%8f%e8%b4%9d.js",
    ]
    .iter()
    .any(|suffix| {
        ext.ends_with(suffix)
            || ext.contains(&format!("{suffix}?"))
            || ext.contains(&format!("{suffix}#"))
    });
    drpy2 && source
}

pub fn kind_for(api: &str, ext: &str) -> Option<LegacyHttpKind> {
    kind(api).or_else(|| is_tuxiaobei(api, ext).then_some(LegacyHttpKind::TuXiaoBei))
}

pub fn capabilities(kind: LegacyHttpKind) -> SourceCapabilities {
    match kind {
        LegacyHttpKind::Dm84 => SourceCapabilities {
            home: true,
            category: true,
            search: true,
            detail: true,
            playback: true,
            local_proxy: false,
            filters: true,
            pagination: true,
            engine: "http-html".to_string(),
        },
        LegacyHttpKind::Kanqiu => SourceCapabilities {
            home: true,
            category: true,
            search: false,
            detail: true,
            playback: true,
            local_proxy: false,
            filters: false,
            pagination: false,
            engine: "http-html-json".to_string(),
        },
        LegacyHttpKind::Kugou => SourceCapabilities {
            home: true,
            category: true,
            search: false,
            detail: true,
            playback: false,
            local_proxy: false,
            filters: false,
            pagination: false,
            engine: "http-html".to_string(),
        },
        LegacyHttpKind::PanSearch => SourceCapabilities {
            home: false,
            category: false,
            search: true,
            detail: false,
            playback: false,
            local_proxy: false,
            filters: false,
            pagination: false,
            engine: "http-json-html".to_string(),
        },
        LegacyHttpKind::AppRJ => SourceCapabilities {
            home: true,
            category: true,
            search: true,
            detail: true,
            playback: true,
            local_proxy: false,
            filters: true,
            pagination: true,
            engine: "http-json-multipart".to_string(),
        },
        LegacyHttpKind::Jpys => SourceCapabilities {
            home: true,
            category: true,
            search: true,
            detail: true,
            playback: true,
            local_proxy: false,
            filters: true,
            pagination: true,
            engine: "http-json-signed".to_string(),
        },
        LegacyHttpKind::Wwys | LegacyHttpKind::SaoHuo | LegacyHttpKind::Czsapp => {
            SourceCapabilities {
                home: true,
                category: true,
                search: true,
                detail: true,
                // These HTML contracts only play when the page itself exposes
                // a credential-free media URL; the extractor never executes
                // remote JavaScript or guesses a parser endpoint.
                playback: true,
                local_proxy: false,
                filters: true,
                pagination: true,
                engine: "http-html".to_string(),
            }
        }
        LegacyHttpKind::Duopan => SourceCapabilities {
            home: true,
            category: true,
            search: true,
            detail: true,
            playback: false,
            local_proxy: false,
            filters: true,
            pagination: true,
            engine: "http-html".to_string(),
        },
        LegacyHttpKind::GuaziTy => SourceCapabilities {
            home: true,
            category: true,
            search: false,
            detail: true,
            playback: true,
            local_proxy: false,
            filters: false,
            pagination: false,
            engine: "http-json-aes".to_string(),
        },
        LegacyHttpKind::Gz360 => SourceCapabilities {
            home: true,
            category: true,
            search: true,
            detail: true,
            playback: true,
            local_proxy: false,
            filters: true,
            pagination: true,
            engine: "http-json-aes".to_string(),
        },
        LegacyHttpKind::Sp360 => SourceCapabilities {
            home: true,
            category: true,
            search: true,
            detail: true,
            playback: true,
            local_proxy: false,
            filters: true,
            pagination: true,
            engine: "http-json-jsonp".to_string(),
        },
        LegacyHttpKind::Ygp => SourceCapabilities {
            home: true,
            category: true,
            search: true,
            detail: true,
            playback: true,
            local_proxy: false,
            filters: true,
            pagination: true,
            engine: "http-html".to_string(),
        },
        LegacyHttpKind::TuXiaoBei => SourceCapabilities {
            home: true,
            category: true,
            search: true,
            detail: true,
            playback: true,
            local_proxy: false,
            filters: false,
            pagination: true,
            engine: "http-json-jsonp-html".to_string(),
        },
    }
}

pub async fn call(
    kind: LegacyHttpKind,
    method: &str,
    params: Option<&Value>,
    ext: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let method = method.to_ascii_lowercase();
    match kind {
        LegacyHttpKind::Dm84 => call_dm84(&method, params, ext, headers, timeout, cancelled).await,
        LegacyHttpKind::Kanqiu => {
            call_kanqiu(&method, params, ext, headers, timeout, cancelled).await
        }
        LegacyHttpKind::Kugou => call_kugou(&method, params, headers, timeout, cancelled).await,
        LegacyHttpKind::PanSearch => {
            call_pansearch(&method, params, headers, timeout, cancelled).await
        }
        LegacyHttpKind::AppRJ => {
            call_apprj(&method, params, ext, headers, timeout, cancelled).await
        }
        LegacyHttpKind::Jpys => call_jpys(&method, params, ext, headers, timeout, cancelled).await,
        LegacyHttpKind::Wwys => call_wwys(&method, params, ext, headers, timeout, cancelled).await,
        LegacyHttpKind::SaoHuo => {
            call_saohuo(&method, params, ext, headers, timeout, cancelled).await
        }
        LegacyHttpKind::Czsapp => {
            call_czsapp(&method, params, ext, headers, timeout, cancelled).await
        }
        LegacyHttpKind::Duopan => {
            call_duopan(&method, params, ext, headers, timeout, cancelled).await
        }
        LegacyHttpKind::GuaziTy => {
            call_guazi_ty(&method, params, headers, timeout, cancelled).await
        }
        LegacyHttpKind::Gz360 => call_gz360(&method, params, headers, timeout, cancelled).await,
        LegacyHttpKind::Sp360 => call_sp360(&method, params, headers, timeout, cancelled).await,
        LegacyHttpKind::Ygp => call_ygp(&method, params, headers, timeout, cancelled).await,
        LegacyHttpKind::TuXiaoBei => {
            call_tuxiaobei(&method, params, headers, timeout, cancelled).await
        }
    }
}

async fn call_dm84(
    method: &str,
    params: Option<&Value>,
    ext: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let configured_base = super::auto_http::endpoint_from_ext("csp_Dm84", ext);
    if !matches!(
        method,
        "home" | "category" | "search" | "detail" | "player" | "playback"
    ) {
        return Err(LegacyHttpError::Unsupported(format!(
            "DM84_METHOD_UNAVAILABLE:{method}"
        )));
    }
    if method == "search"
        && param_string(params, "key")
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err(LegacyHttpError::Request(
            "DM84_SEARCH_KEY_REQUIRED".to_string(),
        ));
    }
    if method == "detail" {
        first_id(params)?;
    }
    let base = fixed_base(configured_base.as_deref().unwrap_or("https://dm84.tv"))?;
    let candidates = dm84_bases(&base, timeout, cancelled.clone()).await?;
    let mut last_error = None;
    for candidate in candidates {
        match call_dm84_on_base(
            method,
            params,
            &candidate,
            headers,
            timeout,
            cancelled.clone(),
        )
        .await
        {
            Ok(value) => return Ok(value),
            Err(error @ LegacyHttpError::Unsupported(_)) => return Err(error),
            Err(error) => {
                if matches!(&error, LegacyHttpError::Request(message) if message.contains("CANCELLED"))
                {
                    return Err(error);
                }
                last_error = Some(error);
            }
        }
    }
    Err(last_error
        .unwrap_or_else(|| LegacyHttpError::Request("DM84_NO_CONTENT_ENDPOINT".to_string())))
}

async fn call_dm84_on_base(
    method: &str,
    params: Option<&Value>,
    base: &reqwest::Url,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    match method {
        "home" => {
            let html = get_text(base.clone(), headers, timeout, cancelled).await?;
            Ok(dm84_home(&html))
        }
        "category" => {
            let type_id = param_string(params, "typeId").unwrap_or_else(|| "1".to_string());
            let page = param_string(params, "page").unwrap_or_else(|| "1".to_string());
            let filter = params.and_then(|value| value.get("filter"));
            let by = filter_string(filter, "by").unwrap_or_else(|| "time".to_string());
            let category = url_encode(&filter_string(filter, "type").unwrap_or_default());
            let year = filter_string(filter, "year").unwrap_or_default();
            let path = format!("/show-{type_id}--{by}-{category}--{year}-{page}.html");
            let html = get_text(join_url(&base, &path)?, headers, timeout, cancelled).await?;
            Ok(
                json!({"list": dm84_items(&html, &base), "page": page.parse::<u64>().unwrap_or(1), "pagecount": 1}),
            )
        }
        "search" => {
            let key = param_string(params, "key").unwrap_or_default();
            let mut url = join_url(&base, "/s----------.html")?;
            url.query_pairs_mut().append_pair("wd", &key);
            let html = get_text(url, headers, timeout, cancelled).await?;
            Ok(json!({"list": dm84_items(&html, &base)}))
        }
        "detail" => {
            let id = first_id(params)?;
            let url = dm84_detail_url(&base, &id)?;
            let html = get_text(url.clone(), headers, timeout, cancelled).await?;
            dm84_detail(&html, &url).map_err(LegacyHttpError::Request)
        }
        "player" | "playback" => {
            let id = param_string(params, "id").unwrap_or_default();
            let url = resolve_http_url(&base, &id)?;
            let html = get_text(url.clone(), headers, timeout, cancelled).await?;
            let iframe = opening_tags(&html, "iframe")
                .find_map(|tag| attribute(tag, "src"))
                .ok_or_else(|| {
                    LegacyHttpError::Request("DM84_PLAYER_IFRAME_MISSING".to_string())
                })?;
            let play_url = resolve_http_url(&url, &iframe)?;
            Ok(
                json!({"parse": 1, "url": play_url.to_string(), "header": {"User-Agent": DEFAULT_UA}}),
            )
        }
        _ => unreachable!("DM84 method was validated before endpoint dispatch"),
    }
}

async fn dm84_bases(
    configured: &reqwest::Url,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<reqwest::Url>, LegacyHttpError> {
    let mut candidates = Vec::new();
    if dm84_discovery_enabled(configured) {
        for value in dm84_discovered_bases(timeout, cancelled.clone()).await? {
            if let Ok(url) = fixed_base(&value) {
                candidates.push(url);
            }
        }
    }
    candidates.push(configured.clone());
    let mut unique = HashSet::new();
    candidates.retain(|url| unique.insert(url.as_str().to_string()));
    Ok(candidates)
}

fn dm84_discovery_enabled(configured: &reqwest::Url) -> bool {
    configured
        .host_str()
        .is_none_or(|host| matches!(host.to_ascii_lowercase().as_str(), "dm84.net" | "dm84.tv"))
}

async fn dm84_discovered_bases(
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<String>, LegacyHttpError> {
    if let Some(cached) = DM84_DISCOVERY_CACHE.get() {
        return Ok(cached.clone());
    }
    let discovered = match get_text(
        reqwest::Url::parse(DM84_DISCOVERY_URL).expect("static Dm84 discovery URL"),
        &HeaderMap::new(),
        timeout,
        cancelled.clone(),
    )
    .await
    {
        Ok(html) => dm84_discovered_bases_from_html(&html),
        Err(LegacyHttpError::Request(message)) if message.contains("CANCELLED") => {
            return Err(LegacyHttpError::Request(message))
        }
        Err(_) => Vec::new(),
    };
    let _ = DM84_DISCOVERY_CACHE.set(discovered.clone());
    Ok(discovered)
}

fn dm84_discovered_bases_from_html(html: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for tag in opening_tags(html, "a") {
        let Some(href) = attribute(tag, "href") else {
            continue;
        };
        let Ok(mut url) = reqwest::Url::parse(href.trim()) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || !dm84_content_host_allowed(url.host_str().unwrap_or_default())
        {
            continue;
        }
        url.set_path("/");
        url.set_query(None);
        url.set_fragment(None);
        let value = url.to_string();
        if seen.insert(value.clone()) {
            result.push(value);
        }
    }
    result
}

fn dm84_content_host_allowed(host: &str) -> bool {
    matches!(
        host.to_ascii_lowercase().as_str(),
        "dm84.vip" | "dmbus.cc" | "dm84.top"
    )
}

async fn call_kanqiu(
    method: &str,
    params: Option<&Value>,
    ext: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let base = if ext.trim().is_empty() {
        fixed_base(KANQIU_BASE)?
    } else {
        configurable_base(KANQIU_BASE, ext)?
    };
    let mut request_headers = headers.clone();
    insert_default_header(&mut request_headers, "user-agent", KANQIU_UA)?;
    match method {
        "home" => Ok(kanqiu_home()),
        "category" => {
            let filter = params.and_then(|value| value.get("filter"));
            let type_id = filter_string(filter, "cateId")
                .or_else(|| param_text(params, "typeId"))
                .unwrap_or_default();
            let path = if type_id.trim().is_empty() {
                "/".to_string()
            } else {
                format!("/match/{}/live", url_encode(type_id.trim()))
            };
            let url = join_url(&base, &path)?;
            let html = get_text(url, &request_headers, timeout, cancelled).await?;
            let list = kanqiu_category_items(&html, &base);
            Ok(json!({"list": list, "page": 1, "pagecount": 1, "total": list.len()}))
        }
        "detail" => {
            let id = first_id(params)?;
            let url = resolve_http_url(&base, &id)?;
            let body = get_text(url.clone(), &request_headers, timeout, cancelled).await?;
            kanqiu_detail(&body, &url).map_err(LegacyHttpError::Request)
        }
        "player" | "playback" => {
            let raw = param_text(params, "id")
                .or_else(|| param_text(params, "url"))
                .unwrap_or_default();
            let url = kanqiu_player_url(&raw, &base).map_err(LegacyHttpError::Request)?;
            Ok(json!({
                "parse": 0,
                "jx": 0,
                "url": url,
                "header": {"User-Agent": KANQIU_UA}
            }))
        }
        "search" => Err(LegacyHttpError::Unsupported(
            "KANQIU_SEARCH_UNAVAILABLE".to_string(),
        )),
        other => Err(LegacyHttpError::Unsupported(format!(
            "KANQIU_METHOD_UNAVAILABLE:{other}"
        ))),
    }
}

fn kanqiu_home() -> Value {
    json!({
        "class": [
            {"type_id": "", "type_name": "全部直播"},
            {"type_id": "4", "type_name": "篮球直播"},
            {"type_id": "23", "type_name": "足球直播"},
            {"type_id": "21", "type_name": "其他直播"}
        ],
        "list": []
    })
}

fn kanqiu_category_items(html: &str, base: &reqwest::Url) -> Vec<Value> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let mut fragments = elements(html, "li", Some("list-group-item"));
    fragments.extend(elements(html, "div", Some("list-group-item")));
    for fragment in fragments {
        let Some(button) = opening_tags(fragment, "a")
            .find(|tag| has_class(tag, "btn") && has_class(tag, "btn-primary"))
        else {
            continue;
        };
        let Some(href) = attribute(button, "href") else {
            continue;
        };
        let detail_path = href.replacen("play", "source", 1);
        let Ok(detail) = resolve_http_url(base, &detail_path) else {
            continue;
        };
        let id = detail.to_string();
        if !seen.insert(id.clone()) {
            continue;
        }
        let name = attribute(button, "title")
            .or_else(|| attribute(button, "data-name"))
            .unwrap_or_else(|| text(fragment));
        let name = if name.trim().is_empty() {
            "看球直播".to_string()
        } else {
            name.trim().to_string()
        };
        let pic = opening_tags(fragment, "img")
            .next()
            .and_then(|tag| attribute(tag, "src"))
            .and_then(|value| resolve_http_url(base, &value).ok())
            .map(|value| value.to_string())
            .unwrap_or_default();
        let remarks = text(fragment);
        result.push(json!({
            "vod_id": id,
            "vod_name": name,
            "vod_pic": pic,
            "vod_remarks": remarks
        }));
    }
    result
}

fn kanqiu_detail(body: &str, url: &reqwest::Url) -> Result<Value, String> {
    let envelope: Value = serde_json::from_str(body)
        .map_err(|error| format!("KANQIU_DETAIL_JSON_INVALID:{error}"))?;
    let data = envelope
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| "KANQIU_DETAIL_DATA_MISSING".to_string())?;
    if data.len() < 8 {
        return Err("KANQIU_DETAIL_DATA_INVALID".to_string());
    }
    let encoded = &data[6..data.len() - 2];
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("KANQIU_DETAIL_BASE64_INVALID:{error}"))?;
    let payload: Value = serde_json::from_slice(&decoded)
        .map_err(|error| format!("KANQIU_DETAIL_PAYLOAD_INVALID:{error}"))?;
    let links = payload
        .get("links")
        .and_then(Value::as_array)
        .ok_or_else(|| "KANQIU_DETAIL_LINKS_MISSING".to_string())?;
    let mut episodes = Vec::new();
    for link in links {
        let name = link
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("直播")
            .trim();
        let raw_url = link
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if raw_url.is_empty() {
            continue;
        }
        let media = reqwest::Url::parse(raw_url)
            .map_err(|error| format!("KANQIU_PLAY_URL_INVALID:{error}"))?;
        if !matches!(media.scheme(), "http" | "https")
            || media.host_str().is_none()
            || !media.username().is_empty()
            || media.password().is_some()
        {
            continue;
        }
        let safe_url = media.to_string().replace('#', "***");
        episodes.push(format!(
            "{}${safe_url}",
            if name.is_empty() { "直播" } else { name }
        ));
    }
    episodes.sort();
    episodes.dedup();
    let title = links
        .iter()
        .find_map(|link| link.get("name").and_then(Value::as_str))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("看球直播");
    Ok(json!({"list": [{
        "vod_id": url.to_string(),
        "vod_name": title,
        "vod_remarks": "Kanqiu",
        "vod_play_from": if episodes.is_empty() { "" } else { "看球" },
        "vod_play_url": episodes.join("#")
    }]}))
}

fn kanqiu_player_url(raw: &str, base: &reqwest::Url) -> Result<String, String> {
    let value = raw
        .rsplit_once('$')
        .map(|(_, value)| value)
        .unwrap_or(raw)
        .trim()
        .replace("***", "#");
    let url = resolve_http_url(base, &value).map_err(|error| format!("{error:?}"))?;
    Ok(url.to_string())
}

async fn call_kugou(
    method: &str,
    params: Option<&Value>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let base = fixed_base("https://www.kugou.com")?;
    match method {
        "home" => Ok(json!({
            "class": [
                {"type_id": "6666|0", "type_name": "热门榜单"},
                {"type_id": "33162|1", "type_name": "特色音乐榜"},
                {"type_id": "4681|2", "type_name": "全球榜"}
            ], "list": []
        })),
        "category" => {
            let type_id = param_string(params, "typeId").unwrap_or_else(|| "6666|0".to_string());
            let mut parts = type_id.split('|');
            let category = parts.next().unwrap_or("6666");
            let sidebar = parts.next().unwrap_or("0").parse::<usize>().unwrap_or(0);
            let url = join_url(&base, &format!("/yy/rank/home/1-{category}.html?from=rank"))?;
            let html = get_text(url, headers, timeout, cancelled).await?;
            Ok(
                json!({"total": kugou_category_items(&html, sidebar).len(), "pagecount": 1, "list": kugou_category_items(&html, sidebar)}),
            )
        }
        "detail" => {
            let id = first_id(params)?;
            let url = resolve_http_url(&base, &id)?;
            let html = get_text(url.clone(), headers, timeout, cancelled).await?;
            kugou_detail(&html, &url).map_err(LegacyHttpError::Request)
        }
        "player" | "playback" => Err(LegacyHttpError::Unsupported(
            "KUGOU_PLAYBACK_CONTRACT_UNVERIFIED".to_string(),
        )),
        "search" => Err(LegacyHttpError::Unsupported(
            "KUGOU_SEARCH_UNAVAILABLE".to_string(),
        )),
        other => Err(LegacyHttpError::Unsupported(format!(
            "KUGOU_METHOD_UNAVAILABLE:{other}"
        ))),
    }
}

const APP_RJ_SECRET: &str = "7gp0bnd2sr85ydii2j32pcypscoc4w6c7g5spl";
const APP_RJ_UA: &str = "okhttp-okgo/jeasonlzy";

async fn call_apprj(
    method: &str,
    params: Option<&Value>,
    ext: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let base = configurable_base("http://v.rbotv.cn", ext)?;
    match method {
        "home" => {
            let value = post_apprj(
                &base,
                "/v3/type/top_type",
                apprj_form(Vec::new()),
                headers,
                timeout,
                cancelled,
            )
            .await?;
            Ok(apprj_home(&value))
        }
        "category" => {
            let mut fields = vec![
                ("type_id", param_text(params, "typeId").unwrap_or_default()),
                ("limit", "12".to_string()),
                (
                    "page",
                    param_text(params, "page").unwrap_or_else(|| "1".to_string()),
                ),
            ];
            append_apprj_filter(&mut fields, params);
            let value = post_apprj(
                &base,
                "/v3/home/type_search",
                apprj_form(fields),
                headers,
                timeout,
                cancelled,
            )
            .await?;
            Ok(apprj_list(&value))
        }
        "search" => {
            let key = param_text(params, "key").unwrap_or_default();
            if key.trim().is_empty() {
                return Err(LegacyHttpError::Request(
                    "APPRJ_SEARCH_KEY_REQUIRED".to_string(),
                ));
            }
            let fields = vec![
                ("keyword", key),
                ("limit", "12".to_string()),
                (
                    "page",
                    param_text(params, "page").unwrap_or_else(|| "1".to_string()),
                ),
            ];
            let value = post_apprj(
                &base,
                "/v3/home/search",
                apprj_form(fields),
                headers,
                timeout,
                cancelled,
            )
            .await?;
            Ok(apprj_list(&value))
        }
        "detail" => {
            let id = first_id(params)?;
            let value = post_apprj(
                &base,
                "/v3/home/vod_details",
                apprj_form(vec![("vod_id", id.clone())]),
                headers,
                timeout,
                cancelled,
            )
            .await?;
            apprj_detail(&value, &id).map_err(LegacyHttpError::Request)
        }
        "player" | "playback" => {
            let raw = param_text(params, "id")
                .or_else(|| param_text(params, "url"))
                .unwrap_or_default();
            let (value, user_agent, parse_chain) =
                apprj_episode_fields(&raw).unwrap_or_else(|| {
                    (
                        raw.split_once('$')
                            .map(|(_, url)| url)
                            .unwrap_or(raw.as_str())
                            .trim()
                            .to_string(),
                        String::new(),
                        String::new(),
                    )
                });
            if !parse_chain.is_empty() {
                let (url, parser_user_agent) = apprj_resolve_parse_chain(
                    &parse_chain,
                    &value,
                    &user_agent,
                    headers,
                    timeout,
                    cancelled,
                )
                .await?;
                let effective_user_agent =
                    parser_user_agent.or_else(|| apprj_safe_user_agent(&user_agent));
                let header = effective_user_agent
                    .map(|value| json!({"User-Agent": value}))
                    .unwrap_or_else(|| json!({}));
                return Ok(json!({"parse": 0, "jx": 0, "url": url, "header": header}));
            }
            if let Some(url) = apprj_media_url(&value) {
                let header = apprj_safe_user_agent(&user_agent)
                    .map(|value| json!({"User-Agent": value}))
                    .unwrap_or_else(|| json!({}));
                return Ok(json!({"parse": 0, "jx": 0, "url": url, "header": header}));
            }
            Err(LegacyHttpError::Unsupported(
                "APPRJ_DYNAMIC_PLAYER_UNSUPPORTED".to_string(),
            ))
        }
        other => Err(LegacyHttpError::Unsupported(format!(
            "APPRJ_METHOD_UNAVAILABLE:{other}"
        ))),
    }
}

fn apprj_form(mut fields: Vec<(&str, String)>) -> Vec<(&str, String)> {
    let timestamp = unix_seconds();
    let sign = md5_hex(&format!("{APP_RJ_SECRET}{timestamp}"));
    fields.push(("timestamp", timestamp));
    fields.push(("sign", sign));
    fields
}

fn append_apprj_filter(fields: &mut Vec<(&str, String)>, params: Option<&Value>) {
    let Some(filter) = params.and_then(|value| value.get("filter")) else {
        return;
    };
    for name in ["area", "class", "lang", "year"] {
        if let Some(value) = filter.get(name).and_then(Value::as_str) {
            fields.push((name, value.to_string()));
        }
    }
}

async fn post_apprj(
    base: &reqwest::Url,
    path: &str,
    fields: Vec<(&str, String)>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let url = join_url(base, path)?;
    let mut request_headers = headers.clone();
    insert_default_header(&mut request_headers, "user-agent", APP_RJ_UA)?;
    let client = reqwest::Client::builder()
        .default_headers(request_headers)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|error| LegacyHttpError::Request(error.to_string()))?;
    let boundary = "qx-apprj-boundary";
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(value.as_bytes());
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    let response = tokio::select! {
        result = client.post(url).header("content-type", format!("multipart/form-data; boundary={boundary}")).body(body).send() => result.map_err(|error| LegacyHttpError::Request(format!("APPRJ_HTTP_FAILED:{error}")))?,
        _ = wait_for_cancel(cancelled.clone()) => return Err(LegacyHttpError::Request("APPRJ_REQUEST_CANCELLED".to_string())),
    };
    let status = response.status();
    let bytes = tokio::select! {
        result = read_bounded_response(response) => result.map_err(|error| LegacyHttpError::Request(error.message("APPRJ_RESPONSE_TOO_LARGE")))?,
        _ = wait_for_cancel(cancelled) => return Err(LegacyHttpError::Request("APPRJ_REQUEST_CANCELLED".to_string())),
    };
    if !status.is_success() {
        return Err(LegacyHttpError::Request(format!(
            "APPRJ_HTTP_STATUS:{status}"
        )));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| LegacyHttpError::Request(format!("APPRJ_JSON_INVALID:{error}")))
}

fn apprj_home(value: &Value) -> Value {
    let classes = value
        .pointer("/data/list")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = apprj_text(item, &["type_id", "id", "tid"]);
                    let name = apprj_text(item, &["type_name", "name", "title"]);
                    (!id.is_empty() && !name.is_empty())
                        .then(|| json!({"type_id": id, "type_name": name}))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({"class": classes, "list": []})
}

fn apprj_list(value: &Value) -> Value {
    let list = value
        .pointer("/data/list")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(apprj_item).collect::<Vec<_>>())
        .unwrap_or_default();
    json!({"list": list, "total": list.len()})
}

fn apprj_item(item: &Value) -> Option<Value> {
    let id = apprj_text(item, &["vod_id", "id", "ids"]);
    let name = apprj_text(item, &["vod_name", "name", "title"]);
    if id.is_empty() && name.is_empty() {
        return None;
    }
    Some(json!({
        "vod_id": id,
        "vod_name": name,
        "vod_pic": apprj_text(item, &["vod_pic", "vod_pic_thumb", "pic", "cover"]),
        "vod_remarks": apprj_text(item, &["vod_remarks", "remarks", "remark", "year"]),
    }))
}

fn apprj_detail(value: &Value, id: &str) -> Result<Value, String> {
    let data = value
        .get("data")
        .ok_or_else(|| "APPRJ_DETAIL_DATA_MISSING".to_string())?;
    let mut result = serde_json::Map::new();
    result.insert("vod_id".to_string(), Value::String(id.to_string()));
    for (field, aliases) in [
        ("vod_name", &["vod_name", "name", "title"] as &[&str]),
        ("vod_pic", &["vod_pic", "vod_pic_thumb", "pic", "cover"]),
        (
            "vod_remarks",
            &["vod_remarks", "remarks", "remark", "vod_year"],
        ),
        ("vod_content", &["vod_content", "content", "intro"]),
        ("vod_actor", &["vod_actor", "actor", "actors"]),
        ("vod_director", &["vod_director", "director", "directors"]),
        ("vod_class", &["vod_class", "class", "type_name"]),
    ] {
        result.insert(field.to_string(), Value::String(apprj_text(data, aliases)));
    }
    let (from, urls) = apprj_playlists(data);
    if !from.is_empty() {
        result.insert("vod_play_from".to_string(), Value::String(from.join("$$$")));
        result.insert("vod_play_url".to_string(), Value::String(urls.join("$$$")));
    }
    Ok(Value::Object(result))
}

fn apprj_playlists(data: &Value) -> (Vec<String>, Vec<String>) {
    let Some(playlists) = data
        .get("vod_play_list")
        .or_else(|| data.get("play_list"))
        .and_then(Value::as_array)
    else {
        return (Vec::new(), Vec::new());
    };
    let mut from = Vec::new();
    let mut urls = Vec::new();
    let vod_name = apprj_text(data, &["vod_name", "name", "title"]);
    for (index, playlist) in playlists.iter().enumerate() {
        let line = apprj_text(playlist, &["name", "show", "parse", "player"]);
        let line = if line.is_empty() {
            format!("线路{}", index + 1)
        } else {
            line
        };
        let user_agent = apprj_text(playlist, &["ua", "user_agent", "user-agent"]);
        let parse_chain = playlist
            .get("parse_urls")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .map(value_text)
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join("@")
            })
            .unwrap_or_default();
        let episodes = playlist
            .get("urls")
            .or_else(|| playlist.get("url_list"))
            .or_else(|| playlist.get("episodes"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut line_urls = Vec::new();
        for episode in episodes {
            let name = apprj_text(&episode, &["name", "title", "episode"]);
            let target = apprj_text(
                &episode,
                &["url", "parse_api_url", "play_url", "playUrl", "link"],
            );
            if target.is_empty() {
                continue;
            }
            let nid = apprj_text(&episode, &["nid", "id"]);
            let encoded_name = if name.is_empty() { "正片" } else { &name };
            line_urls.push(format!(
                "{}${}|{}|{}|{}|{}",
                encoded_name,
                parse_chain,
                target,
                apprj_encode_metadata_field(&user_agent),
                apprj_encode_metadata_field(&vod_name),
                apprj_encode_metadata_field(&nid)
            ));
        }
        if !line_urls.is_empty() {
            from.push(line);
            urls.push(line_urls.join("#"));
        }
    }
    (from, urls)
}

fn apprj_encode_metadata_field(value: &str) -> String {
    value.replace('%', "%25").replace('|', "%7C")
}

fn apprj_decode_metadata_field(value: &str) -> String {
    value.replace("%7C", "|").replace("%25", "%")
}

fn apprj_episode_fields(raw: &str) -> Option<(String, String, String)> {
    let payload = raw.split_once('$').map_or(raw, |(_, payload)| payload);
    let mut tail = payload.rsplitn(4, '|');
    let _nid = tail.next()?;
    let _vod_name = tail.next()?;
    let user_agent = tail.next()?;
    let prefix = tail.next()?;
    let (parse_chain, target) = prefix.split_once('|')?;
    Some((
        target.trim().to_string(),
        apprj_decode_metadata_field(user_agent.trim()),
        parse_chain.trim().to_string(),
    ))
}

fn apprj_text(value: &Value, aliases: &[&str]) -> String {
    aliases
        .iter()
        .find_map(|key| value.get(*key))
        .map(value_text)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Array(values) => values
            .iter()
            .map(value_text)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(","),
        _ => String::new(),
    }
}

fn apprj_media_url(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let path = url.path().to_ascii_lowercase();
    [".m3u8", ".mp4", ".mkv", ".webm", ".mov"]
        .iter()
        .any(|suffix| path.ends_with(suffix))
        .then_some(url.to_string())
}

fn apprj_safe_user_agent(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= 256 && HeaderValue::from_str(value).is_ok())
        .then(|| value.to_string())
}

fn apprj_parser_request_url(parser: &str, target: &str) -> Option<reqwest::Url> {
    let mut url = reqwest::Url::parse(parser.trim()).ok()?;
    if url.scheme() != "https"
        || url.host_str()?.eq_ignore_ascii_case("api.nbyjson.top") == false
        || url.port() != Some(7788)
        || url.path() != "/api/"
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let mut has_key = false;
    let mut has_url = false;
    let retained = url
        .query_pairs()
        .filter_map(|(name, value)| {
            if name == "key" && !value.trim().is_empty() {
                has_key = true;
            }
            if name == "url" {
                has_url = true;
                return None;
            }
            Some((name.into_owned(), value.into_owned()))
        })
        .collect::<Vec<_>>();
    if !has_key || !has_url || target.trim().is_empty() {
        return None;
    }
    {
        let mut query = url.query_pairs_mut();
        query.clear();
        for (name, value) in retained {
            query.append_pair(&name, &value);
        }
        query.append_pair("url", target.trim());
    }
    Some(url)
}

fn apprj_nby_media_url(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/nby/m3u8/getM3u8"
    {
        return None;
    }
    let media = url
        .query_pairs()
        .find(|(name, _)| name == "url")
        .map(|(_, value)| value.into_owned())?;
    media
        .to_ascii_lowercase()
        .ends_with(".m3u8")
        .then_some(url.to_string())
}

fn apprj_parser_response(value: &Value) -> Option<(String, Option<String>)> {
    let code = value.get("code").map(value_text).unwrap_or_default();
    if code != "200" {
        return None;
    }
    let raw_url = value.get("url").and_then(Value::as_str)?.trim();
    let url = apprj_media_url(raw_url).or_else(|| apprj_nby_media_url(raw_url))?;
    let user_agent = value
        .get("UA")
        .or_else(|| value.get("ua"))
        .map(value_text)
        .and_then(|value| apprj_safe_user_agent(&value));
    Some((url, user_agent))
}

async fn apprj_resolve_parse_chain(
    parse_chain: &str,
    target: &str,
    user_agent: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<(String, Option<String>), LegacyHttpError> {
    let mut last_error = None;
    let mut allowed_parser = false;
    for parser in parse_chain
        .split('@')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let Some(url) = apprj_parser_request_url(parser, target) else {
            continue;
        };
        allowed_parser = true;
        let mut request_headers = headers.clone();
        if let Some(value) =
            apprj_safe_user_agent(user_agent).and_then(|value| HeaderValue::from_str(&value).ok())
        {
            request_headers.insert(HeaderName::from_static("user-agent"), value);
        }
        let response =
            match apprj_get_json_no_redirect(url, &request_headers, timeout, cancelled.clone())
                .await
            {
                Ok(value) => value,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            };
        if let Some(result) = apprj_parser_response(&response) {
            return Ok(result);
        }
        last_error = Some(LegacyHttpError::Unsupported(
            "APPRJ_DYNAMIC_PLAYER_UNSUPPORTED".to_string(),
        ));
    }
    if allowed_parser {
        if let Some(error) = last_error {
            return Err(error);
        }
    }
    Err(LegacyHttpError::Unsupported(
        "APPRJ_DYNAMIC_PLAYER_UNSUPPORTED".to_string(),
    ))
}

async fn apprj_get_json_no_redirect(
    url: reqwest::Url,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let mut request_headers = headers.clone();
    insert_default_header(&mut request_headers, "user-agent", APP_RJ_UA)?;
    let client = reqwest::Client::builder()
        .default_headers(request_headers)
        .http1_only()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|error| LegacyHttpError::Request(error.to_string()))?;
    let response = tokio::select! {
        result = client.get(url).send() => result.map_err(|error| LegacyHttpError::Request(format!("APPRJ_PARSER_HTTP_FAILED:{error}")))?,
        _ = wait_for_cancel(cancelled.clone()) => return Err(LegacyHttpError::Request("APPRJ_REQUEST_CANCELLED".to_string())),
    };
    let status = response.status();
    let bytes = tokio::select! {
        result = read_bounded_response(response) => result.map_err(|error| LegacyHttpError::Request(error.message("APPRJ_PARSER_RESPONSE_TOO_LARGE")))?,
        _ = wait_for_cancel(cancelled) => return Err(LegacyHttpError::Request("APPRJ_REQUEST_CANCELLED".to_string())),
    };
    if !status.is_success() {
        return Err(LegacyHttpError::Request(format!(
            "APPRJ_PARSER_HTTP_STATUS:{status}"
        )));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| LegacyHttpError::Request(format!("APPRJ_PARSER_JSON_INVALID:{error}")))
}

async fn call_jpys(
    method: &str,
    params: Option<&Value>,
    ext: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let base = configurable_base(JPYS_BASE, ext)?;
    match method {
        "home" => Ok(json!({
            "class": [
                {"type_id": "1", "type_name": "电影"},
                {"type_id": "2", "type_name": "电视剧"},
                {"type_id": "4", "type_name": "动漫"},
                {"type_id": "3", "type_name": "综艺"}
            ],
            "list": []
        })),
        "category" => {
            let type_id = param_text(params, "typeId").unwrap_or_else(|| "1".to_string());
            let page = param_text(params, "page").unwrap_or_else(|| "1".to_string());
            let filter = params.and_then(|value| value.get("filter"));
            let area = jpys_filter(filter, "area");
            let year = jpys_filter(filter, "year");
            let mut url = join_url(&base, "/api/mw-movie/anonymous/video/list")?;
            {
                let mut query = url.query_pairs_mut();
                query.append_pair("type1", &type_id);
                query.append_pair("pageNum", &page);
                query.append_pair("area", &area);
                query.append_pair("year", &year);
            }
            let timestamp = jpys_timestamp();
            let canonical = format!(
                "area={area}&pageNum={page}&type1={type_id}&year={year}&key={JPYS_SECRET}&t={timestamp}"
            );
            let value =
                jpys_get_json(url, &canonical, headers, timeout, cancelled, timestamp).await?;
            jpys_list(
                value
                    .pointer("/data/list")
                    .ok_or_else(|| LegacyHttpError::Request("JPYS_LIST_MISSING".to_string()))?,
            )
        }
        "search" => {
            let key = param_text(params, "key").unwrap_or_default();
            if key.trim().is_empty() {
                return Err(LegacyHttpError::Request(
                    "JPYS_SEARCH_KEY_REQUIRED".to_string(),
                ));
            }
            let mut url = join_url(&base, "/api/mw-movie/anonymous/video/searchByWord")?;
            url.query_pairs_mut()
                .append_pair("keyword", key.trim())
                .append_pair("pageNum", "1")
                .append_pair("pageSize", "8");
            let timestamp = jpys_timestamp();
            let canonical = format!(
                "keyword={}&pageNum=1&pageSize=8&key={JPYS_SECRET}&t={timestamp}",
                key.trim()
            );
            let value =
                jpys_get_json(url, &canonical, headers, timeout, cancelled, timestamp).await?;
            jpys_list(
                value.pointer("/data/result/list").ok_or_else(|| {
                    LegacyHttpError::Request("JPYS_SEARCH_LIST_MISSING".to_string())
                })?,
            )
        }
        "detail" => {
            let id = first_id(params)?;
            let mut url = join_url(&base, "/api/mw-movie/anonymous/video/detail")?;
            url.query_pairs_mut().append_pair("id", &id);
            let timestamp = jpys_timestamp();
            let canonical = format!("id={id}&key={JPYS_SECRET}&t={timestamp}");
            let value =
                jpys_get_json(url, &canonical, headers, timeout, cancelled, timestamp).await?;
            jpys_detail(&value, &id)
        }
        "player" | "playback" => {
            let raw = param_text(params, "id")
                .or_else(|| param_text(params, "url"))
                .unwrap_or_default();
            let episode = raw
                .rsplit_once('$')
                .map(|(_, value)| value)
                .unwrap_or(raw.as_str());
            let mut parts = episode.split('@');
            let id = parts.next().unwrap_or_default().trim();
            let nid = parts.next().unwrap_or_default().trim();
            if id.is_empty() || nid.is_empty() || parts.next().is_none() {
                return Err(LegacyHttpError::Request("JPYS_EPISODE_INVALID".to_string()));
            }
            let mut url = join_url(&base, "/api/mw-movie/anonymous/v2/video/episode/url")?;
            url.query_pairs_mut()
                .append_pair("id", id)
                .append_pair("nid", nid);
            let timestamp = jpys_timestamp();
            let canonical = format!("id={id}&nid={nid}&key={JPYS_SECRET}&t={timestamp}");
            let value =
                jpys_get_json(url, &canonical, headers, timeout, cancelled, timestamp).await?;
            let media = value
                .pointer("/data/list/0/url")
                .and_then(Value::as_str)
                .and_then(|value| resolve_http_url(&base, value).ok())
                .ok_or_else(|| LegacyHttpError::Request("JPYS_PLAY_URL_MISSING".to_string()))?;
            Ok(json!({
                "parse": 0,
                "url": media,
                "header": {
                    "User-Agent": JPYS_UA,
                    "Origin": "https://www.ghw9zwp5.com",
                    "Referer": "https://www.ghw9zwp5.com/"
                }
            }))
        }
        other => Err(LegacyHttpError::Unsupported(format!(
            "JPYS_METHOD_UNAVAILABLE:{other}"
        ))),
    }
}

async fn call_sp360(
    method: &str,
    params: Option<&Value>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let base = fixed_base(SP360_BASE)?;
    let search_base = fixed_base(SP360_SEARCH_BASE)?;
    match method {
        "home" | "homevideo" | "home_video" => {
            let mut url = join_url(&base, "/v1/rank")?;
            url.query_pairs_mut()
                .append_pair("cat", "2")
                .append_pair("callback", "qx");
            let value = sp360_get_json(url, headers, timeout, cancelled).await?;
            let list = sp360_rank_items(&value);
            if method == "home" {
                Ok(json!({
                    "class": [
                        {"type_id": "1", "type_name": "电影"},
                        {"type_id": "2", "type_name": "电视剧"},
                        {"type_id": "3", "type_name": "综艺"},
                        {"type_id": "4", "type_name": "动漫"}
                    ],
                    "list": list
                }))
            } else {
                Ok(json!({"list": list, "page": 1, "pagecount": 1}))
            }
        }
        "category" => {
            let type_id = sp360_type_id(params)?;
            let page = sp360_page(params);
            let filter = params.and_then(|value| value.get("filter"));
            let rank = sp360_filter_value(filter, &["by", "rank"]);
            let rank = if rank.is_empty() {
                "ranklatest".to_string()
            } else {
                rank
            };
            let cat = sp360_filter_value(filter, &["class", "cat", "type"]);
            let year = sp360_filter_value(filter, &["year"]);
            let area = sp360_filter_value(filter, &["area"]);
            let actor = sp360_filter_value(filter, &["actor", "act"]);
            let mut url = join_url(&base, "/v1/filter/list")?;
            url.query_pairs_mut()
                .append_pair("catid", &type_id)
                .append_pair("rank", &rank)
                .append_pair("cat", &cat)
                .append_pair("year", &year)
                .append_pair("area", &area)
                .append_pair("act", &actor)
                .append_pair("size", "35")
                .append_pair("pageno", &page.to_string())
                .append_pair("callback", "qx");
            let value = sp360_get_json(url, headers, timeout, cancelled).await?;
            let list = sp360_category_items(&value, &type_id);
            Ok(json!({
                "list": list,
                "page": page,
                "pagecount": page,
                "total": list.len()
            }))
        }
        "search" => {
            let key = param_text(params, "key").unwrap_or_default();
            if key.trim().is_empty() {
                return Err(LegacyHttpError::Request(
                    "SP360_SEARCH_KEY_REQUIRED".to_string(),
                ));
            }
            let page = sp360_page(params);
            let mut url = join_url(&search_base, "/index")?;
            url.query_pairs_mut()
                .append_pair("force_v", "1")
                .append_pair("kw", key.trim())
                .append_pair("from", "")
                .append_pair("pageno", &page.to_string())
                .append_pair("v_ap", "1")
                .append_pair("tab", "all");
            let value = sp360_get_json(url, headers, timeout, cancelled).await?;
            let list = sp360_search_items(&value);
            Ok(json!({"list": list, "page": page, "total": list.len()}))
        }
        "detail" => {
            let raw_id = first_id(params)?;
            let (category, ent_id) = sp360_source_id(&raw_id)
                .map_err(|error| LegacyHttpError::Request(error.to_string()))?;
            let mut url = join_url(&base, "/v1/detail")?;
            url.query_pairs_mut()
                .append_pair("cat", &category)
                .append_pair("id", &ent_id)
                .append_pair("callback", "qx");
            let value = sp360_get_json(url, headers, timeout, cancelled).await?;
            sp360_detail(&value, &raw_id).map_err(LegacyHttpError::Request)
        }
        "player" | "playback" => sp360_player(params),
        other => Err(LegacyHttpError::Unsupported(format!(
            "SP360_METHOD_UNAVAILABLE:{other}"
        ))),
    }
}

async fn sp360_get_json(
    url: reqwest::Url,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let mut request_headers = headers.clone();
    insert_default_header(&mut request_headers, "user-agent", SP360_UA)?;
    insert_default_header(&mut request_headers, "referer", SP360_REFERER)?;
    let client = reqwest::Client::builder()
        .default_headers(request_headers)
        .redirect(reqwest::redirect::Policy::limited(2))
        .http1_only()
        .timeout(timeout)
        .build()
        .map_err(|error| LegacyHttpError::Request(format!("SP360_CLIENT_INIT_FAILED:{error}")))?;
    let response = tokio::select! {
        result = client.get(url).send() => result
            .map_err(|error| LegacyHttpError::Request(format!("SP360_HTTP_FAILED:{error}")))?,
        _ = wait_for_cancel(cancelled.clone()) => {
            return Err(LegacyHttpError::Request("SP360_REQUEST_CANCELLED".to_string()))
        }
    };
    let status = response.status();
    let bytes = tokio::select! {
        result = read_bounded_response(response) => result
            .map_err(|error| LegacyHttpError::Request(error.message("SP360_RESPONSE_TOO_LARGE")))?,
        _ = wait_for_cancel(cancelled) => {
            return Err(LegacyHttpError::Request("SP360_REQUEST_CANCELLED".to_string()))
        }
    };
    if !status.is_success() {
        return Err(LegacyHttpError::Request(format!(
            "SP360_HTTP_STATUS:{}",
            status.as_u16()
        )));
    }
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(LegacyHttpError::Request(
            "SP360_RESPONSE_TOO_LARGE".to_string(),
        ));
    }
    let body = String::from_utf8_lossy(&bytes);
    let value = sp360_parse_jsonp(&body)
        .map_err(|error| LegacyHttpError::Request(format!("SP360_JSON_INVALID:{error}")))?;
    if let Some(errno) = value.get("errno").map(value_text) {
        if !errno.is_empty() && errno != "0" {
            return Err(LegacyHttpError::Request(format!(
                "SP360_RESPONSE_ERROR:{errno}"
            )));
        }
    }
    if let Some(code) = value.get("code").map(value_text) {
        if !code.is_empty() && code != "0" {
            return Err(LegacyHttpError::Request(format!(
                "SP360_RESPONSE_CODE:{code}"
            )));
        }
    }
    if let Some(message) = value.get("msg").and_then(Value::as_str) {
        if !message.is_empty() && !matches!(message, "ok" | "OK" | "success" | "Success") {
            return Err(LegacyHttpError::Request(format!(
                "SP360_RESPONSE_MESSAGE:{message}"
            )));
        }
    }
    Ok(value)
}

fn sp360_parse_jsonp(body: &str) -> Result<Value, String> {
    let trimmed = body.trim().trim_start_matches('\u{feff}');
    let payload = if let Some(open) = trimmed.find('(') {
        let prefix = &trimmed[..open];
        if prefix.is_empty()
            || !matches!(prefix, "qx" | "cb")
            || !prefix
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            trimmed
        } else {
            let rest = &trimmed[open + 1..];
            let rest = rest.trim_end_matches(';').trim();
            rest.strip_suffix(')').unwrap_or(rest)
        }
    } else {
        trimmed
    };
    serde_json::from_str(payload.trim()).map_err(|error| format!("{error}"))
}

fn sp360_type_id(params: Option<&Value>) -> Result<String, LegacyHttpError> {
    let type_id = param_text(params, "typeId").unwrap_or_else(|| "1".to_string());
    if matches!(type_id.as_str(), "1" | "2" | "3" | "4") {
        Ok(type_id)
    } else {
        Err(LegacyHttpError::Request(
            "SP360_TYPE_ID_INVALID".to_string(),
        ))
    }
}

fn sp360_page(params: Option<&Value>) -> u64 {
    param_text(params, "page")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (1..=1000).contains(value))
        .unwrap_or(1)
}

fn sp360_filter_value(filter: Option<&Value>, names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| filter.and_then(|value| value.get(*name)).map(value_text))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value != "全部")
        .map(|value| value.chars().take(64).collect())
        .unwrap_or_default()
}

fn sp360_rank_items(value: &Value) -> Vec<Value> {
    value
        .pointer("/data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(35)
                .filter_map(|item| sp360_item(item, None))
                .collect()
        })
        .unwrap_or_default()
}

fn sp360_category_items(value: &Value, category: &str) -> Vec<Value> {
    value
        .pointer("/data/movies")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(35)
                .filter_map(|item| sp360_item(item, Some(category)))
                .collect()
        })
        .unwrap_or_default()
}

fn sp360_search_items(value: &Value) -> Vec<Value> {
    value
        .pointer("/data/longData/rows")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(35)
                .filter_map(|item| sp360_item(item, None))
                .collect()
        })
        .unwrap_or_default()
}

fn sp360_item(value: &Value, category: Option<&str>) -> Option<Value> {
    let object = value.as_object()?;
    let id = first_object_text(object, &["ent_id", "en_id", "id"]);
    if id.is_empty() || id.len() > 128 || id.chars().any(|character| character.is_whitespace()) {
        return None;
    }
    let object_category = first_object_text(object, &["cat", "cat_id"]);
    let category = if matches!(object_category.as_str(), "1" | "2" | "3" | "4") {
        object_category
    } else {
        category.unwrap_or("1").to_string()
    };
    let category = category.as_str();
    let title = first_object_text(object, &["titleTxt", "title", "name"])
        .replace("<b>", "")
        .replace("</b>", "")
        .replace("<em>", "")
        .replace("</em>", "");
    if title.trim().is_empty() {
        return None;
    }
    let cover = sp360_cover(first_object_text(object, &["cdncover", "cover", "vod_pic"]));
    let remarks = first_object_text(object, &["vod_remarks", "pubdate", "year", "upinfo"]);
    let type_name = value
        .get("moviecategory")
        .or_else(|| value.get("cat_name"))
        .map(value_text)
        .unwrap_or_default();
    Some(json!({
        "vod_id": format!("{category}|{id}"),
        "vod_name": title.trim(),
        "vod_pic": cover,
        "vod_remarks": remarks,
        "type_name": type_name,
        "vod_year": first_object_text(object, &["year", "pubdate"]),
        "vod_area": value.get("area").map(value_text).unwrap_or_default(),
        "vod_actor": value.get("actor").map(value_text).unwrap_or_default()
    }))
}

fn sp360_cover(value: String) -> String {
    if value.starts_with("//") {
        format!("https:{value}")
    } else if value.starts_with("http://") || value.starts_with("https://") {
        value
    } else {
        String::new()
    }
}

fn sp360_source_id(value: &str) -> Result<(String, String), String> {
    let (category, id) = value
        .split_once('|')
        .ok_or_else(|| "SP360_ID_INVALID".to_string())?;
    if !matches!(category, "1" | "2" | "3" | "4")
        || id.is_empty()
        || id.len() > 128
        || id
            .chars()
            .any(|character| character.is_whitespace() || character == '|')
    {
        return Err("SP360_ID_INVALID".to_string());
    }
    Ok((category.to_string(), id.to_string()))
}

fn sp360_detail(value: &Value, id: &str) -> Result<Value, String> {
    let data = value
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| "SP360_DETAIL_DATA_MISSING".to_string())?;
    let mut groups = Vec::new();
    let sites = data
        .get("playlink_sites")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let detail = data.get("playlinksdetail").and_then(Value::as_object);
    let episodes = data.get("allepidetail").and_then(Value::as_object);
    let links = data.get("playlinks").and_then(Value::as_object);
    let mut names = sites;
    for object in [detail, episodes, links].into_iter().flatten() {
        for name in object.keys() {
            if !names.iter().any(|value| value == name) {
                names.push(name.as_str());
            }
        }
    }
    for name in names.into_iter().take(32) {
        let mut lines = Vec::new();
        let mut seen = HashSet::new();
        if let Some(items) = episodes
            .and_then(|object| object.get(name))
            .and_then(Value::as_array)
        {
            for item in items.iter().take(200) {
                let Some(object) = item.as_object() else {
                    continue;
                };
                let Some(url) = sp360_page_url(first_object_text(
                    object,
                    &["url", "default_url", "pageurl", "programUrl"],
                )) else {
                    continue;
                };
                if !seen.insert(url.clone()) {
                    continue;
                }
                let label = sp360_episode_label(object);
                lines.push(format!("{label}${url}"));
            }
        }
        if lines.is_empty() {
            if let Some(object) = detail
                .and_then(|object| object.get(name))
                .and_then(Value::as_object)
            {
                if let Some(url) = sp360_page_url(first_object_text(
                    object,
                    &["default_url", "url", "pageurl", "programUrl"],
                )) {
                    seen.insert(url.clone());
                    lines.push(format!("正片${url}"));
                }
            }
        }
        if lines.is_empty() {
            if let Some(url) = links
                .and_then(|object| object.get(name))
                .map(value_text)
                .and_then(sp360_page_url)
            {
                if seen.insert(url.clone()) {
                    lines.push(format!("正片${url}"));
                }
            }
        }
        if !lines.is_empty() {
            groups.push((name.to_string(), lines.join("#")));
        }
    }
    let (from, urls): (Vec<_>, Vec<_>) = groups.into_iter().unzip();
    Ok(json!({
        "list": [{
            "vod_id": id,
            "vod_name": first_object_text(data, &["title", "name"]),
            "vod_pic": sp360_cover(first_object_text(data, &["cdncover", "cover"])),
            "vod_remarks": first_object_text(data, &["upinfo", "total", "pubdate"]),
            "vod_year": first_object_text(data, &["pubdate", "year"]),
            "vod_area": data.get("area").map(value_text).unwrap_or_default(),
            "vod_actor": data.get("actor").map(value_text).unwrap_or_default(),
            "vod_director": data.get("director").map(value_text).unwrap_or_default(),
            "vod_content": first_object_text(data, &["description", "content"]),
            "vod_play_from": from.join("$$$"),
            "vod_play_url": urls.join("$$$")
        }]
    }))
}

fn sp360_episode_label(object: &serde_json::Map<String, Value>) -> String {
    let value = first_object_text(
        object,
        &["playlink_num", "period_alias", "period", "name", "title"],
    );
    let value = if value.trim().is_empty() {
        "正片".to_string()
    } else {
        value
    };
    value.replace('#', "").replace('$', "")
}

fn sp360_page_url(value: String) -> Option<String> {
    let url = reqwest::Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.as_str().len() > 2048
    {
        return None;
    }
    Some(url.to_string())
}

fn sp360_player(params: Option<&Value>) -> Result<Value, LegacyHttpError> {
    let raw = param_text(params, "id")
        .or_else(|| param_text(params, "url"))
        .unwrap_or_default();
    let value = raw
        .rsplit_once('$')
        .map(|(_, value)| value)
        .unwrap_or(raw.as_str());
    let url = sp360_page_url(value.to_string())
        .ok_or_else(|| LegacyHttpError::Unsupported("SP360_PLAYER_PAGE_URL_INVALID".to_string()))?;
    Ok(json!({
        "parse": 1,
        "jx": 0,
        "url": url,
        "header": {
            "User-Agent": SP360_UA,
            "Referer": SP360_REFERER
        }
    }))
}

async fn jpys_get_json(
    url: reqwest::Url,
    canonical: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
    timestamp: String,
) -> Result<Value, LegacyHttpError> {
    let mut request_headers = headers.clone();
    insert_default_header(&mut request_headers, "user-agent", JPYS_UA)?;
    request_headers.insert(
        HeaderName::from_static("sign"),
        HeaderValue::from_str(&jpys_signature(canonical))
            .map_err(|_| LegacyHttpError::Request("JPYS_SIGN_INVALID".to_string()))?,
    );
    request_headers.insert(
        HeaderName::from_static("t"),
        HeaderValue::from_str(&timestamp)
            .map_err(|_| LegacyHttpError::Request("JPYS_TIMESTAMP_INVALID".to_string()))?,
    );
    request_headers.insert(
        HeaderName::from_static("deviceid"),
        HeaderValue::from_str(&Uuid::new_v4().to_string())
            .map_err(|_| LegacyHttpError::Request("JPYS_DEVICE_ID_INVALID".to_string()))?,
    );
    let client = reqwest::Client::builder()
        .default_headers(request_headers)
        .redirect(reqwest::redirect::Policy::none())
        .http1_only()
        .timeout(timeout)
        .build()
        .map_err(|error| LegacyHttpError::Request(format!("JPYS_CLIENT_INIT_FAILED:{error}")))?;
    let response = tokio::select! {
        result = client.get(url).send() => result.map_err(|error| LegacyHttpError::Request(format!("JPYS_HTTP_FAILED:{error}")))?,
        _ = wait_for_cancel(cancelled.clone()) => return Err(LegacyHttpError::Request("JPYS_REQUEST_CANCELLED".to_string())),
    };
    let status = response.status();
    let bytes = tokio::select! {
        result = read_bounded_response(response) => result.map_err(|error| LegacyHttpError::Request(error.message("JPYS_RESPONSE_TOO_LARGE")))?,
        _ = wait_for_cancel(cancelled) => return Err(LegacyHttpError::Request("JPYS_REQUEST_CANCELLED".to_string())),
    };
    if !status.is_success() {
        return Err(LegacyHttpError::Request(format!(
            "JPYS_HTTP_STATUS:{}",
            status.as_u16()
        )));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| LegacyHttpError::Request(format!("JPYS_JSON_INVALID:{error}")))
}

fn jpys_signature(canonical: &str) -> String {
    let md5 = md5_hex(canonical);
    let digest = sha1::Sha1::digest(md5.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn jpys_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn jpys_filter(filter: Option<&Value>, name: &str) -> String {
    filter
        .and_then(|value| value.get(name))
        .map(value_text)
        .filter(|value| !value.trim().is_empty() && value != "全部")
        .unwrap_or_default()
}

fn jpys_list(value: &Value) -> Result<Value, LegacyHttpError> {
    let items = value
        .as_array()
        .ok_or_else(|| LegacyHttpError::Request("JPYS_LIST_INVALID".to_string()))?;
    let list = items.iter().filter_map(jpys_item).collect::<Vec<_>>();
    Ok(json!({"list": list, "total": list.len()}))
}

fn jpys_item(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let id = first_object_text(object, &["vodId", "vod_id", "id"]);
    let name = first_object_text(object, &["vodName", "vod_name", "name", "title"]);
    if id.is_empty() && name.is_empty() {
        return None;
    }
    Some(json!({
        "vod_id": id,
        "vod_name": name,
        "vod_pic": first_object_text(object, &["vodPic", "vod_pic", "pic", "cover"]),
        "vod_remarks": first_object_text(object, &["vodRemarks", "vod_remarks", "remarks", "remm"]),
    }))
}

fn jpys_detail(value: &Value, id: &str) -> Result<Value, LegacyHttpError> {
    let object = value
        .pointer("/data")
        .and_then(Value::as_object)
        .ok_or_else(|| LegacyHttpError::Request("JPYS_DETAIL_DATA_MISSING".to_string()))?;
    let name = first_object_text(object, &["vodName", "vod_name", "name"]);
    let mut episodes = Vec::new();
    if let Some(items) = object.get("episodeList").and_then(Value::as_array) {
        for item in items {
            let Some(item) = item.as_object() else {
                continue;
            };
            let label = first_object_text(item, &["sorr", "name", "title"]);
            let nid = first_object_text(item, &["nid", "id"]);
            if label.is_empty() || nid.is_empty() || id.contains('@') || nid.contains('@') {
                continue;
            }
            episodes.push(format!(
                "{label}${id}@{nid}@{}@{label}",
                if name.is_empty() { "Jpys" } else { &name }
            ));
        }
    }
    let vod = json!({
        "vod_id": id,
        "vod_name": name,
        "vod_pic": first_object_text(object, &["vodPic", "vod_pic", "pic"]),
        "vod_remarks": first_object_text(object, &["vodRemarks", "vod_remarks", "remm"]),
        "vod_area": first_object_text(object, &["vodArea", "vod_area", "area"]),
        "vod_year": first_object_text(object, &["vodYear", "vod_year", "year"]),
        "vod_actor": first_object_text(object, &["vodActor", "vod_actor", "ar"]),
        "vod_director": first_object_text(object, &["vodDirector", "vod_director", "acc"]),
        "vod_content": first_object_text(object, &["vodContent", "vod_content", "vodBlurb", "content"]),
        "vod_play_from": if episodes.is_empty() { "" } else { "在线播放" },
        "vod_play_url": episodes.join("#"),
    });
    Ok(json!({"list": [vod]}))
}

fn first_object_text(object: &serde_json::Map<String, Value>, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| object.get(*key).map(value_text))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_default()
}

fn md5_hex(value: &str) -> String {
    let digest = Md5::digest(value.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unix_seconds() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

async fn call_gz360(
    method: &str,
    params: Option<&Value>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let base = fixed_base(GZ360_BASE)?;
    match method {
        "home" => {
            let value = gz360_post(
                &base,
                "/Pc/Index/indexPid",
                &json!({"type": 1, "phone_type": 3}),
                headers,
                timeout,
                cancelled,
            )
            .await?;
            Ok(gz360_home(&value))
        }
        "category" => {
            let page = gz360_page(params);
            let payload = gz360_category_payload(params, page);
            let endpoint = if payload["parent_id"].as_u64() == Some(0) {
                "/Pc/Resource/IndexShow/ShowOnes"
            } else {
                "/Pc/Resource/ModuleInfo/ShowOnes"
            };
            let value = gz360_post(&base, endpoint, &payload, headers, timeout, cancelled).await?;
            let list = gz360_items(&value);
            Ok(json!({
                "list": list,
                "page": page,
                "pagecount": if list.is_empty() { page } else { page.saturating_add(1) },
                "total": list.len()
            }))
        }
        "search" => {
            let keyword = param_text(params, "key")
                .or_else(|| param_text(params, "wd"))
                .or_else(|| param_text(params, "keyword"))
                .or_else(|| param_text(params, "searchWord"))
                .unwrap_or_default();
            if keyword.trim().is_empty() {
                return Err(LegacyHttpError::Request(
                    "GZ360_SEARCH_KEY_REQUIRED".to_string(),
                ));
            }
            let page = gz360_page(params);
            let page_size = gz360_page_size(params);
            let value = gz360_post(
                &base,
                "/Pc/Search/GetConditionList",
                &json!({
                    "tid": param_text(params, "tid")
                        .or_else(|| param_text(params, "typeId"))
                        .unwrap_or_else(|| "0".to_string()),
                    "area": param_text(params, "area").unwrap_or_else(|| "0".to_string()),
                    "year": param_text(params, "year").unwrap_or_else(|| "0".to_string()),
                    "sort": param_text(params, "sort").unwrap_or_else(|| "d_id".to_string()),
                    "keywords": keyword,
                    "page": page,
                    "pageSize": page_size,
                }),
                headers,
                timeout,
                cancelled,
            )
            .await?;
            let list = gz360_items(&value);
            Ok(json!({
                "list": list,
                "page": page,
                "pagecount": if list.len() < page_size as usize { page } else { page.saturating_add(1) },
                "total": list.len()
            }))
        }
        "detail" => {
            let id = gz360_id(params)?;
            let mut payload = json!({"vod_id": id, "phone_type": 3});
            if let Some(t_id) = param_text(params, "t_id") {
                payload["t_id"] = Value::String(t_id);
            }
            let value = gz360_post(
                &base,
                "/Pc/Resource/GetVodInfo",
                &payload,
                headers,
                timeout,
                cancelled,
            )
            .await?;
            gz360_detail(&value, &id).map_err(LegacyHttpError::Request)
        }
        "player" | "playback" => gz360_player(params),
        other => Err(LegacyHttpError::Unsupported(format!(
            "GZ360_METHOD_UNAVAILABLE:{other}"
        ))),
    }
}

fn gz360_home(value: &Value) -> Value {
    let mut classes = Vec::new();
    if let Some(items) = value.as_array() {
        for item in items {
            let Some(object) = item.as_object() else {
                continue;
            };
            let id = first_object_text(object, &["pid", "id"]);
            let name = first_object_text(object, &["name"]);
            if id.is_empty() || name.is_empty() {
                continue;
            }
            classes.push(json!({
                "type_id": id,
                "type_name": name,
                "type": first_object_text(object, &["type"]),
                "children": object.get("children").cloned().unwrap_or_else(|| json!([]))
            }));
        }
    }
    json!({"class": classes, "list": []})
}

fn gz360_category_payload(params: Option<&Value>, page: u64) -> Value {
    let parent_id = param_text(params, "parent_id")
        .or_else(|| param_text(params, "typeId"))
        .or_else(|| param_text(params, "nav_id"))
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    json!({
        "parent_id": parent_id,
        "page": page,
        "pageSize": gz360_page_size(params),
        "phone_type": 3
    })
}

fn gz360_page(params: Option<&Value>) -> u64 {
    param_text(params, "page")
        .or_else(|| param_text(params, "pageNo"))
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1)
        .max(1)
}

fn gz360_page_size(params: Option<&Value>) -> u64 {
    param_text(params, "pageSize")
        .or_else(|| param_text(params, "page_size"))
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(24)
        .clamp(1, 60)
}

fn gz360_id(params: Option<&Value>) -> Result<String, LegacyHttpError> {
    param_text(params, "vod_id")
        .or_else(|| param_text(params, "id"))
        .or_else(|| {
            params
                .and_then(|value| value.get("ids"))
                .and_then(Value::as_array)
                .and_then(|ids| ids.first())
                .map(value_text)
        })
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| LegacyHttpError::Request("GZ360_ID_REQUIRED".to_string()))
}

fn gz360_items(value: &Value) -> Vec<Value> {
    let mut result = Vec::new();
    gz360_collect_items(value, &mut result);
    result
}

fn gz360_collect_items(value: &Value, result: &mut Vec<Value>) {
    match value {
        Value::Array(items) => {
            for item in items {
                if let Some(mapped) = gz360_item(item) {
                    result.push(mapped);
                } else {
                    gz360_collect_items(item, result);
                }
            }
        }
        Value::Object(object) => {
            for key in ["list", "data", "items"] {
                if let Some(value) = object.get(key) {
                    gz360_collect_items(value, result);
                }
            }
        }
        _ => {}
    }
}

fn gz360_item(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let id = first_object_text(object, &["vod_id", "id"]);
    let name = first_object_text(object, &["vod_name", "c_name", "name", "title"]);
    if id.is_empty() || name.is_empty() {
        return None;
    }
    let tags = object
        .get("tags")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(value_text)
                .filter(|value| !value.trim().is_empty())
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    Some(json!({
        "vod_id": id,
        "vod_name": name,
        "vod_pic": first_object_text(object, &["vod_pic", "c_pic", "pic"]),
        "vod_remarks": first_object_text(object, &["vod_continu", "vod_title", "cf_name", "vod_remarks"]),
        "vod_content": first_object_text(object, &["vod_use_content", "vod_content"]),
        "type_name": if tags.is_empty() { first_object_text(object, &["vod_type_name", "type_name"]) } else { tags }
    }))
}

fn gz360_detail(value: &Value, id: &str) -> Result<Value, String> {
    let object = value
        .get("vodInfo")
        .and_then(Value::as_object)
        .or_else(|| value.as_object())
        .ok_or_else(|| "GZ360_DETAIL_INVALID".to_string())?;
    let name = first_object_text(object, &["vod_name", "vod_title", "name"]);
    if name.is_empty() {
        return Err("GZ360_DETAIL_NAME_MISSING".to_string());
    }
    let mut episodes = Vec::new();
    let default_label = first_object_text(object, &["default_play_name", "vod_title"]);
    if let Some(url) = object
        .get("play_url")
        .and_then(Value::as_str)
        .and_then(gz360_media_url)
    {
        let label = if default_label.is_empty() {
            "正片"
        } else {
            &default_label
        };
        episodes.push(format!("{}${url}", gz360_episode_label(label)));
    }
    if let Some(url) = object
        .get("pre_video")
        .and_then(Value::as_str)
        .and_then(gz360_media_url)
    {
        episodes.push(format!("预告${url}"));
    }
    if let Some(urls) = object.get("vurlList").and_then(Value::as_array) {
        for url_item in urls {
            let Some(url_object) = url_item.as_object() else {
                continue;
            };
            let Some(url) = url_object
                .get("url")
                .and_then(Value::as_str)
                .and_then(gz360_media_url)
            else {
                continue;
            };
            let label = first_object_text(url_object, &["name", "episode"]);
            if !label.is_empty() {
                episodes.push(format!("{}${url}", gz360_episode_label(&label)));
            }
        }
    }
    episodes.sort();
    episodes.dedup();
    Ok(json!({
        "list": [{
            "vod_id": id,
            "vod_name": name,
            "vod_pic": first_object_text(object, &["vod_pic", "vod_picthumb"]),
            "vod_remarks": first_object_text(object, &["vod_title", "vod_year"]),
            "vod_content": first_object_text(object, &["vod_use_content", "vod_content"]),
            "type_name": object.get("videoTag").map(value_text).unwrap_or_default(),
            "vod_play_from": if episodes.is_empty() { "" } else { "瓜子影视" },
            "vod_play_url": episodes.join("#")
        }]
    }))
}

fn gz360_episode_label(value: &str) -> String {
    let label = value.replace(['$', '#'], " ").trim().to_string();
    if label.is_empty() {
        "正片".to_string()
    } else {
        label
    }
}

fn gz360_player(params: Option<&Value>) -> Result<Value, LegacyHttpError> {
    let raw = param_text(params, "id")
        .or_else(|| param_text(params, "url"))
        .unwrap_or_default();
    let raw = raw
        .rsplit_once('$')
        .map(|(_, value)| value)
        .unwrap_or(raw.as_str());
    let url = gz360_media_url(raw)
        .ok_or_else(|| LegacyHttpError::Request("GZ360_PLAY_URL_INVALID".to_string()))?;
    Ok(json!({
        "parse": 0,
        "jx": 0,
        "url": url,
        "header": {"User-Agent": GZ360_UA, "Referer": GZ360_REFERER}
    }))
}

fn gz360_media_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 4096 {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url.to_string())
}

async fn gz360_post(
    base: &reqwest::Url,
    path: &str,
    payload: &Value,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let url = join_url(base, path)?;
    let params = gz360_encrypt_json(payload)
        .map_err(|error| LegacyHttpError::Request(format!("GZ360_ENCRYPT_FAILED:{error}")))?;
    let body = serde_json::to_vec(&json!({"params": params}))
        .map_err(|error| LegacyHttpError::Request(format!("GZ360_BODY_INVALID:{error}")))?;
    let mut request_headers = headers.clone();
    insert_default_header(&mut request_headers, "user-agent", GZ360_UA)?;
    insert_default_header(&mut request_headers, "origin", "https://gz360.tv")?;
    insert_default_header(&mut request_headers, "referer", GZ360_REFERER)?;
    insert_default_header(&mut request_headers, "content-type", "application/json")?;
    let client = reqwest::Client::builder()
        .default_headers(request_headers)
        .redirect(reqwest::redirect::Policy::none())
        .http1_only()
        .timeout(timeout)
        .build()
        .map_err(|error| LegacyHttpError::Request(format!("GZ360_CLIENT_INIT_FAILED:{error}")))?;
    let response = tokio::select! {
        result = client.post(url).body(body).send() => result
            .map_err(|error| LegacyHttpError::Request(format!("GZ360_HTTP_FAILED:{error}")))?,
        _ = wait_for_cancel(cancelled.clone()) => return Err(LegacyHttpError::Request("GZ360_REQUEST_CANCELLED".to_string())),
    };
    let status = response.status();
    let bytes = tokio::select! {
        result = read_bounded_response(response) => result
            .map_err(|error| LegacyHttpError::Request(error.message("GZ360_RESPONSE_TOO_LARGE")))?,
        _ = wait_for_cancel(cancelled) => return Err(LegacyHttpError::Request("GZ360_REQUEST_CANCELLED".to_string())),
    };
    if !status.is_success() {
        return Err(LegacyHttpError::Request(format!(
            "GZ360_HTTP_STATUS:{}",
            status.as_u16()
        )));
    }
    let envelope: Value = serde_json::from_slice(&bytes)
        .map_err(|error| LegacyHttpError::Request(format!("GZ360_JSON_INVALID:{error}")))?;
    let code = envelope.get("code").map(value_text).unwrap_or_default();
    if code != "200" {
        return Err(LegacyHttpError::Request(gz360_response_error(&envelope)));
    }
    let data = envelope
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| LegacyHttpError::Request("GZ360_RESPONSE_DATA_MISSING".to_string()))?;
    let plaintext = gz360_decrypt_text(data.trim())
        .map_err(|error| LegacyHttpError::Request(format!("GZ360_DECRYPT_FAILED:{error}")))?;
    serde_json::from_str(plaintext.trim_start_matches('\u{feff}'))
        .map_err(|error| LegacyHttpError::Request(format!("GZ360_PAYLOAD_INVALID:{error}")))
}

fn gz360_response_error(envelope: &Value) -> String {
    let code = envelope
        .get("code")
        .map(value_text)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "MISSING".to_string());
    let message = envelope
        .get("msg")
        .or_else(|| envelope.get("message"))
        .map(value_text)
        .map(|value| value.trim().chars().take(128).collect::<String>())
        .filter(|value| !value.is_empty());
    match message {
        Some(message) => format!("GZ360_RESPONSE_CODE:{code}:{message}"),
        None => format!("GZ360_RESPONSE_CODE:{code}"),
    }
}

fn gz360_encrypt_json(value: &Value) -> Result<String, String> {
    let text = serde_json::to_string(value).map_err(|error| error.to_string())?;
    gz360_encrypt_text(&text)
}

fn gz360_encrypt_text(value: &str) -> Result<String, String> {
    let mut buffer = Vec::with_capacity(value.len() + 16);
    buffer.extend_from_slice(value.as_bytes());
    let length = buffer.len();
    buffer.resize(length + 16, 0);
    let encrypted = Aes128CbcEncryptor::new(GZ360_KEY.into(), GZ360_IV.into())
        .encrypt_padded_mut::<Pkcs7>(&mut buffer, length)
        .map_err(|error| error.to_string())?;
    Ok(encrypted.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn gz360_decrypt_text(value: &str) -> Result<String, String> {
    let mut bytes = gz360_decode_hex(value)?;
    let decrypted = Aes128CbcDecryptor::new(GZ360_KEY.into(), GZ360_IV.into())
        .decrypt_padded_mut::<Pkcs7>(&mut bytes)
        .map_err(|error| error.to_string())?;
    String::from_utf8(decrypted.to_vec()).map_err(|error| error.to_string())
}

fn gz360_decode_hex(value: &str) -> Result<Vec<u8>, String> {
    let value = value.trim();
    if value.is_empty() || value.len() % 2 != 0 {
        return Err("hex length is invalid".to_string());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16).map_err(|error| error.to_string())
        })
        .collect()
}

async fn call_guazi_ty(
    method: &str,
    params: Option<&Value>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let base = fixed_base(GUAZI_BASE)?;
    match method {
        "home" => Ok(guazi_home()),
        "category" => {
            let page = param_text(params, "page")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(1)
                .max(1);
            if page != 1 {
                return Ok(json!({
                    "list": [],
                    "page": page,
                    "pagecount": 1,
                    "total": 0
                }));
            }
            let type_id = param_text(params, "typeId").unwrap_or_else(|| "hot".to_string());
            let payload = guazi_category_payload(&type_id);
            let value = guazi_post(
                &base,
                "/gz/live/sports?parameter=key",
                &payload,
                headers,
                timeout,
                cancelled,
            )
            .await?;
            let list = guazi_items(&value);
            Ok(json!({
                "list": list,
                "page": page,
                "pagecount": 1,
                "total": list.len()
            }))
        }
        "detail" => {
            let id = first_id(params)?;
            let value = guazi_post(
                &base,
                "/gz/live/detail?parameter=key",
                &json!({"mid": id}),
                headers,
                timeout,
                cancelled,
            )
            .await?;
            guazi_detail(&value, &id).map_err(LegacyHttpError::Request)
        }
        "player" | "playback" => guazi_player(params),
        other => Err(LegacyHttpError::Unsupported(format!(
            "GUAZI_METHOD_UNAVAILABLE:{other}"
        ))),
    }
}

fn guazi_home() -> Value {
    json!({
        "class": [
            {"type_id": "hot", "type_name": "热门"},
            {"type_id": "nba", "type_name": "NBA"},
            {"type_id": "football", "type_name": "足球"},
            {"type_id": "basketball", "type_name": "篮球"}
        ],
        "list": []
    })
}

fn guazi_category_payload(type_id: &str) -> Value {
    match type_id.trim().to_ascii_lowercase().as_str() {
        "nba" | "2" => json!({"frame": "0", "hot": "0", "tag": "37", "type": "0"}),
        "football" | "3" => json!({"frame": "0", "hot": "0", "tag": "0", "type": "1"}),
        "basketball" | "4" => json!({"frame": "0", "hot": "0", "tag": "0", "type": "2"}),
        _ => json!({"frame": "0", "hot": "1", "tag": "0", "type": "0"}),
    }
}

fn guazi_items(value: &Value) -> Vec<Value> {
    guazi_array(value)
        .into_iter()
        .flatten()
        .filter_map(guazi_item)
        .collect()
}

fn guazi_array(value: &Value) -> Option<&Vec<Value>> {
    match value {
        Value::Array(items) => Some(items),
        Value::Object(object) => {
            for key in ["list", "items", "data"] {
                if let Some(items) = object.get(key).and_then(guazi_array) {
                    return Some(items);
                }
            }
            None
        }
        _ => None,
    }
}

fn guazi_item(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let timestamp = guazi_epoch_seconds(object.get("match_time")?)?;
    let now = unix_epoch_seconds();
    if timestamp < now.saturating_sub(24 * 60 * 60) {
        return None;
    }
    let status = guazi_i64(object.get("m_status")?)?;
    if status >= 2 {
        return None;
    }
    let id = first_object_text(object, &["mid", "id"]);
    let home = object.get("home").and_then(Value::as_object);
    let visiting = object.get("visiting").and_then(Value::as_object);
    let home_name = home
        .map(|value| first_object_text(value, &["name"]))
        .unwrap_or_default();
    let visiting_name = visiting
        .map(|value| first_object_text(value, &["name"]))
        .unwrap_or_default();
    if id.is_empty() || home_name.is_empty() || visiting_name.is_empty() {
        return None;
    }
    let name = format!("{home_name} vs {visiting_name}");
    let logo = home
        .map(|value| first_object_text(value, &["logo"]))
        .unwrap_or_default();
    let event = first_object_text(object, &["event_name"]);
    let match_status = first_object_text(object, &["match_status_info"]);
    let time = guazi_match_time(object.get("match_time")?);
    let mut parts = [event, time, match_status]
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    let home_score = home
        .and_then(|value| value.get("score"))
        .and_then(guazi_i64);
    let visiting_score = visiting
        .and_then(|value| value.get("score"))
        .and_then(guazi_i64);
    if home_score.is_some_and(|score| score > 0) || visiting_score.is_some_and(|score| score > 0) {
        parts.push(format!(
            "比分 {}-{}",
            home_score.unwrap_or_default(),
            visiting_score.unwrap_or_default()
        ));
    }
    Some(json!({
        "vod_id": id,
        "vod_name": name,
        "vod_pic": logo,
        "vod_remarks": parts.join(" ")
    }))
}

fn guazi_detail(value: &Value, id: &str) -> Result<Value, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "GUAZI_DETAIL_INVALID".to_string())?;
    let home = object
        .get("home")
        .and_then(Value::as_object)
        .ok_or_else(|| "GUAZI_DETAIL_HOME_MISSING".to_string())?;
    let visiting = object
        .get("visiting")
        .and_then(Value::as_object)
        .ok_or_else(|| "GUAZI_DETAIL_VISITING_MISSING".to_string())?;
    let home_name = first_object_text(home, &["name"]);
    let visiting_name = first_object_text(visiting, &["name"]);
    if home_name.is_empty() || visiting_name.is_empty() {
        return Err("GUAZI_DETAIL_TEAMS_MISSING".to_string());
    }
    let mut episodes = Vec::new();
    if let Some(lines) = object.get("live_line").and_then(Value::as_array) {
        for line in lines {
            let Some(line) = line.as_object() else {
                continue;
            };
            let label = first_object_text(line, &["name"])
                .replace(['$', '#'], " ")
                .trim()
                .to_string();
            let Some(url) = line
                .get("m3u8")
                .and_then(Value::as_str)
                .and_then(guazi_media_url)
            else {
                continue;
            };
            if label.is_empty() {
                continue;
            }
            episodes.push(format!("{label}${url}"));
        }
    }
    let status = guazi_score_text(object);
    Ok(json!({
        "list": [{
            "vod_id": id,
            "vod_name": format!("{home_name} vs {visiting_name}"),
            "vod_pic": first_object_text(home, &["logo"]),
            "type_name": status,
            "vod_play_from": "瓜子体育",
            "vod_play_url": episodes.join("#")
        }]
    }))
}

fn guazi_score_text(object: &serde_json::Map<String, Value>) -> String {
    let mut text = first_object_text(object, &["match_status_info"]);
    let home_score = object
        .get("home")
        .and_then(Value::as_object)
        .and_then(|value| value.get("score"))
        .and_then(guazi_i64);
    let visiting_score = object
        .get("visiting")
        .and_then(Value::as_object)
        .and_then(|value| value.get("score"))
        .and_then(guazi_i64);
    if home_score.is_some_and(|score| score > 0) || visiting_score.is_some_and(|score| score > 0) {
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(&format!(
            "比分 {}-{}",
            home_score.unwrap_or_default(),
            visiting_score.unwrap_or_default()
        ));
    }
    text
}

fn guazi_player(params: Option<&Value>) -> Result<Value, LegacyHttpError> {
    let raw = param_text(params, "id")
        .or_else(|| param_text(params, "url"))
        .unwrap_or_default();
    let url = guazi_media_url(&raw).or_else(|| {
        raw.rsplit_once('$')
            .and_then(|(_, value)| guazi_media_url(value))
    });
    let url = url.ok_or_else(|| LegacyHttpError::Request("GUAZI_PLAY_URL_INVALID".to_string()))?;
    Ok(json!({
        "parse": 0,
        "jx": 0,
        "url": url,
        "header": {
            "User-Agent": GUAZI_PLAYER_UA,
            "Referer": GUAZI_PLAYER_REFERER
        }
    }))
}

fn guazi_media_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 4096 {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url.to_string())
}

async fn guazi_post(
    base: &reqwest::Url,
    path: &str,
    payload: &Value,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let url = join_url(base, path)?;
    let parameter = guazi_encrypt_json(payload)
        .map_err(|error| LegacyHttpError::Request(format!("GUAZI_ENCRYPT_FAILED:{error}")))?;
    let mut request_headers = headers.clone();
    insert_default_header(&mut request_headers, "user-agent", GUAZI_UA)?;
    insert_default_header(
        &mut request_headers,
        "content-type",
        "application/x-www-form-urlencoded",
    )?;
    insert_default_header(&mut request_headers, "user-platform", "null")?;
    insert_default_header(&mut request_headers, "client-version", "3.0.1.1")?;
    insert_default_header(&mut request_headers, "client-channel", "")?;
    insert_default_header(&mut request_headers, "token", "")?;
    let client = reqwest::Client::builder()
        .default_headers(request_headers)
        .redirect(reqwest::redirect::Policy::none())
        .http1_only()
        .timeout(timeout)
        .build()
        .map_err(|error| LegacyHttpError::Request(format!("GUAZI_CLIENT_INIT_FAILED:{error}")))?;
    let form_body = guazi_form_body(&parameter);
    let response = tokio::select! {
        result = client.post(url).body(form_body).send() => result
            .map_err(|error| LegacyHttpError::Request(format!("GUAZI_HTTP_FAILED:{error}")))?,
        _ = wait_for_cancel(cancelled.clone()) => return Err(LegacyHttpError::Request("GUAZI_REQUEST_CANCELLED".to_string())),
    };
    let status = response.status();
    let bytes = tokio::select! {
        result = read_bounded_response(response) => result
            .map_err(|error| LegacyHttpError::Request(error.message("GUAZI_RESPONSE_TOO_LARGE")))?,
        _ = wait_for_cancel(cancelled) => return Err(LegacyHttpError::Request("GUAZI_REQUEST_CANCELLED".to_string())),
    };
    if !status.is_success() {
        return Err(LegacyHttpError::Request(format!(
            "GUAZI_HTTP_STATUS:{}",
            status.as_u16()
        )));
    }
    let envelope: Value = serde_json::from_slice(&bytes)
        .map_err(|error| LegacyHttpError::Request(format!("GUAZI_JSON_INVALID:{error}")))?;
    let code = envelope.get("code").map(value_text).unwrap_or_default();
    if !code.is_empty() && code != "200" {
        return Err(LegacyHttpError::Request(format!(
            "GUAZI_RESPONSE_CODE:{code}"
        )));
    }
    let data = envelope
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| LegacyHttpError::Request("GUAZI_RESPONSE_DATA_MISSING".to_string()))?;
    let plaintext = guazi_decrypt_text(data.trim())
        .map_err(|error| LegacyHttpError::Request(format!("GUAZI_DECRYPT_FAILED:{error}")))?;
    serde_json::from_str(plaintext.trim_start_matches('\u{feff}'))
        .map_err(|error| LegacyHttpError::Request(format!("GUAZI_PAYLOAD_INVALID:{error}")))
}

fn guazi_form_body(parameter: &str) -> String {
    let mut url = reqwest::Url::parse("https://example.invalid/").expect("static URL");
    url.query_pairs_mut().append_pair("parameter", parameter);
    url.query().unwrap_or_default().to_string()
}

fn guazi_encrypt_json(value: &Value) -> Result<String, String> {
    let text = serde_json::to_string(value).map_err(|error| error.to_string())?;
    guazi_encrypt_text(&text)
}

fn guazi_encrypt_text(value: &str) -> Result<String, String> {
    let mut buffer = Vec::with_capacity(value.len() + 16);
    buffer.extend_from_slice(value.as_bytes());
    let length = buffer.len();
    buffer.resize(length + 16, 0);
    let encrypted = Aes128CbcEncryptor::new(GUAZI_KEY.into(), GUAZI_IV.into())
        .encrypt_padded_mut::<Pkcs7>(&mut buffer, length)
        .map_err(|error| error.to_string())?;
    Ok(STANDARD_NO_PAD.encode(encrypted))
}

fn guazi_decrypt_text(value: &str) -> Result<String, String> {
    let mut bytes = STANDARD_NO_PAD
        .decode(value)
        .or_else(|_| STANDARD.decode(value))
        .map_err(|error| error.to_string())?;
    let decrypted = Aes128CbcDecryptor::new(GUAZI_KEY.into(), GUAZI_IV.into())
        .decrypt_padded_mut::<Pkcs7>(&mut bytes)
        .map_err(|error| error.to_string())?;
    String::from_utf8(decrypted.to_vec()).map_err(|error| error.to_string())
}

fn guazi_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
}

fn guazi_epoch_seconds(value: &Value) -> Option<i64> {
    let value = guazi_i64(value)?;
    Some(if value.unsigned_abs() > 100_000_000_000 {
        value / 1_000
    } else {
        value
    })
}

fn unix_epoch_seconds() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn guazi_match_time(value: &Value) -> String {
    let Some(seconds) = guazi_epoch_seconds(value) else {
        return value_text(value);
    };
    let local = seconds.saturating_add(8 * 60 * 60);
    let days = local.div_euclid(86_400);
    let day_seconds = local.rem_euclid(86_400);
    let (_year, month, day) = guazi_civil_date(days);
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    format!("{month:02}-{day:02} {hour:02}:{minute:02}")
}

fn guazi_civil_date(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096).div_euclid(365);
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2).div_euclid(153);
    let day = doy - (153 * mp + 2).div_euclid(5) + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    (year + i64::from(month <= 2), month, day)
}

async fn call_wwys(
    method: &str,
    params: Option<&Value>,
    ext: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    call_html_catalog(
        LegacyHttpKind::Wwys,
        method,
        params,
        configured_html_base("https://vip.wwgz.cn:5200", ext)?,
        headers,
        timeout,
        cancelled,
    )
    .await
}

async fn call_saohuo(
    method: &str,
    params: Option<&Value>,
    ext: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    if !matches!(
        method,
        "home" | "category" | "search" | "detail" | "player" | "playback"
    ) {
        return Err(LegacyHttpError::Unsupported(format!(
            "HTML_METHOD_UNAVAILABLE:{method}"
        )));
    }
    if method == "search" && param_text(params, "key").is_none_or(|key| key.trim().is_empty()) {
        return Err(LegacyHttpError::Request(
            "HTML_SEARCH_KEY_REQUIRED".to_string(),
        ));
    }
    if method == "detail" {
        let _ = first_id(params)?;
    }
    if matches!(method, "player" | "playback") {
        let raw = param_text(params, "id")
            .or_else(|| param_text(params, "url"))
            .unwrap_or_default();
        if let Some(url) = html_media_url(&raw) {
            return Ok(json!({"parse": 0, "jx": 0, "url": url, "header": {}}));
        }
    }
    let configured = configured_html_base("https://shdy5.us", ext)?;
    let mut bases = saohuo_bases(&configured, headers, timeout, cancelled.clone()).await?;
    if !bases.iter().any(|base| base == &configured) {
        bases.push(configured);
    }
    let mut last_request_error = None;
    for base in bases {
        match call_html_catalog(
            LegacyHttpKind::SaoHuo,
            method,
            params,
            base,
            headers,
            timeout,
            cancelled.clone(),
        )
        .await
        {
            Ok(value) => return Ok(value),
            Err(LegacyHttpError::Request(message)) => {
                if message == "SOURCE_REQUEST_CANCELLED" {
                    return Err(LegacyHttpError::Request(message));
                }
                last_request_error = Some(message);
            }
            Err(error) => return Err(error),
        }
    }
    Err(LegacyHttpError::Request(
        last_request_error.unwrap_or_else(|| "SAOHUO_SOURCE_UNAVAILABLE".to_string()),
    ))
}

async fn saohuo_bases(
    configured: &reqwest::Url,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Vec<reqwest::Url>, LegacyHttpError> {
    let discovered = if let Some(cached) = SAOHUO_DISCOVERY_CACHE.get() {
        cached.clone()
    } else {
        let discovery_url = fixed_base(SAOHUO_DISCOVERY_URL)?;
        let discovered = match get_text(discovery_url, headers, timeout, cancelled).await {
            Ok(html) => saohuo_discovered_bases(&html)
                .into_iter()
                .map(|url| url.to_string())
                .collect::<Vec<_>>(),
            Err(LegacyHttpError::Request(message)) if message == "SOURCE_REQUEST_CANCELLED" => {
                return Err(LegacyHttpError::Request(message));
            }
            Err(_) => Vec::new(),
        };
        let _ = SAOHUO_DISCOVERY_CACHE.set(discovered.clone());
        discovered
    };
    Ok(discovered
        .into_iter()
        .filter_map(|value| reqwest::Url::parse(&value).ok())
        .filter(|url| url != configured)
        .collect::<Vec<_>>())
}

fn saohuo_discovered_bases(html: &str) -> Vec<reqwest::Url> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for tag in opening_tags(html, "a") {
        let Some(href) = attribute(tag, "href") else {
            continue;
        };
        let Ok(mut url) = reqwest::Url::parse(href.trim()) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || !saohuo_host_allowed(url.host_str().unwrap_or_default())
        {
            continue;
        }
        url.set_path("/");
        url.set_query(None);
        url.set_fragment(None);
        if seen.insert(url.to_string()) {
            result.push(url);
        }
    }
    result
}

fn saohuo_host_allowed(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let Some(rest) = host.strip_prefix("shdy") else {
        return false;
    };
    let Some((number, suffix)) = rest.split_once('.') else {
        return false;
    };
    !number.is_empty()
        && number.bytes().all(|byte| byte.is_ascii_digit())
        && matches!(suffix, "com" | "us")
}

async fn call_czsapp(
    method: &str,
    params: Option<&Value>,
    ext: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let mut request_headers = headers.clone();
    request_headers.insert(
        HeaderName::from_static("user-agent"),
        HeaderValue::from_static(CZSAPP_UA),
    );
    let base = configured_html_base("https://www.czzy89.com", ext)?;
    let first = call_html_catalog(
        LegacyHttpKind::Czsapp,
        method,
        params,
        base.clone(),
        &request_headers,
        timeout,
        cancelled.clone(),
    )
    .await;
    match first {
        Err(error) if is_retryable_czsapp_error(&error) && !cancelled.load(Ordering::Acquire) => {
            call_html_catalog(
                LegacyHttpKind::Czsapp,
                method,
                params,
                base,
                &request_headers,
                timeout,
                cancelled,
            )
            .await
        }
        result => result,
    }
}

fn is_retryable_czsapp_error(error: &LegacyHttpError) -> bool {
    let LegacyHttpError::Request(message) = error else {
        return false;
    };
    if message.starts_with("error sending request for url") {
        return true;
    }
    let Some(status) = message
        .strip_prefix("SOURCE_HTTP_STATUS:")
        .and_then(|value| value.split_whitespace().next())
        .and_then(|value| value.parse::<u16>().ok())
    else {
        return false;
    };
    matches!(status, 408 | 425 | 429 | 500 | 502 | 503 | 504 | 520..=524)
}

async fn call_duopan(
    method: &str,
    params: Option<&Value>,
    ext: &str,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    if matches!(method, "player" | "playback") {
        return Ok(json!({
            "status": "AUTH_REQUIRED",
            "parse": 0,
            "jx": 0,
            "url": "",
            "header": {},
            "message": "DUOPAN_UC_ACCESS_TOKEN_REQUIRED"
        }));
    }
    let bases = configured_html_bases("", ext)?;
    let mut last_error = None;
    for base in bases {
        match call_html_catalog(
            LegacyHttpKind::Duopan,
            method,
            params,
            base,
            headers,
            timeout,
            cancelled.clone(),
        )
        .await
        {
            Ok(value) => return Ok(value),
            Err(LegacyHttpError::Unsupported(error)) => {
                return Err(LegacyHttpError::Unsupported(error));
            }
            Err(error @ LegacyHttpError::Request(_)) => {
                if matches!(&error, LegacyHttpError::Request(message) if message.contains("CANCELLED"))
                {
                    return Err(error);
                }
                last_error = Some(error);
            }
        }
    }
    Err(last_error
        .unwrap_or_else(|| LegacyHttpError::Request("DUOPAN_NO_CONTENT_ENDPOINT".to_string())))
}

async fn call_ygp(
    method: &str,
    params: Option<&Value>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let base = fixed_base(YGP_BASE)?;
    let mut request_headers = headers.clone();
    insert_default_header(&mut request_headers, "user-agent", YGP_UA)?;
    insert_default_header(&mut request_headers, "referer", YGP_BASE)?;
    match method {
        "home" => {
            let html = get_text(base.clone(), &request_headers, timeout, cancelled).await?;
            Ok(json!({
                "class": ygp_classes(),
                "list": ygp_catalog_items(&html, &base)
            }))
        }
        "category" => {
            let page = param_text(params, "page").unwrap_or_else(|| "1".to_string());
            let path = ygp_category_path(params, &page)?;
            let html = get_text(
                join_url(&base, &path)?,
                &request_headers,
                timeout,
                cancelled,
            )
            .await?;
            let list = ygp_catalog_items(&html, &base);
            Ok(json!({
                "page": page.parse::<u64>().unwrap_or(1),
                "pagecount": ygp_page_count(&html),
                "total": list.len(),
                "list": list
            }))
        }
        "search" => {
            let key = param_text(params, "key").unwrap_or_default();
            if key.trim().is_empty() {
                return Err(LegacyHttpError::Request(
                    "YGP_SEARCH_KEY_REQUIRED".to_string(),
                ));
            }
            let mut url = base.clone();
            url.query_pairs_mut().append_pair("keyword", &key);
            url.query_pairs_mut().append_pair("view", "search");
            let html = get_text(url, &request_headers, timeout, cancelled).await?;
            let list = ygp_catalog_items(&html, &base);
            Ok(json!({"total": list.len(), "list": list}))
        }
        "detail" => {
            let id = first_id(params)?;
            let url = ygp_detail_url(&base, &id)?;
            let html = get_text(url.clone(), &request_headers, timeout, cancelled).await?;
            ygp_detail(&html, &url).map_err(LegacyHttpError::Request)
        }
        "player" | "playback" => {
            let raw = param_text(params, "id")
                .or_else(|| param_text(params, "url"))
                .unwrap_or_default();
            let candidate = raw
                .rsplit_once('$')
                .map(|(_, value)| value)
                .unwrap_or(raw.as_str());
            let page = ygp_show_url(&base, candidate)?;
            let html = get_text(page, &request_headers, timeout, cancelled).await?;
            let url = extract_html_media(&html).ok_or_else(|| {
                LegacyHttpError::Unsupported("YGP_DYNAMIC_PLAYER_UNSUPPORTED".to_string())
            })?;
            Ok(json!({
                "parse": 0,
                "jx": 0,
                "url": url,
                "header": {"User-Agent": YGP_UA}
            }))
        }
        other => Err(LegacyHttpError::Unsupported(format!(
            "YGP_METHOD_UNAVAILABLE:{other}"
        ))),
    }
}

async fn call_tuxiaobei(
    method: &str,
    params: Option<&Value>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let base = fixed_base(TUXIAOBEI_BASE)?;
    let mut request_headers = headers.clone();
    request_headers.insert(
        HeaderName::from_static("user-agent"),
        HeaderValue::from_static(TUXIAOBEI_UA),
    );
    request_headers.insert(
        HeaderName::from_static("referer"),
        HeaderValue::from_static(TUXIAOBEI_BASE),
    );
    match method {
        "home" => {
            let html = get_text(base.clone(), &request_headers, timeout, cancelled).await?;
            Ok(json!({
                "class": tuxiaobei_classes(),
                "list": tuxiaobei_html_items(&html, &base)
            }))
        }
        "category" => {
            let type_id = tuxiaobei_type_id(params)?;
            let page = tuxiaobei_page(params);
            let mut url = join_url(&base, "/list/mip-data")?;
            url.query_pairs_mut()
                .append_pair("typeId", &type_id)
                .append_pair("page", &page.to_string())
                .append_pair("callback", "");
            let body = get_text(url, &request_headers, timeout, cancelled).await?;
            let value = tuxiaobei_parse_jsonp(&body).map_err(LegacyHttpError::Request)?;
            let list = tuxiaobei_json_items(&value, &base);
            let pagecount = value
                .pointer("/data/page_count")
                .or_else(|| value.pointer("/data/pages"))
                .or_else(|| value.pointer("/data/pageCount"))
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .max(page);
            Ok(json!({
                "page": page,
                "pagecount": pagecount,
                "total": list.len(),
                "list": list
            }))
        }
        "search" => {
            let key = param_text(params, "key").unwrap_or_default();
            let url = tuxiaobei_search_url(&base, &key)?;
            let html = get_text(url, &request_headers, timeout, cancelled).await?;
            let list = tuxiaobei_html_items(&html, &base);
            Ok(json!({"total": list.len(), "list": list}))
        }
        "detail" => {
            let id = first_id(params)?;
            let url = tuxiaobei_detail_url(&base, &id)?;
            let html = get_text(url.clone(), &request_headers, timeout, cancelled).await?;
            tuxiaobei_detail(&html, &url).map_err(LegacyHttpError::Request)
        }
        "player" | "playback" => {
            let raw = param_text(params, "id")
                .or_else(|| param_text(params, "url"))
                .unwrap_or_default();
            let candidate = raw
                .rsplit_once('$')
                .map(|(_, value)| value)
                .unwrap_or(raw.as_str())
                .split('|')
                .next()
                .unwrap_or_default()
                .trim();
            let media = if let Some(url) = html_media_url(candidate) {
                url
            } else {
                let page = tuxiaobei_detail_url(&base, candidate)?;
                let html = get_text(page, &request_headers, timeout, cancelled).await?;
                tuxiaobei_video_url(&html).ok_or_else(|| {
                    LegacyHttpError::Unsupported("TUXIAOBEI_DYNAMIC_PLAYER_UNSUPPORTED".to_string())
                })?
            };
            Ok(json!({
                "parse": 0,
                "jx": 0,
                "url": media,
                "header": {"User-Agent": TUXIAOBEI_UA, "Referer": TUXIAOBEI_BASE}
            }))
        }
        other => Err(LegacyHttpError::Unsupported(format!(
            "TUXIAOBEI_METHOD_UNAVAILABLE:{other}"
        ))),
    }
}

fn tuxiaobei_classes() -> Vec<Value> {
    [("2", "儿歌"), ("3", "故事"), ("4", "国学"), ("25", "启蒙")]
        .into_iter()
        .map(|(type_id, type_name)| json!({"type_id": type_id, "type_name": type_name}))
        .collect()
}

fn tuxiaobei_type_id(params: Option<&Value>) -> Result<String, LegacyHttpError> {
    let type_id = param_text(params, "typeId").unwrap_or_else(|| "2".to_string());
    if matches!(type_id.as_str(), "2" | "3" | "4" | "25") {
        Ok(type_id)
    } else {
        Err(LegacyHttpError::Request(
            "TUXIAOBEI_TYPE_ID_INVALID".to_string(),
        ))
    }
}

fn tuxiaobei_page(params: Option<&Value>) -> u64 {
    param_text(params, "page")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (1..=1000).contains(value))
        .unwrap_or(1)
}

fn tuxiaobei_search_url(base: &reqwest::Url, key: &str) -> Result<reqwest::Url, LegacyHttpError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(LegacyHttpError::Request(
            "TUXIAOBEI_SEARCH_KEY_REQUIRED".to_string(),
        ));
    }
    let mut url = base.clone();
    url.set_query(None);
    url.set_fragment(None);
    url.path_segments_mut()
        .map_err(|_| LegacyHttpError::Request("TUXIAOBEI_URL_INVALID".to_string()))?
        .clear()
        .push("search")
        .push(key);
    Ok(url)
}

fn tuxiaobei_parse_jsonp(body: &str) -> Result<Value, String> {
    let trimmed = body.trim().trim_start_matches('\u{feff}');
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return serde_json::from_str(trimmed)
            .map_err(|error| format!("TUXIAOBEI_JSON_INVALID:{error}"));
    }
    let open = trimmed
        .find('{')
        .ok_or_else(|| "TUXIAOBEI_JSONP_INVALID".to_string())?;
    let close = trimmed
        .rfind('}')
        .filter(|close| *close > open)
        .ok_or_else(|| "TUXIAOBEI_JSONP_INVALID".to_string())?;
    if trimmed[..open].trim() != "(" || !matches!(trimmed[close + 1..].trim(), ")" | ");") {
        return Err("TUXIAOBEI_JSONP_INVALID".to_string());
    }
    serde_json::from_str(trimmed[open..=close].trim())
        .map_err(|error| format!("TUXIAOBEI_JSON_INVALID:{error}"))
}

fn tuxiaobei_json_items(value: &Value, base: &reqwest::Url) -> Vec<Value> {
    value
        .pointer("/data/items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let id = item.get("video_id").map(value_text)?;
            let id = id.trim();
            if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let name = item.get("name").map(value_text).unwrap_or_default();
            if name.trim().is_empty() {
                return None;
            }
            let detail = tuxiaobei_detail_url(base, id).ok()?;
            let image = item
                .get("image")
                .map(value_text)
                .and_then(|value| resolve_http_url(base, &value).ok())
                .map(|value| value.to_string())
                .unwrap_or_default();
            Some(json!({
                "vod_id": detail.to_string(),
                "vod_name": name.trim(),
                "vod_pic": image,
                "vod_remarks": item.get("duration_string").map(value_text).unwrap_or_default(),
                "type_name": item.get("category_name").map(value_text).unwrap_or_default()
            }))
        })
        .collect()
}

fn tuxiaobei_html_items(html: &str, base: &reqwest::Url) -> Vec<Value> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let mut fragments = elements(html, "div", Some("items"));
    fragments.extend(elements(html, "li", Some("items")));
    for fragment in fragments {
        let Some((anchor, id)) = opening_tags(fragment, "a")
            .filter_map(|tag| {
                let href = attribute(tag, "href")?;
                let id = tuxiaobei_play_id(&href)?;
                Some((tag, id))
            })
            .next()
        else {
            continue;
        };
        let Ok(detail) = tuxiaobei_detail_url(base, &id) else {
            continue;
        };
        let detail = detail.to_string();
        if !seen.insert(detail.clone()) {
            continue;
        }
        let name = opening_tags(fragment, "div")
            .find(|tag| has_class(tag, "text"))
            .map(|tag| text(element_fragment(fragment, tag)))
            .filter(|value| !value.is_empty())
            .or_else(|| attribute(anchor, "title"))
            .unwrap_or_else(|| text(item_fragment(fragment, anchor)));
        if name.trim().is_empty() {
            continue;
        }
        let image = opening_tags(fragment, "mip-img")
            .next()
            .and_then(|tag| attribute(tag, "src"))
            .and_then(|value| resolve_http_url(base, &value).ok())
            .map(|value| value.to_string())
            .unwrap_or_default();
        let remarks = opening_tags(fragment, "div")
            .find(|tag| has_class(tag, "time") || has_class(tag, "all"))
            .map(|tag| text(element_fragment(fragment, tag)))
            .unwrap_or_default();
        result.push(json!({
            "vod_id": detail,
            "vod_name": name.trim(),
            "vod_pic": image,
            "vod_remarks": remarks
        }));
    }
    result
}

fn tuxiaobei_play_id(value: &str) -> Option<String> {
    let path = reqwest::Url::parse(value.trim())
        .ok()
        .map(|url| url.path().to_string())
        .unwrap_or_else(|| value.trim().to_string());
    let id = path.strip_prefix("/play/")?.trim_end_matches('/');
    (!id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit())).then(|| id.to_string())
}

fn tuxiaobei_detail_url(base: &reqwest::Url, value: &str) -> Result<reqwest::Url, LegacyHttpError> {
    let raw = value.trim();
    let id = if raw.starts_with("http://") || raw.starts_with("https://") {
        let parsed = reqwest::Url::parse(raw)
            .map_err(|_| LegacyHttpError::Request("TUXIAOBEI_URL_INVALID".to_string()))?;
        if parsed.host_str() != base.host_str()
            || !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(LegacyHttpError::Request(
                "TUXIAOBEI_URL_INVALID".to_string(),
            ));
        }
        tuxiaobei_play_id(raw)
            .ok_or_else(|| LegacyHttpError::Request("TUXIAOBEI_ID_INVALID".to_string()))?
    } else if raw.bytes().all(|byte| byte.is_ascii_digit()) && !raw.is_empty() {
        raw.to_string()
    } else if let Some(id) = tuxiaobei_play_id(raw) {
        id
    } else {
        return Err(LegacyHttpError::Request("TUXIAOBEI_ID_INVALID".to_string()));
    };
    let url = join_url(base, &format!("/play/{id}"))?;
    if url.host_str() != base.host_str() || url.username() != "" || url.password().is_some() {
        return Err(LegacyHttpError::Request(
            "TUXIAOBEI_URL_INVALID".to_string(),
        ));
    }
    Ok(url)
}

fn tuxiaobei_video_url(html: &str) -> Option<String> {
    opening_tags(html, "mip-search-video")
        .filter_map(|tag| attribute(tag, "video-src"))
        .find_map(|value| html_media_url(&value))
}

fn tuxiaobei_detail(html: &str, url: &reqwest::Url) -> Result<Value, String> {
    let title = [
        opening_tags(html, "h1")
            .map(|tag| text(element_fragment(html, tag)))
            .next(),
        meta_content(html, "property", "og:title").into(),
        opening_tags(html, "title")
            .map(|tag| text(element_fragment(html, tag)))
            .next(),
    ]
    .into_iter()
    .flatten()
    .map(|value| value.trim().to_string())
    .find(|value| !value.is_empty())
    .unwrap_or_default();
    if title.is_empty() {
        return Err("TUXIAOBEI_DETAIL_TITLE_MISSING".to_string());
    }
    let poster = opening_tags(html, "mip-search-video")
        .next()
        .and_then(|tag| attribute(tag, "poster"))
        .unwrap_or_default();
    let poster = if poster.is_empty() {
        String::new()
    } else {
        reqwest::Url::parse(&poster)
            .ok()
            .filter(|value| {
                matches!(value.scheme(), "http" | "https")
                    && value.username().is_empty()
                    && value.password().is_none()
            })
            .map(|value| value.to_string())
            .unwrap_or_default()
    };
    Ok(json!({"list": [{
        "vod_id": url.to_string(),
        "vod_name": title,
        "vod_pic": poster,
        "vod_content": meta_content(html, "name", "description"),
        "vod_play_from": "兔小贝",
        "vod_play_url": format!("正片${}", url)
    }]}))
}

fn ygp_classes() -> Vec<Value> {
    vec![json!({
        "type_id": "movlist/",
        "type_name": "预告片世界"
    })]
}

fn ygp_category_path(params: Option<&Value>, page: &str) -> Result<String, LegacyHttpError> {
    let type_id = param_text(params, "typeId").unwrap_or_else(|| "movlist/".to_string());
    let type_id = type_id.trim().trim_end_matches('/');
    if type_id.eq_ignore_ascii_case("movlist") {
        let filter = params.and_then(|value| value.get("filter"));
        let aliases = ["type", "area", "year", "sort"];
        let mut values = Vec::with_capacity(5);
        for index in 0..4 {
            let numeric = index.to_string();
            let value = filter
                .and_then(|value| value.get(&numeric).or_else(|| value.get(aliases[index])))
                .map(value_text)
                .unwrap_or_default();
            values.push(ygp_path_encode(&value));
        }
        values.push(page.trim().parse::<u64>().unwrap_or(1).to_string());
        return Ok(format!("/movlist/{}", values.join("_")));
    }
    if matches!(
        type_id,
        "allmovies" | "later" | "footages" | "netdisk" | "hd" | "nowplaying"
    ) {
        let page = page.trim().parse::<u64>().unwrap_or(1);
        return Ok(if page <= 1 {
            format!("/{type_id}")
        } else {
            format!("/{type_id}/{page}")
        });
    }
    Err(LegacyHttpError::Request("YGP_TYPE_ID_INVALID".to_string()))
}

fn ygp_path_encode(value: &str) -> String {
    let mut url = reqwest::Url::parse("https://example.invalid/").expect("static URL");
    url.query_pairs_mut().append_pair("q", value);
    url.query()
        .and_then(|query| query.strip_prefix("q="))
        .unwrap_or_default()
        .to_string()
}

fn ygp_page_count(html: &str) -> u64 {
    let Some(nav) = elements(html, "p", Some("page-nav")).first().copied() else {
        return 1;
    };
    opening_tags(nav, "a")
        .filter_map(|tag| attribute(tag, "href"))
        .filter_map(|href| {
            href.trim_end_matches('/')
                .rsplit('/')
                .next()
                .and_then(|value| value.parse::<u64>().ok())
        })
        .max()
        .unwrap_or(1)
}

fn ygp_catalog_items(html: &str, base: &reqwest::Url) -> Vec<Value> {
    let mut fragments = Vec::new();
    for section in elements(html, "div", Some("inner-2col-main")) {
        for list in elements(section, "div", Some("movlist")) {
            fragments.extend(elements(list, "li", None));
        }
    }
    if fragments.is_empty() {
        fragments.extend(elements(html, "li", None));
    }
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for fragment in fragments {
        let Some((anchor, href)) = opening_tags(fragment, "a")
            .filter_map(|tag| {
                let href = attribute(tag, "href")?;
                ygp_path_id(&href, "movie").map(|_| (tag, href))
            })
            .next()
        else {
            continue;
        };
        let Ok(url) = ygp_detail_url(base, &href) else {
            continue;
        };
        let id = url.to_string();
        if !seen.insert(id.clone()) {
            continue;
        }
        let title = opening_tags(fragment, "span")
            .find(|tag| has_class(tag, "item-title"))
            .and_then(|tag| attribute(tag, "title"))
            .or_else(|| attribute(anchor, "title"))
            .unwrap_or_else(|| text(item_fragment(fragment, anchor)));
        if title.trim().is_empty() {
            continue;
        }
        let image = opening_tags(fragment, "img")
            .next()
            .and_then(|tag| attribute(tag, "src"))
            .and_then(|value| resolve_http_url(base, &value).ok())
            .map(|value| value.to_string())
            .unwrap_or_default();
        let remarks = opening_tags(fragment, "span")
            .find(|tag| has_class(tag, "item-pubtime"))
            .map(text)
            .unwrap_or_default();
        result.push(json!({
            "vod_id": id,
            "vod_name": title.trim(),
            "vod_pic": image,
            "vod_remarks": remarks,
            "type_name": "预告片世界"
        }));
    }
    result
}

fn ygp_path_id(value: &str, section: &str) -> Option<String> {
    let path = reqwest::Url::parse(value)
        .ok()
        .map(|url| url.path().to_string())
        .unwrap_or_else(|| value.split('?').next().unwrap_or(value).to_string());
    let mut parts = path.trim_matches('/').split('/');
    if parts.next()? != section {
        return None;
    }
    let id = parts.next()?.trim();
    if parts.next().is_some() || id.is_empty() || !id.bytes().all(|value| value.is_ascii_digit()) {
        return None;
    }
    Some(id.to_string())
}

fn ygp_detail_url(base: &reqwest::Url, value: &str) -> Result<reqwest::Url, LegacyHttpError> {
    let url = resolve_http_url(base, value)?;
    if !url
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("www.6huo.com"))
        || ygp_path_id(url.path(), "movie").is_none()
    {
        return Err(LegacyHttpError::Request(
            "YGP_DETAIL_URL_INVALID".to_string(),
        ));
    }
    Ok(url)
}

fn ygp_show_url(base: &reqwest::Url, value: &str) -> Result<reqwest::Url, LegacyHttpError> {
    let url = resolve_http_url(base, value.trim())?;
    if !url
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("www.6huo.com"))
        || ygp_path_id(url.path(), "show").is_none()
    {
        return Err(LegacyHttpError::Request(
            "YGP_PLAYER_URL_INVALID".to_string(),
        ));
    }
    Ok(url)
}

fn ygp_detail(html: &str, url: &reqwest::Url) -> Result<Value, String> {
    let title = elements(html, "h1", Some("movie-name"))
        .first()
        .and_then(|value| attribute(value, "title"))
        .or_else(|| {
            elements(html, "h1", Some("movie-name"))
                .first()
                .map(|value| text(value))
        })
        .unwrap_or_default();
    if title.trim().is_empty() {
        return Err("YGP_DETAIL_TITLE_MISSING".to_string());
    }
    let base = fixed_base(YGP_BASE).map_err(|error| format!("{error:?}"))?;
    let poster = elements(html, "div", Some("movie-title-mpic"))
        .first()
        .and_then(|value| opening_tags(value, "img").next())
        .and_then(|tag| attribute(tag, "src"))
        .and_then(|value| resolve_http_url(&base, &value).ok())
        .map(|value| value.to_string())
        .unwrap_or_default();
    let detail_text = elements(html, "div", Some("movie-title-detail"))
        .first()
        .map(|value| text(value))
        .unwrap_or_default();
    let type_name = elements(html, "div", Some("movie-title-detail"))
        .first()
        .map(|value| {
            opening_tags(value, "a")
                .filter_map(|tag| {
                    attribute(tag, "href")
                        .filter(|href| href.contains("/movietype/"))
                        .map(|_| text(item_fragment(value, tag)))
                })
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default();
    let area = elements(html, "div", Some("movie-title-detail"))
        .first()
        .map(|value| {
            opening_tags(value, "a")
                .filter_map(|tag| {
                    attribute(tag, "href")
                        .filter(|href| href.contains("/country/"))
                        .map(|_| text(item_fragment(value, tag)))
                })
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default();
    let year = ygp_between(&detail_text, "上映：", "导演：");
    let director = ygp_between(&detail_text, "导演：", "主演：");
    let actor = ygp_between(&detail_text, "主演：", "剧情：");
    let content = ygp_between(&detail_text, "剧情：", "(详细)");
    let table = elements(html, "table", Some("tlist")).into_iter().next();
    let mut episodes = Vec::new();
    let mut seen = HashSet::new();
    if let Some(table) = table {
        for row in elements(table, "tr", None) {
            for anchor in opening_tags(row, "a").filter(|tag| has_class(tag, "tlist-bbs-tdtitle")) {
                let Some(href) = attribute(anchor, "href") else {
                    continue;
                };
                let Ok(show) = ygp_show_url(&base, &href) else {
                    continue;
                };
                let value = show.to_string();
                if !seen.insert(value.clone()) {
                    continue;
                }
                let name = text(item_fragment(row, anchor));
                if !name.is_empty() {
                    episodes.push(format!("{}${value}", name.trim()));
                }
            }
        }
    }
    Ok(json!({"list": [{
        "vod_id": url.to_string(),
        "vod_name": title.trim(),
        "vod_pic": poster,
        "type_name": type_name,
        "vod_year": year,
        "vod_area": area,
        "vod_actor": actor,
        "vod_director": director,
        "vod_content": content,
        "vod_remarks": if episodes.is_empty() { "".to_string() } else { format!("{}个预告", episodes.len()) },
        "vod_play_from": if episodes.is_empty() { "" } else { "预告片" },
        "vod_play_url": episodes.join("#")
    }]}))
}

fn ygp_between(value: &str, start: &str, end: &str) -> String {
    let Some(start) = value.find(start).map(|offset| offset + start.len()) else {
        return String::new();
    };
    let end = value[start..]
        .find(end)
        .map(|offset| start + offset)
        .unwrap_or(value.len());
    value[start..end].trim().to_string()
}

async fn call_html_catalog(
    kind: LegacyHttpKind,
    method: &str,
    params: Option<&Value>,
    base: reqwest::Url,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    match method {
        "home" => {
            let html = get_text(base.clone(), headers, timeout, cancelled).await?;
            Ok(json!({
                "class": if matches!(kind, LegacyHttpKind::Duopan) {
                    duopan_classes(&html)
                } else {
                    html_classes(kind)
                },
                "list": html_catalog_items(&html, &base, kind)
            }))
        }
        "category" => {
            let type_id = param_text(params, "typeId").unwrap_or_else(|| "1".to_string());
            let page = param_text(params, "page").unwrap_or_else(|| "1".to_string());
            let path = html_category_path(kind, &type_id, &page, params);
            let html = get_text(join_url(&base, &path)?, headers, timeout, cancelled).await?;
            let list = html_catalog_items(&html, &base, kind);
            Ok(
                json!({"page": page.parse::<u64>().unwrap_or(1), "pagecount": 1, "total": list.len(), "list": list}),
            )
        }
        "search" => {
            let key = param_text(params, "key").unwrap_or_default();
            if key.trim().is_empty() {
                return Err(LegacyHttpError::Request(
                    "HTML_SEARCH_KEY_REQUIRED".to_string(),
                ));
            }
            let url = if matches!(kind, LegacyHttpKind::Czsapp) {
                czsapp_search_url(&key)?
            } else {
                join_url(&base, &html_search_path(kind, &key))?
            };
            let html = get_text(url, headers, timeout, cancelled).await?;
            let list = if matches!(kind, LegacyHttpKind::Czsapp) {
                czsapp_search_items(&html, &base)
            } else {
                html_catalog_items(&html, &base, kind)
            };
            Ok(json!({"total": list.len(), "list": list}))
        }
        "detail" => {
            let id = first_id(params)?;
            let url = html_detail_url(kind, &base, &id)?;
            let html = get_text(url.clone(), headers, timeout, cancelled).await?;
            html_catalog_detail(&html, &url, kind).map_err(LegacyHttpError::Request)
        }
        "player" | "playback" => {
            let raw = param_text(params, "id")
                .or_else(|| param_text(params, "url"))
                .unwrap_or_default();
            if let Some(url) = html_media_url(&raw) {
                return Ok(json!({"parse": 0, "jx": 0, "url": url, "header": {}}));
            }
            let page = resolve_http_url(&base, raw.split('|').next().unwrap_or(raw.trim()))?;
            let html = get_text(page, headers, timeout, cancelled).await?;
            let url = if matches!(kind, LegacyHttpKind::Czsapp) {
                extract_czsapp_media(&html)
            } else {
                extract_html_media(&html)
            }
            .ok_or_else(|| {
                LegacyHttpError::Unsupported("HTML_DYNAMIC_PLAYER_UNSUPPORTED".to_string())
            })?;
            Ok(json!({"parse": 0, "jx": 0, "url": url, "header": {}}))
        }
        other => Err(LegacyHttpError::Unsupported(format!(
            "HTML_METHOD_UNAVAILABLE:{other}"
        ))),
    }
}

fn html_classes(kind: LegacyHttpKind) -> Vec<Value> {
    match kind {
        LegacyHttpKind::Wwys => vec![
            json!({"type_id": "1", "type_name": "电影"}),
            json!({"type_id": "2", "type_name": "电视剧"}),
        ],
        LegacyHttpKind::SaoHuo => vec![
            json!({"type_id": "1", "type_name": "电影"}),
            json!({"type_id": "2", "type_name": "电视剧"}),
            json!({"type_id": "20", "type_name": "动漫"}),
            json!({"type_id": "4", "type_name": "综艺"}),
        ],
        LegacyHttpKind::Czsapp => vec![
            json!({"type_id": "movie_bt", "type_name": "全部"}),
            json!({"type_id": "gcj", "type_name": "国产剧"}),
            json!({"type_id": "meijutt", "type_name": "美剧"}),
            json!({"type_id": "fanju", "type_name": "番剧"}),
        ],
        LegacyHttpKind::Duopan => Vec::new(),
        _ => Vec::new(),
    }
}

fn duopan_classes(html: &str) -> Vec<Value> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for tag in opening_tags(html, "a") {
        let Some(href) = attribute(tag, "href") else {
            continue;
        };
        let Some(type_id) = href
            .strip_prefix("/index.php/vod/type/id/")
            .and_then(|value| value.strip_suffix(".html"))
            .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        else {
            continue;
        };
        let name = text(item_fragment(html, tag));
        if name.is_empty() || !seen.insert(type_id.to_string()) {
            continue;
        }
        result.push(json!({"type_id": type_id, "type_name": name}));
    }
    result
}

fn html_category_path(
    kind: LegacyHttpKind,
    type_id: &str,
    page: &str,
    params: Option<&Value>,
) -> String {
    match kind {
        LegacyHttpKind::Wwys => format!(
            "/vod-list-id-{type_id}-pg-{page}-order--by-time-class-0-year-0-letter--area--lang-.html"
        ),
        LegacyHttpKind::SaoHuo => format!("/list/{type_id}-{page}.html"),
        LegacyHttpKind::Czsapp => match type_id {
            "1" | "movie_bt" | "all" => format!("/movie_bt/page/{page}"),
            "2" | "gcj" => format!("/gcj/page/{page}"),
            "3" | "meijutt" => format!("/meijutt/page/{page}"),
            "4" | "fanju" => format!("/fanju/page/{page}"),
            "hanjutv" => format!("/hanjutv/page/{page}"),
            _ => format!("/movie_bt/page/{page}"),
        },
        LegacyHttpKind::Duopan => {
            // The public Duopan/Netfixtv mirrors expose MacCMS `type`, not
            // the older `show` route. Keep the path fixed and ignore filters
            // that are not part of this stable public contract.
            let _ = params;
            if page == "1" {
                format!("/index.php/vod/type/id/{type_id}.html")
            } else {
                format!("/index.php/vod/type/id/{type_id}/page/{page}.html")
            }
        }
        _ => "/".to_string(),
    }
}

fn html_search_path(kind: LegacyHttpKind, key: &str) -> String {
    match kind {
        LegacyHttpKind::Wwys | LegacyHttpKind::Czsapp => {
            let mut url = reqwest::Url::parse("https://example.invalid/").expect("static URL");
            url.query_pairs_mut().append_pair("wd", key);
            let query = url.query().unwrap_or_default();
            if matches!(kind, LegacyHttpKind::Czsapp) {
                format!("/czzysearch.php?{query}")
            } else {
                format!("/index.php?m=vod-search&{query}")
            }
        }
        LegacyHttpKind::SaoHuo => {
            let mut url = reqwest::Url::parse("https://example.invalid/").expect("static URL");
            url.query_pairs_mut().append_pair("wd", key);
            format!("/s----------.html?{}", url.query().unwrap_or_default())
        }
        LegacyHttpKind::Duopan => format!("/index.php/vod/search/wd/{}.html", url_encode(key)),
        _ => "/".to_string(),
    }
}

fn czsapp_search_url(key: &str) -> Result<reqwest::Url, LegacyHttpError> {
    let mut url = fixed_base(CZSAPP_SEARCH_ENDPOINT)?;
    url.query_pairs_mut().append_pair("wd", key);
    Ok(url)
}

fn czsapp_search_items(body: &str, base: &reqwest::Url) -> Vec<Value> {
    body.split("$$$")
        .filter_map(|entry| {
            let fields = entry.split('|').collect::<Vec<_>>();
            if fields.len() < 4 {
                return None;
            }
            let id = fields[0].trim();
            let name = fields[1].trim();
            if id.is_empty() || name.is_empty() {
                return None;
            }
            let detail = resolve_http_url(base, &format!("/movie/{id}.html")).ok()?;
            Some(json!({
                "vod_id": detail.to_string(),
                "vod_name": name,
                "vod_pic": fields[2].trim(),
                "vod_remarks": ""
            }))
        })
        .collect()
}

fn html_detail_url(
    kind: LegacyHttpKind,
    base: &reqwest::Url,
    id: &str,
) -> Result<reqwest::Url, LegacyHttpError> {
    let id = id.trim();
    if matches!(kind, LegacyHttpKind::Wwys)
        && !id.starts_with("http://")
        && !id.starts_with("https://")
        && !id.starts_with('/')
    {
        return resolve_http_url(base, &format!("/vod-detail-id-{id}.html"));
    }
    resolve_http_url(base, id)
}

fn html_catalog_items(html: &str, base: &reqwest::Url, kind: LegacyHttpKind) -> Vec<Value> {
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut fragments = match kind {
        LegacyHttpKind::Duopan => elements(html, "div", Some("module-item")),
        _ => elements(html, "li", None),
    };
    if fragments.is_empty() {
        fragments.extend(elements(html, "div", Some("module-item")));
    }
    if matches!(kind, LegacyHttpKind::Duopan) {
        fragments.extend(elements(html, "div", Some("module-search-item")));
    }
    for fragment in fragments {
        let anchors = opening_tags(fragment, "a")
            .filter_map(|tag| {
                let href = attribute(tag, "href")?;
                let href = href.trim();
                if href.is_empty() || href.starts_with('#') {
                    return None;
                }
                let name = attribute(tag, "title")
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| text(item_fragment(fragment, tag)));
                (!name.is_empty()).then(|| (tag, href.to_string(), name))
            })
            .collect::<Vec<_>>();
        let selected = if matches!(kind, LegacyHttpKind::Duopan) {
            anchors
                .iter()
                .find(|(_, _, name)| !duopan_play_action_title(name))
                .or_else(|| anchors.first())
        } else {
            anchors.first()
        };
        let Some((_anchor, href, name)) = selected else {
            continue;
        };
        let Ok(url) = resolve_http_url(base, &href) else {
            continue;
        };
        if matches!(kind, LegacyHttpKind::Czsapp)
            && !url.path().trim_start_matches('/').starts_with("movie/")
        {
            continue;
        }
        let id = url.to_string();
        if !seen.insert(id.clone()) {
            continue;
        }
        let image = if matches!(kind, LegacyHttpKind::Czsapp) {
            opening_tags(fragment, "img")
                .find_map(|tag| {
                    ["data-original", "data-src", "src"]
                        .into_iter()
                        .filter_map(|name| attribute(tag, name))
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                        .find_map(|value| resolve_http_url(base, &value).ok())
                        .map(|value| value.to_string())
                })
                .unwrap_or_default()
        } else {
            opening_tags(fragment, "img")
                .next()
                .and_then(|tag| {
                    attribute(tag, "data-original")
                        .or_else(|| attribute(tag, "data-src"))
                        .or_else(|| attribute(tag, "src"))
                })
                .and_then(|value| resolve_http_url(base, &value).ok())
                .map(|value| value.to_string())
                .unwrap_or_default()
        };
        if name.is_empty() {
            continue;
        }
        result.push(json!({"vod_id": id, "vod_name": name, "vod_pic": image, "vod_remarks": ""}));
    }
    result
}

fn duopan_play_action_title(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    value.starts_with("立刻播放") || value.starts_with("立即播放")
}

fn html_catalog_detail(
    html: &str,
    url: &reqwest::Url,
    kind: LegacyHttpKind,
) -> Result<Value, String> {
    let name = [
        elements(html, "h1", None).first().map(|value| text(value)),
        elements(html, "div", Some("page-title"))
            .first()
            .map(|value| text(value)),
        elements(html, "div", Some("title"))
            .first()
            .map(|value| text(value)),
    ]
    .into_iter()
    .flatten()
    .find(|value| !value.is_empty())
    .unwrap_or_default();
    if name.is_empty() {
        return Err("HTML_DETAIL_TITLE_MISSING".to_string());
    }
    let mut episodes = if matches!(kind, LegacyHttpKind::Duopan) {
        duopan_share_links(html)
            .into_iter()
            .enumerate()
            .map(|(index, link)| format!("分享{}${link}", index + 1))
            .collect::<Vec<_>>()
    } else {
        let mut values = Vec::new();
        for anchor in elements(html, "a", None) {
            let Some(href) = attribute(anchor, "href") else {
                continue;
            };
            let name = text(anchor);
            if name.is_empty() || href.starts_with('#') {
                continue;
            }
            if href.contains("play") || href.contains("vod-play") || html_media_url(&href).is_some()
            {
                values.push(format!("{}${}", name, href));
            }
        }
        values
    };
    episodes.sort();
    episodes.dedup();
    let poster = if matches!(kind, LegacyHttpKind::Czsapp) {
        elements(html, "div", Some("dyimg"))
            .into_iter()
            .find_map(|fragment| {
                opening_tags(fragment, "img").find_map(|tag| {
                    ["data-original", "data-src", "src"]
                        .into_iter()
                        .filter_map(|name| attribute(tag, name))
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                        .find_map(|value| resolve_http_url(url, &value).ok())
                        .map(|value| value.to_string())
                })
            })
            .unwrap_or_default()
    } else {
        opening_tags(html, "img")
            .next()
            .and_then(|tag| {
                attribute(tag, "data-original")
                    .or_else(|| attribute(tag, "data-src"))
                    .or_else(|| attribute(tag, "src"))
            })
            .unwrap_or_default()
    };
    Ok(json!({"list": [{
        "vod_id": url.to_string(),
        "vod_name": name,
        "vod_pic": poster,
        "vod_content": meta_content(html, "property", "og:description"),
        "vod_play_from": if episodes.is_empty() { "" } else if matches!(kind, LegacyHttpKind::Duopan) { "网盘" } else { "默认" },
        "vod_play_url": episodes.join("#")
    }]}))
}

fn duopan_share_links(html: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for tag in opening_tags(html, "a").filter(|tag| has_class(tag, "module-row-text")) {
        let Some(value) = attribute(tag, "data-clipboard-text") else {
            continue;
        };
        let Ok(url) = reqwest::Url::parse(value.trim()) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            continue;
        }
        let value = url.to_string();
        if seen.insert(value.clone()) {
            result.push(value);
        }
    }
    result
}

fn extract_html_media(html: &str) -> Option<String> {
    for tag in opening_tags(html, "video").chain(opening_tags(html, "source")) {
        if let Some(url) = attribute(tag, "src").and_then(|value| html_media_url(&value)) {
            return Some(url);
        }
    }
    for tag in opening_tags(html, "iframe") {
        if let Some(url) = attribute(tag, "src").and_then(|value| html_media_url(&value)) {
            return Some(url);
        }
    }
    for script in opening_tags(html, "script") {
        let body = script_body(html, script).unwrap_or_default();
        for token in body.split(['\"', '\'', ' ', '\n', '\r', ',']) {
            if let Some(url) = html_media_url(token) {
                return Some(url);
            }
        }
    }
    None
}

fn extract_czsapp_media(html: &str) -> Option<String> {
    for tag in opening_tags(html, "iframe") {
        let Some(src) = attribute(tag, "src") else {
            continue;
        };
        if let Some(url) = html_media_url(&src) {
            return Some(url);
        }
        let Ok(player) = reqwest::Url::parse(src.trim()) else {
            continue;
        };
        if !matches!(player.scheme(), "http" | "https")
            || player.username() != ""
            || player.password().is_some()
        {
            continue;
        }
        for key in ["url", "src", "file"] {
            if let Some(value) = player
                .query_pairs()
                .find(|(name, _)| name.eq_ignore_ascii_case(key))
                .map(|(_, value)| value.into_owned())
            {
                if let Some(url) = html_media_url(&value) {
                    return Some(url);
                }
            }
        }
    }
    extract_html_media(html)
}

fn html_media_url(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let path = url.path().to_ascii_lowercase();
    [".m3u8", ".mp4", ".mkv", ".webm", ".mov"]
        .iter()
        .any(|suffix| path.ends_with(suffix))
        .then_some(url.to_string())
}

fn configured_html_base(default: &str, ext: &str) -> Result<reqwest::Url, LegacyHttpError> {
    let raw = ext.trim();
    let value = if raw.starts_with('{') {
        let object: Value = serde_json::from_str(raw)
            .map_err(|error| LegacyHttpError::Request(format!("HTML_EXT_JSON_INVALID:{error}")))?;
        object
            .get("site_urls")
            .and_then(Value::as_array)
            .and_then(|values| values.iter().find_map(Value::as_str))
            .or_else(|| object.get("site").and_then(Value::as_str))
            .or_else(|| object.get("url").and_then(Value::as_str))
            .unwrap_or(default)
            .to_string()
    } else if raw.is_empty() {
        default.to_string()
    } else {
        raw.to_string()
    };
    if value.is_empty() {
        return Err(LegacyHttpError::Request(
            "HTML_BASE_URL_REQUIRED".to_string(),
        ));
    }
    fixed_base(&value).and_then(|url| {
        if matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
        {
            Ok(url)
        } else {
            Err(LegacyHttpError::Request(
                "HTML_BASE_URL_INVALID".to_string(),
            ))
        }
    })
}

fn configured_html_bases(default: &str, ext: &str) -> Result<Vec<reqwest::Url>, LegacyHttpError> {
    let raw = ext.trim();
    if !raw.starts_with('{') {
        return configured_html_base(default, ext).map(|base| vec![base]);
    }
    let object: Value = serde_json::from_str(raw)
        .map_err(|error| LegacyHttpError::Request(format!("HTML_EXT_JSON_INVALID:{error}")))?;
    let mut bases = Vec::new();
    let mut seen = HashSet::new();
    let mut first_error = None;
    if let Some(values) = object.get("site_urls").and_then(Value::as_array) {
        for value in values.iter().filter_map(Value::as_str) {
            match configured_html_base("", value) {
                Ok(base) if seen.insert(base.as_str().to_string()) => bases.push(base),
                Ok(_) => {}
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
    }
    if !bases.is_empty() {
        return Ok(bases);
    }
    match configured_html_base(default, ext) {
        Ok(base) => Ok(vec![base]),
        Err(error) => Err(first_error.unwrap_or(error)),
    }
}

async fn call_pansearch(
    method: &str,
    params: Option<&Value>,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    if method != "search" {
        return Err(LegacyHttpError::Unsupported(format!(
            "PANSEARCH_METHOD_UNAVAILABLE:{method}"
        )));
    }
    let key = param_string(params, "key").unwrap_or_default();
    if key.trim().is_empty() {
        return Err(LegacyHttpError::Request(
            "PANSEARCH_SEARCH_KEY_REQUIRED".to_string(),
        ));
    }
    let base = fixed_base("https://www.pansearch.me")?;
    let home = get_text(base.clone(), headers, timeout, cancelled.clone()).await?;
    let next_data = opening_tags(&home, "script")
        .find(|tag| attribute(tag, "id").as_deref() == Some("__NEXT_DATA__"))
        .map(|tag| script_body(&home, tag))
        .flatten()
        .ok_or_else(|| LegacyHttpError::Request("PANSEARCH_NEXT_DATA_MISSING".to_string()))?;
    let metadata: Value = serde_json::from_str(&next_data).map_err(|error| {
        LegacyHttpError::Request(format!("PANSEARCH_NEXT_DATA_INVALID:{error}"))
    })?;
    let build_id = metadata
        .get("buildId")
        .and_then(Value::as_str)
        .ok_or_else(|| LegacyHttpError::Request("PANSEARCH_BUILD_ID_MISSING".to_string()))?;
    let mut result = Vec::new();
    for pan in ["quark", "aliyundrive"] {
        let mut url = join_url(&base, &format!("/_next/data/{build_id}/search.json"))?;
        url.query_pairs_mut().append_pair("keyword", &key);
        url.query_pairs_mut().append_pair("pan", pan);
        let mut request_headers = headers.clone();
        insert_default_header(&mut request_headers, "x-nextjs-data", "1")?;
        insert_default_header(&mut request_headers, "referer", "https://www.pansearch.me/")?;
        let value = get_json(url, &request_headers, timeout, cancelled.clone()).await?;
        let items = value
            .pointer("/pageProps/data/data")
            .and_then(Value::as_array)
            .ok_or_else(|| LegacyHttpError::Request("PANSEARCH_RESULT_MISSING".to_string()))?;
        for item in items {
            let content = item
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let Some(anchor) = opening_tags(content, "a").next() else {
                continue;
            };
            let Some(id) =
                attribute(anchor, "href").and_then(|href| pansearch_result_url(&base, &href))
            else {
                continue;
            };
            let title = text(content)
                .lines()
                .next()
                .unwrap_or_default()
                .trim()
                .to_string();
            if title.is_empty() {
                continue;
            }
            result.push(json!({
                "vod_id": id,
                "vod_name": title,
                "vod_pic": item
                    .get("image")
                    .and_then(Value::as_str)
                    .and_then(|image| pansearch_result_url(&base, image))
                    .unwrap_or_default(),
                "vod_remarks": item.get("time").and_then(Value::as_str).unwrap_or_default()
            }));
        }
    }
    Ok(json!({"list": result, "total": result.len()}))
}

fn pansearch_result_url(base: &reqwest::Url, value: &str) -> Option<String> {
    resolve_http_url(base, value)
        .ok()
        .map(|url| url.to_string())
}

fn dm84_home(html: &str) -> Value {
    let mut classes = Vec::new();
    let mut seen = HashSet::new();
    for tag in opening_tags(html, "a") {
        let Some(href) = attribute(tag, "href") else {
            continue;
        };
        if !href.starts_with("/list-") {
            continue;
        }
        let Some(id) = href
            .split('-')
            .nth(1)
            .and_then(|value| value.chars().next())
        else {
            continue;
        };
        let id = id.to_string();
        if seen.insert(id.clone()) {
            classes.push(json!({
                "type_id": id,
                "type_name": text(item_fragment(html, tag))
            }));
        }
    }
    json!({"class": classes, "list": []})
}

fn dm84_detail_url(base: &reqwest::Url, id: &str) -> Result<reqwest::Url, LegacyHttpError> {
    if id.starts_with("http://") || id.starts_with("https://") {
        return resolve_http_url(base, id);
    }
    resolve_http_url(base, &format!("/v/{id}"))
}

fn dm84_items(html: &str, base: &reqwest::Url) -> Vec<Value> {
    elements(html, "div", Some("item"))
        .into_iter()
        .filter_map(|item| {
            let cover = opening_tags(item, "a").find(|tag| has_class(tag, "cover"));
            let title = opening_tags(item, "a").find(|tag| has_class(tag, "title"));
            let title = title?;
            let href = attribute(title, "href")?;
            let id = href.split('/').nth(2).unwrap_or_default();
            if id.is_empty() {
                return None;
            }
            Some(json!({
                "vod_id": id,
                "vod_name": text(item_fragment(item, title)),
                "vod_pic": cover.and_then(|tag| attribute(tag, "data-bg")).and_then(|value| resolve_http_url(base, &value).ok()).map(|value| value.to_string()).unwrap_or_default(),
                "vod_remarks": elements(item, "span", Some("desc")).first().map(|value| text(value)).unwrap_or_default()
            }))
        })
        .collect()
}

fn dm84_detail(html: &str, url: &reqwest::Url) -> Result<Value, String> {
    let name = elements(html, "h1", Some("v_title"))
        .first()
        .map(|value| text(value))
        .unwrap_or_default();
    if name.is_empty() {
        return Err("DM84_DETAIL_TITLE_MISSING".to_string());
    }
    let tabs = elements(html, "ul", Some("tab_control"))
        .first()
        .map(|value| elements(value, "li", None))
        .unwrap_or_default();
    let lists = elements(html, "ul", Some("play_list"));
    let mut from = Vec::new();
    let mut urls = Vec::new();
    for (index, list) in lists.iter().enumerate() {
        let items = opening_tags(list, "a")
            .filter_map(|tag| {
                Some(format!(
                    "{}${}",
                    text(item_fragment(list, tag)),
                    attribute(tag, "href")?
                ))
            })
            .collect::<Vec<_>>();
        if items.is_empty() {
            continue;
        }
        let label = tabs
            .get(index)
            .map(|value| text(value))
            .unwrap_or_else(|| format!("线路{}", index + 1));
        from.push(label);
        urls.push(items.join("#"));
    }
    let vod = json!({
        "vod_id": url.to_string(),
        "vod_name": name,
        "vod_pic": meta_content(html, "property", "og:image"),
        "vod_year": meta_content(html, "name", "og:video:release_date"),
        "vod_area": meta_content(html, "name", "og:video:area"),
        "vod_actor": meta_content(html, "name", "og:video:actor"),
        "vod_director": meta_content(html, "name", "og:video:director"),
        "vod_remarks": elements(html, "span", Some("desc")).first().map(|value| text(value)).unwrap_or_default(),
        "vod_content": meta_content(html, "property", "og:description"),
        "type_name": meta_content(html, "name", "og:video:class"),
        "vod_play_from": from.join("$$$"),
        "vod_play_url": urls.join("$$$")
    });
    Ok(json!({"list": [vod]}))
}

fn kugou_category_items(html: &str, sidebar: usize) -> Vec<Value> {
    let current_items = elements(html, "div", Some("pc_temp_songlist"))
        .into_iter()
        .flat_map(|section| {
            opening_tags(section, "a")
                .filter(|tag| has_class(tag, "pc_temp_songname"))
                .filter_map(|tag| {
                    let id = attribute(tag, "href")?;
                    let name = attribute(tag, "title")
                        .unwrap_or_else(|| text(item_fragment(section, tag)));
                    Some(json!({"vod_id": id, "vod_name": name}))
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    if !current_items.is_empty() {
        return current_items;
    }
    elements(html, "div", Some("pc_rank_sidebar"))
        .get(sidebar)
        .map(|section| {
            opening_tags(section, "a")
                .filter_map(|tag| {
                    let id = attribute(tag, "href")?;
                    if !id.starts_with("http://") && !id.starts_with("https://") {
                        return None;
                    }
                    let name = attribute(tag, "title").unwrap_or_else(|| text(tag));
                    (!id.is_empty() && !name.is_empty())
                        .then(|| json!({"vod_id": id, "vod_name": name}))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn kugou_detail(html: &str, url: &reqwest::Url) -> Result<Value, String> {
    let items = elements(html, "li", Some("pc_temp_songlist"))
        .into_iter()
        .flat_map(|list| {
            opening_tags(list, "a")
                .filter(|tag| has_class(tag, "pc_temp_songname"))
                .filter_map(|tag| {
                    Some(format!(
                        "{}${}",
                        text(item_fragment(list, tag)),
                        attribute(tag, "href")?
                    ))
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let items = if items.is_empty() {
        elements(html, "ul", Some("pc_temp_songlist"))
            .into_iter()
            .flat_map(|list| {
                opening_tags(list, "a")
                    .filter(|tag| has_class(tag, "pc_temp_songname"))
                    .filter_map(|tag| {
                        Some(format!(
                            "{}${}",
                            text(item_fragment(list, tag)),
                            attribute(tag, "href")?
                        ))
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
    } else {
        items
    };
    if items.is_empty() {
        return kugou_single_detail(html, url);
    }
    Ok(json!({"list": [{
        "vod_id": url.to_string(),
        "vod_name": elements(html, "div", Some("pc_temp_title")).first().map(|value| text(value)).unwrap_or_default(),
        "vod_remarks": elements(html, "span", Some("rank_update")).first().map(|value| text(value)).unwrap_or_default(),
        "vod_play_from": "Qile",
        "vod_play_url": items.join("#")
    }]}))
}

fn kugou_single_detail(html: &str, url: &reqwest::Url) -> Result<Value, String> {
    let marker = "var dataFromSmarty = ";
    let start = html
        .find(marker)
        .map(|offset| offset + marker.len())
        .ok_or_else(|| "KUGOU_DETAIL_METADATA_MISSING".to_string())?;
    let end = html[start..]
        .find("],")
        .map(|offset| start + offset + 1)
        .ok_or_else(|| "KUGOU_DETAIL_METADATA_INVALID".to_string())?;
    let metadata: Value = serde_json::from_str(&html[start..end])
        .map_err(|error| format!("KUGOU_DETAIL_METADATA_INVALID:{error}"))?;
    let song = metadata
        .as_array()
        .and_then(|items| items.first())
        .ok_or_else(|| "KUGOU_DETAIL_SONG_MISSING".to_string())?;
    let name = song
        .get("song_name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if name.is_empty() {
        return Err("KUGOU_DETAIL_TITLE_MISSING".to_string());
    }
    Ok(json!({"list": [{
        "vod_id": url.to_string(),
        "vod_name": name,
        "vod_actor": song.get("author_name").and_then(Value::as_str).unwrap_or_default(),
        "vod_remarks": "Kugou",
        "vod_play_from": "Kugou",
        "vod_play_url": ""
    }]}))
}

fn fixed_base(value: &str) -> Result<reqwest::Url, LegacyHttpError> {
    reqwest::Url::parse(value)
        .map_err(|error| LegacyHttpError::Request(format!("URL_INVALID:{error}")))
}

fn configurable_base(default: &str, ext: &str) -> Result<reqwest::Url, LegacyHttpError> {
    let value = if ext.trim().is_empty() {
        default
    } else {
        ext.trim()
    };
    let url = fixed_base(value)?;
    if !matches!(url.scheme(), "http" | "https") || url.username() != "" || url.password().is_some()
    {
        return Err(LegacyHttpError::Request(
            "SOURCE_BASE_URL_INVALID".to_string(),
        ));
    }
    Ok(url)
}

fn join_url(base: &reqwest::Url, path: &str) -> Result<reqwest::Url, LegacyHttpError> {
    base.join(path)
        .map_err(|error| LegacyHttpError::Request(format!("URL_JOIN_INVALID:{error}")))
}

fn resolve_http_url(base: &reqwest::Url, value: &str) -> Result<reqwest::Url, LegacyHttpError> {
    let url = base
        .join(value.trim())
        .map_err(|error| LegacyHttpError::Request(format!("URL_INVALID:{error}")))?;
    if !matches!(url.scheme(), "http" | "https") || url.username() != "" || url.password().is_some()
    {
        return Err(LegacyHttpError::Request(
            "SOURCE_PLAYBACK_URL_INVALID".to_string(),
        ));
    }
    Ok(url)
}

async fn get_text(
    url: reqwest::Url,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<String, LegacyHttpError> {
    let mut request_headers = headers.clone();
    insert_default_header(&mut request_headers, "user-agent", DEFAULT_UA)?;
    let mut client_builder = reqwest::Client::builder()
        .default_headers(request_headers)
        .http1_only()
        .timeout(timeout);
    if should_bypass_proxy_for_legacy_url(&url) {
        client_builder = client_builder.no_proxy();
    }
    let client = client_builder
        .build()
        .map_err(|error| LegacyHttpError::Request(error.to_string()))?;
    let response = tokio::select! {
        result = client.get(url).send() => result.map_err(|error| LegacyHttpError::Request(error.to_string()))?,
        _ = wait_for_cancel(cancelled.clone()) => return Err(LegacyHttpError::Request("SOURCE_REQUEST_CANCELLED".to_string())),
    };
    let status = response.status();
    let bytes = tokio::select! {
        result = read_bounded_response(response) => result.map_err(|error| {
            LegacyHttpError::Request(error.message("SOURCE_RESPONSE_TOO_LARGE"))
        })?,
        _ = wait_for_cancel(cancelled) => return Err(LegacyHttpError::Request("SOURCE_REQUEST_CANCELLED".to_string())),
    };
    if !status.is_success() {
        return Err(LegacyHttpError::Request(format!(
            "SOURCE_HTTP_STATUS:{status}"
        )));
    }
    Ok(String::from_utf8_lossy(&bytes)
        .trim_start_matches('\u{feff}')
        .to_string())
}

fn should_bypass_proxy_for_legacy_url(url: &reqwest::Url) -> bool {
    url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    })
}

async fn get_json(
    url: reqwest::Url,
    headers: &HeaderMap,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, LegacyHttpError> {
    let body = get_text(url, headers, timeout, cancelled).await?;
    serde_json::from_str(&body)
        .map_err(|error| LegacyHttpError::Request(format!("SOURCE_JSON_INVALID:{error}")))
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

fn insert_default_header(
    headers: &mut HeaderMap,
    name: &'static str,
    value: &'static str,
) -> Result<(), LegacyHttpError> {
    if !headers.contains_key(name) {
        headers.insert(
            HeaderName::from_static(name),
            HeaderValue::from_static(value),
        );
    }
    Ok(())
}

fn param_string(params: Option<&Value>, name: &str) -> Option<String> {
    params?
        .get(name)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn param_text(params: Option<&Value>, name: &str) -> Option<String> {
    params?
        .get(name)
        .map(value_text)
        .filter(|value| !value.trim().is_empty())
}

fn first_id(params: Option<&Value>) -> Result<String, LegacyHttpError> {
    params
        .and_then(|value| value.get("ids"))
        .and_then(Value::as_array)
        .and_then(|ids| ids.first())
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| LegacyHttpError::Request("SOURCE_ID_REQUIRED".to_string()))
}

fn filter_string(filter: Option<&Value>, name: &str) -> Option<String> {
    filter?
        .get(name)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn url_encode(value: &str) -> String {
    let mut url = reqwest::Url::parse("https://example.invalid/").expect("static URL");
    url.query_pairs_mut().append_pair("q", value);
    url.query_pairs()
        .next()
        .map(|(_, value)| value.to_string())
        .unwrap_or_default()
}

fn meta_content(html: &str, key: &str, expected: &str) -> String {
    opening_tags(html, "meta")
        .find(|tag| attribute(tag, key).as_deref() == Some(expected))
        .and_then(|tag| attribute(tag, "content"))
        .unwrap_or_default()
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
    let mut result = Vec::new();
    let mut cursor = 0;
    while let Some((start, end, _)) = next_opening_tag(html, cursor, tag) {
        result.push(&html[start..end]);
        cursor = end;
    }
    result.into_iter()
}

fn next_opening_tag<'a>(
    html: &'a str,
    mut cursor: usize,
    wanted: &str,
) -> Option<(usize, usize, &'a str)> {
    while let Some(relative) = html[cursor..].find('<') {
        let start = cursor + relative;
        let end = html[start..].find('>')? + start + 1;
        let raw = &html[start..end];
        let name = tag_name(raw)?;
        if name.eq_ignore_ascii_case(wanted)
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
        if tag_name(raw).is_some_and(|value| value.eq_ignore_ascii_case(tag)) {
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
        let before_ok = start == 0 || !is_html_attribute_name_byte(lower.as_bytes()[start - 1]);
        let after_name = start + name.len();
        let after_ok =
            after_name >= lower.len() || !is_html_attribute_name_byte(lower.as_bytes()[after_name]);
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

fn is_html_attribute_name_byte(value: u8) -> bool {
    value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_' | b':')
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

fn item_fragment<'a>(item: &'a str, opening: &str) -> &'a str {
    let offset = opening.as_ptr() as usize - item.as_ptr() as usize;
    let start = offset.min(item.len());
    let rest = &item[start..];
    let end = matching_end(rest, 0, opening.len(), "a").unwrap_or(rest.len());
    &rest[..end]
}

fn script_body<'a>(html: &'a str, opening: &str) -> Option<String> {
    let start = opening.as_ptr() as usize - html.as_ptr() as usize + opening.len();
    let end = html[start..].find("</script>")? + start;
    Some(html[start..end].trim().to_string())
}

fn element_fragment<'a>(html: &'a str, opening: &str) -> &'a str {
    let offset = opening.as_ptr() as usize - html.as_ptr() as usize;
    if offset >= html.len() {
        return "";
    }
    let tag = tag_name(opening).unwrap_or_default();
    let end = matching_end(html, offset, offset + opening.len(), &tag).unwrap_or(html.len());
    &html[offset..end]
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use std::collections::HashMap;
    use std::sync::{atomic::AtomicBool, Arc};
    use std::time::Duration;

    use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::super::test_support::bind_loopback_tcp;

    use super::{
        apprj_detail, apprj_episode_fields, apprj_home, apprj_list, apprj_parser_request_url,
        apprj_parser_response, call, capabilities, configured_html_base, configured_html_bases,
        czsapp_search_items, czsapp_search_url, dm84_detail, dm84_discovered_bases_from_html,
        dm84_home, dm84_items, duopan_classes, extract_czsapp_media, extract_html_media,
        fixed_base, get_text, guazi_decrypt_text, guazi_detail, guazi_encrypt_text, guazi_home,
        guazi_items, guazi_media_url, guazi_player, gz360_decrypt_text, gz360_detail,
        gz360_encrypt_text, gz360_home, gz360_items, gz360_media_url, gz360_player,
        html_catalog_detail, html_catalog_items, html_category_path, html_detail_url,
        html_search_path, is_retryable_czsapp_error, jpys_detail, jpys_signature,
        kanqiu_category_items, kanqiu_detail, kanqiu_home, kanqiu_player_url, kind,
        kugou_category_items, kugou_detail, md5_hex, pansearch_result_url, read_bounded_response,
        saohuo_discovered_bases, should_bypass_proxy_for_legacy_url, sp360_category_items,
        sp360_detail, sp360_parse_jsonp, sp360_player, sp360_rank_items, sp360_source_id,
        tuxiaobei_detail, tuxiaobei_detail_url, tuxiaobei_html_items, tuxiaobei_json_items,
        tuxiaobei_parse_jsonp, tuxiaobei_search_url, tuxiaobei_video_url, unix_epoch_seconds,
        wait_for_cancel, ygp_catalog_items, ygp_category_path, ygp_detail, ygp_detail_url,
        ygp_show_url, LegacyHttpError, LegacyHttpKind, GUAZI_PLAYER_REFERER, GUAZI_PLAYER_UA,
        GZ360_REFERER, GZ360_UA, SP360_REFERER, SP360_UA, TUXIAOBEI_BASE, TUXIAOBEI_UA, YGP_BASE,
        YGP_UA,
    };

    #[tokio::test]
    async fn html_catalog_player_returns_only_explicit_page_media() {
        let listener = bind_loopback_tcp().await.expect("HTML fixture listener");
        let address = listener.local_addr().expect("HTML fixture address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("HTML fixture request");
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).await.expect("HTML fixture read");
            let body = br#"<html><video src="https://media.test/episode.m3u8"></video></html>"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("HTML fixture headers");
            socket.write_all(body).await.expect("HTML fixture body");
        });
        let result = super::call_html_catalog(
            LegacyHttpKind::Wwys,
            "player",
            Some(&json!({"id": "/play/1"})),
            reqwest::Url::parse(&format!("http://{address}/")).expect("HTML fixture URL"),
            &HeaderMap::new(),
            Duration::from_secs(2),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("HTML player contract");
        assert_eq!(result["parse"], 0);
        assert_eq!(result["url"], "https://media.test/episode.m3u8");
        server.await.expect("HTML fixture completes");
    }

    #[tokio::test]
    async fn czsapp_retries_one_transient_page_failure() {
        let listener = bind_loopback_tcp().await.expect("Czsapp fixture listener");
        let address = listener.local_addr().expect("Czsapp fixture address");
        let server = tokio::spawn(async move {
            for attempt in 0..2 {
                let (mut socket, _) = listener.accept().await.expect("Czsapp fixture request");
                let mut request = [0_u8; 2048];
                let _ = socket
                    .read(&mut request)
                    .await
                    .expect("Czsapp fixture read");
                let (status, body) = if attempt == 0 {
                    ("503 Service Unavailable", "")
                } else {
                    (
                        "200 OK",
                        r#"<li><a href="/movie/42.html" title="片名"><img src="/poster.jpg"></a></li>"#,
                    )
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket
                    .write_all(response.as_bytes())
                    .await
                    .expect("Czsapp fixture response");
            }
        });

        let result = super::call_czsapp(
            "home",
            None,
            &format!("http://{address}/"),
            &HeaderMap::new(),
            Duration::from_secs(2),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("Czsapp retries the transient response");
        assert_eq!(
            result["list"][0]["vod_id"],
            format!("http://{address}/movie/42.html")
        );
        server.await.expect("Czsapp fixture completes");
    }

    #[test]
    fn czsapp_retry_whitelist_excludes_deterministic_failures() {
        for message in [
            "error sending request for url (https://www.4kcz.com/)",
            "SOURCE_HTTP_STATUS:408 Request Timeout",
            "SOURCE_HTTP_STATUS:425 Too Early",
            "SOURCE_HTTP_STATUS:429 Too Many Requests",
            "SOURCE_HTTP_STATUS:500 Internal Server Error",
            "SOURCE_HTTP_STATUS:502 Bad Gateway",
            "SOURCE_HTTP_STATUS:503 Service Unavailable",
            "SOURCE_HTTP_STATUS:504 Gateway Timeout",
            "SOURCE_HTTP_STATUS:520 Unknown Error",
            "SOURCE_HTTP_STATUS:524 A Timeout Occurred",
        ] {
            assert!(is_retryable_czsapp_error(&LegacyHttpError::Request(
                message.to_string()
            )));
        }
        for message in [
            "SOURCE_REQUEST_CANCELLED",
            "SOURCE_HTTP_STATUS:404 Not Found",
            "SOURCE_HTTP_STATUS:501 Not Implemented",
            "SOURCE_JSON_INVALID:expected value",
        ] {
            assert!(!is_retryable_czsapp_error(&LegacyHttpError::Request(
                message.to_string()
            )));
        }
        assert!(!is_retryable_czsapp_error(&LegacyHttpError::Unsupported(
            "HTML_DYNAMIC_PLAYER_UNSUPPORTED".to_string()
        )));
    }

    #[test]
    fn legacy_loopback_urls_bypass_the_environment_proxy_only_locally() {
        for url in [
            "http://localhost:20000/",
            "http://127.0.0.1:20000/",
            "http://[::1]:20000/",
        ] {
            assert!(
                should_bypass_proxy_for_legacy_url(
                    &reqwest::Url::parse(url).expect("loopback URL")
                ),
                "{url} should bypass the environment proxy"
            );
        }
        assert!(!should_bypass_proxy_for_legacy_url(
            &reqwest::Url::parse("https://www.4kcz.com/").expect("external URL")
        ));
    }

    async fn fetch_canary_bytes(
        url: reqwest::Url,
        headers: &HeaderMap,
        timeout: Duration,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Vec<u8>, String> {
        let client = reqwest::Client::builder()
            .default_headers(headers.clone())
            .http1_only()
            .timeout(timeout)
            .build()
            .map_err(|error| error.to_string())?;
        let response = tokio::select! {
            result = client.get(url).send() => result.map_err(|error| error.to_string())?,
            _ = wait_for_cancel(cancelled.clone()) => return Err("SOURCE_REQUEST_CANCELLED".to_string()),
        };
        let status = response.status();
        let bytes = tokio::select! {
            result = read_bounded_response(response) => result.map_err(|error| error.message("SOURCE_RESPONSE_TOO_LARGE"))?,
            _ = wait_for_cancel(cancelled) => return Err("SOURCE_REQUEST_CANCELLED".to_string()),
        };
        if !status.is_success() {
            return Err(format!("SOURCE_HTTP_STATUS:{status}"));
        }
        Ok(bytes)
    }

    async fn fetch_apprj_canary_segment(
        initial_url: reqwest::Url,
        headers: &HeaderMap,
        timeout: Duration,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Vec<u8>, String> {
        let mut builder = reqwest::Client::builder()
            .default_headers(headers.clone())
            .http1_only()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none());
        if should_bypass_proxy_for_legacy_url(&initial_url) {
            builder = builder.no_proxy();
        }
        let client = builder.build().map_err(|error| error.to_string())?;
        let mut current_url = initial_url.clone();
        for redirect_count in 0..=1 {
            let response = tokio::select! {
                result = client.get(current_url.clone()).send() => result.map_err(|error| error.to_string())?,
                _ = wait_for_cancel(cancelled.clone()) => return Err("SOURCE_REQUEST_CANCELLED".to_string()),
            };
            if response.status().is_redirection() {
                if redirect_count > 0 || !initial_url.path().starts_with("/nby/m3u8/play/ts/") {
                    return Err("APPRJ_SEGMENT_REDIRECT_REJECTED".to_string());
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| "APPRJ_SEGMENT_REDIRECT_LOCATION_REQUIRED".to_string())?;
                let target = current_url
                    .join(location)
                    .map_err(|_| "APPRJ_SEGMENT_REDIRECT_INVALID".to_string())?;
                if !matches!(target.scheme(), "http" | "https")
                    || target.host_str().is_none()
                    || !target.username().is_empty()
                    || target.password().is_some()
                    || !target.path().to_ascii_lowercase().ends_with(".png")
                {
                    return Err("APPRJ_SEGMENT_REDIRECT_REJECTED".to_string());
                }
                let same_origin = target.scheme() == current_url.scheme()
                    && target.host_str() == current_url.host_str()
                    && target.port_or_known_default() == current_url.port_or_known_default();
                if !same_origin
                    && headers
                        .keys()
                        .any(|name| name != reqwest::header::USER_AGENT)
                {
                    return Err("APPRJ_SEGMENT_REDIRECT_HEADERS_REJECTED".to_string());
                }
                current_url = target;
                continue;
            }
            let status = response.status();
            let bytes = tokio::select! {
                result = read_bounded_response(response) => result.map_err(|error| error.message("SOURCE_RESPONSE_TOO_LARGE"))?,
                _ = wait_for_cancel(cancelled.clone()) => return Err("SOURCE_REQUEST_CANCELLED".to_string()),
            };
            if !status.is_success() {
                return Err(format!("SOURCE_HTTP_STATUS:{status}"));
            }
            return Ok(bytes);
        }
        Err("APPRJ_SEGMENT_REDIRECT_LIMIT".to_string())
    }

    #[test]
    fn recognizes_the_small_legacy_adapter_set() {
        assert_eq!(kind("csp_Dm84"), Some(LegacyHttpKind::Dm84));
        assert_eq!(kind("csp_Kanqiu"), Some(LegacyHttpKind::Kanqiu));
        assert_eq!(kind("csp_Kugou"), Some(LegacyHttpKind::Kugou));
        assert_eq!(kind("csp_PanSearch"), Some(LegacyHttpKind::PanSearch));
        assert_eq!(kind("csp_AppRJ"), Some(LegacyHttpKind::AppRJ));
        assert_eq!(kind("csp_Jpys"), Some(LegacyHttpKind::Jpys));
        assert_eq!(kind("csp_GuaziTY"), Some(LegacyHttpKind::GuaziTy));
        assert_eq!(kind("csp_Gz360"), Some(LegacyHttpKind::Gz360));
        assert_eq!(kind("csp_Czsapp"), Some(LegacyHttpKind::Czsapp));
        assert_eq!(kind("csp_YGP"), Some(LegacyHttpKind::Ygp));
        assert_eq!(kind("csp_Netfixtv"), Some(LegacyHttpKind::Duopan));
        assert!(kind("csp_Unknown").is_none());
        assert!(capabilities(LegacyHttpKind::PanSearch).search);
        assert!(capabilities(LegacyHttpKind::AppRJ).playback);
        assert!(capabilities(LegacyHttpKind::Kanqiu).playback);
        assert_eq!(
            capabilities(LegacyHttpKind::Jpys).engine,
            "http-json-signed"
        );
        assert_eq!(
            capabilities(LegacyHttpKind::GuaziTy).engine,
            "http-json-aes"
        );
        assert!(!capabilities(LegacyHttpKind::GuaziTy).filters);
        assert_eq!(capabilities(LegacyHttpKind::Gz360).engine, "http-json-aes");
        assert!(capabilities(LegacyHttpKind::Gz360).playback);
        assert!(capabilities(LegacyHttpKind::Wwys).playback);
        assert!(capabilities(LegacyHttpKind::SaoHuo).playback);
        assert!(capabilities(LegacyHttpKind::Czsapp).playback);
        assert!(!capabilities(LegacyHttpKind::Duopan).playback);
        assert!(capabilities(LegacyHttpKind::Ygp).playback);
    }

    #[test]
    fn pansearch_result_urls_are_http_only_and_credential_free() {
        let base = reqwest::Url::parse("https://www.pansearch.me/").unwrap();
        assert_eq!(
            pansearch_result_url(&base, "/share/1").as_deref(),
            Some("https://www.pansearch.me/share/1")
        );
        assert!(pansearch_result_url(&base, "javascript:alert(1)").is_none());
        assert!(pansearch_result_url(&base, "data:text/html,boom").is_none());
        assert!(pansearch_result_url(&base, "https://user:pass@example.test/share").is_none());
    }

    #[test]
    fn maps_dm84_publish_page_to_allowlisted_content_hosts_only() {
        let html = r#"
          <a href="https://dm84.vip">永久网址</a>
          <a href="https://dmbus.cc/path?x=1#home">最新地址</a>
          <a href="https://dm84.top">备用</a>
          <a href="https://dm84.vip.evil.test/">伪造</a>
          <a href="https://user:pass@dm84.vip/">凭据</a>
          <a href="javascript:alert(1)">脚本</a>
        "#;
        assert_eq!(
            dm84_discovered_bases_from_html(html),
            vec![
                "https://dm84.vip/".to_string(),
                "https://dmbus.cc/".to_string(),
                "https://dm84.top/".to_string()
            ]
        );
    }

    #[test]
    fn maps_saohuo_publish_page_to_allowlisted_hosts_only() {
        let html = r#"
          <div class="content-top">
            <a href="https://shdy2.com">https://shdy2.com</a>
            <a href="https://shdy3.com/path?x=1">备用</a>
            <a href="https://shdy5.us">旧地址</a>
            <a href="https://shdy2.com.evil.test">恶意</a>
            <a href="https://user:pass@shdy4.com">凭据</a>
            <a href="javascript:alert(1)">脚本</a>
          </div>
        "#;
        let bases = saohuo_discovered_bases(html);
        assert_eq!(
            bases
                .iter()
                .map(reqwest::Url::to_string)
                .collect::<Vec<_>>(),
            vec![
                "https://shdy2.com/",
                "https://shdy3.com/",
                "https://shdy5.us/"
            ]
        );
    }

    #[tokio::test]
    async fn saohuo_direct_media_player_skips_publish_page_discovery() {
        let result = call(
            LegacyHttpKind::SaoHuo,
            "player",
            Some(&json!({"id": "https://media.test/episode.mp4"})),
            "https://shdy5.us",
            &HeaderMap::new(),
            Duration::from_secs(2),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("direct SaoHuo media");
        assert_eq!(result["parse"], 0);
        assert_eq!(result["url"], "https://media.test/episode.mp4");
    }

    #[test]
    fn maps_tuxiaobei_jsonp_detail_and_explicit_media_contract() {
        let api = "https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/drpy2.min.js";
        let ext = "https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/%E5%85%94%E5%B0%8F%E8%B4%9D.js";
        assert_eq!(super::kind_for(api, ext), Some(LegacyHttpKind::TuXiaoBei));
        assert!(super::is_tuxiaobei(api, ext));
        assert!(!super::is_tuxiaobei(api, "https://example.test/other.js"));
        assert!(!super::is_tuxiaobei(
            "https://example.test/drpy2.min.js.evil",
            ext
        ));
        assert_eq!(
            capabilities(LegacyHttpKind::TuXiaoBei).engine,
            "http-json-jsonp-html"
        );
        let base = fixed_base(TUXIAOBEI_BASE).expect("TuXiaoBei base");
        let value = tuxiaobei_parse_jsonp(
            r#"({"status":0,"data":{"items":[{"video_id":940,"name":"江南style","image":"https://resource-cdn.tuxiaobei.com/video/poster.png","duration_string":"03:32","category_name":"儿歌"}]}});"#,
        )
        .expect("TuXiaoBei JSONP");
        let items = tuxiaobei_json_items(&value, &base);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["vod_id"], "https://www.tuxiaobei.com/play/940");
        assert_eq!(items[0]["vod_name"], "江南style");
        assert_eq!(items[0]["type_name"], "儿歌");
        let html = r#"
          <div class="items"><a href="/play/940"><div class="text">江南style</div><mip-img src="https://resource-cdn.tuxiaobei.com/video/poster.png"></mip-img><div class="time">03:32</div></a></div>
        "#;
        let html_items = tuxiaobei_html_items(html, &base);
        assert_eq!(html_items.len(), 1);
        assert_eq!(html_items[0]["vod_name"], "江南style");
        assert_eq!(
            tuxiaobei_search_url(&base, " 江南style/启蒙? ")
                .expect("TuXiaoBei canonical search URL")
                .as_str(),
            "https://www.tuxiaobei.com/search/%E6%B1%9F%E5%8D%97style%2F%E5%90%AF%E8%92%99%3F"
        );
        assert!(matches!(
            tuxiaobei_search_url(&base, "  "),
            Err(LegacyHttpError::Request(message)) if message == "TUXIAOBEI_SEARCH_KEY_REQUIRED"
        ));
        let detail_html = r#"
          <title>江南style</title>
          <mip-search-video id="videoWrap" video-src="https://resource-cdn.tuxiaobei.com/video/940.mp4" poster="https://resource-cdn.tuxiaobei.com/video/poster.png"></mip-search-video>
        "#;
        let detail_url = tuxiaobei_detail_url(&base, "940").expect("detail URL");
        let detail = tuxiaobei_detail(detail_html, &detail_url).expect("detail");
        assert_eq!(detail["list"][0]["vod_name"], "江南style");
        assert_eq!(
            detail["list"][0]["vod_play_url"],
            "正片$https://www.tuxiaobei.com/play/940"
        );
        assert_eq!(
            tuxiaobei_video_url(detail_html).as_deref(),
            Some("https://resource-cdn.tuxiaobei.com/video/940.mp4")
        );
        assert!(tuxiaobei_parse_jsonp("alert({\"data\":{}})").is_err());
        assert!(tuxiaobei_detail_url(&base, "https://evil.test/play/940").is_err());
        assert_eq!(TUXIAOBEI_UA, "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
    }

    #[test]
    fn maps_sp360_jsonp_catalog_items_and_fixed_source_ids() {
        assert_eq!(kind("csp_SP360"), Some(LegacyHttpKind::Sp360));
        assert_eq!(
            capabilities(LegacyHttpKind::Sp360).engine,
            "http-json-jsonp"
        );
        assert!(capabilities(LegacyHttpKind::Sp360).playback);
        let rank = sp360_rank_items(&json!({
            "data": [{
                "ent_id": "rank-1",
                "cat": 1,
                "title": "榜单片",
                "cover": "//img.test/rank.jpg",
                "moviecat": ["动作"]
            }]
        }));
        assert_eq!(rank[0]["vod_id"], "1|rank-1");
        assert_eq!(rank[0]["vod_name"], "榜单片");
        assert_eq!(rank[0]["vod_pic"], "https://img.test/rank.jpg");
        let category = sp360_category_items(
            &json!({
                "data": {"movies": [{
                    "id": "cat-1",
                    "title": "分类片",
                    "pubdate": "2026-01-01",
                    "moviecategory": ["剧情"]
                }]}
            }),
            "2",
        );
        assert_eq!(category[0]["vod_id"], "2|cat-1");
        assert_eq!(category[0]["type_name"], "剧情");
        assert_eq!(sp360_source_id("2|cat-1").expect("source id").0, "2");
        assert!(sp360_source_id("https://example.test/detail").is_err());
    }

    #[test]
    fn maps_sp360_detail_episodes_and_keeps_page_playback_explicit() {
        let detail = sp360_detail(
            &json!({
                "data": {
                    "title": "示例剧",
                    "cdncover": "https://img.test/show.jpg",
                    "description": "简介",
                    "playlink_sites": ["qq", "imgo"],
                    "allepidetail": {
                        "qq": [{"playlink_num": "1", "url": "https://v.qq.com/x/1.html"}]
                    },
                    "playlinksdetail": {
                        "imgo": {"default_url": "http://www.mgtv.com/b/1.html"}
                    }
                }
            }),
            "2|show-1",
        )
        .expect("detail");
        assert_eq!(detail["list"][0]["vod_name"], "示例剧");
        assert_eq!(detail["list"][0]["vod_play_from"], "qq$$$imgo");
        let urls = detail["list"][0]["vod_play_url"].as_str().expect("urls");
        assert!(urls.contains("1$https://v.qq.com/x/1.html"));
        assert!(urls.contains("正片$http://www.mgtv.com/b/1.html"));
        let player = sp360_player(Some(&json!({
            "id": "1$https://v.qq.com/x/1.html"
        })))
        .expect("player");
        assert_eq!(player["parse"], 1);
        assert_eq!(player["url"], "https://v.qq.com/x/1.html");
        assert_eq!(player["header"]["User-Agent"], SP360_UA);
        assert_eq!(player["header"]["Referer"], SP360_REFERER);
        assert!(sp360_player(Some(&json!({"id": "file:///tmp/video"}))).is_err());
    }

    #[test]
    fn maps_ygp_html_catalog_detail_and_explicit_mp4_playback() {
        let base = fixed_base(YGP_BASE).expect("YGP base");
        let catalog = r#"
          <div class="inner-2col-main"><div class="movlist"><ul>
            <li><a href="/movie/453"><img src="/files/p453.jpg" />
              <span class="item-title" title="示例片">示例片</span>
              <span class="item-pubtime">2026-08上映</span>
            </a></li>
          </ul></div></div>
        "#;
        let items = ygp_catalog_items(catalog, &base);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["vod_id"], "https://www.6huo.com/movie/453");
        assert_eq!(items[0]["vod_name"], "示例片");
        assert_eq!(items[0]["vod_pic"], "https://www.6huo.com/files/p453.jpg");
        assert_eq!(
            ygp_category_path(
                Some(&json!({"typeId":"movlist/", "filter":{"0":"剧情"}})),
                "1"
            )
            .expect("YGP category path"),
            "/movlist/%E5%89%A7%E6%83%85____1"
        );
        let detail_html = r#"
          <div class="movie-title-mpic"><a><img src="/files/p453.jpg" /></a></div>
          <h1 class="movie-name" title="示例片">示例片</h1>
          <div class="movie-title-detail"><p>类型：<a href="/country/美国">美国</a> / <a href="/movietype/科幻">科幻</a><br/>
            上映：2026-08-19 导演：<a href="/search?a=1">导演甲</a> 主演：演员甲 / 演员乙 剧情：这是简介(详细)</p></div>
          <div id="tabwrapper-all" class="tabwrapper-videolist"><table class="tlist">
            <tr><th>预告片</th></tr>
            <tr><td><a class="tlist-bbs-tdtitle" href="/show/177205">示例预告</a></td></tr>
          </table></div>
        "#;
        let detail = ygp_detail(
            detail_html,
            &reqwest::Url::parse("https://www.6huo.com/movie/453").unwrap(),
        )
        .expect("YGP detail");
        assert_eq!(detail["list"][0]["vod_name"], "示例片");
        assert_eq!(detail["list"][0]["vod_area"], "美国");
        assert_eq!(detail["list"][0]["vod_play_from"], "预告片");
        assert_eq!(
            detail["list"][0]["vod_play_url"],
            "示例预告$https://www.6huo.com/show/177205"
        );
        let player_html =
            r#"<script>var videoObject={video:'https://media.test/trailer.mp4'};</script>"#;
        assert_eq!(
            extract_html_media(player_html).as_deref(),
            Some("https://media.test/trailer.mp4")
        );
        assert_eq!(
            ygp_show_url(&base, "/show/177205").unwrap().path(),
            "/show/177205"
        );
        assert!(ygp_detail_url(&base, "https://example.test/movie/453").is_err());
        assert!(ygp_show_url(&base, "javascript:alert(1)").is_err());
        assert!(YGP_UA.contains("Chrome/86.0.4240.198"));
    }

    #[test]
    fn parses_sp360_jsonp_without_executing_callback_code() {
        let value = sp360_parse_jsonp("qx({\"data\":[],\"msg\":\"ok\"});").expect("jsonp");
        assert_eq!(value["msg"], "ok");
        let plain = sp360_parse_jsonp("{\"data\":null}").expect("json");
        assert!(plain["data"].is_null());
        assert!(sp360_parse_jsonp("alert({\"data\":[]})").is_err());
    }

    #[test]
    fn gz360_aes_round_trip_uses_hex_ciphertext() {
        let plaintext = r#"{"vod_id":"1","phone_type":3}"#;
        let encrypted = gz360_encrypt_text(plaintext).expect("encrypt");
        assert!(!encrypted.is_empty());
        assert!(encrypted.chars().all(|value| value.is_ascii_hexdigit()));
        assert_eq!(gz360_decrypt_text(&encrypted).expect("decrypt"), plaintext);
    }

    #[test]
    fn preserves_bounded_gz360_upstream_error_messages_without_payload_data() {
        assert_eq!(
            super::gz360_response_error(&json!({"code": 0, "msg": "系统错误"})),
            "GZ360_RESPONSE_CODE:0:系统错误"
        );
        assert_eq!(
            super::gz360_response_error(&json!({"code": 503})),
            "GZ360_RESPONSE_CODE:503"
        );
        let long = "x".repeat(256);
        let error = super::gz360_response_error(&json!({"code": 0, "message": long}));
        assert_eq!(error.len(), "GZ360_RESPONSE_CODE:0:".len() + 128);
    }

    #[test]
    fn maps_gz360_home_and_catalog_items() {
        let home = gz360_home(&json!([
            {"pid": 1, "name": "热门", "type": "recommend", "children": []},
            {"id": 2, "name": "电影"}
        ]));
        assert_eq!(home["class"][0]["type_id"], "1");
        assert_eq!(home["class"][0]["type_name"], "热门");
        assert_eq!(home["class"][1]["type_id"], "2");

        let items = gz360_items(&json!({
            "list": [{
                "pid": "1",
                "list": [{
                    "vod_id": "v1",
                    "c_name": "示例",
                    "c_pic": "https://img.test/a.jpg",
                    "vod_continu": "更新至1集",
                    "tags": ["电影", "战争"]
                }]
            }]
        }));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["vod_id"], "v1");
        assert_eq!(items[0]["vod_name"], "示例");
        assert_eq!(items[0]["vod_pic"], "https://img.test/a.jpg");
        assert_eq!(items[0]["type_name"], "电影,战争");
    }

    #[test]
    fn maps_gz360_detail_and_rejects_unsafe_episode_urls() {
        let detail = gz360_detail(
            &json!({
                "vodInfo": {
                    "vod_id": "v1",
                    "vod_name": "示例",
                    "vod_pic": "https://img.test/a.jpg",
                    "default_play_name": "正片",
                    "play_url": "https://media.test/main.m3u8",
                    "pre_video": "https://media.test/preview.m3u8",
                    "videoTag": ["电影", "战争"],
                    "vurlList": [
                        {"name": "备用", "url": "https://media.test/backup.m3u8"},
                        {"name": "凭据", "url": "https://user:pass@media.test/private.m3u8"},
                        {"name": "本地", "url": "file:///tmp/video.m3u8"}
                    ]
                }
            }),
            "v1",
        )
        .expect("detail");
        assert_eq!(detail["list"][0]["vod_name"], "示例");
        assert_eq!(detail["list"][0]["type_name"], "电影,战争");
        let episodes = detail["list"][0]["vod_play_url"]
            .as_str()
            .expect("episodes");
        assert!(episodes.contains("https://media.test/main.m3u8"));
        assert!(episodes.contains("https://media.test/preview.m3u8"));
        assert!(episodes.contains("https://media.test/backup.m3u8"));
        assert!(!episodes.contains("user:pass@"));
        assert!(!episodes.contains("file://"));
        assert!(gz360_media_url("javascript:alert(1)").is_none());
        assert!(gz360_media_url("https://user:pass@media.test/live.m3u8").is_none());
    }

    #[test]
    fn gz360_player_returns_a_direct_url_with_fixed_headers() {
        let result = gz360_player(Some(&json!({
            "id": "正片$https://media.test/main.m3u8"
        })))
        .expect("player");
        assert_eq!(result["parse"], 0);
        assert_eq!(result["jx"], 0);
        assert_eq!(result["url"], "https://media.test/main.m3u8");
        assert_eq!(result["header"]["User-Agent"], GZ360_UA);
        assert_eq!(result["header"]["Referer"], GZ360_REFERER);
        assert!(gz360_player(Some(&json!({"id": "file:///tmp/video.m3u8"}))).is_err());
    }

    #[test]
    fn guazi_aes_round_trip_uses_unpadded_base64() {
        let plaintext = r#"{"mid":"match-1","frame":"0"}"#;
        let encrypted = guazi_encrypt_text(plaintext).expect("encrypt");
        assert!(!encrypted.ends_with('='));
        assert_eq!(guazi_decrypt_text(&encrypted).expect("decrypt"), plaintext);
    }

    #[test]
    fn maps_guazi_home_and_filters_stale_or_finished_matches() {
        let home = guazi_home();
        assert_eq!(home["class"][0]["type_id"], "hot");
        assert_eq!(home["class"][3]["type_name"], "篮球");
        let now = unix_epoch_seconds();
        let items = guazi_items(&json!([
            {
                "match_time": now,
                "m_status": 1,
                "mid": "match-1",
                "event_name": "联赛",
                "match_status_info": "直播中",
                "home": {"name": "主队", "logo": "https://img.test/home.png", "score": 1},
                "visiting": {"name": "客队", "logo": "https://img.test/away.png", "score": 0}
            },
            {
                "match_time": now - 90_000,
                "m_status": 1,
                "mid": "stale",
                "home": {"name": "旧主"},
                "visiting": {"name": "旧客"}
            },
            {
                "match_time": now,
                "m_status": 2,
                "mid": "finished",
                "home": {"name": "完主"},
                "visiting": {"name": "完客"}
            }
        ]));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["vod_id"], "match-1");
        assert_eq!(items[0]["vod_name"], "主队 vs 客队");
        assert_eq!(items[0]["vod_pic"], "https://img.test/home.png");
        assert!(items[0]["vod_remarks"]
            .as_str()
            .is_some_and(|value| { value.contains("联赛") && value.contains("比分 1-0") }));
    }

    #[test]
    fn maps_guazi_detail_live_lines_and_rejects_unsafe_media_urls() {
        let detail = guazi_detail(
            &json!({
                "home": {"name": "主队", "logo": "https://img.test/home.png", "score": 2},
                "visiting": {"name": "客队", "score": 1},
                "match_status_info": "进行中",
                "live_line": [
                    {"name": "主线", "m3u8": "https://media.test/live.m3u8"},
                    {"name": "带凭据", "m3u8": "https://user:pass@media.test/live.m3u8"},
                    {"name": "本地", "m3u8": "file:///tmp/live.m3u8"},
                    {"name": "备用", "m3u8": "https://media.test/backup.m3u8?token=1"}
                ]
            }),
            "match-1",
        )
        .expect("detail");
        assert_eq!(detail["list"][0]["vod_name"], "主队 vs 客队");
        assert_eq!(detail["list"][0]["type_name"], "进行中 比分 2-1");
        assert_eq!(
            detail["list"][0]["vod_play_url"],
            "主线$https://media.test/live.m3u8#备用$https://media.test/backup.m3u8?token=1"
        );
        assert!(guazi_media_url("javascript:alert(1)").is_none());
        assert!(guazi_media_url("https://user:pass@media.test/live.m3u8").is_none());
        assert_eq!(
            guazi_media_url("https://media.test/live.m3u8").as_deref(),
            Some("https://media.test/live.m3u8")
        );
    }

    #[test]
    fn guazi_player_returns_a_direct_url_with_fixed_headers() {
        let result = guazi_player(Some(&json!({
            "id": "主线$https://media.test/live.m3u8"
        })))
        .expect("player");
        assert_eq!(result["parse"], 0);
        assert_eq!(result["jx"], 0);
        assert_eq!(result["url"], "https://media.test/live.m3u8");
        assert_eq!(result["header"]["User-Agent"], "Lavf/57.83.100");
        assert_eq!(result["header"]["Referer"], "http://WJiZxLXA2.com/");
        assert!(guazi_player(Some(&json!({"id": "file:///tmp/live.m3u8"}))).is_err());
    }

    #[test]
    fn redacts_guazi_query_parameters_from_canary_logs() {
        assert_eq!(
            safe_media_url("https://media.test/live.m3u8?auth_key=secret#live"),
            "https://media.test/live.m3u8"
        );
        assert_eq!(safe_media_url("not-a-url"), "<invalid-url>");
    }

    #[test]
    fn maps_jpys_signed_detail_episodes_without_a_local_proxy() {
        assert_eq!(
            jpys_signature("foo"),
            "04003622eb9d0f788ce7568c7eed23809534365a"
        );
        let detail = jpys_detail(
            &json!({
                "data": {
                    "vodName": "示例",
                    "vodPic": "https://img.test/example.jpg",
                    "vodRemarks": "更新至1集",
                    "vodArea": "中国",
                    "vodYear": "2026",
                    "vodActor": "演员",
                    "vodDirector": "导演",
                    "vodContent": "简介",
                    "episodeList": [{"sorr": "第1集", "name": "第一集", "nid": "n1"}]
                }
            }),
            "movie-1",
        )
        .unwrap();
        assert_eq!(detail["list"][0]["vod_name"], "示例");
        assert_eq!(
            detail["list"][0]["vod_play_url"],
            "第1集$movie-1@n1@示例@第1集"
        );
        assert!(detail["list"][0]["vod_play_url"]
            .as_str()
            .is_some_and(|value| !value.contains("Proxy")));
    }

    #[tokio::test]
    async fn rejects_jpys_episode_without_signed_endpoint_fields() {
        let error = super::call_jpys(
            "player",
            Some(&json!({"id": "episode-without-nid"})),
            "",
            &HeaderMap::new(),
            Duration::from_secs(1),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap_err();
        assert!(matches!(
            error,
            LegacyHttpError::Request(message) if message == "JPYS_EPISODE_INVALID"
        ));
    }

    #[tokio::test]
    #[ignore = "real Jpys signed read/detail/player canary; network-dependent"]
    async fn real_jpys_signed_read_detail_and_player_chain() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let headers = HeaderMap::new();
        let search = call(
            LegacyHttpKind::Jpys,
            "search",
            Some(&json!({"key": "流浪地球"})),
            "",
            &headers,
            Duration::from_secs(20),
            cancelled.clone(),
        )
        .await
        .expect("Jpys search");
        let id = search["list"][0]["vod_id"]
            .as_str()
            .expect("Jpys search id");
        let detail = call(
            LegacyHttpKind::Jpys,
            "detail",
            Some(&json!({"ids": [id]})),
            "",
            &headers,
            Duration::from_secs(20),
            cancelled.clone(),
        )
        .await
        .expect("Jpys detail");
        let episode = detail["list"][0]["vod_play_url"]
            .as_str()
            .and_then(|value| value.split('#').next())
            .expect("Jpys episode");
        let player = call(
            LegacyHttpKind::Jpys,
            "player",
            Some(&json!({"id": episode})),
            "",
            &headers,
            Duration::from_secs(20),
            cancelled,
        )
        .await
        .expect("Jpys player");
        assert_eq!(player["parse"], 0);
        assert!(player["url"].as_str().is_some_and(|value| {
            value.starts_with("http://") || value.starts_with("https://")
        }));
    }

    #[test]
    fn maps_kanqiu_home_and_static_category_items() {
        let home = kanqiu_home();
        assert_eq!(home["class"][1]["type_id"], "4");
        let base = reqwest::Url::parse("http://www.88kanqiu.la").unwrap();
        let items = kanqiu_category_items(
            r#"
              <li class="list-group-item">
                <span class="event-name">主场 vs 客场</span>
                <a class="btn btn-primary" href="/match/play/42"></a>
                <div class="col-xs-1"><img src="/logo.jpg"></div>
              </li>
            "#,
            &base,
        );
        assert_eq!(items[0]["vod_id"], "http://www.88kanqiu.la/match/source/42");
        assert_eq!(items[0]["vod_pic"], "http://www.88kanqiu.la/logo.jpg");
        assert!(items[0]["vod_name"]
            .as_str()
            .is_some_and(|value| value.contains("主场")));
    }

    #[test]
    fn decodes_kanqiu_detail_links_and_protects_episode_separators() {
        let payload = base64::engine::general_purpose::STANDARD
            .encode(r#"{"links":[{"name":"主线","url":"https://media.test/live#1.m3u8"}]}"#);
        let body = format!(r#"{{"data":"prefix{payload}zz"}}"#);
        let detail = kanqiu_detail(
            &body,
            &reqwest::Url::parse("http://www.88kanqiu.la/match/source/42").unwrap(),
        )
        .unwrap();
        assert_eq!(detail["list"][0]["vod_name"], "主线");
        assert_eq!(
            detail["list"][0]["vod_play_url"],
            "主线$https://media.test/live***1.m3u8"
        );
    }

    #[test]
    fn kanqiu_player_is_a_bounded_direct_url_handoff() {
        let base = reqwest::Url::parse("http://www.88kanqiu.la").unwrap();
        assert_eq!(
            kanqiu_player_url("主线$https://media.test/live***1.m3u8", &base).unwrap(),
            "https://media.test/live#1.m3u8"
        );
        assert!(kanqiu_player_url("javascript:alert(1)", &base).is_err());
    }

    #[test]
    fn maps_apprj_json_contract_and_signature() {
        assert_eq!(
            md5_hex("7gp0bnd2sr85ydii2j32pcypscoc4w6c7g5spl1700000000"),
            "99c38d9eefdaa82e7250ec8eb3445331"
        );
        let home = apprj_home(&json!({
            "data": {"list": [{"type_id": "1", "type_name": "电影"}]}
        }));
        assert_eq!(home["class"][0]["type_id"], "1");
        let list = apprj_list(&json!({
            "data": {"list": [{"id": "v1", "title": "示例", "vod_pic_thumb": "https://img.test/a.jpg"}]}
        }));
        assert_eq!(list["list"][0]["vod_id"], "v1");
        let detail = apprj_detail(
            &json!({
                "data": {
                    "title": "示例",
                    "vod_play_list": [
                        {
                            "name": "主线",
                            "ua": "fixture-agent",
                            "parse_urls": [],
                            "urls": [{
                                "name": "第一集",
                                "url": "https://media.test/a.m3u8",
                                "nid": "ep-1"
                            }]
                        },
                        {
                            "name": "解析线",
                            "ua": "parse-agent",
                            "parse_urls": [
                                "https://parse-a.test/?url=",
                                "https://parse-b.test/?url="
                            ],
                            "urls": [{
                                "name": "第二集",
                                "url": "https://origin.test/token",
                                "nid": "ep-2"
                            }]
                        }
                    ]
                }
            }),
            "v1",
        )
        .unwrap();
        assert_eq!(detail["vod_name"], "示例");
        assert_eq!(detail["vod_play_from"], "主线$$$解析线");
        assert_eq!(
            detail["vod_play_url"],
            "第一集$|https://media.test/a.m3u8|fixture-agent|示例|ep-1$$$第二集$https://parse-a.test/?url=@https://parse-b.test/?url=|https://origin.test/token|parse-agent|示例|ep-2"
        );
    }

    #[test]
    fn accepts_only_the_known_apprj_nby_parser_contract() {
        let parser = "https://api.nbyjson.top:7788/api/?key=test-key&url=";
        let request = apprj_parser_request_url(parser, "NBY-episode-token").expect("parser URL");
        assert_eq!(request.scheme(), "https");
        assert_eq!(request.host_str(), Some("api.nbyjson.top"));
        assert_eq!(request.port(), Some(7788));
        assert_eq!(request.path(), "/api/");
        assert_eq!(
            request
                .query_pairs()
                .find(|(name, _)| name == "url")
                .map(|(_, value)| value.into_owned()),
            Some("NBY-episode-token".to_string())
        );
        assert!(
            apprj_parser_request_url("https://parse.test/api/?key=test&url=", "target").is_none()
        );
        assert!(apprj_parser_request_url(
            "http://api.nbyjson.top:7788/api/?key=test&url=",
            "target"
        )
        .is_none());
        assert!(apprj_parser_request_url(
            "https://api.nbyjson.top:7788/other?key=test&url=",
            "target"
        )
        .is_none());
    }

    #[test]
    fn maps_a_bounded_apprj_nby_parser_response_to_direct_playback() {
        let result = apprj_parser_response(&json!({
            "code": 200,
            "url": "http://111.170.9.52:9090/nby/m3u8/getM3u8?name=jx.91by.top&url=NBY-test.m3u8",
            "UA": "Mozilla/5.0"
        }))
        .expect("NBY parser response");
        assert_eq!(
            result.0,
            "http://111.170.9.52:9090/nby/m3u8/getM3u8?name=jx.91by.top&url=NBY-test.m3u8"
        );
        assert_eq!(result.1.as_deref(), Some("Mozilla/5.0"));
        assert!(apprj_parser_response(
            &json!({"code": 200, "url": "https://media.test/not-a-media"})
        )
        .is_none());
        assert!(
            apprj_parser_response(&json!({"code": 500, "url": "https://media.test/a.m3u8"}))
                .is_none()
        );
    }

    #[test]
    fn keeps_pipe_characters_inside_apprj_episode_targets() {
        let player_id = "https://api.nbyjson.top:7788/api/?key=test&url=|NBY-token|part-two|Mozilla/5.0|示例|ep-1";
        let catalog_entry = format!("第一集${player_id}");
        let fields = apprj_episode_fields(&catalog_entry).expect("catalog episode fields");
        assert_eq!(fields.0, "NBY-token|part-two");
        assert_eq!(fields.1, "Mozilla/5.0");
        assert_eq!(fields.2, "https://api.nbyjson.top:7788/api/?key=test&url=");

        let player_fields = apprj_episode_fields(player_id).expect("player episode fields");
        assert_eq!(player_fields, fields);
    }

    #[test]
    fn escapes_apprj_trailing_metadata_without_changing_the_player_user_agent() {
        let detail = apprj_detail(
            &json!({
                "data": {
                    "title": "Movie|Part%2",
                    "vod_play_list": [{
                        "name": "main",
                        "ua": "Agent|Part%2",
                        "parse_urls": [],
                        "urls": [{
                            "name": "Episode",
                            "url": "https://media.test/a.m3u8",
                            "nid": "ep|1%2"
                        }]
                    }]
                }
            }),
            "v1",
        )
        .expect("AppRJ detail");
        let episode = detail["vod_play_url"].as_str().expect("AppRJ episode");
        assert!(episode.contains("Agent%7CPart%252|Movie%7CPart%252|ep%7C1%252"));
        let fields = apprj_episode_fields(episode).expect("AppRJ episode fields");
        assert_eq!(fields.0, "https://media.test/a.m3u8");
        assert_eq!(fields.1, "Agent|Part%2");
        assert_eq!(fields.2, "");
    }

    #[test]
    fn recognizes_raw_and_png_wrapped_mpeg_ts_without_accepting_a_fake_prefix() {
        let mut transport_stream = vec![0_u8; 188 * 4];
        for packet in 0..4 {
            transport_stream[packet * 188] = 0x47;
        }
        assert_eq!(mpeg_ts_payload_offset(&transport_stream), Some(0));

        let mut wrapped = b"\x89PNG\r\n\x1a\n\0\0\0\0IEND\0\0\0\0".to_vec();
        let wrapper_len = wrapped.len();
        wrapped.extend_from_slice(&transport_stream);
        assert_eq!(mpeg_ts_payload_offset(&wrapped), Some(wrapper_len));

        let mut malformed = b"\x89PNG\r\n\x1a\nnot-an-iend".to_vec();
        malformed.extend_from_slice(&transport_stream);
        assert_eq!(mpeg_ts_payload_offset(&malformed), None);
    }

    async fn spawn_apprj_hls_fixture(
        routes: HashMap<&'static str, (&'static str, Option<&'static str>, Vec<u8>)>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = bind_loopback_tcp()
            .await
            .expect("AppRJ HLS fixture listener");
        let address = listener.local_addr().expect("AppRJ HLS fixture address");
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    continue;
                };
                let mut request = [0_u8; 2048];
                let Ok(size) = socket.read(&mut request).await else {
                    continue;
                };
                let request_text = String::from_utf8_lossy(&request[..size]);
                let path = request_text
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or_default();
                let (status, location, body) =
                    routes
                        .get(path)
                        .cloned()
                        .unwrap_or(("404 Not Found", None, Vec::new()));
                let location_header = location
                    .map(|value| format!("Location: {value}\r\n"))
                    .unwrap_or_default();
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/octet-stream\r\n{location_header}Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                if socket.write_all(response.as_bytes()).await.is_err() {
                    continue;
                }
                let _ = socket.write_all(&body).await;
            }
        });
        (format!("http://{address}"), server)
    }

    #[tokio::test]
    async fn verifies_master_to_raw_apprj_hls_fixture() {
        let mut transport_stream = vec![0_u8; 188 * 4];
        for packet in 0..4 {
            transport_stream[packet * 188] = 0x47;
        }
        let (base, server) = spawn_apprj_hls_fixture(HashMap::from([
            (
                "/master.m3u8",
                (
                    "200 OK",
                    None,
                    b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/raw.m3u8\n".to_vec(),
                ),
            ),
            (
                "/raw.m3u8",
                (
                    "200 OK",
                    None,
                    b"#EXTM3U\n#EXTINF:1,\n/raw.ts\n#EXT-X-ENDLIST\n".to_vec(),
                ),
            ),
            ("/raw.ts", ("200 OK", None, transport_stream.clone())),
        ]))
        .await;
        let result = verify_apprj_hls_media(
            &format!("{base}/master.m3u8"),
            &HeaderMap::new(),
            Duration::from_secs(2),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("master to raw TS");
        assert_eq!((result.1, result.2), (transport_stream.len(), 0));
        server.abort();
    }

    #[tokio::test]
    async fn verifies_media_to_redirected_png_wrapped_apprj_hls_fixture() {
        let mut transport_stream = vec![0_u8; 188 * 4];
        for packet in 0..4 {
            transport_stream[packet * 188] = 0x47;
        }
        let mut wrapped = b"\x89PNG\r\n\x1a\n\0\0\0\0IEND\0\0\0\0".to_vec();
        let wrapper_len = wrapped.len();
        wrapped.extend_from_slice(&transport_stream);
        let (base, server) = spawn_apprj_hls_fixture(HashMap::from([
            (
                "/wrapped.m3u8",
                (
                    "200 OK",
                    None,
                    b"#EXTM3U\n#EXTINF:1,\n/nby/m3u8/play/ts/wrapped\n#EXT-X-ENDLIST\n".to_vec(),
                ),
            ),
            (
                "/nby/m3u8/play/ts/wrapped",
                ("302 Found", Some("/wrapped.png"), Vec::new()),
            ),
            ("/wrapped.png", ("200 OK", None, wrapped.clone())),
        ]))
        .await;
        let result = verify_apprj_hls_media(
            &format!("{base}/wrapped.m3u8"),
            &HeaderMap::new(),
            Duration::from_secs(2),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("media to redirected PNG-wrapped TS");
        assert_eq!((result.1, result.2), (wrapped.len(), wrapper_len));
        server.abort();
    }

    #[tokio::test]
    async fn rejects_second_apprj_segment_redirect_in_fixture() {
        let (base, server) = spawn_apprj_hls_fixture(HashMap::from([
            (
                "/redirect.m3u8",
                (
                    "200 OK",
                    None,
                    b"#EXTM3U\n#EXTINF:1,\n/nby/m3u8/play/ts/redirect\n#EXT-X-ENDLIST\n".to_vec(),
                ),
            ),
            (
                "/nby/m3u8/play/ts/redirect",
                ("302 Found", Some("/second.png"), Vec::new()),
            ),
            ("/second.png", ("302 Found", Some("/third.png"), Vec::new())),
        ]))
        .await;
        let error = verify_apprj_hls_media(
            &format!("{base}/redirect.m3u8"),
            &HeaderMap::new(),
            Duration::from_secs(2),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect_err("second segment redirect must fail");
        assert_eq!(error, "APPRJ_SEGMENT_REDIRECT_REJECTED");
        server.abort();
    }

    #[tokio::test]
    async fn rejects_misaligned_apprj_ts_fixture() {
        let mut malformed = vec![0_u8; 188 * 4 + 1];
        for packet in 0..4 {
            malformed[packet * 188] = 0x47;
        }
        let (base, server) = spawn_apprj_hls_fixture(HashMap::from([
            (
                "/malformed.m3u8",
                (
                    "200 OK",
                    None,
                    b"#EXTM3U\n#EXTINF:1,\n/malformed.ts\n#EXT-X-ENDLIST\n".to_vec(),
                ),
            ),
            ("/malformed.ts", ("200 OK", None, malformed.clone())),
        ]))
        .await;
        let error = verify_apprj_hls_media(
            &format!("{base}/malformed.m3u8"),
            &HeaderMap::new(),
            Duration::from_secs(2),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect_err("misaligned TS must fail");
        assert!(
            error.contains("not MPEG-TS"),
            "unexpected malformed TS error: {error}"
        );
        server.abort();
    }

    #[tokio::test]
    async fn apprj_player_preserves_the_line_user_agent_for_a_direct_media_url() {
        let result = call(
            LegacyHttpKind::AppRJ,
            "player",
            Some(&json!({
                "id": "第一集$|https://media.test/a.m3u8|fixture-agent|示例|ep-1"
            })),
            "https://example.test",
            &HeaderMap::new(),
            Duration::from_secs(1),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();

        assert_eq!(result["parse"], 0);
        assert_eq!(result["url"], "https://media.test/a.m3u8");
        assert_eq!(result["header"]["User-Agent"], "fixture-agent");
    }

    #[tokio::test]
    async fn apprj_player_rejects_a_dynamic_parse_chain() {
        let error = call(
            LegacyHttpKind::AppRJ,
            "player",
            Some(&json!({
                "id": "第一集$https://parse.test/?url=|https://origin.test/token|fixture-agent|示例|ep-1"
            })),
            "https://example.test",
            &HeaderMap::new(),
            Duration::from_secs(1),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error,
            LegacyHttpError::Unsupported(message)
                if message == "APPRJ_DYNAMIC_PLAYER_UNSUPPORTED"
        ));
    }

    #[test]
    fn duopan_catalog_prefers_the_detail_title_over_the_play_action_anchor() {
        let base = reqwest::Url::parse("http://tvpanpan.site").unwrap();
        let items = html_catalog_items(
            r#"
              <div class="module-item">
                <div class="module-item-pic">
                  <a href="/index.php/vod/detail/id/21279.html" title="立刻播放九门">
                    <i class="icon-play"></i>
                  </a>
                </div>
                <h3><a href="/index.php/vod/detail/id/21279.html" title="九门">九门</a></h3>
              </div>
            "#,
            &base,
            LegacyHttpKind::Duopan,
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["vod_name"], "九门");
    }

    #[tokio::test]
    #[ignore = "real AppRJ read/detail/player/transport canary; network-dependent"]
    async fn real_apprj_read_detail_player_transport_chain() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let headers = HeaderMap::new();
        let timeout = Duration::from_secs(20);
        let home = call(
            LegacyHttpKind::AppRJ,
            "home",
            None,
            "",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("AppRJ home");
        let classes = home["class"].as_array().cloned().unwrap_or_default();
        assert!(!classes.is_empty(), "AppRJ home returned no categories");

        let mut category_items = Vec::new();
        for class in classes.iter().take(8) {
            let Some(type_id) = class["type_id"].as_str() else {
                continue;
            };
            let category = match call(
                LegacyHttpKind::AppRJ,
                "category",
                Some(&json!({"typeId": type_id, "page": "1"})),
                "",
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("AppRJ category {type_id} failed: {error:?}");
                    continue;
                }
            };
            if let Some(items) = category["list"].as_array() {
                category_items.extend(items.iter().cloned().take(8));
            }
            if category_items.len() >= 8 {
                break;
            }
        }
        assert!(
            !category_items.is_empty(),
            "AppRJ categories returned no items"
        );

        let search_key = category_items
            .first()
            .and_then(|item| item["vod_name"].as_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("主角");
        let search = call(
            LegacyHttpKind::AppRJ,
            "search",
            Some(&json!({"key": search_key, "page": "1"})),
            "",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("AppRJ search");
        let mut candidates = search["list"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(category_items.iter())
            .filter_map(|item| item["vod_id"].as_str().map(str::to_string))
            .take(12)
            .collect::<Vec<_>>();
        candidates.dedup();

        let mut media_attempts = 0usize;
        let mut last_media_error = None;
        'candidates: for id in candidates {
            let detail = match call(
                LegacyHttpKind::AppRJ,
                "detail",
                Some(&json!({"ids": [id]})),
                "",
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("AppRJ detail {id} failed: {error:?}");
                    continue;
                }
            };
            let episodes = detail["vod_play_url"]
                .as_str()
                .into_iter()
                .flat_map(|value| value.split("$$$").flat_map(|line| line.split('#')))
                .filter(|episode| !episode.trim().is_empty())
                .take(48)
                .map(str::to_string)
                .collect::<Vec<_>>();
            for episode in episodes {
                let player = match call(
                    LegacyHttpKind::AppRJ,
                    "player",
                    Some(&json!({"id": episode})),
                    "",
                    &headers,
                    timeout,
                    cancelled.clone(),
                )
                .await
                {
                    Ok(value) => value,
                    Err(LegacyHttpError::Unsupported(message))
                        if message == "APPRJ_DYNAMIC_PLAYER_UNSUPPORTED" =>
                    {
                        continue
                    }
                    Err(error) => {
                        eprintln!("AppRJ player {id} failed: {error:?}");
                        continue;
                    }
                };
                assert_eq!(player["parse"], 0);
                assert_eq!(player["jx"], 0);
                let Some(media) = player["url"].as_str() else {
                    continue;
                };
                if media_attempts >= 8 {
                    break 'candidates;
                }
                media_attempts += 1;
                let mut player_headers = HeaderMap::new();
                if let Some(user_agent) = player["header"]["User-Agent"].as_str() {
                    player_headers.insert(
                        HeaderName::from_static("user-agent"),
                        HeaderValue::from_str(user_agent).expect("AppRJ player UA"),
                    );
                }
                let (_segment_url, segment_len, payload_offset) = match verify_apprj_hls_media(
                    media,
                    &player_headers,
                    timeout,
                    cancelled.clone(),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => {
                        eprintln!(
                                "AppRJ media candidate {media_attempts} failed; trying the next bounded candidate"
                            );
                        last_media_error = Some("media transport or validation failed");
                        continue;
                    }
                };
                eprintln!(
                    "AppRJ playback verified: detail={id}; media={}; first_segment_verified=true; bytes={segment_len}; wrapper_bytes={payload_offset}",
                    safe_media_url(media)
                );
                return;
            }
        }
        panic!(
            "AppRJ returned no readable media segment in {media_attempts} bounded attempts; last error: {}",
            last_media_error.as_deref().unwrap_or("no direct media URL")
        );
    }

    async fn verify_apprj_hls_media(
        media: &str,
        headers: &HeaderMap,
        timeout: Duration,
        cancelled: Arc<AtomicBool>,
    ) -> Result<(reqwest::Url, usize, usize), String> {
        let mut manifest_url =
            reqwest::Url::parse(media).map_err(|error| format!("media URL invalid: {error}"))?;
        for _ in 0..2 {
            let manifest = get_text(manifest_url.clone(), headers, timeout, cancelled.clone())
                .await
                .map_err(|error| format!("manifest request failed: {error:?}"))?;
            if !manifest.trim_start().starts_with("#EXTM3U") {
                return Err(format!(
                    "player URL did not return an HLS manifest: {}",
                    safe_media_url(manifest_url.as_str())
                ));
            }
            let Some(uri) = manifest
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty() && !line.starts_with('#'))
            else {
                return Err(format!(
                    "HLS manifest has no media URI: {}",
                    safe_media_url(manifest_url.as_str())
                ));
            };
            let next_url = manifest_url
                .join(uri)
                .map_err(|error| format!("HLS URI invalid: {error}"))?;
            if manifest.contains("#EXT-X-STREAM-INF") {
                manifest_url = next_url;
                continue;
            }
            if !manifest.contains("#EXTINF") {
                return Err("HLS playlist is neither master nor media".to_string());
            }
            let bytes =
                fetch_apprj_canary_segment(next_url.clone(), headers, timeout, cancelled).await?;
            let offset = mpeg_ts_payload_offset(&bytes).ok_or_else(|| {
                "first HLS media segment is not MPEG-TS or PNG-wrapped MPEG-TS".to_string()
            })?;
            return Ok((next_url, bytes.len(), offset));
        }
        Err("HLS playlist nesting exceeded the two-level canary bound".to_string())
    }

    fn mpeg_ts_payload_offset(bytes: &[u8]) -> Option<usize> {
        let is_ts = |offset: usize| {
            let payload = bytes.get(offset..).unwrap_or_default();
            payload.len() >= 188 * 4
                && payload.len() % 188 == 0
                && (0..4).all(|packet| payload[packet * 188] == 0x47)
        };
        if is_ts(0) {
            return Some(0);
        }
        let offset = png_payload_end(bytes)?;
        (offset <= 4 * 1024 && is_ts(offset)).then_some(offset)
    }

    fn png_payload_end(bytes: &[u8]) -> Option<usize> {
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return None;
        }
        let mut cursor = 8usize;
        while cursor.checked_add(12)? <= bytes.len() {
            let length = u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().ok()?) as usize;
            let kind = bytes.get(cursor + 4..cursor + 8)?;
            cursor = cursor.checked_add(12)?.checked_add(length)?;
            if cursor > bytes.len() {
                return None;
            }
            if kind == b"IEND" {
                return (length == 0).then_some(cursor);
            }
        }
        None
    }

    #[test]
    fn maps_static_html_catalogs_and_only_accepts_explicit_media_urls() {
        let base = reqwest::Url::parse("https://source.test").unwrap();
        let html = r#"
          <li><a href="/vod-detail-id-1.html" title="片名"><img src="/poster.jpg"></a></li>
          <h1>片名</h1><a href="/vod-play-id-1-src-1-num-1.html">第一集</a>
          <script>var src='https://media.test/episode.m3u8';</script>
        "#;
        let items = html_catalog_items(html, &base, LegacyHttpKind::Wwys);
        assert_eq!(items[0]["vod_name"], "片名");
        let div_items = html_catalog_items(
            r#"<div class="module-item"><a href="/watch/2" title="第二部"><img data-original="/poster-2.jpg"></a></div>"#,
            &base,
            LegacyHttpKind::Duopan,
        );
        assert_eq!(div_items[0]["vod_id"], "https://source.test/watch/2");
        assert_eq!(div_items[0]["vod_pic"], "https://source.test/poster-2.jpg");
        let classes = duopan_classes(
            r#"<a href="/index.php/vod/type/id/1.html">电影</a><a href="/index.php/vod/type/id/1.html">重复</a><a href="/index.php/vod/type/id/2.html">电视剧</a><a href="/index.php/vod/type/id/nope.html">忽略</a>"#,
        );
        assert_eq!(
            classes,
            vec![
                json!({"type_id":"1", "type_name":"电影"}),
                json!({"type_id":"2", "type_name":"电视剧"})
            ]
        );
        let wwys_div_items = html_catalog_items(
            r#"<div class="module-item"><a href="/watch/3"><span>第三部</span><img data-original="/poster-3.jpg"></a></div>"#,
            &base,
            LegacyHttpKind::Wwys,
        );
        assert_eq!(wwys_div_items[0]["vod_name"], "第三部");
        let detail = html_catalog_detail(
            html,
            &reqwest::Url::parse("https://source.test/vod-detail-id-1.html").unwrap(),
            LegacyHttpKind::Wwys,
        )
        .unwrap();
        assert_eq!(
            detail["list"][0]["vod_play_url"],
            "第一集$/vod-play-id-1-src-1-num-1.html"
        );
        assert_eq!(
            extract_html_media(html).as_deref(),
            Some("https://media.test/episode.m3u8")
        );
        assert_eq!(
            html_category_path(LegacyHttpKind::SaoHuo, "2", "3", None),
            "/list/2-3.html"
        );
        assert_eq!(
            html_category_path(LegacyHttpKind::Duopan, "1", "1", None),
            "/index.php/vod/type/id/1.html"
        );
        assert_eq!(
            html_category_path(LegacyHttpKind::Duopan, "1", "2", None),
            "/index.php/vod/type/id/1/page/2.html"
        );
        let duopan = configured_html_base(
            "",
            r#"{"site_urls":["https://duopan.test"],"url_key":"fixture"}"#,
        )
        .unwrap();
        assert_eq!(duopan.as_str(), "https://duopan.test/");
        let duopan_bases = configured_html_bases(
            "",
            r#"{"site_urls":["https://duopan.test/path","https://duopan.test/path","javascript:alert(1)","https://backup.test"]}"#,
        )
        .unwrap();
        assert_eq!(
            duopan_bases
                .iter()
                .map(reqwest::Url::as_str)
                .collect::<Vec<_>>(),
            vec!["https://duopan.test/path", "https://backup.test/"]
        );
    }

    #[test]
    fn maps_wwys_bare_detail_ids_and_czsapp_text_search_results() {
        let base = reqwest::Url::parse("https://source.test").unwrap();
        assert_eq!(
            html_detail_url(LegacyHttpKind::Wwys, &base, "42")
                .unwrap()
                .as_str(),
            "https://source.test/vod-detail-id-42.html"
        );
        assert_eq!(
            html_detail_url(
                LegacyHttpKind::Wwys,
                &base,
                "https://other.test/vod-detail-id-7.html",
            )
            .unwrap()
            .as_str(),
            "https://other.test/vod-detail-id-7.html"
        );

        let search_url = czsapp_search_url("测试 片").unwrap();
        assert_eq!(
            search_url.host_str(),
            Some("czzy.xn--m7r412advb92j21st65a.tk")
        );
        assert_eq!(search_url.path(), "/czzysearch.php");
        assert!(
            html_search_path(LegacyHttpKind::Czsapp, "测试 片").starts_with("/czzysearch.php?wd=")
        );
        assert_eq!(
            search_url
                .query_pairs()
                .find(|(name, _)| name == "wd")
                .map(|(_, value)| value.into_owned()),
            Some("测试 片".to_string())
        );

        let result = czsapp_search_items(
            "42|片名|https://img.test/42.jpg|更新至1集$$$broken|entry",
            &base,
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["vod_id"], "https://source.test/movie/42.html");
        assert_eq!(result[0]["vod_name"], "片名");
        assert_eq!(result[0]["vod_pic"], "https://img.test/42.jpg");
    }

    #[test]
    fn maps_czsapp_live_paths_filters_navigation_and_extracts_explicit_iframe_media() {
        let base = reqwest::Url::parse("https://www.czzy89.com").unwrap();
        assert_eq!(
            html_category_path(LegacyHttpKind::Czsapp, "movie_bt", "2", None),
            "/movie_bt/page/2"
        );
        assert_eq!(
            html_category_path(LegacyHttpKind::Czsapp, "2", "1", None),
            "/gcj/page/1"
        );
        let items = html_catalog_items(
            r#"
              <li><a href="/" title="首页">首页</a></li>
              <li><a href="/movie/42.html" title="片名"><img data-original="/poster.jpg"></a></li>
              <li><a href="/movie/43.html" title="回退片"><img data-original="" data-src="javascript:alert(1)" src="/poster-fallback.jpg"></a></li>
            "#,
            &base,
            LegacyHttpKind::Czsapp,
        );
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["vod_id"], "https://www.czzy89.com/movie/42.html");
        assert_eq!(
            items[1]["vod_pic"],
            "https://www.czzy89.com/poster-fallback.jpg"
        );
        let detail = html_catalog_detail(
            r#"
              <header><img src="/images/logo.png"></header>
              <h1>片名</h1>
              <div class="dyimg">
                <img data-original="posters/42.jpg" data-src="/fallback-lazy.jpg" src="/fallback.jpg">
              </div>
            "#,
            &reqwest::Url::parse("https://www.czzy89.com/movie/42.html").unwrap(),
            LegacyHttpKind::Czsapp,
        )
        .unwrap();
        assert_eq!(
            detail["list"][0]["vod_pic"],
            "https://www.czzy89.com/movie/posters/42.jpg"
        );
        let fallback_detail = html_catalog_detail(
            r#"
              <h1>片名</h1>
              <div class="dyimg">
                <img data-original="" data-src="javascript:alert(1)" src="/poster-fallback.jpg">
              </div>
            "#,
            &reqwest::Url::parse("https://www.czzy89.com/movie/42.html").unwrap(),
            LegacyHttpKind::Czsapp,
        )
        .unwrap();
        assert_eq!(
            fallback_detail["list"][0]["vod_pic"],
            "https://www.czzy89.com/poster-fallback.jpg"
        );
        assert_eq!(
            extract_czsapp_media(
                r#"<iframe src="https://plaa.py1080p.com:8181/player/py.php?code=cs&url=https://media.test/episode.m3u8"></iframe>"#
            )
            .as_deref(),
            Some("https://media.test/episode.m3u8")
        );
        assert!(extract_czsapp_media(
            r#"<iframe src="https://player.test/embed?url=javascript:alert(1)"></iframe>"#
        )
        .is_none());
    }

    #[tokio::test]
    async fn duopan_extracts_public_share_links_but_keeps_playback_auth_blocked() {
        let base = reqwest::Url::parse("https://duopan.test/detail/1").unwrap();
        let detail = html_catalog_detail(
            r#"
              <div class="video-info-header"><h1 class="page-title">网盘片名</h1></div>
              <a class="module-row-text copy" href="javascript:;" data-clipboard-text="https://pan.quark.cn/s/share-a"></a>
              <a class="module-row-text copy" href="javascript:;" data-clipboard-text="https://drive.uc.cn/s/share-b"></a>
            "#,
            &base,
            LegacyHttpKind::Duopan,
        )
        .unwrap();
        assert_eq!(detail["list"][0]["vod_play_from"], "网盘");
        assert_eq!(
            detail["list"][0]["vod_play_url"],
            "分享1$https://pan.quark.cn/s/share-a#分享2$https://drive.uc.cn/s/share-b"
        );

        let result = call(
            LegacyHttpKind::Duopan,
            "player",
            Some(&json!({"id": "https://media.test/should-not-play.m3u8"})),
            r#"{"site_urls":["https://duopan.test"]}"#,
            &HeaderMap::new(),
            Duration::from_secs(1),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        assert_eq!(result["status"], "AUTH_REQUIRED");
        assert_eq!(result["url"], "");
    }

    #[tokio::test]
    #[ignore = "real Duopan public HTML read/detail/share canary; network-dependent"]
    async fn real_duopan_read_detail_share_chain() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let headers = HeaderMap::new();
        let timeout = Duration::from_secs(20);
        let ext = std::env::var("QX_DUOPAN_CANARY_EXT").unwrap_or_else(|_| {
            r#"{"site_urls":["http://tvpanpan.site","http://feimo.fun","http://xiaocgege.shop","http://www.xiaocgege.shop","https://www.xiaocge.fun"],"url_key":"Duopan2"}"#.to_string()
        });
        let home = call(
            LegacyHttpKind::Duopan,
            "home",
            None,
            &ext,
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("Duopan home");
        let category = call(
            LegacyHttpKind::Duopan,
            "category",
            Some(&json!({"typeId":"1", "page":"1"})),
            &ext,
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("Duopan category");
        let search = call(
            LegacyHttpKind::Duopan,
            "search",
            Some(&json!({"key":"斗破苍穹"})),
            &ext,
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("Duopan search");
        let id = search["list"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(category["list"].as_array().into_iter().flatten())
            .chain(home["list"].as_array().into_iter().flatten())
            .find_map(|item| item["vod_id"].as_str().map(str::to_string))
            .expect("Duopan read methods must return an item");
        let detail = call(
            LegacyHttpKind::Duopan,
            "detail",
            Some(&json!({"ids":[id]})),
            &ext,
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("Duopan detail");
        let share = detail["list"][0]["vod_play_url"]
            .as_str()
            .and_then(|value| value.split('#').next())
            .and_then(|value| value.rsplit_once('$').map(|(_, url)| url.to_string()))
            .expect("Duopan detail must expose a public share URL");
        assert!(share.starts_with("http://") || share.starts_with("https://"));
        let player = call(
            LegacyHttpKind::Duopan,
            "player",
            Some(&json!({"id":share})),
            &ext,
            &headers,
            timeout,
            cancelled,
        )
        .await
        .expect("Duopan player boundary");
        assert_eq!(player["status"], "AUTH_REQUIRED");
        assert_eq!(player["url"], "");
        eprintln!("Duopan public read/detail verified: {id} -> {share}; cloud playback remains token-gated");
    }

    #[test]
    fn maps_dm84_html_contract() {
        let html = r#"
          <a href="/list-1.html">电影</a>
          <div class="item"><a class="cover" data-bg="/cover.jpg"></a><a class="title" href="/v/abc">标题</a><span class="desc">2026</span></div>
        "#;
        let home = dm84_home(html);
        assert_eq!(home["class"][0]["type_id"], "1");
        assert_eq!(home["class"][0]["type_name"], "电影");
        assert_eq!(
            dm84_items(html, &reqwest::Url::parse("https://dm84.tv").unwrap())[0]["vod_id"],
            "abc"
        );
        let detail = dm84_detail(
            r#"<h1 class="v_title">标题</h1><meta property="og:image" content="https://img.test/a.jpg"><ul class="tab_control"><li>线路</li></ul><ul class="play_list"><a href="/play/1">第一集</a></ul>"#,
            &reqwest::Url::parse("https://dm84.tv/v/abc").unwrap(),
        )
        .unwrap();
        assert_eq!(detail["list"][0]["vod_name"], "标题");
        assert_eq!(detail["list"][0]["vod_play_url"], "第一集$/play/1");
    }

    #[tokio::test]
    #[ignore = "real Dm84 publish/content/player canary; network-dependent"]
    async fn real_dm84_read_detail_player_chain() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let headers = HeaderMap::new();
        let timeout = Duration::from_secs(20);
        let home = call(
            LegacyHttpKind::Dm84,
            "home",
            None,
            "https://dm84.net",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("Dm84 home");
        let type_id = home["class"]
            .as_array()
            .and_then(|classes| classes.first())
            .and_then(|class| class["type_id"].as_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("1")
            .to_string();
        let category = call(
            LegacyHttpKind::Dm84,
            "category",
            Some(&json!({"typeId": type_id, "page": "1"})),
            "https://dm84.net",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("Dm84 category");
        let search = call(
            LegacyHttpKind::Dm84,
            "search",
            Some(&json!({"key": "海贼王"})),
            "https://dm84.net",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("Dm84 search");
        let id = search["list"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(category["list"].as_array().into_iter().flatten())
            .find_map(|item| item["vod_id"].as_str().map(str::to_string))
            .expect("Dm84 read methods must return an item");
        let detail = call(
            LegacyHttpKind::Dm84,
            "detail",
            Some(&json!({"ids": [id]})),
            "https://dm84.net",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("Dm84 detail");
        let episode = detail["list"][0]["vod_play_url"]
            .as_str()
            .and_then(|value| value.split('#').next())
            .and_then(|value| value.rsplit_once('$').map(|(_, url)| url.to_string()))
            .filter(|value| !value.is_empty())
            .expect("Dm84 detail must expose a page episode");
        let player = call(
            LegacyHttpKind::Dm84,
            "player",
            Some(&json!({"id": episode})),
            "https://dm84.net",
            &headers,
            timeout,
            cancelled,
        )
        .await
        .expect("Dm84 player");
        assert_eq!(player["parse"], 1);
        let url = player["url"].as_str().expect("Dm84 iframe URL");
        assert!(url.starts_with("http://") || url.starts_with("https://"));
        eprintln!("Dm84 page playback handoff verified: {id} -> {url}");
    }

    #[test]
    fn maps_kugou_html_contract() {
        let html = r#"<div class="pc_rank_sidebar"><ul><li><a href="https://song.test/1" title="歌一">歌一</a></li></ul></div><div class="pc_temp_title"><h3>榜单</h3></div><ul class="pc_temp_songlist"><li><a class="pc_temp_songname" href="https://song.test/1">歌一</a></li></ul>"#;
        assert_eq!(kugou_category_items(html, 0)[0]["vod_name"], "歌一");
        let detail = kugou_detail(
            html,
            &reqwest::Url::parse("https://www.kugou.com/rank").unwrap(),
        )
        .unwrap();
        assert_eq!(
            detail["list"][0]["vod_play_url"],
            "歌一$https://song.test/1"
        );

        let song = kugou_detail(
            r#"<script>var dataFromSmarty = [{"song_name":"单曲","author_name":"歌手"}],//页面歌曲信息</script>"#,
            &reqwest::Url::parse("https://www.kugou.com/mixsong/demo.html").unwrap(),
        )
        .unwrap();
        assert_eq!(song["list"][0]["vod_name"], "单曲");
        assert_eq!(song["list"][0]["vod_actor"], "歌手");
        assert_eq!(song["list"][0]["vod_play_url"], "");
    }

    #[tokio::test]
    #[ignore = "real source canary; network-dependent"]
    async fn real_kugou_category_chain() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let result = super::call(
            LegacyHttpKind::Kugou,
            "category",
            Some(&json!({"typeId": "6666|0"})),
            "",
            &HeaderMap::new(),
            Duration::from_secs(20),
            cancelled.clone(),
        )
        .await
        .unwrap();
        let id = result["list"][0]["vod_id"]
            .as_str()
            .expect("Kugou category must return an item");
        let detail = super::call(
            LegacyHttpKind::Kugou,
            "detail",
            Some(&json!({"ids": [id]})),
            "",
            &HeaderMap::new(),
            Duration::from_secs(20),
            cancelled.clone(),
        )
        .await
        .unwrap();
        assert!(detail["list"][0]["vod_name"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
    }

    #[tokio::test]
    #[ignore = "real source canary; network-dependent"]
    async fn real_pansearch_search_chain() {
        let result = super::call(
            LegacyHttpKind::PanSearch,
            "search",
            Some(&json!({"key": "流浪地球"})),
            "",
            &HeaderMap::new(),
            Duration::from_secs(20),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        assert!(result["list"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
    }

    #[tokio::test]
    #[ignore = "real SP360 read/detail/player page canary; network-dependent"]
    async fn real_sp360_read_detail_player_page_chain() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let headers = HeaderMap::new();
        let timeout = Duration::from_secs(20);
        let home = call(
            LegacyHttpKind::Sp360,
            "home",
            None,
            "",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("SP360 home");
        assert_eq!(home["class"][0]["type_id"], "1");
        let category = call(
            LegacyHttpKind::Sp360,
            "category",
            Some(&json!({"typeId": "1", "page": 1})),
            "",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("SP360 category");
        let search = call(
            LegacyHttpKind::Sp360,
            "search",
            Some(&json!({"key": "流浪地球", "page": 1})),
            "",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("SP360 search");
        assert!(home["list"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
        assert!(category["list"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
        let search_items = search["list"].as_array().expect("SP360 search list");
        assert!(!search_items.is_empty(), "SP360 search must return an item");
        let mut page_headers = HeaderMap::new();
        page_headers.insert(
            reqwest::header::USER_AGENT,
            HeaderValue::from_static(SP360_UA),
        );
        page_headers.insert(
            reqwest::header::REFERER,
            HeaderValue::from_static(SP360_REFERER),
        );
        let mut selected = None;
        'search_results: for item in search_items.iter().take(12) {
            let Some(id) = item["vod_id"].as_str().map(str::to_string) else {
                continue;
            };
            let Ok(detail) = call(
                LegacyHttpKind::Sp360,
                "detail",
                Some(&json!({"ids": [id.clone()]})),
                "",
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            else {
                continue;
            };
            let Some(episodes) = detail["list"][0]["vod_play_url"].as_str() else {
                continue;
            };
            for episode in episodes
                .split("$$$")
                .flat_map(|group| group.split('#'))
                .take(24)
            {
                let Ok(player) = call(
                    LegacyHttpKind::Sp360,
                    "player",
                    Some(&json!({"id": episode})),
                    "",
                    &headers,
                    timeout,
                    cancelled.clone(),
                )
                .await
                else {
                    continue;
                };
                let Some(page_url) = player["url"]
                    .as_str()
                    .and_then(|value| reqwest::Url::parse(value).ok())
                else {
                    continue;
                };
                let Ok(page) =
                    fetch_canary_bytes(page_url.clone(), &page_headers, timeout, cancelled.clone())
                        .await
                else {
                    continue;
                };
                if page.is_empty() {
                    continue;
                }
                selected = Some((id, player, page_url, page.len()));
                break 'search_results;
            }
        }
        let (id, player, page_url, page_size) =
            selected.expect("SP360 search result must expose a reachable provider page");
        assert_eq!(player["parse"], 1);
        assert_eq!(player["header"]["User-Agent"], SP360_UA);
        assert_eq!(player["header"]["Referer"], SP360_REFERER);
        assert!(player["url"].as_str().is_some_and(|value| {
            value.starts_with("http://") || value.starts_with("https://")
        }));
        eprintln!(
            "SP360 page playback verified: {id} -> {}{} ({} bytes)",
            page_url.host_str().unwrap_or("<missing>"),
            page_url.path(),
            page_size
        );
    }

    #[tokio::test]
    #[ignore = "real YGP read/detail/direct-mp4 canary; network-dependent"]
    async fn real_ygp_read_detail_player_media_chain() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let headers = HeaderMap::new();
        let timeout = Duration::from_secs(20);
        let home = call(
            LegacyHttpKind::Ygp,
            "home",
            None,
            "",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("YGP home");
        assert_eq!(home["class"][0]["type_id"], "movlist/");
        assert!(
            home["list"]
                .as_array()
                .is_some_and(|items| !items.is_empty()),
            "YGP home returned no items"
        );
        let category = call(
            LegacyHttpKind::Ygp,
            "category",
            Some(&json!({"typeId":"movlist/", "page":"1"})),
            "",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("YGP category");
        assert!(
            category["list"]
                .as_array()
                .is_some_and(|items| !items.is_empty()),
            "YGP category returned no items"
        );
        let search = call(
            LegacyHttpKind::Ygp,
            "search",
            Some(&json!({"key":"机器人总动员"})),
            "",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("YGP search");
        let search_items = search["list"].as_array().expect("YGP search list");
        assert!(!search_items.is_empty(), "YGP search returned no items");

        let mut selected = None;
        for item in search_items.iter().take(12) {
            let Some(id) = item["vod_id"].as_str() else {
                continue;
            };
            let detail = match call(
                LegacyHttpKind::Ygp,
                "detail",
                Some(&json!({"ids":[id]})),
                "",
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("YGP detail {id} failed: {error:?}");
                    continue;
                }
            };
            let Some(episode) = detail["list"][0]["vod_play_url"]
                .as_str()
                .and_then(|value| value.split('#').next())
                .and_then(|value| value.rsplit_once('$').map(|(_, url)| url.to_string()))
            else {
                continue;
            };
            let player = match call(
                LegacyHttpKind::Ygp,
                "player",
                Some(&json!({"id":episode})),
                "",
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("YGP player {id} failed: {error:?}");
                    continue;
                }
            };
            assert_eq!(player["parse"], 0);
            assert_eq!(player["jx"], 0);
            assert_eq!(player["header"]["User-Agent"], YGP_UA);
            assert!(player["header"].get("Referer").is_none());
            let media = player["url"].as_str().expect("YGP media URL");
            assert!(media.ends_with(".mp4"));
            let media_url = reqwest::Url::parse(media).expect("YGP media URL parses");
            let mut media_headers = HeaderMap::new();
            media_headers.insert(
                HeaderName::from_static("user-agent"),
                HeaderValue::from_static(YGP_UA),
            );
            media_headers.insert(
                HeaderName::from_static("range"),
                HeaderValue::from_static("bytes=0-31"),
            );
            let bytes =
                match fetch_canary_bytes(media_url, &media_headers, timeout, cancelled.clone())
                    .await
                {
                    Ok(value) => value,
                    Err(error) => {
                        eprintln!("YGP media prefix for {id} failed: {error}");
                        continue;
                    }
                };
            assert!(bytes.len() >= 8);
            assert_eq!(&bytes[4..8], b"ftyp");
            eprintln!(
                "YGP search-result playback verified: {id}; media_prefix_bytes={}",
                bytes.len()
            );
            selected = Some(id.to_string());
            break;
        }
        assert!(selected.is_some(), "YGP search returned no playable item");
    }

    #[tokio::test]
    #[ignore = "real TuXiaoBei JSONP/detail/direct-mp4 canary; network-dependent"]
    async fn real_tuxiaobei_read_detail_player_media_chain() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let headers = HeaderMap::new();
        let timeout = Duration::from_secs(20);
        let home = call(
            LegacyHttpKind::TuXiaoBei,
            "home",
            None,
            "",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("TuXiaoBei home");
        assert_eq!(home["class"][0]["type_id"], "2");
        let search = call(
            LegacyHttpKind::TuXiaoBei,
            "search",
            Some(&json!({"key": "江南style"})),
            "",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("TuXiaoBei search");
        let search_items = search["list"].as_array().expect("TuXiaoBei search list");
        assert!(
            !search_items.is_empty(),
            "TuXiaoBei search returned no items"
        );

        let category = call(
            LegacyHttpKind::TuXiaoBei,
            "category",
            Some(&json!({"typeId": "2", "page": "1"})),
            "",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("TuXiaoBei category");
        assert!(
            category["list"]
                .as_array()
                .is_some_and(|items| !items.is_empty()),
            "TuXiaoBei category returned no items"
        );

        let mut selected = None;
        for item in search_items.iter().take(12) {
            let Some(id) = item["vod_id"].as_str() else {
                continue;
            };
            let detail = match call(
                LegacyHttpKind::TuXiaoBei,
                "detail",
                Some(&json!({"ids": [id]})),
                "",
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("TuXiaoBei detail {id} failed: {error:?}");
                    continue;
                }
            };
            let Some(episode) = detail["list"][0]["vod_play_url"]
                .as_str()
                .and_then(|value| value.split('#').next())
            else {
                continue;
            };
            let player = match call(
                LegacyHttpKind::TuXiaoBei,
                "player",
                Some(&json!({"id": episode})),
                "",
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("TuXiaoBei player {id} failed: {error:?}");
                    continue;
                }
            };
            assert_eq!(player["parse"], 0);
            assert_eq!(player["jx"], 0);
            assert_eq!(player["header"]["User-Agent"], TUXIAOBEI_UA);
            assert_eq!(player["header"]["Referer"], TUXIAOBEI_BASE);
            let media = player["url"].as_str().expect("TuXiaoBei media URL");
            assert!(media.ends_with(".mp4"));
            let mut media_headers = HeaderMap::new();
            media_headers.insert(
                HeaderName::from_static("user-agent"),
                HeaderValue::from_static(TUXIAOBEI_UA),
            );
            media_headers.insert(
                HeaderName::from_static("referer"),
                HeaderValue::from_static(TUXIAOBEI_BASE),
            );
            media_headers.insert(
                HeaderName::from_static("range"),
                HeaderValue::from_static("bytes=0-31"),
            );
            let bytes = fetch_canary_bytes(
                reqwest::Url::parse(media).expect("TuXiaoBei media URL parses"),
                &media_headers,
                timeout,
                cancelled.clone(),
            )
            .await
            .expect("TuXiaoBei media range");
            assert!(bytes.len() >= 8);
            assert_eq!(&bytes[4..8], b"ftyp");
            eprintln!("TuXiaoBei direct media playback verified: {id} -> {media}");
            selected = Some(());
            break;
        }
        assert!(
            selected.is_some(),
            "TuXiaoBei search returned no playable item"
        );
    }

    #[tokio::test]
    #[ignore = "real GuaziTY multi-category/detail/player canary; network-dependent"]
    async fn real_guazi_ty_multi_category_detail_player_chain() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let headers = HeaderMap::new();
        let home = call(
            LegacyHttpKind::GuaziTy,
            "home",
            None,
            "",
            &headers,
            Duration::from_secs(20),
            cancelled.clone(),
        )
        .await
        .expect("GuaziTY home");
        assert_eq!(home["class"][0]["type_id"], "hot");
        let mut last_error = None;
        for type_id in ["basketball", "hot", "nba", "football"] {
            let category = match call(
                LegacyHttpKind::GuaziTy,
                "category",
                Some(&json!({"typeId": type_id, "page": "1"})),
                "",
                &headers,
                Duration::from_secs(20),
                cancelled.clone(),
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    last_error = Some(format!("{type_id} category: {error:?}"));
                    continue;
                }
            };
            let items = category["list"].as_array().cloned().unwrap_or_default();
            for item in items.into_iter().take(12) {
                let Some(id) = item["vod_id"].as_str() else {
                    continue;
                };
                let detail = match call(
                    LegacyHttpKind::GuaziTy,
                    "detail",
                    Some(&json!({"ids": [id]})),
                    "",
                    &headers,
                    Duration::from_secs(20),
                    cancelled.clone(),
                )
                .await
                {
                    Ok(value) => value,
                    Err(error) => {
                        last_error = Some(format!("{type_id}/{id} detail: {error:?}"));
                        continue;
                    }
                };
                let episodes = detail["list"][0]["vod_play_url"]
                    .as_str()
                    .map(|value| {
                        value
                            .split('#')
                            .filter(|episode| !episode.trim().is_empty())
                            .take(4)
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                for episode in episodes {
                    let player = match call(
                        LegacyHttpKind::GuaziTy,
                        "player",
                        Some(&json!({"id": episode})),
                        "",
                        &headers,
                        Duration::from_secs(20),
                        cancelled.clone(),
                    )
                    .await
                    {
                        Ok(value) => value,
                        Err(error) => {
                            last_error = Some(format!("{type_id}/{id} player: {error:?}"));
                            continue;
                        }
                    };
                    assert_eq!(player["parse"], 0);
                    assert_eq!(player["jx"], 0);
                    assert_eq!(player["header"]["User-Agent"], GUAZI_PLAYER_UA);
                    assert_eq!(player["header"]["Referer"], GUAZI_PLAYER_REFERER);
                    let Some(media) = player["url"].as_str().filter(|value| {
                        value.starts_with("http://") || value.starts_with("https://")
                    }) else {
                        last_error = Some(format!("{type_id}/{id} player: media URL missing"));
                        continue;
                    };
                    let mut media_headers = headers.clone();
                    media_headers.insert(
                        HeaderName::from_static("user-agent"),
                        HeaderValue::from_static(GUAZI_PLAYER_UA),
                    );
                    media_headers.insert(
                        HeaderName::from_static("referer"),
                        HeaderValue::from_static(GUAZI_PLAYER_REFERER),
                    );
                    let (segment_url, segment_len) = match verify_guazi_hls_media(
                        media,
                        &media_headers,
                        Duration::from_secs(20),
                        cancelled.clone(),
                    )
                    .await
                    {
                        Ok(result) => result,
                        Err(error) => {
                            last_error = Some(format!("{type_id}/{id} media: {error}"));
                            continue;
                        }
                    };
                    eprintln!(
                        "GuaziTY playable event found in {type_id}: {id} -> {}; first media {} ({} bytes)",
                        safe_media_url(media),
                        safe_media_url(segment_url.as_str()),
                        segment_len
                    );
                    return;
                }
            }
        }
        panic!(
            "GuaziTY upstream currently exposes no playable live_line; last bounded result: {}",
            last_error.unwrap_or_else(|| "all categories empty or filtered".to_string())
        );
    }

    fn safe_media_url(value: &str) -> String {
        let Ok(mut url) = reqwest::Url::parse(value) else {
            return "<invalid-url>".to_string();
        };
        url.set_query(None);
        url.set_fragment(None);
        url.to_string()
    }

    async fn verify_guazi_hls_media(
        media: &str,
        headers: &HeaderMap,
        timeout: Duration,
        cancelled: Arc<AtomicBool>,
    ) -> Result<(reqwest::Url, usize), String> {
        let mut manifest_url =
            reqwest::Url::parse(media).map_err(|error| format!("media URL invalid: {error}"))?;
        if !matches!(manifest_url.scheme(), "http" | "https")
            || !manifest_url.username().is_empty()
            || manifest_url.password().is_some()
        {
            return Err("media URL is not a credential-free HTTP(S) URL".to_string());
        }
        let mut manifest = get_text(manifest_url.clone(), headers, timeout, cancelled.clone())
            .await
            .map_err(|error| format!("manifest request failed: {error:?}"))?;
        for _ in 0..2 {
            if !manifest.trim_start().starts_with("#EXTM3U") {
                return Err(format!(
                    "player URL did not return an HLS manifest: {}",
                    safe_media_url(manifest_url.as_str())
                ));
            }
            let Some(uri) = manifest
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty() && !line.starts_with('#'))
            else {
                return Err(format!(
                    "HLS manifest has no media URI: {}",
                    safe_media_url(manifest_url.as_str())
                ));
            };
            let next_url = manifest_url
                .join(uri)
                .map_err(|error| format!("HLS URI invalid: {error}"))?;
            if !matches!(next_url.scheme(), "http" | "https")
                || !next_url.username().is_empty()
                || next_url.password().is_some()
            {
                return Err("HLS URI is not a credential-free HTTP(S) URL".to_string());
            }
            let nested_playlist = next_url.path().to_ascii_lowercase().ends_with(".m3u8")
                || manifest.contains("#EXT-X-STREAM-INF");
            if nested_playlist {
                manifest_url = next_url;
                manifest = get_text(manifest_url.clone(), headers, timeout, cancelled.clone())
                    .await
                    .map_err(|error| format!("nested manifest request failed: {error:?}"))?;
                continue;
            }
            let bytes = fetch_canary_bytes(next_url.clone(), headers, timeout, cancelled).await?;
            if bytes.is_empty() {
                return Err("first HLS media segment is empty".to_string());
            }
            return Ok((next_url, bytes.len()));
        }
        Err("HLS playlist nesting exceeded the two-level canary bound".to_string())
    }

    #[tokio::test]
    #[ignore = "real Gz360 read/detail/player canary; network-dependent"]
    async fn real_gz360_read_detail_player_chain() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let headers = HeaderMap::new();
        let timeout = Duration::from_secs(20);
        let home = call(
            LegacyHttpKind::Gz360,
            "home",
            None,
            "",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("Gz360 home");
        let search = call(
            LegacyHttpKind::Gz360,
            "search",
            Some(&json!({"key": "九门", "page": 1, "pageSize": 4})),
            "",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .expect("Gz360 search");
        assert!(search["list"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
        let category_ids = home["class"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| item["type_id"].as_str())
            .take(8)
            .map(str::to_string)
            .collect::<Vec<_>>();
        assert!(
            !category_ids.is_empty(),
            "Gz360 home returned no categories"
        );

        let mut last_error = None;
        for type_id in category_ids {
            let category = match call(
                LegacyHttpKind::Gz360,
                "category",
                Some(&json!({"typeId": type_id, "page": 1, "pageSize": 8})),
                "",
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    last_error = Some(format!("{type_id} category: {error:?}"));
                    continue;
                }
            };
            for item in category["list"].as_array().into_iter().flatten().take(8) {
                let Some(id) = item["vod_id"].as_str() else {
                    continue;
                };
                let detail = match call(
                    LegacyHttpKind::Gz360,
                    "detail",
                    Some(&json!({"ids": [id]})),
                    "",
                    &headers,
                    timeout,
                    cancelled.clone(),
                )
                .await
                {
                    Ok(value) => value,
                    Err(error) => {
                        last_error = Some(format!("{type_id}/{id} detail: {error:?}"));
                        continue;
                    }
                };
                let Some(episode) = detail["list"][0]["vod_play_url"]
                    .as_str()
                    .and_then(|value| value.split('#').find(|episode| !episode.trim().is_empty()))
                else {
                    continue;
                };
                let player = call(
                    LegacyHttpKind::Gz360,
                    "player",
                    Some(&json!({"id": episode})),
                    "",
                    &headers,
                    timeout,
                    cancelled.clone(),
                )
                .await
                .expect("Gz360 player");
                assert_eq!(player["parse"], 0);
                assert_eq!(player["jx"], 0);
                assert_eq!(player["header"]["User-Agent"], GZ360_UA);
                assert_eq!(player["header"]["Referer"], GZ360_REFERER);
                let Some(media) = player["url"]
                    .as_str()
                    .filter(|value| value.starts_with("http://") || value.starts_with("https://"))
                else {
                    last_error = Some(format!("{type_id}/{id} player: media URL missing"));
                    continue;
                };
                let mut media_headers = headers.clone();
                media_headers.insert(
                    HeaderName::from_static("user-agent"),
                    HeaderValue::from_static(GZ360_UA),
                );
                media_headers.insert(
                    HeaderName::from_static("referer"),
                    HeaderValue::from_static(GZ360_REFERER),
                );
                let (segment_url, segment_len) =
                    match verify_guazi_hls_media(media, &media_headers, timeout, cancelled.clone())
                        .await
                    {
                        Ok(result) => result,
                        Err(error) => {
                            last_error = Some(format!("{type_id}/{id} media: {error}"));
                            continue;
                        }
                    };
                eprintln!(
                    "Gz360 playable item found in {type_id}: {id} -> {}; first media {} ({} bytes)",
                    safe_media_url(media),
                    safe_media_url(segment_url.as_str()),
                    segment_len
                );
                return;
            }
        }
        panic!(
            "Gz360 returned no bounded detail with an explicit playable URL: {}",
            last_error.unwrap_or_else(|| "all categories empty or filtered".to_string())
        );
    }

    #[tokio::test]
    #[ignore = "real Czsapp read/detail/player segment canary; network-dependent"]
    async fn real_czsapp_read_detail_player_segment_chain() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let headers = HeaderMap::new();
        let timeout = Duration::from_secs(20);
        let home = call(
            LegacyHttpKind::Czsapp,
            "home",
            None,
            "",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .unwrap_or_else(|error| {
            panic!("Czsapp home is blocked or unavailable from Rust: {error:?}")
        });
        assert!(home["list"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
        let category = call(
            LegacyHttpKind::Czsapp,
            "category",
            Some(&json!({"typeId": "movie_bt", "page": "1"})),
            "",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .unwrap_or_else(|error| {
            panic!("Czsapp category is blocked or unavailable from Rust: {error:?}")
        });
        assert!(category["list"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
        let search = call(
            LegacyHttpKind::Czsapp,
            "search",
            Some(&json!({"key": "九门"})),
            "",
            &headers,
            timeout,
            cancelled.clone(),
        )
        .await
        .unwrap_or_else(|error| {
            panic!("Czsapp search is blocked or unavailable from Rust: {error:?}")
        });
        let mut candidates = search["list"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(category["list"].as_array().into_iter().flatten())
            .filter_map(|item| item["vod_id"].as_str().map(str::to_string))
            .take(10)
            .collect::<Vec<_>>();
        candidates.dedup();
        let mut last_error = None;
        for id in candidates {
            let detail = match call(
                LegacyHttpKind::Czsapp,
                "detail",
                Some(&json!({"ids": [id]})),
                "",
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    last_error = Some(format!("{id} detail: {error:?}"));
                    continue;
                }
            };
            let Some(episode) = detail["list"][0]["vod_play_url"]
                .as_str()
                .and_then(|value| value.split('#').find(|item| !item.trim().is_empty()))
            else {
                continue;
            };
            let player = match call(
                LegacyHttpKind::Czsapp,
                "player",
                Some(&json!({"id": episode})),
                "",
                &headers,
                timeout,
                cancelled.clone(),
            )
            .await
            {
                Ok(value) => value,
                Err(error) => {
                    last_error = Some(format!("{id} player: {error:?}"));
                    continue;
                }
            };
            assert_eq!(player["parse"], 0);
            let Some(media) = player["url"].as_str() else {
                continue;
            };
            let (segment_url, segment_len) =
                match verify_guazi_hls_media(media, &headers, timeout, cancelled.clone()).await {
                    Ok(value) => value,
                    Err(error) => {
                        last_error = Some(format!("{id} media: {error}"));
                        continue;
                    }
                };
            eprintln!(
                "Czsapp explicit HLS segment found: {id} -> {} ({segment_len} bytes)",
                safe_media_url(segment_url.as_str())
            );
            return;
        }
        panic!(
            "Czsapp returned no bounded detail with a readable HLS segment: {}",
            last_error.unwrap_or_else(|| "all candidates empty or filtered".to_string())
        );
    }
}
