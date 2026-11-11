//! A small XML reader for showplan documents: elements and attributes only (text, comments,
//! processing instructions and CDATA are skipped). Showplans are machine-written, without a
//! DTD; a crate for this was not worth a dependency.

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Element {
    /// Local name (the namespace prefix is dropped).
    pub name: String,
    pub attributes: Vec<(String, String)>,
    pub children: Vec<Element>,
}

impl Element {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn child(&self, name: &str) -> Option<&Element> {
        self.children.iter().find(|c| c.name == name)
    }

    /// Every element named `name` under this one, in document order, without descending into
    /// elements named `stop`.
    pub fn find_all<'a>(&'a self, name: &str, stop: &str, out: &mut Vec<&'a Element>) {
        for child in &self.children {
            if child.name == name {
                out.push(child);
            } else if child.name != stop {
                child.find_all(name, stop, out);
            }
        }
    }
}

fn unescape(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest.find(';') else {
            break;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn local(name: &str) -> String {
    name.rsplit(':').next().unwrap_or(name).to_owned()
}

/// Parses a document into its root element; `None` when it is not well formed.
pub fn parse(text: &str) -> Option<Element> {
    let bytes = text.as_bytes();
    let mut stack: Vec<Element> = Vec::new();
    let mut root: Option<Element> = None;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let rest = &text[i..];
        if rest.starts_with("<?") {
            i += rest.find("?>")? + 2;
            continue;
        }
        if rest.starts_with("<!--") {
            i += rest.find("-->")? + 3;
            continue;
        }
        if rest.starts_with("<![CDATA[") {
            i += rest.find("]]>")? + 3;
            continue;
        }
        if rest.starts_with("<!") {
            i += rest.find('>')? + 1;
            continue;
        }
        if let Some(close) = rest.strip_prefix("</") {
            let end = close.find('>')?;
            let element = stack.pop()?;
            if element.name != local(close[..end].trim()) {
                return None;
            }
            match stack.last_mut() {
                Some(parent) => parent.children.push(element),
                None => root = Some(element),
            }
            i += end + 3;
            continue;
        }
        // An opening tag: name, attributes, `>` or `/>`. Quoted values may hold `>`.
        let mut j = i + 1;
        while j < bytes.len()
            && !bytes[j].is_ascii_whitespace()
            && bytes[j] != b'>'
            && bytes[j] != b'/'
        {
            j += 1;
        }
        let mut element = Element {
            name: local(&text[i + 1..j]),
            ..Element::default()
        };
        let self_closing;
        loop {
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            match bytes.get(j)? {
                b'>' => {
                    self_closing = false;
                    j += 1;
                    break;
                }
                b'/' => {
                    if bytes.get(j + 1) != Some(&b'>') {
                        return None;
                    }
                    self_closing = true;
                    j += 2;
                    break;
                }
                _ => {
                    let eq = j + text[j..].find('=')?;
                    let key = text[j..eq].trim().to_owned();
                    let mut k = eq + 1;
                    while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                        k += 1;
                    }
                    let quote = *bytes.get(k)?;
                    if quote != b'"' && quote != b'\'' {
                        return None;
                    }
                    let end = k + 1 + text[k + 1..].find(char::from(quote))?;
                    element
                        .attributes
                        .push((local(&key), unescape(&text[k + 1..end])));
                    j = end + 1;
                }
            }
        }
        i = j;
        if self_closing {
            match stack.last_mut() {
                Some(parent) => parent.children.push(element),
                None => root = Some(element),
            }
        } else {
            stack.push(element);
        }
    }
    if stack.is_empty() { root } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_elements_attributes_and_entities() {
        let doc = parse(
            "<?xml version=\"1.0\"?><!-- c --><a:Root xmlns:a=\"x\" k='v &gt; &#65;&#x42;'>\
             text<Child n=\"1\"/><Child n=\"2\">\n<Inner/></Child><![CDATA[<no>]]></a:Root>",
        )
        .expect("parsed");
        assert_eq!(doc.name, "Root");
        assert_eq!(doc.attr("k"), Some("v > AB"));
        assert_eq!(doc.children.len(), 2);
        assert_eq!(doc.children[1].attr("n"), Some("2"));
        let mut inner = Vec::new();
        doc.find_all("Inner", "", &mut inner);
        assert_eq!(inner.len(), 1);
        assert!(parse("<a><b></a>").is_none());
        assert!(parse("<a>").is_none());
    }
}
