//! An HTTP request to a search server and its response, as the gate and the driver see them.
//! The user's requests are sent exactly as typed in the console (method, path with its query
//! string, body text); the ones yadbe authors carry their values in a JSON body built from a
//! [`Json`] tree, never spliced into text (rule 2).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::document::json::Json;
use crate::db::errors::YadbeError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Delete,
    Head,
    Patch,
}

impl HttpMethod {
    pub const ALL: [HttpMethod; 6] = [
        HttpMethod::Get,
        HttpMethod::Post,
        HttpMethod::Put,
        HttpMethod::Delete,
        HttpMethod::Head,
        HttpMethod::Patch,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            HttpMethod::Get => "GET",
            HttpMethod::Post => "POST",
            HttpMethod::Put => "PUT",
            HttpMethod::Delete => "DELETE",
            HttpMethod::Head => "HEAD",
            HttpMethod::Patch => "PATCH",
        }
    }

    /// `get`, `GET`… (the console accepts any case).
    pub fn parse(text: &str) -> Option<HttpMethod> {
        HttpMethod::ALL
            .into_iter()
            .find(|method| method.as_str().eq_ignore_ascii_case(text))
    }
}

/// The body of a request: JSON, or NDJSON (`_bulk`, `_msearch`: one JSON value per line).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestBody {
    pub text: String,
    pub ndjson: bool,
}

impl RequestBody {
    pub fn content_type(&self) -> &'static str {
        if self.ndjson {
            "application/x-ndjson"
        } else {
            "application/json"
        }
    }
}

/// One request: a method, a path (with its query string) relative to the server's base URL,
/// and an optional body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchRequest {
    pub method: HttpMethod,
    /// Starts with `/`; holds the query string as written (`/orders/_search?size=5`).
    pub path: String,
    pub body: Option<RequestBody>,
}

/// Percent-encodes one path segment (an index name, an id) for a path yadbe builds.
pub fn segment(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'*' | b',' | b'~' | b'+' | b':');
        if keep {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Percent-encodes a document id, a routing value or a concrete index name: everything but
/// letters, digits and `-_.~` (a `+`, `,` or `*` in an id is not an operator), in a path
/// segment as in a query-string value.
pub fn strict(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = text.get(i + 1..i + 3)
            && let Ok(value) = u8::from_str_radix(hex, 16)
        {
            out.push(value);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl SearchRequest {
    /// A request without body; a path without a leading `/` gets one.
    pub fn new(method: HttpMethod, path: impl Into<String>) -> Self {
        let path = path.into();
        let path = if path.starts_with('/') {
            path
        } else {
            format!("/{path}")
        };
        Self {
            method,
            path,
            body: None,
        }
    }

    /// A request yadbe authors with a JSON body.
    pub fn json(method: HttpMethod, path: impl Into<String>, body: &Json) -> Self {
        Self {
            body: Some(RequestBody {
                text: body.to_text(),
                ndjson: false,
            }),
            ..Self::new(method, path)
        }
    }

    /// The path without its query string.
    pub fn path_only(&self) -> &str {
        self.path
            .split_once('?')
            .map_or(&self.path, |(path, _)| path)
    }

    /// The path's segments, percent-decoded (`/logs-*/_search` → `logs-*`, `_search`).
    pub fn segments(&self) -> Vec<String> {
        self.path_only()
            .split('/')
            .filter(|s| !s.is_empty())
            .map(percent_decode)
            .collect()
    }

    /// The value of a query-string parameter, decoded.
    pub fn query_param(&self, name: &str) -> Option<String> {
        let (_, query) = self.path.split_once('?')?;
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(key) == name).then(|| percent_decode(value))
        })
    }

    /// The request line, as the console writes it: `GET /orders/_search`.
    pub fn line(&self) -> String {
        format!("{} {}", self.method.as_str(), self.path)
    }

    /// The whole request as the console writes it (history, statement log).
    pub fn display(&self) -> String {
        match &self.body {
            Some(body) if !body.text.trim().is_empty() => {
                format!("{}\n{}", self.line(), body.text.trim_end())
            }
            _ => self.line(),
        }
    }

    /// [`Self::display`] cut to about `max` characters.
    pub fn display_short(&self, max: usize) -> String {
        let text = self.display();
        if text.chars().count() <= max {
            return text;
        }
        let mut cut: String = text.chars().take(max.saturating_sub(1)).collect();
        cut.push('…');
        cut
    }

    /// The body parsed as JSON (a JSON body only), for the checks of the gate.
    pub fn body_json(&self) -> Option<Json> {
        let body = self.body.as_ref()?;
        if body.ndjson || body.text.trim().is_empty() {
            return None;
        }
        Json::parse(&body.text).ok()
    }
}

/// What the server answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchResponse {
    pub status: u16,
    /// `application/json`, `text/plain`…, without parameters.
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

/// The `error` of an error response: its type, reason and where in the body it points.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ServerError {
    pub kind: String,
    pub reason: String,
    /// 1-based line and column in the request body (`[3:15]`, `line: 3, column: 15`).
    pub position: Option<(u32, u32)>,
}

/// `[3:15]` or `line: 3, column: 15` in a parse error's reason.
fn position_in(reason: &str) -> Option<(u32, u32)> {
    if let Some(start) = reason.find('[') {
        let rest = &reason[start + 1..];
        if let Some(end) = rest.find(']')
            && let Some((line, column)) = rest[..end].split_once(':')
            && let (Ok(line), Ok(column)) = (line.trim().parse(), column.trim().parse())
        {
            return Some((line, column));
        }
    }
    let lower = reason.to_ascii_lowercase();
    let number_after = |key: &str| -> Option<u32> {
        let at = lower.find(key)? + key.len();
        let digits: String = lower[at..]
            .trim_start()
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        digits.parse().ok()
    };
    Some((number_after("line:")?, number_after("column:")?))
}

impl SearchResponse {
    pub fn is_json(&self) -> bool {
        self.content_type
            .as_deref()
            .is_some_and(|t| t.ends_with("json"))
            || (self.content_type.is_none() && self.body.first() == Some(&b'{'))
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// The body as JSON, when it is JSON.
    pub fn json(&self) -> Option<Json> {
        if !self.is_json() {
            return None;
        }
        std::str::from_utf8(&self.body)
            .ok()
            .and_then(|text| Json::parse(text).ok())
    }

    /// What the server said went wrong, for a status of 400 and more.
    pub fn server_error(&self) -> Option<ServerError> {
        if self.is_success() {
            return None;
        }
        let json = self.json();
        let error = json.as_ref().and_then(|j| j.get("error"));
        let (kind, reason) = match error {
            Some(Json::String(text)) => (String::new(), text.clone()),
            Some(error) => {
                // The root cause is usually the precise one (a parse error deep in a query).
                let root = error
                    .get("root_cause")
                    .and_then(Json::as_array)
                    .and_then(|causes| causes.first());
                let pick = |key: &str| {
                    root.and_then(|r| r.get(key))
                        .or_else(|| error.get(key))
                        .and_then(Json::as_str)
                        .unwrap_or_default()
                        .to_owned()
                };
                (pick("type"), pick("reason"))
            }
            None => (
                String::new(),
                json.as_ref()
                    .and_then(|j| j.get("message"))
                    .and_then(Json::as_str)
                    .map_or_else(|| self.text().chars().take(500).collect(), str::to_owned),
            ),
        };
        // `parsing_exception` says where in `line` / `col` fields, of its root cause or itself.
        let field = |key: &str| -> Option<u32> {
            let root = error
                .and_then(|e| e.get("root_cause"))
                .and_then(Json::as_array)
                .and_then(|causes| causes.first());
            root.and_then(|r| r.get(key))
                .or_else(|| error.and_then(|e| e.get(key)))
                .and_then(|n| n.to_text().parse().ok())
        };
        let position = field("line")
            .zip(field("col"))
            .or_else(|| position_in(&reason));
        Some(ServerError {
            kind,
            reason,
            position,
        })
    }

    /// The response as a typed error when it is one (requests yadbe authors).
    pub fn into_result(self) -> Result<SearchResponse, YadbeError> {
        match self.server_error() {
            None => Ok(self),
            Some(error) => Err(error.into_error(self.status)),
        }
    }
}

impl ServerError {
    pub fn into_error(self, status: u16) -> YadbeError {
        crate::db::errors::from_search_error(status, &self.kind, &self.reason, "", true)
            .unwrap_or_else(|| {
                let text = if self.kind.is_empty() {
                    format!("HTTP {status}: {}", self.reason)
                } else {
                    format!("HTTP {status} {}: {}", self.kind, self.reason)
                };
                YadbeError::query_failed(text)
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_split_into_decoded_segments() {
        let req = SearchRequest::new(HttpMethod::Get, "logs%2A/_search?q=a%20b&size=1");
        assert_eq!(req.path, "/logs%2A/_search?q=a%20b&size=1");
        assert_eq!(req.segments(), ["logs*", "_search"]);
        assert_eq!(req.query_param("q").as_deref(), Some("a b"));
        assert_eq!(req.query_param("size").as_deref(), Some("1"));
        assert_eq!(req.query_param("from"), None);
        assert_eq!(segment("a b/c"), "a%20b%2Fc");
        assert_eq!(segment("logs-*,x"), "logs-*,x");
    }

    #[test]
    fn errors_name_their_position() {
        let response = SearchResponse {
            status: 400,
            content_type: Some("application/json".into()),
            body: br#"{"error":{"root_cause":[{"type":"parsing_exception","reason":"[3:5] unknown query [mtch]"}],"type":"x","reason":"y"},"status":400}"#.to_vec(),
        };
        let error = response.server_error().expect("an error");
        assert_eq!(error.kind, "parsing_exception");
        assert_eq!(error.position, Some((3, 5)));
        let json = SearchResponse {
            status: 400,
            content_type: Some("application/json".into()),
            body: br#"{"error":{"type":"x_content_parse_exception","reason":"Unexpected character ('}' (code 125)): at [Source: REDACTED; line: 2, column: 9]"}}"#.to_vec(),
        };
        assert_eq!(json.server_error().expect("error").position, Some((2, 9)));
        let missing = SearchResponse {
            status: 404,
            content_type: Some("application/json".into()),
            body: br#"{"error":{"type":"index_not_found_exception","reason":"no such index [x]"},"status":404}"#.to_vec(),
        };
        assert_eq!(
            missing.into_result().map_err(|e| e.code),
            Err(crate::db::errors::ErrorCode::ObjectNotFound)
        );
    }
}
