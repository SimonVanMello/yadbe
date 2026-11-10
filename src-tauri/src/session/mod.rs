//! Connection manager and per-connection sessions (M0-2); query runner, result store and
//! metadata cache arrive with M1.

mod manager;
mod model;
pub mod statement_log;

pub use manager::ConnectionManager;
pub use model::{ConnectionState, SessionInfo, TestConnectionResult};
