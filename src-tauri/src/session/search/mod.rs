//! The search family on an open session (M4-7): the request gate every request goes through,
//! the service behind the `search_*` commands (explorer, index tab, console) and how answers
//! land in the result store.

pub mod gate;
pub mod model;
pub mod results;
pub mod service;

pub use service::SearchService;
