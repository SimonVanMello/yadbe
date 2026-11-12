//! A streaming reader of JSON objects: the elements of a top-level array, or objects one
//! after the other (JSON Lines). Numbers keep their text (no precision loss); nested
//! objects and arrays are kept as JSON text.

use std::io::Read;

use super::parse::ParseError;
use super::text::TextReader;

/// Largest object read at once: past it the file is taken for malformed.
const MAX_OBJECT_CHARS: usize = 64 * 1024 * 1024;

/// A value of an object, as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JsonCell {
    Null,
    /// A string, escapes decoded; `true`, `false` and numbers as written.
    Text(String),
}

pub struct JsonObjects<R: Read> {
    text: TextReader<R>,
    line: u64,
    started: bool,
    in_array: bool,
    done: bool,
    require_array: bool,
}

impl<R: Read> JsonObjects<R> {
    /// `require_array`: the file must be an array of objects (otherwise a leading `[` is
    /// accepted but not needed).
    pub fn new(text: TextReader<R>, require_array: bool) -> Self {
        Self {
            text,
            line: 1,
            started: false,
            in_array: false,
            done: false,
            require_array,
        }
    }

    fn invalid(&self, problem: &str) -> ParseError {
        ParseError::Invalid {
            line: self.line,
            problem: problem.to_owned(),
        }
    }

    fn next_char(&mut self) -> Result<Option<char>, ParseError> {
        let c = self
            .text
            .next_char()
            .map_err(|e| ParseError::Io(e.to_string()))?;
        if c == Some('\n') {
            self.line += 1;
        }
        Ok(c)
    }

    fn peek(&mut self) -> Result<Option<char>, ParseError> {
        self.text.peek().map_err(|e| ParseError::Io(e.to_string()))
    }

    fn skip_whitespace(&mut self) -> Result<(), ParseError> {
        while let Some(c) = self.peek()? {
            if c.is_whitespace() {
                self.next_char()?;
            } else {
                break;
            }
        }
        Ok(())
    }

    /// The next object as `(line, entries)`, `None` at the end.
    #[allow(clippy::type_complexity)]
    pub fn next_object(&mut self) -> Result<Option<(u64, Vec<(String, JsonCell)>)>, ParseError> {
        if self.done {
            return Ok(None);
        }
        self.skip_whitespace()?;
        if !self.started {
            self.started = true;
            match self.peek()? {
                None => {
                    self.done = true;
                    return Ok(None);
                }
                Some('[') => {
                    self.next_char()?;
                    self.in_array = true;
                }
                Some(_) if self.require_array => {
                    return Err(self.invalid("the file is not a JSON array of objects"));
                }
                Some(_) => {}
            }
        }
        loop {
            self.skip_whitespace()?;
            match self.peek()? {
                None if self.in_array => return Err(self.invalid("the array is never closed")),
                None => {
                    self.done = true;
                    return Ok(None);
                }
                Some(']') if self.in_array => {
                    self.next_char()?;
                    self.done = true;
                    return Ok(None);
                }
                Some(',') => {
                    self.next_char()?;
                }
                Some('{') => {
                    let line = self.line;
                    self.next_char()?;
                    let entries = self.read_object_body()?;
                    return Ok(Some((line, entries)));
                }
                Some(_) => return Err(self.invalid("an element is not a JSON object")),
            }
        }
    }

    fn read_object_body(&mut self) -> Result<Vec<(String, JsonCell)>, ParseError> {
        let mut entries: Vec<(String, JsonCell)> = Vec::new();
        self.skip_whitespace()?;
        if self.peek()? == Some('}') {
            self.next_char()?;
            return Ok(entries);
        }
        loop {
            self.skip_whitespace()?;
            if self.next_char()? != Some('"') {
                return Err(self.invalid("a member name is expected"));
            }
            let key = self.read_string()?;
            self.read_entry(key, &mut entries)?;
            self.skip_whitespace()?;
            match self.next_char()? {
                Some(',') => {}
                Some('}') => return Ok(entries),
                _ => return Err(self.invalid("a comma or a closing brace is expected")),
            }
        }
    }

    /// Reads `: value` for `key`; a repeated key keeps its last value.
    fn read_entry(
        &mut self,
        key: String,
        entries: &mut Vec<(String, JsonCell)>,
    ) -> Result<(), ParseError> {
        self.skip_whitespace()?;
        if self.next_char()? != Some(':') {
            return Err(self.invalid("a colon is missing after a member name"));
        }
        self.skip_whitespace()?;
        let value = self.read_value()?;
        match entries.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => entries.push((key, value)),
        }
        Ok(())
    }

    fn read_value(&mut self) -> Result<JsonCell, ParseError> {
        match self.peek()? {
            Some('"') => {
                self.next_char()?;
                Ok(JsonCell::Text(self.read_string()?))
            }
            Some('{' | '[') => {
                let mut raw = String::new();
                self.copy_container(&mut raw)?;
                Ok(JsonCell::Text(raw))
            }
            Some(_) => {
                let mut word = String::new();
                while let Some(c) = self.peek()? {
                    if c.is_ascii_alphanumeric() || matches!(c, '-' | '+' | '.') {
                        word.push(c);
                        self.next_char()?;
                    } else {
                        break;
                    }
                }
                match word.as_str() {
                    "null" => Ok(JsonCell::Null),
                    "true" | "false" => Ok(JsonCell::Text(word)),
                    _ if is_json_number(&word) => Ok(JsonCell::Text(word)),
                    _ => Err(self.invalid("a value is not valid JSON")),
                }
            }
            None => Err(self.invalid("the file ends inside an object")),
        }
    }

    /// Copies a nested object or array, as written, into `out`.
    fn copy_container(&mut self, out: &mut String) -> Result<(), ParseError> {
        let mut depth = 0_usize;
        let mut in_string = false;
        let mut escaped = false;
        loop {
            let Some(c) = self.next_char()? else {
                return Err(self.invalid("the file ends inside a nested value"));
            };
            out.push(c);
            if out.len() > MAX_OBJECT_CHARS {
                return Err(self.invalid("a value is larger than 64 MiB"));
            }
            if in_string {
                if escaped {
                    escaped = false;
                } else if c == '\\' {
                    escaped = true;
                } else if c == '"' {
                    in_string = false;
                }
            } else {
                match c {
                    '"' => in_string = true,
                    '{' | '[' => depth += 1,
                    '}' | ']' => {
                        depth = depth.saturating_sub(1);
                        if depth == 0 {
                            return Ok(());
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    /// The rest of a string whose opening quote was read; escapes decoded.
    fn read_string(&mut self) -> Result<String, ParseError> {
        let mut out = String::new();
        loop {
            let Some(c) = self.next_char()? else {
                return Err(self.invalid("a string is never closed"));
            };
            match c {
                '"' => return Ok(out),
                '\\' => {
                    let Some(e) = self.next_char()? else {
                        return Err(self.invalid("a string is never closed"));
                    };
                    match e {
                        '"' | '\\' | '/' => out.push(e),
                        'b' => out.push('\u{8}'),
                        'f' => out.push('\u{c}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => {
                            let high = self.read_hex4()?;
                            if (0xd800..0xdc00).contains(&high) {
                                if self.next_char()? == Some('\\') && self.next_char()? == Some('u')
                                {
                                    let low = self.read_hex4()?;
                                    let combined = 0x10000
                                        + ((u32::from(high) - 0xd800) << 10)
                                        + (u32::from(low).wrapping_sub(0xdc00) & 0x3ff);
                                    out.push(char::from_u32(combined).unwrap_or('\u{fffd}'));
                                } else {
                                    return Err(self.invalid("a surrogate pair is incomplete"));
                                }
                            } else {
                                out.push(char::from_u32(u32::from(high)).unwrap_or('\u{fffd}'));
                            }
                        }
                        _ => return Err(self.invalid("a string has an unknown escape")),
                    }
                }
                other => {
                    out.push(other);
                    if out.len() > MAX_OBJECT_CHARS {
                        return Err(self.invalid("a string is larger than 64 MiB"));
                    }
                }
            }
        }
    }

    fn read_hex4(&mut self) -> Result<u16, ParseError> {
        let mut value = 0_u16;
        for _ in 0..4 {
            let digit = self
                .next_char()?
                .and_then(|c| c.to_digit(16))
                .ok_or_else(|| self.invalid("a \\u escape is not hexadecimal"))?;
            // Four hexadecimal digits fit 16 bits.
            value = (value << 4) | u16::try_from(digit).unwrap_or(0);
        }
        Ok(value)
    }
}

/// A JSON number: `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`.
pub fn is_json_number(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut i = 0;
    if bytes.get(i) == Some(&b'-') {
        i += 1;
    }
    match bytes.get(i) {
        Some(b'0') => i += 1,
        Some(b'1'..=b'9') => {
            while bytes.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
        }
        _ => return false,
    }
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == bytes.len()
}

/// Whether `text` is one complete JSON value (a `json` column's content).
pub fn is_valid_json(text: &str) -> bool {
    let mut scanner = Scanner {
        bytes: text.as_bytes(),
        pos: 0,
        depth: 0,
    };
    scanner.skip_ws();
    if !scanner.value() {
        return false;
    }
    scanner.skip_ws();
    scanner.pos == scanner.bytes.len()
}

struct Scanner<'a> {
    bytes: &'a [u8],
    pos: usize,
    depth: usize,
}

impl Scanner<'_> {
    fn skip_ws(&mut self) {
        while matches!(self.bytes.get(self.pos), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.bytes.get(self.pos) == Some(&byte) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn value(&mut self) -> bool {
        if self.depth > 256 {
            return false;
        }
        match self.bytes.get(self.pos) {
            Some(b'{') => self.container(b'}', true),
            Some(b'[') => self.container(b']', false),
            Some(b'"') => self.string(),
            Some(b't') => self.literal("true"),
            Some(b'f') => self.literal("false"),
            Some(b'n') => self.literal("null"),
            Some(b'-' | b'0'..=b'9') => {
                let start = self.pos;
                while self.bytes.get(self.pos).is_some_and(|b| {
                    b.is_ascii_digit() || matches!(b, b'-' | b'+' | b'.' | b'e' | b'E')
                }) {
                    self.pos += 1;
                }
                std::str::from_utf8(&self.bytes[start..self.pos]).is_ok_and(is_json_number)
            }
            _ => false,
        }
    }

    fn literal(&mut self, word: &str) -> bool {
        if self.bytes[self.pos..].starts_with(word.as_bytes()) {
            self.pos += word.len();
            true
        } else {
            false
        }
    }

    fn string(&mut self) -> bool {
        self.pos += 1;
        while let Some(&b) = self.bytes.get(self.pos) {
            self.pos += 1;
            match b {
                b'"' => return true,
                b'\\' => match self.bytes.get(self.pos) {
                    Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') => self.pos += 1,
                    Some(b'u') => {
                        let digits = self.bytes.get(self.pos + 1..self.pos + 5);
                        if !digits.is_some_and(|d| d.iter().all(u8::is_ascii_hexdigit)) {
                            return false;
                        }
                        self.pos += 5;
                    }
                    _ => return false,
                },
                0..=0x1f => return false,
                _ => {}
            }
        }
        false
    }

    fn container(&mut self, close: u8, object: bool) -> bool {
        self.pos += 1;
        self.depth += 1;
        self.skip_ws();
        if self.eat(close) {
            self.depth -= 1;
            return true;
        }
        loop {
            self.skip_ws();
            if object {
                if self.bytes.get(self.pos) != Some(&b'"') || !self.string() {
                    return false;
                }
                self.skip_ws();
                if !self.eat(b':') {
                    return false;
                }
                self.skip_ws();
            }
            if !self.value() {
                return false;
            }
            self.skip_ws();
            if self.eat(b',') {
                continue;
            }
            self.depth -= 1;
            return self.eat(close);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::model::ImportEncoding;
    use crate::import::text::TextCounters;

    fn objects(
        text: &str,
        require_array: bool,
    ) -> Result<Vec<Vec<(String, JsonCell)>>, ParseError> {
        let mut reader = JsonObjects::new(
            TextReader::new(
                text.as_bytes(),
                ImportEncoding::Utf8,
                TextCounters::default(),
            ),
            require_array,
        );
        let mut out = Vec::new();
        while let Some((_, entries)) = reader.next_object()? {
            out.push(entries);
        }
        Ok(out)
    }

    fn text(value: &str) -> JsonCell {
        JsonCell::Text(value.to_owned())
    }

    #[test]
    fn reads_an_array_of_objects_keeping_number_text() {
        let rows = objects(
            r#" [ {"id": 1, "price": 12.50, "big": 12345678901234567890, "ok": true, "gone": null},
                  {"id": 2, "name": "caf\u00e9 \ud83d\ude00 \"q\"\n"} ] "#,
            true,
        )
        .expect("parses");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0][0], ("id".to_owned(), text("1")));
        assert_eq!(rows[0][1], ("price".to_owned(), text("12.50")));
        assert_eq!(rows[0][2], ("big".to_owned(), text("12345678901234567890")));
        assert_eq!(rows[0][3], ("ok".to_owned(), text("true")));
        assert_eq!(rows[0][4], ("gone".to_owned(), JsonCell::Null));
        assert_eq!(rows[1][1], ("name".to_owned(), text("café 😀 \"q\"\n")));
    }

    #[test]
    fn reads_json_lines_and_keeps_nested_values_as_text() {
        let rows = objects(
            "{\"a\": 1, \"tags\": [\"x\", {\"y\": \"]\"}]}\n{\"a\": 2, \"o\": {}}\n\n",
            false,
        )
        .expect("parses");
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0][1],
            ("tags".to_owned(), text("[\"x\", {\"y\": \"]\"}]"))
        );
        assert_eq!(rows[1][1], ("o".to_owned(), text("{}")));
    }

    #[test]
    fn rejects_what_is_not_an_array_of_objects() {
        assert!(objects("{\"a\":1}", true).is_err());
        assert!(objects("[1, 2]", true).is_err());
        assert!(objects("[{\"a\":1}", true).is_err());
        assert!(objects("[{\"a\":1 \"b\":2}]", true).is_err());
        assert!(objects("[{\"a\":tru}]", true).is_err());
        assert_eq!(objects("[]", true).expect("empty"), Vec::<Vec<_>>::new());
        assert_eq!(objects("", true).expect("empty"), Vec::<Vec<_>>::new());
    }

    #[test]
    fn a_repeated_key_keeps_the_last_value_and_lines_are_tracked() {
        let mut reader = JsonObjects::new(
            TextReader::new(
                "{\"a\":1,\"a\":2}\n\n{\"b\":3}".as_bytes(),
                ImportEncoding::Utf8,
                TextCounters::default(),
            ),
            false,
        );
        let (line, entries) = reader.next_object().expect("parses").expect("object");
        assert_eq!((line, entries), (1, vec![("a".to_owned(), text("2"))]));
        let (line, _) = reader.next_object().expect("parses").expect("object");
        assert_eq!(line, 3);
        assert!(reader.next_object().expect("parses").is_none());
    }

    #[test]
    fn validates_json_text() {
        for good in [
            "{}",
            "[]",
            "1",
            "-1.5e+3",
            "\"x\"",
            "null",
            "{\"a\":[1,{\"b\":null}]}",
        ] {
            assert!(is_valid_json(good), "{good}");
        }
        for bad in [
            "",
            "{",
            "{'a':1}",
            "[1,]",
            "01",
            "1.",
            "tru",
            "{\"a\" 1}",
            "\"\\x\"",
            "[1] x",
        ] {
            assert!(!is_valid_json(bad), "{bad}");
        }
    }
}
