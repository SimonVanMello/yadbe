//! Connection manager and per-connection sessions (M0-2); query runner, result store and
//! metadata cache arrive with M1.

mod connection;
mod manager;
pub mod meta_cache;
mod model;
pub mod statement_log;

pub use connection::{ConnectionSession, SessionConfig};
pub use manager::ConnectionManager;
pub use model::{ConnectionState, SessionInfo, TestConnectionResult};

#[cfg(test)]
mod tests;
