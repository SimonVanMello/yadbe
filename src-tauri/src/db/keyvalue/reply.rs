//! A server reply, binary-safe, the same for RESP2 and RESP3. Drivers convert their own
//! reply type into this one; the services and the console only read this.

use super::bytes::escape;

#[derive(Debug, Clone, PartialEq)]
pub enum KvReply {
    Nil,
    Int(i64),
    Double(f64),
    Bool(bool),
    /// A number beyond 64 bits, as its decimal digits.
    BigNumber(String),
    /// A simple string (`OK`, `PONG`, a type name…).
    Status(String),
    /// A bulk or verbatim string: any bytes.
    Bulk(Vec<u8>),
    /// An error inside a reply (an `EXEC` element); a top-level error is an `Err`.
    Error(String),
    Array(Vec<KvReply>),
    /// A RESP3 set; RESP2 sends an array.
    Set(Vec<KvReply>),
    /// A RESP3 map, in the server's order; RESP2 sends a flat array.
    Map(Vec<(KvReply, KvReply)>),
}

impl KvReply {
    /// The bytes of a string-like reply (bulk, status, number).
    pub fn bytes(&self) -> Option<Vec<u8>> {
        match self {
            KvReply::Bulk(bytes) => Some(bytes.clone()),
            KvReply::Status(text) | KvReply::BigNumber(text) => Some(text.as_bytes().to_vec()),
            KvReply::Int(n) => Some(n.to_string().into_bytes()),
            KvReply::Double(f) => Some(f.to_string().into_bytes()),
            _ => None,
        }
    }

    /// A string-like reply as text (lossy for binary data).
    pub fn text(&self) -> Option<String> {
        match self {
            KvReply::Bulk(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
            KvReply::Status(text) | KvReply::BigNumber(text) => Some(text.clone()),
            KvReply::Int(n) => Some(n.to_string()),
            KvReply::Double(f) => Some(f.to_string()),
            _ => None,
        }
    }

    /// An integer reply, or a string holding one (RESP2 sends some numbers as strings).
    pub fn int(&self) -> Option<i64> {
        match self {
            KvReply::Int(n) => Some(*n),
            KvReply::Bulk(_) | KvReply::Status(_) => self.text()?.trim().parse().ok(),
            _ => None,
        }
    }

    /// A floating reply, or a string holding one (scores in RESP2).
    pub fn float(&self) -> Option<f64> {
        match self {
            KvReply::Double(f) => Some(*f),
            KvReply::Int(n) => Some(*n as f64),
            KvReply::Bulk(_) | KvReply::Status(_) => self.text()?.trim().parse().ok(),
            _ => None,
        }
    }

    /// The elements of an array or a set; `None` for anything else.
    pub fn items(&self) -> Option<&[KvReply]> {
        match self {
            KvReply::Array(items) | KvReply::Set(items) => Some(items),
            _ => None,
        }
    }

    pub fn into_items(self) -> Option<Vec<KvReply>> {
        match self {
            KvReply::Array(items) | KvReply::Set(items) => Some(items),
            _ => None,
        }
    }

    /// Field / value pairs of a map, or of a flat array of even length (RESP2 `HGETALL`).
    pub fn into_pairs(self) -> Option<Vec<(KvReply, KvReply)>> {
        match self {
            KvReply::Map(pairs) => Some(pairs),
            KvReply::Array(items) if items.len() % 2 == 0 => {
                let mut pairs = Vec::with_capacity(items.len() / 2);
                let mut iter = items.into_iter();
                while let (Some(k), Some(v)) = (iter.next(), iter.next()) {
                    pairs.push((k, v));
                }
                Some(pairs)
            }
            _ => None,
        }
    }

    /// Whether the reply is a scalar (not a collection).
    pub fn is_scalar(&self) -> bool {
        !matches!(self, KvReply::Array(_) | KvReply::Set(_) | KvReply::Map(_))
    }

    /// The reply as JSON, for the tree view: strings that are not UTF-8 are escaped the way
    /// `redis-cli` prints them, map keys become strings, errors `{"error": …}`. Collections
    /// past `budget` elements in total are cut, and the second value says so.
    pub fn to_json(&self, budget: usize) -> (serde_json::Value, bool) {
        let mut left = budget;
        let mut truncated = false;
        let value = json_of(self, &mut left, &mut truncated);
        (value, truncated)
    }
}

fn bulk_json(bytes: &[u8]) -> serde_json::Value {
    match std::str::from_utf8(bytes) {
        Ok(text) => serde_json::Value::String(text.to_owned()),
        Err(_) => serde_json::Value::String(escape(bytes)),
    }
}

fn json_of(reply: &KvReply, left: &mut usize, truncated: &mut bool) -> serde_json::Value {
    use serde_json::Value as J;
    match reply {
        KvReply::Nil => J::Null,
        KvReply::Int(n) => J::from(*n),
        KvReply::Double(f) => {
            serde_json::Number::from_f64(*f).map_or_else(|| J::String(f.to_string()), J::Number)
        }
        KvReply::Bool(b) => J::Bool(*b),
        KvReply::BigNumber(text) | KvReply::Status(text) => J::String(text.clone()),
        KvReply::Bulk(bytes) => bulk_json(bytes),
        KvReply::Error(message) => serde_json::json!({ "error": message }),
        KvReply::Array(items) | KvReply::Set(items) => {
            let mut out = Vec::new();
            for item in items {
                if *left == 0 {
                    *truncated = true;
                    break;
                }
                *left -= 1;
                out.push(json_of(item, left, truncated));
            }
            J::Array(out)
        }
        KvReply::Map(pairs) => {
            let mut out = serde_json::Map::new();
            for (key, value) in pairs {
                if *left == 0 {
                    *truncated = true;
                    break;
                }
                *left -= 1;
                let name = match key {
                    KvReply::Bulk(bytes) => match std::str::from_utf8(bytes) {
                        Ok(text) => text.to_owned(),
                        Err(_) => escape(bytes),
                    },
                    other => other.text().unwrap_or_else(|| {
                        let (json, _) = other.to_json(16);
                        json.to_string()
                    }),
                };
                out.insert(name, json_of(value, left, truncated));
            }
            J::Object(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_come_from_maps_and_flat_arrays() {
        let flat = KvReply::Array(vec![
            KvReply::Bulk(b"a".to_vec()),
            KvReply::Bulk(b"1".to_vec()),
            KvReply::Bulk(b"b".to_vec()),
            KvReply::Bulk(b"2".to_vec()),
        ]);
        let pairs = flat.into_pairs().expect("pairs");
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[1].1.int(), Some(2));
        assert!(KvReply::Array(vec![KvReply::Nil]).into_pairs().is_none());
    }

    #[test]
    fn json_cuts_long_collections() {
        let reply = KvReply::Array((0..10).map(KvReply::Int).collect());
        let (json, truncated) = reply.to_json(4);
        assert!(truncated);
        assert_eq!(json.as_array().map(Vec::len), Some(4));
        let map = KvReply::Map(vec![(KvReply::Bulk(vec![0xff]), KvReply::Nil)]);
        let (json, truncated) = map.to_json(10);
        assert!(!truncated);
        assert_eq!(json, serde_json::json!({ "\\xff": null }));
    }
}
