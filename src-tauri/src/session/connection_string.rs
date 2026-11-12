//! "Copy as ADO.NET / EF Core connection string" (F-143) for a saved connection: the
//! definition from the store, the password from the keychain only when the user asked for it.
//! Blocking (store, keychain): callers run it off the async threads.

use crate::db::dotnet::{self, ConnectionStringCopy, ConnectionStringFlavor};
use crate::db::errors::YadbeError;
use crate::secrets::{SecretKind, SecretStore};
use crate::store::Store;

/// The copy of a saved connection. With `include_password` the password is read through
/// `secrets/` (session first, then the keychain), written into the returned text and nowhere
/// else; `passwordRequired` when none is stored.
pub fn copy_connection_string(
    store: &Store,
    secrets: &SecretStore,
    connection_id: &str,
    flavor: ConnectionStringFlavor,
    include_password: bool,
) -> Result<ConnectionStringCopy, YadbeError> {
    let definition = store.connection(connection_id)?.definition;
    let dialect = definition
        .engine
        .sql_dialect()
        .ok_or_else(YadbeError::sql_only)?;
    let password = if include_password && !definition.engine.capabilities().uses_file {
        Some(
            secrets
                .get(connection_id, SecretKind::Password)?
                .ok_or_else(YadbeError::password_required)?,
        )
    } else {
        None
    };
    Ok(dotnet::build(
        dialect,
        &definition,
        flavor,
        password.as_ref(),
    ))
}
