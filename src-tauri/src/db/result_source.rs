//! Whether a user statement is a plain `SELECT … FROM <one table>` (F-087), and the table it
//! names. A narrowing check only: where result columns come from is the engine's word
//! (`ColumnOrigin`); this check refuses what the engine's word cannot rule out, a table read
//! twice (a self-join reports every column as the same table's) or a view hiding a join.
//!
//! Conservative by design: tokens are matched, not parsed, and anything this cannot prove is
//! one table read once is refused: joins and comma joins, subqueries, functions and `VALUES`
//! in `FROM`, set operations, CTEs, `SELECT … INTO`, several statements in one batch,
//! table hints other than SQL Server's `WITH (…)`. Subqueries elsewhere (in the select list,
//! in `WHERE`) are fine: they do not add rows.

use crate::db::split::{SqlSyntax, TokenKind, tokenize};

/// The table named in `FROM`, as written: its name parts unquoted, the table last
/// (`["sales", "orders"]`; an empty part for SQL Server's `db..table`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectSource {
    pub parts: Vec<String>,
}

impl SelectSource {
    /// Whether the name designates `table` in `schema` of `database`, comparing the parts
    /// written (case-insensitively: the engine resolved the name, this only checks it is
    /// the same object).
    pub fn names(&self, database: Option<&str>, schema: Option<&str>, table: &str) -> bool {
        let mut written = self.parts.iter().rev();
        let Some(name) = written.next() else {
            return false;
        };
        if !name.eq_ignore_ascii_case(table) {
            return false;
        }
        let chain = [schema, database];
        let mut known = chain.iter().flatten();
        for part in written {
            let Some(expected) = known.next() else {
                return false;
            };
            if !part.is_empty() && !part.eq_ignore_ascii_case(expected) {
                return false;
            }
        }
        true
    }
}

/// Words that start what may follow the table: the statement's other clauses.
const TAIL_STARTS: &[&str] = &[
    "where", "group", "having", "order", "limit", "offset", "fetch", "for", "option", "window",
    "lock",
];

/// Words that are never a table alias (bare words after the table name).
const NOT_ALIASES: &[&str] = &[
    "where",
    "group",
    "having",
    "order",
    "limit",
    "offset",
    "fetch",
    "for",
    "option",
    "window",
    "lock",
    "join",
    "inner",
    "left",
    "right",
    "full",
    "cross",
    "natural",
    "outer",
    "straight_join",
    "on",
    "using",
    "union",
    "intersect",
    "except",
    "minus",
    "with",
    "as",
    "tablesample",
    "select",
    "from",
    "into",
    "returning",
];

/// Words that, at the top level after `FROM`, mean another row source or another statement.
const TAIL_REFUSED: &[&str] = &[
    "union",
    "intersect",
    "except",
    "minus",
    "join",
    "select",
    "into",
    "insert",
    "update",
    "delete",
    "merge",
];

struct Tok<'a> {
    kind: TokenKind,
    text: &'a str,
    /// Parenthesis depth before the token.
    depth: u32,
}

impl Tok<'_> {
    fn word(&self, word: &str) -> bool {
        self.kind == TokenKind::Word && self.text.eq_ignore_ascii_case(word)
    }

    fn punct(&self, c: &str) -> bool {
        self.kind == TokenKind::Punct && self.text == c
    }

    fn is_word_in(&self, words: &[&str]) -> bool {
        self.kind == TokenKind::Word && words.iter().any(|w| self.text.eq_ignore_ascii_case(w))
    }

    fn is_name(&self) -> bool {
        matches!(self.kind, TokenKind::Word | TokenKind::QuotedIdent)
    }
}

/// `"a""b"` → `a"b`, `[a]]b]` → `a]b`, `` `a``b` `` → ``a`b``; a word as written.
fn unquote(kind: TokenKind, text: &str) -> String {
    if kind != TokenKind::QuotedIdent || text.len() < 2 {
        return text.to_owned();
    }
    let close = match text.as_bytes()[0] {
        b'[' => "]",
        b'`' => "`",
        _ => "\"",
    };
    let inner = &text[1..text.len() - 1];
    inner.replace(&format!("{close}{close}"), close)
}

/// The code tokens of `sql` with their depth; `None` when the text holds code the engine runs
/// from a comment, or unbalanced parentheses.
fn code_tokens<'a>(sql: &'a str, syntax: &SqlSyntax) -> Option<Vec<Tok<'a>>> {
    let mut out = Vec::new();
    let mut depth: u32 = 0;
    for token in tokenize(sql, syntax) {
        match token.kind {
            TokenKind::Whitespace | TokenKind::Comment => continue,
            TokenKind::CodeComment => return None,
            _ => {}
        }
        let text = &sql[token.start..token.end];
        let before = depth;
        if token.kind == TokenKind::Punct {
            if text == "(" {
                depth += 1;
            } else if text == ")" {
                depth = depth.checked_sub(1)?;
            }
        }
        out.push(Tok {
            kind: token.kind,
            text,
            depth: if text == ")" { depth } else { before },
        });
    }
    (depth == 0).then_some(out)
}

/// The table a plain `SELECT … FROM <one table>` reads, `None` for any other statement.
pub fn single_table_select(sql: &str, syntax: &SqlSyntax) -> Option<SelectSource> {
    let mut tokens = code_tokens(sql, syntax)?;
    while tokens.last().is_some_and(|t| t.punct(";")) {
        tokens.pop();
    }
    if tokens.iter().any(|t| t.punct(";")) {
        return None;
    }
    if !tokens.first()?.word("select") {
        return None;
    }
    // The clause's FROM: the first one at the top level that is not `IS [NOT] DISTINCT FROM`.
    let from = tokens.iter().enumerate().position(|(i, t)| {
        t.depth == 0 && t.word("from") && !(i > 0 && tokens[i - 1].word("distinct"))
    })?;
    if tokens[..from]
        .iter()
        .any(|t| t.depth == 0 && t.is_word_in(&["into", "union", "intersect", "except"]))
    {
        return None;
    }
    let mut i = from + 1;
    if tokens.get(i).is_some_and(|t| t.word("only")) {
        i += 1;
    }
    // The name: parts separated by dots (`db..table` leaves an empty part).
    let mut parts = Vec::new();
    loop {
        let token = tokens.get(i)?;
        if !token.is_name() || token.is_word_in(NOT_ALIASES) {
            return None;
        }
        parts.push(unquote(token.kind, token.text));
        i += 1;
        if !tokens.get(i).is_some_and(|t| t.punct(".")) {
            break;
        }
        i += 1;
        if tokens.get(i).is_some_and(|t| t.punct(".")) {
            // `db..table`: the next loop turn reads the table after the empty part.
            parts.push(String::new());
            i += 1;
        }
    }
    if parts.len() > 4 || parts.last().is_none_or(String::is_empty) {
        return None;
    }
    // An optional alias, never followed by a column list.
    if tokens.get(i).is_some_and(|t| t.word("as")) {
        i += 1;
        if !tokens.get(i).is_some_and(Tok::is_name) {
            return None;
        }
        i += 1;
    } else if tokens
        .get(i)
        .is_some_and(|t| t.is_name() && !t.is_word_in(NOT_ALIASES))
    {
        i += 1;
    }
    // SQL Server table hints: `WITH (NOLOCK)`.
    if tokens.get(i).is_some_and(|t| t.word("with"))
        && tokens.get(i + 1).is_some_and(|t| t.punct("("))
    {
        i += 2;
        while tokens.get(i).is_some_and(|t| t.depth > 0) {
            i += 1;
        }
        if tokens.get(i).is_some_and(|t| t.punct(")")) {
            i += 1;
        }
    }
    let Some(next) = tokens.get(i) else {
        return Some(SelectSource { parts });
    };
    if !next.is_word_in(TAIL_STARTS) {
        return None;
    }
    let tail = &tokens[i..];
    for (n, token) in tail.iter().enumerate() {
        if token.depth != 0 {
            continue;
        }
        // `FOR UPDATE`, `FOR NO KEY UPDATE`: a row lock, not another statement.
        let locking = n > 0 && (tail[n - 1].word("for") || tail[n - 1].word("key"));
        if token.is_word_in(TAIL_REFUSED) && !locking {
            return None;
        }
        if token.word("from") && !(n > 0 && tail[n - 1].word("distinct")) {
            return None;
        }
    }
    Some(SelectSource { parts })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::dialect::Engine;

    fn table(sql: &str, engine: Engine) -> Option<Vec<String>> {
        single_table_select(sql, &engine.dialect().syntax()).map(|s| s.parts)
    }

    fn pg(sql: &str) -> Option<Vec<String>> {
        table(sql, Engine::Postgres)
    }

    fn parts(names: &[&str]) -> Option<Vec<String>> {
        Some(names.iter().map(|s| (*s).to_owned()).collect())
    }

    #[test]
    fn accepts_one_table_read_once() {
        assert_eq!(pg("SELECT * FROM t"), parts(&["t"]));
        assert_eq!(
            pg("select id, name from public.t;"),
            parts(&["public", "t"])
        );
        assert_eq!(
            pg(r#"SELECT a FROM "My ""Schema"""."Tab" AS x WHERE x.a > 1 ORDER BY 1 LIMIT 5"#),
            parts(&["My \"Schema\"", "Tab"])
        );
        assert_eq!(
            pg(
                "SELECT id, (SELECT max(v) FROM u WHERE u.id = t.id) AS m FROM t t1 WHERE id IN (SELECT id FROM u) FOR UPDATE"
            ),
            parts(&["t"])
        );
        assert_eq!(
            pg("SELECT a IS DISTINCT FROM b, id FROM ONLY t"),
            parts(&["t"])
        );
        assert_eq!(
            pg(
                "SELECT id FROM t WHERE a IS NOT DISTINCT FROM b GROUP BY id HAVING count(*) > 0 OFFSET 2 FETCH FIRST 3 ROWS ONLY"
            ),
            parts(&["t"])
        );
        assert_eq!(
            pg("SELECT extract(year FROM d), id FROM t -- the end\n;;"),
            parts(&["t"])
        );
        assert_eq!(
            table(
                "SELECT TOP 10 * FROM [db]..[Order]] Lines] o WITH (NOLOCK, INDEX(ix)) WHERE o.id = @id",
                Engine::Mssql
            ),
            parts(&["db", "", "Order] Lines"])
        );
        assert_eq!(
            table("SELECT * FROM `shop`.`t` LOCK IN SHARE MODE", Engine::Mysql),
            parts(&["shop", "t"])
        );
        assert_eq!(
            table("SELECT * FROM main.t", Engine::Sqlite),
            parts(&["main", "t"])
        );
    }

    #[test]
    fn refuses_anything_else() {
        for sql in [
            "SELECT 1",
            "SELECT * FROM a JOIN b ON a.id = b.id",
            "SELECT * FROM a x, a y",
            "SELECT * FROM a NATURAL JOIN b",
            "SELECT * FROM a LEFT OUTER JOIN b USING (id)",
            "SELECT * FROM a CROSS JOIN LATERAL f(a.id)",
            "SELECT * FROM (SELECT * FROM a) s",
            "SELECT * FROM f(1)",
            "SELECT * FROM t AS x (a, b)",
            "SELECT * FROM a UNION SELECT * FROM b",
            "SELECT * FROM a EXCEPT SELECT * FROM a",
            "WITH c AS (SELECT * FROM a) SELECT * FROM c",
            "(SELECT * FROM a)",
            "SELECT * INTO b FROM a",
            "SELECT * FROM a; SELECT * FROM b",
            "SELECT * FROM t TABLESAMPLE SYSTEM (10)",
            "VALUES (1)",
            "TABLE t",
            "UPDATE t SET a = 1",
            "SELECT * FROM",
            "SELECT * FROM t *",
            "SELECT * FROM t WHERE (a = 1",
        ] {
            assert_eq!(pg(sql), None, "{sql}");
        }
        // A batch of two statements without a separator (SQL Server).
        assert_eq!(
            table("SELECT * FROM a SELECT * FROM b", Engine::Mssql),
            None
        );
        assert_eq!(
            table("SELECT * FROM a OUTER APPLY f(a.id)", Engine::Mssql),
            None
        );
        assert_eq!(table("SELECT * FROM t USE INDEX (i)", Engine::Mysql), None);
        assert_eq!(
            table("SELECT /*! SQL_NO_CACHE */ * FROM t", Engine::Mysql),
            None
        );
        assert_eq!(table("SELECT * FROM t PARTITION (p0)", Engine::Mysql), None);
        assert_eq!(table("SELECT * FROM t INDEXED BY i", Engine::Sqlite), None);
    }

    #[test]
    fn checks_the_name_against_the_engine_origin() {
        let source = |names: &[&str]| SelectSource {
            parts: names.iter().map(|s| (*s).to_owned()).collect(),
        };
        assert!(source(&["T"]).names(Some("db"), Some("public"), "t"));
        assert!(source(&["public", "t"]).names(Some("db"), Some("public"), "t"));
        assert!(source(&["db", "public", "t"]).names(Some("db"), Some("public"), "t"));
        assert!(source(&["db", "", "t"]).names(Some("db"), Some("dbo"), "t"));
        assert!(source(&["shop", "t"]).names(Some("shop"), None, "t"));
        assert!(!source(&["v"]).names(Some("db"), Some("public"), "t"));
        assert!(!source(&["other", "t"]).names(Some("db"), Some("public"), "t"));
        assert!(!source(&["x", "db", "public", "t"]).names(Some("db"), Some("public"), "t"));
        assert!(!source(&["main", "t"]).names(None, None, "t"));
    }
}
