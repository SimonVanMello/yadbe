//! The SSH tunnel part of the error catalog: FR / EN messages and suggested actions. Every
//! error carries a [`TunnelFailure`] naming the hop, so the UI can tell tunnel failures from
//! database ones and say which hop failed.

use crate::db::errors::{ErrorAction, ErrorCode, YadbeError};
use crate::secrets::SecretKind;
use crate::tunnel::model::{TunnelFailure, TunnelHop};

/// The hop an error is about.
#[derive(Debug, Clone)]
pub struct HopRef {
    pub hop: TunnelHop,
    pub host: String,
    pub port: u16,
}

impl HopRef {
    fn failure(&self) -> TunnelFailure {
        TunnelFailure {
            hop: self.hop,
            host: self.host.clone(),
            port: self.port,
            key_type: None,
            fingerprint: None,
            secret: None,
        }
    }

    fn name_en(&self) -> String {
        match self.hop {
            TunnelHop::Jump => format!("the jump host {}:{}", self.host, self.port),
            TunnelHop::Server => format!("the SSH server {}:{}", self.host, self.port),
            TunnelHop::Database => format!("{}:{}", self.host, self.port),
        }
    }

    fn name_fr(&self) -> String {
        match self.hop {
            TunnelHop::Jump => format!("l'hôte de rebond {}:{}", self.host, self.port),
            TunnelHop::Server => format!("le serveur SSH {}:{}", self.host, self.port),
            TunnelHop::Database => format!("{}:{}", self.host, self.port),
        }
    }
}

fn with_failure(mut error: YadbeError, failure: TunnelFailure) -> YadbeError {
    error.tunnel = Some(Box::new(failure));
    error
}

impl YadbeError {
    pub fn ssh_host_not_found(hop: &HopRef) -> Self {
        with_failure(
            Self::new(
                ErrorCode::SshHostUnreachable,
                format!(
                    "SSH tunnel: {} could not be found. Check its name and your network (VPN, DNS).",
                    hop.name_en()
                ),
                format!(
                    "Tunnel SSH : {} est introuvable. Vérifiez son nom et votre réseau (VPN, DNS).",
                    hop.name_fr()
                ),
            )
            .with_action(ErrorAction::EditConnection),
            hop.failure(),
        )
    }

    pub fn ssh_unreachable(hop: &HopRef) -> Self {
        with_failure(
            Self::new(
                ErrorCode::SshHostUnreachable,
                format!(
                    "SSH tunnel: {} did not accept the connection. Check that its SSH service runs on this port and that no firewall blocks it.",
                    hop.name_en()
                ),
                format!(
                    "Tunnel SSH : {} n'a pas accepté la connexion. Vérifiez que son service SSH écoute sur ce port et qu'aucun pare-feu ne le bloque.",
                    hop.name_fr()
                ),
            )
            .with_action(ErrorAction::Retry),
            hop.failure(),
        )
    }

    pub fn ssh_timeout(hop: &HopRef, seconds: u32) -> Self {
        with_failure(
            Self::new(
                ErrorCode::SshHostUnreachable,
                format!(
                    "SSH tunnel: {} did not answer within {seconds} s.",
                    hop.name_en()
                ),
                format!(
                    "Tunnel SSH : {} n'a pas répondu en {seconds} s.",
                    hop.name_fr()
                ),
            )
            .with_action(ErrorAction::Retry),
            hop.failure(),
        )
    }

    pub fn ssh_handshake_failed(hop: &HopRef) -> Self {
        with_failure(
            Self::new(
                ErrorCode::SshHandshakeFailed,
                format!(
                    "SSH tunnel: the SSH handshake with {} failed (connection closed, or no algorithm in common).",
                    hop.name_en()
                ),
                format!(
                    "Tunnel SSH : la négociation SSH avec {} a échoué (connexion fermée, ou aucun algorithme commun).",
                    hop.name_fr()
                ),
            )
            .with_action(ErrorAction::Retry),
            hop.failure(),
        )
    }

    /// `secret`: the password or passphrase that was used and may be wrong.
    pub fn ssh_auth_failed(hop: &HopRef, user: &str, secret: Option<SecretKind>) -> Self {
        let mut failure = hop.failure();
        failure.secret = secret;
        let error = Self::new(
            ErrorCode::SshAuthFailed,
            format!(
                "SSH tunnel: {} refused the authentication of \"{user}\". Check the user name, the password or key, and that the key is authorized on the server.",
                hop.name_en()
            ),
            format!(
                "Tunnel SSH : {} a refusé l'authentification de « {user} ». Vérifiez le nom d'utilisateur, le mot de passe ou la clé, et que la clé est autorisée sur le serveur.",
                hop.name_fr()
            ),
        );
        let action = if secret.is_some() {
            ErrorAction::EnterPassword
        } else {
            ErrorAction::EditConnection
        };
        with_failure(error.with_action(action), failure)
    }

    pub fn ssh_secret_required(hop: &HopRef, secret: SecretKind) -> Self {
        let mut failure = hop.failure();
        failure.secret = Some(secret);
        let passphrase = matches!(
            secret,
            SecretKind::SshPassphrase | SecretKind::JumpPassphrase
        );
        let (en, fr) = if passphrase {
            (
                format!(
                    "SSH tunnel: the private key for {} is protected by a passphrase.",
                    hop.name_en()
                ),
                format!(
                    "Tunnel SSH : la clé privée pour {} est protégée par une phrase de passe.",
                    hop.name_fr()
                ),
            )
        } else {
            (
                format!("SSH tunnel: a password is required for {}.", hop.name_en()),
                format!(
                    "Tunnel SSH : un mot de passe est requis pour {}.",
                    hop.name_fr()
                ),
            )
        };
        with_failure(
            Self::new(ErrorCode::SshSecretRequired, en, fr).with_action(ErrorAction::EnterPassword),
            failure,
        )
    }

    pub fn ssh_host_key_unknown(hop: &HopRef, key_type: &str, fingerprint: &str) -> Self {
        let mut failure = hop.failure();
        failure.key_type = Some(key_type.to_owned());
        failure.fingerprint = Some(fingerprint.to_owned());
        with_failure(
            Self::new(
                ErrorCode::SshHostKeyUnknown,
                format!(
                    "SSH tunnel: the host key of {} is not known yet ({key_type} {fingerprint}). Check this fingerprint with the server's administrator before trusting it.",
                    hop.name_en()
                ),
                format!(
                    "Tunnel SSH : la clé d'hôte de {} n'est pas encore connue ({key_type} {fingerprint}). Vérifiez cette empreinte auprès de l'administrateur du serveur avant de lui faire confiance.",
                    hop.name_fr()
                ),
            )
            .with_action(ErrorAction::TrustHostKey),
            failure,
        )
    }

    pub fn ssh_host_key_changed(hop: &HopRef, key_type: &str, fingerprint: &str) -> Self {
        let mut failure = hop.failure();
        failure.key_type = Some(key_type.to_owned());
        failure.fingerprint = Some(fingerprint.to_owned());
        with_failure(
            Self::new(
                ErrorCode::SshHostKeyChanged,
                format!(
                    "SSH tunnel: the host key of {} CHANGED (now {key_type} {fingerprint}). Someone may be intercepting the connection, or the server was reinstalled. yadbe refuses to connect. Once the administrator confirms the new key, forget the old one in Preferences › SSH known hosts.",
                    hop.name_en()
                ),
                format!(
                    "Tunnel SSH : la clé d'hôte de {} a CHANGÉ (maintenant {key_type} {fingerprint}). Quelqu'un intercepte peut-être la connexion, ou le serveur a été réinstallé. yadbe refuse de se connecter. Une fois la nouvelle clé confirmée par l'administrateur, oubliez l'ancienne dans Préférences › Hôtes SSH connus.",
                    hop.name_fr()
                ),
            ),
            failure,
        )
    }

    /// The SSH server refuses to open a forwarding channel to `next` (forwarding disabled).
    pub fn ssh_channel_refused(server: &HopRef, next: &HopRef) -> Self {
        with_failure(
            Self::new(
                ErrorCode::SshChannelRefused,
                format!(
                    "SSH tunnel: {} refused to forward the connection to {} (TCP forwarding is disabled for this user, or not allowed to this destination).",
                    server.name_en(),
                    next.name_en()
                ),
                format!(
                    "Tunnel SSH : {} a refusé de relayer la connexion vers {} (le relais TCP est désactivé pour cet utilisateur, ou interdit vers cette destination).",
                    server.name_fr(),
                    next.name_fr()
                ),
            )
            .with_action(ErrorAction::EditConnection),
            next.failure(),
        )
    }

    /// The SSH server could not reach `next` itself (down, wrong host or port).
    pub fn ssh_target_unreachable(server: &HopRef, next: &HopRef) -> Self {
        with_failure(
            Self::new(
                ErrorCode::ConnectionRefused,
                format!(
                    "SSH tunnel: {} could not reach {}. Check the host and port as seen from the SSH server, and that the server is running.",
                    server.name_en(),
                    next.name_en()
                ),
                format!(
                    "Tunnel SSH : {} n'a pas pu joindre {}. Vérifiez l'hôte et le port vus depuis le serveur SSH, et que le serveur est démarré.",
                    server.name_fr(),
                    next.name_fr()
                ),
            )
            .with_action(ErrorAction::EditConnection),
            next.failure(),
        )
    }

    pub fn ssh_agent_unavailable(hop: &HopRef) -> Self {
        with_failure(
            Self::new(
                ErrorCode::SshAgentUnavailable,
                "SSH tunnel: no SSH agent is reachable, or it holds no key. Start the agent and add your key (ssh-add), or choose another authentication method.",
                "Tunnel SSH : aucun agent SSH n'est joignable, ou il ne contient aucune clé. Démarrez l'agent et ajoutez votre clé (ssh-add), ou choisissez une autre méthode d'authentification.",
            )
            .with_action(ErrorAction::EditConnection),
            hop.failure(),
        )
    }

    pub fn ssh_key_unreadable(hop: &HopRef, path: &str) -> Self {
        with_failure(
            Self::new(
                ErrorCode::SshKeyUnreadable,
                format!(
                    "SSH tunnel: the private key \"{path}\" could not be read, or is not a supported key (OpenSSH or PEM; Ed25519, ECDSA or RSA)."
                ),
                format!(
                    "Tunnel SSH : la clé privée « {path} » n'a pas pu être lue, ou n'est pas une clé prise en charge (OpenSSH ou PEM ; Ed25519, ECDSA ou RSA)."
                ),
            )
            .with_action(ErrorAction::EditConnection),
            hop.failure(),
        )
    }

    pub fn ssh_key_passphrase_wrong(hop: &HopRef, path: &str, secret: SecretKind) -> Self {
        let mut failure = hop.failure();
        failure.secret = Some(secret);
        with_failure(
            Self::new(
                ErrorCode::SshKeyPassphraseWrong,
                format!("SSH tunnel: the passphrase of the private key \"{path}\" is wrong."),
                format!(
                    "Tunnel SSH : la phrase de passe de la clé privée « {path} » est incorrecte."
                ),
            )
            .with_action(ErrorAction::EnterPassword),
            failure,
        )
    }

    /// The tunnel cannot carry what the connection needs (UDP browser, a redirection).
    pub fn ssh_tunnel_unsupported(en: impl Into<String>, fr: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, en, fr).with_action(ErrorAction::EditConnection)
    }
}
