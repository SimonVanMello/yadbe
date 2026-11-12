//! The lines of a script that are mongosh shell commands rather than JavaScript (`use shop`,
//! `show collections`, `it`), found as mongosh finds them: a whole line, outside any string,
//! comment, template or bracket. The rest is JavaScript, evaluated as written in the pieces
//! between those lines.

/// A shell command, with what follows it on its line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellCommand {
    Use(String),
    Show(String),
    It,
}

impl ShellCommand {
    /// The command and its argument, as the prelude's `shell` hook takes them.
    pub fn parts(&self) -> (&'static str, &str) {
        match self {
            ShellCommand::Use(name) => ("use", name),
            ShellCommand::Show(what) => ("show", what),
            ShellCommand::It => ("it", ""),
        }
    }
}

/// A piece of the script: JavaScript between byte offsets, or one shell command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Js { start: usize, end: usize },
    Shell { command: ShellCommand, start: usize },
}

/// Lexical state carried from one line to the next.
#[derive(Debug, Default)]
struct Scan {
    /// Open brackets, and template literals (`` ` ``) whose `${` are counted here too.
    stack: Vec<u8>,
    in_block_comment: bool,
    /// Inside a template literal's text (not in one of its `${ }`).
    in_template: bool,
}

impl Scan {
    fn clean(&self) -> bool {
        self.stack.is_empty() && !self.in_block_comment && !self.in_template
    }

    /// Walks one line (without its newline). `last` is the last significant character seen,
    /// to tell a regular expression from a division.
    fn line(&mut self, line: &[u8], last: &mut u8) {
        let mut i = 0;
        while i < line.len() {
            let c = line[i];
            if self.in_block_comment {
                if c == b'*' && line.get(i + 1) == Some(&b'/') {
                    self.in_block_comment = false;
                    i += 2;
                } else {
                    i += 1;
                }
                continue;
            }
            if self.in_template {
                match c {
                    b'\\' => i += 2,
                    b'`' => {
                        self.in_template = false;
                        self.stack.pop();
                        *last = b'`';
                        i += 1;
                    }
                    b'$' if line.get(i + 1) == Some(&b'{') => {
                        self.in_template = false;
                        self.stack.push(b'{');
                        i += 2;
                    }
                    _ => i += 1,
                }
                continue;
            }
            match c {
                b' ' | b'\t' | b'\r' => i += 1,
                b'/' if line.get(i + 1) == Some(&b'/') => return,
                b'/' if line.get(i + 1) == Some(&b'*') => {
                    self.in_block_comment = true;
                    i += 2;
                }
                b'/' if regex_can_start(*last) => {
                    i = skip_regex(line, i);
                    *last = b'/';
                }
                b'\'' | b'"' => {
                    i = skip_string(line, i, c);
                    *last = c;
                }
                b'`' => {
                    self.stack.push(b'`');
                    self.in_template = true;
                    i += 1;
                }
                b'(' | b'[' | b'{' => {
                    self.stack.push(c);
                    *last = c;
                    i += 1;
                }
                b')' | b']' | b'}' => {
                    if self.stack.last().is_some_and(|open| *open != b'`') {
                        self.stack.pop();
                    }
                    // The `}` closing a template's `${`: back into its text.
                    if c == b'}' && self.stack.last() == Some(&b'`') {
                        self.in_template = true;
                    }
                    *last = c;
                    i += 1;
                }
                _ => {
                    *last = c;
                    i += 1;
                }
            }
        }
    }
}

/// A `/` after one of these starts a regular expression, not a division.
fn regex_can_start(last: u8) -> bool {
    matches!(
        last,
        0 | b'('
            | b','
            | b'='
            | b':'
            | b'['
            | b'!'
            | b'&'
            | b'|'
            | b'?'
            | b'{'
            | b'}'
            | b';'
            | b'+'
            | b'-'
            | b'*'
            | b'%'
            | b'<'
            | b'>'
            | b'~'
            | b'^'
    )
}

fn skip_string(line: &[u8], from: usize, quote: u8) -> usize {
    let mut i = from + 1;
    while i < line.len() {
        match line[i] {
            b'\\' => i += 2,
            c if c == quote => return i + 1,
            _ => i += 1,
        }
    }
    line.len()
}

fn skip_regex(line: &[u8], from: usize) -> usize {
    let mut i = from + 1;
    let mut class = false;
    while i < line.len() {
        match line[i] {
            b'\\' => i += 2,
            b'[' => {
                class = true;
                i += 1;
            }
            b']' => {
                class = false;
                i += 1;
            }
            b'/' if !class => return i + 1,
            _ => i += 1,
        }
    }
    line.len()
}

/// The shell command a whole line is, if it is one: `use <db>`, `show <what>`, `it`, with an
/// optional `;` and trailing `//` comment.
pub fn shell_command(line: &str) -> Option<ShellCommand> {
    let text = match line.find("//") {
        Some(at) => &line[..at],
        None => line,
    };
    let text = text.trim().trim_end_matches(';').trim_end();
    let mut words = text.split_whitespace();
    let first = words.next()?;
    let rest: Vec<&str> = words.collect();
    match (first, rest.as_slice()) {
        ("use", [name]) if is_name(name) => Some(ShellCommand::Use((*name).to_owned())),
        ("show", [what]) if is_name(what) => Some(ShellCommand::Show((*what).to_owned())),
        ("it", []) => Some(ShellCommand::It),
        _ => None,
    }
}

/// A database name or a `show` argument: no quote, bracket, operator or dot-call that would
/// make the line JavaScript (`use(x)`, `show.x`).
fn is_name(word: &str) -> bool {
    !word.is_empty()
        && word.chars().all(|c| {
            !matches!(
                c,
                '(' | ')' | '[' | ']' | '{' | '}' | '=' | '\'' | '"' | '`' | ',' | '+'
            )
        })
}

/// Splits `code` into JavaScript pieces and shell command lines, in order. Empty or blank
/// JavaScript pieces are dropped.
pub fn segments(code: &str) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut scan = Scan::default();
    let mut last = 0_u8;
    let mut js_start = 0;
    let mut offset = 0;
    for line in code.split_inclusive('\n') {
        let body = line.trim_end_matches('\n');
        if scan.clean()
            && let Some(command) = shell_command(body)
        {
            push_js(&mut out, code, js_start, offset);
            out.push(Segment::Shell {
                command,
                start: offset,
            });
            js_start = offset + line.len();
            last = b';';
        } else {
            scan.line(body.as_bytes(), &mut last);
            if !body.trim().is_empty() && scan.clean() {
                // A new line may start a regular expression (ASI).
                last = b';';
            }
        }
        offset += line.len();
    }
    push_js(&mut out, code, js_start, code.len());
    out
}

fn push_js(out: &mut Vec<Segment>, code: &str, start: usize, end: usize) {
    if start < end && !code[start..end].trim().is_empty() {
        out.push(Segment::Js { start, end });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shells(code: &str) -> Vec<String> {
        segments(code)
            .into_iter()
            .map(|s| match s {
                Segment::Js { start, end } => format!("js:{}", code[start..end].trim()),
                Segment::Shell { command, .. } => {
                    let (name, arg) = command.parts();
                    format!("{name}:{arg}")
                }
            })
            .collect()
    }

    #[test]
    fn shell_lines_split_the_javascript() {
        assert_eq!(
            shells("use shop\ndb.orders.find()\nshow collections;\nit\n"),
            ["use:shop", "js:db.orders.find()", "show:collections", "it:"]
        );
        assert_eq!(
            shells("  use   shop ; // switch\nx = 1"),
            ["use:shop", "js:x = 1"]
        );
        assert_eq!(shells("let a = 1\nprint(a)"), ["js:let a = 1\nprint(a)"]);
    }

    #[test]
    fn javascript_that_looks_like_a_command_stays_javascript() {
        // Inside a template, a block comment, an object, a string continued by a backslash.
        for code in [
            "const s = `\nuse shop\n`",
            "/*\nuse shop\n*/",
            "f({\nit\n})",
            "const r = /[(]/; g(\nshow dbs\n)",
            "const t = `${ {a: 1}.a }\nuse x\n`",
        ] {
            assert!(
                shells(code).iter().all(|s| s.starts_with("js:")),
                "{code}: {:?}",
                shells(code)
            );
        }
        // Valid JavaScript: a call, a property, an assignment.
        assert_eq!(shell_command("use(x)"), None);
        assert_eq!(shell_command("show.dbs"), None);
        assert_eq!(shell_command("it = 3"), None);
        assert_eq!(shell_command("use"), None);
        // After a regex with a quote in it, a line is still a command.
        assert_eq!(
            shells("const r = /'/\nuse shop"),
            ["js:const r = /'/", "use:shop"]
        );
    }

    #[test]
    fn offsets_point_into_the_text() {
        let code = "a()\nuse shop\nb()";
        let segs = segments(code);
        assert_eq!(
            segs,
            [
                Segment::Js { start: 0, end: 4 },
                Segment::Shell {
                    command: ShellCommand::Use("shop".into()),
                    start: 4
                },
                Segment::Js { start: 13, end: 16 },
            ]
        );
    }
}
