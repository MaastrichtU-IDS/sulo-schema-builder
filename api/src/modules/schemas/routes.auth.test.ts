// What authentication buys the schema routes: a session is mandatory for every
// write, and a schema belongs to whoever created it rather than to the pre-auth
// seed row.
//
// AMENDED BY PLAN 3, TASK 2 (the ACL enforcement point) — deliberately, not a
// regression. This file used to assert 401 for all twelve routes without a
// token. That is now wrong for the two read routes:
//
//   * GET /ontology-schemas answers 200 with a list. Reading the catalogue is
//     open; an anonymous caller gets [] until `?scope=` arrives in task 3.
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

let t: TestDb;
let harness: AuthedTestApp;

const GHOST = '11111111-1111-1111-1111-111111111111';
const CHILD = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  t = await startTestDb();
  harness = await buildAuthedApp(t.db);
});

afterAll(async () => {
  await harness.close();
  await t.stop();
});

beforeEach(async () => { await truncateAll(t.db); });

/**
 * A schema created through the API by `subject`, then published.
 *
 * Visibility is set with an UPDATE because no route exposes it yet (task 4).
 * The owner still comes from the token path, so the `users` row is the one the
 * auth plugin minted and cached.
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
  it('serves the read routes without a token, and hides a private schema behind a 404', async () => {
    const open = await schemaOwnedBy('kc-publisher', 'public', 'Open');
    const secret = await schemaOwnedBy('kc-hoarder', 'private', 'Secret');

    const list = await harness.app.inject({ method: 'GET', url: '/ontology-schemas' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);

    const read = await harness.app.inject({ method: 'GET', url: `/ontology-schemas/${open}` });
    expect(read.statusCode).toBe(200);
    expect(read.json().title).toBe('Open');

    const hidden = await harness.app.inject({ method: 'GET', url: `/ontology-schemas/${secret}` });
    const missing = await harness.app.inject({ method: 'GET', url: `/ontology-schemas/${GHOST}` });
    expect(hidden.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(hidden.body).toBe(missing.body);
  });

  // Was GET /ontology-schemas, which is now anonymous-readable; moved to a
  // route where anonymity is still refused, so the assertion keeps its point:
  // an unverifiable token must not buy anything a missing one would not.
  it('401s a write whose token does not verify, rather than treating it as anonymous-but-allowed', async () => {
    const res = await harness.app.inject({
      method: 'POST', url: '/ontology-schemas',
      headers: harness.bearer('not.a.real.jwt'), payload: { title: 'x' },
    });
    expect(res.statusCode).toBe(401);
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
