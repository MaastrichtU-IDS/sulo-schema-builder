import { test, expect, request } from '@playwright/test';

// End-to-end proof against a *real* Keycloak — the class of failure unit
// tests structurally cannot catch: the audience mapper, issuer matching,
// PKCE and the redirect URIs. Everything else in this repo's auth stack has
// only ever been exercised against `jose`-signed test tokens.
//
// One-time setup, against the docker-compose stack (not the plain dev
// servers `schema-flow.spec.ts` targets):
//
//   docker compose -f docker-compose.yml down -v   # fresh realm import
//   docker compose -f docker-compose.yml up -d --build
//   docker compose exec \
//     -e KEYCLOAK_ADMIN_PASSWORD=admin -e KEYCLOAK_ADMIN=admin \
//     keycloak sh /opt/keycloak/bin/seed-test-user.sh
//   npx --prefix frontend playwright test -c frontend/playwright.config.ts frontend/e2e/auth-flow.spec.ts
//
// BASE below matches the compose file's published api port (8080) by
// default. Override with E2E_BASE_URL if that port is unavailable (see
// README's "running the e2e suite locally" section) — Keycloak's own
// realm-sulo.json already permits both http://localhost:8080/* and
// http://localhost:5173/* as redirect URIs / web origins, so no realm
// change is needed for either.
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';

// Seeded by docker/keycloak/seed-test-user.sh — local/CI credentials only.
const TEST_EMAIL = process.env.E2E_USER_EMAIL ?? 'e2e@example.org';
const TEST_PASSWORD = process.env.E2E_USER_PASSWORD ?? 'E2ePassw0rd!';

async function signIn(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Assertion 2: lands on Keycloak's own login page, in the `sulo` realm.
  await page.waitForURL(/^http:\/\/localhost:8088\/realms\/sulo\//, { timeout: 15_000 });
  await page.fill('#username', TEST_EMAIL);
  await page.fill('#password', TEST_PASSWORD);
  await page.click('#kc-login');
  // Back on the app, authenticated.
  await page.waitForURL(new RegExp(`^${BASE}/`), { timeout: 15_000 });
}

test.describe('Auth — real Keycloak login flow', () => {
  test('anonymous, sign-in redirect, sign-in, schema persistence, sign-out', async ({ page }) => {
    // 1. Anonymous visit: a "Sign in" affordance, and a scope-tab strip that
    // proves the anonymous view is a real, meaningful one rather than an
    // empty gate — the design spec (spec §5 / plan 3) requires anonymous
    // readers to see public schemas, so there is no "Sign in to see your
    // schemas." copy to assert on any more (OntologyBuilderPage.tsx pins an
    // anonymous visitor to one non-interactive "Public" tab and renders
    // "Mine"/"Shared with me" only once authenticated, since both would
    // otherwise only ever 401 server-side). Assert that shape directly:
    // "Public" present, "Mine"/"Shared with me" absent.
    await page.goto(`${BASE}/`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Public', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mine', exact: true })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Shared with me' })).not.toBeVisible();

    // 2 & 3. Sign in through Keycloak's hosted login page (PKCE, redirect_uri,
    // issuer/audience mapper all exercised for real here) and land back
    // authenticated, with the display name visible.
    await signIn(page);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('E2E Tester')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    // 4. Creating a schema succeeds, and it is still there after a reload —
    // proving both that the API accepted the real access token (audience
    // mapper, issuer match) and that ownership was recorded against this
    // account.
    const title = `E2E Auth Flow ${Date.now()}`;
    await page.getByRole('button', { name: '+ New Schema' }).click();
    await page.getByPlaceholder('e.g. Patient Health Record Ontology').fill(title);
    await page.getByRole('button', { name: 'Create ontology' }).click();
    await page.waitForURL(/\/ontology\/[0-9a-f-]+$/, { timeout: 15_000 });

    await page.goto(`${BASE}/`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(title)).toBeVisible({ timeout: 15_000 });

    // 5. Signing out returns to the same anonymous shape as step 1 — the
    // "Sign in" affordance and the pinned, non-interactive "Public" tab —
    // and the title created in step 4 is no longer visible. NOTE: that last
    // check alone only proves the UI gate, not owner-scoped listing on the
    // server: since the schema above was created private (the column
    // default — see schemas.ts's Visibility comment), it never appears in
    // `?scope=public` regardless of who is asking, so it disappearing here
    // is expected either way and cannot by itself distinguish "the server
    // scoped it" from "the UI hid it." Owner-scoped listing itself — one
    // subject's GET never contains another's title, and an anonymous
    // scope=public list never contains a private one — is proved
    // load-bearingly, against the server and with a second real account,
    // by frontend/e2e/sharing-flow.spec.ts (assertions 1, 5 and 6) and by
    // the unit suite ("lists only the caller's own schemas" in
    // api/src/modules/schemas/routes.auth.test.ts). This test keeps only
    // the cheap, still-true UI-shape assertions.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Public', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mine', exact: true })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Shared with me' })).not.toBeVisible();
    await expect(page.getByText(title)).not.toBeVisible();
  });

  // 6. Direct API call, no UI, no token: proves the guard itself rather than
  // the SPA's own handling of a 401.
  test('POST /api/v1/ontology-schemas with no token is rejected', async () => {
    const api = await request.newContext();
    const response = await api.post(`${BASE}/api/v1/ontology-schemas`, {
      data: { title: 'should never be created' },
    });
    expect(response.status()).toBe(401);
    await api.dispose();
  });
});
