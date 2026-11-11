//! Engine drivers: the only place a driver crate is used.

mod mssql;
mod mysql;
mod postgres;
mod sqlite;

use std::sync::Arc;

use crate::db::driver::Driver;

/// The drivers this build ships. Engines without one fail with `engineNotSupported`.
pub fn builtin() -> Vec<Arc<dyn Driver>> {
    vec![
        Arc::new(postgres::PostgresDriver),
        Arc::new(mssql::MssqlDriver),
        Arc::new(mysql::MysqlDriver),
        Arc::new(sqlite::SqliteDriver),
    ]
}
