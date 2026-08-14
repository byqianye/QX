use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use reqwest::blocking::Client;
use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;
#[cfg(debug_assertions)]
use tauri::Manager;
use uuid::Uuid;

const MAX_SCRIPT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickJsSidecarPayload {
    pub action: String,
    pub session_id: String,
    pub script: Option<String>,
    #[serde(default)]
    pub module_sources: HashMap<String, String>,
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    pub name: Option<String>,
    #[serde(default)]
    pub args: Vec<Value>,
}

#[derive(Debug)]
pub enum QuickJsBridgeError {
    Invalid(String),
    Unavailable(String),
    Failed { code: String, message: String },
}

pub struct QuickJsSidecarState {
    sessions: Mutex<HashMap<String, QuickJsProcess>>,
}

impl Default for QuickJsSidecarState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl QuickJsSidecarState {
    pub fn handle(
        &self,
        app: &AppHandle,
        payload: QuickJsSidecarPayload,
    ) -> Result<Value, QuickJsBridgeError> {
        if payload.session_id.trim().is_empty() {
            return Err(QuickJsBridgeError::Invalid(
                "sessionId is required".to_string(),
            ));
        }
        match payload.action.as_str() {
            "load" => self.load(app, payload),
            "call" => self.call(payload),
            "capabilities" => self.capabilities(payload),
            "close" => self.close(&payload.session_id),
            action => Err(QuickJsBridgeError::Invalid(format!(
                "unsupported action: {action}"
            ))),
        }
    }

    fn load(
        &self,
        app: &AppHandle,
        payload: QuickJsSidecarPayload,
    ) -> Result<Value, QuickJsBridgeError> {
        let script = payload
            .script
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| QuickJsBridgeError::Invalid("load requires script".to_string()))?;
        let script = resolve_script(script, &payload.allowed_origins)?;
        let mut process = QuickJsProcess::spawn(sidecar_path(app)?)?;
        let request = serde_json::json!({
            "id": Uuid::new_v4().to_string(),
            "method": "load",
            "script": script,
            "moduleSources": payload.module_sources,
            "allowedOrigins": payload.allowed_origins,
        });
        let result = match process.request(request) {
            Ok(result) => result,
            Err(error) => {
                process.terminate();
                return Err(error);
            }
        };
        let mut sessions = self.sessions.lock().map_err(|_| {
            QuickJsBridgeError::Unavailable("sidecar state is poisoned".to_string())
        })?;
        if let Some(previous) = sessions.insert(payload.session_id, process) {
            previous.terminate();
        }
        Ok(result)
    }

    fn call(&self, payload: QuickJsSidecarPayload) -> Result<Value, QuickJsBridgeError> {
        let name = payload
            .name
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| QuickJsBridgeError::Invalid("call requires name".to_string()))?;
        let mut sessions = self.sessions.lock().map_err(|_| {
            QuickJsBridgeError::Unavailable("sidecar state is poisoned".to_string())
        })?;
        let process = sessions.get_mut(&payload.session_id).ok_or_else(|| {
            QuickJsBridgeError::Unavailable("QuickJS session is not loaded".to_string())
        })?;
        process.request(serde_json::json!({
            "id": Uuid::new_v4().to_string(),
            "method": "call",
            "name": name,
            "args": payload.args,
        }))
    }

    fn capabilities(&self, payload: QuickJsSidecarPayload) -> Result<Value, QuickJsBridgeError> {
        let mut sessions = self.sessions.lock().map_err(|_| {
            QuickJsBridgeError::Unavailable("sidecar state is poisoned".to_string())
        })?;
        let process = sessions.get_mut(&payload.session_id).ok_or_else(|| {
            QuickJsBridgeError::Unavailable("QuickJS session is not loaded".to_string())
        })?;
        process.request(serde_json::json!({
            "id": Uuid::new_v4().to_string(),
            "method": "capabilities",
        }))
    }

    fn close(&self, session_id: &str) -> Result<Value, QuickJsBridgeError> {
        let mut sessions = self.sessions.lock().map_err(|_| {
            QuickJsBridgeError::Unavailable("sidecar state is poisoned".to_string())
        })?;
        let mut process = sessions.remove(session_id).ok_or_else(|| {
            QuickJsBridgeError::Unavailable("QuickJS session is not loaded".to_string())
        })?;
        let result = process.request(serde_json::json!({
            "id": Uuid::new_v4().to_string(),
            "method": "close",
        }));
        process.terminate();
        result
    }
}

impl Drop for QuickJsSidecarState {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, process) in sessions.drain() {
                process.terminate();
            }
        }
    }
}

struct QuickJsProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl QuickJsProcess {
    fn spawn(path: PathBuf) -> Result<Self, QuickJsBridgeError> {
        let mut child = Command::new(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                QuickJsBridgeError::Unavailable(format!("cannot start {}: {error}", path.display()))
            })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            QuickJsBridgeError::Unavailable("sidecar stdin is unavailable".to_string())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            QuickJsBridgeError::Unavailable("sidecar stdout is unavailable".to_string())
        })?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    fn request(&mut self, request: Value) -> Result<Value, QuickJsBridgeError> {
        let encoded = serde_json::to_vec(&request).map_err(|error| {
            QuickJsBridgeError::Invalid(format!("cannot encode sidecar request: {error}"))
        })?;
        self.stdin
            .write_all(&encoded)
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|error| {
                QuickJsBridgeError::Unavailable(format!("cannot write to QuickJS sidecar: {error}"))
            })?;
        let mut line = String::new();
        self.stdout.read_line(&mut line).map_err(|error| {
            QuickJsBridgeError::Unavailable(format!("cannot read QuickJS sidecar: {error}"))
        })?;
        if line.trim().is_empty() {
            return Err(QuickJsBridgeError::Unavailable(
                "QuickJS sidecar exited without a response".to_string(),
            ));
        }
        let response: SidecarResponse = serde_json::from_str(&line).map_err(|error| {
            QuickJsBridgeError::Unavailable(format!("invalid QuickJS sidecar response: {error}"))
        })?;
        if response.ok {
            Ok(response.result.unwrap_or(Value::Null))
        } else {
            let error = response.error.unwrap_or(SidecarError {
                code: "QUICKJS_UNKNOWN_ERROR".to_string(),
                message: "QuickJS sidecar returned an unspecified error".to_string(),
            });
            Err(QuickJsBridgeError::Failed {
                code: error.code,
                message: error.message,
            })
        }
    }

    fn terminate(mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

#[derive(Debug, Deserialize)]
struct SidecarResponse {
    ok: bool,
    result: Option<Value>,
    error: Option<SidecarError>,
}

#[derive(Debug, Deserialize)]
struct SidecarError {
    code: String,
    message: String,
}

pub fn sidecar_path(app: &AppHandle) -> Result<PathBuf, QuickJsBridgeError> {
    let mut candidates = Vec::new();
    if let Ok((data_directory, _)) = super::app_data_paths(app) {
        candidates.push(
            data_directory
                .join("component-manager-v1")
                .join("components")
                .join("quickjs")
                .join("active")
                .join("payload"),
        );
    }

    // The development sidecar is intentionally not a release fallback. Release
    // builds must use the verified component-manager payload so the core NSIS
    // package cannot silently execute an unsigned sidecar.
    #[cfg(debug_assertions)]
    {
        if let Ok(resource_dir) = app.path().resource_dir() {
            candidates.push(resource_dir.join("qx-quickjs-sidecar.exe"));
            candidates.push(resource_dir.join("binaries").join("qx-quickjs-sidecar.exe"));
        }
        if let Ok(current_exe) = std::env::current_exe() {
            if let Some(parent) = current_exe.parent() {
                candidates.push(parent.join("qx-quickjs-sidecar.exe"));
            }
        }
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            QuickJsBridgeError::Unavailable(
                "verified QuickJS component is not installed".to_string(),
            )
        })
}

fn resolve_script(script: &str, allowed_origins: &[String]) -> Result<String, QuickJsBridgeError> {
    let trimmed = script.trim();
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        if trimmed.starts_with("file://") {
            return Err(QuickJsBridgeError::Failed {
                code: "QUICKJS_NETWORK_DENIED".to_string(),
                message: "Tauri QuickJS does not load local files as scripts".to_string(),
            });
        }
        if trimmed.len() > MAX_SCRIPT_BYTES {
            return Err(QuickJsBridgeError::Failed {
                code: "QUICKJS_SCRIPT_LOAD_FAILED".to_string(),
                message: format!("script exceeds {MAX_SCRIPT_BYTES} bytes"),
            });
        }
        return Ok(script.to_string());
    }

    let url = reqwest::Url::parse(trimmed).map_err(|error| {
        QuickJsBridgeError::Invalid(format!("QuickJS script URL is invalid: {error}"))
    })?;
    if allowed_origins.is_empty()
        || !allowed_origins
            .iter()
            .any(|origin| same_origin(&url, origin))
    {
        return Err(QuickJsBridgeError::Failed {
            code: "QUICKJS_NETWORK_DENIED".to_string(),
            message: "QuickJS script origin is not allowed".to_string(),
        });
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("QX-Yingshi/0.9 QuickJS sidecar")
        .build()
        .map_err(|error| QuickJsBridgeError::Unavailable(error.to_string()))?;
    let response = client
        .get(url)
        .send()
        .map_err(|error| QuickJsBridgeError::Unavailable(error.to_string()))?;
    if !response.status().is_success() {
        return Err(QuickJsBridgeError::Failed {
            code: "QUICKJS_SCRIPT_LOAD_FAILED".to_string(),
            message: format!("QuickJS script returned {}", response.status()),
        });
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_SCRIPT_BYTES as u64)
    {
        return Err(QuickJsBridgeError::Failed {
            code: "QUICKJS_SCRIPT_LOAD_FAILED".to_string(),
            message: format!("script exceeds {MAX_SCRIPT_BYTES} bytes"),
        });
    }
    let mut bytes = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or(0)
            .min(MAX_SCRIPT_BYTES as u64) as usize,
    );
    response
        .take((MAX_SCRIPT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| QuickJsBridgeError::Unavailable(error.to_string()))?;
    if bytes.len() > MAX_SCRIPT_BYTES {
        return Err(QuickJsBridgeError::Failed {
            code: "QUICKJS_SCRIPT_LOAD_FAILED".to_string(),
            message: format!("script exceeds {MAX_SCRIPT_BYTES} bytes"),
        });
    }
    String::from_utf8(bytes).map_err(|error| QuickJsBridgeError::Failed {
        code: "QUICKJS_SCRIPT_LOAD_FAILED".to_string(),
        message: format!("script is not valid UTF-8: {error}"),
    })
}

fn same_origin(url: &reqwest::Url, allowed: &str) -> bool {
    let Ok(origin) = reqwest::Url::parse(allowed) else {
        return false;
    };
    url.scheme() == origin.scheme()
        && url.host_str() == origin.host_str()
        && url.port_or_known_default() == origin.port_or_known_default()
}

pub fn error_fields(error: QuickJsBridgeError) -> (String, String, bool) {
    match error {
        QuickJsBridgeError::Invalid(message) => {
            ("QUICKJS_INVALID_REQUEST".to_string(), message, false)
        }
        QuickJsBridgeError::Unavailable(message) => {
            ("QUICKJS_SIDECAR_UNAVAILABLE".to_string(), message, true)
        }
        QuickJsBridgeError::Failed { code, message } => (code, message, false),
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_script, QuickJsSidecarPayload, QuickJsSidecarState};

    #[test]
    fn payload_uses_stable_camel_case_wire_fields() {
        let payload: QuickJsSidecarPayload = serde_json::from_value(serde_json::json!({
            "action": "call",
            "sessionId": "s1",
            "name": "search",
            "args": ["fixture", 1]
        }))
        .unwrap();
        assert_eq!(payload.session_id, "s1");
        assert_eq!(payload.args.len(), 2);
        assert!(QuickJsSidecarState::default()
            .sessions
            .lock()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn keeps_inline_scripts_and_rejects_unapproved_remote_scripts() {
        assert_eq!(
            resolve_script("export default {};", &[]).unwrap(),
            "export default {};"
        );
        let error = resolve_script("https://example.test/spider.mjs", &[]).unwrap_err();
        assert!(
            matches!(error, super::QuickJsBridgeError::Failed { code, .. } if code == "QUICKJS_NETWORK_DENIED")
        );
    }
}
