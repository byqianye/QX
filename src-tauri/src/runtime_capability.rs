use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilityPayload {
    pub api: String,
    pub ext: Option<String>,
    pub script_bytes: Option<u64>,
    pub allowed_origins: Option<Vec<String>>,
    pub artifact_name: Option<String>,
    pub artifact_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilitySnapshot {
    pub runtime: String,
    pub supported: bool,
    pub reason_code: String,
    pub capabilities: RuntimeCapabilities,
    pub asset_classification: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub home: bool,
    pub category: bool,
    pub search: bool,
    pub detail: bool,
    pub player: bool,
}

pub fn probe(payload: &RuntimeCapabilityPayload) -> RuntimeCapabilitySnapshot {
    let api = payload.api.trim();
    let asset_classification = classify_artifact(
        payload.artifact_name.as_deref(),
        payload.artifact_base64.as_deref(),
    );
    if api.eq_ignore_ascii_case("csp_Douban") {
        return with_asset(
            supported(
                "native",
                "native_douban_supported",
                true,
                true,
                true,
                true,
                false,
            ),
            asset_classification,
        );
    }
    if api.eq_ignore_ascii_case("csp_Jianpian") {
        if payload
            .ext
            .as_deref()
            .is_some_and(|ext| !ext.trim().is_empty())
        {
            return with_asset(
                supported(
                    "native",
                    "native_jianpian_supported",
                    true,
                    true,
                    true,
                    true,
                    true,
                ),
                asset_classification,
            );
        }
        return with_asset(
            unsupported("native", "native_jianpian_ext_required"),
            asset_classification,
        );
    }
    let quickjs_reference = api.to_ascii_lowercase();
    if matches!(
        super::legacy_http::kind_for(api, payload.ext.as_deref().unwrap_or_default()),
        Some(super::legacy_http::LegacyHttpKind::TuXiaoBei)
    ) {
        let capabilities =
            super::legacy_http::capabilities(super::legacy_http::LegacyHttpKind::TuXiaoBei);
        return with_asset(
            supported(
                "http-json-jsonp-html",
                "legacy_http_contract_supported",
                capabilities.home,
                capabilities.category,
                capabilities.search,
                capabilities.detail,
                capabilities.playback,
            ),
            asset_classification,
        );
    }
    if quickjs_reference.starts_with("js:")
        || quickjs_reference.ends_with(".js")
        || quickjs_reference.ends_with(".mjs")
        || quickjs_reference.contains(".js?")
        || quickjs_reference.contains(".mjs?")
    {
        let size_ok = payload.script_bytes.unwrap_or(0) <= 1024 * 1024;
        let policy_present = payload.allowed_origins.is_some();
        let origins_ok = payload
            .allowed_origins
            .as_ref()
            .is_some_and(|origins| !quickjs_reference.starts_with("http") || !origins.is_empty());
        if size_ok && policy_present && origins_ok {
            return with_asset(
                supported_runtime("quickjs-sidecar", "quickjs_sidecar_supported"),
                asset_classification,
            );
        }
        return with_asset(
            unsupported("quickjs-sidecar", "quickjs_policy_requirements_missing"),
            asset_classification,
        );
    }
    if api.starts_with("http://") || api.starts_with("https://") {
        return with_asset(
            supported(
                "cms-http",
                "cms_http_supported",
                true,
                true,
                true,
                true,
                true,
            ),
            asset_classification,
        );
    }
    if super::app_get::is_python_wrapper_api(api) {
        let ext = payload.ext.as_deref().unwrap_or_default();
        return with_asset(
            match super::app_get::from_python_wrapper_ext(api, ext) {
                Ok(Some(_config)) => {
                    let capabilities = super::app_get::capabilities_for("csp_AppGet");
                    supported(
                        &capabilities.engine,
                        "appget_python_wrapper_supported",
                        capabilities.home,
                        capabilities.category,
                        capabilities.search,
                        capabilities.detail,
                        capabilities.playback,
                    )
                }
                Ok(None) | Err(_) => unsupported("http-appget", "appget_python_wrapper_invalid"),
            },
            asset_classification,
        );
    }
    if api.starts_with("py:") || api.ends_with(".py") {
        return with_asset(
            unsupported("python", "python_runtime_disabled_in_tauri"),
            asset_classification,
        );
    }
    if api.starts_with("csp_") {
        if api.eq_ignore_ascii_case("csp_Config") {
            return with_asset(
                unsupported("local-config", "config_source_local_only"),
                asset_classification,
            );
        }
        if payload.ext.as_deref().unwrap_or_default().trim().is_empty()
            && super::first_aid::is_supported(api)
        {
            let capabilities = super::first_aid::capabilities();
            return with_asset(
                supported(
                    "http-html",
                    "first_aid_html_contract_supported",
                    capabilities.home,
                    capabilities.category,
                    capabilities.search,
                    capabilities.detail,
                    capabilities.playback,
                ),
                asset_classification,
            );
        }
        if super::bili::is_supported(api) {
            let capabilities = super::bili::capabilities();
            return with_asset(
                supported(
                    "http-json",
                    "bili_http_contract_supported",
                    capabilities.home,
                    capabilities.category,
                    capabilities.search,
                    capabilities.detail,
                    capabilities.playback,
                ),
                asset_classification,
            );
        }
        if super::push_source::is_supported(api) {
            let capabilities = super::push_source::capabilities();
            return with_asset(
                supported(
                    "http-push",
                    "push_http_contract_supported",
                    capabilities.home,
                    capabilities.category,
                    capabilities.search,
                    capabilities.detail,
                    capabilities.playback,
                ),
                asset_classification,
            );
        }
        if super::misou::is_supported(api) {
            let capabilities = super::misou::capabilities();
            return with_asset(
                supported(
                    &capabilities.engine,
                    "misou_http_search_contract_supported",
                    capabilities.home,
                    capabilities.category,
                    capabilities.search,
                    capabilities.detail,
                    capabilities.playback,
                ),
                asset_classification,
            );
        }
        if let Some(kind) =
            super::legacy_http::kind_for(api, payload.ext.as_deref().unwrap_or_default())
        {
            let capabilities = super::legacy_http::capabilities(kind);
            let runtime = match kind {
                super::legacy_http::LegacyHttpKind::AppRJ => "http-json-multipart",
                super::legacy_http::LegacyHttpKind::Jpys => "http-json-signed",
                super::legacy_http::LegacyHttpKind::Kanqiu => "http-html-json",
                super::legacy_http::LegacyHttpKind::PanSearch => "http-json-html",
                super::legacy_http::LegacyHttpKind::GuaziTy => "http-json-aes",
                super::legacy_http::LegacyHttpKind::Gz360 => "http-json-aes",
                super::legacy_http::LegacyHttpKind::Sp360 => "http-json-jsonp",
                super::legacy_http::LegacyHttpKind::TuXiaoBei => "http-json-jsonp-html",
                _ => "http-html",
            };
            return with_asset(
                supported(
                    runtime,
                    "legacy_http_contract_supported",
                    capabilities.home,
                    capabilities.category,
                    capabilities.search,
                    capabilities.detail,
                    capabilities.playback,
                ),
                asset_classification,
            );
        }
        if let Some(ext) = payload.ext.as_deref() {
            if super::app_get::is_supported(api) {
                match super::app_get::from_ext_for(api, ext) {
                    Ok(Some(_)) => {
                        let capabilities = super::app_get::capabilities_for(api);
                        return with_asset(
                            supported(
                                &capabilities.engine,
                                if api.eq_ignore_ascii_case("csp_AppQi") {
                                    "appqi_http_contract_supported"
                                } else {
                                    "appget_http_contract_supported"
                                },
                                capabilities.home,
                                capabilities.category,
                                capabilities.search,
                                capabilities.detail,
                                capabilities.playback,
                            ),
                            asset_classification,
                        );
                    }
                    Err(_) => {
                        return with_asset(
                            unsupported(
                                if api.eq_ignore_ascii_case("csp_AppQi") {
                                    "http-appqi"
                                } else {
                                    "http-appget"
                                },
                                if api.eq_ignore_ascii_case("csp_AppQi") {
                                    "appqi_http_contract_invalid"
                                } else {
                                    "appget_http_contract_invalid"
                                },
                            ),
                            asset_classification,
                        );
                    }
                    Ok(None) => {}
                }
            }
            if let Ok(adapter) = super::source_converter::compile_source_spec(api, ext) {
                return with_asset(
                    supported(
                        "http-adapter",
                        "declarative_http_adapter_supported",
                        adapter.supports("home"),
                        adapter.supports("category"),
                        adapter.supports("search"),
                        adapter.supports("detail"),
                        adapter.supports("player")
                            || adapter.supports("playback")
                            || super::source_semantics::supports_direct_playback(api),
                    ),
                    asset_classification,
                );
            }
            if super::auto_http::endpoint_from_ext(api, ext).is_some() {
                return with_asset(
                    supported(
                        "http-auto",
                        "bounded_cms_http_candidate",
                        true,
                        true,
                        true,
                        true,
                        super::source_semantics::supports_direct_playback(api),
                    ),
                    asset_classification,
                );
            }
        }
        return with_asset(
            unsupported("unknown", "spider_artifact_not_declared"),
            asset_classification,
        );
    }
    with_asset(
        unsupported("unknown", "unsupported_site_type"),
        asset_classification,
    )
}

fn supported(
    runtime: &str,
    reason_code: &str,
    home: bool,
    category: bool,
    search: bool,
    detail: bool,
    player: bool,
) -> RuntimeCapabilitySnapshot {
    RuntimeCapabilitySnapshot {
        runtime: runtime.to_string(),
        supported: true,
        reason_code: reason_code.to_string(),
        capabilities: RuntimeCapabilities {
            home,
            category,
            search,
            detail,
            player,
        },
        asset_classification: None,
    }
}

fn unsupported(runtime: &str, reason_code: &str) -> RuntimeCapabilitySnapshot {
    RuntimeCapabilitySnapshot {
        runtime: runtime.to_string(),
        supported: false,
        reason_code: reason_code.to_string(),
        capabilities: RuntimeCapabilities {
            home: false,
            category: false,
            search: false,
            detail: false,
            player: false,
        },
        asset_classification: None,
    }
}

fn supported_runtime(runtime: &str, reason_code: &str) -> RuntimeCapabilitySnapshot {
    RuntimeCapabilitySnapshot {
        runtime: runtime.to_string(),
        supported: true,
        reason_code: reason_code.to_string(),
        capabilities: RuntimeCapabilities {
            home: false,
            category: false,
            search: false,
            detail: false,
            player: false,
        },
        asset_classification: None,
    }
}

fn with_asset(
    mut snapshot: RuntimeCapabilitySnapshot,
    classification: Option<String>,
) -> RuntimeCapabilitySnapshot {
    snapshot.asset_classification = classification;
    snapshot
}

fn classify_artifact(name: Option<&str>, encoded: Option<&str>) -> Option<String> {
    let Some(name) = name else {
        return None;
    };
    let bytes = match encoded {
        Some(value) => match STANDARD.decode(value) {
            Ok(bytes) => bytes,
            Err(_) => return Some("artifact_invalid_base64".to_string()),
        },
        None => Vec::new(),
    };
    let png_name = name.to_ascii_lowercase().ends_with(".png");
    let png_header = bytes.starts_with(b"\x89PNG\r\n\x1a\n");
    let dex_marker = bytes.windows(11).any(|window| window == b"classes.dex")
        || bytes.windows(4).any(|window| window == b"dex\n");
    if dex_marker && (png_name || png_header) {
        return Some("png_disguised_dex".to_string());
    }
    if dex_marker {
        return Some("android_dex_asset".to_string());
    }
    if png_name || png_header {
        return Some("png_asset_unconfirmed".to_string());
    }
    Some("artifact_unclassified".to_string())
}

#[cfg(test)]
mod tests {
    use super::{probe, RuntimeCapabilityPayload};
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    fn payload(api: &str) -> RuntimeCapabilityPayload {
        RuntimeCapabilityPayload {
            api: api.to_string(),
            ext: None,
            script_bytes: Some(128),
            allowed_origins: Some(vec!["https://example.test".to_string()]),
            artifact_name: None,
            artifact_base64: None,
        }
    }

    #[test]
    fn keeps_native_and_unavailable_runtime_reasons_explicit() {
        assert_eq!(
            probe(&payload("csp_Douban")).reason_code,
            "native_douban_supported"
        );
        assert_eq!(
            probe(&payload("csp_Jianpian")).reason_code,
            "native_jianpian_ext_required"
        );
        let mut jianpian = payload("csp_Jianpian");
        jianpian.ext = Some("https://api.ztcgi.com".to_string());
        assert_eq!(probe(&jianpian).reason_code, "native_jianpian_supported");
        assert_eq!(
            probe(&payload("js:fixture.mjs")).reason_code,
            "quickjs_sidecar_supported"
        );
        assert!(probe(&payload("js:fixture.mjs")).supported);
        let config = probe(&payload("csp_Config"));
        assert!(!config.supported);
        assert_eq!(config.runtime, "local-config");
        assert_eq!(config.reason_code, "config_source_local_only");
    }

    #[test]
    fn identifies_a_png_disguised_dex_without_loading_or_executing_it() {
        let mut value = payload("csp_Unknown");
        value.artifact_name = Some("library.png".to_string());
        value.artifact_base64 = Some(STANDARD.encode(b"\x89PNG\r\n\x1a\n...classes.dex..."));
        let snapshot = probe(&value);
        assert_eq!(
            snapshot.asset_classification.as_deref(),
            Some("png_disguised_dex")
        );
        assert!(!snapshot.supported);
    }

    #[test]
    fn recognizes_a_declarative_http_adapter_without_loading_a_spider_artifact() {
        let mut value = payload("csp_Example");
        value.ext = Some(
            r#"{
              "qxAdapterVersion": 1,
              "baseUrl": "https://example.test/api",
              "operations": {
                "home": {"path": "/home"},
                "search": {"path": "/search"},
                "detail": {"path": "/detail"},
                "playback": {"path": "/playback"}
              }
            }"#
            .to_string(),
        );
        let snapshot = probe(&value);
        assert!(snapshot.supported);
        assert_eq!(snapshot.runtime, "http-adapter");
        assert_eq!(snapshot.reason_code, "declarative_http_adapter_supported");
        assert!(snapshot.capabilities.player);

        let mut tuxiaobei = payload(
            "https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/drpy2.min.js",
        );
        tuxiaobei.ext = Some("https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/%E5%85%94%E5%B0%8F%E8%B4%9D.js".to_string());
        let snapshot = probe(&tuxiaobei);
        assert!(snapshot.supported);
        assert_eq!(snapshot.runtime, "http-json-jsonp-html");
        assert_eq!(snapshot.reason_code, "legacy_http_contract_supported");
        assert!(snapshot.capabilities.player);
    }

    #[test]
    fn recognizes_a_bounded_cms_candidate_only_when_an_endpoint_is_present() {
        let mut value = payload("csp_AppGet");
        value.ext = Some("https://example.test/appget.txt|opaque-token".to_string());
        let snapshot = probe(&value);
        assert!(snapshot.supported);
        assert_eq!(snapshot.runtime, "http-auto");
        assert_eq!(snapshot.reason_code, "bounded_cms_http_candidate");
        assert!(snapshot.capabilities.search);
        assert!(!snapshot.capabilities.player);

        let snapshot = probe(&payload("csp_GuaziTY"));
        assert!(snapshot.supported);
        assert_eq!(snapshot.runtime, "http-json-aes");
        assert!(snapshot.capabilities.player);

        let snapshot = probe(&payload("csp_YGP"));
        assert!(snapshot.supported);
        assert_eq!(snapshot.runtime, "http-html");
        assert_eq!(snapshot.reason_code, "legacy_http_contract_supported");
        assert!(snapshot.capabilities.home);
        assert!(snapshot.capabilities.search);
        assert!(snapshot.capabilities.player);
    }

    #[test]
    fn recognizes_the_fixed_key_appget_contract_before_the_cms_fallback() {
        let mut value = payload("csp_AppGet");
        value.ext = Some(
            "https://example.test/appget.txt?version=119|0123456789abcdef|119|user".to_string(),
        );
        let snapshot = probe(&value);
        assert!(snapshot.supported);
        assert_eq!(snapshot.runtime, "http-appget");
        assert_eq!(snapshot.reason_code, "appget_http_contract_supported");
        assert!(snapshot.capabilities.search);
        assert!(snapshot.capabilities.detail);
        assert!(snapshot.capabilities.player);
    }

    #[test]
    fn recognizes_the_fixed_python_appget_wrapper_as_http_only() {
        let mut value = payload("./Py/app/getapp.py");
        value.ext = Some(
            r#"{"host":"http://103.236.61.192:8006","api":"/api.php/getappapi","datakey":"123456789abcdefg","dataiv":"123456789abcdefg"}"#
                .to_string(),
        );
        let snapshot = probe(&value);
        assert!(snapshot.supported);
        assert_eq!(snapshot.runtime, "http-appget");
        assert_eq!(snapshot.reason_code, "appget_python_wrapper_supported");
        assert!(snapshot.capabilities.home);
        assert!(snapshot.capabilities.search);
        assert!(snapshot.capabilities.detail);
        assert!(snapshot.capabilities.player);
    }

    #[test]
    fn rejects_an_invalid_python_appget_wrapper_without_downgrading_to_python() {
        for ext in [
            r#"{"host":"http://103.236.61.192:8006","api":"/api.php/qijiappapi","datakey":"123456789abcdefg"}"#,
            r#"{"host":"http://103.236.61.192:8006","api":"/api.php/getappapi","datakey":"short"}"#,
        ] {
            let mut value = payload("Py/app/getapp.py");
            value.ext = Some(ext.to_string());
            let snapshot = probe(&value);
            assert!(!snapshot.supported);
            assert_eq!(snapshot.runtime, "http-appget");
            assert_eq!(snapshot.reason_code, "appget_python_wrapper_invalid");
            assert!(!snapshot.capabilities.home);
            assert!(!snapshot.capabilities.player);
        }
    }

    #[test]
    fn recognizes_appqi_with_its_own_fixed_path_contract() {
        let mut value = payload("csp_AppQi");
        value.ext =
            Some("https://example.test/appqi.txt|0123456789abcdef|fixture-agent".to_string());
        let snapshot = probe(&value);
        assert!(snapshot.supported);
        assert_eq!(snapshot.runtime, "http-appqi");
        assert_eq!(snapshot.reason_code, "appqi_http_contract_supported");
        assert!(snapshot.capabilities.player);
    }

    #[test]
    fn rejects_a_malformed_fixed_key_appget_contract_instead_of_downgrading_it() {
        let mut value = payload("csp_AppGet");
        value.ext = Some("ftp://example.test/appget.txt|0123456789abcdef|119|user".to_string());
        let snapshot = probe(&value);
        assert!(!snapshot.supported);
        assert_eq!(snapshot.runtime, "http-appget");
        assert_eq!(snapshot.reason_code, "appget_http_contract_invalid");
        assert!(!snapshot.capabilities.home);
        assert!(!snapshot.capabilities.player);
    }

    #[test]
    fn rejects_an_explicit_invalid_appget_data_iv_instead_of_downgrading_it() {
        let mut value = payload("csp_AppGet");
        value.ext = Some(
            r#"{
              "url":"https://example.test",
              "dataKey":"0123456789abcdef",
              "dataIv":"short"
            }"#
            .to_string(),
        );
        let snapshot = probe(&value);
        assert!(!snapshot.supported);
        assert_eq!(snapshot.runtime, "http-appget");
        assert_eq!(snapshot.reason_code, "appget_http_contract_invalid");
        assert!(!snapshot.capabilities.home);
        assert!(!snapshot.capabilities.player);
    }

    #[test]
    fn rejects_an_explicit_invalid_app_data_key_without_reclassifying_opaque_tokens() {
        for (api, runtime, reason) in [
            ("csp_AppGet", "http-appget", "appget_http_contract_invalid"),
            ("csp_AppQi", "http-appqi", "appqi_http_contract_invalid"),
        ] {
            let mut value = payload(api);
            value.ext = Some(
                r#"{
                  "url":"https://example.test",
                  "dataKey":"short"
                }"#
                .to_string(),
            );
            let snapshot = probe(&value);
            assert!(!snapshot.supported);
            assert_eq!(snapshot.runtime, runtime);
            assert_eq!(snapshot.reason_code, reason);
            assert!(!snapshot.capabilities.home);
            assert!(!snapshot.capabilities.player);
        }

        let mut opaque = payload("csp_AppGet");
        opaque.ext = Some(r#"{"url":"https://example.test","token":"opaque-token"}"#.to_string());
        let snapshot = probe(&opaque);
        assert!(snapshot.supported);
        assert_eq!(snapshot.runtime, "http-auto");
        assert_eq!(snapshot.reason_code, "bounded_cms_http_candidate");
    }

    #[test]
    fn recognizes_the_first_aid_html_contract_without_an_artifact() {
        let snapshot = probe(&payload("csp_FirstAid"));
        assert!(snapshot.supported);
        assert_eq!(snapshot.runtime, "http-html");
        assert_eq!(snapshot.reason_code, "first_aid_html_contract_supported");
        assert!(snapshot.capabilities.category);
        assert!(!snapshot.capabilities.search);
        assert!(snapshot.capabilities.player);
    }

    #[test]
    fn recognizes_the_bilibili_http_contract_without_an_artifact() {
        let snapshot = probe(&payload("csp_Bili"));
        assert!(snapshot.supported);
        assert_eq!(snapshot.runtime, "http-json");
        assert_eq!(snapshot.reason_code, "bili_http_contract_supported");
        assert!(snapshot.capabilities.search);
        assert!(snapshot.capabilities.player);
    }

    #[test]
    fn recognizes_the_legacy_http_contracts_without_android_runtime() {
        let kanqiu = probe(&payload("csp_Kanqiu"));
        assert!(kanqiu.supported);
        assert_eq!(kanqiu.runtime, "http-html-json");
        assert_eq!(kanqiu.reason_code, "legacy_http_contract_supported");
        assert!(kanqiu.capabilities.category);
        assert!(kanqiu.capabilities.player);

        let snapshot = probe(&payload("csp_Kugou"));
        assert!(snapshot.supported);
        assert_eq!(snapshot.runtime, "http-html");
        assert_eq!(snapshot.reason_code, "legacy_http_contract_supported");
        assert!(snapshot.capabilities.category);
        assert!(!snapshot.capabilities.player);

        let snapshot = probe(&payload("csp_PanSearch"));
        assert!(snapshot.supported);
        assert!(snapshot.capabilities.search);
        assert!(!snapshot.capabilities.player);

        let apprj = probe(&RuntimeCapabilityPayload {
            api: "csp_AppRJ".to_string(),
            ext: Some("https://example.test".to_string()),
            ..payload("csp_AppRJ")
        });
        assert!(apprj.supported);
        assert_eq!(apprj.runtime, "http-json-multipart");
        assert!(apprj.capabilities.player);

        let jpys = probe(&payload("csp_Jpys"));
        assert!(jpys.supported);
        assert_eq!(jpys.runtime, "http-json-signed");
        assert!(jpys.capabilities.search);
        assert!(jpys.capabilities.player);

        let guazi = probe(&payload("csp_GuaziTY"));
        assert!(guazi.supported);
        assert_eq!(guazi.runtime, "http-json-aes");
        assert_eq!(guazi.reason_code, "legacy_http_contract_supported");
        assert!(guazi.capabilities.category);
        assert!(guazi.capabilities.player);

        let gz360 = probe(&payload("csp_Gz360"));
        assert!(gz360.supported);
        assert_eq!(gz360.runtime, "http-json-aes");
        assert_eq!(gz360.reason_code, "legacy_http_contract_supported");
        assert!(gz360.capabilities.home);
        assert!(gz360.capabilities.category);
        assert!(gz360.capabilities.search);
        assert!(gz360.capabilities.detail);
        assert!(gz360.capabilities.player);

        let sp360 = probe(&payload("csp_SP360"));
        assert!(sp360.supported);
        assert_eq!(sp360.runtime, "http-json-jsonp");
        assert_eq!(sp360.reason_code, "legacy_http_contract_supported");
        assert!(sp360.capabilities.home);
        assert!(sp360.capabilities.category);
        assert!(sp360.capabilities.search);
        assert!(sp360.capabilities.detail);
        assert!(sp360.capabilities.player);

        let ygp = probe(&payload("csp_YGP"));
        assert!(ygp.supported);
        assert_eq!(ygp.runtime, "http-html");
        assert_eq!(ygp.reason_code, "legacy_http_contract_supported");
        assert!(ygp.capabilities.home);
        assert!(ygp.capabilities.category);
        assert!(ygp.capabilities.search);
        assert!(ygp.capabilities.detail);
        assert!(ygp.capabilities.player);

        for api in [
            "csp_Wwys",
            "csp_SaoHuo",
            "csp_Czsapp",
            "csp_Duopan",
            "csp_Netfixtv",
        ] {
            let mut value = payload(api);
            value.ext = Some(if api == "csp_Duopan" {
                r#"{"site_urls":["https://example.test"]}"#.to_string()
            } else {
                "https://example.test".to_string()
            });
            let snapshot = probe(&value);
            assert!(
                snapshot.supported,
                "{api} should use the bounded HTML contract"
            );
            let direct_page_playback = !matches!(api, "csp_Duopan" | "csp_Netfixtv");
            assert_eq!(
                snapshot.capabilities.player, direct_page_playback,
                "{api} should only expose the explicit HTML media contract"
            );
        }
    }

    #[test]
    fn keeps_the_current_feimao_public_api_set_on_explicit_boundaries() {
        let cases = [
            ("csp_Douban", None, "native", true),
            ("csp_YGP", None, "http-html", true),
            ("csp_Config", None, "local-config", false),
            (
                "csp_Duopan",
                Some(r#"{"site_urls":["https://example.test"]}"#),
                "http-html",
                true,
            ),
            (
                "csp_AppRJ",
                Some("https://example.test"),
                "http-json-multipart",
                true,
            ),
            (
                "csp_AppGet",
                Some("https://example.test/appget|0123456789abcdef"),
                "http-appget",
                true,
            ),
            (
                "csp_AppQi",
                Some("https://example.test/appqi|0123456789abcdef|fixture-agent"),
                "http-appqi",
                true,
            ),
            ("csp_Jpys", None, "http-json-signed", true),
            ("csp_Wwys", Some("https://example.test"), "http-html", true),
            ("csp_Jianpian", Some("https://example.test"), "native", true),
            (
                "csp_SaoHuo",
                Some("https://example.test"),
                "http-html",
                true,
            ),
            ("csp_Gz360", None, "http-json-aes", true),
            (
                "csp_Czsapp",
                Some("https://example.test"),
                "http-html",
                true,
            ),
            ("csp_SP360", None, "http-json-jsonp", true),
            ("csp_Bili", None, "http-json", true),
            ("csp_Dm84", Some("https://example.test"), "http-html", true),
            ("csp_FirstAid", None, "http-html", true),
            ("csp_Kugou", Some("https://example.test"), "http-html", true),
            ("csp_Kanqiu", None, "http-html-json", true),
            ("csp_GuaziTY", None, "http-json-aes", true),
            (
                "csp_MiSou",
                Some("http://127.0.0.1:9978/file/fatcat/kk.txt"),
                "http-misou-search",
                true,
            ),
            (
                "csp_PanSearch",
                Some("http://127.0.0.1:9978/file/fatcat/token.txt"),
                "http-json-html",
                true,
            ),
            ("csp_Push", None, "http-push", true),
        ];

        for (api, ext, runtime, supported) in cases {
            let mut value = payload(api);
            value.ext = ext.map(ToString::to_string);
            let snapshot = probe(&value);
            assert_eq!(snapshot.runtime, runtime, "{api}");
            assert_eq!(snapshot.supported, supported, "{api}");
            assert_ne!(
                snapshot.reason_code, "spider_artifact_not_declared",
                "{api}"
            );
        }

        let mut tuxiaobei = payload(
            "https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/drpy2.min.js",
        );
        tuxiaobei.ext = Some(
            "https://gh-proxy.net/https://raw.githubusercontent.com/fantaiying7/EXT/refs/heads/main/%E5%85%94%E5%B0%8F%E8%B4%9D.js"
                .to_string(),
        );
        let snapshot = probe(&tuxiaobei);
        assert_eq!(snapshot.runtime, "http-json-jsonp-html");
        assert_eq!(snapshot.reason_code, "legacy_http_contract_supported");
        assert!(snapshot.supported);

        let quickjs = probe(&payload("js:fixture.mjs"));
        assert_eq!(quickjs.runtime, "quickjs-sidecar");
        assert_eq!(quickjs.reason_code, "quickjs_sidecar_supported");
        assert!(quickjs.supported);
    }

    #[test]
    fn recognizes_the_endpointless_push_http_contract() {
        let snapshot = probe(&payload("csp_Push"));
        assert!(snapshot.supported);
        assert_eq!(snapshot.runtime, "http-push");
        assert_eq!(snapshot.reason_code, "push_http_contract_supported");
        assert!(!snapshot.capabilities.home);
        assert!(snapshot.capabilities.detail);
        assert!(snapshot.capabilities.player);
    }

    #[test]
    fn recognizes_the_misou_search_contract_without_claiming_provider_playback() {
        let mut value = payload("csp_MiSou");
        value.ext = Some("http://127.0.0.1:9978/file/fatcat/kk.txt".to_string());
        let snapshot = probe(&value);
        assert!(snapshot.supported);
        assert_eq!(snapshot.runtime, "http-misou-search");
        assert_eq!(snapshot.reason_code, "misou_http_search_contract_supported");
        assert!(snapshot.capabilities.home);
        assert!(snapshot.capabilities.category);
        assert!(snapshot.capabilities.search);
        assert!(!snapshot.capabilities.detail);
        assert!(!snapshot.capabilities.player);
    }
}
