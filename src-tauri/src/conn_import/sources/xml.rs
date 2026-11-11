//! A small tolerant XML reader for the one file that needs it (SSMS registered servers):
//! elements, attributes and text, namespace prefixes dropped, entities decoded. Not a
//! validating parser; DTDs are skipped, never followed.

#[derive(Debug, Default, Clone)]
pub struct Node {
    /// The name without its namespace prefix.
    pub name: String,
    pub attributes: Vec<(String, String)>,
    pub children: Vec<Node>,
    pub text: String,
}

impl Node {
    pub fn attribute(&self, name: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name)
    }

    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> {
        self.children.iter().filter(move |c| c.name == name)
    }
}

fn local(name: &str) -> &str {
    name.rsplit_once(':').map_or(name, |(_, local)| local)
}

fn decode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest.find(';') else {
            out.push_str(rest);
            return out;
        };
        let entity = &rest[1..end];
        match entity {
            "amp" => out.push('&'),
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "quot" => out.push('"'),
            "apos" => out.push('\''),
            _ => {
                let code = entity
                    .strip_prefix("#x")
                    .and_then(|h| u32::from_str_radix(h, 16).ok())
                    .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()));
                match code.and_then(char::from_u32) {
                    Some(c) => out.push(c),
                    None => out.push_str(&rest[..=end]),
                }
            }
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

fn attributes(tag: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = tag;
    while let Some(eq) = rest.find('=') {
        let key = rest[..eq]
            .trim()
            .rsplit(char::is_whitespace)
            .next()
            .unwrap_or_default();
        let after = rest[eq + 1..].trim_start();
        let Some(quote) = after.chars().next().filter(|c| matches!(c, '"' | '\'')) else {
            break;
        };
        let Some(close) = after[1..].find(quote) else {
            break;
        };
        out.push((local(key).to_owned(), decode(&after[1..=close])));
        rest = &after[close + 2..];
    }
    out
}

/// The root element of `text`, or `None` when there is none or tags do not nest.
pub fn parse(text: &str) -> Option<Node> {
    let mut stack: Vec<Node> = Vec::new();
    let mut root: Option<Node> = None;
    let mut rest = text.strip_prefix('\u{feff}').unwrap_or(text);
    while !rest.is_empty() {
        let Some(open) = rest.find('<') else {
            if let Some(top) = stack.last_mut() {
                top.text.push_str(&decode(rest));
            }
            break;
        };
        if let Some(top) = stack.last_mut() {
            top.text.push_str(&decode(&rest[..open]));
        }
        rest = &rest[open..];
        if let Some(body) = rest.strip_prefix("<!--") {
            rest = &body[body.find("-->")? + 3..];
        } else if let Some(body) = rest.strip_prefix("<![CDATA[") {
            let end = body.find("]]>")?;
            if let Some(top) = stack.last_mut() {
                top.text.push_str(&body[..end]);
            }
            rest = &body[end + 3..];
        } else if rest.starts_with("<?") || rest.starts_with("<!") {
            rest = &rest[rest.find('>')? + 1..];
        } else {
            let end = rest.find('>')?;
            let tag = &rest[1..end];
            rest = &rest[end + 1..];
            if let Some(name) = tag.strip_prefix('/') {
                let node = stack.pop()?;
                if node.name != local(name.trim()) {
                    return None;
                }
                match stack.last_mut() {
                    Some(parent) => parent.children.push(node),
                    None => root = Some(node),
                }
            } else {
                let self_closing = tag.ends_with('/');
                let tag = tag.trim_end_matches('/');
                let name_end = tag.find(char::is_whitespace).unwrap_or(tag.len());
                let node = Node {
                    name: local(&tag[..name_end]).to_owned(),
                    attributes: attributes(&tag[name_end..]),
                    ..Node::default()
                };
                if self_closing {
                    match stack.last_mut() {
                        Some(parent) => parent.children.push(node),
                        None => root = Some(node),
                    }
                } else {
                    stack.push(node);
                }
            }
        }
    }
    if stack.is_empty() { root } else { None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_elements_attributes_text_and_entities() {
        let root = parse(
            "<?xml version=\"1.0\"?>\n<!-- c --><a:Root xmlns:a=\"urn:x\" name=\"R &amp; D\">\
             <a:Item id='1'>x &lt; y</a:Item><a:Empty/><a:Item id=\"2\"><![CDATA[<raw>]]></a:Item></a:Root>",
        )
        .expect("parses");
        assert_eq!(root.name, "Root");
        assert_eq!(root.attribute("name"), Some("R & D"));
        let items: Vec<&Node> = root.children_named("Item").collect();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].text, "x < y");
        assert_eq!(items[0].attribute("id"), Some("1"));
        assert_eq!(items[1].text, "<raw>");
        assert!(root.child("Empty").is_some());
        assert!(parse("<a><b></a>").is_none());
        assert!(parse("<a>").is_none());
        assert!(parse("no xml").is_none());
    }
}
