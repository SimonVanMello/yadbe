# yadbe

A local, cross-platform (Windows, macOS, Linux) SQL database explorer in the spirit of Azure Data Studio: ergonomics, safety and performance first. Built with Tauri 2, React and Rust. Sibling project of yaggui (same themes, primitives and tooling).

- **Local and private**: no account, no telemetry. Passwords live in the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service on Linux), never in yadbe's own database.
- **Transparent**: every statement yadbe runs on its own shows up in the statement log.
- **Safe by default**: TLS with certificate verification for remote hosts, typed errors with a suggested action.

## Status

Milestones **M0 (foundations)**, **M1 (explore and query)** and **M2 (editing, the MVP)** are done, on **PostgreSQL**, **SQL Server** and **SQLite**. MySQL / MariaDB connections can be saved but not opened yet (M3).

- **Connections**: create, edit, duplicate, group, favorite, environment tag (prod tints the window, tabs and every confirmation), paste a connection string (URL, ADO.NET, JDBC), test with typed errors, TLS (verify-full by default for a remote host), automatic reconnection, passwords in the keychain, read-only connections enforced by the backend.
- **Schema explorer**: databases, schemas, tables, views, routines, sequences, types, columns, keys, indexes, constraints, triggers; lazy and virtualized, filter, refresh, Script as SELECT / INSERT / UPDATE / DELETE, open a table's data.
- **Table data** (double-click a table): pages of 100 to 5 000 rows, estimate then exact count (cancellable), filter chips per column and a raw `WHERE`, multi-column sort; editing with a type-aware editor per cell (NULL and empty string kept apart), insert / duplicate / paste / delete rows, pending changes shown in the grid, **Preview SQL** (always on a prod connection), Apply in one transaction where every `UPDATE` / `DELETE` must touch exactly one row; a failure rolls everything back, keeps the changes and points at the row and the constraint. Views, keyless tables and read-only connections say why they cannot be edited.
- **SQL editor** (CodeMirror): schema-aware autocomplete (keywords, schemas, tables, columns, aliases, functions, joins from foreign keys, quoting), run all, selection or the statement under the cursor (dialect-aware splitting, `GO` batches), cancel, auto-commit or manual transactions, dangerous-statement guard, open / save `.sql` files, database switcher, tabs restored with their text.
- **Results**: streamed into a virtualized grid (a row cap, then Load more / Load all), several result sets and messages with error positions, copy as TSV / CSV / JSON / Markdown / INSERT, cell viewer (JSON, XML, binary) with save to file.
- **Export** of a result or a whole table (under the tab's filter and sort) to CSV or JSON, streamed to disk with progress and cancellation, past the in-memory cap.
- **Command palette** (`Ctrl/⌘ K`): actions, connections, objects (open data, Script as, reveal in the explorer), tabs, history.
- **Preferences** (`Ctrl/⌘ ,`): theme, language, density, fonts and sizes, editor options, result caps, NULL text, preview before apply, history retention, connect timeout.
- **History** of every statement run, with full-text search and filters; **statement log** of what yadbe runs on its own.

See `docs/PLAN.md` for the roadmap, `docs/SPEC.md` for the requirements and `docs/validation/M2.md` (and `M0.md`, `M1.md`) for the manual validation checklists and the performance measurements.

## Running it

Requirements: Node 22, pnpm 10, stable Rust ≥ 1.93, and the [Tauri system libraries](https://v2.tauri.app/start/prerequisites/) (WebKitGTK on Linux, WebView2 on Windows). `mise install` sets up the toolchains.

```bash
pnpm install
pnpm tauri dev                    # full app
pnpm tauri build --no-bundle      # release binary in src-tauri/target/release/
pnpm dev                          # frontend only, in the browser, on a mocked backend: http://localhost:1430
```

The app keeps its connections, tabs and preferences in `yadbe.db` in the OS config folder (`dev.tropico.yadbe`); `YADBE_CONFIG_DIR=<folder>` uses another folder.

## Development

```bash
pnpm check        # case check, lint, format, typecheck, unit tests
pnpm test:ui      # Playwright on the mocked backend (captures in test-results/)
pnpm bindings     # regenerate src/ipc/bindings.ts from Rust
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
pnpm perf:tabs    # also perf:grid, perf:palette, perf:completion, perf:explorer, perf:startup (see CLAUDE.md)
```

Integration tests run against real engines when `YADBE_TEST_PG_URL` / `YADBE_TEST_MSSQL_URL` are set (SQLite always runs); `docker compose -f dev/compose.yml up -d` starts PostgreSQL (TLS on, after `dev/tls-certs.sh`) and SQL Server, with the URLs to export in the file's header. The UI primitives are shown at `/#primitives` in `pnpm dev`. See `CLAUDE.md` for the conventions and the full command list.

## License

GPL-3.0-or-later, see `LICENSE`.
