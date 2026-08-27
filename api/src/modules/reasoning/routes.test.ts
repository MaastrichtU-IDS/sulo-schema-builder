// The report endpoints as a status/visibility matrix, mirroring
// modules/acl/grants.test.ts's approach: the routes are mounted exactly as
// routes/v1/index.ts mounts them (schema, grants and reasoning trees sharing
// the /ontology-schemas prefix), so the sibling `aclGuards` registration this
// arrangement requires is exercised rather than assumed.
//
// Fixture users go through the token path, never a hand-inserted `users`
// row — see grants.test.ts's header for why.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyPluginAsync } from 'fastify';
import sensible from '@fastify/sensible';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import { buildAuthedApp, type AuthedTestApp } from '../../test/authApp.js';
import errorHandler from '../../plugins/errorHandler.js';
import schemasRoutes from '../schemas/routes.js';
import grantsRoutes from '../acl/grants.routes.js';
import { TIERS } from '../quota/tiers.js';
import { REASON_RUN } from '../quota/service.js';
import { stopPendingChecks } from './pipeline.js';
import reasoningRoutes from './routes.js';

const apiRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(schemasRoutes, { prefix: '/ontology-schemas' });
  await fastify.register(grantsRoutes, { prefix: '/ontology-schemas' });
  await fastify.register(reasoningRoutes, { prefix: '/ontology-schemas' });
};

const PEOPLE = {
  owner: 'kc-report-owner',
  viewer: 'kc-report-viewer',
  editor: 'kc-report-editor',
  stranger: 'kc-report-stranger',
} as const;
type Who = keyof typeof PEOPLE;

let t: TestDb;
let harness: AuthedTestApp;
const tokens = {} as Record<Who, string>;
const userIds = {} as Record<Who, string>;

const auth = (who: Who) => harness.bearer(tokens[who]);

beforeAll(async () => {
  t = await startTestDb();
  harness = await buildAuthedApp(t.db, { routes: apiRoutes, prefix: '' });

  for (const [who, subject] of Object.entries(PEOPLE) as [Who, string][]) {
    tokens[who] = await harness.issuer.sign({ sub: subject }, { expiresIn: '2h' });
    const seen = await harness.app.inject({ method: 'GET', url: '/ontology-schemas', headers: auth(who) });
    expect(seen.statusCode, `first sight of ${who}`).toBe(200);
    const { rows } = await t.pool.query('select id from users where subject = $1', [subject]);
    userIds[who] = rows[0].id;
  }
});

afterAll(async () => {
  stopPendingChecks();
  await harness.close();
  await t.stop();
});

beforeEach(async () => { await truncateAll(t.db); });

async function newSchema(visibility: 'private' | 'public' = 'private'): Promise<string> {
  const res = await harness.app.inject({
    method: 'POST', url: '/ontology-schemas', headers: auth('owner'), payload: { title: 'Report fixture' },
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().id;
  if (visibility !== 'private') {
    await t.db.updateTable('schemas').set({ visibility }).where('id', '=', id).execute();
  }
  return id;
}

async function grant(schemaId: string, role: 'viewer' | 'editor'): Promise<void> {
  const res = await harness.app.inject({
    method: 'PUT', url: `/ontology-schemas/${schemaId}/grants/${userIds[role]}`,
    headers: auth('owner'), payload: { role },
  });
  expect(res.statusCode).toBe(200);
}

function getReport(who: Who | 'anonymous', schemaId: string) {
  return harness.app.inject({
    method: 'GET', url: `/ontology-schemas/${schemaId}/report`,
    ...(who === 'anonymous' ? {} : { headers: auth(who) }),
  });
}

function refresh(who: Who | 'anonymous', schemaId: string) {
  return harness.app.inject({
    method: 'POST', url: `/ontology-schemas/${schemaId}/report/refresh`,
    ...(who === 'anonymous' ? {} : { headers: auth(who) }),
  });
}

describe('GET /:id/report', () => {
  it('a schema that has never been checked says so explicitly, with no report key', async () => {
    const schemaId = await newSchema();
    const res = await getReport('owner', schemaId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'stale', cacheKey: '', computedAt: null, stale: false });
    expect(res.json().report).toBeUndefined();
  });

  it('an owner reads a report', async () => {
    const schemaId = await newSchema();
    const res = await getReport('owner', schemaId);
    expect(res.statusCode).toBe(200);
  });

  it('a viewer grantee reads it', async () => {
    const schemaId = await newSchema();
    await grant(schemaId, 'viewer');
    const res = await getReport('viewer', schemaId);
    expect(res.statusCode).toBe(200);
  });

  it('a stranger gets 404, identical to a nonexistent schema', async () => {
    const schemaId = await newSchema();
    const real = await getReport('stranger', schemaId);
    const ghost = await getReport('stranger', '99999999-9999-9999-9999-999999999999');
    expect(real.statusCode).toBe(404);
    expect(ghost.statusCode).toBe(404);
    expect(real.json()).toEqual(ghost.json());
  });

  it('an anonymous caller reads the report of a public schema', async () => {
    const schemaId = await newSchema('public');
    const res = await getReport('anonymous', schemaId);
    expect(res.statusCode).toBe(200);
  });

  it('an anonymous caller gets 404 for a private schema', async () => {
    const schemaId = await newSchema('private');
    const res = await getReport('anonymous', schemaId);
    expect(res.statusCode).toBe(404);
  });

  it('reports the previous verdict, flagged stale, once edited since the last successful check', async () => {
    const schemaId = await newSchema();
    // Fabricate "already checked, then edited": a real report on file, but
    // reason_state moved back to stale (exactly what a later mutation does).
    await t.db.insertInto('reasoning_reports').values({
      cache_key: 'fixture-key', report: JSON.stringify({ consistent: true, reasoner: 'HermiT', clashes: [] }),
      reasoner: 'HermiT', sulo_hash: 'irrelevant', duration_ms: 10,
    }).execute();
    await t.db.updateTable('schemas')
      .set({ reason_state: 'stale', latest_report_key: 'fixture-key' })
      .where('id', '=', schemaId).execute();

    const res = await getReport('owner', schemaId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'stale', stale: true, cacheKey: 'fixture-key' });
    expect(res.json().report).toEqual({ consistent: true, reasoner: 'HermiT', clashes: [] });
  });
});

describe('POST /:id/report/refresh', () => {
  it('a viewer cannot refresh (403)', async () => {
    const schemaId = await newSchema();
    await grant(schemaId, 'viewer');
    const res = await refresh('viewer', schemaId);
    expect(res.statusCode).toBe(403);
  });

  it('an editor can refresh', async () => {
    const schemaId = await newSchema();
    await grant(schemaId, 'editor');
    const res = await refresh('editor', schemaId);
    expect(res.statusCode).toBe(202);
  });

  it('anonymous gets 401 (a session is the missing thing, not an admin secret)', async () => {
    const schemaId = await newSchema('public');
    const res = await refresh('anonymous', schemaId);
    expect(res.statusCode).toBe(401);
  });

  it('is a no-op success on an already-fresh schema, rather than a duplicate run', async () => {
    const schemaId = await newSchema();
    await t.db.updateTable('schemas').set({ reason_state: 'fresh' }).where('id', '=', schemaId).execute();

    const res = await refresh('owner', schemaId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: 'already-fresh' });

    // No job was created for it.
    const jobs = await t.db.selectFrom('reason_jobs').selectAll().where('schema_id', '=', schemaId).execute();
    expect(jobs).toHaveLength(0);
  });

  it('returns 429 with retryAfter once the requester is over their tier\'s runs-per-hour quota', async () => {
    const schemaId = await newSchema();
    for (let i = 0; i < TIERS.free.runsPerHour; i += 1) {
      await t.db.insertInto('usage_events').values({
        user_id: userIds.owner, kind: REASON_RUN, schema_id: null, cost_ms: 5, cache_hit: false,
      }).execute();
    }

    const res = await refresh('owner', schemaId);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'quota_exceeded' });
    expect(typeof res.json().retryAfter).toBe('number');
    expect(res.json().retryAfter).toBeGreaterThan(0);
  });
});

// Mirrors grants.test.ts's own version of this test: `fastify-plugin` lets
// aclGuards escape exactly one encapsulation level, so a plugin tree
// registering this file's routes as a sibling does not inherit the
// decorator — this file has to register aclGuards itself. Forgetting is
// otherwise silent (Fastify does not seal `request`), so this is the one
// test that actually fails if the registration is removed.
describe('the aclGuards registration this plugin owns', () => {
  it('refuses to boot on an instance without the auth plugin request decorators', async () => {
    const app = Fastify();
    await app.register(sensible);
    await app.register(errorHandler);
    app.decorate('pg', t.db);
    app.register(reasoningRoutes, { prefix: '/ontology-schemas' });

    await expect(app.ready().then(() => 'booted')).rejects.toThrow(/user/);
    await app.close();
  });
});
