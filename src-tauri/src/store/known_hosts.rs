//! SSH host keys the user accepted (F-010), by fingerprint.

use rusqlite::{Row, params};

use super::{Store, now};
use crate::db::errors::YadbeError;
use crate::tunnel::KnownHost;

fn row_to_known_host(row: &Row<'_>) -> rusqlite::Result<KnownHost> {
    Ok(KnownHost {
        host: row.get(0)?,
        port: row.get(1)?,
        key_type: row.get(2)?,
        fingerprint: row.get(3)?,
        added_at: row.get(4)?,
    })
}

const COLUMNS: &str = "host, port, key_type, fingerprint, added_at";

impl Store {
    /// Every accepted host key, by host then port.
    pub fn list_known_hosts(&self) -> Result<Vec<KnownHost>, YadbeError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM ssh_known_hosts ORDER BY host, port, key_type"
        ))?;
        let rows = stmt.query_map([], row_to_known_host)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// The accepted keys of one host (`host` already normalized).
    pub fn known_hosts_for(&self, host: &str, port: u16) -> Result<Vec<KnownHost>, YadbeError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM ssh_known_hosts WHERE host = ?1 AND port = ?2"
        ))?;
        let rows = stmt.query_map(params![host, port], row_to_known_host)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Records an accepted key; accepting the same key again is a no-op.
    pub fn add_known_host(
        &self,
        host: &str,
        port: u16,
        key_type: &str,
        fingerprint: &str,
    ) -> Result<KnownHost, YadbeError> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO ssh_known_hosts (host, port, key_type, fingerprint, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (host, port, key_type) DO NOTHING",
            params![host, port, key_type, fingerprint, now()],
        )?;
        Ok(conn.query_row(
            &format!(
                "SELECT {COLUMNS} FROM ssh_known_hosts
                 WHERE host = ?1 AND port = ?2 AND key_type = ?3"
            ),
            params![host, port, key_type],
            row_to_known_host,
        )?)
    }

    /// Forgets the accepted keys of a host (`key_type`: only that one). Returns how many.
    pub fn forget_known_host(
        &self,
        host: &str,
        port: u16,
        key_type: Option<&str>,
    ) -> Result<usize, YadbeError> {
        let conn = self.conn();
        Ok(match key_type {
            Some(key_type) => conn.execute(
                "DELETE FROM ssh_known_hosts WHERE host = ?1 AND port = ?2 AND key_type = ?3",
                params![host, port, key_type],
            )?,
            None => conn.execute(
                "DELETE FROM ssh_known_hosts WHERE host = ?1 AND port = ?2",
                params![host, port],
            )?,
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::db::config::sample_definition;
    use crate::db::dialect::Engine;
    use crate::store::Store;
    use crate::tunnel::model::sample_hop;
    use crate::tunnel::{SshAuthMethod, SshHop, SshTunnel};

    #[test]
    fn known_hosts_are_kept_by_host_port_and_type() {
        let store = Store::open_in_memory().expect("store");
        let added = store
            .add_known_host("bastion", 22, "ssh-ed25519", "SHA256:aaa")
            .expect("add");
        assert_eq!(added.fingerprint, "SHA256:aaa");
        // Accepting again keeps the first key.
        store
            .add_known_host("bastion", 22, "ssh-ed25519", "SHA256:bbb")
            .expect("again");
        store
            .add_known_host("bastion", 22, "ecdsa-sha2-nistp256", "SHA256:ccc")
            .expect("other type");
        store
            .add_known_host("bastion", 2222, "ssh-ed25519", "SHA256:ddd")
            .expect("other port");
        let for_22 = store.known_hosts_for("bastion", 22).expect("for");
        assert_eq!(for_22.len(), 2);
        assert!(for_22.iter().any(|k| k.fingerprint == "SHA256:aaa"));
        assert_eq!(store.list_known_hosts().expect("list").len(), 3);
        assert_eq!(
            store
                .forget_known_host("bastion", 22, Some("ssh-ed25519"))
                .expect("forget one"),
            1
        );
        assert_eq!(
            store
                .forget_known_host("bastion", 22, None)
                .expect("forget"),
            1
        );
        assert_eq!(store.list_known_hosts().expect("list").len(), 1);
    }

    #[test]
    fn the_ssh_tunnel_of_a_connection_round_trips() {
        let store = Store::open_in_memory().expect("store");
        let mut def = sample_definition(Engine::Postgres);
        def.ssh = Some(SshTunnel {
            server: SshHop {
                auth: SshAuthMethod::Key,
                key_path: Some("~/.ssh/id_ed25519".into()),
                ..sample_hop("bastion")
            },
            jump: Some(sample_hop("jump")),
            keepalive_secs: Some(15),
        });
        let saved = store.create_connection(&def).expect("create");
        assert_eq!(saved.definition.ssh, def.ssh);
        def.ssh = None;
        let updated = store.update_connection(&saved.id, &def).expect("update");
        assert_eq!(updated.definition.ssh, None);
    }
}
