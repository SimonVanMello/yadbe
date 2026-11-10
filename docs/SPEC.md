# yadbe — Specification

> Local, cross-platform (Windows / macOS / Linux) SQL database explorer, focused on ergonomics and performance.
> UX references: Azure Data Studio, TablePlus, DataGrip. Visual reference: yaggui (same themes, same primitives).

Version 0.1 — November 2026

---

## 1. Vision and principles

**Goal**: connect to a database in seconds, look at the data, change it safely, and never lose a query. Everything common takes one click or one shortcut; everything dangerous is understandable before it runs.

Guiding principles, in priority order when they conflict:

1. **Never damage the user's data by accident.** Edits are buffered, previewed as SQL and applied in one transaction. Production connections are visibly different and can be read-only. Statements that change many rows are confirmed with their concrete effect.
2. **Never leak a secret.** Passwords and tokens live in the OS keychain only. They are never written to the app database, logs, history, error messages or frontend payloads.
3. **Fast, all the time.** The UI never blocks on the network. Results stream; a grid of a million rows scrolls at the display refresh rate; every query can be cancelled.
4. **Never lose a query.** Every executed statement goes to a searchable history; editor tabs survive a crash or a restart, saved or not.
5. **The engine's behavior is the behavior.** yadbe sends the SQL the user wrote, untouched. No hidden rewriting, except the documented row limit of table browsing.
6. **Transparent.** Every statement yadbe runs on its own (metadata, edits, session setup) can be inspected in a log.

**100% local**: no account, no telemetry, no network call other than the database connections themselves and, opt-in, update checks.

### Out of scope (v1)

NoSQL engines, server administration (backup/restore, user and role management, server configuration), notebooks, schema migration tooling, AI-generated SQL, cloud sync, team sharing. Possible evolutions are listed in §11.

---

## 2. Technical choices

### 2.1 Stack

Same shell and frontend stack as yaggui, so primitives, themes, i18n and tooling are ported rather than rewritten.

| Layer | Choice | Rationale |
|---|---|---|
| App shell | **Tauri 2** | Small binary, low idle RAM, native Rust backend. |
| Frontend | React 19 + strict TypeScript + Vite + pnpm | Same as yaggui. |
| Frontend state | Zustand (UI) + TanStack Query (server data) | Metadata and result windows are cached and invalidated precisely. |
| Styles | CSS Modules + CSS variable tokens, Radix UI primitives | Graphite (dark) and Paper (light) themes taken from yaggui. |
| SQL editor | **CodeMirror 6** (`@codemirror/lang-sql`, dialect per engine) | Light, extensible completion source fed by the cached schema. |
| Result grid | In-house grid on TanStack Virtual (rows **and** columns) | Existing grids are heavy or licensed; only visible cells exist in the DOM. Falls back to canvas if P-04 is not met on WebKitGTK. |
| Async runtime | `tokio` | Required by the drivers. |
| PostgreSQL | **`tokio-postgres`** + `rustls` | Dynamic typing, simple-query protocol (multi-statement scripts), cancel tokens, notices. `sqlx` is designed for compile-time-known queries and hides what an explorer needs. |
| SQL Server | **`tiberius`** | The only maintained pure-Rust TDS driver. SQL logins and Entra ID tokens; integrated auth is V2. |
| MySQL / MariaDB | `mysql_async` | Native async driver. |
| SQLite | `rusqlite` (bundled) | Also used for the app store. |
| Secrets | **`keyring`** | macOS Keychain, Windows Credential Manager, Secret Service (Linux). |
| SSH tunnels | `russh` | No dependency on a system `ssh`; V1. |
| Bindings | `tauri-specta` | TS types and commands generated from Rust. |
| App store | SQLite (`rusqlite`) in the OS config folder, versioned migrations | Connections (without secrets), tabs, history, saved queries, preferences. |
| Tests | Vitest + Testing Library, Playwright on a mocked backend, `cargo test` against real engines | |

### 2.2 Architecture

```
┌──────────────────────────── Frontend (WebView) ────────────────────────────┐
│  Tabs ─ Explorer ─ Editor(CodeMirror) ─ Grid(virtualized) ─ Palette        │
│  Zustand (UI)          TanStack Query (metadata, result windows)           │
└───────────────▲────────────────────────────────────────┬───────────────────┘
                │ events (query-progress, query-finished, │ invoke(commands)
                │ connection-state, statement-logged)     ▼
┌─────────────────────────────── Rust backend ───────────────────────────────┐
│  ConnectionManager (1 ConnectionSession per open connection)               │
│   ├─ Driver trait   : connect, execute (stream), cancel, introspect        │
│   │    └─ drivers/{postgres, mssql, mysql, sqlite}  + Dialect (quoting,    │
│   │       paging, type names, capabilities)                                │
│   ├─ QueryRunner    : one running query per editor tab, cancellation,      │
│   │                   messages / notices, timing                           │
│   ├─ ResultStore    : rows kept backend-side (memory-capped), served to    │
│   │                   the grid in windows of 500 rows                      │
│   ├─ MetaCache      : schemas, tables, columns, keys; lazy, refreshable    │
│   ├─ EditPlanner    : change set → parameterized DML in one transaction    │
│   └─ StatementLog   : everything yadbe ran on its own                      │
│  Secrets (OS keychain)      AppStore (SQLite): connections, tabs,          │
│                             history, saved queries, preferences            │
└────────────────────────────────────────────────────────────────────────────┘
```

Architecture rules:

- **One value model.** Drivers decode into a common `Value` enum (null, bool, integers, decimal as string, float, text, bytes, date/time types, uuid, json, array, unknown-as-text). The frontend never sees a driver type. Lossless: decimals, 64-bit integers and timestamps cross the IPC as strings.
- **Rows stay in the backend.** A result set lives in the `ResultStore`; the grid asks for windows. A result is capped (default 100 000 rows / 256 MB, configurable); past the cap the fetch pauses and the user chooses to continue.
- **Sessions.** Each editor tab owns a dedicated server connection (its own transaction state, `search_path`, temp tables). Metadata and table browsing share one pooled connection per `ConnectionSession`.
- **Cancellation is native**: Postgres cancel request, TDS attention, `KILL QUERY` on MySQL, `sqlite3_interrupt`.
- **Values are always bound.** Generated DML binds values as parameters and quotes identifiers through the dialect. No value is ever concatenated into SQL.

---

## 3. Performance targets

Reference machine: 2023 mid-range laptop (8 cores, 16 GB, NVMe SSD). Database on localhost.

| ID | Measure | Target |
|---|---|---|
| P-01 | Cold start until the window is interactive | < 800 ms |
| P-02 | Connection established → explorer tree shown (500 tables) | < 400 ms over the connect time |
| P-03 | Query sent → first rows painted, for a 1M-row result | < 200 ms over the server's time-to-first-row |
| P-04 | Grid scrolling, 100k rows × 50 columns, both axes | sustained 60 fps, no frame > 32 ms |
| P-05 | Autocomplete suggestions on a 10k-object schema | < 50 ms per keystroke |
| P-06 | Palette fuzzy search over 10k objects | < 30 ms per keystroke |
| P-07 | Tab switch | < 50 ms |
| P-08 | History search over 100k entries | < 100 ms |
| P-09 | Idle RAM, 3 connections open, no result | < 300 MB |
| P-10 | Installer size | < 25 MB |

---

## 4. Overall layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  [Query 1 ×] [orders ×] [Query 2 • ×]  [+]                      ⌘K     │ ← tab bar
├──────────────────────────────────────────────────────────────────────────────┤
│ ▶ Run  ■ Cancel │ ⟳ Commit  ⤺ Rollback │ auto-commit ▾ │ [PROD] shop@pg-eu ▾ │ ← toolbar
├──────────────┬───────────────────────────────────────────────────────────────┤
│ CONNECTIONS  │  1  select o.id, o.total, c.email                             │
│ ▾ ● pg-eu    │  2  from orders o join customers c on c.id = o.customer_id    │
│   ▾ shop     │  3  where o.created_at > now() - interval '1 day';            │
│     ▾ public │                                                               │
│       ▸ Tables (42)                                                          │
│       ▸ Views├───────────────────────────────────────────────────────────────┤
│       ▸ Functions  Result 1 │ Result 2 │ Messages                            │
│ ▸ ○ local-mssql│  id   │ total    │ email                │                   │
│ ▸ ○ app.sqlite │  9412 │   129.90 │ ana@example.com      │                   │
│              │  9413 │    18.00 │ NULL                 │                   │
│ HISTORY      │                                                               │
│ SAVED        │                                                               │
├──────────────┴───────────────────────────────────────────────────────────────┤
│ ✓ 1 284 rows · 38 ms            Ln 3, Col 12 · PostgreSQL 17.2 · 2 pending ⌄ │ ← status bar
└──────────────────────────────────────────────────────────────────────────────┘
```

Tabs are editor tabs (SQL) or table tabs (data browsing/editing); each is bound to one connection and one database. The sidebar and the result panel are resizable and collapsible, sizes remembered. The window is tinted by the connection's environment color (thin top border + connection chip).

---

## 5. Functional requirements

Priorities: **MVP** (daily use), **V1** (public release), **V2** (after v1).

### 5.1 Connections

| ID | Requirement | Prio |
|---|---|---|
| F-001 | Create, edit, duplicate, delete a connection: engine, host, port, database, user, auth method, TLS mode, options. Engine-specific forms. | MVP |
| F-002 | Engines: PostgreSQL, SQL Server (incl. Azure SQL), SQLite (file). | MVP |
| F-003 | MySQL / MariaDB. | V1 |
| F-004 | **Test connection** with a typed, translated error (DNS, refused, timeout, TLS, auth, unknown database) and a suggested action. | MVP |
| F-005 | **Secrets in the OS keychain.** "Remember password" stores it there; otherwise it is asked at connect time and kept in memory for the session. If no keychain is available (headless Linux), session-only is the only mode and the UI says so. | MVP |
| F-006 | Paste a connection string to fill the form: URL (`postgres://`, `mysql://`, `sqlserver://`), ADO.NET (`Server=…;Database=…;User Id=…`), JDBC. The password part goes to the keychain, never to the store. | MVP |
| F-007 | Groups (folders), environment tag (dev / staging / prod / custom) with a color, favorites, fuzzy search. | MVP |
| F-008 | **Read-only connection**: enforced backend-side (session set read-only where the engine supports it + statement classification), not only hidden buttons. | MVP |
| F-009 | TLS: disable / prefer / require / verify-full, custom CA, client certificate. | MVP (modes), V1 (client cert) |
| F-010 | SSH tunnel (password, key, agent; jump host). Key passphrase in the keychain. | V1 |
| F-011 | Entra ID (Azure AD) authentication for Azure SQL: interactive browser flow, token cached in the keychain. | V1 |
| F-012 | Import connections from Azure Data Studio / SSMS, DBeaver, `pgpass`, `~/.pg_service.conf`. Export / import yadbe connections as a file **without secrets**. | V1 |
| F-013 | Auto-reconnect on a dropped connection, with a visible state; never silently replays a statement. | MVP |
| F-014 | Keep-alive and configurable connect / statement timeouts per connection. | V1 |
| F-015 | Detect local databases: Docker containers exposing a known engine, default local ports. | V2 |

### 5.2 Explorer (sidebar)

| ID | Requirement | Prio |
|---|---|---|
| F-020 | Tree: connection → database → schema → tables, views, materialized views, functions / procedures, sequences, types. Lazy loading, counts, virtualized. | MVP |
| F-021 | Table node expands to columns (type, nullability, default, PK/FK icons), indexes, constraints, triggers. | MVP |
| F-022 | Filter box (fuzzy, across loaded schemas), refresh at any node. | MVP |
| F-023 | Double-click a table → table tab (§5.5). Context menu: open data, new query, **Script as** SELECT / INSERT / UPDATE / DELETE / CREATE, copy qualified name, refresh. | MVP |
| F-024 | DDL view of any object (reconstructed or from the catalog), read-only, copyable. | V1 |
| F-025 | Table properties: row estimate, size on disk, last analyze/vacuum (when the engine exposes them). | V1 |
| F-026 | Drop / truncate / rename from the tree, with a confirmation showing the exact statement and requiring the object name for `DROP` on a prod-tagged connection. | V1 |
| F-027 | Pin objects and schemas at the top; hide system schemas by default. | V1 |

### 5.3 SQL editor

| ID | Requirement | Prio |
|---|---|---|
| F-040 | Editor tabs with syntax highlighting per dialect, multi-cursor, find/replace, bracket matching, comment toggle, indentation. | MVP |
| F-041 | Run all (`⌘↵`), run selection, **run statement under cursor** (`⌘⇧↵`); the statement about to run is highlighted. Statement splitting is dialect-aware (`GO` batches on SQL Server, dollar-quoting on Postgres, `DELIMITER` on MySQL). | MVP |
| F-042 | Cancel a running query (`⌘.`); elapsed time shown live. | MVP |
| F-043 | **Schema-aware autocomplete**: keywords, schemas, tables, columns (resolving aliases and CTEs in the current statement), functions; join suggestions from foreign keys. | MVP (objects, columns), V1 (aliases, joins) |
| F-044 | Tabs restored on restart with their content, cursor and connection, saved or not (autosave to the store every few seconds). | MVP |
| F-045 | Open / save `.sql` files; dirty indicator; external change detection. | MVP |
| F-046 | Switch the tab's connection / database from the toolbar. | MVP |
| F-047 | **Transaction mode** per tab: auto-commit (default) or manual with Commit / Rollback buttons and an "open transaction" indicator; closing a tab with an open transaction asks. | MVP |
| F-048 | Query parameters: `:name` / `@name` / `$1` placeholders prompt for typed values, remembered per tab. | V1 |
| F-049 | Format SQL (selection or document). | V1 |
| F-050 | Snippets with placeholders; saved queries library (folders, fuzzy search, per-connection or global). | V1 |
| F-051 | **Dangerous statement guard**: `UPDATE` / `DELETE` without `WHERE`, `TRUNCATE`, `DROP` ask for confirmation; always on for prod-tagged connections, configurable elsewhere. | MVP |
| F-052 | Hover an object name → columns and types; `F12` / `⌘click` → reveal in explorer. | V1 |
| F-053 | Explain: `EXPLAIN (ANALYZE)` / estimated and actual plans rendered as a tree with the costly nodes highlighted. | V1 |

### 5.4 Results

| ID | Requirement | Prio |
|---|---|---|
| F-060 | Virtualized grid: sticky header and row numbers, resizable / reorderable / auto-fit columns, type-aware alignment and formatting, distinct rendering of `NULL`, empty string and whitespace. | MVP |
| F-061 | Multiple result sets per run (one sub-tab each) + **Messages** (notices, `PRINT`, rows affected, timings, errors with line/position; clicking an error jumps to the editor position). | MVP |
| F-062 | Streaming: rows appear while the server sends them; row count and elapsed time live. Result cap with "Load more / Load all". | MVP |
| F-063 | Selection of cells / rows / columns (mouse and keyboard), copy as TSV (default), CSV, JSON, Markdown, SQL `INSERT`, `IN (…)` list. | MVP |
| F-064 | Cell viewer panel for long text, JSON / XML (pretty-printed, foldable), binary (hex + size), with copy and save to file. | MVP |
| F-065 | Client-side sort and filter on a loaded result; quick aggregate (count, sum, avg, min, max) of the selection in the status bar. | V1 |
| F-066 | Export a result or a table to CSV, JSON, SQL inserts, Markdown, Excel; streamed to disk without loading everything in memory, cancellable. | MVP (CSV, JSON), V1 (others) |
| F-067 | Pin a result so the next run opens beside it; compare two results (row diff by key). | V2 |
| F-068 | Row detail view (one row as a vertical form), useful on wide tables. | V1 |
| F-069 | Quick chart of a result (bar / line / scatter). | V2 |

### 5.5 Table data: browsing and editing

| ID | Requirement | Prio |
|---|---|---|
| F-080 | Table tab: paged browsing (server-side `ORDER BY` / `LIMIT`), page size configurable, total count estimated then exact on demand. | MVP |
| F-081 | **Filter bar**: per-column filters (=, ≠, <, >, contains, starts with, in, is null…) built into a parameterized `WHERE`, plus a raw `WHERE` field. Sort by clicking headers (multi-column with `⇧`). | MVP |
| F-082 | **Inline editing**: double-click or `↵` edits a cell with a type-aware editor (text, number, boolean, date/time, enum, JSON, `NULL` toggle with `⌘⌫`). | MVP |
| F-083 | Insert rows (empty, duplicated, pasted from TSV / CSV), delete rows. | MVP |
| F-084 | **Pending changes**: edits are buffered and color-coded (modified cell, new row, deleted row); nothing is sent until Apply. Revert a cell, a row or everything. | MVP |
| F-085 | **Preview SQL** of the pending changes; Apply (`⌘S`) runs them in one transaction, reports per-statement failures and rolls back entirely on error. Each `UPDATE` / `DELETE` is checked to affect exactly one row. | MVP |
| F-086 | Editing requires a primary key or a non-null unique key; otherwise the table is read-only with the reason shown. Generated / computed / identity columns are not editable; defaults are applied when a new row leaves a column untouched. | MVP |
| F-087 | Results of a `SELECT` on a single table that includes its key are editable with the same mechanism. | V1 |
| F-088 | **Foreign key navigation**: jump from a FK value to the referenced row; list the rows referencing the current row; FK cell editor with lookup of the referenced table. | V1 |
| F-089 | Optimistic concurrency: the `WHERE` of an update includes the original values of the edited columns; a row changed by someone else is reported instead of overwritten. | V1 |
| F-090 | **Change journal**: every applied change set is recorded with its inverse statements; "Revert this change set" generates the script and applies it after preview. | V1 |
| F-091 | Import CSV / JSON into a table with column mapping, type preview and a dry run. | V1 |
| F-092 | Set a value on many selected cells at once; find and replace in a column (previewed as SQL). | V2 |

### 5.6 History

| ID | Requirement | Prio |
|---|---|---|
| F-100 | Every executed statement is recorded: text, connection, database, start time, duration, rows returned / affected, success or error message. Stored locally, bounded (default 50 000 entries or 12 months). | MVP |
| F-101 | History panel: newest first, virtualized, full-text search, filters (connection, status, date, duration). Enter → open in a new tab; `⌘↵` → insert at cursor; copy. | MVP |
| F-102 | Per-tab history (previous versions of what was run in this tab). | V1 |
| F-103 | Star an entry / save it to the library (F-050). | V1 |
| F-104 | Privacy: history can be disabled per connection; "Clear history" (all / per connection / range). The text is stored as written, so a secret typed in a statement is the user's to clear; the docs say so. | MVP |

### 5.7 Palette, keyboard, shell

| ID | Requirement | Prio |
|---|---|---|
| F-120 | `⌘K` palette: actions (stable IDs), connections, database objects (fuzzy over the cached schema), open tabs, saved queries, history. | MVP |
| F-121 | Every action reachable from the keyboard; rebindable shortcuts. | MVP (defaults), V1 (rebinding) |
| F-122 | Tabs: reorder, close, reopen closed, pin, `⌘1…9`, `⌃Tab`. | MVP |
| F-123 | Welcome screen: recent and favorite connections, new connection, open file. | MVP |
| F-124 | Statement log panel (what yadbe ran on its own), toasts, typed errors with a suggested action. | MVP |
| F-125 | Preferences: theme, density, fonts, default page size and result cap, null rendering, date / number formats, confirmations, history retention, keybindings. | MVP |
| F-126 | CLI: `yadbe <file.sql>`, `yadbe <connection-url>` (password prompted, never taken from argv into any store). | V1 |

### 5.8 Tools

| ID | Requirement | Prio |
|---|---|---|
| F-140 | Activity monitor: running sessions / queries (`pg_stat_activity`, `sys.dm_exec_requests`, `SHOW PROCESSLIST`), locks, kill with confirmation. | V1 |
| F-141 | ER diagram of a schema or of a table's neighborhood (auto-layout, export SVG / PNG). | V2 |
| F-142 | Schema compare between two connections, with a generated migration script. | V2 |
| F-143 | EF Core awareness: `__EFMigrationsHistory` shown as a migrations timeline; copy a connection as an ADO.NET / EF Core connection string (without password by default). | V1 |
| F-144 | Global search of a value across the text columns of a schema (bounded, cancellable). | V2 |

---

## 6. Cross-cutting UX requirements

- **Keyboard first, mouse complete**: every action is in a menu or a button, and in the palette.
- **Environment always visible**: connection chip with name, database and environment color in the toolbar and on each tab.
- **Empty, loading and error states** are designed for every panel; an error always says what happened and what to do.
- **Nothing blocks**: any network call shows progress after 150 ms and can be cancelled.
- **Accessibility**: focus visible, ARIA roles on the grid (`grid`, `row`, `gridcell`), WCAG AA contrast in both themes.
- **i18n**: French and English, switchable live. SQL, object names and server messages are never translated.
- **Platform conventions**: `⌘` on macOS, `Ctrl` elsewhere; native window controls and menus.

## 7. UI style

Themes **Graphite** (dark) and **Paper** (light), tokens copied from yaggui's `src/theme` (`tokens.css`, `graphite.css`, `paper.css`), fonts Inter and JetBrains Mono bundled. The grid and the editor use the mono font. Additions specific to yadbe: environment colors (`--env-dev`, `--env-staging`, `--env-prod`, custom), cell state colors (modified, inserted, deleted, null), SQL syntax colors.

## 8. Persisted data

SQLite in the OS config folder (`yadbe.db`): `connections` (no secret column), `connection_groups`, `tabs` (kind, connection, content, cursor, order, pinned), `history` (+ FTS5 index), `saved_queries`, `change_journal`, `preferences`, `meta_cache` (optional, per connection). Versioned migrations. Secrets: OS keychain, service `dev.tropico.yadbe`, account `<connection-uuid>:<kind>` (`password`, `ssh-passphrase`, `token`).

## 9. Security

- Secrets: keychain only (§8). The `Secret` type has a redacted `Debug` / `Display`, is not `Serialize`, and is zeroized on drop. Commands that take a password receive it once and hand it to the keychain or the session.
- Connection strings in logs and errors are redacted. The statement log and the history never contain bound parameter values of generated DML beyond what the SQL preview shows.
- TLS through `rustls`; `verify-full` is the default for non-local hosts; a downgrade is an explicit user choice.
- Tauri: strict CSP, minimal capabilities, no remote content. File access only through explicit open / save dialogs.
- Exported connection files never contain secrets.

## 10. Quality and tests

- Rust integration tests run against real engines: SQLite always; PostgreSQL, SQL Server and MySQL when `YADBE_TEST_PG_URL` / `YADBE_TEST_MSSQL_URL` / `YADBE_TEST_MYSQL_URL` are set (CI provides them through service containers; locally `docker compose -f dev/compose.yml up`). A test that needs an absent engine is skipped with a visible notice, never silently passed.
- Each driver passes the same conformance suite: type round-trips, multi-statement scripts, cancellation, errors with position, introspection of a fixture schema, edit plans.
- Fixture schemas are created by script (`src-tauri/tests/fixtures/`).
- Frontend: Vitest for stores, parsing (statement splitter, connection strings), grid math; Playwright on the mocked backend with captures in both themes.
- Benchmarks for the `P-xx` targets are scripts, reproducible locally.

## 11. Roadmap

M0 foundations → M1 explore and query → M2 edit (= MVP) → M3 comfort (= V1) → V2. Details in `docs/PLAN.md`.

Possible later evolutions: more engines (Oracle, DuckDB, ClickHouse, CockroachDB), notebooks, charts and dashboards, data generators, backup / restore wrappers, plugin API for drivers.

## 12. Risks and open points

- **`tiberius` maintenance and auth coverage**: integrated Windows auth and some Entra flows are weak. Mitigation: SQL login + Entra token first; revisit an ODBC-backed driver behind the same trait if needed.
- **Grid performance on WebKitGTK**: measured at M1; canvas fallback planned.
- **Keychain on Linux**: no Secret Service on minimal desktops; the session-only mode must be a first-class path.
- **Statement splitting** without a full parser per dialect: a tokenizer-level splitter is enough for running statements; autocomplete of aliases needs a tolerant partial parser (V1).
- **Type fidelity**: exotic types (PostGIS, hierarchyid, user-defined) degrade to their text form and are read-only.
