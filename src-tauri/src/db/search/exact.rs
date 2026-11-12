//! JSON that keeps every number exactly as written and the order of an object's keys: a
//! document's `_source` read for an edit and written back. [`Json`](crate::db::document::json)
//! holds numbers as `serde_json::Number`, which rounds a decimal with many digits or an
//! integer past 64 bits to a double; an edit must send back what it read, digit for digit.
//!
//! The tree is what yadbe serializes into a request body (rule 2): the user's text is parsed,
//! never spliced.

use std::fmt::Write as _;

use crate::db::errors::YadbeError;

/// Objects deeper than this are refused (the parser recurses).
const MAX_DEPTH: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExactJson {
    Null,
    Bool(bool),
    /// The number's text as written (`12.50`, `1e3`, `123456789012345678901234567890`).
    Number(String),
    String(String),
    Array(Vec<ExactJson>),
    Object(Vec<(String, ExactJson)>),
}

/// Where a text stops being JSON (1-based line and column) and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExactJsonError {
    pub line: u32,
    pub column: u32,
    pub message: String,
}

impl ExactJsonError {
    pub fn into_error(self) -> YadbeError {
        YadbeError::invalid_argument(
            format!(
                "The document is not valid JSON (line {}, column {}).",
                self.line, self.column
            ),
            format!(
                "Le document n'est pas du JSON valide (ligne {}, colonne {}).",
                self.line, self.column
            ),
        )
        .with_detail(self.message)
    }
}

struct Parser<'a> {
    text: &'a str,
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn fail(&self, message: impl Into<String>) -> ExactJsonError {
        let before = &self.text[..self.at.min(self.text.len())];
        let line = before.matches('\n').count() + 1;
        let column = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
        ExactJsonError {
            line: u32::try_from(line).unwrap_or(u32::MAX),
            column: u32::try_from(column).unwrap_or(u32::MAX),
            message: message.into(),
        }
    }

    fn skip_space(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.bytes.get(self.at) {
            self.at += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn expect(&mut self, byte: u8) -> Result<(), ExactJsonError> {
        if self.peek() == Some(byte) {
            self.at += 1;
            Ok(())
        } else {
            Err(self.fail(format!("expected '{}'", char::from(byte))))
        }
    }

    fn value(&mut self, depth: usize) -> Result<ExactJson, ExactJsonError> {
        if depth > MAX_DEPTH {
            return Err(self.fail("nested too deep"));
        }
        self.skip_space();
        match self.peek() {
            None => Err(self.fail("unexpected end of the text")),
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => self.string().map(ExactJson::String),
            Some(b'-' | b'0'..=b'9') => self.number().map(ExactJson::Number),
            Some(_) => {
                for (word, value) in [
                    ("true", ExactJson::Bool(true)),
                    ("false", ExactJson::Bool(false)),
                    ("null", ExactJson::Null),
                ] {
                    if self.text[self.at..].starts_with(word) {
                        self.at += word.len();
                        return Ok(value);
                    }
                }
                Err(self.fail("unexpected character"))
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<ExactJson, ExactJsonError> {
        self.expect(b'{')?;
        let mut entries = Vec::new();
        self.skip_space();
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Ok(ExactJson::Object(entries));
        }
        loop {
            self.skip_space();
            if self.peek() != Some(b'"') {
                return Err(self.fail("expected a key in double quotes"));
            }
            let key = self.string()?;
            self.skip_space();
            self.expect(b':')?;
            let value = self.value(depth + 1)?;
            entries.push((key, value));
            self.skip_space();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    return Ok(ExactJson::Object(entries));
                }
                _ => return Err(self.fail("expected ',' or '}'")),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<ExactJson, ExactJsonError> {
        self.expect(b'[')?;
        let mut items = Vec::new();
        self.skip_space();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Ok(ExactJson::Array(items));
        }
        loop {
            items.push(self.value(depth + 1)?);
            self.skip_space();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(ExactJson::Array(items));
                }
                _ => return Err(self.fail("expected ',' or ']'")),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, ExactJsonError> {
        let digits = self
            .text
            .get(self.at..self.at + 4)
            .ok_or_else(|| self.fail("a \\u escape needs four hex digits"))?;
        let value = u32::from_str_radix(digits, 16).map_err(|_| self.fail("invalid \\u escape"))?;
        self.at += 4;
        Ok(value)
    }

    fn string(&mut self) -> Result<String, ExactJsonError> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let start = self.at;
            while let Some(b) = self.peek() {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.at += 1;
            }
            out.push_str(&self.text[start..self.at]);
            match self.peek() {
                None => return Err(self.fail("unterminated string")),
                Some(b'"') => {
                    self.at += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.at += 1;
                    let escape = self
                        .peek()
                        .ok_or_else(|| self.fail("unterminated escape"))?;
                    self.at += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let first = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&first) {
                                if !self.text[self.at..].starts_with("\\u") {
                                    return Err(self.fail("lone surrogate in a \\u escape"));
                                }
                                self.at += 2;
                                let second = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&second) {
                                    return Err(self.fail("invalid surrogate pair"));
                                }
                                0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00)
                            } else {
                                first
                            };
                            out.push(
                                char::from_u32(code)
                                    .ok_or_else(|| self.fail("invalid \\u escape"))?,
                            );
                        }
                        _ => return Err(self.fail("invalid escape")),
                    }
                }
                Some(_) => return Err(self.fail("control character in a string")),
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while let Some(b'0'..=b'9') = self.peek() {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Result<String, ExactJsonError> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        match self.peek() {
            Some(b'0') => {
                self.at += 1;
                if let Some(b'0'..=b'9') = self.peek() {
                    return Err(self.fail("a number does not start with 0"));
                }
            }
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(self.fail("invalid number")),
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            if self.digits() == 0 {
                return Err(self.fail("digits expected after '.'"));
            }
        }
        if let Some(b'e' | b'E') = self.peek() {
            self.at += 1;
            if let Some(b'+' | b'-') = self.peek() {
                self.at += 1;
            }
            if self.digits() == 0 {
                return Err(self.fail("digits expected in the exponent"));
            }
        }
        Ok(self.text[start..self.at].to_owned())
    }
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

impl ExactJson {
    /// Parses one JSON value; anything but white space after it is an error.
    pub fn parse(text: &str) -> Result<ExactJson, ExactJsonError> {
        let mut parser = Parser {
            text,
            bytes: text.as_bytes(),
            at: 0,
        };
        let value = parser.value(0)?;
        parser.skip_space();
        if parser.at < text.len() {
            return Err(parser.fail("unexpected text after the JSON value"));
        }
        Ok(value)
    }

    pub fn get(&self, key: &str) -> Option<&ExactJson> {
        match self {
            ExactJson::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            ExactJson::String(s) => Some(s),
            _ => None,
        }
    }

    /// A number's text, or a string's (an id or a routing value).
    pub fn scalar_text(&self) -> Option<&str> {
        match self {
            ExactJson::Number(n) | ExactJson::String(n) => Some(n),
            _ => None,
        }
    }

    pub fn is_object(&self) -> bool {
        matches!(self, ExactJson::Object(_))
    }

    fn write(&self, out: &mut String, indent: Option<usize>, level: usize) {
        let newline = |out: &mut String, level: usize| {
            if let Some(width) = indent {
                out.push('\n');
                out.extend(std::iter::repeat_n(' ', width * level));
            }
        };
        match self {
            ExactJson::Null => out.push_str("null"),
            ExactJson::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            ExactJson::Number(n) => out.push_str(n),
            ExactJson::String(s) => write_string(out, s),
            ExactJson::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    newline(out, level + 1);
                    item.write(out, indent, level + 1);
                }
                if !items.is_empty() {
                    newline(out, level);
                }
                out.push(']');
            }
            ExactJson::Object(entries) => {
                out.push('{');
                for (i, (key, value)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    newline(out, level + 1);
                    write_string(out, key);
                    out.push(':');
                    if indent.is_some() {
                        out.push(' ');
                    }
                    value.write(out, indent, level + 1);
                }
                if !entries.is_empty() {
                    newline(out, level);
                }
                out.push('}');
            }
        }
    }

    /// Compact text: what a request body carries.
    pub fn to_text(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, None, 0);
        out
    }

    /// Indented by two spaces: what an editor or a preview shows.
    pub fn to_pretty(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, Some(2), 0);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_and_key_order_survive_a_round_trip() {
        let text = r#"{"z":123456789012345678901234567890,"a":0.10000000000000000555111512312578270211815834045,"e":-1.5E+300,"s":"é\"\\\n\u00e9\ud83d\ude00","n":null,"b":[true,false,{}],"o":{}}"#;
        let json = ExactJson::parse(text).expect("parses");
        assert_eq!(
            json.to_text(),
            "{\"z\":123456789012345678901234567890,\"a\":0.10000000000000000555111512312578270211815834045,\"e\":-1.5E+300,\"s\":\"é\\\"\\\\\\né😀\",\"n\":null,\"b\":[true,false,{}],\"o\":{}}"
        );
        assert_eq!(
            ExactJson::parse(&json.to_pretty()).expect("pretty parses"),
            json
        );
        assert_eq!(
            json.get("z").and_then(ExactJson::scalar_text),
            Some("123456789012345678901234567890")
        );
    }

    #[test]
    fn errors_say_where() {
        let err = ExactJson::parse("{\n  \"a\": 01\n}").expect_err("leading zero");
        assert_eq!((err.line, err.column), (2, 9));
        assert!(ExactJson::parse("{\"a\":1,}").is_err());
        assert!(ExactJson::parse("{\"a\":1} x").is_err());
        assert!(ExactJson::parse("[1.]").is_err());
        assert!(ExactJson::parse("\"\\ud800\"").is_err());
        assert!(ExactJson::parse("{'a':1}").is_err());
        assert!(ExactJson::parse(&"[".repeat(600)).is_err());
        let pretty = ExactJson::parse(r#"{"a":[1,{"b":2}]}"#)
            .expect("json")
            .to_pretty();
        assert_eq!(
            pretty,
            "{\n  \"a\": [\n    1,\n    {\n      \"b\": 2\n    }\n  ]\n}"
        );
    }
}
