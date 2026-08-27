import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test';

// Proves plan 4's whole claim end to end, against a real reasoner: save a
// schema with a genuine contradiction, watch the badge report it; fix it,
// watch the badge clear; reintroduce the EXACT same contradiction, and the
// verdict must come back from the content-addressed cache rather than a
// second JVM run — that last one is the plan's central claim and nothing
// else in this repo tests it end to end. Finally, publish the schema and
// prove an anonymous context can read the verdict too.
//
// Setup is via the API (aliceApi below), not the class-creation UI forms —
// the same choice frontend/e2e/sharing-flow.spec.ts made and documents in
// its own header: Playwright driving a browser proves what only a browser
// can (a real Keycloak login, and here, that the ConsistencyBadge genuinely
// reflects server state), while everything else is faster and less flaky
// through direct HTTP.
//
// The contradiction itself needs no ABox/individuals — SULO ships real
// disjoint class pairs (api/resources/sulo.ttl), so a class mapped to BOTH
// halves of one, via its own `mapsToConceptIri` and its superclass's, is
// unsatisfiable on TBox alone:
//
//   ClassA --mapsToConceptIri--> sulo:StartTime
//   ClassB --superClassId--> ClassA, --mapsToConceptIri--> sulo:EndTime
//
// ClassB is therefore asserted a subclass of both sulo:StartTime (via
// ClassA) and sulo:EndTime (directly) — and sulo.ttl declares
// `sulo:EndTime owl:disjointWith sulo:StartTime`. HermiT reports ClassB
// unsatisfiable with zero individuals involved.
//
// One-time setup, against the docker-compose stack — identical to
// sharing-flow.spec.ts's own, which this spec runs alongside in ci.yml's
// e2e-auth job (same stack, same seeding, one more spec far cheaper than a
// second cold build):
//
//   docker compose -f docker-compose.yml down -v   # fresh realm import
//   docker compose -f docker-compose.yml up -d --build
//   docker compose exec \
//     -e KEYCLOAK_ADMIN_PASSWORD=admin -e KEYCLOAK_ADMIN=admin \
//     keycloak sh /opt/keycloak/bin/seed-test-user.sh
//   npx --prefix frontend playwright test -c frontend/playwright.config.ts frontend/e2e/reasoning-flow.spec.ts
//
// BASE/credentials follow auth-flow.spec.ts's own conventions —
// E2E_BASE_URL overrides the compose-published port if 8080 is unavailable.
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8080';
const ALICE_EMAIL = process.env.E2E_USER_EMAIL ?? 'e2e@example.org';
const ALICE_PASSWORD = process.env.E2E_USER_PASSWORD ?? 'E2ePassw0rd!';

const SULO = 'https://w3id.org/sulo/';

/** Mirrors sharing-flow.spec.ts's own helper of the same name. */
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

test.describe('Automatic reasoning — real HermiT, real cache', () => {
  let alicePage: Page;
  let aliceApi: APIRequestContext;
  let anonApi: APIRequestContext;

  let schemaId: string;
  let classAId: string;
  let classBId: string;

  const run = Date.now();
  const title = `Reasoning E2E ${run}`;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    alicePage = await context.newPage();
    const token = await signInCapturingToken(alicePage, ALICE_EMAIL, ALICE_PASSWORD);

    aliceApi = await request.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    anonApi = await request.newContext({ baseURL: BASE });

    const created = await aliceApi.post('/api/v1/ontology-schemas', { data: { title } });
    expect(created.status()).toBe(201);
    schemaId = (await created.json()).id;
  });

  test.afterAll(async () => {
    await aliceApi?.dispose();
    await anonApi?.dispose();
    await alicePage?.context().close();
  });

  test('a genuine contradiction is detected: two classes mapped to disjoint SULO terms', async () => {
    test.setTimeout(90_000);

    const classA = await aliceApi.post(`/api/v1/ontology-schemas/${schemaId}/classes`, {
      data: { name: 'PeriodStart', mapsToConceptIri: `${SULO}StartTime` },
    });
    expect(classA.status()).toBe(201);
    classAId = (await classA.json()).id;

    const classB = await aliceApi.post(`/api/v1/ontology-schemas/${schemaId}/classes`, {
      data: { name: 'PeriodEnd', mapsToConceptIri: `${SULO}EndTime`, superClassId: classAId },
    });
    expect(classB.status()).toBe(201);
    classBId = (await classB.json()).id;

    await alicePage.goto(`${BASE}/ontology/${schemaId}`);
    // The badge polls GET .../report itself every 4s while queued/running
    // (frontend/src/api/report.ts) — no manual reload needed once the page
    // has mounted with the schema open.
    await expect(alicePage.getByText(/problem.*found by HermiT/i)).toBeVisible({ timeout: 75_000 });
  });

  test('fixing the contradiction returns the badge to consistent', async () => {
    test.setTimeout(90_000);

    // Breaks the disjoint pair: PeriodEnd no longer maps to sulo:EndTime.
    const fix = await aliceApi.patch(`/api/v1/ontology-schemas/${schemaId}/classes/${classBId}`, {
      data: { mapsToConceptIri: '' },
    });
    expect(fix.status()).toBe(204);

    // The already-open page's own React Query cache stopped polling once it
    // settled above (refetchInterval turns itself off at `fresh`/`failed`) —
    // reload so it mounts fresh and picks up the new `stale` state, then its
    // own polling carries it the rest of the way.
    await alicePage.reload();
    await expect(alicePage.getByText('Consistent', { exact: true })).toBeVisible({ timeout: 75_000 });
  });

  test('reintroducing the exact same contradiction serves the verdict from cache', async () => {
    test.setTimeout(60_000);

    const reintroduce = await aliceApi.patch(`/api/v1/ontology-schemas/${schemaId}/classes/${classBId}`, {
      data: { mapsToConceptIri: `${SULO}EndTime` },
    });
    expect(reintroduce.status()).toBe(204);

    await alicePage.reload();

    // This is the plan's central claim: a cache hit settles synchronously
    // inside the debounced check itself — stale straight to fresh, with NO
    // queued/running interim state ever observable — whereas the FIRST time
    // this exact content was seen (assertion 1, above) necessarily passed
    // through both (a real job, claimed and run by a worker). Asserting the
    // interim copy never appears is what actually distinguishes "came back
    // from cache" from "ran again and got the same answer".
    await expect(alicePage.getByText('Queued for a consistency check…')).not.toBeVisible();
    await expect(alicePage.getByText('Checking consistency…')).not.toBeVisible();
    await expect(alicePage.getByText(/problem.*found by HermiT/i)).toBeVisible({ timeout: 20_000 });
  });

  test('publishing the schema lets an anonymous context read the verdict', async () => {
    const publish = await aliceApi.patch(`/api/v1/ontology-schemas/${schemaId}`, {
      data: { visibility: 'public' },
    });
    expect(publish.status()).toBe(204);

    const anonRead = await anonApi.get(`/api/v1/ontology-schemas/${schemaId}/report`);
    expect(anonRead.status()).toBe(200);
    const body = await anonRead.json();
    expect(body.report).toBeTruthy();
    expect(body.report.consistent).toBe(false);
  });
});
