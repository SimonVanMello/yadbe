import { defineConfig, devices } from '@playwright/test';

// Lets environments with a preinstalled Chromium (e.g. CI containers) skip `playwright install`.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
// Same variable as vite.config.ts: one mock server per checkout when several run side by side.
const mockPort = process.env.YADBE_MOCK_PORT ?? '1430';

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${mockPort}`,
    viewport: { width: 1280, height: 800 },
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: `http://localhost:${mockPort}`,
    // Port 1430 is only used by the mock server (see vite.config.ts), so reuse is safe.
    reuseExistingServer: !process.env.CI,
  },
});
