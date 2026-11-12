# yadbe

Local, cross-platform (Windows, macOS, Linux) SQL database explorer in the spirit of Azure Data Studio: ergonomics, safety and performance first. Sibling project of yaggui: same stack, same visual style, same way of working.

Sources of truth, to read before touching the code:

- `docs/SPEC.md`: requirements (IDs `F-xxx`, `P-xx`), architecture, UX principles.
- `docs/PLAN.md`: breakdown into tasks, dependencies, session model and effort per task.
- `docs/analysis/NOSQL.md`: MongoDB, Elasticsearch and Redis (M4): engine families, per-engine design, decisions taken.
- yaggui (`SimonVanMello/yaggui`): reference for the themes (**Graphite** dark, **Paper** light), the `ui/` primitives and the tooling. Port from it rather than reinventing.

When this file and the spec disagree, this file wins for conventions and the spec wins for functional behavior.

## Stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2 |
| Frontend | React 19, strict TypeScript, Vite, pnpm |
| State | Zustand (UI state), TanStack Query (metadata, result windows) |
| UI | CSS Modules + CSS variables (tokens), Radix UI for primitives |
| SQL editor | CodeMirror 6 (`@codemirror/lang-sql`) |
| Grid, lists | In-house grid and lists on TanStack Virtual |
| Backend | Stable Rust (2024 edition), `tokio` |
| Drivers | `tokio-postgres` (+ `rustls`), `tiberius`, `mysql_async`, `rusqlite` |
| Secrets | `keyring` (OS keychain) |
| Bindings | `tauri-specta`: TS types and commands **generated** from Rust, never written by hand |
| Persistence | SQLite (`rusqlite`) in the OS config folder |
| Tests | Vitest + Testing Library, Playwright (front on a mocked backend), `cargo test` against real engines |

Do not add a dependency outside this list without justifying it in the commit message (size, maintenance, alternative ruled out).

## Layout

```
src/                      Frontend
  app/                    Shell: window, title bar and tabs, layout, actions and shortcuts, errors, startup and restore
  features/<feature>/     One feature = components + hooks + styles + tests:
    connections/          Connection list model, dialog and forms (EngineFields: the fields of each engine family, DocumentConnectionFields + mongoModel.ts for MongoDB; SSH tunnel section), password / SSH secret / host key prompts, connection chip, import (other tools' files) and export dialogs
    sidebar/              Sidebar views (Connections / History / Saved / Journal), the virtualized tree of connections + explorer (rows dispatched by engine family)
    explorer/             Explorer rows (pure tree building and filter; documentRows.ts: the document family's tree), metadata queries, context menu, Script as, the shared catalog cache (catalogCache.ts: palette + autocomplete)
    query/                Query tab: SQL editor (CodeMirror), run / cancel, transactions, results area, files, danger guard, parameter prompt, formatter, hover cards and go to definition, plan tree
    grid/                 Data grid (results and table tabs), selection and copy formats, cell viewer
    documents/            Documents view: a virtualized, foldable tree of plain values (DocNode), copy value / path / document; reused by every document-like store
    document/             The document family (MongoDB): collection tab (filter, projection, sort, pages, counts), the JSON console (query tab of the family), grid / documents switch, dangerous-command confirmation, Extended JSON → documents view (ejsonView.ts)
    table-data/           Table tab: pages, count, filter bar, sort, cell editors, pending changes, SQL preview, apply, conflict and revert dialogs, table export, foreign key navigation (peek, jump, referencing rows, lookup editor, back / forward trail)
    completion/           Editor autocomplete: SQL context analysis, suggestions, quoting, index over the shared catalog
    palette/              Command palette: fuzzy matcher, sources (actions, connections, objects, tabs, history)
    preferences/          Preferences screen, schema and store; user-facing settings are read with `usePreference` / `getPreference`
    export/               Export dialog, options, progress toasts (result or table source)
    library/              Saved queries and snippets: Saved view, save dialog, snippet expansion, built-in snippets
    result-edit/          Editable query results: edit session over a result (table-tab machinery), footer status and read-only reasons
    activity/             Activity monitor tab: sessions and locks lists, who blocks whom, kill confirmation
    migrations/           EF Core migrations timeline (`__EFMigrationsHistory`)
    tools/                Tool tabs (never saved): guard, toolbar controls, palette actions
    journal/              Change journal view: search and filters, change set detail, revert entry point
    objects/              DDL tab, properties dialog, drop / truncate / rename confirmation, pins, inline rename
    import/               Data import wizard (file and format, column mapping, dry run and import)
    history/              History panel, search and filters, open / insert, clear
    statement-log/        Statement log panel
    statusbar/, toolbar/, welcome/   Bottom bar (run status, Ln/Col), query toolbar (QueryTabControls: per engine family, like app/tabs/QueryTabBody), welcome screen
    demo/                 The /#primitives page
  ipc/                    Backend access: generated bindings + Tauri client + mock client (mock/ per domain); sqlEngine.ts (SqlEngine: what SQL-only tables are keyed by)
  ui/                     Reusable primitives (Button, Menu, Dialog, Toast…)
  theme/                  tokens.css, graphite.css, paper.css
  i18n/                   fr.json, en.json
  test/                   Vitest setup
e2e/                      Playwright specs (mocked backend); perf*.spec.ts run with playwright.perf.config.ts
scripts/                  check-case, P-01 startup and P-04 WebKitGTK measurements
src-tauri/
  src/
    cli.rs                Command-line arguments (`yadbe <file.sql>`, `yadbe <url>`) → launch requests the front takes at startup (src/app/launch.ts)
    commands/             Tauri handlers: thin, no logic (validation → service call → error mapping)
    db/                   value.rs (Value model), engine.rs (engines, families, capabilities: one profile per engine), driver.rs (Driver, Backend by family, Link + SqlConnection + DocumentConnection), document/ (the document family above its driver: order-keeping Json, typed operations DocOp, read-only allow-list and danger detection, canonical Extended JSON ↔ cells, explorer model and field sampling, MongoDB settings and URIs), dialect.rs + edit_dialect.rs (SQL family only: quoting, paging, DML syntax), bound.rs (SQL builder with bound values), meta.rs + introspect.rs (introspection model), split.rs (statement splitter), classify.rs (read-only classifier), script.rs (Script as), ddl.rs + object_ops.rs + object_model.rs (DDL text, object statements, properties), params.rs (query parameters: scanner, binding), activity.rs (sessions, locks, kill), ef.rs (EF Core migrations), dotnet.rs (ADO.NET / EF Core connection strings), result_source.rs (plain one-table SELECT check for editable results), tls_identity.rs (client certificate and key), plan/ (plan model, one parser per engine, fixtures of real plans), config.rs + connstring.rs (connection definitions and strings), errors.rs (catalog)
      drivers/<engine>/   postgres, mssql, sqlite, mysql, mongodb: the only place a driver crate is used
    session/              ConnectionManager, ConnectionSession, QueryRunner, ResultStore, MetaCache, statement log, history recording, TableDataService (table tabs: pages, counts, apply) + table_sql.rs / table_shape.rs, ReferenceService (references.rs: foreign key lookups), Library (library.rs: saved queries), journal.rs (change journal, reverts), result_edit.rs (editable query results), result_view.rs + result_agg.rs + decimal.rs (sort / filter view of a result, selection aggregates), meta_objects.rs (DDL, properties, object actions), meta_activity.rs (activity, kill, migrations), connection_string.rs (copy as .NET connection string), tunnel.rs (SSH tunnel of a session), document/ (the command gate every document operation goes through: read-only, danger, timeout, statement log; DocumentService: explorer, collection pages, counts, console; documents into the ResultStore)
    tunnel/               SSH tunnels (russh): hops, authentication, host key checks, the loopback listener drivers dial
    edit/                 Change set → EditPlanner → parameterized DML with original-value checks, SQL preview, inverse.rs (what reverts a change set)
    secrets/              Keychain access, Secret type
    store/                SQLite: connections, tabs, history, preferences, saved queries, SSH known hosts, change journal, pinned objects
    export/               Streaming exports: sources (result, table), CSV / JSON / SQL / Markdown / xlsx encoders, the background job manager
    import/               Data import: streaming text / CSV / JSON readers, type conversion, plan, run, rejects file, job manager
    conn_import/          Connections from other tools (Azure Data Studio, DBeaver, pgpass, pg_service, SSMS) and yadbe's own file, without secrets
  examples/               export_bindings.rs (`pnpm bindings`)
  tests/                  Integration tests (common/, query_common/, conformance/) + fixture schema scripts (fixtures/)
  vendor/tiberius/        tiberius 0.13.0, pristine commit then yadbe's patches (PATCHES.md says which and why)
  vendor/russh/           russh 0.65.1, same scheme (per-channel flow control; PATCHES.md)
dev/                      compose.yml (test engines), mtls.yml (throwaway servers that require a client certificate), tls-certs.sh, mssql.conf, mysql-init.sql, ssh-test.sh (throwaway sshd servers)
docs/                     SPEC.md, PLAN.md, validation/Mx.md (manual checklists), analysis/ (studies that precede a milestone)
```

## Commands

Created by task M0-1; keep this list up to date when scripts change.

```bash
pnpm dev            # Frontend alone in the browser, mocked backend (VITE_MOCK=1), port 1430; primitives page at /#primitives
pnpm tauri dev      # Full app (Vite on port 1420)
pnpm build          # Typecheck + production build of the frontend
pnpm check          # file name casing + ESLint + Prettier + typecheck + Vitest — must pass before any commit
pnpm test:ui        # Playwright on `pnpm dev` (mocked backend), captures in test-results/ (set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to reuse a preinstalled Chromium)
pnpm bindings       # Regenerates src/ipc/bindings.ts from Rust
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
dev/tls-certs.sh    # Throwaway CA + `localhost` server certificate in dev/certs/ (git-ignored), for the TLS tests and compose
docker compose -f dev/compose.yml up -d   # PostgreSQL (TLS on), SQL Server, MySQL, MongoDB (replica set 57017, standalone 57018) for integration tests; URLs to export in the file's header
cd src-tauri && YADBE_TEST_PG_URL=postgres://user:pw@localhost:5432/db YADBE_TEST_PG_CA=../dev/certs/ca.crt cargo test --test postgres   # unset: tests print SKIPPED
cd src-tauri && YADBE_TEST_MSSQL_URL='sqlserver://localhost:51433;database=master;user=sa;password=Yadbe-test-pw1;trustServerCertificate=true' YADBE_TEST_MSSQL_CA=../dev/certs/ca.crt cargo test --test query_mssql --test introspection   # SQL Server (compose service); the CA test needs the compose TLS certificate, unset: SKIPPED
YADBE_CONFIG_DIR=<dir> pnpm tauri dev   # App database (yadbe.db) in another folder than the OS config one
cd src-tauri && YADBE_TEST_PG_URL=… cargo test --release --test introspection p02 -- --ignored --nocapture   # P-02: introspection on a 500-table and a 10k-object schema
xvfb-run pnpm tauri dev   # Run the real app in a headless container
pnpm tauri build --debug --no-bundle   # Built front + CSP with nonces (absent under `tauri dev`): check every new screen with this binary. A lib that injects <style> must receive the page nonce (src/ui/cspNonce.ts).
cd src-tauri && cargo test --release --test history_bench p08 -- --ignored --nocapture   # P-08: history search over 100k entries
pnpm perf:startup   # P-01 on the release binary (`pnpm tauri build --no-bundle` first; headless Linux: xvfb-run -a pnpm perf:startup)
pnpm perf:tabs      # P-07 on a production build of the front (mock): three query tabs and two table tabs, CPU ×1 and ×4
pnpm perf:grid      # P-04 on Chromium: scrolling 100k × 50 on the mock (production build), CPU ×1 and ×4
YADBE_TEST_PG_URL=… pnpm perf:grid:webkit [--binary …]   # P-04 in the real app through tauri-driver (start it with WEBKIT_DISABLE_COMPOSITING_MODE=1 under Xvfb)
pnpm perf:palette   # P-06: palette search over 10 000 objects on the mock (production build), CPU ×1 and ×4
pnpm perf:completion  # P-05: autocomplete source over a 10 000-object catalog on the mock, CPU ×1 and ×4
pnpm tauri build --bundles deb   # P-10: installer size (Linux .deb; macOS / Windows bundles on their OS)
cd src-tauri && YADBE_TEST_PG_URL=… YADBE_TEST_MSSQL_URL=… cargo test --test table_data --test export   # table browsing / edit plans on the three engines, exports
cd src-tauri && YADBE_TEST_MYSQL_URL=mysql://yadbe:yadbe-test-pw@localhost:53306/yadbe_test YADBE_TEST_MYSQL_CA=../dev/certs/ca.crt cargo test --test query_mysql --test introspection --test table_data --test export   # MySQL (compose service; `up -d -V mysql` the first time so the init grants run); P-02: `p02_mysql`
cd src-tauri && YADBE_TEST_PG_URL=… YADBE_TEST_MSSQL_URL=… YADBE_TEST_MYSQL_URL=… cargo test --test references   # foreign key lookups (SQLite always runs)
cd src-tauri && YADBE_TEST_PG_URL=… YADBE_TEST_MSSQL_URL=… YADBE_TEST_MYSQL_URL=… cargo test --test change_journal --test result_edit --test objects --test query_tools --test import --test activity --test ef_core   # optimistic concurrency and journal, editable query results, activity monitor and EF Core, object DDL and actions, parameters and plans, data import (SQLite always runs)
cd src-tauri && YADBE_BENCH_ROWS=1000000 cargo test --release --test import throughput -- --ignored --nocapture   # import throughput per engine; `large_file` instead for the 1 GiB file (about 2.5 GB of disk)
cd src-tauri && YADBE_TEST_PG_URL=… YADBE_TEST_MSSQL_URL=… YADBE_TEST_MYSQL_URL=… cargo test --test result_tools --test export_formats --test timeouts   # result sort / filter / aggregates, SQL / Markdown / xlsx exports, statement timeout and keep-alive
docker compose -f dev/compose.yml up -d mongo mongo-standalone   # MongoDB only: a single-node replica set (57017, initiated by its healthcheck) and a standalone server with auth and TLS allowed (57018)
cd src-tauri && YADBE_TEST_MONGO_URL='mongodb://localhost:57017/?replicaSet=rs0' YADBE_TEST_MONGO_STANDALONE_URL='mongodb://yadbe:yadbe-test-pw@localhost:57018/?authSource=admin' YADBE_TEST_MONGO_CA=../dev/certs/ca.crt cargo test --test document   # document family conformance (types, paging, sampling, gate, cancel, timeout, TLS; unset: SKIPPED)
docker compose -p yadbe-mtls -f dev/mtls.yml up -d   # PostgreSQL 55433 and MySQL 53307 requiring a client certificate; then `cargo test --test tls_client_cert` with the variables of the file's header (unset: SKIPPED)
dev/ssh-test.sh [dir]   # Throwaway OpenSSH servers (tunnel 2222, jump host 2223, no forwarding 2224) + ssh-agent; needs openssh-server and root; `dev/ssh-test.sh stop [dir]`
cd src-tauri && YADBE_TEST_SSH_DIR=/tmp/yadbe-sshd YADBE_TEST_PG_URL=… YADBE_TEST_PG_CA=… [YADBE_TEST_MSSQL_URL=… YADBE_TEST_MYSQL_URL=… YADBE_TEST_MYSQL_CA=…] cargo test --test ssh_tunnel   # SSH tunnels on every engine set (unset: SKIPPED; YADBE_TEST_SSH_PORT defaults to 2222)
cd src-tauri && YADBE_TEST_PG_URL=… cargo test --release --test table_data p_table_export -- --ignored --nocapture   # table export of 1M rows (keyset paging)
pnpm screenshots    # README screenshots (docs/assets/*.png) on the mocked backend; quantize the PNGs afterwards (ImageMagick, 128 colours)
pnpm perf:explorer  # Explorer tree on the mock: first level with 500 tables, scroll, filter (at once and a key at a time) on 10k objects (YADBE_PERF_PORT / YADBE_MOCK_PORT when the default port is taken)
cd src-tauri && YADBE_TEST_PG_URL=… cargo test --release --test query_postgres p03 -- --ignored --nocapture   # P-03: query sent → first 500-row window readable, 1M rows
```

`cargo build` / `cargo test` (debug or `--release`) rewrite `src-tauri/target/<profile>/yadbe` without the bundled frontend (it then loads `http://localhost:1420`): run `pnpm tauri build [--debug] --no-bundle` again before launching or measuring that binary.

Driving the real app (WebKitGTK) on Linux, e.g. to check a change end to end: `apt-get install webkit2gtk-driver`, `cargo install tauri-driver --locked`, start `Xvfb :99` and `DISPLAY=:99 YADBE_CONFIG_DIR=<dir> tauri-driver`, then speak W3C WebDriver to `http://127.0.0.1:4444` with the capability `{"tauri:options": {"application": "src-tauri/target/debug/yadbe"}}` (see `docs/validation/M0.md`, "How M0 was checked on Linux", and `docs/validation/M1.md`, `M2.md`, `M3.md`). Under Xvfb, `WEBKIT_DISABLE_COMPOSITING_MODE=1` makes WebKitGTK render much faster; GTK native dialogs can be driven with `xdotool` (`windowfocus --sync` on the dialog, Ctrl+A, type the path, Return). WebKitWebDriver sends no pointer events, ignores CSS transforms when it computes an element's center and drops Shift for `> : _`: `docs/validation/M3.md` (section 4) has the workarounds. `dev/certs` is git-ignored: copy it into a worktree before starting `dev/mtls.yml` from there. Use a fresh `YADBE_CONFIG_DIR` for measurements: saved preferences (result caps, fonts) change what the scripts see.

## Architecture rules (non-negotiable)

1. **Drivers stay behind the `Driver` trait.** No driver crate (`tokio_postgres`, `tiberius`, `mysql_async`, `rusqlite` for user databases) outside `db/drivers/<engine>/`. Engine differences are expressed by the engine's family and capabilities (`db/engine.rs`) and, inside the SQL family, by its `Dialect`; never by `match engine` in services or in the frontend. Dispatching on the family happens in the session and command layers (`Backend`) and at the front's seams (query tab, explorer, connection form); a SQL service refuses another family with `sqlOnly`.
2. **Values are bound, identifiers are quoted.** SQL generated by yadbe (edits, filters, metadata) passes values as parameters and quotes identifiers through the dialect. Never concatenate a value into SQL. Outside SQL (M4), a value yadbe sends is always a structured argument (BSON document, JSON body, RESP argument), never text spliced into a command.
3. **User SQL is sent as written.** No rewriting of what the user typed; the same holds for the scripts, requests and commands of the other engine families. The only SQL yadbe authors is metadata queries, table browsing and edit plans.
4. **Secrets live in the keychain only**, through `secrets/`. Never in SQLite, logs, history, error messages, events or any payload sent to the frontend. The `Secret` type is not `Serialize`, has a redacted `Debug`, and is zeroized on drop. Connection strings are redacted before being logged.
5. **Every statement yadbe runs on its own is recorded** in the statement log (SQL, duration, outcome). Every statement the user runs is recorded in the history.
6. **Typed errors**: Rust errors are a serialized enum (`code`, FR/EN `message`, suggested `action`), never a raw `String` sent to the front. Known driver errors go through the catalog in `db/errors.rs`.
7. **The UI never blocks**: every database call is asynchronous, reports progress through Tauri events and is cancellable with the engine's native mechanism.
8. **Rows stay in the backend.** Results live in the `ResultStore`; the frontend reads windows of 500 rows as flat arrays. Decimals, 64-bit integers and timestamps cross the IPC as strings (no precision loss).
9. **The front only talks to the backend through `src/ipc`.** No direct `invoke` in components. The mock client implements every command, so `pnpm dev` and `pnpm test:ui` work without Tauri or a database.
10. **Data changes are previewable and atomic**: edits are buffered, shown as SQL, applied in one transaction, and each `UPDATE` / `DELETE` must affect exactly one row. Where the server has no multi-statement transaction (a standalone MongoDB, Elasticsearch), changes are applied one by one, each checked, stopping at the first failure, and the preview says so and why. Read-only connections are enforced in the backend. Dangerous statements are confirmed with their concrete effect.

## Code conventions

- **Language**: code, identifiers, comments, commit messages and docs in English. UI text always goes through i18n, with FR and EN provided together.
- **TypeScript**: `strict`, no `any` (nor `as any`), no unjustified `!`. Function components, one component per file, `PascalCase.tsx` naming, hooks as `useXxx.ts`.
- **File names**: never two files in the same folder that differ only by case. `pnpm check` enforces it.
- **Styles**: no hard-coded color, size or radius in a component; only the tokens of `src/theme/tokens.css`. Both themes must stay correct in every change.
- **Rust**: `thiserror` for errors, no `unwrap()`/`expect()` outside tests and documented invariants, `tracing` for logs. Clippy without warnings.
- **Comments**: only for the non-obvious *why*.
- **Performance**: virtualize any list that can exceed ~200 items; targeted TanStack Query invalidation; measure before optimizing, and give the measurements in the commit message when the task touches a `P-xx` target.

## Tests

- Every driver passes the shared conformance suite (types, scripts, cancellation, error positions, introspection, edit plans) against a real engine.
- Integration tests read `YADBE_TEST_PG_URL`, `YADBE_TEST_MSSQL_URL`, `YADBE_TEST_MYSQL_URL`, `YADBE_TEST_MONGO_URL`, `YADBE_TEST_MONGO_STANDALONE_URL`; SQLite always runs. A missing engine skips the test with a printed notice.
- Every generated-DML path has a test that checks the resulting database state.
- Fixture schemas are created by script (`src-tauri/tests/fixtures/`), never committed as database files.
- Non-trivial front logic (stores, statement splitting, connection-string parsing, grid math): Vitest. Screens: at least one Playwright capture per new screen or visual state, in both themes.
- Tests never touch the real OS keychain: `secrets/` has an in-memory backend for tests.

## Agent workflow

- A **master session** owns `docs/PLAN.md`: it breaks the work down, starts one **sub-session per task** with the model and effort of the plan's *Session* column, reviews the result, runs the checks and updates the task status.
- No pull request for now: a task is one or more commits on the development branch. Parallel sub-sessions work in separate git worktrees and are merged by the master session.
- Commits follow Conventional Commits (`feat(grid): …`, `fix(ipc): …`) and mention the task ID in the body.
- A task whose IPC contract others depend on commits the contract first (Rust types, generated bindings, mock implementation).
- Stay within the task's scope. If something else is needed, report it to the master session instead of doing it.
- If a decision is covered neither by this file nor by the spec, take the simplest option that respects the rules above and say so in the commit message and the final report.
- Screenshots go to `test-results/` (not committed).

### Definition of done

1. The task's acceptance criteria are met.
2. `pnpm check`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` pass.
3. The app starts (`xvfb-run pnpm tauri dev`, or at least `cargo build` + `pnpm build`) and new screens are checked with Playwright captures in both themes.
4. Final report to the master session: what was done, covered requirements (`F-xxx`), decisions taken, measurements, what could not be verified, follow-ups.
5. `docs/PLAN.md` updated (task status).
