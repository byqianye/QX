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
    if api.starts_with("py:") || api.ends_with(".py") {
        return with_asset(
            unsupported("python", "python_runtime_disabled_in_tauri"),
            asset_classification,
        );
    }
    if api.starts_with("csp_") {
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
}
