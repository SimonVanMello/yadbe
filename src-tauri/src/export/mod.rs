//! Streaming exports (M2-7): a result written to CSV or JSON without loading it in memory.
//!
//! `source` reads rows (the query result today, a table later), `encode` / `csv` / `json`
//! turn them into bytes, `run` writes them to a temporary file renamed over the target at
//! the end, and `manager` runs that as a cancellable background job with events.

mod csv;
pub mod encode;
mod json;
mod lines;
pub mod manager;
mod markdown;
pub mod model;
pub mod run;
pub mod source;
mod sql;
pub mod xlsx;

pub use manager::ExportManager;

#[cfg(test)]
mod format_tests;
#[cfg(test)]
mod io_tests;
#[cfg(test)]
mod lines_tests;
#[cfg(test)]
mod tests;
