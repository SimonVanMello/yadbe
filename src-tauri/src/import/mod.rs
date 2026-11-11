//! Data import (M3-10, F-091): a CSV or JSON file written into a table, streamed.
//!
//! `text` decodes the bytes, `csv` / `json` read records, `parse` detects the format and
//! serves records and previews, `convert` turns a cell into the value of a column,
//! `plan` maps columns and builds the statements, `run` is the loop, `manager` the
//! background jobs with their events.

mod convert;
mod csv;
mod json;
pub mod manager;
pub mod model;
mod parse;
pub mod plan;
mod rejects;
pub mod run;
mod text;

pub use manager::ImportManager;
