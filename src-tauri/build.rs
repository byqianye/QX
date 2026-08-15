use std::env;

fn main() {
    println!("cargo:rerun-if-env-changed=QX_COMPONENT_PUBLIC_KEY_BASE64");
    println!("cargo:rerun-if-env-changed=QX_COMPONENT_MANIFEST_URL");
    println!("cargo:rerun-if-env-changed=QX_COMPONENT_SIGNATURE_URL");
    let profile = env::var("PROFILE").unwrap_or_default();
    if let Ok(value) = env::var("QX_COMPONENT_PUBLIC_KEY_BASE64") {
        let value = value.trim().to_string();
        if !is_base64_32(&value) {
            panic!("QX_COMPONENT_PUBLIC_KEY_BASE64 must be a base64-encoded 32-byte Ed25519 public key");
        }
        println!("cargo:rustc-env=QX_COMPONENT_PUBLIC_KEY_BASE64={value}");
    } else if profile == "release" {
        panic!("release builds require QX_COMPONENT_PUBLIC_KEY_BASE64; refusing to produce an untrusted component host");
    }
    for (name, message) in [
        (
            "QX_COMPONENT_MANIFEST_URL",
            "release builds require QX_COMPONENT_MANIFEST_URL; refusing to produce a host without a default component source",
        ),
        (
            "QX_COMPONENT_SIGNATURE_URL",
            "release builds require QX_COMPONENT_SIGNATURE_URL; refusing to produce a host without a default component signature source",
        ),
    ] {
        match env::var(name) {
            Ok(value) if is_https_url(&value) => println!("cargo:rustc-env={name}={value}"),
            Ok(_) => panic!("{name} must be an HTTPS URL"),
            Err(_) if profile == "release" => panic!("{message}"),
            Err(_) => {}
        }
    }
    tauri_build::build();
}

fn is_base64_32(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.len() == 44
        && value.ends_with('=')
        && bytes[..43]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
}

fn is_https_url(value: &str) -> bool {
    value.starts_with("https://") && !value.contains(['\r', '\n'])
}
