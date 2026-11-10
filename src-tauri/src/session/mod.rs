//! Connection manager and per-connection sessions (M0-2); query runner, result store and
//! metadata cache arrive with M1.

mod connection;
pub mod history_hook;
pub mod history_writer;
pub mod library;
mod manager;
pub mod meta_cache;
mod model;
pub mod query_model;
pub mod query_runner;
pub mod result_store;
pub mod result_tap;
pub mod statement_log;
pub mod table_data;
pub mod table_model;
pub mod table_shape;
pub mod table_sql;

pub use connection::{ConnectionSession, SessionConfig};
pub use manager::ConnectionManager;
pub use model::{ConnectionState, SessionInfo, TestConnectionResult};
pub use query_runner::{QueryRunner, RunnerConfig};

#[cfg(test)]
mod tests;
