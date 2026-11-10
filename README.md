# yadbe

A local, cross-platform (Windows, macOS, Linux) SQL database explorer in the spirit of Azure Data Studio: ergonomics, safety and performance first. Built with Tauri 2, React and Rust. Sibling project of yaggui (same themes, primitives and tooling).

- **Local and private**: no account, no telemetry. Passwords live in the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service on Linux), never in yadbe's own database.
- **Transparent**: every statement yadbe runs on its own shows up in the statement log.
- **Safe by default**: TLS with certificate verification for remote hosts, typed errors with a suggested action.

## Status

Milestone **M0 (foundations)** is done: the shell (tabs restored on restart, sidebar, status bar, statement log, Graphite and Paper themes, English and French), the connection manager (PostgreSQL and SQLite; create, edit, duplicate, group, favorite, environment tag, paste a connection string, test, connect with automatic reconnection) and the keychain integration.

Not there yet: the schema explorer, the SQL editor and query results (M1), table editing, read-only enforcement and the palette (M2). SQL Server and MySQL connections can be saved but not opened yet. See `docs/PLAN.md` for the roadmap, `docs/SPEC.md` for the requirements and `docs/validation/M0.md` for the manual validation checklist.

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
```

Integration tests run against real engines when `YADBE_TEST_PG_URL` (and friends) are set; `dev/compose.yml` starts them. The UI primitives are shown at `/#primitives` in `pnpm dev`. See `CLAUDE.md` for the conventions and the full command list.

## License

GPL-3.0-or-later, see `LICENSE`.
