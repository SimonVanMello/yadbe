//! What SQLite keeps only in the `CREATE` text of `sqlite_schema`: check constraints,
//! generation expressions, trigger timing and events, index key expressions. A tokenizer
//! that understands quotes and comments, and a few patterns over its tokens; anything it
//! does not recognize is left out rather than guessed.

use crate::db::meta::{TriggerEvent, TriggerTiming};

#[derive(Debug, Clone, PartialEq, Eq)]
enum Kind {
    /// Bare word (keyword or identifier).
    Word,
    /// `"x"`, `[x]` or `` `x` ``.
    Quoted,
    /// `'x'`
    Literal,
    Open,
    Close,
    Comma,
    Other,
}

#[derive(Debug, Clone)]
struct Token {
    kind: Kind,
    start: usize,
    end: usize,
}

fn tokenize(sql: &str) -> Vec<Token> {
    let bytes = sql.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        let start = i;
        let kind = match b {
            b if b.is_ascii_whitespace() => {
                i += 1;
                continue;
            }
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i < bytes.len() && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                i = (i + 2).min(bytes.len());
                continue;
            }
            b'\'' | b'"' | b'`' | b'[' => {
                let close = if b == b'[' { b']' } else { b };
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == close {
                        // A doubled quote is an escaped quote (not inside brackets).
                        if close != b']' && bytes.get(i + 1) == Some(&close) {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i = (i + 1).min(bytes.len());
                if b == b'\'' {
                    Kind::Literal
                } else {
                    Kind::Quoted
                }
            }
            b'(' => {
                i += 1;
                Kind::Open
            }
            b')' => {
                i += 1;
                Kind::Close
            }
            b',' => {
                i += 1;
                Kind::Comma
            }
            b if b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80 => {
                while i < bytes.len()
                    && (bytes[i].is_ascii_alphanumeric()
                        || bytes[i] == b'_'
                        || bytes[i] >= 0x80
                        || bytes[i] == b'$')
                {
                    i += 1;
                }
                Kind::Word
            }
            _ => {
                i += 1;
                Kind::Other
            }
        };
        tokens.push(Token {
            kind,
            start,
            end: i,
        });
    }
    tokens
}

struct Parsed<'a> {
    sql: &'a str,
    tokens: Vec<Token>,
}

impl<'a> Parsed<'a> {
    fn new(sql: &'a str) -> Self {
        Self {
            sql,
            tokens: tokenize(sql),
        }
    }

    fn text(&self, index: usize) -> &'a str {
        let t = &self.tokens[index];
        &self.sql[t.start..t.end]
    }

    fn is_word(&self, index: usize, word: &str) -> bool {
        self.tokens
            .get(index)
            .is_some_and(|t| t.kind == Kind::Word && self.text(index).eq_ignore_ascii_case(word))
    }

    /// The identifier at `index`, unquoted.
    fn ident(&self, index: usize) -> Option<String> {
        let token = self.tokens.get(index)?;
        let text = self.text(index);
        match token.kind {
            Kind::Word => Some(text.to_owned()),
            Kind::Quoted if text.len() >= 2 => {
                let inner = &text[1..text.len() - 1];
                Some(match text.as_bytes()[0] {
                    b'"' => inner.replace("\"\"", "\""),
                    b'`' => inner.replace("``", "`"),
                    _ => inner.to_owned(),
                })
            }
            _ => None,
        }
    }

    /// Index of the token closing the parenthesis opened at `open`.
    fn matching(&self, open: usize) -> Option<usize> {
        let mut depth = 0usize;
        for (index, token) in self.tokens.iter().enumerate().skip(open) {
            match token.kind {
                Kind::Open => depth += 1,
                Kind::Close => {
                    depth = depth.checked_sub(1)?;
                    if depth == 0 {
                        return Some(index);
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// Source text strictly between two tokens.
    fn between(&self, open: usize, close: usize) -> String {
        self.sql[self.tokens[open].end..self.tokens[close].start]
            .trim()
            .to_owned()
    }

    /// Items of the parenthesized list opened at `open`, as token ranges.
    fn items(&self, open: usize) -> Option<Vec<(usize, usize)>> {
        let close = self.matching(open)?;
        let mut items = Vec::new();
        let mut depth = 0usize;
        let mut start = open + 1;
        for index in open + 1..close {
            match self.tokens[index].kind {
                Kind::Open => depth += 1,
                Kind::Close => depth = depth.saturating_sub(1),
                Kind::Comma if depth == 0 => {
                    items.push((start, index));
                    start = index + 1;
                }
                _ => {}
            }
        }
        items.push((start, close));
        Some(items)
    }

    fn first_open(&self) -> Option<usize> {
        self.tokens.iter().position(|t| t.kind == Kind::Open)
    }
}

/// What the `CREATE TABLE` text adds to the pragmas.
#[derive(Debug, Default, PartialEq)]
pub struct TableDdl {
    /// `(constraint name, condition)`, table and column checks in order.
    pub checks: Vec<(Option<String>, String)>,
    /// `(column, expression)` of generated columns.
    pub generated: Vec<(String, String)>,
}

pub fn parse_table(sql: &str) -> TableDdl {
    let p = Parsed::new(sql);
    let mut ddl = TableDdl::default();
    let Some(items) = p.first_open().and_then(|open| p.items(open)) else {
        return ddl;
    };
    for (start, end) in items {
        let is_constraint = ["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"]
            .iter()
            .any(|w| p.is_word(start, w));
        let column = if is_constraint { None } else { p.ident(start) };
        let mut index = start;
        while index < end {
            if p.is_word(index, "CHECK")
                && p.tokens
                    .get(index + 1)
                    .is_some_and(|t| t.kind == Kind::Open)
            {
                if let Some(close) = p.matching(index + 1) {
                    let name = (index >= start + 2 && p.is_word(index - 2, "CONSTRAINT"))
                        .then(|| p.ident(index - 1))
                        .flatten();
                    ddl.checks.push((name, p.between(index + 1, close)));
                    index = close;
                }
            } else if p.is_word(index, "AS")
                && let Some(column) = &column
                && p.tokens
                    .get(index + 1)
                    .is_some_and(|t| t.kind == Kind::Open)
                && let Some(close) = p.matching(index + 1)
            {
                ddl.generated
                    .push((column.clone(), p.between(index + 1, close)));
                index = close;
            }
            index += 1;
        }
    }
    ddl
}

/// Timing and events of a `CREATE TRIGGER` (SQLite triggers are always row-level).
pub fn parse_trigger(sql: &str) -> Option<(TriggerTiming, Vec<TriggerEvent>)> {
    let p = Parsed::new(sql);
    let trigger = (0..p.tokens.len()).find(|&i| p.is_word(i, "TRIGGER"))?;
    let mut index = trigger + 1;
    if p.is_word(index, "IF") {
        index += 3;
    }
    // The name, possibly `schema.name`.
    index += 1;
    if p.tokens.get(index).is_some_and(|t| t.kind == Kind::Other) && p.text(index) == "." {
        index += 2;
    }
    let timing = if p.is_word(index, "BEFORE") {
        index += 1;
        TriggerTiming::Before
    } else if p.is_word(index, "AFTER") {
        index += 1;
        TriggerTiming::After
    } else if p.is_word(index, "INSTEAD") && p.is_word(index + 1, "OF") {
        index += 2;
        TriggerTiming::InsteadOf
    } else {
        TriggerTiming::Before
    };
    let event = if p.is_word(index, "INSERT") {
        TriggerEvent::Insert
    } else if p.is_word(index, "UPDATE") {
        TriggerEvent::Update
    } else if p.is_word(index, "DELETE") {
        TriggerEvent::Delete
    } else {
        return None;
    };
    Some((timing, vec![event]))
}

/// Key texts and `WHERE` condition of a `CREATE INDEX`.
pub fn parse_index(sql: &str) -> (Vec<String>, Option<String>) {
    let p = Parsed::new(sql);
    let Some(on) = (0..p.tokens.len()).find(|&i| p.is_word(i, "ON")) else {
        return (Vec::new(), None);
    };
    let Some(open) = (on..p.tokens.len()).find(|&i| p.tokens[i].kind == Kind::Open) else {
        return (Vec::new(), None);
    };
    let keys = p
        .items(open)
        .unwrap_or_default()
        .into_iter()
        .filter(|(start, end)| start < end)
        .map(|(start, end)| p.sql[p.tokens[start].start..p.tokens[end - 1].end].to_owned())
        .collect();
    let predicate = p.matching(open).and_then(|close| {
        let where_at = (close..p.tokens.len()).find(|&i| p.is_word(i, "WHERE"))?;
        let rest = p.sql[p.tokens[where_at].end..]
            .trim()
            .trim_end_matches(';')
            .trim();
        (!rest.is_empty()).then(|| rest.to_owned())
    });
    (keys, predicate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_checks_and_generated_columns() {
        let ddl = parse_table(
            "CREATE TABLE \"t\" (\n  id INTEGER PRIMARY KEY, -- the key (not a CHECK)\n  \
             qty INT CHECK (qty > 0),\n  note TEXT DEFAULT 'a, b (c)',\n  \
             total NUMERIC GENERATED ALWAYS AS (qty * (2)) STORED,\n  \
             half AS (qty / 2),\n  CONSTRAINT \"positive\" CHECK (qty >= 0 AND note <> ')')\n)",
        );
        assert_eq!(
            ddl.checks,
            vec![
                (None, "qty > 0".to_owned()),
                (
                    Some("positive".to_owned()),
                    "qty >= 0 AND note <> ')'".to_owned()
                )
            ]
        );
        assert_eq!(
            ddl.generated,
            vec![
                ("total".to_owned(), "qty * (2)".to_owned()),
                ("half".to_owned(), "qty / 2".to_owned())
            ]
        );
    }

    #[test]
    fn reads_trigger_timing_and_event() {
        assert_eq!(
            parse_trigger(
                "CREATE TRIGGER IF NOT EXISTS main.t AFTER UPDATE OF a ON x BEGIN SELECT 1; END"
            ),
            Some((TriggerTiming::After, vec![TriggerEvent::Update]))
        );
        assert_eq!(
            parse_trigger("create trigger \"t\" instead of delete on v begin select 1; end"),
            Some((TriggerTiming::InsteadOf, vec![TriggerEvent::Delete]))
        );
        assert_eq!(
            parse_trigger("CREATE TEMP TRIGGER t INSERT ON x BEGIN SELECT 1; END"),
            Some((TriggerTiming::Before, vec![TriggerEvent::Insert]))
        );
    }

    #[test]
    fn reads_index_keys_and_predicate() {
        assert_eq!(
            parse_index("CREATE INDEX i ON t (lower(email), created_at DESC) WHERE total > 0"),
            (
                vec!["lower(email)".to_owned(), "created_at DESC".to_owned()],
                Some("total > 0".to_owned())
            )
        );
        assert_eq!(
            parse_index("CREATE UNIQUE INDEX i ON \"t\"(a)"),
            (vec!["a".to_owned()], None)
        );
    }
}
