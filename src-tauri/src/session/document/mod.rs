//! The document family on an open session (M4-2): the command gate every operation goes
//! through, the service behind the `mongo_*` commands (explorer, collection tab, console)
//! and how documents land in the result store.

pub mod gate;
pub mod model;
pub mod results;
pub mod service;

pub use service::DocumentService;
