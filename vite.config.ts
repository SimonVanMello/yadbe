import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const host = process.env.TAURI_DEV_HOST;

// `pnpm dev` (mock) gets its own port so Playwright never reuses a `pnpm tauri dev` server.
// `YADBE_MOCK_PORT` moves it, for several checkouts tested side by side (playwright.config.ts
// reads the same variable).
const MOCK_PORT = Number(process.env.YADBE_MOCK_PORT ?? 1430);
const TAURI_PORT = 1420;

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Tauri expects a fixed port and shows its own errors.
  clearScreen: false,
  server: {
    port: mode === 'mock' ? MOCK_PORT : TAURI_PORT,
    strictPort: true,
    host: host ?? false,
    hmr: host ? { protocol: 'ws', host, port: TAURI_PORT + 1 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // Tauri webviews: WebView2 (Chromium), WKWebView and WebKitGTK (Safari 15+ equivalent).
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome110' : 'safari15',
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    // One stylesheet, read before the first paint: a part loaded later never shows unstyled.
    cssCodeSplit: false,
    rolldownOptions: {
      output: {
        // What the first paint needs stays in one chunk (no cascade of small requests at
        // startup); the parts loaded later (`src/app/lazyViews.ts`) get their own chunks.
        codeSplitting: { groups: [{ name: 'app', tags: ['$initial'] }] },
      },
    },
  },
  css: {
    modules: { localsConvention: 'camelCaseOnly' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Unit tests run against the in-memory mock backend.
    env: { VITE_MOCK: '1' },
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
}));
