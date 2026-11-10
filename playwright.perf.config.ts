import { defineConfig, devices } from '@playwright/test';

/**
 * Performance measurements (`pnpm perf:tabs`): production build of the frontend on the mock
 * backend, so React runs without its development checks, like in the app.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const PORT = 1431;

export default defineConfig({
  testDir: './e2e',
  testMatch: 'perf*.spec.ts',
  outputDir: './test-results/perf',
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: `vite build --mode mock --outDir dist-mock && vite preview --mode mock --outDir dist-mock --port ${String(PORT)} --strictPort`,
    url: `http://localhost:${String(PORT)}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
