//! Tokenizer-level statement splitting (F-041): which parts of an editor text are separate
//! statements, the statement under the cursor, and the mapping between byte offsets and the
//! editor's UTF-16 positions. No parsing: strings, quoted identifiers, comments and the
//! engine's block forms are recognized so their delimiters do not split.
//!
//! A statement spans its code only: whitespace and comments around it are left out (the
//! text sent is exactly the range, so error positions map back). Comment-only parts are
//! not statements.

use std::ops::Range;

/// How an engine separates statements in a script.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Separator {
    /// `;`.
    Semicolon,
    /// `;` by default, changed by a `DELIMITER xx` line (MySQL client command, not sent).
    MysqlDelimiter,
    /// A line holding only `GO` ends a batch; a batch is sent whole (SQL Server).
    GoBatches,
}

/// Bodies whose `;` belong to the statement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockRule {
    None,
    /// `CREATE [TEMP] TRIGGER … BEGIN … END` (SQLite).
    SqliteTrigger,
    /// `CREATE FUNCTION … BEGIN ATOMIC … END` (PostgreSQL 14+).
    BeginAtomic,
}

/// The lexical rules of an engine, as far as splitting and classification need them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SqlSyntax {
    /// `$tag$ … $tag$` strings (PostgreSQL).
    pub dollar_quotes: bool,
    /// `E'…'` strings take backslash escapes (PostgreSQL).
    pub e_strings: bool,
    /// Every `'…'` and `"…"` takes backslash escapes (MySQL).
    pub backslash_strings: bool,
    /// `/* /* */ */` nests (PostgreSQL, SQL Server).
    pub nested_comments: bool,
    /// `# …` comments (MySQL).
    pub hash_comments: bool,
    /// `--` starts a comment only when followed by a space or a control character (MySQL).
    pub dash_comment_needs_space: bool,
    /// `` `…` `` identifiers (MySQL, SQLite).
    pub backtick_idents: bool,
    /// `[…]` identifiers (SQL Server, SQLite).
    pub bracket_idents: bool,
    /// `/*! … */` and `/*+ … */` are code, not comments (MySQL).
    pub executable_comments: bool,
    pub separator: Separator,
    pub blocks: BlockRule,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    Whitespace,
    Comment,
    /// Identifier, keyword or number.
    Word,
    QuotedIdent,
    String,
    /// A comment the engine runs (`/*! … */`).
    CodeComment,
    /// Any other character.
    Punct,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub start: usize,
    pub end: usize,
}

impl Token {
    pub fn is_code(&self) -> bool {
        !matches!(self.kind, TokenKind::Whitespace | TokenKind::Comment)
    }
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80
}

fn is_ident(b: u8) -> bool {
    is_ident_start(b) || b == b'$'
}

/// End of a quoted span opened at `start` by `open`, closed by `close` (doubled to escape).
fn quoted_end(bytes: &[u8], start: usize, close: u8, backslash: bool) -> usize {
    let mut i = start + 1;
    while i < bytes.len() {
        let b = bytes[i];
        if backslash && b == b'\\' {
            i += 2;
            continue;
        }
        if b == close {
            if bytes.get(i + 1) == Some(&close) {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    bytes.len()
}

fn line_end(bytes: &[u8], from: usize) -> usize {
    bytes[from..]
        .iter()
        .position(|&b| b == b'\n')
        .map_or(bytes.len(), |p| from + p)
}

/// The tag of a dollar quote starting at `start` (`$$` or `$name$`), with both dollars.
fn dollar_tag(bytes: &[u8], start: usize) -> Option<usize> {
    let mut i = start + 1;
    if let Some(&b) = bytes.get(i)
        && b != b'$'
    {
        if !(b.is_ascii_alphabetic() || b == b'_' || b >= 0x80) {
            return None;
        }
        while i < bytes.len()
            && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] >= 0x80)
        {
            i += 1;
        }
    }
    (bytes.get(i) == Some(&b'$')).then_some(i + 1 - start)
}

/// The token starting at `pos` (never empty).
pub fn next_token(text: &str, pos: usize, syntax: &SqlSyntax) -> Token {
    let bytes = text.as_bytes();
    let b = bytes[pos];
    let next = bytes.get(pos + 1).copied();
    let token = |kind, end: usize| Token {
        kind,
        start: pos,
        end: end.min(bytes.len()),
    };
    if b.is_ascii_whitespace() {
        // A whitespace token ends after a line break, so line-level commands (`GO`,
        // `DELIMITER`) are seen at the start of their line.
        let mut end = pos;
        while end < bytes.len() && bytes[end].is_ascii_whitespace() {
            end += 1;
            if bytes[end - 1] == b'\n' {
                break;
            }
        }
        return token(TokenKind::Whitespace, end);
    }
    if b == b'-' && next == Some(b'-') {
        let spaced = bytes
            .get(pos + 2)
            .is_none_or(|c| c.is_ascii_whitespace() || c.is_ascii_control());
        if !syntax.dash_comment_needs_space || spaced {
            return token(TokenKind::Comment, line_end(bytes, pos));
        }
    }
    if b == b'#' && syntax.hash_comments {
        return token(TokenKind::Comment, line_end(bytes, pos));
    }
    if b == b'/' && next == Some(b'*') {
        let code = syntax.executable_comments && matches!(bytes.get(pos + 2), Some(b'!' | b'+'));
        let mut depth = 1;
        let mut i = pos + 2;
        while i < bytes.len() && depth > 0 {
            if bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/') {
                depth -= 1;
                i += 2;
            } else if syntax.nested_comments && bytes[i] == b'/' && bytes.get(i + 1) == Some(&b'*')
            {
                depth += 1;
                i += 2;
            } else {
                i += 1;
            }
        }
        let kind = if code {
            TokenKind::CodeComment
        } else {
            TokenKind::Comment
        };
        return token(kind, i);
    }
    match b {
        b'\'' => {
            let prefixed = pos >= 1
                && matches!(bytes[pos - 1], b'e' | b'E')
                && (pos < 2 || !is_ident(bytes[pos - 2]));
            let backslash = syntax.backslash_strings || (syntax.e_strings && prefixed);
            return token(TokenKind::String, quoted_end(bytes, pos, b'\'', backslash));
        }
        b'"' => {
            let kind = if syntax.backslash_strings {
                TokenKind::String
            } else {
                TokenKind::QuotedIdent
            };
            return token(kind, quoted_end(bytes, pos, b'"', syntax.backslash_strings));
        }
        b'`' if syntax.backtick_idents => {
            return token(TokenKind::QuotedIdent, quoted_end(bytes, pos, b'`', false));
        }
        b'[' if syntax.bracket_idents => {
            return token(TokenKind::QuotedIdent, quoted_end(bytes, pos, b']', false));
        }
        b'$' if syntax.dollar_quotes && (pos == 0 || !is_ident(bytes[pos - 1])) => {
            if let Some(len) = dollar_tag(bytes, pos) {
                let tag = &bytes[pos..pos + len];
                let body = pos + len;
                let end = bytes[body..]
                    .windows(len)
                    .position(|w| w == tag)
                    .map_or(bytes.len(), |p| body + p + len);
                return token(TokenKind::String, end);
            }
        }
        _ => {}
    }
    if is_ident_start(b) {
        let mut end = pos + 1;
        while end < bytes.len() && is_ident(bytes[end]) {
            end += 1;
        }
        return token(TokenKind::Word, end);
    }
    token(TokenKind::Punct, pos + 1)
}

/// Every token of `text`.
pub fn tokenize(text: &str, syntax: &SqlSyntax) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut pos = 0;
    while pos < text.len() {
        let token = next_token(text, pos, syntax);
        pos = token.end;
        tokens.push(token);
    }
    tokens
}

/// A statement of a script, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Statement {
    /// First byte of its first code token.
    pub start: usize,
    /// End of its last code token.
    pub end: usize,
    /// End of the delimiter (or `GO` line) that closed it; `end` without one.
    pub delimiter_end: usize,
    /// How many times it runs: `GO 3` repeats its batch (SQL Server tools); 1 otherwise.
    pub repeat: u32,
}

impl Statement {
    pub fn range(&self) -> Range<usize> {
        self.start..self.end
    }
}

/// Tracks `BEGIN … END` bodies inside one statement.
#[derive(Default)]
struct Blocks {
    words: usize,
    first: [Option<String>; 3],
    previous: Option<String>,
    depth: u32,
}

impl Blocks {
    fn word(&mut self, rule: BlockRule, word: &str) {
        let word = word.to_ascii_lowercase();
        if self.words < 3 {
            self.first[self.words] = Some(word.clone());
        }
        self.words += 1;
        let first = |i: usize| self.first[i].as_deref();
        let in_block = self.depth > 0;
        match rule {
            BlockRule::None => {}
            BlockRule::SqliteTrigger => {
                let trigger = first(0) == Some("create")
                    && (first(1) == Some("trigger")
                        || (matches!(first(1), Some("temp" | "temporary"))
                            && first(2) == Some("trigger")));
                if trigger {
                    match word.as_str() {
                        "begin" => self.depth += 1,
                        "case" if in_block => self.depth += 1,
                        "end" if in_block => self.depth -= 1,
                        _ => {}
                    }
                }
            }
            BlockRule::BeginAtomic => {
                if first(0) == Some("create") {
                    match word.as_str() {
                        "atomic" if self.previous.as_deref() == Some("begin") => self.depth += 1,
                        "case" if in_block => self.depth += 1,
                        "end" if in_block => self.depth -= 1,
                        _ => {}
                    }
                }
            }
        }
        self.previous = Some(word);
    }
}

/// `GO` alone on its line (optionally `GO 3` and a trailing `--` comment); returns the end
/// of the line and the repeat count (1 without one, `GO 0` included).
fn go_line(bytes: &[u8], start: usize) -> Option<(usize, u32)> {
    let end = line_end(bytes, start);
    let line = std::str::from_utf8(&bytes[start..end]).ok()?.trim();
    let rest = line
        .get(..2)
        .filter(|go| go.eq_ignore_ascii_case("go"))
        .map(|_| &line[2..])?;
    let rest = rest.split("--").next().unwrap_or_default().trim();
    if !rest.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let repeat = rest.parse::<u32>().unwrap_or(1).max(1);
    Some((end, repeat))
}

/// `DELIMITER xx` line: the new delimiter and the end of the line.
fn delimiter_line(bytes: &[u8], start: usize) -> Option<(String, usize)> {
    let end = line_end(bytes, start);
    let line = std::str::from_utf8(&bytes[start..end]).ok()?.trim();
    let keyword = line.get(..9)?;
    if !keyword.eq_ignore_ascii_case("delimiter") {
        return None;
    }
    let rest = &line[9..];
    if !rest.starts_with(|c: char| c.is_ascii_whitespace()) {
        return None;
    }
    let delimiter = rest.split_whitespace().next()?;
    Some((delimiter.to_owned(), end))
}

/// The statements of `text`, in order.
pub fn split(text: &str, syntax: &SqlSyntax) -> Vec<Statement> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut delimiter = ";".to_owned();
    let mut start: Option<usize> = None;
    let mut code_end = 0;
    let mut blocks = Blocks::default();
    let mut pos = 0;

    let mut close = |start: &mut Option<usize>,
                     code_end: usize,
                     delimiter_end: usize,
                     repeat: u32,
                     blocks: &mut Blocks| {
        if let Some(begin) = start.take() {
            out.push(Statement {
                start: begin,
                end: code_end,
                delimiter_end: delimiter_end.max(code_end),
                repeat,
            });
        }
        *blocks = Blocks::default();
    };

    while pos < bytes.len() {
        let line_start = pos == 0 || bytes[pos - 1] == b'\n';
        if line_start {
            match syntax.separator {
                Separator::GoBatches => {
                    if let Some((end, repeat)) = go_line(bytes, pos) {
                        close(&mut start, code_end, end, repeat, &mut blocks);
                        pos = end;
                        continue;
                    }
                }
                Separator::MysqlDelimiter if start.is_none() => {
                    if let Some((new, end)) = delimiter_line(bytes, pos) {
                        delimiter = new;
                        pos = end;
                        continue;
                    }
                }
                _ => {}
            }
        }
        if syntax.separator != Separator::GoBatches
            && blocks.depth == 0
            && text[pos..].starts_with(delimiter.as_str())
        {
            let end = pos + delimiter.len();
            close(&mut start, code_end, end, 1, &mut blocks);
            pos = end;
            continue;
        }
        let token = next_token(text, pos, syntax);
        if token.is_code() {
            start.get_or_insert(token.start);
            code_end = token.end;
            if token.kind == TokenKind::Word {
                blocks.word(syntax.blocks, &text[token.start..token.end]);
            }
        }
        pos = token.end;
    }
    close(&mut start, code_end, bytes.len(), 1, &mut blocks);
    out
}

/// The statement "under the cursor" at byte `offset`: the one containing it (its delimiter
/// included; the later one when two touch), else the closest one with no blank line in
/// between, preferring the one before.
pub fn statement_at(text: &str, statements: &[Statement], offset: usize) -> Option<Statement> {
    if let Some(found) = statements
        .iter()
        .rev()
        .find(|s| s.start <= offset && offset <= s.delimiter_end)
    {
        return Some(*found);
    }
    let newlines = |range: Range<usize>| {
        text.as_bytes().get(range).map_or(usize::MAX, |gap| {
            gap.iter().filter(|&&b| b == b'\n').count()
        })
    };
    let before = statements.iter().rev().find(|s| s.delimiter_end < offset);
    let after = statements.iter().find(|s| s.start > offset);
    if let Some(before) = before
        && newlines(before.delimiter_end..offset) <= 1
    {
        return Some(*before);
    }
    if let Some(after) = after
        && newlines(offset..after.start) <= 1
    {
        return Some(*after);
    }
    None
}

/// Converts between byte offsets of a text and its UTF-16 positions (what the editor counts).
pub struct Utf16Map<'a> {
    text: &'a str,
    /// UTF-16 position of every byte (`len + 1` entries), empty for ASCII text.
    positions: Vec<u32>,
}

impl<'a> Utf16Map<'a> {
    pub fn new(text: &'a str) -> Self {
        let positions = if text.is_ascii() {
            Vec::new()
        } else {
            let mut positions = Vec::with_capacity(text.len() + 1);
            let mut utf16 = 0_u32;
            for c in text.chars() {
                for _ in 0..c.len_utf8() {
                    positions.push(utf16);
                }
                utf16 += u32::try_from(c.len_utf16()).unwrap_or(2);
            }
            positions.push(utf16);
            positions
        };
        Self { text, positions }
    }

    fn clamp(&self, byte: usize) -> usize {
        let mut byte = byte.min(self.text.len());
        while !self.text.is_char_boundary(byte) {
            byte -= 1;
        }
        byte
    }

    pub fn to_utf16(&self, byte: usize) -> u32 {
        let byte = self.clamp(byte);
        if self.positions.is_empty() {
            u32::try_from(byte).unwrap_or(u32::MAX)
        } else {
            self.positions[byte]
        }
    }

    /// The byte offset of a UTF-16 position (inside a surrogate pair: the character's start).
    pub fn to_byte(&self, utf16: u32) -> usize {
        if self.positions.is_empty() {
            return usize::try_from(utf16)
                .unwrap_or(usize::MAX)
                .min(self.text.len());
        }
        let after = self.positions.partition_point(|&p| p <= utf16);
        self.clamp(after.saturating_sub(1))
    }

    /// 1-based line and UTF-16 column of a byte offset.
    pub fn line_column(&self, byte: usize) -> (u32, u32) {
        let byte = self.clamp(byte);
        let before = &self.text.as_bytes()[..byte];
        let line = before.iter().filter(|&&b| b == b'\n').count() + 1;
        let line_start = before
            .iter()
            .rposition(|&b| b == b'\n')
            .map_or(0, |p| p + 1);
        let column = self.to_utf16(byte) - self.to_utf16(line_start) + 1;
        (u32::try_from(line).unwrap_or(u32::MAX), column)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::dialect::Engine;

    fn texts(engine: Engine, text: &str) -> Vec<String> {
        split(text, &engine.dialect().syntax())
            .into_iter()
            .map(|s| text[s.range()].to_owned())
            .collect()
    }

    #[test]
    fn splits_on_semicolons_and_skips_empty_parts() {
        assert_eq!(
            texts(Engine::Postgres, "select 1;select 2 ;; \n  select 3\n"),
            ["select 1", "select 2", "select 3"]
        );
        assert!(texts(Engine::Postgres, "  ;\n -- only a comment\n/* x */").is_empty());
        assert!(texts(Engine::Postgres, "").is_empty());
    }

    #[test]
    fn leaves_surrounding_comments_out_and_keeps_inner_ones() {
        assert_eq!(
            texts(
                Engine::Postgres,
                "-- top\nselect /* a; */ 1 -- end;\n; /* after */"
            ),
            ["select /* a; */ 1"]
        );
    }

    #[test]
    fn postgres_strings_identifiers_and_dollar_quotes() {
        assert_eq!(
            texts(
                Engine::Postgres,
                "select 'it''s; fine', \"a;\"\"b\" from t; select E'\\'; still', 'x\\'; select 2"
            ),
            [
                "select 'it''s; fine', \"a;\"\"b\" from t",
                "select E'\\'; still', 'x\\'",
                "select 2"
            ]
        );
        let body = "create function f() returns int as $body$ begin return 1; end; $body$ language plpgsql";
        assert_eq!(
            texts(Engine::Postgres, &format!("{body};select 1")),
            [body, "select 1"]
        );
        assert_eq!(
            texts(
                Engine::Postgres,
                "do $$ begin raise notice 'a;'; end $$; select $1, a$b$c;"
            ),
            ["do $$ begin raise notice 'a;'; end $$", "select $1, a$b$c"]
        );
        assert_eq!(
            texts(Engine::Postgres, "select $a$ $b$; $a$; select 1"),
            ["select $a$ $b$; $a$", "select 1"]
        );
    }

    #[test]
    fn postgres_nested_comments_and_begin_atomic() {
        assert_eq!(
            texts(Engine::Postgres, "select /* a /* b; */ c; */ 1; select 2"),
            ["select /* a /* b; */ c; */ 1", "select 2"]
        );
        let atomic = "create function f(a int) returns int language sql begin atomic select case when a > 0 then 1 else 2 end; select 3; end";
        assert_eq!(
            texts(Engine::Postgres, &format!("{atomic};\nbegin;\ncommit;")),
            [atomic, "begin", "commit"]
        );
    }

    #[test]
    fn unterminated_strings_run_to_the_end() {
        assert_eq!(
            texts(Engine::Postgres, "select 'abc; select 1"),
            ["select 'abc; select 1"]
        );
        assert_eq!(texts(Engine::Postgres, "select 1 /* ; "), ["select 1"]);
    }

    #[test]
    fn sqlite_triggers_and_quotes() {
        let trigger = "CREATE TEMP TRIGGER t AFTER INSERT ON a WHEN new.x > 0 BEGIN UPDATE b SET y = CASE WHEN new.x > 1 THEN 1 ELSE 0 END; DELETE FROM c; END";
        assert_eq!(
            texts(
                Engine::Sqlite,
                &format!("{trigger}; select [a;b], `c;d` from t;")
            ),
            [trigger, "select [a;b], `c;d` from t"]
        );
        // `END` of a CASE outside the trigger body does not close anything.
        assert_eq!(
            texts(Engine::Sqlite, "select case when 1 then 2 end; select 3"),
            ["select case when 1 then 2 end", "select 3"]
        );
    }

    #[test]
    fn mssql_go_batches() {
        let text = "select 1; select 2\nGO\n  go 3 -- again\nprint 'GO'\ngo\nselect [a]]b] -- x\nGOTO label\n";
        assert_eq!(
            texts(Engine::Mssql, text),
            [
                "select 1; select 2",
                "print 'GO'",
                "select [a]]b] -- x\nGOTO label"
            ]
        );
        assert_eq!(texts(Engine::Mssql, "/* GO\n*/ select 1"), ["select 1"]);
        // `GO 3` repeats the batch it closes (an empty one: nothing).
        let repeats = |text: &str| -> Vec<u32> {
            split(text, &Engine::Mssql.dialect().syntax())
                .iter()
                .map(|s| s.repeat)
                .collect()
        };
        assert_eq!(repeats(text), [1, 1, 1]);
        assert_eq!(repeats("select 1\nGO 3\nselect 2\ngo 0"), [3, 1]);
    }

    #[test]
    fn mysql_delimiters_comments_and_escapes() {
        let text = "DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END//\nDELIMITER ;\nSELECT 'a\\';b' # c;\n; SELECT 1--2;\nSELECT \"x\\\";\" -- c;\n;/*!40101 SET NAMES utf8 */;";
        assert_eq!(
            texts(Engine::Mysql, text),
            [
                "CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END",
                "SELECT 'a\\';b'",
                "SELECT 1--2",
                "SELECT \"x\\\";\"",
                "/*!40101 SET NAMES utf8 */"
            ]
        );
    }

    #[test]
    fn statement_under_the_cursor() {
        let text = "select 1;\nselect 2;   \n\n\n\nselect 3;select 4";
        let syntax = Engine::Postgres.dialect().syntax();
        let statements = split(text, &syntax);
        let at = |offset: usize| statement_at(text, &statements, offset).map(|s| &text[s.range()]);
        assert_eq!(at(0), Some("select 1"));
        assert_eq!(at(9), Some("select 1"), "right after the delimiter");
        assert_eq!(at(10), Some("select 2"));
        assert_eq!(at(21), Some("select 2"), "same line, after spaces");
        assert_eq!(at(23), Some("select 2"), "the line below");
        assert_eq!(at(24), None, "between paragraphs");
        assert_eq!(at(25), Some("select 3"), "the line above");
        assert_eq!(at(34), Some("select 3"));
        assert_eq!(at(35), Some("select 4"), "touching: the later one");
        assert_eq!(at(text.len()), Some("select 4"));
        assert_eq!(statement_at("", &[], 0), None);
    }

    #[test]
    fn utf16_positions() {
        let text = "é😀\nab";
        let map = Utf16Map::new(text);
        // é: 2 bytes / 1 unit; 😀: 4 bytes / 2 units.
        assert_eq!(map.to_utf16(2), 1);
        assert_eq!(map.to_utf16(6), 3);
        assert_eq!(map.to_utf16(text.len()), 6);
        assert_eq!(map.to_byte(1), 2);
        assert_eq!(map.to_byte(2), 2, "inside the surrogate pair");
        assert_eq!(map.to_byte(3), 6);
        assert_eq!(map.to_byte(99), text.len());
        assert_eq!(map.line_column(8), (2, 2));
        assert_eq!(map.line_column(6), (1, 4));
        let ascii = Utf16Map::new("ab\ncd");
        assert_eq!(ascii.to_utf16(4), 4);
        assert_eq!(ascii.line_column(4), (2, 2));
    }
}
