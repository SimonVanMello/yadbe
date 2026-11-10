# Paused work — how to resume

Paused on 2026-11-10 by the product owner (token budget). The master session stopped four running sub-sessions mid-task. Nothing below was reviewed or verified by the master session unless stated.

## State of the integration branch (`claude/practical-faraday-39e9km`)

Merged and checked by the master session (`pnpm check` 387 tests; clippy and `cargo test` 121 passed before the M1-4 merge; Playwright and Rust tests NOT rerun after the M1-4 merge):

- M0 complete (see `docs/validation/M0.md`, waiting for the owner's manual validation on macOS / Windows).
- M1-1 introspection backend, M1-3 query execution backend (read-only enforcement included), M1-4 SQL editor front.
- `src-tauri/vendor/tiberius/`: pristine tiberius 0.13.0 committed by the M1-7 sub-session (commit `9702527`), not referenced by `Cargo.toml` on this branch. The M1-7 patch below modifies it and wires it. **Open decision for the owner: keep a vendored, patched tiberius or not** — the sub-session was stopped before explaining why it forked (its diff touches TLS via rustls, the token stream, money / var-len decoding, a new `tds/stream/batch.rs`).

## Unfinished tasks: one patch each in `docs/progress/wip/`

Each patch is `git format-patch` output (work commits + a final `wip(...)` commit holding whatever was uncommitted at the stop). Restore with a branch at the given base, then `git am`:

```bash
git switch -c resume/m1-5 5e9784e && git am docs/progress/wip/m1-5-grid.patch
git switch -c resume/m1-2 6f4c365 && git am docs/progress/wip/m1-2-explorer.patch
git switch -c resume/m1-6 3280bb2 && git am docs/progress/wip/m1-6-history.patch
git switch -c resume/m1-7 9702527 && git am docs/progress/wip/m1-7-mssql.patch
```

Then merge the integration branch into each and continue. State when stopped (last thing each sub-session said):

| Task | Session | Where it was | Notes |
|---|---|---|---|
| M1-5 result grid | opus · high | One real commit (`feat(grid): virtualized result grid with selection, copy and cell viewer`) + WIP; was "implementing span placeholders in the renderer" | Seam: `src/features/grid/ResultGrid.tsx`, props `{ resultId, summary }`. P-04 not reported yet. |
| M1-2 explorer front | sonnet · high | Everything in the WIP commit; was "fixing a test-file lint issue and rerunning checks" — probably close to done | Must report its `openQueryTab({connectionId, database, initialText})` seam; reconcile with M1-4's tab model (`src/features/query/queryTabStore`). |
| M1-6 history | sonnet · high | Early (started ~15 min before the stop); was rewriting parts | Based on M1-4. Changes the connection contract (`historyEnabled`). |
| M1-7 SQL Server driver | opus · high | Driver in `src-tauri/src/db/drivers/mssql/` + patched vendored tiberius, uncommitted when stopped | A real SQL Server 2022 was running through Docker: start `dockerd` (no systemd), `docker compose -f dev/compose.yml up -d mssql`, `YADBE_TEST_MSSQL_URL` as in the header of `dev/compose.yml` (port 51433). Whether its tests pass is unknown. |

The original briefs of these four sub-sessions follow the pattern of the task rows in `docs/PLAN.md` plus: contract first, new files rather than edits to shared files, `bindings.ts` regenerated never hand-edited, FR + EN together, Playwright captures in both themes.

## What the master session still has to do after these land

1. Mount the grid: in `src/features/query/ResultsArea.tsx` replace `<ResultPlaceholder …>` by `<ResultGrid …>` (same props), delete `ResultPlaceholder.tsx` / `.module.css`.
2. Database list in the connection switcher: implement `useDatabaseList(connectionId)` in `src/features/query/databaseList.ts` with `listDatabases`.
3. M1-8 integration: run the real app (`pnpm tauri build --debug --no-bundle`, CSP check for CodeMirror was only done in Chromium), measure P-02 to P-04 (P-04 on WebKitGTK), write `docs/validation/M1.md`.
4. Status bar: Ln/Col and run summary (SPEC §4), not built by M1-4.
5. SQL Server has no read-only session: only the statement classifier protects there; the UI must say so (asked of M1-7).

## Environment notes (cloud container)

- PostgreSQL 16 local: `pg_ctlcluster 16 main start`; `YADBE_TEST_PG_URL=postgres://yadbe:yadbe-test-pw@localhost:5432/yadbe_test`, `YADBE_TEST_PG_CA=../dev/certs/ca.crt` (`dev/tls-certs.sh` recreates the certs; the role and database must be recreated in a fresh container).
- Tauri system libs are not preinstalled in a fresh container: `.claude/hooks/session-start.sh` installs them.
- Disk allowance is small: export `CARGO_PROFILE_DEV_DEBUG=0`, share one `CARGO_TARGET_DIR` between worktrees, front-only sub-sessions must not run cargo.
- Sub-sessions run on Opus commit with their own `Co-Authored-By` trailer; left as is.
