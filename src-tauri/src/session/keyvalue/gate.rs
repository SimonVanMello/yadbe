//! The command gate: the one function every key-value command passes through before the
//! driver, whoever sends it (the explorer, a key tab, the console).
//!
//! In order: what the server says of the command (`COMMAND INFO`, cached per session), the
//! commands yadbe cannot show yet (streaming, blocking), read-only from the session's live flag
//! (F-008: the server's `write` flag, scripts, unknown commands, admin commands), dangerous
//! commands not confirmed, then the command itself under the statement timeout, recorded in
//! the statement log (yadbe's own commands) or the history (the user's).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use crate::db::driver::{KeyValueConnection, RecordedStatement};
use crate::db::errors::{LocalizedText, YadbeError};
use crate::db::keyvalue::command::{is_secret_setting, quote};
use crate::db::keyvalue::spec::{
    CommandSpec, KvDanger, KvDangerKind, check_read_only, check_supported, danger_of,
};
use crate::db::keyvalue::{KvCommand, KvReply};
use crate::session::ConnectionSession;
use crate::session::history_hook::{HistoryEntry, HistoryRecorder};

/// `COMMAND INFO` answers of one session, by command name; `None`: the server does not know
/// the command (or would not say).
#[derive(Default)]
pub struct SpecCache {
    specs: Mutex<HashMap<String, Option<Arc<CommandSpec>>>>,
}

impl SpecCache {
    fn get(&self, name: &str) -> Option<Option<Arc<CommandSpec>>> {
        self.specs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(name)
            .cloned()
    }

    fn put(&self, name: String, spec: Option<Arc<CommandSpec>>) {
        self.specs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(name, spec);
    }
}

/// Who sent a command, and so where it is recorded.
pub enum Origin<'a> {
    /// yadbe on its own: the statement log.
    Yadbe,
    /// The user, from a console tab: the history.
    User(&'a UserContext),
    /// yadbe, recorded by the caller as one entry for many commands (a key scan).
    Batched,
}

/// Where a user command comes from, for its history entry.
pub struct UserContext {
    pub tab_id: String,
    pub connection_id: String,
    pub database: u32,
}

/// Commands of a batch written to its statement-log entry; the rest are counted.
pub const BATCH_LOG_LINES: usize = 200;

/// The gate of one session.
pub struct Gate<'a> {
    pub session: &'a ConnectionSession,
    pub specs: &'a SpecCache,
    pub history: &'a dyn HistoryRecorder,
}

fn rows_of(reply: &KvReply) -> Option<u64> {
    match reply {
        KvReply::Map(pairs) => Some(pairs.len() as u64),
        _ => reply.items().map(|items| items.len() as u64),
    }
}

pub fn confirmation_missing(cmd: &KvCommand) -> YadbeError {
    YadbeError::invalid_argument(
        format!(
            "{} needs a confirmation of its effect before it runs. Nothing was run.",
            cmd.name().to_ascii_uppercase()
        ),
        format!(
            "{} doit être confirmée avec son effet avant de s'exécuter. Rien n'a été exécuté.",
            cmd.name().to_ascii_uppercase()
        ),
    )
}

impl Gate<'_> {
    /// What the server says of the command named `name` (lower case), asked once per session.
    pub async fn spec(
        &self,
        conn: &dyn KeyValueConnection,
        name: &str,
    ) -> Option<Arc<CommandSpec>> {
        if let Some(known) = self.specs.get(name) {
            return known;
        }
        let args = vec![
            b"COMMAND".to_vec(),
            b"INFO".to_vec(),
            name.as_bytes().to_vec(),
        ];
        let started_at = SystemTime::now();
        let start = Instant::now();
        let result = conn.send(&args).await;
        self.session.recorder().record(RecordedStatement {
            sql: format!("COMMAND INFO {name}"),
            started_at,
            duration: start.elapsed(),
            outcome: result.as_ref().map(|_| None).map_err(Clone::clone),
        });
        // A link failure says nothing about the command: it is asked again next time.
        let cacheable =
            !matches!(&result, Err(err) if err.code != crate::db::errors::ErrorCode::QueryFailed);
        let spec = match result {
            Ok(reply) => reply
                .items()
                .and_then(|items| items.first())
                .and_then(CommandSpec::parse)
                .map(Arc::new),
            // A server that refuses `COMMAND` (ACL) gives no spec: read-only refuses then.
            Err(err) => {
                tracing::debug!(command = name, error = %err, "COMMAND INFO failed");
                None
            }
        };
        if cacheable {
            self.specs.put(name.to_owned(), spec.clone());
        }
        spec
    }

    /// Whether `cmd` may run now: supported, allowed by read-only, confirmed if dangerous.
    pub async fn check(
        &self,
        conn: &dyn KeyValueConnection,
        cmd: &KvCommand,
        confirmed: bool,
    ) -> Result<(), YadbeError> {
        let name = cmd.name();
        let spec = if name.is_empty() {
            None
        } else {
            self.spec(conn, &name).await
        };
        check_supported(cmd, spec.as_deref())?;
        if self.session.read_only() {
            check_read_only(cmd, spec.as_deref())?;
        }
        if !confirmed && danger_of(cmd).is_some() {
            return Err(confirmation_missing(cmd));
        }
        Ok(())
    }

    /// Sends a command under the session's statement timeout (F-014). A command cannot be
    /// stopped on the server: past the limit the caller stops waiting for it.
    async fn send_timed(
        &self,
        conn: &dyn KeyValueConnection,
        args: &[Vec<u8>],
    ) -> Result<KvReply, YadbeError> {
        match self.session.statement_timeout() {
            Some(limit) => match tokio::time::timeout(limit, conn.send(args)).await {
                Ok(result) => result,
                Err(_) => Err(YadbeError::statement_timeout(limit.as_secs().max(1))),
            },
            None => conn.send(args).await,
        }
    }

    fn record(
        &self,
        cmd: &KvCommand,
        origin: &Origin<'_>,
        started_at: SystemTime,
        duration: Duration,
        result: &Result<KvReply, YadbeError>,
    ) {
        match origin {
            Origin::Yadbe => self.session.recorder().record(RecordedStatement {
                sql: cmd.display_short(4096),
                started_at,
                duration,
                outcome: result.as_ref().map(rows_of).map_err(Clone::clone),
            }),
            Origin::User(user) => self.history.record(HistoryEntry {
                tab_id: user.tab_id.clone(),
                connection_id: user.connection_id.clone(),
                database: Some(user.database.to_string()),
                sql: cmd.display(),
                started_at,
                duration,
                rows: result.as_ref().ok().and_then(rows_of),
                outcome: result.as_ref().map(|_| ()).map_err(Clone::clone),
            }),
            Origin::Batched => {}
        }
    }

    /// Runs one command through the gate.
    pub async fn run(
        &self,
        conn: &dyn KeyValueConnection,
        cmd: &KvCommand,
        origin: Origin<'_>,
        confirmed: bool,
    ) -> Result<KvReply, YadbeError> {
        let started_at = SystemTime::now();
        let start = Instant::now();
        let result = match self.check(conn, cmd, confirmed).await {
            Ok(()) => self.send_timed(conn, &cmd.args).await,
            Err(refused) => Err(refused),
        };
        self.record(cmd, &origin, started_at, start.elapsed(), &result);
        result
    }

    /// Runs yadbe's own commands in one round trip, each checked by the gate; recorded as
    /// one statement-log entry (one line per command) so that reading the rows on screen does
    /// not flood the log.
    pub async fn run_all(
        &self,
        conn: &dyn KeyValueConnection,
        cmds: &[KvCommand],
    ) -> Vec<Result<KvReply, YadbeError>> {
        if cmds.is_empty() {
            return Vec::new();
        }
        let started_at = SystemTime::now();
        let start = Instant::now();
        let mut checked = Vec::with_capacity(cmds.len());
        let mut refusals = Vec::with_capacity(cmds.len());
        for cmd in cmds {
            match self.check(conn, cmd, false).await {
                Ok(()) => {
                    checked.push(cmd.args.clone());
                    refusals.push(None);
                }
                Err(err) => refusals.push(Some(err)),
            }
        }
        let sent = match self.session.statement_timeout() {
            Some(limit) => tokio::time::timeout(limit, conn.send_all(&checked))
                .await
                .unwrap_or_else(|_| {
                    let err = YadbeError::statement_timeout(limit.as_secs().max(1));
                    checked.iter().map(|_| Err(err.clone())).collect()
                }),
            None => conn.send_all(&checked).await,
        };
        let mut sent = sent.into_iter();
        let results: Vec<Result<KvReply, YadbeError>> = refusals
            .into_iter()
            .map(|refusal| match refusal {
                Some(err) => Err(err),
                None => sent
                    .next()
                    .unwrap_or_else(|| Err(YadbeError::internal("pipeline reply missing"))),
            })
            .collect();
        let text = cmds
            .iter()
            .map(|cmd| cmd.display_short(512))
            .collect::<Vec<_>>()
            .join("\n");
        let first_error = results.iter().find_map(|r| r.as_ref().err()).cloned();
        self.session.recorder().record(RecordedStatement {
            sql: text,
            started_at,
            duration: start.elapsed(),
            outcome: match first_error {
                Some(err) => Err(err),
                None => Ok(Some(cmds.len() as u64)),
            },
        });
        results
    }

    /// Runs yadbe's own commands in one round trip, all or none: every command is checked
    /// first and a single refusal sends nothing (an edit's `MULTI` … `EXEC` must never go out
    /// with a command missing). One statement-log entry, its text cut after
    /// [`BATCH_LOG_LINES`] commands. `Err` only for a refusal or the statement timeout (the
    /// connection's state is then unknown); a failing command is its own `Err` in the list.
    pub async fn run_batch(
        &self,
        conn: &dyn KeyValueConnection,
        cmds: &[KvCommand],
        confirmed: bool,
    ) -> Result<Vec<Result<KvReply, YadbeError>>, YadbeError> {
        if cmds.is_empty() {
            return Ok(Vec::new());
        }
        let started_at = SystemTime::now();
        let start = Instant::now();
        let mut checked = None;
        for cmd in cmds {
            if let Err(refused) = self.check(conn, cmd, confirmed).await {
                checked = Some(refused);
                break;
            }
        }
        let result = match checked {
            Some(refused) => Err(refused),
            None => {
                let args: Vec<Vec<Vec<u8>>> = cmds.iter().map(|c| c.args.clone()).collect();
                match self.session.statement_timeout() {
                    Some(limit) => tokio::time::timeout(limit, conn.send_all(&args))
                        .await
                        .map_err(|_| YadbeError::statement_timeout(limit.as_secs().max(1))),
                    None => Ok(conn.send_all(&args).await),
                }
            }
        };
        let mut text: Vec<String> = cmds
            .iter()
            .take(BATCH_LOG_LINES)
            .map(crate::db::keyvalue::edit::shown_command)
            .collect();
        if cmds.len() > BATCH_LOG_LINES {
            text.push(format!("… {} more", cmds.len() - BATCH_LOG_LINES));
        }
        let outcome = match &result {
            Err(err) => Err(err.clone()),
            Ok(replies) => match replies.iter().find_map(|r| r.as_ref().err()) {
                Some(err) => Err(err.clone()),
                None => Ok(Some(cmds.len() as u64)),
            },
        };
        self.session.recorder().record(RecordedStatement {
            sql: text.join("\n"),
            started_at,
            duration: start.elapsed(),
            outcome,
        });
        result
    }

    /// Records many commands yadbe ran as one statement-log entry (`Origin::Batched`).
    pub fn log_batch(
        &self,
        text: String,
        started_at: SystemTime,
        duration: Duration,
        outcome: Result<Option<u64>, YadbeError>,
    ) {
        self.session.recorder().record(RecordedStatement {
            sql: text,
            started_at,
            duration,
            outcome,
        });
    }

    /// The dangerous commands among `lines` and their concrete effect, measured on the server
    /// where it can be (key counts, the current value of a setting). Read-only probes, each
    /// recorded in the statement log.
    pub async fn dangers(
        &self,
        conn: &dyn KeyValueConnection,
        database: u32,
        lines: &[(u32, KvCommand)],
    ) -> Vec<KvDanger> {
        let mut found = Vec::new();
        for (line, cmd) in lines {
            let Some(kind) = danger_of(cmd) else { continue };
            // What the gate refuses anyway (read-only, unsupported) needs no confirmation.
            if self.check(conn, cmd, true).await.is_err() {
                continue;
            }
            let effect = self.effect(conn, database, cmd, &kind).await;
            found.push(KvDanger {
                line: *line,
                command: cmd.display_short(512),
                kind,
                effect,
            });
        }
        found
    }

    async fn probe(&self, conn: &dyn KeyValueConnection, cmd: KvCommand) -> Option<KvReply> {
        self.run(conn, &cmd, Origin::Yadbe, false).await.ok()
    }

    async fn effect(
        &self,
        conn: &dyn KeyValueConnection,
        database: u32,
        cmd: &KvCommand,
        kind: &KvDangerKind,
    ) -> LocalizedText {
        let count = |n: Option<u64>| n.map_or_else(|| "?".to_owned(), |n| n.to_string());
        match kind {
            KvDangerKind::FlushAll => {
                let keys = self
                    .probe(conn, KvCommand::of(["INFO", "keyspace"]))
                    .await
                    .and_then(|r| r.text())
                    .map(|text| parse_keyspace(&text).iter().map(|db| db.1).sum());
                LocalizedText::new(
                    format!(
                        "Deletes every key of every database on this server: {} keys.",
                        count(keys)
                    ),
                    format!(
                        "Supprime toutes les clés de toutes les bases de ce serveur : {} clés.",
                        count(keys)
                    ),
                )
            }
            KvDangerKind::FlushDb => {
                let keys = self.dbsize(conn).await;
                LocalizedText::new(
                    format!(
                        "Deletes every key of database {database}: {} keys.",
                        count(keys)
                    ),
                    format!(
                        "Supprime toutes les clés de la base {database} : {} clés.",
                        count(keys)
                    ),
                )
            }
            KvDangerKind::Keys => {
                let keys = self.dbsize(conn).await;
                LocalizedText::new(
                    format!(
                        "Walks all {} keys of database {database} in one go and blocks the server meanwhile. The explorer lists keys with SCAN instead.",
                        count(keys)
                    ),
                    format!(
                        "Parcourt d'un coup les {} clés de la base {database} et bloque le serveur pendant ce temps. L'explorateur liste les clés avec SCAN à la place.",
                        count(keys)
                    ),
                )
            }
            KvDangerKind::DeleteMany { keys } => {
                let mut exists = vec![b"EXISTS".to_vec()];
                exists.extend(cmd.args.iter().skip(1).cloned());
                let existing = self
                    .probe(conn, KvCommand::new(exists))
                    .await
                    .and_then(|r| r.int())
                    .and_then(|n| u64::try_from(n).ok());
                LocalizedText::new(
                    format!(
                        "Deletes {keys} keys; {} of them exist now.",
                        count(existing)
                    ),
                    format!(
                        "Supprime {keys} clés ; {} d'entre elles existent actuellement.",
                        count(existing)
                    ),
                )
            }
            KvDangerKind::Config => self.config_effect(conn, cmd).await,
            KvDangerKind::Shutdown => LocalizedText::new(
                "Stops the server: every client is disconnected.",
                "Arrête le serveur : tous les clients sont déconnectés.",
            ),
            KvDangerKind::Debug => LocalizedText::new(
                "A debugging command: it can crash, block or corrupt the server.",
                "Une commande de débogage : elle peut planter, bloquer ou corrompre le serveur.",
            ),
            KvDangerKind::SwapDb { a, b } => {
                let space = self
                    .probe(conn, KvCommand::of(["INFO", "keyspace"]))
                    .await
                    .and_then(|r| r.text())
                    .map(|text| parse_keyspace(&text))
                    .unwrap_or_default();
                let keys_of = |db: &str| {
                    let index = db.parse::<u32>().ok();
                    space
                        .iter()
                        .find(|(i, _, _)| Some(*i) == index)
                        .map_or(0, |(_, keys, _)| *keys)
                };
                LocalizedText::new(
                    format!(
                        "Swaps database {a} ({} keys) with database {b} ({} keys) for every client.",
                        keys_of(a),
                        keys_of(b)
                    ),
                    format!(
                        "Échange la base {a} ({} clés) avec la base {b} ({} clés) pour tous les clients.",
                        keys_of(a),
                        keys_of(b)
                    ),
                )
            }
            KvDangerKind::FlushScripts => LocalizedText::new(
                "Deletes cached scripts or library functions of the server.",
                "Supprime des scripts en cache ou des fonctions de bibliothèque du serveur.",
            ),
            KvDangerKind::ClientKill => LocalizedText::new(
                "Disconnects other clients of the server.",
                "Déconnecte d'autres clients du serveur.",
            ),
            KvDangerKind::ReplicaOf => LocalizedText::new(
                "Changes the server's replication: as a replica, its data is replaced by the primary's.",
                "Modifie la réplication du serveur : en réplique, ses données sont remplacées par celles du primaire.",
            ),
        }
    }

    async fn dbsize(&self, conn: &dyn KeyValueConnection) -> Option<u64> {
        self.probe(conn, KvCommand::of(["DBSIZE"]))
            .await
            .and_then(|r| r.int())
            .and_then(|n| u64::try_from(n).ok())
    }

    async fn config_effect(&self, conn: &dyn KeyValueConnection, cmd: &KvCommand) -> LocalizedText {
        match cmd.arg_lower(1).as_deref() {
            Some("set") => {
                let mut en = Vec::new();
                let mut fr = Vec::new();
                let mut i = 2;
                while i + 1 < cmd.args.len() {
                    let name = String::from_utf8_lossy(&cmd.args[i]).into_owned();
                    let secret = is_secret_setting(&name);
                    let shown = if secret {
                        "***".to_owned()
                    } else {
                        quote(&cmd.args[i + 1])
                    };
                    let old = if secret {
                        "***".to_owned()
                    } else {
                        self.probe(
                            conn,
                            KvCommand::new(vec![
                                b"CONFIG".to_vec(),
                                b"GET".to_vec(),
                                cmd.args[i].clone(),
                            ]),
                        )
                        .await
                        .and_then(KvReply::into_pairs)
                        .and_then(|pairs| pairs.into_iter().next())
                        .and_then(|(_, v)| v.bytes())
                        .map_or_else(|| "?".to_owned(), |v| quote(&v))
                    };
                    en.push(format!("{name}: {old} → {shown}"));
                    fr.push(format!("{name} : {old} → {shown}"));
                    i += 2;
                }
                LocalizedText::new(
                    format!(
                        "Changes server settings for every client: {}.",
                        en.join(", ")
                    ),
                    format!(
                        "Modifie des réglages du serveur pour tous les clients : {}.",
                        fr.join(", ")
                    ),
                )
            }
            Some("resetstat") => LocalizedText::new(
                "Resets the server's statistics (INFO, slow log, latency).",
                "Remet à zéro les statistiques du serveur (INFO, journal des requêtes lentes, latence).",
            ),
            _ => LocalizedText::new(
                "Rewrites the server's configuration file.",
                "Réécrit le fichier de configuration du serveur.",
            ),
        }
    }
}

/// `INFO keyspace` lines (`db0:keys=12,expires=1,avg_ttl=0`) as `(index, keys, expires)`.
pub fn parse_keyspace(info: &str) -> Vec<(u32, u64, u64)> {
    let mut out = Vec::new();
    for line in info.lines() {
        let Some((db, fields)) = line.trim().split_once(':') else {
            continue;
        };
        let Some(index) = db.strip_prefix("db").and_then(|i| i.parse::<u32>().ok()) else {
            continue;
        };
        let field = |name: &str| {
            fields
                .split(',')
                .find_map(|pair| pair.strip_prefix(name)?.strip_prefix('='))
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0)
        };
        out.push((index, field("keys"), field("expires")));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_keyspace_section() {
        let info = "# Keyspace\r\ndb0:keys=12,expires=1,avg_ttl=0,subexpiry=0\r\ndb3:keys=4,expires=0,avg_ttl=0\r\n";
        assert_eq!(parse_keyspace(info), vec![(0, 12, 1), (3, 4, 0)]);
        assert!(parse_keyspace("# Keyspace\r\n").is_empty());
    }
}
