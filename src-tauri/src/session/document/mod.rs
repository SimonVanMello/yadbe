//! The document family on an open session (M4-2): the command gate every operation goes
//! through, the service behind the `mongo_*` commands (explorer, collection tab, query tab)
//! and how documents land in the result store; the mongosh runtime of the query tab (M4-3); edits of a collection's documents, their journal and reverts (M4-4).

pub mod edit;
pub mod gate;
pub mod model;
pub mod results;
pub mod script;
pub mod service;

pub use service::DocumentService;
