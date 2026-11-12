//! What the server says of a command (`COMMAND INFO`: arity, flags, ACL categories,
//! subcommands) and the command gate's verdict built on it. The server is the authority on
//! what writes: yadbe keeps no list of write commands, only the few rules the flags cannot
//! express (scripts, publishing, the admin commands that only read, what yadbe cannot show).

use serde::Serialize;
use specta::Type;

use super::command::KvCommand;
use super::reply::KvReply;
use crate::db::errors::{ErrorCode, LocalizedText, YadbeError};

/// One command (or subcommand: `config|get`) as `COMMAND INFO` describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    /// Lower case; `container|sub` for a subcommand.
    pub name: String,
    pub arity: i64,
    pub flags: Vec<String>,
    /// ACL categories without the `@` (`read`, `admin`, `dangerous`…).
    pub categories: Vec<String>,
    pub subcommands: Vec<CommandSpec>,
}

fn text_list(reply: Option<&KvReply>) -> Vec<String> {
    reply
        .and_then(KvReply::items)
        .map(|items| {
            items
                .iter()
                .filter_map(KvReply::text)
                .map(|t| t.trim_start_matches('@').to_ascii_lowercase())
                .collect()
        })
        .unwrap_or_default()
}

impl CommandSpec {
    /// One entry of a `COMMAND INFO` reply; `None` for a nil entry (unknown command).
    pub fn parse(reply: &KvReply) -> Option<CommandSpec> {
        let items = reply.items()?;
        let name = items.first()?.text()?.to_ascii_lowercase();
        let arity = items.get(1).and_then(KvReply::int).unwrap_or(0);
        let flags = text_list(items.get(2));
        let categories = text_list(items.get(6));
        let subcommands = items
            .get(9)
            .and_then(KvReply::items)
            .map(|subs| subs.iter().filter_map(CommandSpec::parse).collect())
            .unwrap_or_default();
        Some(CommandSpec {
            name,
            arity,
            flags,
            categories,
            subcommands,
        })
    }

    pub fn has_flag(&self, flag: &str) -> bool {
        self.flags.iter().any(|f| f == flag)
    }

    pub fn in_category(&self, category: &str) -> bool {
        self.categories.iter().any(|c| c == category)
    }

    /// The spec that applies to `cmd`: its subcommand's when the server lists them
    /// (`CONFIG SET` → `config|set`), else this one.
    pub fn resolve<'a>(&'a self, cmd: &KvCommand) -> &'a CommandSpec {
        if self.subcommands.is_empty() {
            return self;
        }
        let Some(sub) = cmd.arg_lower(1) else {
            return self;
        };
        let full = format!("{}|{sub}", self.name);
        self.subcommands
            .iter()
            .find(|s| s.name == full)
            .unwrap_or(self)
    }
}

/// Scripts and functions: what they do cannot be known before they run.
const SCRIPT_COMMANDS: &[&str] = &[
    "eval",
    "evalsha",
    "eval_ro",
    "evalsha_ro",
    "fcall",
    "fcall_ro",
    "script",
    "function",
];

/// Sends a message to other clients: a side effect the flags do not call a write.
const PUBLISH_COMMANDS: &[&str] = &["publish", "spublish"];

/// Admin (sub)commands that only read: allowed on a read-only connection.
const ADMIN_READS: &[&str] = &[
    "config|get",
    "slowlog|get",
    "slowlog|len",
    "client|list",
    "client|info",
    "acl|list",
    "acl|users",
    "acl|getuser",
    "acl|log",
    "latency|latest",
    "latency|history",
    "latency|doctor",
    "latency|graph",
    "latency|histogram",
    "memory|stats",
    "memory|doctor",
    "module|list",
    "lastsave",
];

/// Commands that turn the connection into a stream the console cannot show yet.
const STREAMING_COMMANDS: &[&str] = &[
    "monitor",
    "subscribe",
    "psubscribe",
    "ssubscribe",
    "unsubscribe",
    "punsubscribe",
    "sunsubscribe",
    "sync",
    "psync",
];

/// Commands that wait for data, when the server does not flag them (older servers).
const BLOCKING_COMMANDS: &[&str] = &[
    "blpop",
    "brpop",
    "brpoplpush",
    "blmove",
    "blmpop",
    "bzpopmin",
    "bzpopmax",
    "bzmpop",
    "wait",
    "waitaof",
];

pub fn not_supported_yet(name: &str) -> YadbeError {
    YadbeError::new(
        ErrorCode::NotSupported,
        format!(
            "{} is not supported yet: it streams or waits for data, which the console cannot show. Nothing was run.",
            name.to_ascii_uppercase()
        ),
        format!(
            "{} n'est pas encore pris en charge : la commande diffuse ou attend des données, ce que la console ne sait pas encore afficher. Rien n'a été exécuté.",
            name.to_ascii_uppercase()
        ),
    )
}

/// A read-only refusal naming the command, and why when the flags do not say "write".
fn read_only_refusal(cmd: &KvCommand, why_en: &str, why_fr: &str) -> YadbeError {
    let name = cmd.name().to_ascii_uppercase();
    YadbeError::new(
        ErrorCode::ReadOnlyViolation,
        format!("This connection is read-only: {name} {why_en}. Nothing was run."),
        format!("Cette connexion est en lecture seule : {name} {why_fr}. Rien n'a été exécuté."),
    )
    .with_action(crate::db::errors::ErrorAction::EditConnection)
}

fn has_block_option(cmd: &KvCommand) -> bool {
    (1..cmd.args.len()).any(|i| cmd.arg_lower(i).as_deref() == Some("block"))
}

/// Whether yadbe can run `cmd` at all, whatever the connection: streaming and blocking
/// commands are refused with a typed error until the console can show them.
pub fn check_supported(cmd: &KvCommand, spec: Option<&CommandSpec>) -> Result<(), YadbeError> {
    let name = cmd.name();
    if name.is_empty() {
        return Err(YadbeError::invalid_argument(
            "The command is empty.",
            "La commande est vide.",
        ));
    }
    if STREAMING_COMMANDS.contains(&name.as_str()) {
        return Err(not_supported_yet(&name));
    }
    let blocking = match name.as_str() {
        // They block only with `BLOCK`; the flag is set either way.
        "xread" | "xreadgroup" => has_block_option(cmd),
        _ => {
            BLOCKING_COMMANDS.contains(&name.as_str())
                || spec.is_some_and(|s| s.resolve(cmd).has_flag("blocking"))
        }
    };
    if blocking {
        return Err(not_supported_yet(&name));
    }
    Ok(())
}

/// The read-only verdict: `Err(readOnlyViolation)` for anything the server flags as a
/// write, scripts and functions, unknown commands, publishing, and admin commands outside
/// the few that only read.
pub fn check_read_only(cmd: &KvCommand, spec: Option<&CommandSpec>) -> Result<(), YadbeError> {
    let name = cmd.name();
    if SCRIPT_COMMANDS.contains(&name.as_str()) {
        return Err(read_only_refusal(
            cmd,
            "runs a script whose effects cannot be known before it runs",
            "exécute un script dont les effets ne peuvent être connus avant son exécution",
        ));
    }
    if PUBLISH_COMMANDS.contains(&name.as_str()) {
        return Err(read_only_refusal(
            cmd,
            "sends a message to other clients",
            "envoie un message aux autres clients",
        ));
    }
    let Some(spec) = spec else {
        return Err(read_only_refusal(
            cmd,
            "is not a command this server knows, so yadbe cannot tell it only reads",
            "n'est pas une commande connue de ce serveur : yadbe ne peut pas garantir qu'elle ne fait que lire",
        ));
    };
    let resolved = spec.resolve(cmd);
    if resolved.has_flag("write") {
        return Err(read_only_refusal(
            cmd,
            "changes data",
            "modifie des données",
        ));
    }
    let admin = resolved.has_flag("admin") || resolved.in_category("admin");
    if admin && !ADMIN_READS.contains(&resolved.name.as_str()) {
        return Err(read_only_refusal(
            cmd,
            "is an administration command that may change the server",
            "est une commande d'administration qui peut modifier le serveur",
        ));
    }
    Ok(())
}

/// A command that needs a confirmation with its concrete effect (rule 10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum KvDangerKind {
    /// `FLUSHALL`: every key of every database.
    FlushAll,
    /// `FLUSHDB`: every key of the current database.
    FlushDb,
    /// `KEYS`: walks the whole keyspace and blocks the server meanwhile.
    Keys,
    /// `DEL` / `UNLINK` of many keys.
    DeleteMany { keys: u32 },
    /// `CONFIG SET`, `CONFIG RESETSTAT`, `CONFIG REWRITE`.
    Config,
    /// `SHUTDOWN`.
    Shutdown,
    /// `DEBUG`: can crash, block or corrupt the server.
    Debug,
    /// `SWAPDB a b`.
    SwapDb { a: String, b: String },
    /// `SCRIPT FLUSH`, `FUNCTION FLUSH`, `FUNCTION DELETE`.
    FlushScripts,
    /// `CLIENT KILL`: drops other connections.
    ClientKill,
    /// `REPLICAOF` / `SLAVEOF`: turns the server into a replica (its data replaced).
    ReplicaOf,
}

/// `DEL` / `UNLINK` of at least this many keys is confirmed.
pub const DELETE_MANY_KEYS: usize = 10;

/// The danger of `cmd`, before any probing of its concrete effect.
pub fn danger_of(cmd: &KvCommand) -> Option<KvDangerKind> {
    let name = cmd.name();
    let sub = cmd.arg_lower(1).unwrap_or_default();
    match name.as_str() {
        "flushall" => Some(KvDangerKind::FlushAll),
        "flushdb" => Some(KvDangerKind::FlushDb),
        "keys" => Some(KvDangerKind::Keys),
        "del" | "unlink" if cmd.args.len() > DELETE_MANY_KEYS => Some(KvDangerKind::DeleteMany {
            keys: u32::try_from(cmd.args.len() - 1).unwrap_or(u32::MAX),
        }),
        "config" if matches!(sub.as_str(), "set" | "resetstat" | "rewrite") => {
            Some(KvDangerKind::Config)
        }
        "shutdown" => Some(KvDangerKind::Shutdown),
        "debug" => Some(KvDangerKind::Debug),
        "swapdb" => Some(KvDangerKind::SwapDb {
            a: String::from_utf8_lossy(cmd.args.get(1).map_or(&[][..], Vec::as_slice)).into(),
            b: String::from_utf8_lossy(cmd.args.get(2).map_or(&[][..], Vec::as_slice)).into(),
        }),
        "script" if sub == "flush" => Some(KvDangerKind::FlushScripts),
        "function" if matches!(sub.as_str(), "flush" | "delete") => {
            Some(KvDangerKind::FlushScripts)
        }
        "client" if sub == "kill" => Some(KvDangerKind::ClientKill),
        "replicaof" | "slaveof" => Some(KvDangerKind::ReplicaOf),
        _ => None,
    }
}

/// A dangerous command and what it would do, for the confirmation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KvDanger {
    /// 0-based line of the console text.
    pub line: u32,
    /// The command as it would run (secrets redacted).
    pub command: String,
    pub kind: KvDangerKind,
    /// The concrete effect, measured on the server when it can be (`Deletes 1 204 keys…`).
    pub effect: LocalizedText,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::keyvalue::tokenize::split_args;

    fn cmd(line: &str) -> KvCommand {
        KvCommand::new(split_args(line).expect("splits"))
    }

    fn spec(name: &str, flags: &[&str], categories: &[&str]) -> CommandSpec {
        CommandSpec {
            name: name.into(),
            arity: -1,
            flags: flags.iter().map(|s| (*s).to_owned()).collect(),
            categories: categories.iter().map(|s| (*s).to_owned()).collect(),
            subcommands: Vec::new(),
        }
    }

    fn bulk(s: &str) -> KvReply {
        KvReply::Bulk(s.as_bytes().to_vec())
    }

    #[test]
    fn parses_command_info_with_subcommands() {
        let sub = KvReply::Array(vec![
            bulk("config|set"),
            KvReply::Int(-4),
            KvReply::Set(vec![KvReply::Status("admin".into())]),
            KvReply::Int(0),
            KvReply::Int(0),
            KvReply::Int(0),
            KvReply::Set(vec![KvReply::Status("@admin".into())]),
        ]);
        let reply = KvReply::Array(vec![
            bulk("config"),
            KvReply::Int(-2),
            KvReply::Set(vec![]),
            KvReply::Int(0),
            KvReply::Int(0),
            KvReply::Int(0),
            KvReply::Set(vec![KvReply::Status("@slow".into())]),
            KvReply::Set(vec![]),
            KvReply::Array(vec![]),
            KvReply::Array(vec![sub]),
        ]);
        let parsed = CommandSpec::parse(&reply).expect("spec");
        assert_eq!(parsed.name, "config");
        let resolved = parsed.resolve(&cmd("CONFIG SET maxmemory 1"));
        assert_eq!(resolved.name, "config|set");
        assert!(resolved.has_flag("admin"));
        assert!(resolved.in_category("admin"));
        assert_eq!(parsed.resolve(&cmd("CONFIG")).name, "config");
        assert!(CommandSpec::parse(&KvReply::Nil).is_none());
    }

    #[test]
    fn read_only_follows_the_server_flags() {
        let get = spec("get", &["readonly", "fast"], &["read"]);
        let set = spec("set", &["write", "denyoom"], &["write"]);
        let info = spec("info", &["loading", "stale"], &["slow", "dangerous"]);
        let shutdown = spec("shutdown", &["admin", "noscript"], &["admin"]);
        let config_get = spec("config|get", &["admin"], &["admin"]);
        assert!(check_read_only(&cmd("GET k"), Some(&get)).is_ok());
        assert!(check_read_only(&cmd("INFO keyspace"), Some(&info)).is_ok());
        let refused = check_read_only(&cmd("SET k v"), Some(&set)).expect_err("write");
        assert_eq!(refused.code, ErrorCode::ReadOnlyViolation);
        assert!(refused.message.en.contains("SET"));
        assert!(check_read_only(&cmd("SHUTDOWN"), Some(&shutdown)).is_err());
        assert!(check_read_only(&cmd("CONFIG GET maxmemory"), Some(&config_get)).is_ok());
        assert!(check_read_only(&cmd("NOSUCH x"), None).is_err());
        for script in [
            "EVAL 'return 1' 0",
            "EVALSHA abc 0",
            "FCALL f 0",
            "SCRIPT LOAD x",
            "FUNCTION LIST",
        ] {
            assert!(
                check_read_only(&cmd(script), Some(&get)).is_err(),
                "{script}"
            );
        }
        assert!(check_read_only(&cmd("PUBLISH ch hi"), Some(&get)).is_err());
    }

    #[test]
    fn streaming_and_blocking_commands_are_not_supported_yet() {
        let xread = spec("xread", &["readonly", "blocking"], &["read"]);
        for line in [
            "MONITOR",
            "SUBSCRIBE ch",
            "PSUBSCRIBE c*",
            "BLPOP q 0",
            "WAIT 1 0",
        ] {
            let err = check_supported(&cmd(line), None).expect_err(line);
            assert_eq!(err.code, ErrorCode::NotSupported, "{line}");
        }
        assert!(check_supported(&cmd("XREAD COUNT 2 STREAMS s 0"), Some(&xread)).is_ok());
        assert!(check_supported(&cmd("XREAD BLOCK 0 STREAMS s $"), Some(&xread)).is_err());
        assert!(check_supported(&cmd("GET k"), None).is_ok());
        assert!(check_supported(&cmd(""), None).is_err());
    }

    #[test]
    fn dangers_are_named() {
        assert_eq!(
            danger_of(&cmd("flushall async")),
            Some(KvDangerKind::FlushAll)
        );
        assert_eq!(danger_of(&cmd("FLUSHDB")), Some(KvDangerKind::FlushDb));
        assert_eq!(danger_of(&cmd("KEYS *")), Some(KvDangerKind::Keys));
        assert_eq!(danger_of(&cmd("DEL a b c")), None);
        assert_eq!(
            danger_of(&cmd("UNLINK k1 k2 k3 k4 k5 k6 k7 k8 k9 k10")),
            Some(KvDangerKind::DeleteMany { keys: 10 })
        );
        assert_eq!(
            danger_of(&cmd("CONFIG SET maxmemory 1")),
            Some(KvDangerKind::Config)
        );
        assert_eq!(danger_of(&cmd("CONFIG GET maxmemory")), None);
        assert_eq!(
            danger_of(&cmd("SHUTDOWN NOSAVE")),
            Some(KvDangerKind::Shutdown)
        );
        assert_eq!(danger_of(&cmd("DEBUG SLEEP 1")), Some(KvDangerKind::Debug));
        assert_eq!(
            danger_of(&cmd("SWAPDB 0 1")),
            Some(KvDangerKind::SwapDb {
                a: "0".into(),
                b: "1".into()
            })
        );
        assert_eq!(danger_of(&cmd("GET k")), None);
    }
}
