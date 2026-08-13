use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const EXPECTED_TARGET: &str = "x86_64-pc-windows-msvc";
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_ARTIFACT_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentManagerPayload {
    pub action: String,
    pub component_id: Option<String>,
    pub manifest_json: Option<String>,
    pub signature_base64: Option<String>,
    pub public_key_base64: Option<String>,
    pub artifact_base64: Option<String>,
    pub running: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentManagerSnapshot {
    pub state: String,
    pub component_id: Option<String>,
    pub version: Option<String>,
    pub verified: bool,
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentManifest {
    pub version: u32,
    pub components: Vec<ComponentEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentEntry {
    pub id: String,
    pub version: String,
    pub target: String,
    pub sha256: String,
    pub url: String,
}

#[derive(Debug)]
pub enum ComponentManagerError {
    Invalid(String),
    Untrusted(String),
    Storage(String),
}

impl ComponentManagerError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "COMPONENT_MANIFEST_INVALID",
            Self::Untrusted(_) => "COMPONENT_UNTRUSTED",
            Self::Storage(_) => "COMPONENT_STORAGE_FAILED",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Invalid(message) | Self::Untrusted(message) | Self::Storage(message) => {
                message.clone()
            }
        }
    }
}

pub fn handle(
    root: &Path,
    payload: &ComponentManagerPayload,
) -> Result<ComponentManagerSnapshot, ComponentManagerError> {
    match payload.action.as_str() {
        "verify" => {
            let manifest = verify_manifest(payload)?;
            let id = payload.component_id.clone();
            let version = id.as_deref().and_then(|value| {
                manifest
                    .components
                    .iter()
                    .find(|component| component.id == value)
                    .map(|component| component.version.clone())
            });
            Ok(ComponentManagerSnapshot {
                state: "verified".to_string(),
                component_id: id,
                version,
                verified: true,
                reason_code: None,
            })
        }
        "install" => install(root, payload),
        "rollback" => rollback(root, payload),
        "uninstall" => uninstall(root, payload),
        _ => Err(ComponentManagerError::Invalid(
            "component action must be verify, install, rollback, or uninstall".to_string(),
        )),
    }
}

fn verify_manifest(
    payload: &ComponentManagerPayload,
) -> Result<ComponentManifest, ComponentManagerError> {
    let raw = payload
        .manifest_json
        .as_deref()
        .ok_or_else(|| ComponentManagerError::Invalid("manifestJson is required".to_string()))?;
    if raw.is_empty() || raw.len() > MAX_MANIFEST_BYTES {
        return Err(ComponentManagerError::Invalid(
            "component manifest is empty or too large".to_string(),
        ));
    }
    let signature = decode_fixed::<64>(
        payload.signature_base64.as_deref().ok_or_else(|| {
            ComponentManagerError::Untrusted("detached signature is required".to_string())
        })?,
        "signature",
    )?;
    let public_key = decode_fixed::<32>(
        payload.public_key_base64.as_deref().ok_or_else(|| {
            ComponentManagerError::Untrusted("public key is required".to_string())
        })?,
        "public key",
    )?;
    let verifying_key = VerifyingKey::from_bytes(&public_key).map_err(|error| {
        ComponentManagerError::Untrusted(format!("invalid public key: {error}"))
    })?;
    verifying_key
        .verify(raw.as_bytes(), &Signature::from_bytes(&signature))
        .map_err(|_| {
            ComponentManagerError::Untrusted("component manifest signature is invalid".to_string())
        })?;
    let manifest: ComponentManifest = serde_json::from_str(raw).map_err(|error| {
        ComponentManagerError::Invalid(format!("invalid component manifest: {error}"))
    })?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

fn validate_manifest(manifest: &ComponentManifest) -> Result<(), ComponentManagerError> {
    if manifest.version != 1 || manifest.components.is_empty() {
        return Err(ComponentManagerError::Invalid(
            "component manifest must be version 1 and contain components".to_string(),
        ));
    }
    for component in &manifest.components {
        validate_component_id(&component.id)?;
        if component.version.trim().is_empty()
            || component.target != EXPECTED_TARGET
            || !is_sha256(&component.sha256)
            || !is_https_url(&component.url)
        {
            return Err(ComponentManagerError::Invalid(format!(
                "component entry is invalid: {}",
                component.id
            )));
        }
    }
    Ok(())
}

fn install(
    root: &Path,
    payload: &ComponentManagerPayload,
) -> Result<ComponentManagerSnapshot, ComponentManagerError> {
    if payload.running.unwrap_or(false) {
        return Err(ComponentManagerError::Invalid(
            "running components cannot be switched".to_string(),
        ));
    }
    let manifest = verify_manifest(payload)?;
    let component_id = payload
        .component_id
        .as_deref()
        .ok_or_else(|| ComponentManagerError::Invalid("componentId is required".to_string()))?;
    let component = manifest
        .components
        .iter()
        .find(|candidate| candidate.id == component_id)
        .ok_or_else(|| {
            ComponentManagerError::Invalid("component is not in the manifest".to_string())
        })?;
    let artifact = STANDARD
        .decode(payload.artifact_base64.as_deref().unwrap_or_default())
        .map_err(|error| ComponentManagerError::Invalid(format!("invalid artifact: {error}")))?;
    if artifact.is_empty() || artifact.len() > MAX_ARTIFACT_BYTES {
        return Err(ComponentManagerError::Invalid(
            "component artifact is empty or too large".to_string(),
        ));
    }
    if sha256(&artifact) != component.sha256 {
        return Err(ComponentManagerError::Untrusted(
            "component artifact sha256 does not match the manifest".to_string(),
        ));
    }

    let component_root = safe_component_root(root, component_id)?;
    let staging_root = root.join("staging");
    fs::create_dir_all(&staging_root)
        .map_err(|error| ComponentManagerError::Storage(error.to_string()))?;
    let staging = staging_root.join(format!("{}-{}", component_id, Uuid::new_v4()));
    fs::create_dir_all(&staging)
        .map_err(|error| ComponentManagerError::Storage(error.to_string()))?;
    fs::write(staging.join("payload"), &artifact)
        .map_err(|error| ComponentManagerError::Storage(error.to_string()))?;
    fs::write(
        staging.join("manifest.json"),
        payload.manifest_json.as_deref().unwrap_or_default(),
    )
    .map_err(|error| ComponentManagerError::Storage(error.to_string()))?;

    let active = component_root.join("active");
    let previous = component_root.join("previous");
    fs::create_dir_all(&component_root)
        .map_err(|error| ComponentManagerError::Storage(error.to_string()))?;
    if active.exists() {
        replace_directory(&active, &previous)?;
    }
    replace_directory(&staging, &active)?;

    Ok(ComponentManagerSnapshot {
        state: "active".to_string(),
        component_id: Some(component_id.to_string()),
        version: Some(component.version.clone()),
        verified: true,
        reason_code: None,
    })
}

fn rollback(
    root: &Path,
    payload: &ComponentManagerPayload,
) -> Result<ComponentManagerSnapshot, ComponentManagerError> {
    if payload.running.unwrap_or(false) {
        return Err(ComponentManagerError::Invalid(
            "running components cannot be switched".to_string(),
        ));
    }
    let component_id = payload
        .component_id
        .as_deref()
        .ok_or_else(|| ComponentManagerError::Invalid("componentId is required".to_string()))?;
    validate_component_id(component_id)?;
    let component_root = safe_component_root(root, component_id)?;
    let active = component_root.join("active");
    let previous = component_root.join("previous");
    if !previous.exists() {
        return Err(ComponentManagerError::Invalid(
            "component has no previous version".to_string(),
        ));
    }
    let swap = component_root.join(format!("swap-{}", Uuid::new_v4()));
    if active.exists() {
        fs::rename(&active, &swap)
            .map_err(|error| ComponentManagerError::Storage(error.to_string()))?;
    }
    fs::rename(&previous, &active)
        .map_err(|error| ComponentManagerError::Storage(error.to_string()))?;
    if swap.exists() {
        fs::rename(&swap, &previous)
            .map_err(|error| ComponentManagerError::Storage(error.to_string()))?;
    }
    Ok(ComponentManagerSnapshot {
        state: "rolled_back".to_string(),
        component_id: Some(component_id.to_string()),
        version: None,
        verified: true,
        reason_code: None,
    })
}

fn uninstall(
    root: &Path,
    payload: &ComponentManagerPayload,
) -> Result<ComponentManagerSnapshot, ComponentManagerError> {
    if payload.running.unwrap_or(false) {
        return Err(ComponentManagerError::Invalid(
            "running components cannot be removed".to_string(),
        ));
    }
    let component_id = payload
        .component_id
        .as_deref()
        .ok_or_else(|| ComponentManagerError::Invalid("componentId is required".to_string()))?;
    validate_component_id(component_id)?;
    let component_root = safe_component_root(root, component_id)?;
    if component_root.exists() {
        fs::remove_dir_all(&component_root)
            .map_err(|error| ComponentManagerError::Storage(error.to_string()))?;
    }
    Ok(ComponentManagerSnapshot {
        state: "uninstalled".to_string(),
        component_id: Some(component_id.to_string()),
        version: None,
        verified: true,
        reason_code: None,
    })
}

fn replace_directory(source: &Path, destination: &Path) -> Result<(), ComponentManagerError> {
    if destination.exists() {
        fs::remove_dir_all(destination)
            .map_err(|error| ComponentManagerError::Storage(error.to_string()))?;
    }
    fs::rename(source, destination)
        .map_err(|error| ComponentManagerError::Storage(error.to_string()))
}

fn safe_component_root(root: &Path, component_id: &str) -> Result<PathBuf, ComponentManagerError> {
    validate_component_id(component_id)?;
    Ok(root.join("components").join(component_id))
}

fn validate_component_id(value: &str) -> Result<(), ComponentManagerError> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(ComponentManagerError::Invalid(
            "component id is invalid".to_string(),
        ));
    }
    Ok(())
}

fn decode_fixed<const N: usize>(
    value: &str,
    label: &str,
) -> Result<[u8; N], ComponentManagerError> {
    let bytes = STANDARD
        .decode(value)
        .map_err(|error| ComponentManagerError::Untrusted(format!("invalid {label}: {error}")))?;
    bytes
        .try_into()
        .map_err(|_| ComponentManagerError::Untrusted(format!("{label} has an invalid length")))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_https_url(value: &str) -> bool {
    value.starts_with("https://") && !value.contains(['\r', '\n'])
}

fn sha256(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{handle, sha256, ComponentManagerPayload};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    fn signed_payload(id: &str, version: &str, artifact: &[u8]) -> ComponentManagerPayload {
        let manifest = json!({
            "version": 1,
            "components": [{
                "id": id,
                "version": version,
                "target": "x86_64-pc-windows-msvc",
                "sha256": sha256(artifact),
                "url": "https://github.com/example/qx/releases/download/v1/component.bin"
            }]
        })
        .to_string();
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let signature = signing_key.sign(manifest.as_bytes());
        ComponentManagerPayload {
            action: "install".to_string(),
            component_id: Some(id.to_string()),
            manifest_json: Some(manifest),
            signature_base64: Some(STANDARD.encode(signature.to_bytes())),
            public_key_base64: Some(STANDARD.encode(signing_key.verifying_key().to_bytes())),
            artifact_base64: Some(STANDARD.encode(artifact)),
            running: Some(false),
        }
    }

    fn test_root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("qx-component-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("test root");
        root
    }

    #[test]
    fn verifies_signature_and_rejects_tampered_artifact() {
        let mut payload = signed_payload("quickjs", "1", b"component-v1");
        payload.artifact_base64 = Some(STANDARD.encode(b"tampered"));
        let error = handle(&test_root("tamper"), &payload).expect_err("tamper rejected");
        assert!(error.message().contains("sha256"));
    }

    #[test]
    fn installs_keeps_one_previous_version_and_rolls_back_atomically() {
        let root = test_root("rollback");
        let first = signed_payload("mpv", "1", b"one");
        handle(&root, &first).expect("first install");
        let second = signed_payload("mpv", "2", b"two");
        handle(&root, &second).expect("second install");
        assert_eq!(
            fs::read(root.join("components/mpv/active/payload")).expect("active"),
            b"two"
        );
        assert_eq!(
            fs::read(root.join("components/mpv/previous/payload")).expect("previous"),
            b"one"
        );
        let rollback = ComponentManagerPayload {
            action: "rollback".to_string(),
            component_id: Some("mpv".to_string()),
            manifest_json: None,
            signature_base64: None,
            public_key_base64: None,
            artifact_base64: None,
            running: Some(false),
        };
        handle(&root, &rollback).expect("rollback");
        assert_eq!(
            fs::read(root.join("components/mpv/active/payload")).expect("rolled active"),
            b"one"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_switching_or_removing_a_running_component() {
        let root = test_root("running");
        let mut payload = signed_payload("quickjs", "1", b"one");
        payload.running = Some(true);
        let error = handle(&root, &payload).expect_err("running install rejected");
        assert!(error.message().contains("running"));
    }
}
