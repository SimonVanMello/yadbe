#!/bin/bash
# Prépare un conteneur Claude Code cloud pour yadbe (Tauri 2 + React).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Dépendances système Tauri (Linux / WebKitGTK) + xvfb pour lancer l'app sans écran.
if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo -n"
  $SUDO apt-get update -qq
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
    libxdo-dev libssl-dev build-essential file xvfb >/dev/null
fi

# Dépendances JS (pnpm install plutôt que --frozen-lockfile pour profiter du cache du conteneur).
if [ -f package.json ]; then
  pnpm install --prefer-offline
fi

# Dépendances Rust.
if [ -f src-tauri/Cargo.toml ]; then
  cargo fetch --manifest-path src-tauri/Cargo.toml
fi

# Playwright : réutilise le Chromium préinstallé du conteneur au lieu de `playwright install`.
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -x /opt/pw-browsers/chromium ]; then
  echo "export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium" >> "$CLAUDE_ENV_FILE"
fi
