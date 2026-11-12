//! What a key tab reads: the key's header, windows of a string, a RedisJSON document, and
//! collections paged into the result store (`HSCAN`, `SSCAN`, `ZRANGE` by rank, `LRANGE`,
//! `XRANGE`), which the grid reads by windows like any result (rule 8).

use std::collections::HashSet;
use std::sync::Arc;

use crate::db::errors::{ErrorCode, YadbeError};
use crate::db::keyvalue::bytes::encode;
use crate::db::keyvalue::{KvBytes, KvCommand, KvReply};
use crate::db::value::{ColumnMeta, Value, ValueKind};
use crate::session::keyvalue::Pool;
use crate::session::keyvalue::model::{KvCollection, KvKeyInfo, KvKeyKind, KvStringChunk};
use crate::session::result_store::{ResultStore, StoredResult};

/// Largest string window one call reads.
pub const MAX_STRING_CHUNK: u32 = 1024 * 1024;
/// Largest RedisJSON document shown whole (its `MEMORY USAGE`).
pub const MAX_JSON_BYTES: i64 = 32 * 1024 * 1024;
/// Elements asked of the server per page of a collection.
const PAGE: usize = 500;

/// `PTTL`: `-1` no expiry, `-2` no key; otherwise milliseconds left.
pub fn ttl_of(pttl: Option<i64>) -> Option<f64> {
    pttl.filter(|ms| *ms >= 0).map(|ms| ms as f64)
}

/// A cell of any bytes: text when it is UTF-8, else hexadecimal bytes.
pub fn bytes_value(bytes: &[u8]) -> Value {
    match std::str::from_utf8(bytes) {
        Ok(text) => Value::Text(text.to_owned()),
        Err(_) => Value::bytes(bytes),
    }
}

fn column(name: &str, kind: ValueKind) -> ColumnMeta {
    ColumnMeta {
        name: name.to_owned(),
        type_name: String::new(),
        kind,
    }
}

fn length_command(kind: KvKeyKind) -> Option<&'static str> {
    match kind {
        KvKeyKind::String => Some("STRLEN"),
        KvKeyKind::Hash => Some("HLEN"),
        KvKeyKind::List => Some("LLEN"),
        KvKeyKind::Set => Some("SCARD"),
        KvKeyKind::Zset => Some("ZCARD"),
        KvKeyKind::Stream => Some("XLEN"),
        _ => None,
    }
}

pub async fn key_info(pool: &Pool, db: u32, key: &KvBytes) -> Result<KvKeyInfo, YadbeError> {
    let raw = key.to_bytes()?;
    let k = raw.as_slice();
    let replies = pool
        .run_all(
            db,
            &[
                KvCommand::of([b"TYPE".as_slice(), k]),
                KvCommand::of([b"PTTL".as_slice(), k]),
                KvCommand::of([b"OBJECT".as_slice(), b"ENCODING", k]),
                KvCommand::of([b"MEMORY".as_slice(), b"USAGE", k]),
            ],
        )
        .await?;
    let mut replies = replies.into_iter();
    let type_name = replies
        .next()
        .unwrap_or_else(|| Err(YadbeError::internal("TYPE reply missing")))?
        .text()
        .unwrap_or_default();
    let ttl = replies.next().and_then(Result::ok).and_then(|r| r.int());
    let encoding = replies.next().and_then(Result::ok).and_then(|r| r.text());
    let memory = replies.next().and_then(Result::ok).and_then(|r| r.int());
    let conn = pool.conn(db).await?;
    let json_module = pool
        .gate(&crate::session::history_hook::NoHistory)
        .spec(&*conn, "json.get")
        .await
        .is_some();
    let mut kind = KvKeyKind::of_type(&type_name);
    if kind == KvKeyKind::Json && !json_module {
        kind = KvKeyKind::Unknown;
    }
    let length = match length_command(kind) {
        Some(command) => pool
            .run(db, &KvCommand::of([command.as_bytes(), k]))
            .await
            .ok()
            .and_then(|r| r.int())
            .and_then(|n| u32::try_from(n).ok()),
        None => None,
    };
    Ok(KvKeyInfo {
        key: key.clone(),
        database: db,
        kind,
        type_name,
        ttl_ms: ttl_of(ttl),
        encoding,
        memory: memory.filter(|m| *m >= 0).map(|m| m as f64),
        length,
        json_module,
    })
}

pub async fn read_string(
    pool: &Pool,
    db: u32,
    key: &KvBytes,
    offset: u64,
    length: u32,
) -> Result<KvStringChunk, YadbeError> {
    let raw = key.to_bytes()?;
    let length = u64::from(length.clamp(1, MAX_STRING_CHUNK));
    let end = offset.saturating_add(length) - 1;
    let replies = pool
        .run_all(
            db,
            &[
                KvCommand::of([b"STRLEN".as_slice(), &raw]),
                KvCommand::new(vec![
                    b"GETRANGE".to_vec(),
                    raw.clone(),
                    offset.to_string().into_bytes(),
                    end.to_string().into_bytes(),
                ]),
            ],
        )
        .await?;
    let mut replies = replies.into_iter();
    let total = replies
        .next()
        .unwrap_or_else(|| Err(YadbeError::internal("STRLEN reply missing")))?
        .int()
        .unwrap_or(0);
    let bytes = replies
        .next()
        .unwrap_or_else(|| Err(YadbeError::internal("GETRANGE reply missing")))?
        .bytes()
        .unwrap_or_default();
    Ok(KvStringChunk {
        total: u32::try_from(total).unwrap_or(u32::MAX),
        offset: u32::try_from(offset).unwrap_or(u32::MAX),
        base64: encode(&bytes),
    })
}

pub async fn read_json(pool: &Pool, db: u32, key: &KvBytes) -> Result<String, YadbeError> {
    let raw = key.to_bytes()?;
    let memory = pool
        .run(db, &KvCommand::of([b"MEMORY".as_slice(), b"USAGE", &raw]))
        .await
        .ok()
        .and_then(|r| r.int());
    if memory.is_some_and(|m| m > MAX_JSON_BYTES) {
        return Err(YadbeError::new(
            ErrorCode::NotSupported,
            "This JSON document is too large to show whole (over 32 MB).",
            "Ce document JSON est trop volumineux pour être affiché en entier (plus de 32 Mo).",
        ));
    }
    pool.run(db, &KvCommand::of([b"JSON.GET".as_slice(), &raw]))
        .await?
        .text()
        .ok_or_else(|| YadbeError::internal("unexpected JSON.GET reply"))
}

/// Where the next page of a collection starts.
enum Cursor {
    /// `HSCAN` / `SSCAN` cursor; `None` before the first call.
    Scan(Option<u64>),
    /// Rank or index of the next element (`ZRANGE`, `LRANGE`).
    Index(u64),
    /// The last stream entry read; `None` before the first.
    Stream(Option<Vec<u8>>),
}

/// A collection being read into a result.
pub struct Collection {
    pool: Arc<Pool>,
    db: u32,
    key: Vec<u8>,
    kind: KvKeyKind,
    cursor: Cursor,
    result: Arc<StoredResult>,
    done: bool,
    total: Option<u64>,
    /// Fields or members already read: `HSCAN` and `SSCAN` may return one twice.
    seen: HashSet<Vec<u8>>,
}

impl Collection {
    pub async fn open(
        pool: Arc<Pool>,
        store: &ResultStore,
        db: u32,
        key: Vec<u8>,
    ) -> Result<Self, YadbeError> {
        let type_name = pool
            .run(db, &KvCommand::of([b"TYPE".as_slice(), &key]))
            .await?
            .text()
            .unwrap_or_default();
        let kind = KvKeyKind::of_type(&type_name);
        let (columns, cursor) = match kind {
            KvKeyKind::Hash => (
                vec![
                    column("field", ValueKind::Text),
                    column("value", ValueKind::Text),
                ],
                Cursor::Scan(None),
            ),
            KvKeyKind::Set => (vec![column("member", ValueKind::Text)], Cursor::Scan(None)),
            KvKeyKind::Zset => (
                vec![
                    column("rank", ValueKind::Int),
                    column("member", ValueKind::Text),
                    column("score", ValueKind::Float),
                ],
                Cursor::Index(0),
            ),
            KvKeyKind::List => (
                vec![
                    column("index", ValueKind::Int),
                    column("value", ValueKind::Text),
                ],
                Cursor::Index(0),
            ),
            KvKeyKind::Stream => (
                vec![
                    column("id", ValueKind::Text),
                    column("fields", ValueKind::Json),
                ],
                Cursor::Stream(None),
            ),
            _ => {
                return Err(YadbeError::invalid_argument(
                    format!("The key is a {type_name}, not a collection."),
                    format!("La clé est de type {type_name}, pas une collection."),
                ));
            }
        };
        let total = match length_command(kind) {
            Some(command) => pool
                .run(db, &KvCommand::of([command.as_bytes(), &key]))
                .await
                .ok()
                .and_then(|r| r.int())
                .and_then(|n| u64::try_from(n).ok()),
            None => None,
        };
        Ok(Self {
            pool,
            db,
            key,
            kind,
            cursor,
            result: store.create(columns),
            done: false,
            total,
            seen: HashSet::new(),
        })
    }

    pub fn summary(&self) -> KvCollection {
        KvCollection {
            result_id: self.result.id(),
            columns: self.result.columns().to_vec(),
            row_count: u32::try_from(self.result.row_count()).unwrap_or(u32::MAX),
            done: self.done,
            total: self.total.and_then(|n| u32::try_from(n).ok()),
        }
    }

    /// Reads pages until `wanted` more rows are in, or the collection is exhausted.
    pub async fn fill(&mut self, wanted: usize) -> Result<(), YadbeError> {
        let mut added = 0;
        while !self.done && added < wanted {
            let rows = self.page().await?;
            added += rows.len();
            if !rows.is_empty() {
                self.result.append(rows);
            }
        }
        Ok(())
    }

    async fn page(&mut self) -> Result<Vec<Vec<Value>>, YadbeError> {
        let key = self.key.clone();
        let count = PAGE.to_string().into_bytes();
        match &mut self.cursor {
            Cursor::Scan(cursor) => {
                let command: &[u8] = if self.kind == KvKeyKind::Hash {
                    b"HSCAN"
                } else {
                    b"SSCAN"
                };
                let at = cursor.unwrap_or(0).to_string().into_bytes();
                let reply = self
                    .pool
                    .run(
                        self.db,
                        &KvCommand::new(vec![command.to_vec(), key, at, b"COUNT".to_vec(), count]),
                    )
                    .await?;
                let malformed = || YadbeError::internal("unexpected SCAN reply");
                let mut items = reply.into_items().ok_or_else(malformed)?.into_iter();
                let next = items
                    .next()
                    .and_then(|c| c.text())
                    .and_then(|c| c.parse::<u64>().ok())
                    .ok_or_else(malformed)?;
                let elements = items.next().ok_or_else(malformed)?;
                *cursor = Some(next);
                if next == 0 {
                    self.done = true;
                }
                let mut rows = Vec::new();
                if self.kind == KvKeyKind::Hash {
                    for (field, value) in elements.into_pairs().ok_or_else(malformed)? {
                        let field = field.bytes().unwrap_or_default();
                        if self.seen.insert(field.clone()) {
                            rows.push(vec![
                                bytes_value(&field),
                                bytes_value(&value.bytes().unwrap_or_default()),
                            ]);
                        }
                    }
                } else {
                    for member in elements.into_items().ok_or_else(malformed)? {
                        let member = member.bytes().unwrap_or_default();
                        if self.seen.insert(member.clone()) {
                            rows.push(vec![bytes_value(&member)]);
                        }
                    }
                }
                Ok(rows)
            }
            Cursor::Index(next) => {
                let start = *next;
                let stop = start + PAGE as u64 - 1;
                let mut args = vec![
                    if self.kind == KvKeyKind::Zset {
                        b"ZRANGE".to_vec()
                    } else {
                        b"LRANGE".to_vec()
                    },
                    key,
                    start.to_string().into_bytes(),
                    stop.to_string().into_bytes(),
                ];
                if self.kind == KvKeyKind::Zset {
                    args.push(b"WITHSCORES".to_vec());
                }
                let reply = self.pool.run(self.db, &KvCommand::new(args)).await?;
                let items = reply
                    .into_items()
                    .ok_or_else(|| YadbeError::internal("unexpected range reply"))?;
                let rows: Vec<Vec<Value>> = if self.kind == KvKeyKind::Zset {
                    zset_pairs(items)
                        .into_iter()
                        .enumerate()
                        .map(|(i, (member, score))| {
                            vec![
                                Value::int(start + i as u64),
                                bytes_value(&member.bytes().unwrap_or_default()),
                                score.float().map_or(Value::Null, Value::float),
                            ]
                        })
                        .collect()
                } else {
                    items
                        .into_iter()
                        .enumerate()
                        .map(|(i, item)| {
                            vec![
                                Value::int(start + i as u64),
                                bytes_value(&item.bytes().unwrap_or_default()),
                            ]
                        })
                        .collect()
                };
                *next = start + rows.len() as u64;
                if rows.len() < PAGE {
                    self.done = true;
                }
                Ok(rows)
            }
            Cursor::Stream(last) => {
                let start = match last {
                    Some(id) => {
                        let mut exclusive = b"(".to_vec();
                        exclusive.extend_from_slice(id);
                        exclusive
                    }
                    None => b"-".to_vec(),
                };
                let reply = self
                    .pool
                    .run(
                        self.db,
                        &KvCommand::new(vec![
                            b"XRANGE".to_vec(),
                            key,
                            start,
                            b"+".to_vec(),
                            b"COUNT".to_vec(),
                            count,
                        ]),
                    )
                    .await?;
                let entries = reply
                    .into_items()
                    .ok_or_else(|| YadbeError::internal("unexpected XRANGE reply"))?;
                let mut rows = Vec::with_capacity(entries.len());
                for entry in entries {
                    let mut parts = entry.into_items().unwrap_or_default().into_iter();
                    let id = parts.next().and_then(|i| i.bytes()).unwrap_or_default();
                    let fields = parts.next().map_or(KvReply::Map(Vec::new()), |f| {
                        f.into_pairs().map_or(KvReply::Nil, KvReply::Map)
                    });
                    let (json, _) = fields.to_json(usize::MAX);
                    *last = Some(id.clone());
                    rows.push(vec![bytes_value(&id), Value::Json(json.to_string())]);
                }
                if rows.len() < PAGE {
                    self.done = true;
                }
                Ok(rows)
            }
        }
    }
}

/// `ZRANGE … WITHSCORES` pairs: RESP3 sends `[member, score]` arrays, RESP2 a flat list.
fn zset_pairs(items: Vec<KvReply>) -> Vec<(KvReply, KvReply)> {
    if items.first().is_some_and(|i| i.items().is_some()) {
        items
            .into_iter()
            .filter_map(|pair| {
                let mut parts = pair.into_items()?.into_iter();
                Some((parts.next()?, parts.next()?))
            })
            .collect()
    } else {
        KvReply::Array(items).into_pairs().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scores_come_in_both_protocols() {
        let resp3 = vec![KvReply::Array(vec![
            KvReply::Bulk(b"a".to_vec()),
            KvReply::Double(1.5),
        ])];
        let resp2 = vec![KvReply::Bulk(b"a".to_vec()), KvReply::Bulk(b"1.5".to_vec())];
        for items in [resp3, resp2] {
            let pairs = zset_pairs(items);
            assert_eq!(pairs.len(), 1);
            assert_eq!(pairs[0].1.float(), Some(1.5));
        }
    }

    #[test]
    fn binary_cells_are_bytes() {
        assert_eq!(bytes_value(b"hi"), Value::Text("hi".into()));
        assert_eq!(bytes_value(&[0xff]), Value::Bytes("ff".into()));
        assert_eq!(ttl_of(Some(-1)), None);
        assert_eq!(ttl_of(Some(1500)), Some(1500.0));
    }
}
