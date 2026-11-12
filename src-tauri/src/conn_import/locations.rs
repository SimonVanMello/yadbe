//! Where each source keeps its file on each operating system. Built from the environment
//! once per call and passed as data, so tests never look at the real home directory.

use std::path::{Path, PathBuf};

use super::model::ConnectionSourceKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Linux,
    Macos,
    Windows,
}

#[derive(Debug, Clone)]
pub struct Locations {
    pub os: Os,
    pub home: Option<PathBuf>,
    /// `%APPDATA%` on Windows.
    pub appdata: Option<PathBuf>,
    pub xdg_config: Option<PathBuf>,
    pub xdg_data: Option<PathBuf>,
    /// `PGPASSFILE`.
    pub pgpassfile: Option<PathBuf>,
    /// `PGSERVICEFILE`.
    pub pgservicefile: Option<PathBuf>,
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

impl Locations {
    pub fn from_env() -> Self {
        let os = if cfg!(target_os = "windows") {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Macos
        } else {
            Os::Linux
        };
        Self {
            os,
            home: env_path("HOME").or_else(|| env_path("USERPROFILE")),
            appdata: env_path("APPDATA"),
            xdg_config: env_path("XDG_CONFIG_HOME"),
            xdg_data: env_path("XDG_DATA_HOME"),
            pgpassfile: env_path("PGPASSFILE"),
            pgservicefile: env_path("PGSERVICEFILE"),
        }
    }

    /// The per-user folder editors keep their `User/settings.json` under.
    fn editor_config(&self) -> Option<PathBuf> {
        match self.os {
            Os::Windows => self.appdata.clone(),
            Os::Macos => self
                .home
                .as_ref()
                .map(|h| h.join("Library/Application Support")),
            Os::Linux => self
                .xdg_config
                .clone()
                .or_else(|| self.home.as_ref().map(|h| h.join(".config"))),
        }
    }

    /// The files a source may be at, most likely first.
    pub fn candidates(&self, kind: ConnectionSourceKind) -> Vec<PathBuf> {
        let join = |base: Option<PathBuf>, rest: &str| base.map(|b| b.join(rest));
        let mut out: Vec<Option<PathBuf>> = Vec::new();
        match kind {
            ConnectionSourceKind::AzureDataStudio => {
                for product in ["azuredatastudio", "azuredatastudio-insiders"] {
                    out.push(join(
                        self.editor_config(),
                        &format!("{product}/User/settings.json"),
                    ));
                }
            }
            ConnectionSourceKind::VscodeMssql => {
                for product in ["Code", "Code - Insiders", "VSCodium"] {
                    out.push(join(
                        self.editor_config(),
                        &format!("{product}/User/settings.json"),
                    ));
                }
            }
            ConnectionSourceKind::Dbeaver => {
                let workspace = "DBeaverData/workspace6/General/.dbeaver/data-sources.json";
                out.push(match self.os {
                    Os::Windows => join(self.appdata.clone(), workspace),
                    Os::Macos => join(self.home.clone(), &format!("Library/{workspace}")),
                    Os::Linux => join(
                        self.xdg_data
                            .clone()
                            .or_else(|| self.home.as_ref().map(|h| h.join(".local/share"))),
                        workspace,
                    ),
                });
            }
            ConnectionSourceKind::Pgpass => {
                out.push(self.pgpassfile.clone());
                out.push(match self.os {
                    Os::Windows => join(self.appdata.clone(), "postgresql/pgpass.conf"),
                    _ => join(self.home.clone(), ".pgpass"),
                });
            }
            ConnectionSourceKind::PgService => {
                out.push(self.pgservicefile.clone());
                out.push(match self.os {
                    Os::Windows => join(self.appdata.clone(), "postgresql/.pg_service.conf"),
                    _ => join(self.home.clone(), ".pg_service.conf"),
                });
            }
            ConnectionSourceKind::Ssms => {
                if self.os == Os::Windows {
                    for version in ["21", "20.0", "19.0", "18.0"] {
                        out.push(join(
                            self.appdata.clone(),
                            &format!(
                                "Microsoft/SQL Server Management Studio/{version}/RegSrvr.xml"
                            ),
                        ));
                    }
                    for version in ["150", "140", "130", "120", "110", "100"] {
                        out.push(join(
                            self.appdata.clone(),
                            &format!(
                                "Microsoft/Microsoft SQL Server/{version}/Tools/Shell/RegSrvr.xml"
                            ),
                        ));
                    }
                }
            }
            ConnectionSourceKind::Yadbe => {}
        }
        out.into_iter().flatten().collect()
    }

    /// The first candidate that exists as a file.
    pub fn default_path(&self, kind: ConnectionSourceKind) -> Option<PathBuf> {
        self.candidates(kind).into_iter().find(|p| p.is_file())
    }
}

/// Whether `path` is somewhere a source file can be read from (absolute).
pub fn is_absolute(path: &str) -> bool {
    Path::new(path).is_absolute()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(os: Os) -> Locations {
        Locations {
            os,
            home: Some(PathBuf::from("/h")),
            appdata: Some(PathBuf::from("/h/AppData/Roaming")),
            xdg_config: None,
            xdg_data: None,
            pgpassfile: None,
            pgservicefile: None,
        }
    }

    #[test]
    fn proposes_the_usual_place_per_os() {
        let first = |os, kind| {
            at(os)
                .candidates(kind)
                .into_iter()
                .next()
                .map(|p| p.display().to_string())
        };
        assert_eq!(
            first(Os::Linux, ConnectionSourceKind::AzureDataStudio).as_deref(),
            Some("/h/.config/azuredatastudio/User/settings.json")
        );
        assert_eq!(
            first(Os::Macos, ConnectionSourceKind::VscodeMssql).as_deref(),
            Some("/h/Library/Application Support/Code/User/settings.json")
        );
        assert_eq!(
            first(Os::Windows, ConnectionSourceKind::AzureDataStudio).as_deref(),
            Some("/h/AppData/Roaming/azuredatastudio/User/settings.json")
        );
        assert_eq!(
            first(Os::Linux, ConnectionSourceKind::Dbeaver).as_deref(),
            Some("/h/.local/share/DBeaverData/workspace6/General/.dbeaver/data-sources.json")
        );
        assert_eq!(
            first(Os::Macos, ConnectionSourceKind::Dbeaver).as_deref(),
            Some("/h/Library/DBeaverData/workspace6/General/.dbeaver/data-sources.json")
        );
        assert_eq!(
            first(Os::Linux, ConnectionSourceKind::Pgpass).as_deref(),
            Some("/h/.pgpass")
        );
        assert_eq!(
            first(Os::Windows, ConnectionSourceKind::Pgpass).as_deref(),
            Some("/h/AppData/Roaming/postgresql/pgpass.conf")
        );
        assert_eq!(
            first(Os::Linux, ConnectionSourceKind::PgService).as_deref(),
            Some("/h/.pg_service.conf")
        );
        assert!(
            at(Os::Linux)
                .candidates(ConnectionSourceKind::Ssms)
                .is_empty()
        );
        assert!(
            !at(Os::Windows)
                .candidates(ConnectionSourceKind::Ssms)
                .is_empty()
        );
        assert!(
            at(Os::Windows)
                .candidates(ConnectionSourceKind::Yadbe)
                .is_empty()
        );
        let mut with_env = at(Os::Linux);
        with_env.pgpassfile = Some(PathBuf::from("/custom/pgpass"));
        assert_eq!(
            with_env.candidates(ConnectionSourceKind::Pgpass)[0],
            PathBuf::from("/custom/pgpass")
        );
    }

    #[test]
    fn the_default_is_the_first_file_that_exists() {
        let dir = tempfile::tempdir().expect("dir");
        let mut locations = at(Os::Linux);
        locations.home = Some(dir.path().to_path_buf());
        assert_eq!(locations.default_path(ConnectionSourceKind::Pgpass), None);
        std::fs::write(dir.path().join(".pgpass"), "x").expect("writes");
        assert_eq!(
            locations.default_path(ConnectionSourceKind::Pgpass),
            Some(dir.path().join(".pgpass"))
        );
    }
}
