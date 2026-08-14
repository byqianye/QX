use std::env;

fn main() {
    println!("cargo:rerun-if-env-changed=QX_COMPONENT_PUBLIC_KEY_BASE64");
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
