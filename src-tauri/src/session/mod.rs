//! Connection manager and per-connection sessions (M0-2); query runner, result store and
//! metadata cache arrive with M1.

mod connection;
pub mod history_hook;
mod manager;
mod model;
pub mod query_model;
pub mod query_runner;
pub mod result_store;
pub mod statement_log;

pub use connection::{ConnectionSession, SessionConfig};
pub use manager::ConnectionManager;
pub use model::{ConnectionState, SessionInfo, TestConnectionResult};
pub use query_runner::{QueryRunner, RunnerConfig};

#[cfg(test)]
mod tests;
