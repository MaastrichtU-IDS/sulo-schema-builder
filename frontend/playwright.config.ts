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
  // Serial, not Playwright's default (parallel across files, sized to the
  // CPU count). auth-flow.spec.ts and sharing-flow.spec.ts both sign in as
  // the same seeded Keycloak account ("Alice"/e2e@example.org) against the
  // one shared, stateful realm+Postgres the e2e-auth job boots — running
  // them in different workers raced two logins for that account through
  // Keycloak's hosted form at once and intermittently failed with a genuine
  // (not flaky-assertion) "Invalid username or password.", reproduced
  // locally with 2 workers and gone with 1. A shared external identity
  // provider is not something either spec can make safe to hit
  // concurrently, so concurrency is the thing to remove here.
  workers: 1,
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
