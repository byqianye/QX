use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilityPayload {
    pub api: String,
    pub script_bytes: Option<u64>,
    pub allowed_origins: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilitySnapshot {
    pub runtime: String,
    pub supported: bool,
    pub reason_code: String,
    pub capabilities: RuntimeCapabilities,
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
    if api.eq_ignore_ascii_case("csp_Douban") {
        return supported(
            "native",
            "native_douban_supported",
            true,
            true,
            true,
            true,
            false,
        );
    }
    if api.eq_ignore_ascii_case("csp_Jianpian") {
        return unsupported("native", "native_jianpian_port_pending");
    }
    if api.starts_with("http://") || api.starts_with("https://") {
        return supported(
            "cms-http",
            "cms_http_supported",
            true,
            true,
            true,
            true,
            true,
        );
    }
    if api.starts_with("js:") || api.ends_with(".js") || api.ends_with(".mjs") {
        let size_ok = payload.script_bytes.unwrap_or(0) <= 1024 * 1024;
        let origins_ok = payload
            .allowed_origins
            .as_ref()
            .is_some_and(|origins| !origins.is_empty());
        if size_ok && origins_ok {
            return unsupported("quickjs-sidecar", "quickjs_sidecar_not_installed");
        }
        return unsupported("quickjs-sidecar", "quickjs_policy_requirements_missing");
    }
    if api.starts_with("py:") || api.ends_with(".py") {
        return unsupported("python", "python_runtime_disabled_in_tauri");
    }
    if api.starts_with("csp_") {
        return unsupported("unknown", "spider_artifact_not_declared");
    }
    unsupported("unknown", "unsupported_site_type")
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
    }
}

#[cfg(test)]
mod tests {
    use super::{probe, RuntimeCapabilityPayload};

    fn payload(api: &str) -> RuntimeCapabilityPayload {
        RuntimeCapabilityPayload {
            api: api.to_string(),
            script_bytes: Some(128),
            allowed_origins: Some(vec!["https://example.test".to_string()]),
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
            "native_jianpian_port_pending"
        );
        assert_eq!(
            probe(&payload("js:fixture.mjs")).reason_code,
            "quickjs_sidecar_not_installed"
        );
        assert!(!probe(&payload("js:fixture.mjs")).supported);
    }
}
