//! Database layer: `Value` model, `Driver` traits, `Dialect`, connection definitions, the
//! connection-string parser and the error catalog. Driver crates are used only under
//! `drivers/<engine>/`.

pub mod bound;
pub mod classify;
pub mod config;
pub mod connstring;
pub mod dialect;
pub mod driver;
pub mod drivers;
pub mod edit_dialect;
pub mod errors;
pub mod split;
pub mod value;

pub mod introspect;
pub mod meta;
pub mod script;
