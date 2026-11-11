import { defineConfig, devices } from '@playwright/test';

/**
 * README screenshots (`pnpm screenshots`, e2e/screenshots.shot.ts): the mocked backend, one
 * worker so the images come out in a stable state, written to docs/assets/.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const mockPort = process.env.YADBE_MOCK_PORT ?? '1430';

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.shot.ts',
  outputDir: './test-results/screenshots',
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${mockPort}`,
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: `http://localhost:${mockPort}`,
    reuseExistingServer: !process.env.CI,
  },
});
