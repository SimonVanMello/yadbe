//! The console syntax of Kibana's Dev Tools: a request line (`GET /orders/_search`), then its
//! body on the lines that follow, up to the next request line. `#` and `//` lines are
//! comments. A `_bulk` / `_msearch` body is NDJSON: its lines are sent one per line.
//!
//! The text of a request is sent as written (rule 3): only whole comment lines and the blank
//! lines around a body are left out. They cannot be part of JSON (a JSON string holds no raw
//! line break), so nothing the server would read is changed.

use super::request::{HttpMethod, RequestBody, SearchRequest};
use crate::db::errors::YadbeError;

/// One request of the console text, with where it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsoleRequest {
    pub request: SearchRequest,
    /// 0-based line of the request line.
    pub line: u32,
    /// 0-based last line of the request (its body's last line, or the request line).
    pub end_line: u32,
    /// The editor line of each line of the body sent, in order (error positions).
    pub body_lines: Vec<u32>,
}

/// Endpoints whose body is NDJSON.
fn is_ndjson(request: &SearchRequest) -> bool {
    let segments = request.segments();
    segments
        .iter()
        .any(|s| matches!(s.as_str(), "_bulk" | "_msearch"))
}

fn is_comment(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with('#') || trimmed.starts_with("//")
}

/// `GET /path` → the method and the path, when the line is a request line.
fn request_line(line: &str) -> Option<(HttpMethod, &str, &str)> {
    let trimmed = line.trim();
    let (word, rest) = trimmed.split_once(char::is_whitespace)?;
    let method = HttpMethod::parse(word)?;
    let rest = rest.trim_start();
    let (path, after) = rest
        .split_once(char::is_whitespace)
        .map_or((rest, ""), |(p, a)| (p, a.trim()));
    (!path.is_empty()).then_some((method, path, after))
}

fn not_a_request(line: u32) -> YadbeError {
    YadbeError::invalid_argument(
        format!(
            "Line {} is not a request: a request starts with a method and a path, like GET /my-index/_search.",
            line + 1
        ),
        format!(
            "La ligne {} n'est pas une requête : une requête commence par une méthode et un chemin, comme GET /mon-index/_search.",
            line + 1
        ),
    )
}

/// A console text that cannot be read, and the 0-based line at fault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsoleError {
    pub line: u32,
    pub error: YadbeError,
}

fn finish(method: HttpMethod, path: &str, line: u32, body: &[(u32, &str)]) -> ConsoleRequest {
    let mut request = SearchRequest::new(method, path);
    let ndjson = is_ndjson(&request);
    let mut kept: Vec<(u32, &str)> = body
        .iter()
        .copied()
        .filter(|(_, text)| !is_comment(text) && !(ndjson && text.trim().is_empty()))
        .collect();
    while kept.last().is_some_and(|(_, text)| text.trim().is_empty()) {
        kept.pop();
    }
    while kept.first().is_some_and(|(_, text)| text.trim().is_empty()) {
        kept.remove(0);
    }
    let end_line = body
        .iter()
        .rev()
        .find(|(_, text)| !text.trim().is_empty() && !is_comment(text))
        .map_or(line, |(n, _)| *n);
    if !kept.is_empty() {
        let mut text = kept.iter().map(|(_, t)| *t).collect::<Vec<_>>().join("\n");
        if ndjson {
            // The bulk APIs want a line break after the last line.
            text.push('\n');
        }
        request.body = Some(RequestBody { text, ndjson });
    }
    ConsoleRequest {
        request,
        line,
        end_line,
        body_lines: kept.iter().map(|(n, _)| *n).collect(),
    }
}

/// The requests of a console text, in order.
pub fn parse_console(text: &str) -> Result<Vec<ConsoleRequest>, ConsoleError> {
    let mut requests = Vec::new();
    let mut current: Option<(HttpMethod, String, u32)> = None;
    let mut body: Vec<(u32, &str)> = Vec::new();
    for (index, line) in text.split('\n').enumerate() {
        let number = u32::try_from(index).unwrap_or(u32::MAX);
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some((method, path, after)) = request_line(line) {
            if !after.is_empty() && !is_comment(after) {
                return Err(ConsoleError {
                    line: number,
                    error: YadbeError::invalid_argument(
                        format!(
                            "Line {}: a request line holds a method and a path only; the body goes on the next lines.",
                            number + 1
                        ),
                        format!(
                            "Ligne {} : une ligne de requête ne contient qu'une méthode et un chemin ; le corps va sur les lignes suivantes.",
                            number + 1
                        ),
                    ),
                });
            }
            if let Some((method, path, at)) = current.take() {
                requests.push(finish(method, &path, at, &body));
            }
            body.clear();
            current = Some((method, path.to_owned(), number));
            continue;
        }
        if current.is_some() {
            body.push((number, line));
        } else if !line.trim().is_empty() && !is_comment(line) {
            return Err(ConsoleError {
                line: number,
                error: not_a_request(number),
            });
        }
    }
    if let Some((method, path, at)) = current {
        requests.push(finish(method, &path, at, &body));
    }
    Ok(requests)
}

/// The requests a run takes: those with a line in `from..=to` (the cursor's line, or the
/// selected lines), or all of them.
pub fn pick(requests: Vec<ConsoleRequest>, lines: Option<(u32, u32)>) -> Vec<ConsoleRequest> {
    let Some((from, to)) = lines else {
        return requests;
    };
    let picked: Vec<ConsoleRequest> = requests
        .iter()
        .filter(|r| r.line <= to && r.end_line.max(r.line) >= from)
        .cloned()
        .collect();
    if !picked.is_empty() || from != to {
        return picked;
    }
    // The cursor on a blank line after a request (Kibana's habit): that request.
    requests
        .into_iter()
        .rfind(|r| r.line <= from)
        .into_iter()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEXT: &str = "# orders\nGET /orders/_search\n{\n  \"query\": { \"match_all\": {} }\n}\n\n// bulk\nPOST _bulk\n{\"index\":{\"_index\":\"a\"}}\n\n{\"n\":1}\n# end\nHEAD /a\n";

    #[test]
    fn requests_and_bodies_as_written() {
        let requests = parse_console(TEXT).expect("parses");
        assert_eq!(requests.len(), 3);
        let first = &requests[0];
        assert_eq!(first.request.line(), "GET /orders/_search");
        assert_eq!((first.line, first.end_line), (1, 4));
        let body = first.request.body.as_ref().expect("a body");
        assert_eq!(body.text, "{\n  \"query\": { \"match_all\": {} }\n}");
        assert!(!body.ndjson);
        assert_eq!(first.body_lines, [2, 3, 4]);
        let bulk = &requests[1];
        assert_eq!(bulk.request.path, "/_bulk");
        let body = bulk.request.body.as_ref().expect("a body");
        assert!(body.ndjson);
        assert_eq!(body.text, "{\"index\":{\"_index\":\"a\"}}\n{\"n\":1}\n");
        assert_eq!(bulk.body_lines, [8, 10]);
        assert_eq!(requests[2].request.method, HttpMethod::Head);
        assert_eq!(requests[2].request.body, None);
    }

    #[test]
    fn text_outside_a_request_is_an_error() {
        let error = parse_console("\n{ \"query\": {} }\nGET /").expect_err("no request");
        assert_eq!(error.line, 1);
        let error = parse_console("GET /a { }").expect_err("body on the line");
        assert_eq!(error.line, 0);
        assert!(
            parse_console("get a\n").is_ok(),
            "any case, no leading slash"
        );
    }

    #[test]
    fn a_run_picks_the_requests_under_the_cursor_or_selection() {
        let requests = parse_console(TEXT).expect("parses");
        let lines = |range| {
            pick(requests.clone(), range)
                .iter()
                .map(|r| r.line)
                .collect::<Vec<_>>()
        };
        assert_eq!(lines(Some((3, 3))), [1]);
        assert_eq!(lines(Some((5, 5))), [1], "blank line after a request");
        assert_eq!(lines(Some((2, 9))), [1, 7]);
        assert_eq!(lines(None), [1, 7, 12]);
        assert_eq!(lines(Some((0, 0))), Vec::<u32>::new());
    }
}
