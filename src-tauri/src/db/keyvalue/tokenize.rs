//! A console line split into arguments the way `redis-cli` does it (`sdssplitargs`):
//! whitespace separates arguments; `"…"` takes escapes (`\n`, `\r`, `\t`, `\b`, `\a`, `\\`,
//! `\"`, `\xHH`); `'…'` takes only `\'`; a closing quote must end the argument. The bytes
//! that come out are sent as they are (rule 3): nothing is joined back into a string.

use crate::db::errors::YadbeError;

fn unbalanced() -> YadbeError {
    YadbeError::invalid_argument(
        "Unbalanced quotes in the command line.",
        "Guillemets non équilibrés dans la ligne de commande.",
    )
}

fn hex(b: u8) -> Option<u8> {
    char::from(b)
        .to_digit(16)
        .and_then(|d| u8::try_from(d).ok())
}

/// The arguments of one line; an empty line has none.
pub fn split_args(line: &str) -> Result<Vec<Vec<u8>>, YadbeError> {
    let bytes = line.as_bytes();
    let mut args = Vec::new();
    let mut i = 0;
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            return Ok(args);
        }
        let mut current = Vec::new();
        let mut in_double = false;
        let mut in_single = false;
        loop {
            if in_double {
                let Some(&b) = bytes.get(i) else {
                    return Err(unbalanced());
                };
                if b == b'\\'
                    && bytes.get(i + 1) == Some(&b'x')
                    && let (Some(h), Some(l)) = (
                        bytes.get(i + 2).copied().and_then(hex),
                        bytes.get(i + 3).copied().and_then(hex),
                    )
                {
                    current.push(h * 16 + l);
                    i += 4;
                    continue;
                }
                if b == b'\\' && i + 1 < bytes.len() {
                    i += 1;
                    current.push(match bytes[i] {
                        b'n' => b'\n',
                        b'r' => b'\r',
                        b't' => b'\t',
                        b'b' => 0x08,
                        b'a' => 0x07,
                        other => other,
                    });
                } else if b == b'"' {
                    // A closing quote must be followed by a space or nothing.
                    if bytes.get(i + 1).is_some_and(|n| !n.is_ascii_whitespace()) {
                        return Err(unbalanced());
                    }
                    i += 1;
                    break;
                } else {
                    current.push(b);
                }
                i += 1;
            } else if in_single {
                let Some(&b) = bytes.get(i) else {
                    return Err(unbalanced());
                };
                if b == b'\\' && bytes.get(i + 1) == Some(&b'\'') {
                    current.push(b'\'');
                    i += 2;
                    continue;
                }
                if b == b'\'' {
                    if bytes.get(i + 1).is_some_and(|n| !n.is_ascii_whitespace()) {
                        return Err(unbalanced());
                    }
                    i += 1;
                    break;
                }
                current.push(b);
                i += 1;
            } else {
                match bytes.get(i) {
                    None => break,
                    Some(b) if b.is_ascii_whitespace() => break,
                    Some(b'"') if current.is_empty() => in_double = true,
                    Some(b'\'') if current.is_empty() => in_single = true,
                    Some(&b) => current.push(b),
                }
                i += 1;
            }
        }
        args.push(current);
    }
}

/// The command lines of a console text: one per line, blank lines and `#` comments skipped.
/// Each comes with its 0-based line number.
pub fn command_lines(text: &str) -> Vec<(usize, &str)> {
    text.lines()
        .enumerate()
        .map(|(n, line)| (n, line.trim()))
        .filter(|(_, line)| !line.is_empty() && !line.starts_with('#'))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        split_args(line)
            .expect("splits")
            .into_iter()
            .map(|a| String::from_utf8_lossy(&a).into_owned())
            .collect()
    }

    #[test]
    fn splits_like_redis_cli() {
        assert_eq!(args("  HGETALL   user:42 "), ["HGETALL", "user:42"]);
        assert_eq!(args(r#"SET k "a b\n\"c\"""#), ["SET", "k", "a b\n\"c\""]);
        assert_eq!(args(r"SET k 'it\'s \n'"), ["SET", "k", "it's \\n"]);
        assert_eq!(args(r#"SET k "" ''"#), ["SET", "k", "", ""]);
        assert_eq!(args("GET a\"b"), ["GET", "a\"b"]);
        assert!(args("").is_empty());
    }

    #[test]
    fn hex_escapes_give_raw_bytes() {
        let split = split_args(r#"SET "\xff\x00k" v"#).expect("splits");
        assert_eq!(split[1], vec![0xff, 0x00, b'k']);
    }

    #[test]
    fn refuses_unbalanced_quotes() {
        assert!(split_args(r#"SET "abc"#).is_err());
        assert!(split_args("SET 'abc").is_err());
        assert!(split_args(r#"SET "a"b"#).is_err());
    }

    #[test]
    fn lines_skip_blanks_and_comments() {
        let text = "PING\n\n  # a note\nGET k  \n";
        assert_eq!(command_lines(text), vec![(0, "PING"), (3, "GET k")]);
    }
}
