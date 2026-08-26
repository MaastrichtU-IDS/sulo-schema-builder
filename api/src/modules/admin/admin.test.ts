// The operator surface, as a status matrix mirroring moderation.test.ts's own
// approach: authorization here is a global role too, decided without ever
// touching a schema's grants, so "who is the caller" is the interesting axis
// — the 404 for a moderator (not just an ordinary user) is the case this
// suite exists to pin down, since this surface has nothing to do with
// moderation.
//
// Fixture users go through the token path, never a hand-inserted `users`
// row for the SAME reason moderation.test.ts's header gives — except for
// the one deliberate exception in the "cache" describe block below, which
// needs a user who is ALREADY admin the very first time the token path ever
// sees them; see that block's own comment for why upsertBySubject makes
// that safe.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyPluginAsync } from 'fastify';
import sensible from '@fastify/sensible';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import { buildAuthedApp, type AuthedTestApp } from '../../test/authApp.js';
import schemasRoutes from '../schemas/routes.js';
import { claimNext } from '../reasoning/queue.repo.js';
import adminRoutes, { requireUserOrThrow } from './routes.js';

const whoami: FastifyPluginAsync = async (fastify) => {
  fastify.get('/whoami', async (request) => ({ user: request.user }));
};

// Mirrors routes/v1/index.ts's postgres branch: admin routes are a sibling
// of the schema routes (needed for job/usage fixtures), mounted at /admin.
const apiRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(schemasRoutes, { prefix: '/ontology-schemas' });
  await fastify.register(adminRoutes, { prefix: '/admin' });
  await fastify.register(whoami, { prefix: '' });
};

const SUBJECTS = {
  admin: 'kc-admin-admin',
  moderator: 'kc-admin-moderator',
  stranger: 'kc-admin-stranger',
} as const;

type Who = keyof typeof SUBJECTS | 'anonymous';

let t: TestDb;
let harness: AuthedTestApp;
const tokens = {} as Record<keyof typeof SUBJECTS, string>;
const userIds = {} as Record<keyof typeof SUBJECTS, string>;

function headers(who: Who) {
  return who === 'anonymous' ? undefined : harness.bearer(tokens[who]);
}

function getUsers(who: Who, query = '') {
  return harness.app.inject({ method: 'GET', url: `/admin/users${query}`, headers: headers(who) });
}

function patchUser(who: Who, id: string, body: Record<string, unknown>) {
  return harness.app.inject({ method: 'PATCH', url: `/admin/users/${id}`, headers: headers(who), payload: body });
}

function getUsage(who: Who, query = '') {
  return harness.app.inject({ method: 'GET', url: `/admin/usage${query}`, headers: headers(who) });
}

function getJobs(who: Who) {
  return harness.app.inject({ method: 'GET', url: '/admin/jobs', headers: headers(who) });
}

function requeue(who: Who, id: string | number) {
  return harness.app.inject({ method: 'POST', url: `/admin/jobs/${id}/requeue`, headers: headers(who) });
}

beforeAll(async () => {
  t = await startTestDb();
  harness = await buildAuthedApp(t.db, { routes: apiRoutes, prefix: '', userCacheTtlMs: 0 });

  for (const [who, subject] of Object.entries(SUBJECTS) as [keyof typeof SUBJECTS, string][]) {
    tokens[who] = await harness.issuer.sign({ sub: subject }, { expiresIn: '2h' });
    const seen = await harness.app.inject({ method: 'GET', url: '/whoami', headers: harness.bearer(tokens[who]) });
    expect(seen.statusCode, `first sight of ${who}`).toBe(200);
    const { rows } = await t.pool.query('select id from users where subject = $1', [subject]);
    userIds[who] = rows[0].id;
  }

  await t.db.updateTable('users').set({ global_role: 'moderator' }).where('subject', '=', SUBJECTS.moderator).execute();
  await t.db.updateTable('users').set({ global_role: 'admin' }).where('subject', '=', SUBJECTS.admin).execute();
});

afterAll(async () => {
  await harness.close();
  await t.stop();
});

beforeEach(async () => { await truncateAll(t.db); });

async function newSchema(who: keyof typeof SUBJECTS = 'admin'): Promise<string> {
  const res = await harness.app.inject({
    method: 'POST', url: '/ontology-schemas', headers: harness.bearer(tokens[who]), payload: { title: 'Admin fixture' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

describe('GET /admin/users', () => {
  it('lets an admin list users, including each one\'s own owned-schema count', async () => {
    await newSchema('stranger');
    await newSchema('stranger');

    const res = await getUsers('admin');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(3);
    const stranger = body.users.find((u: { id: string }) => u.id === userIds.stranger);
    expect(stranger).toMatchObject({ subject: SUBJECTS.stranger, globalRole: 'user', quotaTier: 'free', schemaCount: 2 });
  });

  it('paginates: limit/offset are respected and total reflects the whole set, not the page', async () => {
    const page1 = await getUsers('admin', '?limit=1&offset=0');
    expect(page1.statusCode).toBe(200);
    expect(page1.json().users).toHaveLength(1);
    expect(page1.json().total).toBeGreaterThanOrEqual(3);
  });

  it('404s a moderator — the route is the secret, not the resource', async () => {
    expect((await getUsers('moderator')).statusCode).toBe(404);
  });

  it('404s an ordinary signed-in user', async () => {
    expect((await getUsers('stranger')).statusCode).toBe(404);
  });

  it('401s an anonymous caller: a session is the missing thing', async () => {
    expect((await getUsers('anonymous')).statusCode).toBe(401);
  });
});

describe('PATCH /admin/users/:id', () => {
  it('lets an admin change a tier, and it takes effect immediately under userCacheTtlMs: 0', async () => {
    const res = await patchUser('admin', userIds.stranger, { quotaTier: 'staff' });
    expect(res.statusCode).toBe(204);

    const who = await harness.app.inject({ method: 'GET', url: '/whoami', headers: harness.bearer(tokens.stranger) });
    expect(who.json().user.tier).toBe('staff');
  });

  it('404s a well-formed id that names no user', async () => {
    const GHOST = '99999999-9999-9999-9999-999999999999';
    expect((await patchUser('admin', GHOST, { quotaTier: 'staff' })).statusCode).toBe(404);
  });

  it('400s a malformed user id rather than handing Postgres a bad uuid', async () => {
    expect((await patchUser('admin', 'not-a-uuid', { quotaTier: 'staff' })).statusCode).toBe(400);
  });

  it('refuses to let an admin demote themselves out of admin, to avoid locking out the last one', async () => {
    const res = await patchUser('admin', userIds.admin, { globalRole: 'user' });
    expect(res.statusCode).toBe(400);

    const row = await t.db.selectFrom('users').select('global_role').where('id', '=', userIds.admin).executeTakeFirstOrThrow();
    expect(row.global_role).toBe('admin');
  });

  it('still lets an admin change their OWN tier (only the role guard is special-cased)', async () => {
    const res = await patchUser('admin', userIds.admin, { quotaTier: 'staff' });
    expect(res.statusCode).toBe(204);
  });

  it('404s for a moderator, 404s for an ordinary user, 401s anonymous', async () => {
    expect((await patchUser('moderator', userIds.stranger, { quotaTier: 'staff' })).statusCode).toBe(404);
    expect((await patchUser('stranger', userIds.stranger, { quotaTier: 'staff' })).statusCode).toBe(404);
    expect((await patchUser('anonymous', userIds.stranger, { quotaTier: 'staff' })).statusCode).toBe(401);
  });
});

describe('GET /admin/usage', () => {
  it('returns aggregates per user and kind, not raw usage_events rows', async () => {
    for (let i = 0; i < 5; i += 1) {
      await t.db.insertInto('usage_events').values({
        user_id: userIds.stranger, kind: 'reason', schema_id: null, cost_ms: 100, cache_hit: i % 2 === 0,
      }).execute();
    }
    await t.db.insertInto('usage_events').values({
      user_id: userIds.stranger, kind: 'upper_concepts_fetch', schema_id: null, cost_ms: null, cache_hit: false,
    }).execute();

    const res = await getUsage('admin');
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // 6 raw events collapse to 2 groups: (stranger, reason) and (stranger, upper_concepts_fetch).
    const strangerRows = body.rows.filter((r: { userId: string }) => r.userId === userIds.stranger);
    expect(strangerRows).toHaveLength(2);

    const reasonRow = strangerRows.find((r: { kind: string }) => r.kind === 'reason');
    expect(reasonRow).toMatchObject({ cacheHits: 3, realRuns: 2, totalCostMs: 500 });
  });

  it('respects ?since=, excluding events before it', async () => {
    await t.db.insertInto('usage_events').values({
      user_id: userIds.stranger, kind: 'reason', schema_id: null, cost_ms: 10, cache_hit: false,
      created_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    }).execute();

    const res = await getUsage('admin', `?since=${encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().rows.filter((r: { userId: string }) => r.userId === userIds.stranger)).toHaveLength(0);
  });

  it('404s for a moderator, 404s for an ordinary user, 401s anonymous', async () => {
    expect((await getUsage('moderator')).statusCode).toBe(404);
    expect((await getUsage('stranger')).statusCode).toBe(404);
    expect((await getUsage('anonymous')).statusCode).toBe(401);
  });
});

describe('GET /admin/jobs and POST /admin/jobs/:id/requeue', () => {
  it('lists the current reason_jobs state', async () => {
    const schemaId = await newSchema();
    const inserted = await t.db.insertInto('reason_jobs').values({
      schema_id: schemaId, requested_by: userIds.admin, cache_key: 'k1', state: 'failed', error: 'boom',
    }).returning('id').executeTakeFirstOrThrow();

    const res = await getJobs('admin');
    expect(res.statusCode).toBe(200);
    const job = res.json().jobs.find((j: { id: number }) => j.id === Number(inserted.id));
    expect(job).toMatchObject({ schemaId, state: 'failed', error: 'boom' });
  });

  it('requeues a stuck (running) job, and it becomes claimable again', async () => {
    const schemaId = await newSchema();
    const inserted = await t.db.insertInto('reason_jobs').values({
      schema_id: schemaId, requested_by: userIds.admin, cache_key: 'k1', state: 'running',
      started_at: new Date(Date.now() - 10 * 60 * 1000), attempts: 2,
    }).returning('id').executeTakeFirstOrThrow();

    const res = await requeue('admin', inserted.id);
    expect(res.statusCode).toBe(204);

    const row = await t.db.selectFrom('reason_jobs').selectAll().where('id', '=', inserted.id).executeTakeFirstOrThrow();
    expect(row.state).toBe('queued');
    expect(row.attempts).toBe(0);
    expect(row.started_at).toBeNull();

    const claimed = await claimNext(t.db);
    expect(claimed?.id).toBe(Number(inserted.id));
  });

  it('requeues a failed job too', async () => {
    const schemaId = await newSchema();
    const inserted = await t.db.insertInto('reason_jobs').values({
      schema_id: schemaId, requested_by: userIds.admin, cache_key: 'k1', state: 'failed', error: 'boom',
    }).returning('id').executeTakeFirstOrThrow();

    expect((await requeue('admin', inserted.id)).statusCode).toBe(204);
    const row = await t.db.selectFrom('reason_jobs').select('state').where('id', '=', inserted.id).executeTakeFirstOrThrow();
    expect(row.state).toBe('queued');
  });

  it('refuses to requeue an already-queued or done job', async () => {
    const schemaId = await newSchema();
    const queued = await t.db.insertInto('reason_jobs').values({
      schema_id: schemaId, requested_by: userIds.admin, cache_key: 'k1', state: 'queued',
    }).returning('id').executeTakeFirstOrThrow();

    expect((await requeue('admin', queued.id)).statusCode).toBe(400);
  });

  it('404s a nonexistent job id', async () => {
    expect((await requeue('admin', 999999)).statusCode).toBe(404);
  });

  it('404s for a moderator, 404s for an ordinary user, 401s anonymous', async () => {
    const schemaId = await newSchema();
    const inserted = await t.db.insertInto('reason_jobs').values({
      schema_id: schemaId, requested_by: userIds.admin, cache_key: 'k1', state: 'failed',
    }).returning('id').executeTakeFirstOrThrow();

    expect((await getJobs('moderator')).statusCode).toBe(404);
    expect((await getJobs('stranger')).statusCode).toBe(404);
    expect((await getJobs('anonymous')).statusCode).toBe(401);
    expect((await requeue('moderator', inserted.id)).statusCode).toBe(404);
    expect((await requeue('stranger', inserted.id)).statusCode).toBe(404);
    expect((await requeue('anonymous', inserted.id)).statusCode).toBe(401);
  });
});

// Task 4's own required case: does a tier change actually reach the caller on
// their NEXT request, or does the 60s subject->user cache (plan 2) mean it
// doesn't? Answer, asserted rather than assumed: it does NOT, under the real
// default TTL — this is a genuine operator-facing surprise ("I changed their
// tier and they say nothing happened") worth having pinned down in a test
// rather than left as a support ticket.
//
// This harness deliberately uses the REAL default userCacheTtlMs (no
// override) — every other describe block above uses 0 specifically to avoid
// this effect. Getting an ADMIN identity into a cache-realistic harness
// without hitting the same staleness on the admin's OWN first request needs
// one exception to "never insert into users directly" (this file's own
// header): a row inserted with global_role already 'admin' BEFORE that
// subject's first token-path sign-in. users/repo.ts's upsertBySubject
// documents exactly why this is safe rather than a coincidence — its
// `on conflict` clause updates email/display_name/orcid/last_seen_at only,
// deliberately never global_role/quota_tier, "so a later sign-in must not
// reset a promotion". The first sign-in is itself that later sign-in.
describe('the subject->user cache delays a tier change reaching the target (real default TTL)', () => {
  it('does not show the new tier on the target\'s very next request', async () => {
    const t2 = await startTestDb();
    try {
      const preSeededAdminSubject = 'kc-admin-precached';
      await t2.pool.query(
        "insert into users (subject, global_role) values ($1, 'admin')", [preSeededAdminSubject],
      );

      // No userCacheTtlMs override: the real ~60s default applies.
      const cacheHarness = await buildAuthedApp(t2.db, { routes: apiRoutes, prefix: '' });
      try {
        const adminToken = await cacheHarness.issuer.sign({ sub: preSeededAdminSubject }, { expiresIn: '2h' });
        const adminFirstSight = await cacheHarness.app.inject({
          method: 'GET', url: '/whoami', headers: cacheHarness.bearer(adminToken),
        });
        expect(adminFirstSight.json().user.role).toBe('admin'); // proves the pre-seed survived upsertBySubject's ON CONFLICT

        const targetToken = await cacheHarness.issuer.sign({ sub: 'kc-admin-cache-target' }, { expiresIn: '2h' });
        const before = await cacheHarness.app.inject({ method: 'GET', url: '/whoami', headers: cacheHarness.bearer(targetToken) });
        expect(before.json().user.tier).toBe('free');
        const targetId = before.json().user.id as string;

        const patchRes = await cacheHarness.app.inject({
          method: 'PATCH', url: `/admin/users/${targetId}`, headers: cacheHarness.bearer(adminToken),
          payload: { quotaTier: 'staff' },
        });
        expect(patchRes.statusCode).toBe(204);

        // The database has the new value...
        const row = await t2.db.selectFrom('users').select('quota_tier').where('id', '=', targetId).executeTakeFirstOrThrow();
        expect(row.quota_tier).toBe('staff');

        // ...but the target's own cached RequestUser does not, yet: this
        // request lands well inside the ~60s TTL window since `before` above.
        const after = await cacheHarness.app.inject({ method: 'GET', url: '/whoami', headers: cacheHarness.bearer(targetToken) });
        expect(after.json().user.tier).toBe('free');
      } finally {
        await cacheHarness.close();
      }
    } finally {
      await t2.stop();
    }
  });
});

// Mirrors moderation.test.ts's own version of this test, for the same
// reason: the non-admin rejection must be byte-identical to server.ts's
// unregistered-route shape, or the pair becomes an oracle telling a moderator
// (who already knows they are signed in and can already reach every OTHER
// route they're allowed to) that an admin surface exists at this path.
describe('the non-admin rejection is byte-identical to an unregistered route', () => {
  it('for GET /admin/users', async () => {
    const unregistered = Fastify();
    await unregistered.register(sensible);
    unregistered.setNotFoundHandler((request, reply) => {
      reply.code(404).send({ error: 'not_found', message: `Route ${request.method}:${request.url} not found` });
    });
    await unregistered.ready();

    try {
      const rejected = await getUsers('moderator');
      const neverRegistered = await unregistered.inject({ method: 'GET', url: '/admin/users' });

      expect(rejected.statusCode).toBe(404);
      expect(rejected.body).toBe(neverRegistered.body);
      expect(rejected.headers['content-type']).toBe(neverRegistered.headers['content-type']);
    } finally {
      await unregistered.close();
    }
  });
});

// Same braces as moderation.routes.ts's own — exercised directly against the
// exported helper, since its contract does not depend on which server
// assembled the request.
describe('requireUserOrThrow', () => {
  it('throws when request.user is absent, instead of returning or admitting', () => {
    const fakeRequest = { user: null } as unknown as Parameters<typeof requireUserOrThrow>[0];
    expect(() => requireUserOrThrow(fakeRequest)).toThrow(/request\.user/);
  });

  it('returns the user when present', () => {
    const user = { id: '1', subject: 's', role: 'admin' as const, tier: 'free' as const };
    const fakeRequest = { user } as unknown as Parameters<typeof requireUserOrThrow>[0];
    expect(requireUserOrThrow(fakeRequest)).toBe(user);
  });
});

// Belt-through-the-actual-no-op-plugin, mirroring moderation.test.ts's own:
// proves that if the storage-mode registration switch in routes/v1/index.ts
// were ever bypassed, reaching this route with the real sqlite-mode no-op
// auth wiring is a loud 500, never a silent admission.
describe('reached with sqlite mode\'s no-op auth wiring', () => {
  it('500s instead of silently succeeding', async () => {
    const app = Fastify();
    await app.register(sensible);
    const { default: authDisabledPlugin } = await import('../../plugins/authDisabled.js');
    await app.register(authDisabledPlugin);
    await app.register(adminRoutes, { prefix: '/admin' });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/admin/users' });
    expect(res.statusCode).toBe(500);

    await app.close();
  });
});
