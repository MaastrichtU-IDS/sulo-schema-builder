import { defineConfig, devices } from '@playwright/test';

// E2E config. Assumes the dev stack is already running
// (Vite :5173, API :3001, QLever). Run: npx playwright test
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
