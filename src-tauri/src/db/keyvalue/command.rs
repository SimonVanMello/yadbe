//! One command as RESP arguments, and its display form: what the history, the statement log
//! and the confirmation dialogs show. Secrets a command carries (`AUTH`, `HELLO … AUTH`,
//! `ACL SETUSER … >password`, `CONFIG SET requirepass`, `MIGRATE … AUTH`) never appear there
//! (rule 4): the display redacts them.

use super::bytes::escape;

const REDACTED: &str = "***";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KvCommand {
    pub args: Vec<Vec<u8>>,
}

impl KvCommand {
    pub fn new(args: Vec<Vec<u8>>) -> Self {
        Self { args }
    }

    /// A command yadbe writes itself, from text arguments and raw ones.
    pub fn of<I, A>(args: I) -> Self
    where
        I: IntoIterator<Item = A>,
        A: AsRef<[u8]>,
    {
        Self {
            args: args.into_iter().map(|a| a.as_ref().to_vec()).collect(),
        }
    }

    /// The command name, lower case (`hgetall`); empty for an empty command.
    pub fn name(&self) -> String {
        self.args
            .first()
            .map(|a| String::from_utf8_lossy(a).to_ascii_lowercase())
            .unwrap_or_default()
    }

    /// Argument `index` lower case, when it is text (a subcommand, an option).
    pub fn arg_lower(&self, index: usize) -> Option<String> {
        self.args
            .get(index)
            .and_then(|a| std::str::from_utf8(a).ok())
            .map(str::to_ascii_lowercase)
    }

    /// The argument positions that hold a secret.
    fn secret_positions(&self) -> Vec<usize> {
        let name = self.name();
        let len = self.args.len();
        let lower = |i: usize| self.arg_lower(i).unwrap_or_default();
        let mut secrets = Vec::new();
        match name.as_str() {
            // AUTH password | AUTH user password
            "auth" if len >= 2 => secrets.push(len - 1),
            // HELLO [protover [AUTH user password] [SETNAME name]]
            "hello" => {
                for i in 1..len {
                    if lower(i) == "auth" {
                        secrets.push(i + 2);
                    }
                }
            }
            // MIGRATE … [AUTH password | AUTH2 user password] [KEYS …]
            "migrate" => {
                for i in 1..len {
                    match lower(i).as_str() {
                        "auth" => secrets.push(i + 1),
                        "auth2" => secrets.push(i + 2),
                        _ => {}
                    }
                }
            }
            "acl" if lower(1) == "setuser" => {
                for i in 3..len {
                    if matches!(self.args[i].first(), Some(b'>' | b'<' | b'#' | b'!')) {
                        secrets.push(i);
                    }
                }
            }
            "config" if lower(1) == "set" => {
                let mut i = 2;
                while i + 1 < len {
                    if is_secret_setting(&lower(i)) {
                        secrets.push(i + 1);
                    }
                    i += 2;
                }
            }
            _ => {}
        }
        secrets.retain(|&i| i < len);
        secrets
    }

    /// The command as a `redis-cli` line, with its secrets replaced by `***`.
    pub fn display(&self) -> String {
        let secrets = self.secret_positions();
        self.args
            .iter()
            .enumerate()
            .map(|(i, arg)| {
                if secrets.contains(&i) {
                    // Keep the rule's operator (`>`), drop the password.
                    match arg.first() {
                        Some(&op @ (b'>' | b'<' | b'#' | b'!')) if self.name() == "acl" => {
                            format!("{}{REDACTED}", char::from(op))
                        }
                        _ => REDACTED.to_owned(),
                    }
                } else {
                    quote(arg)
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// The display form cut to `max` characters (statement log of long commands).
    pub fn display_short(&self, max: usize) -> String {
        let full = self.display();
        if full.chars().count() <= max {
            return full;
        }
        let mut cut: String = full.chars().take(max).collect();
        cut.push('…');
        cut
    }
}

/// Server settings whose value is a secret (`CONFIG SET requirepass …`).
pub fn is_secret_setting(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "requirepass"
            | "masterauth"
            | "masteruser"
            | "tls-key-file-pass"
            | "tls-client-key-file-pass"
    )
}

/// One argument as `redis-cli` would need it typed: bare when it is plain text, else in
/// double quotes with escapes.
pub fn quote(arg: &[u8]) -> String {
    let plain = !arg.is_empty()
        && arg
            .iter()
            .all(|&b| b.is_ascii_graphic() && !matches!(b, b'"' | b'\'' | b'\\'));
    if plain {
        String::from_utf8_lossy(arg).into_owned()
    } else {
        format!("\"{}\"", escape(arg))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::keyvalue::tokenize::split_args;

    fn display(line: &str) -> String {
        KvCommand::new(split_args(line).expect("splits")).display()
    }

    #[test]
    fn quotes_what_needs_it() {
        assert_eq!(display("SET user:1 hello"), "SET user:1 hello");
        assert_eq!(display(r#"SET "a b" "x\xff""#), r#"SET "a b" "x\xff""#);
        assert_eq!(display(r#"SET k """#), r#"SET k """#);
    }

    #[test]
    fn secrets_never_show() {
        assert_eq!(display("AUTH s3cret"), "AUTH ***");
        assert_eq!(display("auth bob s3cret"), "auth bob ***");
        assert_eq!(
            display("HELLO 3 AUTH bob s3cret SETNAME x"),
            "HELLO 3 AUTH bob *** SETNAME x"
        );
        assert_eq!(
            display("ACL SETUSER bob on >s3cret ~* +@all"),
            "ACL SETUSER bob on >*** ~* +@all"
        );
        assert_eq!(
            display("CONFIG SET maxmemory 1gb requirepass s3cret"),
            "CONFIG SET maxmemory 1gb requirepass ***"
        );
        assert_eq!(
            display("MIGRATE h 6379 k 0 5000 AUTH2 bob s3cret"),
            "MIGRATE h 6379 k 0 5000 AUTH2 bob ***"
        );
        for line in [
            "AUTH s3cret",
            "HELLO 3 AUTH bob s3cret",
            "ACL SETUSER bob >s3cret",
            "CONFIG SET requirepass s3cret",
            "MIGRATE h 1 k 0 1 AUTH s3cret",
        ] {
            assert!(!display(line).contains("s3cret"), "{line}");
        }
    }

    #[test]
    fn names_are_lower_case() {
        let cmd = KvCommand::of(["HGetAll", "k"]);
        assert_eq!(cmd.name(), "hgetall");
        assert_eq!(cmd.display_short(5), "HGetA…");
    }
}
