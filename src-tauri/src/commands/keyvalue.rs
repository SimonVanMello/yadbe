//! Key-value connections (Redis, Valkey; M4-5): explorer, key tabs and console. Every command
//! the server receives goes through the command gate (`session::keyvalue::gate`): read-only
//! from the server's own command flags, dangerous commands confirmed with their effect, the
//! statement timeout, the statement log for yadbe's commands and the history for the user's.
//! Another family's connection answers `notSupported`.

use tauri::State;

use crate::db::errors::YadbeError;
use crate::db::keyvalue::KvBytes;
use crate::db::keyvalue::edit::KvChangeSet;
use crate::session::keyvalue::edit::{
    KvApplyOutcome, KvNamespaceCount, KvNamespaceDeleted, KvPreview,
};
use crate::session::keyvalue::model::{
    KvCollection, KvCommandHint, KvConsoleOutcome, KvDatabase, KvFoundKeys, KvKeyInfo,
    KvKeySummary, KvLevel, KvScanStatus, KvStringChunk,
};
use crate::state::AppState;

/// The databases holding keys (`INFO keyspace`) and the connection's own, by index.
#[tauri::command]
#[specta::specta]
pub async fn kv_list_databases(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<KvDatabase>, YadbeError> {
    state.key_values.databases(&connection_id).await
}

/// The key scan of database `database` with `pattern` (`MATCH`; `null` or `*`: every key):
/// the one running, or a new one when there is none or the pattern changed. `SCAN` only, in
/// batches of about 1 000 keys, pausing at 10 000 keys; `kv-scan-progress` reports it.
#[tauri::command]
#[specta::specta]
pub async fn kv_scan_keys(
    state: State<'_, AppState>,
    connection_id: String,
    database: u32,
    pattern: Option<String>,
) -> Result<KvScanStatus, YadbeError> {
    state
        .key_values
        .scan_status(&connection_id, database, pattern)
}

/// Goes on scanning: `count` more keys, or every key left when `null`.
#[tauri::command]
#[specta::specta]
pub async fn kv_scan_more(
    state: State<'_, AppState>,
    connection_id: String,
    database: u32,
    count: Option<u32>,
) -> Result<KvScanStatus, YadbeError> {
    state.key_values.scan_more(&connection_id, database, count)
}

/// Stops the scan between two batches; `kv_scan_more` goes on from there.
#[tauri::command]
#[specta::specta]
pub async fn kv_scan_stop(
    state: State<'_, AppState>,
    connection_id: String,
    database: u32,
) -> Result<KvScanStatus, YadbeError> {
    state.key_values.scan_stop(&connection_id, database)
}

/// Forgets the keys found and scans the database again, with the same pattern.
#[tauri::command]
#[specta::specta]
pub async fn kv_scan_restart(
    state: State<'_, AppState>,
    connection_id: String,
    database: u32,
) -> Result<KvScanStatus, YadbeError> {
    state.key_values.scan_restart(&connection_id, database)
}

/// Entries `[offset, offset + limit)` of the level `prefix` of the key tree: namespaces
/// (keys sharing the next segment before `delimiter`) then keys, among the keys scanned so far.
#[tauri::command]
#[specta::specta]
pub async fn kv_scan_level(
    state: State<'_, AppState>,
    connection_id: String,
    database: u32,
    prefix: KvBytes,
    delimiter: String,
    offset: u32,
    limit: u32,
) -> Result<KvLevel, YadbeError> {
    state
        .key_values
        .scan_level(&connection_id, database, &prefix, &delimiter, offset, limit)
}

/// The keys already scanned whose name contains `text`, at most `limit` (no server round trip):
/// the palette's and the console's key suggestions.
#[tauri::command]
#[specta::specta]
pub async fn kv_find_keys(
    state: State<'_, AppState>,
    connection_id: String,
    database: u32,
    text: String,
    limit: u32,
) -> Result<KvFoundKeys, YadbeError> {
    state
        .key_values
        .find_keys(&connection_id, database, &text, limit)
}

/// The commands the server knows with their arity (`COMMAND`), for the console's completion.
#[tauri::command]
#[specta::specta]
pub async fn kv_command_hints(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<KvCommandHint>, YadbeError> {
    state.key_values.command_hints(&connection_id).await
}

/// Type, time to live and memory of up to 500 keys (the rows on screen), in one round trip.
#[tauri::command]
#[specta::specta]
pub async fn kv_key_summaries(
    state: State<'_, AppState>,
    connection_id: String,
    database: u32,
    keys: Vec<KvBytes>,
) -> Result<Vec<KvKeySummary>, YadbeError> {
    state
        .key_values
        .key_summaries(&connection_id, database, keys)
        .await
}

/// The header of a key tab: type, time to live, encoding, memory, length.
#[tauri::command]
#[specta::specta]
pub async fn kv_key_info(
    state: State<'_, AppState>,
    connection_id: String,
    database: u32,
    key: KvBytes,
) -> Result<KvKeyInfo, YadbeError> {
    state
        .key_values
        .key_info(&connection_id, database, &key)
        .await
}

/// Bytes `[offset, offset + length)` of a string value (at most 1 MiB per call).
#[tauri::command]
#[specta::specta]
pub async fn kv_read_string(
    state: State<'_, AppState>,
    connection_id: String,
    database: u32,
    key: KvBytes,
    offset: u32,
    length: u32,
) -> Result<KvStringChunk, YadbeError> {
    state
        .key_values
        .read_string(&connection_id, database, &key, u64::from(offset), length)
        .await
}

/// A RedisJSON document as JSON text (`JSON.GET`).
#[tauri::command]
#[specta::specta]
pub async fn kv_read_json(
    state: State<'_, AppState>,
    connection_id: String,
    database: u32,
    key: KvBytes,
) -> Result<String, YadbeError> {
    state
        .key_values
        .read_json(&connection_id, database, &key)
        .await
}

/// Opens a hash, list, set, sorted set or stream and reads its first `rows` rows into the
/// result store; the grid reads them with `fetch_result_window`.
#[tauri::command]
#[specta::specta]
pub async fn kv_open_collection(
    state: State<'_, AppState>,
    connection_id: String,
    database: u32,
    key: KvBytes,
    rows: u32,
) -> Result<KvCollection, YadbeError> {
    state
        .key_values
        .open_collection(&connection_id, database, &key, rows)
        .await
}

/// Reads `rows` more rows of an open collection, or all of them when `null`.
#[tauri::command]
#[specta::specta]
pub async fn kv_collection_more(
    state: State<'_, AppState>,
    result_id: u32,
    rows: Option<u32>,
) -> Result<KvCollection, YadbeError> {
    state.key_values.collection_more(result_id, rows).await
}

/// Frees an open collection.
#[tauri::command]
#[specta::specta]
pub async fn kv_close_collection(
    state: State<'_, AppState>,
    result_id: u32,
) -> Result<(), YadbeError> {
    state.key_values.close_collection(result_id);
    Ok(())
}

/// Runs the command lines of a console tab in order, as typed (`redis-cli` quoting), on the
/// tab's own connection. Without `confirmed`, a dangerous command (`FLUSHALL`, `KEYS`…) makes
/// the call return `needsConfirmation` with its effect, and nothing runs. Stops at the first
/// failure; `MONITOR`, `SUBSCRIBE` and blocking commands are refused (`notSupported`).
#[tauri::command]
#[specta::specta]
pub async fn kv_console_run(
    state: State<'_, AppState>,
    tab_id: String,
    connection_id: String,
    text: String,
    confirmed: bool,
) -> Result<KvConsoleOutcome, YadbeError> {
    state
        .key_values
        .console_run(&tab_id, &connection_id, &text, confirmed)
        .await
}

/// Stops a console run after its current command (a running command cannot be stopped).
#[tauri::command]
#[specta::specta]
pub async fn kv_console_stop(state: State<'_, AppState>, tab_id: String) -> Result<(), YadbeError> {
    state.key_values.console_stop(&tab_id);
    Ok(())
}

/// Frees a console tab's results and closes its connection.
#[tauri::command]
#[specta::specta]
pub async fn kv_console_close(
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), YadbeError> {
    state.key_values.console_close(&tab_id).await;
    Ok(())
}

// --- Edits (M4-6) ---------------------------------------------------------------------------

/// The commands Apply would run for a change set, in order (`WATCH`, the checks, `MULTI`, the
/// commands, `EXEC`), and the dangers to confirm with their measured effect.
#[tauri::command]
#[specta::specta]
pub async fn kv_preview_changes(
    state: State<'_, AppState>,
    connection_id: String,
    changes: KvChangeSet,
) -> Result<KvPreview, YadbeError> {
    state
        .key_values
        .preview_changes(&connection_id, &changes)
        .await
}

/// Applies a change set in one transaction, checked against what the user saw (`WATCH`):
/// `conflicted` when the server holds something else (nothing applied), `needsConfirmation`
/// for dangerous changes not `confirmed`. Journaled. Refused on a read-only connection.
#[tauri::command]
#[specta::specta]
pub async fn kv_apply_changes(
    state: State<'_, AppState>,
    connection_id: String,
    changes: KvChangeSet,
    confirmed: bool,
) -> Result<KvApplyOutcome, YadbeError> {
    state
        .key_values
        .apply_changes(&connection_id, &changes, confirmed)
        .await
}

/// What reverting a key-value journal entry would run.
#[tauri::command]
#[specta::specta]
pub async fn kv_preview_revert(
    state: State<'_, AppState>,
    connection_id: String,
    entry_id: u32,
) -> Result<KvPreview, YadbeError> {
    state
        .key_values
        .preview_revert(&connection_id, entry_id)
        .await
}

/// Reverts a key-value journal entry: its inverse, applied with the same checks.
#[tauri::command]
#[specta::specta]
pub async fn kv_apply_revert(
    state: State<'_, AppState>,
    connection_id: String,
    entry_id: u32,
) -> Result<KvApplyOutcome, YadbeError> {
    state
        .key_values
        .apply_revert(&connection_id, entry_id)
        .await
}

/// The keys under `prefix` (a full `SCAN … MATCH prefix*`), before deleting the namespace.
#[tauri::command]
#[specta::specta]
pub async fn kv_namespace_count(
    state: State<'_, AppState>,
    connection_id: String,
    database: u32,
    prefix: KvBytes,
) -> Result<KvNamespaceCount, YadbeError> {
    state
        .key_values
        .namespace_count(&connection_id, database, &prefix)
        .await
}

/// Deletes every key under `prefix`, by atomic batches of 500 (`UNLINK`), journaled.
#[tauri::command]
#[specta::specta]
pub async fn kv_delete_namespace(
    state: State<'_, AppState>,
    connection_id: String,
    database: u32,
    prefix: KvBytes,
) -> Result<KvNamespaceDeleted, YadbeError> {
    state
        .key_values
        .delete_namespace(&connection_id, database, &prefix)
        .await
}
