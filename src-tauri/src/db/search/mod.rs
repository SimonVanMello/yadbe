//! The search family (Elasticsearch, OpenSearch, M4-7) above its driver: requests and
//! responses ([`request`]), the console syntax ([`console`]), what a request does
//! ([`classify`]: the read-only allow-list and the dangerous requests), the server and its
//! features ([`server`]), hits and tables as grid rows ([`hits`]), the explorer model
//! ([`meta`]), the connection fields ([`settings`]) and document edits ([`edit`], M4-8, over
//! the exact JSON of [`exact`]). No driver crate here.

pub mod classify;
pub mod console;
pub mod edit;
pub mod exact;
pub mod hits;
pub mod meta;
pub mod request;
pub mod server;
pub mod settings;
