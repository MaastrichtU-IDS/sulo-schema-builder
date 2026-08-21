import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test';

// The assertion frontend/e2e/auth-flow.spec.ts could not make. That spec's
// sign-out check is tautological: signing out replaces the whole schema-list
// subtree with an anonymous prompt, so `expect(...).not.toBeVisible()` passes
// regardless of what GET /ontology-schemas without a token actually returned
// — it proves the UI's own gate, not owner-scoped listing on the server. See
// its header comment for the fuller argument.
//
// This spec is the load-bearing replacement: two real Keycloak accounts
// ("Alice" and "Bob", seeded by docker/keycloak/seed-test-user.sh), and every
// isolation/sharing claim asserted with Playwright's `request` API — no
// browser context — directly against the API. The browser is used only for
// what only the browser can prove: that signing in through Keycloak's real
// hosted login page (PKCE, redirect_uri, issuer/audience mapper) yields a
// token the API accepts. That token is then read out of the network
// response for the code→token exchange (`signInCapturingToken` below) and
// used as a bearer token for every `request` call that follows — the tokens
// never touch localStorage or cookies (frontend/src/auth/AuthProvider.tsx
// keeps them in memory only), so reading them off the wire is the only way
// to hand them to an API-only request context.
//
// One-time setup, against the docker-compose stack (not the plain dev
// servers `schema-flow.spec.ts` targets) — identical to auth-flow.spec.ts's
// own setup, with one more seeded account:
//
//   docker compose -f docker-compose.yml down -v   # fresh realm import
//   docker compose -f docker-compose.yml up -d --build
//   docker compose exec \
//     -e KEYCLOAK_ADMIN_PASSWORD=admin -e KEYCLOAK_ADMIN=admin \
//     keycloak sh /opt/keycloak/bin/seed-test-user.sh
//   npx --prefix frontend playwright test -c frontend/playwright.config.ts frontend/e2e/sharing-flow.spec.ts
//
// BASE/credentials below follow auth-flow.spec.ts's own conventions —
// E2E_BASE_URL overrides the compose-published port if 8080 is unavailable.
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';

// "Alice" — the same account auth-flow.spec.ts signs in as.
const ALICE_EMAIL = process.env.E2E_USER_EMAIL ?? 'e2e@example.org';
const ALICE_PASSWORD = process.env.E2E_USER_PASSWORD ?? 'E2ePassw0rd!';

// "Bob" — seeded by the same script, added for this spec only.
const BOB_EMAIL = process.env.E2E_USER2_EMAIL ?? 'e2e-bob@example.org';
const BOB_PASSWORD = process.env.E2E_USER2_PASSWORD ?? 'E2eBobPassw0rd!';

/**
 * Signs in through Keycloak's hosted login page, exactly like
 * auth-flow.spec.ts's own `signIn`, but additionally captures the access
 * token from the authorization-code→token exchange that keycloak-js makes
 * once the browser is redirected back to the app. That network response is
 * the only place this token is ever observable from outside the page's own
 * in-memory Keycloak instance (see the header comment) — it is registered
 * *before* submitting the login form so it cannot race the redirect back.
 */
async function signInCapturingToken(page: Page, email: string, password: string): Promise<string> {
  await page.goto(`${BASE}/`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/^http:\/\/localhost:8088\/realms\/sulo\//, { timeout: 15_000 });
  await page.fill('#username', email);
  await page.fill('#password', password);

  const tokenResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/protocol/openid-connect/token') && response.request().method() === 'POST',
    { timeout: 20_000 },
  );
  await page.click('#kc-login');
  await page.waitForURL(new RegExp(`^${BASE}/`), { timeout: 15_000 });

  const tokenResponse = await tokenResponsePromise;
  const body = (await tokenResponse.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('Keycloak token response carried no access_token');
  return body.access_token;
}

test.describe.configure({ mode: 'serial' });

test.describe('Sharing and isolation — two real accounts', () => {
  let aliceApi: APIRequestContext;
  let bobApi: APIRequestContext;
  let anonApi: APIRequestContext;

  let privateSchemaId: string;
  let publicSchemaId: string;
  let bobOwnSchemaId: string;
  let bobUserId: string;

  const run = Date.now();
  const privateTitle = `Sharing E2E private ${run}`;
  const publicTitle = `Sharing E2E public ${run}`;
  const bobTitle = `Sharing E2E bob-owned ${run}`;

  test.beforeAll(async ({ browser }) => {
    // Two independent browser contexts — no shared cookies/SSO state — so
    // each login is genuinely a separate real identity, not the same
    // Keycloak session reused.
    const aliceContext = await browser.newContext();
    const alicePage = await aliceContext.newPage();
    const aliceToken = await signInCapturingToken(alicePage, ALICE_EMAIL, ALICE_PASSWORD);
    await aliceContext.close();

    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    const bobToken = await signInCapturingToken(bobPage, BOB_EMAIL, BOB_PASSWORD);
    await bobContext.close();

    aliceApi = await request.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${aliceToken}` },
    });
    bobApi = await request.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${bobToken}` },
    });
    // No Authorization header at all — a real anonymous caller, not merely
    // one whose token happens to be absent from a header we forgot to set.
    anonApi = await request.newContext({ baseURL: BASE });
  });

  test.afterAll(async () => {
    await aliceApi?.dispose();
    await bobApi?.dispose();
    await anonApi?.dispose();
  });

  test('setup: Alice and Bob each create a private schema', async () => {
    const aliceRes = await aliceApi.post('/api/v1/ontology-schemas', { data: { title: privateTitle } });
    expect(aliceRes.status()).toBe(201);
    privateSchemaId = (await aliceRes.json()).id;

    const bobRes = await bobApi.post('/api/v1/ontology-schemas', { data: { title: bobTitle } });
    expect(bobRes.status()).toBe(201);
    bobOwnSchemaId = (await bobRes.json()).id;
  });

  // Assertion 1: Alice's private schema is invisible to Bob — 404, the same
  // answer a nonexistent id would get, straight from the server (not the UI).
  test('assertion 1: Bob gets 404 on Alice’s private schema', async () => {
    const res = await bobApi.get(`/api/v1/ontology-schemas/${privateSchemaId}`);
    expect(res.status()).toBe(404);
  });

  // Assertion 2: once Alice grants Bob `viewer`, Bob can read it — but his
  // write is refused with 403 (he can see it now, so 401 would be the wrong
  // answer; he simply lacks the level).
  test('assertion 2: after a viewer grant Bob can read but not write', async () => {
    const lookup = await aliceApi.get(`/api/v1/users/lookup?email=${encodeURIComponent(BOB_EMAIL)}`);
    expect(lookup.status()).toBe(200);
    bobUserId = (await lookup.json()).id;

    const grant = await aliceApi.put(`/api/v1/ontology-schemas/${privateSchemaId}/grants/${bobUserId}`, {
      data: { role: 'viewer' },
    });
    expect(grant.status()).toBe(200);

    const read = await bobApi.get(`/api/v1/ontology-schemas/${privateSchemaId}`);
    expect(read.status()).toBe(200);
    expect((await read.json()).id).toBe(privateSchemaId);

    const write = await bobApi.patch(`/api/v1/ontology-schemas/${privateSchemaId}`, {
      data: { title: 'Bob should not be able to set this' },
    });
    expect(write.status()).toBe(403);
  });

  // Assertion 3: Alice publishes a second schema, and an anonymous caller —
  // no token, no browser — can read it.
  test('assertion 3: an anonymous caller reads Alice’s published schema', async () => {
    const created = await aliceApi.post('/api/v1/ontology-schemas', { data: { title: publicTitle } });
    expect(created.status()).toBe(201);
    publicSchemaId = (await created.json()).id;

    const publish = await aliceApi.patch(`/api/v1/ontology-schemas/${publicSchemaId}`, {
      data: { visibility: 'public' },
    });
    expect(publish.status()).toBe(204);

    const anonRead = await anonApi.get(`/api/v1/ontology-schemas/${publicSchemaId}`);
    expect(anonRead.status()).toBe(200);
    expect((await anonRead.json()).id).toBe(publicSchemaId);
  });

  // Assertion 4: an anonymous write to that same (now-public, view-level)
  // schema is 401, not 403 — a session is the only thing missing, per
  // modules/acl/guards.ts's three-way status code policy.
  test('assertion 4: an anonymous write is 401', async () => {
    const write = await anonApi.post(`/api/v1/ontology-schemas/${publicSchemaId}/classes`, {
      data: { name: 'ShouldNeverBeCreated' },
    });
    expect(write.status()).toBe(401);
  });

  // Assertion 5: Alice's own-scoped list never contains anything Bob owns.
  test('assertion 5: Alice’s ?scope=mine never contains Bob’s schemas', async () => {
    const res = await aliceApi.get('/api/v1/ontology-schemas?scope=mine');
    expect(res.status()).toBe(200);
    const ids: string[] = (await res.json()).map((s: { id: string }) => s.id);

    expect(ids).toContain(privateSchemaId);
    expect(ids).toContain(publicSchemaId);
    expect(ids).not.toContain(bobOwnSchemaId);
  });

  // Assertion 6: Bob's shared-scoped list contains the one schema Alice
  // granted him — and never his own (repo.ts's listSchemasByScope excludes
  // owner_id = :me from the `shared` branch by construction). Scoped to this
  // run's own id rather than `toEqual([privateSchemaId])`: every run creates a
  // fresh private schema and grants Bob `viewer` on it, so against a
  // non-reset volume a second run would find this run's schema *and* a
  // previous run's, and an exact-list equality would fail in a way that reads
  // as a product bug rather than what it actually is — test pollution.
  test('assertion 6: Bob’s ?scope=shared contains exactly the shared schema', async () => {
    const res = await bobApi.get('/api/v1/ontology-schemas?scope=shared');
    expect(res.status()).toBe(200);
    const ids: string[] = (await res.json()).map((s: { id: string }) => s.id);

    expect(ids).toContain(privateSchemaId);
    expect(ids).not.toContain(bobOwnSchemaId);
  });
});
