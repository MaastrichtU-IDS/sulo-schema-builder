// What authentication buys the schema routes: a session is mandatory for every
// write, and a schema belongs to whoever created it rather than to the pre-auth
// seed row.
//
// AMENDED BY PLAN 3, TASK 2 (the ACL enforcement point) — deliberately, not a
// regression. This file used to assert 401 for all twelve routes without a
// token. That is now wrong for the two read routes:
//
//   * GET /ontology-schemas answers 200 with a list *for a caller with no
//     token*. Reading the catalogue is open; an anonymous caller defaults to
//     `?scope=public` (task 3). A caller with a token that is expired or
//     unverifiable still gets 401, and one the server cannot resolve gets 503 —
//     anonymity is the absence of a session, not a broken one.
//   * GET /ontology-schemas/:id answers 200 anonymously for a public or
//     unlisted schema, and 404 — never 401, never 403 — for a private one,
//     because a caller who may not see a schema must not learn it exists.
//
// Every route that *writes* is still 401 without a token, and the list below is
// now a stronger claim than the one it replaces: it runs against a real, fully
// public schema. Against the nonexistent uuid the old list used, an anonymous
// write would 404 (correctly, by the rule above), and the test would pass
// without ever exercising the session requirement at all.
// GET /:id/upper-concepts also stays 401: reading is view-level, but making the
// server dereference a remote IRI is a privilege of signed-in users (plan 2,
// spec §5), so it carries authRequired *and* the ACL guard.
//
// The full 404/403/401/200 matrix — grants, visibility, global roles, the
// nonexistent-versus-invisible pair — lives in src/modules/acl/guards.test.ts.
// Keep this file about *sessions*.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import { buildAuthedApp, type AuthedTestApp } from '../../test/authApp.js';
import { stopPendingChecks } from '../reasoning/pipeline.js';

let t: TestDb;
let harness: AuthedTestApp;

const GHOST = '11111111-1111-1111-1111-111111111111';
const CHILD = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  t = await startTestDb();
  harness = await buildAuthedApp(t.db);
});

afterAll(async () => {
  // See routes.test.ts's afterAll for why: a mutating request here schedules
  // a debounced check against this file's own pool.
  stopPendingChecks();
  await harness.close();
  await t.stop();
});

beforeEach(async () => { await truncateAll(t.db); });

/**
 * A schema created through the API by `subject`, then published.
 *
 * Visibility is set with a direct UPDATE rather than through PATCH /:id (which
 * does expose it now, at `own` — task 3) so that setting up a fixture never
 * depends on the very ACL guard this file is testing. Tasks 3 (`?scope=`), 4
 * (grants) and 5 (the moderator unpublish route) have all shipped; this file
 * stays about sessions regardless, per the header above. The owner still
 * comes from the token path, so the `users` row is the one the auth plugin
 * minted and cached.
 */
async function schemaOwnedBy(
  subject: string, visibility: 'private' | 'unlisted' | 'public', title: string,
): Promise<string> {
  const token = await harness.issuer.sign({ sub: subject }, { expiresIn: '2h' });
  const created = (await harness.app.inject({
    method: 'POST', url: '/ontology-schemas', headers: harness.bearer(token), payload: { title },
  })).json();
  await t.pool.query('update schemas set visibility = $1 where id = $2', [visibility, created.id]);
  return created.id;
}

describe('schema routes under authentication', () => {
  it('401s every write route without a token, even on a fully public schema', async () => {
    const id = await schemaOwnedBy('kc-publisher', 'public', 'Wide open');

    for (const [method, url] of [
      ['POST', '/ontology-schemas'],
      ['PATCH', `/ontology-schemas/${id}`],
      ['DELETE', `/ontology-schemas/${id}`],
      // Not a write, but a signed-in-only read: it makes the server fetch.
      ['GET', `/ontology-schemas/${id}/upper-concepts`],
      ['POST', `/ontology-schemas/${id}/classes`],
      ['PATCH', `/ontology-schemas/${id}/classes/${CHILD}`],
      ['DELETE', `/ontology-schemas/${id}/classes/${CHILD}`],
      ['POST', `/ontology-schemas/${id}/properties`],
      ['PATCH', `/ontology-schemas/${id}/properties/${CHILD}`],
      ['DELETE', `/ontology-schemas/${id}/properties/${CHILD}`],
    ] as const) {
      const res = await harness.app.inject({
        method, url,
        payload: method === 'GET' || method === 'DELETE' ? undefined : { title: 'x', name: 'x' },
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  // The other side of the amendment above: the two read routes answer without a
  // session, and the private one is invisible rather than forbidden.
  //
  // Task 3 activated `?scope=`: an anonymous caller's default scope is now
  // `public`, so the list carries the public schema and omits the private
  // one — the full scope matrix (mine/shared/public, the 401 for mine/shared
  // without a session, the 400 for an unknown scope) lives in
  // modules/schemas/listing.test.ts. This file stays about sessions.
  it('serves the read routes without a token, and hides a private schema behind a 404', async () => {
    const open = await schemaOwnedBy('kc-publisher', 'public', 'Open');
    const secret = await schemaOwnedBy('kc-hoarder', 'private', 'Secret');

    const list = await harness.app.inject({ method: 'GET', url: '/ontology-schemas' });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((s: { title: string }) => s.title)).toEqual(['Open']);

    const read = await harness.app.inject({ method: 'GET', url: `/ontology-schemas/${open}` });
    expect(read.statusCode).toBe(200);
    expect(read.json().title).toBe('Open');

    const hidden = await harness.app.inject({ method: 'GET', url: `/ontology-schemas/${secret}` });
    const missing = await harness.app.inject({ method: 'GET', url: `/ontology-schemas/${GHOST}` });
    expect(hidden.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(hidden.body).toBe(missing.body);
  });

  // Was asserted on GET /ontology-schemas, which is now anonymous-readable.
  // Kept there anyway (next test) *and* extended to a write, because the point
  // is that an unverifiable token buys nothing a missing one would not.
  it('401s a write whose token does not verify, rather than treating it as anonymous-but-allowed', async () => {
    const res = await harness.app.inject({
      method: 'POST', url: '/ontology-schemas',
      headers: harness.bearer('not.a.real.jwt'), payload: { title: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });

  // Fix round 1, finding 1. Opening GET / to anonymous callers must not also
  // open it to *broken* sessions: an expired token answering `200 []` tells a
  // signed-in user every schema they own has disappeared, and gives their SPA
  // nothing to re-authenticate on. Absent token → 200 []; present-but-invalid
  // token → 401. (The outage case, 503, is covered without a database in
  // src/modules/acl/guards.unavailable.test.ts.)
  it('401s the open list route for an expired or unverifiable token, but not for no token at all', async () => {
    await schemaOwnedBy('kc-alice', 'private', 'Alice only');
    const expired = await harness.issuer.sign({ sub: 'kc-alice' }, { expiresIn: '-2h' });

    for (const token of ['not.a.real.jwt', expired]) {
      const res = await harness.app.inject({
        method: 'GET', url: '/ontology-schemas', headers: harness.bearer(token),
      });
      expect(res.statusCode).toBe(401);
    }

    const anonymous = await harness.app.inject({ method: 'GET', url: '/ontology-schemas' });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json()).toEqual([]);
  });

  it('attributes a created schema to the caller', async () => {
    const token = await harness.issuer.sign({ sub: 'kc-owner' });
    const created = (await harness.app.inject({
      method: 'POST', url: '/ontology-schemas', headers: harness.bearer(token), payload: { title: 'Mine' },
    })).json();

    const { rows } = await t.pool.query(
      'select u.subject from schemas s join users u on u.id = s.owner_id where s.id = $1', [created.id],
    );
    expect(rows[0].subject).toBe('kc-owner');
  });

  it('lists only the caller own schemas', async () => {
    const alice = await harness.issuer.sign({ sub: 'kc-alice' });
    const bob = await harness.issuer.sign({ sub: 'kc-bob' });

    await harness.app.inject({ method: 'POST', url: '/ontology-schemas', headers: harness.bearer(alice), payload: { title: 'Alice A' } });
    await harness.app.inject({ method: 'POST', url: '/ontology-schemas', headers: harness.bearer(bob), payload: { title: 'Bob B' } });

    const mine = (await harness.app.inject({ method: 'GET', url: '/ontology-schemas', headers: harness.bearer(alice) })).json();
    expect(mine.map((s: { title: string }) => s.title)).toEqual(['Alice A']);
  });

  it('two sign-ins by the same subject share one owner row', async () => {
    const token = await harness.issuer.sign({ sub: 'kc-twice' });
    await harness.app.inject({ method: 'POST', url: '/ontology-schemas', headers: harness.bearer(token), payload: { title: 'One' } });
    await harness.app.inject({ method: 'POST', url: '/ontology-schemas', headers: harness.bearer(token), payload: { title: 'Two' } });

    const mine = (await harness.app.inject({ method: 'GET', url: '/ontology-schemas', headers: harness.bearer(token) })).json();
    expect(mine).toHaveLength(2);
    const { rows } = await t.pool.query('select count(*)::int as n from users where subject = $1', ['kc-twice']);
    expect(rows[0].n).toBe(1);
  });

  // Fix round 1, finding 4. The only route in the table whose level cannot be
  // weakened without the rest of the suite noticing: every mutation is covered
  // by the anonymous-write list above (an anonymous caller has `view` on a
  // public schema, so a mutation downgraded to `view` would answer 204/201
  // instead of 401), but DELETE /:id going from `own` to `edit` is invisible
  // there — an editor-grantee could then delete someone else's schema and
  // nothing would fail. PATCH in the same test is the control: it proves the
  // grant is real and that the difference is the level, not the grantee.
  it('lets an editor-grantee patch a schema but not delete it', async () => {
    const id = await schemaOwnedBy('kc-alice', 'private', 'Alice only');
    const bob = await harness.issuer.sign({ sub: 'kc-bob' }, { expiresIn: '2h' });

    // Make Bob known through the token path, then grant him `editor`.
    await harness.app.inject({ method: 'GET', url: '/ontology-schemas', headers: harness.bearer(bob) });
    await t.pool.query(
      `insert into schema_grants (schema_id, grantee_id, role)
       select $1, id, 'editor' from users where subject = $2`,
      [id, 'kc-bob'],
    );

    const patch = await harness.app.inject({
      method: 'PATCH', url: `/ontology-schemas/${id}`,
      headers: harness.bearer(bob), payload: { title: 'Edited by Bob' },
    });
    expect(patch.statusCode).toBe(204);

    // An editor grant must not just fail to be *looser* than required (the
    // DELETE below) — it must actually be *enough* to write children. Nothing
    // else in this file, or in guards.test.ts, ever has an editor-grantee add
    // a class, so this is the only thing standing between `edit` and `own` on
    // the six child-write routes.
    const addClass = await harness.app.inject({
      method: 'POST', url: `/ontology-schemas/${id}/classes`,
      headers: harness.bearer(bob), payload: { name: 'BobClass' },
    });
    expect(addClass.statusCode).toBe(201);

    const del = await harness.app.inject({
      method: 'DELETE', url: `/ontology-schemas/${id}`, headers: harness.bearer(bob),
    });
    expect(del.statusCode).toBe(403);

    // The row is still there, and its owner can delete it.
    const alice = await harness.issuer.sign({ sub: 'kc-alice' }, { expiresIn: '2h' });
    const owned = await harness.app.inject({
      method: 'DELETE', url: `/ontology-schemas/${id}`, headers: harness.bearer(alice),
    });
    expect(owned.statusCode).toBe(204);

    const { rows } = await t.pool.query('select count(*)::int as n from schemas where id = $1', [id]);
    expect(rows[0].n).toBe(0);
  });

  // Plan 2 left this open on purpose and plan 3 closed it; the assertion lives
  // here as well as in the ACL matrix because "Bob is a known Bob" was this
  // file's promise, and "a known Bob is not everyone" is what completes it.
  it('refuses Bob a direct read of Alice private schema', async () => {
    const alices = await schemaOwnedBy('kc-alice', 'private', 'Alice only');
    const bob = await harness.issuer.sign({ sub: 'kc-bob' });

    const res = await harness.app.inject({
      method: 'GET', url: `/ontology-schemas/${alices}`, headers: harness.bearer(bob),
    });
    expect(res.statusCode).toBe(404);
  });
});
