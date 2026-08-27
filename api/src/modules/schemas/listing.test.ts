// Task 3: listing, visibility and scopes.
//
// GET /ontology-schemas?scope=mine|shared|public activates the visibility
// column migration 001 already carries. Three scopes, each a different
// relationship between the caller and a schema:
//   * mine   — schemas the caller owns, at any visibility.
//   * shared — schemas granted to the caller, and never their own, whatever
//              visibility those own schemas happen to have.
//   * public — visibility = 'public' from every owner. Never 'unlisted': that
//              exclusion is the entire difference between the two published
//              states (a schema is still reachable at GET /:id by anyone who
//              already has the id — see modules/acl — this is only what a
//              caller with no id yet can discover by browsing).
//
// Default scope is `mine` for a signed-in caller and `public` for an
// anonymous one; `mine`/`shared` requested anonymously are 401, not [] — a
// scope that names the caller's own relationship to a schema is meaningless
// without a session. An unrecognised scope is 400.
//
// Fixtures go through the token path (createTestIssuer via
// buildAuthedApp/harness.issuer), never a hand-inserted `users` row — see
// routes.auth.test.ts for why: truncateAll spares `users` on purpose, and the
// auth plugin's subject->user cache means a fabricated id drifts from the one
// the plugin would actually resolve.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import { buildAuthedApp, type AuthedTestApp } from '../../test/authApp.js';

let t: TestDb;
let harness: AuthedTestApp;

beforeAll(async () => {
  t = await startTestDb();
  harness = await buildAuthedApp(t.db);
});

afterAll(async () => {
  await harness.close();
  await t.stop();
});

beforeEach(async () => { await truncateAll(t.db); });

async function tokenFor(subject: string): Promise<string> {
  return harness.issuer.sign({ sub: subject }, { expiresIn: '2h' });
}

/** Creates a schema through the API as `subject`, optionally publishing it in the same call. */
async function createSchema(
  subject: string, title: string, visibility?: 'private' | 'unlisted' | 'public',
): Promise<{ id: string; title: string; visibility: 'private' | 'unlisted' | 'public' }> {
  const token = await tokenFor(subject);
  const res = await harness.app.inject({
    method: 'POST', url: '/ontology-schemas', headers: harness.bearer(token),
    payload: { title, ...(visibility !== undefined ? { visibility } : {}) },
  });
  return res.json();
}

/**
 * Grants `role` on `schemaId` to `subject`. `subject` must already be known
 * to the auth plugin (one prior authenticated request) or the SELECT behind
 * this INSERT matches no row and the grant silently does nothing — the same
 * pattern routes.auth.test.ts uses.
 */
async function grant(schemaId: string, subject: string, role: 'viewer' | 'editor' | 'owner'): Promise<void> {
  await t.pool.query(
    `insert into schema_grants (schema_id, grantee_id, role)
     select $1, id, $3 from users where subject = $2`,
    [schemaId, subject, role],
  );
}

/** A GET /ontology-schemas?scope=... as `subject`, or anonymously if omitted. */
async function list(scope: string | undefined, subject?: string) {
  const headers = subject ? harness.bearer(await tokenFor(subject)) : undefined;
  const url = scope === undefined ? '/ontology-schemas' : `/ontology-schemas?scope=${scope}`;
  return harness.app.inject({ method: 'GET', url, headers });
}

describe('GET /ontology-schemas scopes', () => {
  it('mine returns only schemas the caller owns, regardless of visibility', async () => {
    await createSchema('kc-alice', 'Alice private', 'private');
    await createSchema('kc-alice', 'Alice unlisted', 'unlisted');
    await createSchema('kc-alice', 'Alice public', 'public');
    await createSchema('kc-bob', 'Bob public', 'public');

    const res = await list('mine', 'kc-alice');
    expect(res.statusCode).toBe(200);
    expect(res.json().map((s: { title: string }) => s.title)).toEqual([
      'Alice private', 'Alice public', 'Alice unlisted',
    ]);
  });

  it('shared returns only schemas granted to the caller, and never their own', async () => {
    const owned = await createSchema('kc-alice', 'Alice A', 'private');
    // Bob must be known to the auth plugin before the grant SELECT can find him.
    await tokenFor('kc-bob');
    await list('mine', 'kc-bob');
    await grant(owned.id, 'kc-bob', 'editor');
    await createSchema('kc-bob', 'Bob B', 'public');

    const res = await list('shared', 'kc-bob');
    expect(res.statusCode).toBe(200);
    expect(res.json().map((s: { title: string }) => s.title)).toEqual(['Alice A']);
  });

  it('public returns public schemas from every owner, and never unlisted ones', async () => {
    await createSchema('kc-alice', 'Alice public', 'public');
    await createSchema('kc-alice', 'Alice unlisted', 'unlisted');
    await createSchema('kc-alice', 'Alice private', 'private');
    await createSchema('kc-bob', 'Bob public', 'public');

    const res = await list('public');
    expect(res.statusCode).toBe(200);
    expect(res.json().map((s: { title: string }) => s.title)).toEqual(['Alice public', 'Bob public']);
  });

  it('defaults to mine for a signed-in caller and public for an anonymous one', async () => {
    await createSchema('kc-alice', 'Alice private', 'private');
    await createSchema('kc-bob', 'Bob public', 'public');

    const signedIn = await list(undefined, 'kc-alice');
    expect(signedIn.json().map((s: { title: string }) => s.title)).toEqual(['Alice private']);

    const anonymous = await list(undefined);
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json().map((s: { title: string }) => s.title)).toEqual(['Bob public']);
  });

  it('401s mine and shared for an anonymous caller instead of answering an empty list', async () => {
    for (const scope of ['mine', 'shared']) {
      const res = await list(scope);
      expect(res.statusCode, scope).toBe(401);
    }
  });

  it('400s an unrecognised scope', async () => {
    const res = await list('bogus', 'kc-alice');
    expect(res.statusCode).toBe(400);
  });

  it('keeps every scope ordered by title', async () => {
    await createSchema('kc-alice', 'Zebra', 'public');
    await createSchema('kc-alice', 'Alpha', 'public');
    await createSchema('kc-alice', 'Mid', 'public');

    const mine = await list('mine', 'kc-alice');
    expect(mine.json().map((s: { title: string }) => s.title)).toEqual(['Alpha', 'Mid', 'Zebra']);

    const pub = await list('public');
    expect(pub.json().map((s: { title: string }) => s.title)).toEqual(['Alpha', 'Mid', 'Zebra']);

    // shared: three schemas owned by someone else, all granted to Bob, created
    // out of title order.
    await tokenFor('kc-bob'); // must be known to the auth plugin before grant() can find him
    await list('mine', 'kc-bob');
    const z = await createSchema('kc-carol', 'Shared Zebra', 'private');
    const a = await createSchema('kc-carol', 'Shared Alpha', 'private');
    const m = await createSchema('kc-carol', 'Shared Mid', 'private');
    await grant(z.id, 'kc-bob', 'viewer');
    await grant(a.id, 'kc-bob', 'viewer');
    await grant(m.id, 'kc-bob', 'viewer');

    const shared = await list('shared', 'kc-bob');
    expect(shared.json().map((s: { title: string }) => s.title)).toEqual([
      'Shared Alpha', 'Shared Mid', 'Shared Zebra',
    ]);
  });

  it('never lists a schema twice when the caller both owns it and holds an explicit grant on it', async () => {
    const owned = await createSchema('kc-alice', 'Alice A', 'private');
    await grant(owned.id, 'kc-alice', 'editor'); // a redundant self-grant

    const mine = await list('mine', 'kc-alice');
    expect(mine.json().map((s: { title: string }) => s.title)).toEqual(['Alice A']);

    // And it must never leak into `shared` either, self-grant or not.
    const shared = await list('shared', 'kc-alice');
    expect(shared.json()).toEqual([]);
  });

  it('round-trips visibility through create, patch and every read', async () => {
    const token = await tokenFor('kc-alice');
    const created = (await harness.app.inject({
      method: 'POST', url: '/ontology-schemas', headers: harness.bearer(token),
      payload: { title: 'Roundtrip', visibility: 'unlisted' },
    })).json();
    expect(created.visibility).toBe('unlisted');

    const single = (await harness.app.inject({
      method: 'GET', url: `/ontology-schemas/${created.id}`, headers: harness.bearer(token),
    })).json();
    expect(single.visibility).toBe('unlisted');

    const patch = await harness.app.inject({
      method: 'PATCH', url: `/ontology-schemas/${created.id}`,
      headers: harness.bearer(token), payload: { visibility: 'public' },
    });
    expect(patch.statusCode).toBe(204);

    const list = (await harness.app.inject({
      method: 'GET', url: '/ontology-schemas?scope=mine', headers: harness.bearer(token),
    })).json();
    expect(list.find((s: { id: string }) => s.id === created.id).visibility).toBe('public');
  });

  it('defaults to private when visibility is omitted on create', async () => {
    const created = await createSchema('kc-alice', 'No visibility given');
    expect(created.visibility).toBe('private');

    // and stays out of the public scope, at the API-observable level.
    const pub = await list('public');
    expect(pub.json().map((s: { title: string }) => s.title)).not.toContain('No visibility given');
  });

  it('400s an invalid visibility value on create and on patch, not a database error', async () => {
    const token = await tokenFor('kc-alice');

    const create = await harness.app.inject({
      method: 'POST', url: '/ontology-schemas', headers: harness.bearer(token),
      payload: { title: 'Bad visibility', visibility: 'bogus' },
    });
    expect(create.statusCode).toBe(400);
    expect(create.body).not.toMatch(/constraint|check|internal server error/i);

    const schema = await createSchema('kc-alice', 'Fine on create');
    const patch = await harness.app.inject({
      method: 'PATCH', url: `/ontology-schemas/${schema.id}`,
      headers: harness.bearer(token), payload: { visibility: 'bogus' },
    });
    expect(patch.statusCode).toBe(400);
    expect(patch.body).not.toMatch(/constraint|check|internal server error/i);
  });

  it('never exposes owner_id on any read', async () => {
    const created = await createSchema('kc-alice', 'No owner leak', 'public');
    const res = await list('public');
    const row = res.json().find((s: { id: string }) => s.id === created.id);
    expect(row.owner_id).toBeUndefined();
    expect(row.ownerId).toBeUndefined();
  });

  it('lets an owner change visibility but rejects the same change from a mere editor, with 403', async () => {
    const owned = await createSchema('kc-alice', 'Alice A', 'private');
    await tokenFor('kc-bob');
    await list('mine', 'kc-bob');
    await grant(owned.id, 'kc-bob', 'editor');

    const bobToken = await tokenFor('kc-bob');

    // An editor may still edit ordinary fields...
    const titleEdit = await harness.app.inject({
      method: 'PATCH', url: `/ontology-schemas/${owned.id}`,
      headers: harness.bearer(bobToken), payload: { title: 'Edited by Bob' },
    });
    expect(titleEdit.statusCode).toBe(204);

    // ...but not visibility.
    const visibilityEdit = await harness.app.inject({
      method: 'PATCH', url: `/ontology-schemas/${owned.id}`,
      headers: harness.bearer(bobToken), payload: { visibility: 'public' },
    });
    expect(visibilityEdit.statusCode).toBe(403);

    const aliceToken = await tokenFor('kc-alice');
    const ownerEdit = await harness.app.inject({
      method: 'PATCH', url: `/ontology-schemas/${owned.id}`,
      headers: harness.bearer(aliceToken), payload: { visibility: 'public' },
    });
    expect(ownerEdit.statusCode).toBe(204);
  });
});
