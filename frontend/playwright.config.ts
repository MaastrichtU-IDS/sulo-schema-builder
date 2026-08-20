import { defineConfig, devices } from '@playwright/test';

// E2E config shared by every spec under ./e2e. `schema-flow.spec.ts` assumes
// the dev stack is already running (Vite :5173, API :3001, QLever) and
// defines its own absolute BASE, ignoring `baseURL` below.
// `auth-flow.spec.ts` targets the docker-compose stack instead (real
// Keycloak) and does the same — see its header comment for how to run it
// and for E2E_BASE_URL, which overrides the compose-published port if 8080
// is unavailable.
//
// `timeout` is 60s rather than the previous 30s: the auth spec's login
// round trip is a full browser redirect to Keycloak's hosted login page, a
// form submit, and a redirect back — more hops than the existing schema
// flow, especially on a cold container.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // An HTML report (frontend/playwright-report/) so ci.yml's e2e-auth job
  // has something concrete to upload on failure — the default reporter
  // writes no file at all.
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
