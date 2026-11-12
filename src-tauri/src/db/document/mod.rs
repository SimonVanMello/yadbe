//! The document family (MongoDB, M4-2): its value model above the driver. Documents cross
//! as canonical Extended JSON in an order-keeping [`json::Json`]; [`ops::DocOp`] is what can
//! be asked of a server, [`classify`] decides what it does (read-only allow-list, danger),
//! [`ejson`] maps values to grid cells and back, [`meta`] is what the explorer shows and
//! [`settings`] the connection fields and strings. No driver crate here.

pub mod classify;
pub mod ejson;
pub mod json;
pub mod meta;
pub mod ops;
pub mod settings;
