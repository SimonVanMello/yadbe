//! Secrets in the text of scripts and requests that reach the history (rule 4).
//!
//! The history keeps what the user typed, except what must not be kept: a password given to
//! `db.auth(…)`, a `pwd` / `password` field in a script or a request body, and the credentials of
//! a URL. The Redis family does the same on the parsed command (`db/keyvalue/command.rs`).

const REDACTED: &str = "***";

/// Keys whose string value is a secret (compared in lower case).
fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    matches!(
        key.as_str(),
        "pwd"
            | "passwd"
            | "password"
            | "new_password"
            | "old_password"
            | "password_hash"
            | "passphrase"
            | "secret"
            | "client_secret"
    )
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// The end (exclusive, in bytes) of the string literal starting at `start` (its quote), or the
/// end of the text when it is not closed.
fn string_end(text: &str, start: usize) -> usize {
    let mut chars = text[start..].char_indices();
    let Some((_, quote)) = chars.next() else {
        return start;
    };
    let mut escaped = false;
    for (offset, c) in chars {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == quote {
            return start + offset + c.len_utf8();
        }
    }
    text.len()
}

fn is_quote(c: char) -> bool {
    matches!(c, '"' | '\'' | '`')
}

/// Replaces the string value of every secret key (`"password": "x"`, `pwd: 'x'`) and the
/// credentials of a URL by `***`. Works on JSON and on JavaScript object literals alike.
pub fn secrets_in_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        let rest = &text[at..];
        let Some(c) = rest.chars().next() else { break };
        // A string: its content may be a key, and is copied as is.
        if is_quote(c) {
            let end = string_end(text, at);
            let literal = &text[at..end];
            let inner = literal.get(1..literal.len().saturating_sub(1)).unwrap_or("");
            out.push_str(literal);
            at = end;
            if is_secret_key(inner) {
                at = mask_value(text, at, &mut out);
            }
            continue;
        }
        // A bare key.
        if is_ident(c) {
            let end = at
                + rest
                    .char_indices()
                    .find(|&(_, c)| !is_ident(c))
                    .map_or(rest.len(), |(i, _)| i);
            out.push_str(&text[at..end]);
            let word = &text[at..end];
            at = end;
            if is_secret_key(word) {
                at = mask_value(text, at, &mut out);
            }
            continue;
        }
        out.push(c);
        at += c.len_utf8();
    }
    url_credentials(&out)
}

/// After a secret key: copies `:` and blanks, and replaces the string value that follows.
/// Anything else (a number, a variable, an object) is left for the main loop.
fn mask_value(text: &str, from: usize, out: &mut String) -> usize {
    let rest = &text[from..];
    let spaces = rest.len() - rest.trim_start().len();
    let after = &rest[spaces..];
    let Some(after_colon) = after.strip_prefix(':') else {
        return from;
    };
    let tail = after_colon.trim_start();
    let value_at = text.len() - tail.len();
    match tail.chars().next() {
        Some(q) if is_quote(q) => {
            out.push_str(&text[from..value_at]);
            out.push(q);
            out.push_str(REDACTED);
            out.push(q);
            string_end(text, value_at)
        }
        _ => from,
    }
}

/// `scheme://user:password@host` → `scheme://user:***@host`.
fn url_credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let authority_end = tail
            .find(|c: char| c == '/' || c == '?' || c == '#' || c.is_whitespace() || is_quote(c))
            .unwrap_or(tail.len());
        let authority = &tail[..authority_end];
        match authority.rsplit_once('@') {
            Some((userinfo, host)) => {
                let user = userinfo.split_once(':').map_or(userinfo, |(user, _)| user);
                if userinfo.contains(':') {
                    out.push_str(user);
                    out.push(':');
                    out.push_str(REDACTED);
                } else {
                    out.push_str(user);
                }
                out.push('@');
                out.push_str(host);
            }
            None => out.push_str(authority),
        }
        rest = &tail[authority_end..];
    }
    out.push_str(rest);
    out
}

/// A mongosh script as the history keeps it: secret fields masked, and every string given to an
/// `auth(…)` call (`db.auth("user", "password")`, `db.auth({ pwd: … })`).
pub fn script(code: &str) -> String {
    let masked = secrets_in_text(code);
    let mut out = String::with_capacity(masked.len());
    let mut rest = masked.as_str();
    while let Some(i) = rest.find("auth(") {
        let (head, tail) = rest.split_at(i + "auth(".len());
        out.push_str(head);
        // Only a method call: `x.auth(`, not `oauth(`.
        let is_call = head[..head.len() - "auth(".len()].ends_with('.');
        let close = tail.find(')').unwrap_or(tail.len());
        let (args, after) = tail.split_at(close);
        if is_call {
            out.push_str(&mask_strings(args));
        } else {
            out.push_str(args);
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

fn mask_strings(args: &str) -> String {
    let mut out = String::with_capacity(args.len());
    let mut at = 0;
    while at < args.len() {
        let Some(c) = args[at..].chars().next() else {
            break;
        };
        if is_quote(c) {
            out.push(c);
            out.push_str(REDACTED);
            out.push(c);
            at = string_end(args, at);
        } else {
            out.push(c);
            at += c.len_utf8();
        }
    }
    out
}

/// A search console request as the history keeps it (the request line and its body).
pub fn request(text: &str) -> String {
    secrets_in_text(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_secret_fields_in_json_and_javascript() {
        assert_eq!(
            secrets_in_text(r#"{"username":"bob","password":"s3cret"}"#),
            r#"{"username":"bob","password":"***"}"#
        );
        assert_eq!(
            secrets_in_text("{ user: 'bob', pwd: 's3cret', roles: [] }"),
            "{ user: 'bob', pwd: '***', roles: [] }"
        );
        assert_eq!(
            secrets_in_text(r#"{"password" : "a\"b"}"#),
            r#"{"password" : "***"}"#
        );
    }

    #[test]
    fn leaves_other_text_alone() {
        let text = r#"db.orders.find({ status: "paid", note: "my password is long" })"#;
        assert_eq!(secrets_in_text(text), text);
        assert_eq!(secrets_in_text("héllo → wörld"), "héllo → wörld");
    }

    #[test]
    fn masks_url_credentials() {
        assert_eq!(
            secrets_in_text("GET http://elastic:pw@localhost:9200/_cat/indices"),
            "GET http://elastic:***@localhost:9200/_cat/indices"
        );
        assert_eq!(
            secrets_in_text("mongodb://bob@host/db"),
            "mongodb://bob@host/db"
        );
    }

    #[test]
    fn masks_what_auth_receives() {
        assert_eq!(
            script("db.auth('bob', 'pw')\ndb.orders.find()"),
            "db.auth('***', '***')\ndb.orders.find()"
        );
        assert_eq!(
            script("db.getSiblingDB('admin').auth({ user: 'a', pwd: 'x' })"),
            "db.getSiblingDB('admin').auth({ user: '***', pwd: '***' })"
        );
        assert_eq!(script("oauth('x')"), "oauth('x')");
    }
}
