//! `ConnectionManager`: one `ConnectionSession` per open connection, connection tests.

use std::sync::Arc;

use crate::db::config::ConnectionDefinition;
use crate::db::dialect::{Engine, EngineInfo};
use crate::db::errors::YadbeError;
use crate::events::EventSink;
use crate::secrets::{Secret, SecretStore};
use crate::session::statement_log::StatementLog;
use crate::session::{SessionInfo, TestConnectionResult};
use crate::store::Store;

pub struct ConnectionManager {
    store: Arc<Store>,
    secrets: Arc<SecretStore>,
    log: Arc<StatementLog>,
    sink: Arc<dyn EventSink>,
}

impl ConnectionManager {
    pub fn new(
        store: Arc<Store>,
        secrets: Arc<SecretStore>,
        log: Arc<StatementLog>,
        sink: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            store,
            secrets,
            log,
            sink,
        }
    }

    pub fn engines(&self) -> Vec<EngineInfo> {
        Engine::ALL
            .into_iter()
            .map(|engine| {
                let dialect = engine.dialect();
                EngineInfo {
                    engine,
                    label: dialect.label().to_owned(),
                    capabilities: dialect.capabilities(),
                    default_username: dialect.default_username().map(str::to_owned),
                    available: false,
                }
            })
            .collect()
    }

    pub async fn test(
        &self,
        request_id: String,
        definition: ConnectionDefinition,
        password: Option<Secret>,
        connection_id: Option<String>,
    ) -> Result<TestConnectionResult, YadbeError> {
        let _ = (
            request_id,
            definition,
            password,
            connection_id,
            &self.store,
            &self.secrets,
            &self.log,
            &self.sink,
        );
        Err(YadbeError::not_implemented())
    }

    pub fn cancel_test(&self, request_id: &str) {
        let _ = request_id;
    }

    pub async fn connect(
        &self,
        connection_id: &str,
        password: Option<Secret>,
    ) -> Result<SessionInfo, YadbeError> {
        let _ = (connection_id, password);
        Err(YadbeError::not_implemented())
    }

    pub async fn disconnect(&self, connection_id: &str) {
        let _ = connection_id;
    }

    pub fn sessions(&self) -> Vec<SessionInfo> {
        Vec::new()
    }
}
