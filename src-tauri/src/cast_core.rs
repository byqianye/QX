use std::collections::BTreeMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::UdpSocket;
use tokio::time::{timeout, Instant};

const MEDIA_RENDERER_ST: &str = "urn:schemas-upnp-org:device:MediaRenderer:1";
const AV_TRANSPORT_TYPE: &str = "urn:schemas-upnp-org:service:AVTransport:1";
const DEFAULT_SSDP_HOST: &str = "239.255.255.250";
const DEFAULT_SSDP_PORT: u16 = 1900;
const DEFAULT_DISCOVERY_WINDOW_MS: u64 = 1_500;
const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 5_000;
const MAX_XML_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastPayload {
    pub action: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CastSnapshot {
    pub schema_version: String,
    pub state: Value,
}

#[derive(Debug)]
pub enum CastError {
    Invalid(String),
    Network(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CastCapabilities {
    set_av_transport_uri: bool,
    play: bool,
    pause: bool,
    stop: bool,
    seek: bool,
    get_transport_info: bool,
    get_position_info: bool,
}

impl Default for CastCapabilities {
    fn default() -> Self {
        Self {
            set_av_transport_uri: true,
            play: true,
            pause: true,
            stop: true,
            seek: false,
            get_transport_info: false,
            get_position_info: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CastDevice {
    device_id: String,
    friendly_name: String,
    location: String,
    model: String,
    manufacturer: String,
    last_seen: i64,
    capabilities: CastCapabilities,
}

#[derive(Debug, Clone)]
struct DeviceRecord {
    device: CastDevice,
    control_url: String,
    service_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CastSession {
    device: CastDevice,
    media: Value,
    state: String,
    started_at: i64,
    last_position: f64,
    error: Option<Value>,
}

#[derive(Debug, Default)]
struct Runtime {
    discovery_status: String,
    devices: BTreeMap<String, DeviceRecord>,
    session: Option<CastSession>,
    error: Option<Value>,
}

#[derive(Default)]
pub struct CastState {
    runtime: Mutex<Runtime>,
}

#[derive(Debug, Clone)]
struct ParsedDevice {
    device_id: String,
    friendly_name: String,
    manufacturer: String,
    model: String,
    control_url: String,
    scpd_url: String,
    service_type: String,
    capabilities: CastCapabilities,
}

#[derive(Default)]
struct ServiceFields {
    service_type: String,
    control_url: String,
    scpd_url: String,
}

impl CastState {
    pub async fn handle(&self, payload: &CastPayload) -> Result<CastSnapshot, CastError> {
        match payload.action.as_str() {
            "snapshot" => self.snapshot(),
            "discover" => {
                let host = payload
                    .value
                    .get("ssdpHost")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(DEFAULT_SSDP_HOST);
                let port = payload
                    .value
                    .get("ssdpPort")
                    .and_then(Value::as_u64)
                    .and_then(|value| u16::try_from(value).ok())
                    .unwrap_or_else(|| env_port("QX_TAURI_CAST_SSDP_PORT", DEFAULT_SSDP_PORT));
                match self.discover_at(host, port).await {
                    Ok(snapshot) => Ok(snapshot),
                    Err(error) => {
                        self.set_error("error", &error_code(&error), &error_message(&error));
                        self.snapshot()
                    }
                }
            }
            "play" => self.play(&payload.value).await,
            "pause" => self.transport_action("Pause", "paused").await,
            "resume" => self.transport_action("Play", "playing").await,
            "stop" => self.stop().await,
            "seek" => self.seek(&payload.value).await,
            "position" => self.position().await,
            "transport" => self.transport().await,
            "disconnect" => self.disconnect(),
            _ => Err(CastError::Invalid(format!(
                "DLNA_ACTION_UNSUPPORTED:{}",
                payload.action
            ))),
        }
    }

    async fn discover_at(&self, host: &str, port: u16) -> Result<CastSnapshot, CastError> {
        self.set_discovery_status("searching");
        let socket = UdpSocket::bind("0.0.0.0:0")
            .await
            .map_err(|error| CastError::Network(format!("DLNA_DISCOVERY_SOCKET:{error}")))?;
        let payload = format!(
            "M-SEARCH * HTTP/1.1\r\nHOST: {host}:{port}\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: {MEDIA_RENDERER_ST}\r\n\r\n"
        );
        socket
            .send_to(payload.as_bytes(), (host, port))
            .await
            .map_err(|error| CastError::Network(format!("DLNA_DISCOVERY_SEND:{error}")))?;

        let deadline = Instant::now()
            + Duration::from_millis(env_port(
                "QX_TAURI_CAST_DISCOVERY_WINDOW_MS",
                DEFAULT_DISCOVERY_WINDOW_MS.min(u16::MAX as u64) as u16,
            ) as u64);
        let mut responses = BTreeMap::<String, DeviceRecord>::new();
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let received = timeout(remaining, socket.recv_from(&mut buffer)).await;
            let Ok(Ok((size, _remote))) = received else {
                break;
            };
            let headers = parse_ssdp_headers(&buffer[..size]);
            let Some(location) = headers.get("location") else {
                continue;
            };
            let key = format!(
                "{}|{}",
                location,
                headers.get("usn").cloned().unwrap_or_default()
            );
            if responses.contains_key(&key) {
                continue;
            }
            if let Ok(device) = self.read_device(location).await {
                responses.insert(key, device);
            }
        }

        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| CastError::Invalid("DLNA_STATE_POISONED".to_string()))?;
        runtime.devices = responses
            .into_values()
            .map(|record| (record.device.device_id.clone(), record))
            .collect();
        runtime.discovery_status = "ready".to_string();
        runtime.error = None;
        if let Some(session) = &runtime.session {
            if !runtime.devices.contains_key(&session.device.device_id) {
                runtime.session = None;
            }
        }
        drop(runtime);
        self.snapshot()
    }

    async fn read_device(&self, location: &str) -> Result<DeviceRecord, CastError> {
        let location_url = validate_local_http_url(location, "DLNA_LOCATION")?;
        let body = get_limited_text(&location_url).await?;
        let parsed = parse_device_description(&body, location)?;
        let mut capabilities = parsed.capabilities;
        if !parsed.scpd_url.is_empty() {
            if let Ok(scpd) = get_limited_text(
                &Url::parse(&parsed.scpd_url)
                    .map_err(|error| CastError::Invalid(format!("DLNA_SCPD_URL:{error}")))?,
            )
            .await
            {
                let actions = scpd_action_names(&scpd)?;
                capabilities.pause = actions.contains("pause");
                capabilities.seek = actions.contains("seek");
                capabilities.get_transport_info = actions.contains("gettransportinfo");
                capabilities.get_position_info = actions.contains("getpositioninfo");
            }
        }
        let device = CastDevice {
            device_id: parsed.device_id,
            friendly_name: parsed.friendly_name,
            location: location_url.to_string(),
            model: parsed.model,
            manufacturer: parsed.manufacturer,
            last_seen: now_millis(),
            capabilities,
        };
        Ok(DeviceRecord {
            device,
            control_url: parsed.control_url,
            service_type: parsed.service_type,
        })
    }

    async fn play(&self, value: &Value) -> Result<CastSnapshot, CastError> {
        let device_id = required_string(value, "deviceId")?;
        let url = validate_media_url(required_string(value, "url")?)?;
        let title = value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("QX Cast")
            .trim()
            .chars()
            .take(200)
            .collect::<String>();
        if title.is_empty() {
            return Err(CastError::Invalid("DLNA_MEDIA_TITLE_INVALID".to_string()));
        }
        let content_type = value
            .get("contentType")
            .and_then(Value::as_str)
            .filter(|value| !value.contains(['\r', '\n']))
            .unwrap_or_else(|| content_type_for(&url));
        if value
            .get("headers")
            .is_some_and(|headers| headers.as_object().is_some_and(|object| !object.is_empty()))
        {
            return Err(CastError::Invalid(
                "DLNA_MEDIA_HEADERS_UNSUPPORTED".to_string(),
            ));
        }

        let record = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| CastError::Invalid("DLNA_STATE_POISONED".to_string()))?;
            runtime
                .devices
                .get(device_id)
                .cloned()
                .ok_or_else(|| CastError::Invalid("DLNA_DEVICE_NOT_FOUND".to_string()))?
        };
        if !record.device.capabilities.set_av_transport_uri || !record.device.capabilities.play {
            return Err(CastError::Invalid("DLNA_UNSUPPORTED".to_string()));
        }
        let media_url = url.to_string();
        let metadata = didl_metadata(&title, &media_url, content_type);
        soap_request(
            &record.control_url,
            &record.service_type,
            "SetAVTransportURI",
            &[
                ("InstanceID", "0"),
                ("CurrentURI", &media_url),
                ("CurrentURIMetaData", &metadata),
            ],
        )
        .await?;
        soap_request(
            &record.control_url,
            &record.service_type,
            "Play",
            &[("InstanceID", "0"), ("Speed", "1")],
        )
        .await?;

        let session = CastSession {
            device: record.device,
            media: json!({"title": title, "contentType": content_type}),
            state: "playing".to_string(),
            started_at: now_millis(),
            last_position: value
                .get("startPosition")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .max(0.0),
            error: None,
        };
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| CastError::Invalid("DLNA_STATE_POISONED".to_string()))?;
        runtime.session = Some(session);
        runtime.error = None;
        drop(runtime);
        self.snapshot()
    }

    async fn transport_action(
        &self,
        soap_action: &str,
        next_state: &str,
    ) -> Result<CastSnapshot, CastError> {
        let record = self.active_record()?;
        let supported = match soap_action {
            "Pause" => record.device.capabilities.pause,
            "Play" => record.device.capabilities.play,
            _ => false,
        };
        if !supported {
            return Err(CastError::Invalid("DLNA_UNSUPPORTED".to_string()));
        }
        soap_request(
            &record.control_url,
            &record.service_type,
            soap_action,
            &[("InstanceID", "0")],
        )
        .await?;
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| CastError::Invalid("DLNA_STATE_POISONED".to_string()))?;
        if let Some(session) = runtime.session.as_mut() {
            session.state = next_state.to_string();
            session.error = None;
        }
        drop(runtime);
        self.snapshot()
    }

    async fn seek(&self, value: &Value) -> Result<CastSnapshot, CastError> {
        let position = value
            .get("position")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 0.0)
            .ok_or_else(|| CastError::Invalid("DLNA_SEEK_INVALID".to_string()))?;
        let record = self.active_record()?;
        if !record.device.capabilities.seek {
            return Err(CastError::Invalid("DLNA_UNSUPPORTED".to_string()));
        }
        let target = format_time(position);
        soap_request(
            &record.control_url,
            &record.service_type,
            "Seek",
            &[
                ("InstanceID", "0"),
                ("Unit", "REL_TIME"),
                ("Target", &target),
            ],
        )
        .await?;
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| CastError::Invalid("DLNA_STATE_POISONED".to_string()))?;
        if let Some(session) = runtime.session.as_mut() {
            session.last_position = position;
            session.error = None;
        }
        drop(runtime);
        self.snapshot()
    }

    async fn position(&self) -> Result<CastSnapshot, CastError> {
        let record = self.active_record()?;
        if !record.device.capabilities.get_position_info {
            return Err(CastError::Invalid("DLNA_UNSUPPORTED".to_string()));
        }
        let body = soap_request(
            &record.control_url,
            &record.service_type,
            "GetPositionInfo",
            &[("InstanceID", "0")],
        )
        .await?;
        let fields = parse_soap_fields(&body)?;
        let fallback_position = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| CastError::Invalid("DLNA_STATE_POISONED".to_string()))?;
            runtime
                .session
                .as_ref()
                .map(|session| session.last_position)
                .ok_or_else(|| CastError::Invalid("DLNA_SESSION_MISSING".to_string()))?
        };
        let position = fields
            .get("reltime")
            .and_then(|value| parse_time(value))
            .unwrap_or(fallback_position);
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| CastError::Invalid("DLNA_STATE_POISONED".to_string()))?;
        if let Some(session) = runtime.session.as_mut() {
            session.last_position = position;
            if let Some(state) = fields
                .get("currenttransportstate")
                .and_then(|value| state_for_transport(value))
            {
                session.state = state.to_string();
            }
            session.error = None;
        }
        drop(runtime);
        self.snapshot()
    }

    async fn transport(&self) -> Result<CastSnapshot, CastError> {
        let record = self.active_record()?;
        if !record.device.capabilities.get_transport_info {
            return Err(CastError::Invalid("DLNA_UNSUPPORTED".to_string()));
        }
        let body = soap_request(
            &record.control_url,
            &record.service_type,
            "GetTransportInfo",
            &[("InstanceID", "0")],
        )
        .await?;
        let fields = parse_soap_fields(&body)?;
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| CastError::Invalid("DLNA_STATE_POISONED".to_string()))?;
        if let Some(session) = runtime.session.as_mut() {
            if let Some(state) = fields
                .get("currenttransportstate")
                .and_then(|value| state_for_transport(value))
            {
                session.state = state.to_string();
            }
            session.error = None;
        }
        drop(runtime);
        self.snapshot()
    }

    fn active_record(&self) -> Result<DeviceRecord, CastError> {
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| CastError::Invalid("DLNA_STATE_POISONED".to_string()))?;
        let session = runtime
            .session
            .as_ref()
            .ok_or_else(|| CastError::Invalid("DLNA_SESSION_MISSING".to_string()))?;
        runtime
            .devices
            .get(&session.device.device_id)
            .cloned()
            .ok_or_else(|| CastError::Invalid("DLNA_DEVICE_NOT_FOUND".to_string()))
    }

    async fn stop(&self) -> Result<CastSnapshot, CastError> {
        let (record, has_session) = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| CastError::Invalid("DLNA_STATE_POISONED".to_string()))?;
            let Some(session) = runtime.session.as_ref() else {
                return Err(CastError::Invalid("DLNA_SESSION_MISSING".to_string()));
            };
            (
                runtime.devices.get(&session.device.device_id).cloned(),
                true,
            )
        };
        if has_session {
            if let Some(record) = record {
                if record.device.capabilities.stop {
                    soap_request(
                        &record.control_url,
                        &record.service_type,
                        "Stop",
                        &[("InstanceID", "0")],
                    )
                    .await?;
                }
            }
        }
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| CastError::Invalid("DLNA_STATE_POISONED".to_string()))?;
        if let Some(session) = runtime.session.as_mut() {
            session.state = "stopped".to_string();
        }
        drop(runtime);
        self.snapshot()
    }

    fn disconnect(&self) -> Result<CastSnapshot, CastError> {
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| CastError::Invalid("DLNA_STATE_POISONED".to_string()))?;
        runtime.session = None;
        runtime.error = None;
        drop(runtime);
        self.snapshot()
    }

    fn set_discovery_status(&self, status: &str) {
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.discovery_status = status.to_string();
            runtime.error = None;
        }
    }

    fn set_error(&self, _status: &str, code: &str, message: &str) {
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.discovery_status = "error".to_string();
            runtime.error = Some(json!({"code": code, "message": message}));
        }
    }

    fn snapshot(&self) -> Result<CastSnapshot, CastError> {
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| CastError::Invalid("DLNA_STATE_POISONED".to_string()))?;
        Ok(CastSnapshot {
            schema_version: "v1".to_string(),
            state: json!({
                "cast": {
                    "discoveryStatus": if runtime.discovery_status.is_empty() { "idle" } else { &runtime.discovery_status },
                    "devices": runtime.devices.values().map(|record| &record.device).collect::<Vec<_>>(),
                    "session": runtime.session,
                    "error": runtime.error,
                }
            }),
        })
    }
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, CastError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CastError::Invalid(format!("DLNA_{key}_REQUIRED")))
}

fn validate_media_url(value: &str) -> Result<Url, CastError> {
    let parsed =
        Url::parse(value).map_err(|_| CastError::Invalid("DLNA_MEDIA_INVALID".to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(CastError::Invalid("DLNA_MEDIA_INVALID".to_string()));
    }
    Ok(parsed)
}

fn validate_local_http_url(value: &str, prefix: &str) -> Result<Url, CastError> {
    let parsed = Url::parse(value).map_err(|_| CastError::Invalid(format!("{prefix}_INVALID")))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| CastError::Invalid(format!("{prefix}_INVALID")))?;
    if parsed.scheme() != "http"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !is_local_host(host)
    {
        return Err(CastError::Invalid(format!("{prefix}_BLOCKED")));
    }
    Ok(parsed)
}

fn is_local_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>()
        .map(|address| match address {
            IpAddr::V4(value) => value.is_loopback() || value.is_private(),
            IpAddr::V6(value) => value.is_loopback() || (value.segments()[0] & 0xfe00) == 0xfc00,
        })
        .unwrap_or(false)
}

fn parse_device_description(xml: &str, location: &str) -> Result<ParsedDevice, CastError> {
    if xml.len() > MAX_XML_BYTES || xml.contains("<!DOCTYPE") || xml.contains("<!ENTITY") {
        return Err(CastError::Invalid("DLNA_XML_UNSAFE".to_string()));
    }
    let base = validate_local_http_url(location, "DLNA_LOCATION")?;
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut current_tag = String::new();
    let mut friendly_name = String::new();
    let mut manufacturer = String::new();
    let mut model = String::new();
    let mut device_id = String::new();
    let mut current_service: Option<ServiceFields> = None;
    let mut selected_service: Option<ServiceFields> = None;
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => {
                let name = local_name(event.name().as_ref());
                if name.eq_ignore_ascii_case("service") {
                    current_service = Some(ServiceFields::default());
                }
                current_tag = name;
            }
            Ok(Event::Text(event)) => {
                let value =
                    quick_xml::escape::unescape(&event.decode().map_err(|error| {
                        CastError::Invalid(format!("DLNA_XML_INVALID:{error}"))
                    })?)
                    .map_err(|error| CastError::Invalid(format!("DLNA_XML_INVALID:{error}")))?
                    .trim()
                    .to_string();
                if let Some(service) = current_service.as_mut() {
                    match current_tag.to_ascii_lowercase().as_str() {
                        "servicetype" => service.service_type = value,
                        "controlurl" => service.control_url = value,
                        "scpdurl" => service.scpd_url = value,
                        _ => {}
                    }
                } else {
                    match current_tag.to_ascii_lowercase().as_str() {
                        "friendlyname" => friendly_name = value,
                        "manufacturer" => manufacturer = value,
                        "modelname" => model = value,
                        "udn" => device_id = value,
                        _ => {}
                    }
                }
            }
            Ok(Event::End(event)) => {
                let name = local_name(event.name().as_ref());
                if name.eq_ignore_ascii_case("service") {
                    if let Some(service) = current_service.take() {
                        if service.service_type.eq_ignore_ascii_case(AV_TRANSPORT_TYPE)
                            || service
                                .service_type
                                .to_ascii_lowercase()
                                .contains("avtransport")
                        {
                            selected_service = Some(service);
                        }
                    }
                }
                current_tag.clear();
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(CastError::Invalid(format!("DLNA_XML_INVALID:{error}"))),
            _ => {}
        }
        buffer.clear();
    }
    let service = selected_service
        .ok_or_else(|| CastError::Invalid("DLNA_AVTRANSPORT_MISSING".to_string()))?;
    let control_url = resolve_same_origin(&base, &service.control_url, "DLNA_CONTROL_URL")?;
    let scpd_url = if service.scpd_url.is_empty() {
        String::new()
    } else {
        resolve_same_origin(&base, &service.scpd_url, "DLNA_SCPD_URL")?
    };
    Ok(ParsedDevice {
        device_id: if device_id.is_empty() {
            base.to_string()
        } else {
            device_id
        },
        friendly_name: if friendly_name.is_empty() {
            "MediaRenderer".to_string()
        } else {
            friendly_name
        },
        manufacturer: if manufacturer.is_empty() {
            "Unknown".to_string()
        } else {
            manufacturer
        },
        model: if model.is_empty() {
            "MediaRenderer".to_string()
        } else {
            model
        },
        control_url,
        scpd_url,
        service_type: if service.service_type.is_empty() {
            AV_TRANSPORT_TYPE.to_string()
        } else {
            service.service_type
        },
        capabilities: CastCapabilities::default(),
    })
}

fn resolve_same_origin(base: &Url, value: &str, prefix: &str) -> Result<String, CastError> {
    let resolved = base
        .join(value)
        .map_err(|_| CastError::Invalid(format!("{prefix}_INVALID")))?;
    if resolved.scheme() != "http"
        || resolved.host_str() != base.host_str()
        || resolved.port_or_known_default() != base.port_or_known_default()
    {
        return Err(CastError::Invalid(format!("{prefix}_BLOCKED")));
    }
    Ok(resolved.to_string())
}

fn parse_ssdp_headers(bytes: &[u8]) -> BTreeMap<String, String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect()
}

fn scpd_action_names(xml: &str) -> Result<std::collections::BTreeSet<String>, CastError> {
    if xml.len() > MAX_XML_BYTES || xml.contains("<!DOCTYPE") || xml.contains("<!ENTITY") {
        return Err(CastError::Invalid("DLNA_XML_UNSAFE".to_string()));
    }
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut tag = String::new();
    let mut actions = std::collections::BTreeSet::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => tag = local_name(event.name().as_ref()),
            Ok(Event::Text(event)) if tag.eq_ignore_ascii_case("name") => {
                actions.insert(
                    event
                        .decode()
                        .map_err(|error| CastError::Invalid(format!("DLNA_XML_INVALID:{error}")))?
                        .trim()
                        .to_ascii_lowercase(),
                );
            }
            Ok(Event::End(_)) => tag.clear(),
            Ok(Event::Eof) => break,
            Err(error) => return Err(CastError::Invalid(format!("DLNA_XML_INVALID:{error}"))),
            _ => {}
        }
        buffer.clear();
    }
    Ok(actions)
}

async fn get_limited_text(url: &Url) -> Result<String, CastError> {
    let mut builder = Client::builder().timeout(Duration::from_millis(env_port(
        "QX_TAURI_CAST_TIMEOUT_MS",
        DEFAULT_REQUEST_TIMEOUT_MS.min(u16::MAX as u64) as u16,
    ) as u64));
    if url.host_str().is_some_and(is_local_host) {
        builder = builder.no_proxy();
    }
    let response = builder
        .build()
        .map_err(|error| CastError::Network(format!("DLNA_HTTP_CLIENT:{error}")))?
        .get(url.clone())
        .send()
        .await
        .map_err(|error| CastError::Network(format!("DLNA_HTTP_REQUEST:{error}")))?;
    if !response.status().is_success() {
        return Err(CastError::Network(format!(
            "DLNA_HTTP_{}",
            response.status().as_u16()
        )));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_XML_BYTES as u64)
    {
        return Err(CastError::Invalid("DLNA_XML_TOO_LARGE".to_string()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| CastError::Network(format!("DLNA_HTTP_BODY:{error}")))?;
    if bytes.len() > MAX_XML_BYTES {
        return Err(CastError::Invalid("DLNA_XML_TOO_LARGE".to_string()));
    }
    String::from_utf8(bytes.to_vec())
        .map_err(|_| CastError::Invalid("DLNA_XML_INVALID".to_string()))
}

async fn soap_request(
    control_url: &str,
    service_type: &str,
    action: &str,
    arguments: &[(&str, &str)],
) -> Result<String, CastError> {
    let control = validate_local_http_url(control_url, "DLNA_CONTROL_URL")?;
    let body = build_soap_envelope(service_type, action, arguments);
    let response = Client::builder()
        .timeout(Duration::from_millis(env_port(
            "QX_TAURI_CAST_TIMEOUT_MS",
            DEFAULT_REQUEST_TIMEOUT_MS.min(u16::MAX as u64) as u16,
        ) as u64))
        .no_proxy()
        .build()
        .map_err(|error| CastError::Network(format!("DLNA_HTTP_CLIENT:{error}")))?
        .post(control)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPAction", format!("\"{service_type}#{action}\""))
        .body(body)
        .send()
        .await
        .map_err(|error| CastError::Network(format!("DLNA_SOAP_REQUEST:{error}")))?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|size| size > MAX_XML_BYTES as u64)
    {
        return Err(CastError::Invalid("DLNA_XML_TOO_LARGE".to_string()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| CastError::Network(format!("DLNA_SOAP_BODY:{error}")))?;
    if bytes.len() > MAX_XML_BYTES {
        return Err(CastError::Invalid("DLNA_XML_TOO_LARGE".to_string()));
    }
    let body = String::from_utf8(bytes.to_vec())
        .map_err(|_| CastError::Invalid("DLNA_XML_INVALID".to_string()))?;
    if !status.is_success() || body.contains("<Fault") || body.contains(":Fault") {
        return Err(CastError::Network("DLNA_SOAP_FAULT".to_string()));
    }
    if body.len() > MAX_XML_BYTES || body.contains("<!DOCTYPE") || body.contains("<!ENTITY") {
        return Err(CastError::Invalid("DLNA_XML_UNSAFE".to_string()));
    }
    Ok(body)
}

fn build_soap_envelope(service_type: &str, action: &str, arguments: &[(&str, &str)]) -> String {
    let mut body = format!(
        "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{}\">",
        xml_escape(service_type)
    );
    for (key, value) in arguments {
        body.push('<');
        body.push_str(key);
        body.push('>');
        body.push_str(&xml_escape(value));
        body.push_str("</");
        body.push_str(key);
        body.push('>');
    }
    body.push_str(&format!("</u:{action}></s:Body></s:Envelope>"));
    body
}

fn didl_metadata(title: &str, url: &str, content_type: &str) -> String {
    format!(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"><item id=\"0\" parentID=\"-1\" restricted=\"1\"><dc:title>{}</dc:title><upnp:class>object.item.videoItem</upnp:class><res protocolInfo=\"http-get:*:{}:*\">{}</res></item></DIDL-Lite>",
        xml_escape(title),
        xml_escape(content_type),
        xml_escape(url)
    )
}

fn content_type_for(url: &Url) -> &'static str {
    let path = url.path().to_ascii_lowercase();
    if path.ends_with(".m3u8") {
        "application/vnd.apple.mpegurl"
    } else if path.ends_with(".mpd") {
        "application/dash+xml"
    } else if path.ends_with(".mp4") {
        "video/mp4"
    } else if path.ends_with(".webm") {
        "video/webm"
    } else {
        "video/*"
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn parse_soap_fields(xml: &str) -> Result<BTreeMap<String, String>, CastError> {
    if xml.len() > MAX_XML_BYTES || xml.contains("<!DOCTYPE") || xml.contains("<!ENTITY") {
        return Err(CastError::Invalid("DLNA_XML_UNSAFE".to_string()));
    }
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut current_tag = String::new();
    let mut fields = BTreeMap::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => current_tag = local_name(event.name().as_ref()),
            Ok(Event::Text(event)) if !current_tag.is_empty() => {
                let value =
                    quick_xml::escape::unescape(&event.decode().map_err(|error| {
                        CastError::Invalid(format!("DLNA_XML_INVALID:{error}"))
                    })?)
                    .map_err(|error| CastError::Invalid(format!("DLNA_XML_INVALID:{error}")))?
                    .trim()
                    .to_string();
                if !value.is_empty() {
                    fields.insert(current_tag.to_ascii_lowercase(), value);
                }
            }
            Ok(Event::End(_)) => current_tag.clear(),
            Ok(Event::Eof) => break,
            Err(error) => return Err(CastError::Invalid(format!("DLNA_XML_INVALID:{error}"))),
            _ => {}
        }
        buffer.clear();
    }
    Ok(fields)
}

fn parse_time(value: &str) -> Option<f64> {
    let parts = value.trim().split(':').collect::<Vec<_>>();
    if parts.len() != 3 || parts[0].len() < 2 || parts[1].len() != 2 {
        return None;
    }
    let hours = parts[0].parse::<u64>().ok()?;
    let minutes = parts[1].parse::<u64>().ok()?;
    let seconds = parts[2].parse::<f64>().ok()?;
    if minutes > 59 || !seconds.is_finite() || !(0.0..60.0).contains(&seconds) {
        return None;
    }
    Some(hours as f64 * 3_600.0 + minutes as f64 * 60.0 + seconds)
}

fn format_time(value: f64) -> String {
    let whole = value.floor() as u64;
    let hours = whole / 3_600;
    let minutes = (whole % 3_600) / 60;
    let seconds = whole % 60;
    format!("{hours:02}:{minutes:02}:{seconds:02}")
}

fn state_for_transport(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_uppercase().as_str() {
        "PLAYING" => Some("playing"),
        "PAUSED_PLAYBACK" | "PAUSED" => Some("paused"),
        "STOPPED" | "NO_MEDIA_PRESENT" => Some("stopped"),
        _ => None,
    }
}

fn local_name(value: &[u8]) -> String {
    String::from_utf8_lossy(value)
        .rsplit(':')
        .next()
        .unwrap_or_default()
        .to_string()
}

fn env_port(name: &str, fallback: u16) -> u16 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .and_then(|value| u16::try_from(value).ok())
        .unwrap_or(fallback)
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn error_code(error: &CastError) -> String {
    match error {
        CastError::Invalid(message) | CastError::Network(message) => message
            .split(':')
            .next()
            .unwrap_or("DLNA_CAST_FAILED")
            .to_string(),
    }
}

fn error_message(error: &CastError) -> String {
    match error {
        CastError::Invalid(message) | CastError::Network(message) => message.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_soap_envelope, parse_device_description, validate_media_url, CastPayload, CastState,
        AV_TRANSPORT_TYPE, MEDIA_RENDERER_ST,
    };
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, UdpSocket};

    #[test]
    fn parses_avtransport_device_description_without_external_entities() {
        let xml = r#"<?xml version="1.0"?>
            <root><device>
              <friendlyName>Fixture TV</friendlyName>
              <manufacturer>QX Fixture</manufacturer>
              <modelName>Cast Model</modelName>
              <UDN>uuid:fixture-renderer</UDN>
              <serviceList><service>
                <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
                <SCPDURL>/scpd.xml</SCPDURL>
                <controlURL>/control</controlURL>
              </service></serviceList>
            </device></root>"#;

        let device = parse_device_description(xml, "http://127.0.0.1:39501/device.xml")
            .expect("device description");
        assert_eq!(device.device_id, "uuid:fixture-renderer");
        assert_eq!(device.friendly_name, "Fixture TV");
        assert_eq!(device.control_url, "http://127.0.0.1:39501/control");
        assert_eq!(device.scpd_url, "http://127.0.0.1:39501/scpd.xml");
        assert!(device.capabilities.set_av_transport_uri);
        assert!(device.capabilities.play);
        assert!(device.capabilities.stop);
    }

    #[test]
    fn rejects_credentialed_and_non_http_media_urls() {
        assert!(validate_media_url("https://media.example.test/movie.m3u8").is_ok());
        assert!(validate_media_url("file:///C:/movie.mp4").is_err());
        assert!(validate_media_url("https://user:pass@media.example.test/movie.mp4").is_err());
    }

    #[test]
    fn builds_bounded_set_uri_soap_request() {
        let body = build_soap_envelope(
            AV_TRANSPORT_TYPE,
            "SetAVTransportURI",
            &[
                ("InstanceID", "0"),
                ("CurrentURI", "https://media.example.test/a.mp4"),
            ],
        );
        assert!(body.contains("SetAVTransportURI"));
        assert!(body.contains("CurrentURI"));
        assert!(!body.contains("Authorization"));
        assert!(body.len() < 16 * 1024);
    }

    #[tokio::test]
    async fn completes_local_ssdp_description_and_soap_playback_chain() {
        let http = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("HTTP listener");
        let http_address = http.local_addr().expect("HTTP address");
        let ssdp = UdpSocket::bind("127.0.0.1:0").await.expect("SSDP listener");
        let ssdp_address = ssdp.local_addr().expect("SSDP address");
        let ssdp_task = tokio::spawn(async move {
            let mut buffer = [0_u8; 4096];
            let (_, remote) = ssdp.recv_from(&mut buffer).await.expect("M-SEARCH");
            let response = format!(
                "HTTP/1.1 200 OK\r\nLOCATION: http://{http_address}/device.xml\r\nUSN: uuid:fixture-renderer::upnp:rootdevice\r\nST: {MEDIA_RENDERER_ST}\r\n\r\n"
            );
            ssdp.send_to(response.as_bytes(), remote)
                .await
                .expect("SSDP response");
        });
        let http_task = tokio::spawn(async move {
            for _ in 0..10 {
                let (mut stream, _) = http.accept().await.expect("HTTP request");
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let size = stream.read(&mut buffer).await.expect("HTTP request bytes");
                    if size == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..size]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8_lossy(&request);
                let body = if request.contains("GET /device.xml") {
                    format!(
                        "<?xml version=\"1.0\"?><root><device><friendlyName>Fixture TV</friendlyName><manufacturer>QX Fixture</manufacturer><modelName>Cast Model</modelName><UDN>uuid:fixture-renderer</UDN><serviceList><service><serviceType>{AV_TRANSPORT_TYPE}</serviceType><SCPDURL>/scpd.xml</SCPDURL><controlURL>/control</controlURL></service></serviceList></device></root>"
                    )
                } else if request.contains("GET /scpd.xml") {
                    "<scpd><actionList><action><name>SetAVTransportURI</name></action><action><name>Play</name></action><action><name>Pause</name></action><action><name>Stop</name></action><action><name>Seek</name></action><action><name>GetPositionInfo</name></action><action><name>GetTransportInfo</name></action></actionList></scpd>".to_string()
                } else if request.contains("GetPositionInfo") {
                    "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:GetPositionInfoResponse xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><TrackDuration>00:10:00</TrackDuration><RelTime>00:01:02</RelTime><CurrentTransportState>PLAYING</CurrentTransportState></u:GetPositionInfoResponse></s:Body></s:Envelope>".to_string()
                } else if request.contains("GetTransportInfo") {
                    "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:GetTransportInfoResponse xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><CurrentTransportState>PAUSED_PLAYBACK</CurrentTransportState></u:GetTransportInfoResponse></s:Body></s:Envelope>".to_string()
                } else {
                    "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body></s:Body></s:Envelope>".to_string()
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("HTTP response");
            }
        });

        let state = CastState::default();
        let discovered = state
            .discover_at("127.0.0.1", ssdp_address.port())
            .await
            .expect("discover");
        assert_eq!(discovered.state["cast"]["discoveryStatus"], "ready");
        assert_eq!(
            discovered.state["cast"]["devices"].as_array().map(Vec::len),
            Some(1)
        );

        let playing = state
            .handle(&CastPayload {
                action: "play".to_string(),
                value: json!({
                    "deviceId": "uuid:fixture-renderer",
                    "url": "https://media.example.test/movie.mp4",
                    "title": "Fixture Movie"
                }),
            })
            .await
            .expect("play");
        assert_eq!(playing.state["cast"]["session"]["state"], "playing");

        let paused = state
            .handle(&CastPayload {
                action: "pause".to_string(),
                value: json!({}),
            })
            .await
            .expect("pause");
        assert_eq!(paused.state["cast"]["session"]["state"], "paused");

        let resumed = state
            .handle(&CastPayload {
                action: "resume".to_string(),
                value: json!({}),
            })
            .await
            .expect("resume");
        assert_eq!(resumed.state["cast"]["session"]["state"], "playing");

        let sought = state
            .handle(&CastPayload {
                action: "seek".to_string(),
                value: json!({"position": 42.0}),
            })
            .await
            .expect("seek");
        assert_eq!(sought.state["cast"]["session"]["lastPosition"], 42.0);

        let position = state
            .handle(&CastPayload {
                action: "position".to_string(),
                value: json!({}),
            })
            .await
            .expect("position");
        assert_eq!(position.state["cast"]["session"]["lastPosition"], 62.0);
        assert_eq!(position.state["cast"]["session"]["state"], "playing");

        let transport = state
            .handle(&CastPayload {
                action: "transport".to_string(),
                value: json!({}),
            })
            .await
            .expect("transport");
        assert_eq!(transport.state["cast"]["session"]["state"], "paused");

        let stopped = state
            .handle(&CastPayload {
                action: "stop".to_string(),
                value: json!({}),
            })
            .await
            .expect("stop");
        assert_eq!(stopped.state["cast"]["session"]["state"], "stopped");

        let disconnected = state
            .handle(&CastPayload {
                action: "disconnect".to_string(),
                value: json!({}),
            })
            .await
            .expect("disconnect");
        assert!(disconnected.state["cast"]["session"].is_null());

        ssdp_task.await.expect("SSDP task");
        http_task.await.expect("HTTP task");
    }
}
