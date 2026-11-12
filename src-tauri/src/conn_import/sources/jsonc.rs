//! JSON with comments and trailing commas (VS Code and Azure Data Studio settings), as
//! plain JSON.

/// Drops `//` and `/* */` comments outside strings, then the commas before a closing `}` or
/// `]`.
pub fn to_json(text: &str) -> String {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut stripped = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            stripped.push(c);
            if c == '\\' {
                if let Some(next) = chars.next() {
                    stripped.push(next);
                }
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                stripped.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        stripped.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut previous = '\0';
                for next in chars.by_ref() {
                    if previous == '*' && next == '/' {
                        break;
                    }
                    if next == '\n' {
                        stripped.push('\n');
                    }
                    previous = next;
                }
            }
            _ => stripped.push(c),
        }
    }
    drop_trailing_commas(&stripped)
}

fn drop_trailing_commas(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut in_string = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                i += 1;
                out.push(chars[i]);
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if c == ',' {
            let next = chars[i + 1..].iter().find(|c| !c.is_whitespace());
            if !matches!(next, Some('}' | ']')) {
                out.push(c);
            }
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_settings_with_comments_and_trailing_commas() {
        let text = "\u{feff}{
  // a comment with \"quotes\"
  \"url\": \"http://example.com/a//b\", /* block
  comment */
  \"list\": [1, 2, 3,],
  \"nested\": {\"a\": \"x,]\",},
}";
        let value: serde_json::Value = serde_json::from_str(&to_json(text)).expect("valid JSON");
        assert_eq!(value["url"], "http://example.com/a//b");
        assert_eq!(value["list"], serde_json::json!([1, 2, 3]));
        assert_eq!(value["nested"]["a"], "x,]");
    }
}
