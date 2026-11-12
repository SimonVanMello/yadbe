//! The fields of a search connection besides the common ones (host, port, TLS, user): how it
//! authenticates and the path the API is served under. The secret (password, API key or
//! token) is the connection's password, kept in the keychain like the others.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::errors::YadbeError;

/// How requests authenticate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SearchAuth {
    /// No `Authorization` header (security off, or a proxy in front).
    None,
    /// User name and password (`Authorization: Basic`).
    #[default]
    Basic,
    /// An API key, as the server encodes it (`Authorization: ApiKey <encoded>`).
    ApiKey,
    /// A bearer token (`Authorization: Bearer <token>`: service tokens, OAuth / OIDC).
    Bearer,
}

impl SearchAuth {
    /// The secret is asked for and kept like a password.
    pub fn has_secret(self) -> bool {
        self != SearchAuth::None
    }
}

/// What only search connections have. `null` on the other families.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchSettings {
    #[serde(default)]
    pub auth: SearchAuth,
    /// The path the API is served under behind a proxy (`/elasticsearch`); `null`: the root.
    #[serde(default)]
    pub path_prefix: Option<String>,
}

const MAX_PREFIX_CHARS: usize = 200;

impl SearchSettings {
    /// A prefix starts with `/` and does not end with one; an empty one is none.
    pub fn normalized(mut self) -> Result<Self, YadbeError> {
        self.path_prefix = self
            .path_prefix
            .map(|p| p.trim().trim_matches('/').to_owned())
            .filter(|p| !p.is_empty())
            .map(|p| format!("/{p}"));
        if let Some(prefix) = &self.path_prefix
            && (prefix.chars().count() > MAX_PREFIX_CHARS || prefix.contains(['?', '#', ' ', '\\']))
        {
            return Err(YadbeError::invalid_argument(
                "The path of the URL is a plain path (/elasticsearch), without spaces, ? or #.",
                "Le chemin de l'URL est un chemin simple (/elasticsearch), sans espace, ? ni #.",
            ));
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_are_normalized() {
        let settings = |prefix: &str| SearchSettings {
            auth: SearchAuth::Basic,
            path_prefix: Some(prefix.to_owned()),
        };
        assert_eq!(
            settings(" es/ ").normalized().expect("ok").path_prefix,
            Some("/es".into())
        );
        assert_eq!(settings("/").normalized().expect("ok").path_prefix, None);
        assert!(settings("/a?b").normalized().is_err());
        let json = serde_json::to_value(SearchAuth::ApiKey).expect("json");
        assert_eq!(json, "apiKey");
    }
}
