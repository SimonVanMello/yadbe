//! What the user defines for an SSH tunnel (no secret), and what errors and connection states
//! say about it.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::errors::YadbeError;
use crate::secrets::SecretKind;

pub const DEFAULT_SSH_PORT: u16 = 22;
/// Keep-alive interval when the definition sets none.
pub const DEFAULT_KEEPALIVE_SECS: u32 = 30;
pub const MAX_KEEPALIVE_SECS: u32 = 3600;
const MAX_FIELD_CHARS: usize = 1024;

/// How yadbe authenticates to an SSH server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SshAuthMethod {
    /// The password lives in the keychain or in the session, like a database password.
    Password,
    /// A private key file read at connect time (OpenSSH or PEM); its passphrase, if any,
    /// lives in the keychain or in the session.
    Key,
    /// The running SSH agent (`SSH_AUTH_SOCK`; Pageant / the OpenSSH agent on Windows).
    Agent,
}

/// One SSH server: the tunnel's own, or the jump host in front of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshHop {
    pub host: String,
    /// `null`: 22.
    pub port: Option<u16>,
    pub username: String,
    pub auth: SshAuthMethod,
    /// Private key file (`~` allowed) for `key`; never copied, read at connect time.
    pub key_path: Option<String>,
    /// The password or key passphrase goes to the OS keychain; otherwise it is asked at
    /// connect time and kept in memory for the session.
    pub remember_secret: bool,
}

impl SshHop {
    pub fn port(&self) -> u16 {
        self.port.unwrap_or(DEFAULT_SSH_PORT)
    }

    /// `user@host:port`, as shown in states, logs and errors.
    pub fn endpoint(&self) -> String {
        format!("{}@{}:{}", self.username, self.host, self.port())
    }
}

/// An SSH tunnel in front of a server connection (F-010): the database host and port are
/// reached from the SSH server's side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnel {
    pub server: SshHop,
    /// One hop in front of `server` (`ssh -J`).
    pub jump: Option<SshHop>,
    /// Keep-alive interval; `null`: 30 s, `0`: off.
    pub keepalive_secs: Option<u32>,
}

/// The hops of a tunnelled connection, in the order they are crossed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TunnelHop {
    /// The jump host.
    Jump,
    /// The tunnel's SSH server.
    Server,
    /// The database, reached through the tunnel.
    Database,
}

impl TunnelHop {
    /// The secret kinds of a hop: (password, key passphrase).
    pub fn secret_kinds(self) -> (SecretKind, SecretKind) {
        match self {
            TunnelHop::Jump => (SecretKind::JumpPassword, SecretKind::JumpPassphrase),
            _ => (SecretKind::SshPassword, SecretKind::SshPassphrase),
        }
    }
}

/// What a tunnel error is about, for the UI: which hop failed, the host key to show, the
/// secret to ask for. Never holds a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TunnelFailure {
    pub hop: TunnelHop,
    pub host: String,
    pub port: u16,
    /// Host key algorithm (`ssh-ed25519`…), for host key errors.
    pub key_type: Option<String>,
    /// `SHA256:…` fingerprint of the host key the server presented, for host key errors.
    pub fingerprint: Option<String>,
    /// The secret to ask for (`sshSecretRequired`, `sshAuthFailed`, wrong passphrase).
    pub secret: Option<SecretKind>,
}

/// Phase of a session's tunnel, carried by connection states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TunnelPhase {
    /// Connecting and authenticating to the SSH server(s).
    Opening,
    Open,
    /// Closed or dropped; reopened before the next database connection.
    Down,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub phase: TunnelPhase,
    /// `user@host:port` of the tunnel's SSH server.
    pub endpoint: String,
    /// `user@host:port` of the jump host, if any.
    pub jump: Option<String>,
}

/// A host key the user accepted (yadbe's own known-hosts store).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    /// Unix time in seconds.
    pub added_at: u32,
}

fn normalized_hop(mut hop: SshHop, what_en: &str, what_fr: &str) -> Result<SshHop, YadbeError> {
    hop.host = hop.host.trim().to_owned();
    hop.username = hop.username.trim().to_owned();
    hop.key_path = hop
        .key_path
        .map(|p| p.trim().to_owned())
        .filter(|p| !p.is_empty());
    if hop.host.is_empty() {
        return Err(YadbeError::invalid_argument(
            format!("The {what_en} needs a host."),
            format!("{what_fr} doit avoir un hôte."),
        ));
    }
    if hop.username.is_empty() {
        return Err(YadbeError::invalid_argument(
            format!("The {what_en} needs a user name."),
            format!("{what_fr} doit avoir un nom d'utilisateur."),
        ));
    }
    if hop.port == Some(0) {
        return Err(YadbeError::invalid_argument(
            "The port must be between 1 and 65535.",
            "Le port doit être compris entre 1 et 65535.",
        ));
    }
    let too_long = [Some(&hop.host), Some(&hop.username), hop.key_path.as_ref()]
        .into_iter()
        .flatten()
        .any(|f| f.chars().count() > MAX_FIELD_CHARS);
    if too_long {
        return Err(YadbeError::invalid_argument(
            format!("A connection field has at most {MAX_FIELD_CHARS} characters."),
            format!("Un champ de connexion compte au plus {MAX_FIELD_CHARS} caractères."),
        ));
    }
    match hop.auth {
        SshAuthMethod::Key if hop.key_path.is_none() => {
            return Err(YadbeError::invalid_argument(
                format!("Choose the private key file of the {what_en}."),
                format!("Choisissez le fichier de clé privée : {what_fr}."),
            ));
        }
        SshAuthMethod::Key => {}
        SshAuthMethod::Password | SshAuthMethod::Agent => hop.key_path = None,
    }
    Ok(hop)
}

impl SshTunnel {
    /// Trims the fields and checks what a tunnel needs.
    pub fn normalized(self) -> Result<Self, YadbeError> {
        let server = normalized_hop(self.server, "SSH server", "Le serveur SSH")?;
        let jump = self
            .jump
            .map(|jump| normalized_hop(jump, "jump host", "L'hôte de rebond"))
            .transpose()?;
        if let Some(secs) = self.keepalive_secs
            && secs > MAX_KEEPALIVE_SECS
        {
            return Err(YadbeError::invalid_argument(
                format!("The keep-alive interval is at most {MAX_KEEPALIVE_SECS} seconds."),
                format!("L'intervalle de keep-alive est d'au plus {MAX_KEEPALIVE_SECS} secondes."),
            ));
        }
        Ok(Self {
            server,
            jump,
            keepalive_secs: self.keepalive_secs,
        })
    }

    pub fn status(&self, phase: TunnelPhase) -> TunnelStatus {
        TunnelStatus {
            phase,
            endpoint: self.server.endpoint(),
            jump: self.jump.as_ref().map(SshHop::endpoint),
        }
    }
}

#[cfg(test)]
pub(crate) fn sample_hop(host: &str) -> SshHop {
    SshHop {
        host: host.into(),
        port: None,
        username: "deploy".into(),
        auth: SshAuthMethod::Password,
        key_path: None,
        remember_secret: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::errors::ErrorCode;

    #[test]
    fn normalizes_and_validates_the_hops() {
        let tunnel = SshTunnel {
            server: SshHop {
                host: " bastion ".into(),
                key_path: Some("~/.ssh/id".into()),
                ..sample_hop("x")
            },
            jump: None,
            keepalive_secs: None,
        }
        .normalized()
        .expect("valid");
        assert_eq!(tunnel.server.host, "bastion");
        assert_eq!(tunnel.server.key_path, None, "password auth keeps no key");
        assert_eq!(tunnel.server.endpoint(), "deploy@bastion:22");

        let no_key = SshTunnel {
            server: SshHop {
                auth: SshAuthMethod::Key,
                ..sample_hop("bastion")
            },
            jump: None,
            keepalive_secs: None,
        };
        assert_eq!(
            no_key.normalized().map_err(|e| e.code),
            Err(ErrorCode::InvalidArgument)
        );

        let no_jump_user = SshTunnel {
            server: sample_hop("bastion"),
            jump: Some(SshHop {
                username: " ".into(),
                ..sample_hop("jump")
            }),
            keepalive_secs: Some(10),
        };
        assert!(no_jump_user.normalized().is_err());
    }
}
