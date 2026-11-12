//! Command line: `yadbe <file.sql>…` opens scripts, `yadbe <connection-url>` starts a connection
//! (F-126).
//!
//! The arguments are read once at startup into [`LaunchRequest`]s the frontend takes with
//! `take_launch_requests`. A password written in a URL is dropped here, on the spot: it is
//! never kept, stored, logged or sent to the frontend (a command line is visible to every
//! process of the machine and to the shell history; the password is typed in the app, or comes
//! from the keychain). A rejected argument is reported without its text when it may hold a
//! secret (a URL).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use specta::Type;

use crate::db::connstring::{self, ParsedConnectionString};

/// What the command line asked for.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LaunchRequest {
    /// Open this script (an absolute path) in a query tab.
    #[serde(rename_all = "camelCase")]
    SqlFile { path: String },
    /// Open this connection: a saved one when it matches, else the connection form filled in.
    #[serde(rename_all = "camelCase")]
    Connection {
        /// The URL's fields, without its password.
        parsed: ParsedConnectionString,
        /// The URL carried a password: it was ignored.
        password_ignored: bool,
    },
    /// An argument that could not be used.
    #[serde(rename_all = "camelCase")]
    Rejected {
        reason: RejectedReason,
        /// The argument, for file paths; `null` for a URL (it may hold a password).
        argument: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RejectedReason {
    /// Not a script file (`.sql`, `.ddl`, …).
    NotAScript,
    /// The file does not exist.
    FileNotFound,
    /// A connection URL that could not be understood.
    InvalidUrl,
}

/// Extensions of the files yadbe opens as scripts (the ones `commands::files` serves).
const SCRIPT_EXTENSIONS: &[&str] = &["sql", "ddl", "dml", "psql", "pgsql", "tsql", "txt"];

/// Reads `args` (without the program name). Flags (`-x`, `--x`: macOS adds `-psn_…`) are
/// skipped; a relative path is resolved against `cwd`. At most one connection URL is used:
/// the others are rejected.
pub fn parse_args(args: &[OsString], cwd: &Path) -> Vec<LaunchRequest> {
    let mut requests = Vec::new();
    let mut connection_seen = false;
    for arg in args {
        let Some(text) = arg.to_str() else {
            // A path that is not UTF-8 cannot cross to the webview.
            requests.push(LaunchRequest::Rejected {
                reason: RejectedReason::NotAScript,
                argument: Some(arg.to_string_lossy().into_owned()),
            });
            continue;
        };
        if text.starts_with('-') || text.is_empty() {
            continue;
        }
        if connstring::looks_like_url(text) {
            if connection_seen {
                requests.push(rejected_url());
                continue;
            }
            connection_seen = true;
            requests.push(match connstring::parse(text, None) {
                // The password is dropped (zeroized) here.
                Ok(parsed) => LaunchRequest::Connection {
                    password_ignored: parsed.password.is_some(),
                    parsed: parsed.fields,
                },
                Err(_) => rejected_url(),
            });
            continue;
        }
        requests.push(script_request(text, cwd));
    }
    requests
}

fn rejected_url() -> LaunchRequest {
    LaunchRequest::Rejected {
        reason: RejectedReason::InvalidUrl,
        argument: None,
    }
}

fn script_request(text: &str, cwd: &Path) -> LaunchRequest {
    let path = Path::new(text);
    let path: PathBuf = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    let rejected = |reason| LaunchRequest::Rejected {
        reason,
        argument: Some(text.to_owned()),
    };
    let is_script = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            SCRIPT_EXTENSIONS
                .iter()
                .any(|known| known.eq_ignore_ascii_case(ext))
        });
    if !is_script {
        return rejected(RejectedReason::NotAScript);
    }
    if !path.is_file() {
        return rejected(RejectedReason::FileNotFound);
    }
    // `..` and `.` out of the way: the same file is recognized when it is already open.
    let path = path.canonicalize().unwrap_or(path);
    match path.to_str() {
        Some(path) => LaunchRequest::SqlFile {
            path: strip_verbatim(path).to_owned(),
        },
        None => rejected(RejectedReason::NotAScript),
    }
}

/// `\\?\C:\x` (what Windows canonicalization yields) back to `C:\x`, which is what the file
/// dialogs return and what open tabs remember.
fn strip_verbatim(path: &str) -> &str {
    path.strip_prefix(r"\\?\")
        .filter(|rest| !rest.starts_with("UNC\\"))
        .unwrap_or(path)
}

/// The requests waiting for the frontend: filled once at startup, taken once.
#[derive(Default)]
pub struct LaunchRequests(Mutex<Vec<LaunchRequest>>);

impl LaunchRequests {
    pub fn new(requests: Vec<LaunchRequest>) -> Self {
        Self(Mutex::new(requests))
    }

    pub fn take(&self) -> Vec<LaunchRequest> {
        std::mem::take(
            &mut *self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }
}

/// The text `yadbe --help` prints.
pub const USAGE: &str = "\
yadbe, a local SQL database explorer

Usage:
  yadbe [FILE.sql]...        open scripts in query tabs
  yadbe <connection-url>     open a saved connection that matches, or the connection form
                             filled in (postgres://, mysql://, sqlserver://, sqlite://)

A password written in the URL is ignored: it would stay in the process list and the shell
history. Type it in the app, or let the keychain provide it.

Options:
  -h, --help       print this help
  -V, --version    print the version
";

/// `--help` / `--version`: the text to print before exiting, when one of them is the first
/// argument.
pub fn info_flag(args: &[OsString]) -> Option<String> {
    match args.first().and_then(|arg| arg.to_str()) {
        Some("-h" | "--help") => Some(USAGE.to_owned()),
        Some("-V" | "--version") => Some(format!("yadbe {}\n", env!("CARGO_PKG_VERSION"))),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    fn dir_with(files: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        for file in files {
            std::fs::write(dir.path().join(file), "select 1;").expect("write");
        }
        dir
    }

    #[test]
    fn opens_scripts_by_absolute_or_relative_path() {
        let dir = dir_with(&["a.sql", "b.SQL"]);
        let absolute = dir.path().join("b.SQL").display().to_string();
        let requests = parse_args(&os(&["a.sql", &absolute]), dir.path());
        let canonical = |name: &str| {
            dir.path()
                .join(name)
                .canonicalize()
                .expect("canonical")
                .display()
                .to_string()
        };
        assert_eq!(
            requests,
            vec![
                LaunchRequest::SqlFile {
                    path: canonical("a.sql")
                },
                LaunchRequest::SqlFile {
                    path: canonical("b.SQL")
                },
            ]
        );
    }

    #[test]
    fn rejects_what_is_not_a_script_or_does_not_exist() {
        let dir = dir_with(&["data.csv"]);
        let requests = parse_args(&os(&["data.csv", "missing.sql"]), dir.path());
        assert_eq!(
            requests,
            vec![
                LaunchRequest::Rejected {
                    reason: RejectedReason::NotAScript,
                    argument: Some("data.csv".into())
                },
                LaunchRequest::Rejected {
                    reason: RejectedReason::FileNotFound,
                    argument: Some("missing.sql".into())
                },
            ]
        );
    }

    #[test]
    fn a_url_gives_its_fields_and_drops_its_password() {
        let requests = parse_args(
            &os(&["postgres://app:hunter2@db.example.com:6543/shop?sslmode=require"]),
            Path::new("/"),
        );
        let [
            LaunchRequest::Connection {
                parsed,
                password_ignored,
            },
        ] = requests.as_slice()
        else {
            panic!("a connection: {requests:?}");
        };
        assert!(password_ignored);
        assert_eq!(parsed.host.as_deref(), Some("db.example.com"));
        assert_eq!(parsed.port, Some(6543));
        assert_eq!(parsed.database.as_deref(), Some("shop"));
        assert_eq!(parsed.username.as_deref(), Some("app"));
        // Nothing the frontend receives holds the password, whatever the way it is printed.
        assert_eq!(parsed.password_id, None);
        assert!(!format!("{requests:?}").contains("hunter2"));
        let json = serde_json::to_string(&requests).expect("json");
        assert!(!json.contains("hunter2"), "{json}");
    }

    #[test]
    fn a_url_without_a_password_says_so() {
        let requests = parse_args(&os(&["mysql://root@localhost/test"]), Path::new("/"));
        assert!(matches!(
            requests.as_slice(),
            [LaunchRequest::Connection {
                password_ignored: false,
                ..
            }]
        ));
    }

    #[test]
    fn a_broken_url_is_rejected_without_being_echoed() {
        let requests = parse_args(
            &os(&["postgres://user:secret@host:notaport/db"]),
            Path::new("/"),
        );
        assert_eq!(
            requests,
            vec![LaunchRequest::Rejected {
                reason: RejectedReason::InvalidUrl,
                argument: None
            }]
        );
        assert!(!format!("{requests:?}").contains("secret"));
    }

    #[test]
    fn only_the_first_url_is_used() {
        let requests = parse_args(
            &os(&["postgres://a@h1/x", "postgres://b:pw@h2/y"]),
            Path::new("/"),
        );
        assert!(matches!(requests[0], LaunchRequest::Connection { .. }));
        assert_eq!(
            requests[1],
            LaunchRequest::Rejected {
                reason: RejectedReason::InvalidUrl,
                argument: None
            }
        );
    }

    #[test]
    fn flags_and_blank_arguments_are_skipped() {
        let dir = dir_with(&["q.sql"]);
        let requests = parse_args(&os(&["-psn_0_12345", "--foo", "", "q.sql"]), dir.path());
        assert_eq!(requests.len(), 1);
        assert!(matches!(requests[0], LaunchRequest::SqlFile { .. }));
        assert!(parse_args(&[], dir.path()).is_empty());
    }

    #[test]
    fn a_windows_drive_path_is_not_a_url() {
        let requests = parse_args(&os(&[r"C:\scripts\x.sql"]), Path::new("/"));
        assert!(matches!(
            requests.as_slice(),
            [LaunchRequest::Rejected {
                reason: RejectedReason::FileNotFound,
                ..
            }]
        ));
    }

    #[test]
    fn requests_are_taken_once() {
        let queue = LaunchRequests::new(vec![LaunchRequest::SqlFile {
            path: "/a.sql".into(),
        }]);
        assert_eq!(queue.take().len(), 1);
        assert!(queue.take().is_empty());
    }

    #[test]
    fn help_and_version_are_answered_before_anything_starts() {
        assert!(info_flag(&os(&["--help"])).is_some_and(|text| text.contains("Usage")));
        assert!(
            info_flag(&os(&["-V"]))
                .is_some_and(|text| text.starts_with("yadbe ") && text.ends_with('\n'))
        );
        assert!(info_flag(&os(&["a.sql", "--help"])).is_none());
        assert!(info_flag(&[]).is_none());
    }

    #[test]
    fn strips_the_windows_verbatim_prefix() {
        assert_eq!(strip_verbatim(r"\\?\C:\x\a.sql"), r"C:\x\a.sql");
        assert_eq!(
            strip_verbatim(r"\\?\UNC\srv\share\a.sql"),
            r"\\?\UNC\srv\share\a.sql"
        );
        assert_eq!(strip_verbatim("/home/a.sql"), "/home/a.sql");
    }
}
