//! Engine drivers: the only place a driver crate is used.

mod postgres;
mod sqlite;

use std::sync::Arc;

use crate::db::driver::Driver;

/// The drivers this build ships. Engines without one fail with `engineNotSupported`.
pub fn builtin() -> Vec<Arc<dyn Driver>> {
    vec![
        Arc::new(postgres::PostgresDriver),
        Arc::new(sqlite::SqliteDriver),
    ]
}
