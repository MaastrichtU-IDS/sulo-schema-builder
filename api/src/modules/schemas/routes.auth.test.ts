// What authentication buys the schema routes: a session is mandatory, and a
// schema belongs to whoever created it rather than to the pre-auth seed row.
//
// DELIBERATELY ABSENT: a test that Bob is refused a direct
// GET /ontology-schemas/:id of Alice's schema. That is cross-user read
// protection, which is the ACL's job (plan 3: visibility, grants, ?scope=
// filtering and 404-not-403 semantics). Today Bob *can* read Alice's schema by
// id — this task only guarantees that Bob is a known, authenticated Bob. The
// gap is known, not forgotten; do not plug it here.

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

describe('schema routes under authentication', () => {
  it('401s every route without a token', async () => {
    for (const [method, url] of [
      ['GET', '/ontology-schemas'],
      ['POST', '/ontology-schemas'],
      ['GET', '/ontology-schemas/11111111-1111-1111-1111-111111111111'],
      ['PATCH', '/ontology-schemas/11111111-1111-1111-1111-111111111111'],
      ['DELETE', '/ontology-schemas/11111111-1111-1111-1111-111111111111'],
      ['GET', '/ontology-schemas/11111111-1111-1111-1111-111111111111/upper-concepts'],
      ['POST', '/ontology-schemas/11111111-1111-1111-1111-111111111111/classes'],
      ['PATCH', '/ontology-schemas/11111111-1111-1111-1111-111111111111/classes/22222222-2222-2222-2222-222222222222'],
      ['DELETE', '/ontology-schemas/11111111-1111-1111-1111-111111111111/classes/22222222-2222-2222-2222-222222222222'],
      ['POST', '/ontology-schemas/11111111-1111-1111-1111-111111111111/properties'],
      ['PATCH', '/ontology-schemas/11111111-1111-1111-1111-111111111111/properties/22222222-2222-2222-2222-222222222222'],
      ['DELETE', '/ontology-schemas/11111111-1111-1111-1111-111111111111/properties/22222222-2222-2222-2222-222222222222'],
    ] as const) {
      const res = await harness.app.inject({
        method, url,
        payload: method === 'GET' || method === 'DELETE' ? undefined : { title: 'x', name: 'x' },
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('401s a route whose token does not verify, rather than treating it as anonymous-but-allowed', async () => {
    const res = await harness.app.inject({
      method: 'GET', url: '/ontology-schemas', headers: harness.bearer('not.a.real.jwt'),
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
});
