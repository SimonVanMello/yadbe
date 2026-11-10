# tiberius 0.13.0, patched for yadbe

The commit `chore(vendor): tiberius 0.13.0 as published on crates.io` holds the crate exactly as
published (0.13.0 is the latest release as of 2026-11). The next commit applies the patches
below; `git diff <that commit> -- src-tauri/vendor/tiberius` shows all of them.

## Why a fork

yadbe's SQL Server driver must show what a SQL editor shows (SPEC §5.3, §5.4, F-061): every
result set of a batch, the rows each statement affected, `PRINT` / `RAISERROR` messages in
order with the batch's errors, and a native cancel that works while rows stream. The
published API cannot do this: `QueryStream` keeps only column metadata and rows, and the
client that could send a cancel is mutably borrowed by the stream. Nothing in the public API
or the feature flags (`rustls`, `tds73`, `chrono` / `time`, `rust_decimal` / `bigdecimal`)
covers these gaps, so every patch below is needed. Each patch is listed with the alternative
that was ruled out.

## Patches

| # | Change | Files | Upstreamable |
|---|---|---|---|
| 1 | Batch stream | `tds/stream/batch.rs` (new), `tds/stream/token.rs`, `tds/codec/token/token_done.rs`, `client.rs`, `lib.rs`, `tds/stream.rs` | Yes, additive API |
| 2 | In-band Attention while a batch streams | `tds/stream/batch.rs`, `client/connection.rs`, `tds/stream/token.rs` | Yes, fixes a documented limit |
| 3 | `Client::in_transaction()` | `client.rs` | Yes, 4 lines |
| 4 | Exact `money` / `smallmoney` | `tds/codec/column_data/money.rs`, `var_len.rs` (test) | Only opt-in: changes `FromSql` for money |
| 5 | rustls with `ring` instead of `aws-lc-rs` | `Cargo.toml`, `client/tls_stream/rustls_tls_stream.rs` | Yes, as a feature flag |
| 6 | Manifest without tests, examples and dev-dependencies | `Cargo.toml` | No (vendoring only) |

1. **Batch stream.** `Client::batch(sql, attention)` sends `sql` as one SQL batch and returns a
   `BatchStream` of `BatchItem`s in the order the server sends them: `Metadata` (names and
   full type info: length, precision, scale), `Row`, `Done` (the statement's row count when
   `DONE_COUNT` is set, and whether it acknowledges an Attention) and `Message` (INFO and ERROR
   tokens with number, state, severity, procedure and line). Server errors are items: the batch
   goes on after a statement error, as SQL Server does. `TokenStream::batch` turns off the
   "first error becomes the stream's end" rule for this stream only.
   *Without it:* `QueryStream` drops INFO tokens (they are only traced at DEBUG level, with no
   number or line), DONE tokens (no per-statement row counts), and keeps only the first ERROR,
   returned after the rows that followed it. Capturing `tracing` events was ruled out: they carry
   the text only and cannot be tied to a connection. `Client::execute` keeps row counts but no
   rows.
2. **In-band Attention.** An `AttentionSignal` armed for the batch is checked by the
   connection's read path: as soon as it is raised, the Attention packet is queued and flushed,
   whatever the decoder is doing (between two tokens, or waiting for the rest of a row the
   server has not sent yet), and without making the reader wait for the write. The token stream
   then reads up to the `DONE_ATTN`, past the end of the current message when the server
   acknowledges in a message of its own. A batch dropped after its Attention went out leaves
   the acknowledgement unread: the next request fails and the connection is marked unusable
   instead of desynchronizing.
   *Without it:* `Client::cancel_query` needs `&mut Client`, which the stream borrows. Dropping
   the stream first loses the bytes of a half-decoded token, so the following reads are
   garbage whenever the server stalls in the middle of a row (a row spanning packets while the
   query waits on a lock or computes the next row; the test
   `cancels_a_batch_stalled_in_the_middle_of_a_row` hung until the lock was released with an
   earlier version of this patch that only sent the Attention between tokens), and its
   `flush_done_attention` stops at the end of the message when the server acknowledges in the
   next one. Cancelling with `KILL` from a second connection was ruled out: it ends the
   session (temporary tables, open transaction, `SET` options) and SPEC §2.2 asks for the TDS
   Attention.
3. **`Client::in_transaction()`.** Whether the transaction descriptor the server reports with
   its ENVCHANGE tokens is set (also `BEGIN TRAN` in T-SQL and rollbacks by `XACT_ABORT`).
   *Without it:* `SELECT @@TRANCOUNT` after every user batch, one extra round trip per
   statement (tens of milliseconds per `GO` batch on Azure SQL).
4. **Exact money.** `money` and `smallmoney` decode to `ColumnData::Numeric` with four
   decimals instead of `ColumnData::F64`.
   *Without it:* an `f64` loses the last digits of amounts above about 10^11 (money goes up
   to 922 337 203 685 477.5807), and user SQL is sent as written, so the driver cannot `CAST`.
5. **ring.** `tokio-rustls` without default features, with `ring`; the fallback crypto
   provider is ring (a process-installed provider still wins, as published).
   *Without it:* the `rustls` feature pulls `aws-lc-rs`, a second crypto library next to the
   ring yadbe already uses for PostgreSQL, built from C (cmake on some platforms, NASM on
   Windows), and larger binaries (P-10).
6. **Manifest.** The `[[test]]` / `[[example]]` targets and the dev-dependencies are dropped:
   their files are not vendored and Cargo refuses explicit targets whose files are missing.
   The crate's own unit tests therefore do not run here; the patches are covered by
   `src-tauri/tests/query_mssql.rs` and `src-tauri/tests/introspection.rs`.

## Maintenance

A new file of about 280 lines (`batch.rs`) and about 100 changed lines in nine upstream files;
`token.rs` and `connection.rs` are where an upgrade may conflict. To upgrade: copy the new
release over `src/` and `Cargo.toml` in a commit of its own, re-apply these patches, then run
`cargo test --test query_mssql --test introspection` against a SQL Server (see `CLAUDE.md`).
Patches 1, 2, 3 and 5 could be proposed upstream (prisma/tiberius); once released there, the
fork shrinks to patch 4 or disappears.
