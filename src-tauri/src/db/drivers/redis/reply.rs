//! redis-rs replies into yadbe's [`KvReply`].

use redis::Value;

use crate::db::keyvalue::KvReply;

pub fn convert(value: Value) -> KvReply {
    match value {
        Value::Nil => KvReply::Nil,
        Value::Int(n) => KvReply::Int(n),
        Value::BulkString(bytes) => KvReply::Bulk(bytes),
        Value::Array(items) => KvReply::Array(items.into_iter().map(convert).collect()),
        Value::SimpleString(text) => KvReply::Status(text),
        Value::Okay => KvReply::Status("OK".to_owned()),
        Value::Map(pairs) => KvReply::Map(
            pairs
                .into_iter()
                .map(|(k, v)| (convert(k), convert(v)))
                .collect(),
        ),
        Value::Attribute { data, .. } => convert(*data),
        Value::Set(items) => KvReply::Set(items.into_iter().map(convert).collect()),
        Value::Double(f) => KvReply::Double(f),
        Value::Boolean(b) => KvReply::Bool(b),
        Value::VerbatimString { text, .. } => KvReply::Bulk(text.into_bytes()),
        Value::BigNumber(digits) => {
            KvReply::BigNumber(String::from_utf8_lossy(&digits).into_owned())
        }
        Value::Push { data, .. } => KvReply::Array(data.into_iter().map(convert).collect()),
        Value::ServerError(err) => KvReply::Error(match err.details() {
            Some(detail) => format!("{} {detail}", err.code()),
            None => err.code().to_owned(),
        }),
        // A variant a later redis-rs adds: shown as its debug text rather than lost.
        #[allow(unreachable_patterns)]
        other => KvReply::Status(format!("{other:?}")),
    }
}
