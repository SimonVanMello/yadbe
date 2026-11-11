//! Query parameters of user statements (F-048): which placeholders a statement holds, and
//! the statement as it is sent with its values bound.
//!
//! Placeholders are found on the splitter's tokens, so nothing inside a string, a quoted
//! name, a comment or a dollar-quoted body counts, nor `::` casts, `:=` assignments, `@@`
//! globals or array slices (`a[1:n]`). Routine definitions (`CREATE PROCEDURE`, `CREATE
//! FUNCTION`, triggers, events) hold none: their `@x` / `:x` belong to their body.
//!
//! What reaches the server depends on the engine's protocol ([`ParamBinding`]):
//! - SQLite and SQL Server bind names themselves: the text is sent exactly as written.
//!   SQL Server reads an `@name` as a parameter only when the batch does not declare it
//!   (`DECLARE @name`), and never in an `EXEC` argument name (`EXEC p @id = 1`).
//! - PostgreSQL numbers its parameters (`$1`): a `:name` is replaced by the next free
//!   number, everything else stays byte for byte.
//! - MySQL only knows `?`: a `:name` is replaced by `?`.
//!
//! A rewritten statement is what the history records, so what ran can be read back.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::errors::YadbeError;
use crate::db::split::{SqlSyntax, Statement, Token, TokenKind, tokenize};
use crate::db::value::Value;
use crate::session::query_model::ParameterKind;

/// How a placeholder is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ParameterStyle {
    /// `:name`.
    Colon,
    /// `@name`.
    At,
    /// `$name` (SQLite).
    DollarName,
    /// `$1` (PostgreSQL), `?1` (SQLite).
    Numbered,
    /// `?`: each one is its own parameter, numbered in order of appearance.
    Positional,
}

/// The placeholders an engine reads as query parameters (F-048).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ParameterStyles {
    /// `:name`.
    pub colon: bool,
    /// `@name`.
    pub at: bool,
    /// `@name` is also how variables are written (T-SQL): only the names the batch does not
    /// declare are parameters.
    pub at_declared_are_variables: bool,
    /// `$name`.
    pub dollar_name: bool,
    /// `$1`.
    pub dollar_number: bool,
    /// `?`.
    pub question: bool,
    /// `?1`.
    pub question_number: bool,
}

impl ParameterStyles {
    pub fn any(&self) -> bool {
        self.colon
            || self.at
            || self.dollar_name
            || self.dollar_number
            || self.question
            || self.question_number
    }
}

/// How bound values reach the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParamBinding {
    /// The engine numbers its parameters (`$1`): named placeholders become the next free
    /// number in the text sent (PostgreSQL).
    DollarNumbers,
    /// The engine only knows `?`, bound in order: named placeholders become `?` (MySQL).
    QuestionMarks,
    /// The engine binds the placeholders by the name they are written with: the text is
    /// sent as written (SQLite, SQL Server).
    AsWritten,
}

/// One placeholder in a statement, in bytes of the statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placeholder {
    pub start: usize,
    pub end: usize,
    pub style: ParameterStyle,
    /// What identifies the parameter: the name without its sigil (`id`), the number of a
    /// numbered one (`2`), empty for a positional one (numbered later, in run order).
    pub name: String,
}

impl Placeholder {
    /// The placeholder as written.
    pub fn written<'a>(&self, sql: &'a str) -> &'a str {
        &sql[self.start..self.end]
    }
}

fn is_name_start(text: &str) -> bool {
    text.chars()
        .next()
        .is_some_and(|c| c.is_alphabetic() || c == '_')
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// Words after `CREATE` / `ALTER` that make the statement a routine definition.
const ROUTINE_WORDS: &[&str] = &[
    "procedure",
    "proc",
    "function",
    "trigger",
    "event",
    "package",
];

/// `CREATE [OR REPLACE | OR ALTER] [DEFINER = …] PROCEDURE …` and the like.
fn is_routine_definition(sql: &str, code: &[Token]) -> bool {
    let words: Vec<String> = code
        .iter()
        .take(12)
        .filter(|t| t.kind == TokenKind::Word)
        .map(|t| sql[t.start..t.end].to_ascii_lowercase())
        .collect();
    let Some(first) = words.first() else {
        return false;
    };
    if first != "create" && first != "alter" {
        return false;
    }
    words
        .iter()
        .skip(1)
        .take(8)
        .any(|w| ROUTINE_WORDS.contains(&w.as_str()))
}

/// Statement keywords that end a T-SQL `DECLARE` list or `EXEC` argument list.
const TSQL_STATEMENT_WORDS: &[&str] = &[
    "select",
    "insert",
    "update",
    "delete",
    "merge",
    "set",
    "if",
    "else",
    "while",
    "begin",
    "end",
    "exec",
    "execute",
    "print",
    "return",
    "declare",
    "with",
    "truncate",
    "create",
    "alter",
    "drop",
    "open",
    "fetch",
    "close",
    "deallocate",
    "raiserror",
    "throw",
    "goto",
    "waitfor",
    "use",
    "break",
    "continue",
];

/// T-SQL: the `@name`s the batch declares, and the placeholders that name an `EXEC`
/// argument (`EXEC p @id = 1`), which are not parameters either.
fn tsql_declared(sql: &str, code: &[Token]) -> (HashSet<String>, HashSet<usize>) {
    let mut declared = HashSet::new();
    let mut argument_names = HashSet::new();
    let text = |t: &Token| &sql[t.start..t.end];
    let punct = |i: usize, c: &str| {
        code.get(i)
            .is_some_and(|t| t.kind == TokenKind::Punct && text(t) == c)
    };
    let mut depth: i32 = 0;
    // `DECLARE` list: its depth, and whether the next `@name` is a new variable.
    let mut declare: Option<i32> = None;
    let mut expect_name = false;
    let mut exec: Option<i32> = None;
    let mut i = 0;
    while i < code.len() {
        let token = code[i];
        let value = text(&token);
        match token.kind {
            TokenKind::Punct if value == "(" => depth += 1,
            TokenKind::Punct if value == ")" => depth -= 1,
            TokenKind::Punct if value == ";" => {
                declare = None;
                exec = None;
            }
            TokenKind::Punct if value == "," && declare == Some(depth) => expect_name = true,
            TokenKind::Punct if value == "@" => {
                let after = code.get(i + 1);
                let adjacent = after.is_some_and(|n| n.start == token.end);
                let before_at = i > 0 && punct(i - 1, "@") && code[i - 1].end == token.start;
                if let Some(name) = after.filter(|n| adjacent && n.kind == TokenKind::Word)
                    && !before_at
                {
                    let lower = text(name).to_lowercase();
                    if declare.is_some() && expect_name {
                        declared.insert(lower);
                        expect_name = false;
                    } else if exec == Some(depth) && punct(i + 2, "=") && !punct(i + 3, "=") {
                        argument_names.insert(token.start);
                    }
                    i += 2;
                    continue;
                }
            }
            TokenKind::Word => {
                let lower = value.to_ascii_lowercase();
                if lower == "declare" {
                    declare = Some(depth);
                    expect_name = true;
                    exec = None;
                } else if lower == "exec" || lower == "execute" {
                    exec = Some(depth);
                    declare = None;
                } else if TSQL_STATEMENT_WORDS.contains(&lower.as_str()) {
                    if declare == Some(depth) {
                        declare = None;
                    }
                    if exec == Some(depth) {
                        exec = None;
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    (declared, argument_names)
}

/// The placeholders of one statement, in order.
pub fn scan(sql: &str, syntax: &SqlSyntax, styles: ParameterStyles) -> Vec<Placeholder> {
    if !styles.any() {
        return Vec::new();
    }
    let code: Vec<Token> = tokenize(sql, syntax)
        .into_iter()
        .filter(|t| t.is_code())
        .collect();
    if is_routine_definition(sql, &code) {
        return Vec::new();
    }
    let text = |t: &Token| &sql[t.start..t.end];
    let mut out = Vec::new();
    // Square brackets (array subscripts and slices); quoted names when the engine uses them.
    let mut brackets = 0_i32;
    let mut i = 0;
    while i < code.len() {
        let token = code[i];
        if token.kind != TokenKind::Punct {
            i += 1;
            continue;
        }
        let sigil = text(&token);
        let previous = i.checked_sub(1).map(|p| &code[p]);
        let next = code.get(i + 1).filter(|n| n.start == token.end);
        // `::`, `@@`, `$$`…: a doubled sigil is never a placeholder.
        let doubled = previous.is_some_and(|p| p.end == token.start && text(p) == sigil)
            || next.is_some_and(|n| n.kind == TokenKind::Punct && text(n) == sigil);
        match sigil {
            "[" => brackets += 1,
            "]" => brackets -= 1,
            _ => {}
        }
        let word = next.filter(|n| n.kind == TokenKind::Word).map(text);
        let found = match (sigil, word) {
            (":", Some(name))
                if styles.colon && !doubled && brackets <= 0 && is_name_start(name) =>
            {
                Some((ParameterStyle::Colon, name.to_owned()))
            }
            ("@", Some(name)) if styles.at && !doubled && is_name_start(name) => {
                Some((ParameterStyle::At, name.to_owned()))
            }
            ("$", Some(name)) if styles.dollar_number && !doubled && is_digits(name) => {
                Some((ParameterStyle::Numbered, trim_number(name)))
            }
            ("$", Some(name)) if styles.dollar_name && !doubled && is_name_start(name) => {
                Some((ParameterStyle::DollarName, name.to_owned()))
            }
            ("?", Some(name)) if styles.question_number && is_digits(name) => {
                Some((ParameterStyle::Numbered, trim_number(name)))
            }
            ("?", _) if styles.question => {
                out.push(Placeholder {
                    start: token.start,
                    end: token.end,
                    style: ParameterStyle::Positional,
                    name: String::new(),
                });
                i += 1;
                continue;
            }
            _ => None,
        };
        if let (Some((style, name)), Some(next)) = (found, next) {
            out.push(Placeholder {
                start: token.start,
                end: next.end,
                style,
                name,
            });
            i += 2;
            continue;
        }
        i += 1;
    }
    if styles.at_declared_are_variables && out.iter().any(|p| p.style == ParameterStyle::At) {
        let (declared, arguments) = tsql_declared(sql, &code);
        out.retain(|p| {
            p.style != ParameterStyle::At
                || !(declared.contains(&p.name.to_lowercase()) || arguments.contains(&p.start))
        });
    }
    out
}

/// `007` and `7` are the same parameter.
fn trim_number(digits: &str) -> String {
    let trimmed = digits.trim_start_matches('0');
    if trimmed.is_empty() { "0" } else { trimmed }.to_owned()
}

/// The identity of a parameter across a run: names compare without case where the engine
/// folds them, positional ones by their order in the run.
pub fn parameter_key(placeholder: &Placeholder, positional_index: usize) -> String {
    match placeholder.style {
        ParameterStyle::Positional => positional_index.to_string(),
        ParameterStyle::Numbered => placeholder.name.clone(),
        _ => placeholder.name.clone(),
    }
}

/// A value bound to one placeholder of the statement sent.
#[derive(Debug, Clone, PartialEq)]
pub struct BoundParam {
    /// The placeholder as the engine binds it: `$2`, `?`, `:id`, `@id`, `?3`.
    pub name: String,
    pub value: Value,
}

/// A user statement ready to run with its parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct ParamStatement {
    /// The text sent to the server.
    pub sql: String,
    /// In the engine's order: `$n` → index `n - 1`; `?` → order of appearance; names
    /// (bound as written) → order of first appearance.
    pub params: Vec<BoundParam>,
    /// Edits made to the text: (start in `sql`, end in `sql`, start in the original, end
    /// in the original), in order. Empty when the text is sent as written.
    pub edits: Vec<(usize, usize, usize, usize)>,
}

impl ParamStatement {
    /// The statement without parameters.
    pub fn plain(sql: &str) -> Self {
        Self {
            sql: sql.to_owned(),
            params: Vec::new(),
            edits: Vec::new(),
        }
    }

    pub fn rewritten(&self) -> bool {
        !self.edits.is_empty()
    }

    /// The byte of the original statement a byte of the sent text comes from.
    pub fn original_byte(&self, sent: usize) -> usize {
        let mut shift: isize = 0;
        for &(start, end, orig_start, orig_end) in &self.edits {
            if sent < start {
                break;
            }
            if sent < end {
                return orig_start;
            }
            shift = orig_end.cast_signed() - end.cast_signed();
        }
        sent.saturating_add_signed(shift)
    }
}

/// Values given for a run, by parameter key.
pub type ParamValues = HashMap<String, Value>;

/// Binds the values to one statement, rewriting its placeholders only where the engine
/// needs it. `positional_base`: positional parameters before this statement in the run.
/// Fails, naming them, when parameters have no value.
pub fn bind(
    sql: &str,
    placeholders: &[Placeholder],
    positional_base: usize,
    values: &ParamValues,
    binding: ParamBinding,
) -> Result<ParamStatement, YadbeError> {
    if placeholders.is_empty() {
        return Ok(ParamStatement::plain(sql));
    }
    let mut positional = positional_base;
    let mut keyed: Vec<(String, &Placeholder)> = Vec::with_capacity(placeholders.len());
    let mut missing: Vec<String> = Vec::new();
    for placeholder in placeholders {
        if placeholder.style == ParameterStyle::Positional {
            positional += 1;
        }
        let key = parameter_key(placeholder, positional);
        if !values.contains_key(&key) && !missing.contains(&key) {
            missing.push(key.clone());
        }
        keyed.push((key, placeholder));
    }
    if !missing.is_empty() {
        return Err(missing_values(sql, &keyed, &missing));
    }
    let value = |key: &str| values.get(key).cloned().unwrap_or(Value::Null);
    match binding {
        ParamBinding::AsWritten => {
            let mut params: Vec<BoundParam> = Vec::new();
            for (key, placeholder) in &keyed {
                let name = placeholder.written(sql).to_owned();
                // Every `?` is its own parameter; a name is bound once, wherever it appears.
                if placeholder.style == ParameterStyle::Positional
                    || !params.iter().any(|p| p.name == name)
                {
                    params.push(BoundParam {
                        name,
                        value: value(key),
                    });
                }
            }
            Ok(ParamStatement {
                sql: sql.to_owned(),
                params,
                edits: Vec::new(),
            })
        }
        ParamBinding::DollarNumbers => {
            let highest = keyed
                .iter()
                .filter(|(_, p)| p.style == ParameterStyle::Numbered)
                .filter_map(|(key, _)| key.parse::<usize>().ok())
                .max()
                .unwrap_or(0);
            let mut slots: Vec<Option<Value>> = vec![None; highest];
            let mut numbers: HashMap<String, usize> = HashMap::new();
            let mut out = String::with_capacity(sql.len());
            let mut edits = Vec::new();
            let mut copied = 0;
            for (key, placeholder) in &keyed {
                if placeholder.style == ParameterStyle::Numbered {
                    let n: usize = key.parse().unwrap_or(0);
                    if n == 0 {
                        return Err(YadbeError::invalid_argument(
                            "Parameters are numbered from $1.",
                            "Les paramètres sont numérotés à partir de $1.",
                        ));
                    }
                    slots[n - 1] = Some(value(key));
                    continue;
                }
                let number = *numbers.entry(key.clone()).or_insert_with(|| {
                    slots.push(Some(value(key)));
                    slots.len()
                });
                out.push_str(&sql[copied..placeholder.start]);
                let start = out.len();
                out.push('$');
                out.push_str(&number.to_string());
                edits.push((start, out.len(), placeholder.start, placeholder.end));
                copied = placeholder.end;
            }
            out.push_str(&sql[copied..]);
            // `$2` without `$1`: the server still expects a value for `$1`.
            let params = slots
                .into_iter()
                .enumerate()
                .map(|(i, value)| BoundParam {
                    name: format!("${}", i + 1),
                    value: value.unwrap_or(Value::Null),
                })
                .collect();
            Ok(ParamStatement {
                sql: out,
                params,
                edits,
            })
        }
        ParamBinding::QuestionMarks => {
            let mut out = String::with_capacity(sql.len());
            let mut edits = Vec::new();
            let mut params = Vec::with_capacity(keyed.len());
            let mut copied = 0;
            for (key, placeholder) in &keyed {
                params.push(BoundParam {
                    name: "?".to_owned(),
                    value: value(key),
                });
                if placeholder.style == ParameterStyle::Positional {
                    continue;
                }
                out.push_str(&sql[copied..placeholder.start]);
                let start = out.len();
                out.push('?');
                edits.push((start, out.len(), placeholder.start, placeholder.end));
                copied = placeholder.end;
            }
            out.push_str(&sql[copied..]);
            Ok(ParamStatement {
                sql: out,
                params,
                edits,
            })
        }
    }
}

/// A parameter found in a run, with every place it appears (bytes of the whole text).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundParameter {
    pub key: String,
    /// As written the first time.
    pub label: String,
    pub style: ParameterStyle,
    pub occurrences: Vec<(usize, usize)>,
}

/// The parameters of the statements of a run, merged by key, in order of first appearance.
pub fn parameters_of(
    text: &str,
    statements: &[Statement],
    syntax: &SqlSyntax,
    styles: ParameterStyles,
) -> Vec<FoundParameter> {
    let mut out: Vec<FoundParameter> = Vec::new();
    let mut positional = 0;
    for statement in statements {
        let sql = &text[statement.range()];
        for placeholder in scan(sql, syntax, styles) {
            if placeholder.style == ParameterStyle::Positional {
                positional += 1;
            }
            let key = parameter_key(&placeholder, positional);
            let at = (
                statement.start + placeholder.start,
                statement.start + placeholder.end,
            );
            match out.iter_mut().find(|p| p.key == key) {
                Some(found) => found.occurrences.push(at),
                None => out.push(FoundParameter {
                    key,
                    label: placeholder.written(sql).to_owned(),
                    style: placeholder.style,
                    occurrences: vec![at],
                }),
            }
        }
    }
    out
}

/// Every statement of a run with its values bound. Fails before anything runs when a
/// parameter has no value.
pub fn bind_all(
    text: &str,
    statements: &[Statement],
    syntax: &SqlSyntax,
    styles: ParameterStyles,
    binding: ParamBinding,
    values: &ParamValues,
) -> Result<Vec<ParamStatement>, YadbeError> {
    let mut out = Vec::with_capacity(statements.len());
    let mut positional = 0;
    for statement in statements {
        let sql = &text[statement.range()];
        let placeholders = scan(sql, syntax, styles);
        out.push(bind(sql, &placeholders, positional, values, binding)?);
        positional += placeholders
            .iter()
            .filter(|p| p.style == ParameterStyle::Positional)
            .count();
    }
    Ok(out)
}

/// The value of a parameter as the user typed it, checked against its type.
pub fn parameter_value(kind: ParameterKind, text: &str) -> Result<Value, YadbeError> {
    let trimmed = text.trim();
    let invalid = |what_en: &str, what_fr: &str| {
        YadbeError::invalid_argument(
            format!("\"{trimmed}\" is not {what_en}."),
            format!("« {trimmed} » n'est pas {what_fr}."),
        )
    };
    match kind {
        ParameterKind::Text => Ok(Value::Text(text.to_owned())),
        ParameterKind::Null => Ok(Value::Null),
        ParameterKind::Boolean => match trimmed.to_ascii_lowercase().as_str() {
            "true" | "1" | "t" | "yes" => Ok(Value::Bool(true)),
            "false" | "0" | "f" | "no" => Ok(Value::Bool(false)),
            _ => Err(invalid(
                "a boolean (true or false)",
                "un booléen (true ou false)",
            )),
        },
        ParameterKind::Number => {
            let digits = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
            let (mantissa, exponent) = match digits.split_once(['e', 'E']) {
                Some((m, e)) => (m, Some(e.strip_prefix(['+', '-']).unwrap_or(e))),
                None => (digits, None),
            };
            let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
            let all_digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
            let valid = !(whole.is_empty() && fraction.is_empty())
                && all_digits(whole)
                && all_digits(fraction)
                && exponent.is_none_or(|e| !e.is_empty() && all_digits(e));
            if !valid {
                return Err(invalid("a number", "un nombre"));
            }
            let normalized = trimmed.strip_prefix('+').unwrap_or(trimmed).to_owned();
            Ok(if exponent.is_some() {
                Value::Float(normalized)
            } else if mantissa.contains('.') {
                Value::Decimal(normalized)
            } else {
                Value::Int(normalized)
            })
        }
        ParameterKind::DateTime => {
            let bytes = trimmed.as_bytes();
            let is_date = |s: &[u8]| {
                s.len() == 10
                    && s.iter().enumerate().all(|(i, b)| match i {
                        4 | 7 => *b == b'-',
                        _ => b.is_ascii_digit(),
                    })
            };
            let is_time = |s: &str| {
                let core = s.split(['+', 'Z', 'z']).next().unwrap_or(s);
                let core = match core.rfind('-') {
                    Some(at) if at >= 5 => &core[..at],
                    _ => core,
                };
                let parts: Vec<&str> = core.split(':').collect();
                (2..=3).contains(&parts.len())
                    && parts.iter().enumerate().all(|(i, p)| {
                        let (int, frac) = p.split_once('.').unwrap_or((p, ""));
                        int.len() == 2
                            && int.bytes().all(|b| b.is_ascii_digit())
                            && frac.bytes().all(|b| b.is_ascii_digit())
                            && (frac.is_empty() || i == 2)
                    })
            };
            if is_date(bytes) {
                return Ok(Value::Date(trimmed.to_owned()));
            }
            if bytes.len() > 11 && is_date(&bytes[..10]) && matches!(bytes[10], b' ' | b'T') {
                let time = &trimmed[11..];
                if is_time(time) {
                    let zoned =
                        time.contains(['+', 'Z', 'z']) || time.rfind('-').is_some_and(|at| at >= 5);
                    let value = format!("{} {time}", &trimmed[..10]);
                    return Ok(if zoned {
                        Value::TimestampTz(value)
                    } else {
                        Value::Timestamp(value)
                    });
                }
            }
            if is_time(trimmed) {
                return Ok(Value::Time(trimmed.to_owned()));
            }
            Err(invalid(
                "a date or a time (YYYY-MM-DD, HH:MM:SS or both)",
                "une date ou une heure (AAAA-MM-JJ, HH:MM:SS ou les deux)",
            ))
        }
    }
}

fn missing_values(sql: &str, keyed: &[(String, &Placeholder)], missing: &[String]) -> YadbeError {
    let names: Vec<String> = missing
        .iter()
        .map(|key| {
            keyed.iter().find(|(k, _)| k == key).map_or_else(
                || key.clone(),
                |(_, p)| match p.style {
                    ParameterStyle::Positional => format!("? #{key}"),
                    _ => p.written(sql).to_owned(),
                },
            )
        })
        .collect();
    let list = names.join(", ");
    YadbeError::invalid_argument(
        format!("These parameters have no value: {list}. Nothing was run."),
        format!("Ces paramètres n'ont pas de valeur : {list}. Rien n'a été exécuté."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::dialect::Engine;

    fn found(engine: Engine, sql: &str) -> Vec<String> {
        let dialect = engine.dialect();
        scan(
            sql,
            &dialect.syntax(),
            dialect.capabilities().parameter_styles,
        )
        .iter()
        .map(|p| p.written(sql).to_owned())
        .collect()
    }

    #[test]
    fn postgres_names_and_numbers_outside_strings_comments_and_casts() {
        let sql = "select $1, :name, x::int, ':no', \"a:b\", $$ :no $$, $tag$ $2 $tag$ \
                   -- :no\n /* :no */ from t where a[1:n] = :other and b = $10 and c @> d";
        assert_eq!(
            found(Engine::Postgres, sql),
            ["$1", ":name", ":other", "$10"]
        );
        // `E'…'` takes backslash escapes; `@name` is an operator on PostgreSQL.
        assert_eq!(found(Engine::Postgres, r"select E'\':no', @x, :y"), [":y"]);
        assert!(found(Engine::Postgres, "select 1::text, now()::date").is_empty());
    }

    #[test]
    fn sqlite_reads_every_native_form() {
        assert_eq!(
            found(
                Engine::Sqlite,
                "select ?, ?2, :a, @b, $c, '?', [x?] from t where `y:z` = :a"
            ),
            ["?", "?2", ":a", "@b", "$c", ":a"]
        );
    }

    #[test]
    fn mysql_reads_question_marks_and_colon_names_not_user_variables() {
        assert_eq!(
            found(
                Engine::Mysql,
                "select ?, :id, @user_var, @@session.sql_mode, '?', `a?` # :no\n from t"
            ),
            ["?", ":id"]
        );
        assert!(found(Engine::Mysql, "SET @x := 1").is_empty());
    }

    #[test]
    fn sql_server_reads_undeclared_variables_only() {
        let batch = "DECLARE @a int = 1, @b decimal(10, 2), @t TABLE (x int, y int);\n\
                     SELECT @a, @b, @id, @@ROWCOUNT FROM t WHERE name = @Name\n\
                     EXEC dbo.p @id = @other, @flag = 1\n\
                     SELECT @ID";
        assert_eq!(
            found(Engine::Mssql, batch),
            ["@id", "@Name", "@other", "@ID"]
        );
        assert!(found(Engine::Mssql, "select :x, ?, $1").is_empty());
        assert!(
            found(
                Engine::Mssql,
                "CREATE PROCEDURE p @id int AS SELECT * FROM t WHERE id = @id"
            )
            .is_empty()
        );
        assert!(
            found(
                Engine::Mssql,
                "CREATE OR ALTER FUNCTION f(@x int) RETURNS int AS BEGIN RETURN @x END"
            )
            .is_empty()
        );
    }

    #[test]
    fn routine_bodies_hold_no_parameters() {
        assert!(
            found(
                Engine::Mysql,
                "CREATE DEFINER=`root`@`%` PROCEDURE p(IN x INT) lbl:BEGIN SELECT :x; END"
            )
            .is_empty()
        );
    }

    fn values(pairs: &[(&str, Value)]) -> ParamValues {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect()
    }

    fn bound(engine: Engine, sql: &str, given: &ParamValues) -> Result<ParamStatement, YadbeError> {
        let dialect = engine.dialect();
        let placeholders = scan(
            sql,
            &dialect.syntax(),
            dialect.capabilities().parameter_styles,
        );
        bind(sql, &placeholders, 0, given, dialect.param_binding())
    }

    #[test]
    fn postgres_rewrites_names_to_the_next_free_numbers() {
        let given = values(&[
            ("1", Value::int(7)),
            ("name", Value::Text("x' OR 1=1 --".into())),
            ("when", Value::Null),
        ]);
        let statement = bound(
            Engine::Postgres,
            "select :name, $1, :when, :name from t -- :name",
            &given,
        )
        .expect("bound");
        assert_eq!(statement.sql, "select $2, $1, $3, $2 from t -- :name");
        assert_eq!(
            statement.params,
            [
                BoundParam {
                    name: "$1".into(),
                    value: Value::int(7)
                },
                BoundParam {
                    name: "$2".into(),
                    value: Value::Text("x' OR 1=1 --".into())
                },
                BoundParam {
                    name: "$3".into(),
                    value: Value::Null
                },
            ]
        );
        // Positions in the text sent map back to the text written.
        assert_eq!(statement.original_byte(7), 7);
        assert_eq!(statement.original_byte(11), 14);
        assert_eq!(statement.original_byte(statement.sql.len()), 46);
        assert!(statement.rewritten());
    }

    #[test]
    fn mysql_rewrites_names_to_question_marks() {
        let given = values(&[
            ("1", Value::int(1)),
            ("id", Value::int(2)),
            ("2", Value::Null),
        ]);
        let statement = bound(Engine::Mysql, "select ?, :id, ?, :id", &given).expect("bound");
        assert_eq!(statement.sql, "select ?, ?, ?, ?");
        let sent: Vec<Value> = statement.params.iter().map(|p| p.value.clone()).collect();
        assert_eq!(
            sent,
            [Value::int(1), Value::int(2), Value::Null, Value::int(2)]
        );
    }

    #[test]
    fn sqlite_and_sql_server_send_the_text_as_written() {
        let given = values(&[
            ("a", Value::int(1)),
            ("1", Value::int(2)),
            ("2", Value::int(3)),
        ]);
        let statement = bound(Engine::Sqlite, "select :a, ?, :a, ?", &given).expect("bound");
        assert_eq!(statement.sql, "select :a, ?, :a, ?");
        assert!(!statement.rewritten());
        let names: Vec<&str> = statement.params.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, [":a", "?", "?"]);

        let given = values(&[("id", Value::int(1))]);
        let statement = bound(Engine::Mssql, "select @id where @id > 0", &given).expect("bound");
        assert_eq!(statement.sql, "select @id where @id > 0");
        assert_eq!(statement.params.len(), 1);
    }

    #[test]
    fn typed_values_are_checked() {
        use ParameterKind as K;
        assert_eq!(
            parameter_value(K::Number, " 42 ").expect("int"),
            Value::int(42)
        );
        assert_eq!(
            parameter_value(K::Number, "-1.50").expect("decimal"),
            Value::Decimal("-1.50".into())
        );
        assert_eq!(
            parameter_value(K::Number, "+1e-3").expect("float"),
            Value::Float("1e-3".into())
        );
        for bad in ["", "1.2.3", "1e", "12a", "--1", "."] {
            assert!(parameter_value(K::Number, bad).is_err(), "{bad}");
        }
        assert_eq!(
            parameter_value(K::Boolean, "TRUE").expect("b"),
            Value::Bool(true)
        );
        assert!(parameter_value(K::Boolean, "maybe").is_err());
        assert_eq!(
            parameter_value(K::DateTime, "2024-02-29").expect("date"),
            Value::Date("2024-02-29".into())
        );
        assert_eq!(
            parameter_value(K::DateTime, "2024-02-29T10:30:00.5").expect("ts"),
            Value::Timestamp("2024-02-29 10:30:00.5".into())
        );
        assert_eq!(
            parameter_value(K::DateTime, "2024-02-29 10:30+02:00").expect("tz"),
            Value::TimestampTz("2024-02-29 10:30+02:00".into())
        );
        assert_eq!(
            parameter_value(K::DateTime, "23:59:59").expect("time"),
            Value::Time("23:59:59".into())
        );
        assert!(parameter_value(K::DateTime, "tomorrow").is_err());
        assert_eq!(
            parameter_value(K::Text, " x' OR 1=1 --").expect("text"),
            Value::Text(" x' OR 1=1 --".into())
        );
        assert_eq!(
            parameter_value(K::Null, "ignored").expect("null"),
            Value::Null
        );
    }

    #[test]
    fn a_run_numbers_positional_parameters_across_statements() {
        let text = "select ?; select ?, :a";
        let syntax = Engine::Mysql.dialect().syntax();
        let styles = Engine::Mysql.dialect().capabilities().parameter_styles;
        let statements = crate::db::split::split(text, &syntax);
        let found = parameters_of(text, &statements, &syntax, styles);
        let keys: Vec<&str> = found.iter().map(|p| p.key.as_str()).collect();
        assert_eq!(keys, ["1", "2", "a"]);
        assert_eq!(found[1].occurrences, [(17, 18)]);
        let given = values(&[
            ("1", Value::int(1)),
            ("2", Value::int(2)),
            ("a", Value::Null),
        ]);
        let bound = bind_all(
            text,
            &statements,
            &syntax,
            styles,
            ParamBinding::QuestionMarks,
            &given,
        )
        .expect("bound");
        assert_eq!(bound[1].sql, "select ?, ?");
        assert_eq!(bound[1].params[0].value, Value::int(2));
    }

    #[test]
    fn missing_values_are_named_and_nothing_is_bound() {
        let err = bound(
            Engine::Postgres,
            "select :a, $2, :b",
            &values(&[("b", Value::Null)]),
        )
        .expect_err("missing");
        assert!(err.message.en.contains(":a, $2"), "{}", err.message.en);
        let err = bound(Engine::Mysql, "select ?, ?", &values(&[("1", Value::Null)]))
            .expect_err("missing");
        assert!(err.message.en.contains("? #2"), "{}", err.message.en);
    }
}
