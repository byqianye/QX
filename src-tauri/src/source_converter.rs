use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Debug)]
pub enum SourceConverterError {
    Invalid(String),
    Unsupported(String),
}

pub fn compile_source_spec(
    api: &str,
    ext: &str,
) -> Result<CompiledSourceAdapter, SourceConverterError> {
    if !api.trim().to_ascii_lowercase().starts_with("csp_") {
        return Err(SourceConverterError::Unsupported(
            "ADAPTER_API_MUST_BE_CSP".to_string(),
        ));
    }
    let document: AdapterDocument = serde_json::from_str(ext)
        .map_err(|_| SourceConverterError::Unsupported("ADAPTER_CONTRACT_REQUIRED".to_string()))?;
    if document.qx_adapter_version != 1 {
        return Err(SourceConverterError::Unsupported(
            "ADAPTER_VERSION_UNSUPPORTED".to_string(),
        ));
    }
    if document.operations.is_empty() {
        return Err(SourceConverterError::Invalid(
            "ADAPTER_OPERATIONS_REQUIRED".to_string(),
        ));
    }
    let base_url = validate_base_url(&document.base_url)?;
    let mut operations = BTreeMap::new();
    for (name, operation) in document.operations {
        let normalized_name = name.trim().to_ascii_lowercase();
        if normalized_name.is_empty() {
            return Err(SourceConverterError::Invalid(
                "ADAPTER_OPERATION_NAME_REQUIRED".to_string(),
            ));
        }
        operations.insert(normalized_name, compile_operation(operation)?);
    }
    Ok(CompiledSourceAdapter {
        base_url,
        operations,
    })
}

#[derive(Debug, Clone)]
pub struct CompiledSourceAdapter {
    base_url: String,
    operations: BTreeMap<String, CompiledOperation>,
}

#[derive(Debug, Clone)]
pub struct AdapterRequest {
    pub method: String,
    pub url: String,
    pub headers: Map<String, Value>,
    pub body: Option<Value>,
}

impl CompiledSourceAdapter {
    pub fn supports(&self, method: &str) -> bool {
        self.operation(method).is_ok()
    }

    pub fn build_request(
        &self,
        method: &str,
        params: &Value,
    ) -> Result<AdapterRequest, SourceConverterError> {
        let operation = self.operation(method)?;
        let rendered_path = render_template(&operation.path, params)?;
        validate_relative_path(&rendered_path)?;
        let base_url = reqwest::Url::parse(&self.base_url)
            .map_err(|_| SourceConverterError::Invalid("ADAPTER_BASE_URL_INVALID".to_string()))?;
        let mut url = base_url
            .join(&rendered_path)
            .map_err(|_| SourceConverterError::Invalid("ADAPTER_PATH_INVALID".to_string()))?;
        if url.scheme() != base_url.scheme()
            || url.host_str() != base_url.host_str()
            || url.port_or_known_default() != base_url.port_or_known_default()
        {
            return Err(SourceConverterError::Invalid(
                "ADAPTER_PATH_MUST_BE_RELATIVE".to_string(),
            ));
        }
        for (name, value) in &operation.query {
            let value = render_value(value, params)?;
            let value = scalar_to_text(&value).ok_or_else(|| {
                SourceConverterError::Invalid(format!("ADAPTER_QUERY_VALUE_INVALID:{name}"))
            })?;
            url.query_pairs_mut().append_pair(name, &value);
        }
        let body = operation
            .body
            .as_ref()
            .map(|body| render_value(body, params))
            .transpose()?;
        let headers = operation
            .headers
            .iter()
            .map(|(name, value)| Ok((name.clone(), render_value(value, params)?)))
            .collect::<Result<Map<_, _>, SourceConverterError>>()?;
        if body.is_some() && operation.method == "GET" {
            return Err(SourceConverterError::Invalid(
                "ADAPTER_GET_BODY_UNSUPPORTED".to_string(),
            ));
        }
        Ok(AdapterRequest {
            method: operation.method.clone(),
            url: url.to_string(),
            headers,
            body,
        })
    }

    pub fn map_response(&self, method: &str, body: Value) -> Result<Value, SourceConverterError> {
        let operation = self.operation(method)?;
        let Some(response) = &operation.response else {
            return Ok(body);
        };
        let root = select_pointer(&body, response.root.as_deref().unwrap_or("/"))?;
        if response.fields.is_empty() && response.list.is_none() {
            return Ok(root.clone());
        }
        let mut output = Map::new();
        for (name, path) in &response.fields {
            let (pointer, optional) = split_optional_pointer(path);
            match select_pointer(root, pointer) {
                Ok(value) => {
                    output.insert(name.clone(), value.clone());
                }
                Err(_error) if optional => {}
                Err(error) => return Err(error),
            }
        }
        if let Some(list) = &response.list {
            let values = select_pointer(root, &list.path)?
                .as_array()
                .ok_or_else(|| {
                    SourceConverterError::Invalid(format!(
                        "ADAPTER_RESPONSE_ARRAY_REQUIRED:{}",
                        list.path
                    ))
                })?;
            let mut mapped = Vec::with_capacity(values.len());
            for value in values {
                if list.item.is_empty() {
                    mapped.push(value.clone());
                    continue;
                }
                let mut item = Map::new();
                for (name, path) in &list.item {
                    let (pointer, optional) = split_optional_pointer(path);
                    match select_pointer(value, pointer) {
                        Ok(field) => {
                            item.insert(name.clone(), field.clone());
                        }
                        Err(_error) if optional => {}
                        Err(error) => return Err(error),
                    }
                }
                mapped.push(Value::Object(item));
            }
            output.insert("list".to_string(), Value::Array(mapped));
        }
        Ok(Value::Object(output))
    }

    fn operation(&self, method: &str) -> Result<&CompiledOperation, SourceConverterError> {
        let normalized = method.to_ascii_lowercase();
        let operation = self.operations.get(&normalized).or_else(|| {
            // The host protocol uses both names for the same playback step.
            // Resolve the alias only when the requested spelling is absent;
            // an explicitly declared operation always wins.
            match normalized.as_str() {
                "player" => self.operations.get("playback"),
                "playback" => self.operations.get("player"),
                _ => None,
            }
        });
        operation.ok_or_else(|| {
            SourceConverterError::Unsupported(format!("ADAPTER_OPERATION_UNSUPPORTED:{normalized}"))
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterDocument {
    qx_adapter_version: u8,
    base_url: String,
    operations: BTreeMap<String, AdapterOperation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterOperation {
    method: Option<String>,
    path: String,
    #[serde(default)]
    query: Map<String, Value>,
    #[serde(default)]
    headers: Map<String, Value>,
    body: Option<Value>,
    response: Option<AdapterResponse>,
}

#[derive(Debug, Clone)]
struct CompiledOperation {
    method: String,
    path: String,
    query: Map<String, Value>,
    headers: Map<String, Value>,
    body: Option<Value>,
    response: Option<AdapterResponse>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AdapterResponse {
    root: Option<String>,
    #[serde(default)]
    fields: BTreeMap<String, String>,
    list: Option<AdapterList>,
}

#[derive(Debug, Clone, Deserialize)]
struct AdapterList {
    path: String,
    #[serde(default)]
    item: BTreeMap<String, String>,
}

fn compile_operation(
    operation: AdapterOperation,
) -> Result<CompiledOperation, SourceConverterError> {
    let method = operation
        .method
        .unwrap_or_else(|| "GET".to_string())
        .to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "POST") {
        return Err(SourceConverterError::Unsupported(format!(
            "ADAPTER_METHOD_UNSUPPORTED:{method}"
        )));
    }
    if operation.path.trim().is_empty() {
        return Err(SourceConverterError::Invalid(
            "ADAPTER_PATH_REQUIRED".to_string(),
        ));
    }
    validate_relative_path(&operation.path)?;
    validate_headers(&operation.headers)?;
    Ok(CompiledOperation {
        method,
        path: operation.path,
        query: operation.query,
        headers: operation.headers,
        body: operation.body,
        response: operation.response,
    })
}

fn validate_relative_path(path: &str) -> Result<(), SourceConverterError> {
    if path.contains("://")
        || path.starts_with("//")
        || path.starts_with("\\\\")
        || path
            .split(|character| matches!(character, '/' | '\\' | '?' | '#'))
            .any(is_parent_segment)
    {
        return Err(SourceConverterError::Invalid(
            "ADAPTER_PATH_MUST_BE_RELATIVE".to_string(),
        ));
    }
    Ok(())
}

fn is_parent_segment(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    let mut index = 0;
    let mut dots = 0;
    while index < bytes.len() {
        if bytes[index] == b'.' {
            dots += 1;
            index += 1;
        } else if index + 2 < bytes.len()
            && bytes[index] == b'%'
            && bytes[index + 1] == b'2'
            && matches!(bytes[index + 2], b'e' | b'E')
        {
            dots += 1;
            index += 3;
        } else {
            return false;
        }
    }
    dots == 2
}

fn validate_base_url(value: &str) -> Result<String, SourceConverterError> {
    let url = reqwest::Url::parse(value.trim())
        .map_err(|_| SourceConverterError::Invalid("ADAPTER_BASE_URL_INVALID".to_string()))?;
    if !matches!(url.scheme(), "http" | "https") || url.username() != "" || url.password().is_some()
    {
        return Err(SourceConverterError::Invalid(
            "ADAPTER_BASE_URL_INVALID".to_string(),
        ));
    }
    Ok(url.to_string())
}

fn validate_headers(headers: &Map<String, Value>) -> Result<(), SourceConverterError> {
    for (name, value) in headers {
        if !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
            || !value.is_string()
            || name.eq_ignore_ascii_case("host")
            || name.eq_ignore_ascii_case("connection")
        {
            return Err(SourceConverterError::Invalid(format!(
                "ADAPTER_HEADER_INVALID:{name}"
            )));
        }
    }
    Ok(())
}

fn render_value(value: &Value, params: &Value) -> Result<Value, SourceConverterError> {
    match value {
        Value::String(value) => Ok(Value::String(render_template(value, params)?)),
        Value::Array(values) => Ok(Value::Array(
            values
                .iter()
                .map(|value| render_value(value, params))
                .collect::<Result<Vec<_>, _>>()?,
        )),
        Value::Object(values) => Ok(Value::Object(
            values
                .iter()
                .map(|(key, value)| Ok((key.clone(), render_value(value, params)?)))
                .collect::<Result<Map<_, _>, SourceConverterError>>()?,
        )),
        value => Ok(value.clone()),
    }
}

fn render_template(template: &str, params: &Value) -> Result<String, SourceConverterError> {
    let mut output = String::with_capacity(template.len());
    let mut cursor = 0;
    while let Some(start_offset) = template[cursor..].find('{') {
        let start = cursor + start_offset;
        output.push_str(&template[cursor..start]);
        let end = template[start + 1..]
            .find('}')
            .map(|offset| start + 1 + offset)
            .ok_or_else(|| SourceConverterError::Invalid("ADAPTER_TEMPLATE_INVALID".to_string()))?;
        let key = &template[start + 1..end];
        let value = lookup_param(params, key).ok_or_else(|| {
            SourceConverterError::Invalid(format!("ADAPTER_PARAMETER_MISSING:{key}"))
        })?;
        let value = scalar_to_text(value).ok_or_else(|| {
            SourceConverterError::Invalid(format!("ADAPTER_PARAMETER_NOT_SCALAR:{key}"))
        })?;
        output.push_str(&value);
        cursor = end + 1;
    }
    output.push_str(&template[cursor..]);
    Ok(output)
}

fn lookup_param<'a>(params: &'a Value, key: &str) -> Option<&'a Value> {
    let mut value = params;
    for part in key.split('.') {
        value = value.get(part)?;
    }
    Some(value)
}

fn scalar_to_text(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Array(values) => Some(
            values
                .iter()
                .filter_map(scalar_to_text)
                .collect::<Vec<_>>()
                .join(","),
        ),
        _ => None,
    }
}

fn select_pointer<'a>(value: &'a Value, pointer: &str) -> Result<&'a Value, SourceConverterError> {
    let pointer = if pointer.is_empty() { "/" } else { pointer };
    if pointer == "/" {
        return Ok(value);
    }
    value.pointer(pointer).ok_or_else(|| {
        SourceConverterError::Invalid(format!("ADAPTER_RESPONSE_PATH_MISSING:{pointer}"))
    })
}

/// A mapping path ending in `?` is optional. This keeps contracts useful
/// across sources that omit non-essential metadata while preserving strict
/// failures for required fields and list roots.
fn split_optional_pointer(path: &str) -> (&str, bool) {
    path.strip_suffix('?')
        .map_or((path, false), |pointer| (pointer, true))
}

#[cfg(test)]
mod tests {
    use super::{compile_source_spec, SourceConverterError};
    use serde_json::json;

    #[test]
    fn rejects_csp_without_an_explicit_http_contract() {
        let error = compile_source_spec("csp_Bili", r#"{"ext":"https://example.test"}"#)
            .expect_err("a source-specific runtime must not be guessed");
        assert!(
            matches!(error, SourceConverterError::Unsupported(message) if message == "ADAPTER_CONTRACT_REQUIRED")
        );
    }

    #[test]
    fn rejects_an_absolute_operation_path() {
        let error = compile_source_spec(
            "csp_Example",
            r#"{
              "qxAdapterVersion": 1,
              "baseUrl": "https://example.test/api",
              "operations": {"search": {"path": "https://other.test/search"}}
            }"#,
        )
        .expect_err("adapter must stay below its configured base URL");
        assert!(
            matches!(error, SourceConverterError::Invalid(message) if message == "ADAPTER_PATH_MUST_BE_RELATIVE")
        );
    }

    #[test]
    fn rejects_a_rendered_path_that_escapes_the_configured_origin() {
        let adapter = compile_source_spec(
            "csp_Example",
            r#"{
              "qxAdapterVersion": 1,
              "baseUrl": "https://example.test/api/",
              "operations": {"detail": {"path": "{id}"}}
            }"#,
        )
        .expect("contract compiles");

        for id in ["https://evil.test/detail", "//evil.test/detail", "../admin"] {
            let error = adapter
                .build_request("detail", &json!({"id": id}))
                .expect_err("rendered path must stay within its configured boundary");
            assert!(
                matches!(error, SourceConverterError::Invalid(message) if message == "ADAPTER_PATH_MUST_BE_RELATIVE")
            );
        }
    }

    #[test]
    fn builds_a_typed_search_request_from_a_declarative_contract() {
        let adapter = compile_source_spec(
            "csp_Example",
            r#"
            {
              "qxAdapterVersion": 1,
              "baseUrl": "https://example.test/api",
              "operations": {
                "search": {
                  "method": "GET",
                  "path": "/search",
                  "query": {"wd": "{key}", "pg": "{page}"}
                }
              }
            }
            "#,
        )
        .expect("contract compiles");
        let request = adapter
            .build_request("search", &json!({"key": "星际", "page": 2}))
            .expect("search request builds");
        assert_eq!(request.method, "GET");
        let query = reqwest::Url::parse(&request.url)
            .expect("request URL parses")
            .query_pairs()
            .into_owned()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(query.get("wd"), Some(&"星际".to_string()));
        assert_eq!(query.get("pg"), Some(&"2".to_string()));
    }

    #[test]
    fn maps_json_items_to_the_tvbox_shape_without_executing_code() {
        let adapter = compile_source_spec(
            "csp_Example",
            r#"
            {
              "qxAdapterVersion": 1,
              "baseUrl": "https://example.test/api",
              "operations": {
                "search": {
                  "method": "GET",
                  "path": "/search",
                  "response": {
                    "root": "/data",
                    "fields": {"total": "/total"},
                    "list": {
                      "path": "/items",
                      "item": {
                        "vod_id": "/id",
                        "vod_name": "/title",
                        "vod_pic": "/cover"
                      }
                    }
                  }
                }
              }
            }
            "#,
        )
        .expect("contract compiles");
        let output = adapter
            .map_response(
                "search",
                json!({
                    "data": {
                        "total": 1,
                        "items": [{"id": "v1", "title": "示例", "cover": "https://img.test/1.jpg"}]
                    }
                }),
            )
            .expect("response maps");
        assert_eq!(output["total"], 1);
        assert_eq!(output["list"][0]["vod_id"], "v1");
        assert_eq!(output["list"][0]["vod_name"], "示例");
        assert_eq!(output["list"][0]["vod_pic"], "https://img.test/1.jpg");
    }

    #[test]
    fn treats_player_and_playback_as_bidirectional_contract_aliases() {
        let adapter = compile_source_spec(
            "csp_Example",
            r#"
            {
              "qxAdapterVersion": 1,
              "baseUrl": "https://example.test/api",
              "operations": {
                "playback": {
                  "method": "GET",
                  "path": "/play",
                  "query": {"id": "{id}"}
                }
              }
            }
            "#,
        )
        .expect("playback contract compiles");

        assert!(adapter.supports("playback"));
        assert!(adapter.supports("player"));
        let request = adapter
            .build_request("player", &json!({"id": "episode-1"}))
            .expect("player alias resolves to playback operation");
        assert_eq!(request.method, "GET");
        let url = reqwest::Url::parse(&request.url).expect("request URL parses");
        assert_eq!(url.path(), "/play");
        assert_eq!(
            url.query_pairs().next().map(|pair| pair.1),
            Some("episode-1".into())
        );
    }

    #[test]
    fn skips_missing_optional_fields_but_keeps_required_mappings_strict() {
        let adapter = compile_source_spec(
            "csp_Example",
            r#"
            {
              "qxAdapterVersion": 1,
              "baseUrl": "https://example.test/api",
              "operations": {
                "search": {
                  "path": "/search",
                  "response": {
                    "fields": {"total": "/total", "page": "/page?"},
                    "list": {
                      "path": "/items",
                      "item": {"vod_id": "/id", "vod_pic": "/cover?"}
                    }
                  }
                }
              }
            }
            "#,
        )
        .expect("contract compiles");
        let output = adapter
            .map_response("search", json!({"total": 1, "items": [{"id": "v1"}]}))
            .expect("optional fields may be absent");
        assert_eq!(output["total"], 1);
        assert!(output.get("page").is_none());
        assert_eq!(output["list"][0]["vod_id"], "v1");
        assert!(output["list"][0].get("vod_pic").is_none());

        let error = adapter
            .map_response("search", json!({"items": [{"id": "v1"}]}))
            .expect_err("required fields remain strict");
        assert!(matches!(
            error,
            SourceConverterError::Invalid(message) if message == "ADAPTER_RESPONSE_PATH_MISSING:/total"
        ));
    }
}
