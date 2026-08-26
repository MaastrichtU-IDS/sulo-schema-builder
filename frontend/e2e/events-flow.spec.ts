import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test';

// Proves plan 5's whole claim end to end, against the real docker-compose
// stack: a change one browser makes is announced through Postgres
// LISTEN/NOTIFY and pushed over SSE to a SECOND browser that never reloads
// — and, separately, that the admin surface (plan 5 task 4) is a real route
// an admin can drive and have take effect.
//
// Two accounts this spec alone needs, seeded by
// docker/keycloak/seed-test-user.sh: "Alice" (also used by auth-flow.spec.ts
// and sharing-flow.spec.ts) owns the schema the live-update assertion
// watches; "Carol" is pre-seeded a Postgres admin BEFORE her first sign-in
// (ci.yml's "Pre-seed Carol as a Postgres admin" step, right after seeding —
// see that script's own comment for why before, not after, is the whole
// point: the real 60s subject->user cache (plugins/auth.ts) would otherwise
// leave a post-hoc promotion invisible to Carol's own next request for up to
// a minute). "Bob" (frontend/e2e/sharing-flow.spec.ts's own second account)
// is reused here only as the *target* of Carol's tier change — signed in
// once, in this spec's own beforeAll, purely to make one authenticated call
// that creates his `users` row via upsertBySubject. Without that, Carol's
// email lookup 404s: a fresh stack never runs sharing-flow.spec.ts's own
// Bob sign-in unless it happens to execute first in the same job, and this
// spec must not depend on that ordering. None of the three accounts drives
// its own browser page beyond that one sign-in — Alice's and Carol's bearer
// tokens are enough for everything each does here, the same choice
// reasoning-flow.spec.ts and sharing-flow.spec.ts make for every assertion
// that doesn't specifically need a browser.
//
// The live-update assertion reuses reasoning-flow.spec.ts's own
// contradiction trick (two SULO classes mapped to a disjoint pair) purely as
// a reliable way to force a real, multi-step reason_state transition
// (stale -> queued -> running -> fresh-with-a-clash) that is visible as
// text in the badge — the reasoning result itself is incidental here; what
// this spec actually tests is that a browser which made NONE of the API
// calls that caused it still sees every step, pushed, with its own polling
// turned off.
//
// The admin assertion is checked from the admin's OWN follow-up request
// (GET /admin/users again after the PATCH), not from Bob's — Bob's own
// per-request auth cache has that same real 60s TTL, so his very next
// request is NOT guaranteed to reflect a tier change made a moment earlier
// (admin.test.ts's own cache test pins this down as correct, surprising
// behaviour, not a bug); the admin listing route reads the `users` table
// fresh on every call and carries no such cache.
//
// One-time setup, against the docker-compose stack — identical to
// sharing-flow.spec.ts's and reasoning-flow.spec.ts's own, plus the admin
// pre-seed step ci.yml runs right after seeding:
//
//   docker compose -f docker-compose.yml down -v   # fresh realm + Postgres
//   docker compose -f docker-compose.yml up -d --build
//   docker compose exec -T \
//     -e KEYCLOAK_ADMIN_PASSWORD=admin -e KEYCLOAK_ADMIN=admin \
//     keycloak sh /opt/keycloak/bin/seed-test-user.sh
//   # then, using that command's own `CAROL_ID=...` stdout line:
//   docker compose exec -T db psql -U sulo -d sulo -c \
//     "insert into users (subject, global_role) values ('<CAROL_ID>', 'admin')"
//   npx --prefix frontend playwright test -c frontend/playwright.config.ts frontend/e2e/events-flow.spec.ts
//
// BASE/credentials follow auth-flow.spec.ts's own conventions —
// E2E_BASE_URL overrides the compose-published port if 8080 is unavailable.
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const ALICE_EMAIL = process.env.E2E_USER_EMAIL ?? 'e2e@example.org';
const ALICE_PASSWORD = process.env.E2E_USER_PASSWORD ?? 'E2ePassw0rd!';
const BOB_EMAIL = process.env.E2E_USER2_EMAIL ?? 'e2e-bob@example.org';
const BOB_PASSWORD = process.env.E2E_USER2_PASSWORD ?? 'E2eBobPassw0rd!';
const CAROL_EMAIL = process.env.E2E_USER3_EMAIL ?? 'e2e-carol@example.org';
const CAROL_PASSWORD = process.env.E2E_USER3_PASSWORD ?? 'E2eCarolPassw0rd!';

const SULO = 'https://w3id.org/sulo/';

/** Mirrors reasoning-flow.spec.ts's and sharing-flow.spec.ts's own helper of the same name. */
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

test.describe('Live change events and the admin surface — real stack', () => {
  let aliceApi: APIRequestContext;
  let carolApi: APIRequestContext;
  let anonPage: Page;

  const run = Date.now();
  const title = `Events E2E ${run}`;

  test.beforeAll(async ({ browser }) => {
    const aliceContext = await browser.newContext();
    const alicePage = await aliceContext.newPage();
    const aliceToken = await signInCapturingToken(alicePage, ALICE_EMAIL, ALICE_PASSWORD);
    await aliceContext.close();

    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    const bobToken = await signInCapturingToken(bobPage, BOB_EMAIL, BOB_PASSWORD);
    await bobContext.close();

    const carolContext = await browser.newContext();
    const carolPage = await carolContext.newPage();
    const carolToken = await signInCapturingToken(carolPage, CAROL_EMAIL, CAROL_PASSWORD);
    await carolContext.close();

    aliceApi = await request.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${aliceToken}` },
    });
    carolApi = await request.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${carolToken}` },
    });

    // Bob's own token is never needed again after this — one authenticated
    // call is enough to create his `users` row (see the header comment for
    // why this spec cannot rely on sharing-flow.spec.ts having done this
    // already).
    const bobApi = await request.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${bobToken}` },
    });
    const seenBob = await bobApi.get('/api/v1/ontology-schemas');
    expect(seenBob.status()).toBe(200);
    await bobApi.dispose();

    // No sign-in at all — this is the context the live-update assertion
    // watches, and it must never make an authenticated request of any kind.
    const anonContext = await browser.newContext();
    anonPage = await anonContext.newPage();
  });

  test.afterAll(async () => {
    await aliceApi?.dispose();
    await carolApi?.dispose();
    await anonPage?.context().close();
  });

  test('an admin changes another user\'s quota tier, visible on the admin\'s own subsequent request', async () => {
    const lookup = await carolApi.get(`/api/v1/users/lookup?email=${encodeURIComponent(BOB_EMAIL)}`);
    expect(lookup.status()).toBe(200);
    const bobId = (await lookup.json()).id as string;

    const before = await carolApi.get('/api/v1/admin/users');
    expect(before.status()).toBe(200);
    const beforeRow = (await before.json()).users.find((u: { id: string }) => u.id === bobId);
    expect(beforeRow?.quotaTier).toBe('free');

    const patch = await carolApi.patch(`/api/v1/admin/users/${bobId}`, { data: { quotaTier: 'staff' } });
    expect(patch.status()).toBe(204);

    // The "subsequent request" the plan asks for — a second GET, not a
    // re-read of the PATCH response. repo.ts's listUsers/updateUser both hit
    // Postgres directly on every call, so unlike a target reading their own
    // tier back (see this file's header), there is no cache here to race.
    const after = await carolApi.get('/api/v1/admin/users');
    expect(after.status()).toBe(200);
    const afterRow = (await after.json()).users.find((u: { id: string }) => u.id === bobId);
    expect(afterRow?.quotaTier).toBe('staff');
  });

  test('a signed-out browser watching a public schema updates itself, with no polling and no reload', async () => {
    test.setTimeout(120_000);

    const created = await aliceApi.post('/api/v1/ontology-schemas', { data: { title } });
    expect(created.status()).toBe(201);
    const schemaId = (await created.json()).id as string;

    const classA = await aliceApi.post(`/api/v1/ontology-schemas/${schemaId}/classes`, {
      data: { name: 'PeriodStart', mapsToConceptIri: `${SULO}StartTime` },
    });
    expect(classA.status()).toBe(201);
    const classAId = (await classA.json()).id as string;

    const publish = await aliceApi.patch(`/api/v1/ontology-schemas/${schemaId}`, {
      data: { visibility: 'public' },
    });
    expect(publish.status()).toBe(204);

    // Every GET this anonymous page makes to the report endpoint, from here
    // until the end of the test — the assertion below is that there are few
    // enough of them that they can only be the ones the SSE stream itself
    // triggered (one per `pg_notify`d transition: mutated, queued, running,
    // fresh), never REPORT_POLL_INTERVAL_MS's 4-second timer.
    const reportRequests: string[] = [];
    anonPage.on('request', (req) => {
      if (req.url().includes(`/ontology-schemas/${schemaId}/report`)) reportRequests.push(req.url());
    });

    // Loads and subscribes BEFORE the contradiction exists — the point is
    // not that this page can show a verdict, it's that it changes without
    // ever being told to look again.
    await anonPage.goto(`${BASE}/ontology/${schemaId}`);
    await expect(anonPage.getByText('This schema has not yet been checked for consistency.')).toBeVisible({
      timeout: 15_000,
    });

    // Alice's edit — through aliceApi, a context anonPage shares nothing
    // with (no cookies, no localStorage, a different process entirely).
    // Mirrors reasoning-flow.spec.ts's own disjoint-pair trick: ClassB is
    // asserted a subclass of both sulo:StartTime (via ClassA) and
    // sulo:EndTime (directly), and sulo.ttl declares those disjoint.
    const classB = await aliceApi.post(`/api/v1/ontology-schemas/${schemaId}/classes`, {
      data: { name: 'PeriodEnd', mapsToConceptIri: `${SULO}EndTime`, superClassId: classAId },
    });
    expect(classB.status()).toBe(201);

    // No `anonPage.reload()` anywhere in this test — every state this page
    // ever shows from here on arrives over the SSE connection it opened
    // above.
    await expect(anonPage.getByText(/problem.*found by HermiT/i)).toBeVisible({ timeout: 90_000 });

    // Five real transitions notify (mutated, queued, running, fresh) plus
    // the page's own initial mount fetch is, at most, five GETs. A 4-second
    // poll running for the ~minute this JVM run took would have produced
    // several times that many.
    expect(reportRequests.length).toBeLessThanOrEqual(8);
  });
});
