# yadbe

A local, cross-platform (Windows, macOS, Linux) SQL database explorer in the spirit of Azure Data Studio: ergonomics, safety and performance first. Built with Tauri 2, React and Rust. Sibling project of yaggui.

Status: project skeleton (task M0-1). See `docs/SPEC.md` for the requirements and `docs/PLAN.md` for the plan.

## Development

Requirements: Node 22, pnpm, stable Rust, and the [Tauri system libraries](https://v2.tauri.app/start/prerequisites/). `mise install` sets up the toolchains.

```bash
pnpm install
pnpm dev          # frontend in the browser on a mocked backend, http://localhost:1430
pnpm tauri dev    # full app
pnpm check        # case check, lint, format, typecheck, unit tests
pnpm test:ui      # Playwright on the mocked backend (captures in test-results/)
pnpm bindings     # regenerate src/ipc/bindings.ts from Rust
```

The UI primitives are shown at `/#primitives`. See `CLAUDE.md` for conventions.

## License

GPL-3.0-or-later, see `LICENSE`.
