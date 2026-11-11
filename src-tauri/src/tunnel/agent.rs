//! Connection to the user's SSH agent: `SSH_AUTH_SOCK` on Unix; on Windows the OpenSSH
//! agent's named pipe (or `SSH_AUTH_SOCK` naming a pipe), then Pageant.

use std::path::PathBuf;

use russh::keys::agent::client::{AgentClient, AgentStream};

pub type Agent = AgentClient<Box<dyn AgentStream + Send + Unpin + 'static>>;

/// Where to find the agent; `None`: the platform default.
#[derive(Debug, Clone, Default)]
pub struct AgentLocation(pub Option<PathBuf>);

#[cfg(unix)]
pub async fn connect(location: &AgentLocation) -> Result<Agent, String> {
    let path = match &location.0 {
        Some(path) => path.clone(),
        None => std::env::var_os("SSH_AUTH_SOCK")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| "SSH_AUTH_SOCK is not set".to_owned())?,
    };
    AgentClient::connect_uds(&path)
        .await
        .map(AgentClient::dynamic)
        .map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(windows)]
pub async fn connect(location: &AgentLocation) -> Result<Agent, String> {
    const OPENSSH_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";
    let pipe = location
        .0
        .clone()
        .or_else(|| {
            std::env::var_os("SSH_AUTH_SOCK")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| PathBuf::from(OPENSSH_PIPE));
    match AgentClient::connect_named_pipe(pipe.as_os_str()).await {
        Ok(agent) => Ok(agent.dynamic()),
        Err(pipe_err) => AgentClient::connect_pageant()
            .await
            .map(AgentClient::dynamic)
            .map_err(|e| format!("{}: {pipe_err}; Pageant: {e}", pipe.display())),
    }
}

#[cfg(not(any(unix, windows)))]
pub async fn connect(_location: &AgentLocation) -> Result<Agent, String> {
    Err("no SSH agent support on this platform".to_owned())
}
