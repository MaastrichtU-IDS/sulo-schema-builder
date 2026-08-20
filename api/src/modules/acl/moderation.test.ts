// Abuse handling, as a small status matrix over one route.
//
// This is deliberately NOT the same shape as guards.test.ts's matrix: the
// authorization here is a global role, decided without ever loading the
// schema's grants, so the interesting axis is "who is the caller" rather than
// "what can they already see". The one status this suite exists to pin down
// is the 404 for an ordinary signed-in user — see moderation.routes.ts for why
// that (and not the schema routes' 403) is correct here.
//
// Fixture users are built through the token path, never by inserting `users`
// rows directly: test/pg.ts's truncateAll spares that table, and the auth
// plugin caches subject -> user, so a hand-inserted row would drift from the
// id the plugin resolves. Moderator/admin are promoted with an UPDATE *after*
// the token path creates the row (mirrors guards.test.ts), which is why this
// harness is built with userCacheTtlMs: 0.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyPluginAsync } from 'fastify';
import sensible from '@fastify/sensible';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import { buildAuthedApp, type AuthedTestApp } from '../../test/authApp.js';
import schemasRoutes from '../schemas/routes.js';
import moderationRoutes, { requireUserOrThrow } from './moderation.routes.js';

// Mirrors routes/v1/index.ts's postgres branch: the moderation routes are a
// sibling of the schema routes, mounted at /admin/schemas rather than sharing
// the schemas' own prefix (there is no `:id` collision to worry about — this
// route names no schema-scoped sub-resource of /ontology-schemas).
const apiRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(schemasRoutes, { prefix: '/ontology-schemas' });
  await fastify.register(moderationRoutes, { prefix: '/admin/schemas' });
};

const SUBJECTS = {
  owner: 'kc-mod-owner',
  moderator: 'kc-mod-moderator',
  admin: 'kc-mod-admin',
  stranger: 'kc-mod-stranger',
} as const;

type Who = keyof typeof SUBJECTS | 'anonymous';

let t: TestDb;
let harness: AuthedTestApp;
const tokens = {} as Record<keyof typeof SUBJECTS, string>;
const userIds = {} as Record<keyof typeof SUBJECTS, string>;

function headers(who: Who) {
  return who === 'anonymous' ? undefined : harness.bearer(tokens[who]);
}

function unpublish(who: Who, schemaId: string) {
  return harness.app.inject({
    method: 'POST', url: `/admin/schemas/${schemaId}/unpublish`, headers: headers(who),
  });
}

function get(who: Who, schemaId: string) {
  return harness.app.inject({ method: 'GET', url: `/ontology-schemas/${schemaId}`, headers: headers(who) });
}

function publicList(who: Who) {
  return harness.app.inject({ method: 'GET', url: '/ontology-schemas?scope=public', headers: headers(who) });
}

async function visibilityOf(schemaId: string): Promise<string> {
  const { rows } = await t.pool.query('select visibility from schemas where id = $1', [schemaId]);
  return rows[0].visibility;
}

/** A schema created through the API by `who`, then set to the given visibility directly. */
async function newSchema(visibility: 'private' | 'unlisted' | 'public', who: keyof typeof SUBJECTS = 'owner'): Promise<string> {
  const res = await harness.app.inject({
    method: 'POST', url: '/ontology-schemas', headers: harness.bearer(tokens[who]), payload: { title: 'Abuse target' },
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  await t.pool.query('update schemas set visibility = $1 where id = $2', [visibility, id]);
  return id;
}

beforeAll(async () => {
  t = await startTestDb();
  harness = await buildAuthedApp(t.db, { routes: apiRoutes, prefix: '', userCacheTtlMs: 0 });

  for (const [who, subject] of Object.entries(SUBJECTS) as [keyof typeof SUBJECTS, string][]) {
    tokens[who] = await harness.issuer.sign({ sub: subject }, { expiresIn: '2h' });
    const seen = await harness.app.inject({
      method: 'GET', url: '/ontology-schemas', headers: harness.bearer(tokens[who]),
    });
    expect(seen.statusCode, `first sight of ${who}`).toBe(200);
    const { rows } = await t.pool.query('select id from users where subject = $1', [subject]);
    userIds[who] = rows[0].id;
  }

  await t.db.updateTable('users').set({ global_role: 'moderator' })
    .where('subject', '=', SUBJECTS.moderator).execute();
  await t.db.updateTable('users').set({ global_role: 'admin' })
    .where('subject', '=', SUBJECTS.admin).execute();
});

afterAll(async () => {
  await harness.close();
  await t.stop();
});

beforeEach(async () => { await truncateAll(t.db); });

describe('POST /admin/schemas/:id/unpublish', () => {
  it('lets a moderator force a public schema private, and it leaves the public list', async () => {
    const id = await newSchema('public');
    expect((await publicList('stranger')).json().map((s: { id: string }) => s.id)).toContain(id);

    const res = await unpublish('moderator', id);
    expect(res.statusCode).toBe(204);
    expect(await visibilityOf(id)).toBe('private');
    expect((await publicList('stranger')).json().map((s: { id: string }) => s.id)).not.toContain(id);
  });

  it('lets an admin do the same', async () => {
    const id = await newSchema('public');
    const res = await unpublish('admin', id);
    expect(res.statusCode).toBe(204);
    expect(await visibilityOf(id)).toBe('private');
  });

  // The route is the secret, not the schema: an ordinary signed-in user must
  // not learn that an admin surface exists at this path. See
  // moderation.routes.ts for the full reasoning — this deliberately differs
  // from the 403 the schema routes give a known-but-unauthorised caller.
  it('404s for an ordinary signed-in user, not 403', async () => {
    const id = await newSchema('public');
    const res = await unpublish('stranger', id);
    expect(res.statusCode).toBe(404);
    expect(await visibilityOf(id)).toBe('public');
  });

  it('401s an anonymous caller: a session is the missing thing', async () => {
    const id = await newSchema('public');
    const res = await unpublish('anonymous', id);
    expect(res.statusCode).toBe(401);
    expect(await visibilityOf(id)).toBe('public');
  });

  it('is idempotent: unpublishing an already-private schema succeeds rather than erroring', async () => {
    const id = await newSchema('private');
    const res = await unpublish('moderator', id);
    expect(res.statusCode).toBe(204);
    expect(await visibilityOf(id)).toBe('private');
  });

  it('leaves the owner\'s own access unchanged', async () => {
    const id = await newSchema('public');
    await unpublish('moderator', id);

    // The owner still holds `own` — unpublishing removes publication, not
    // ownership — so both reading and editing the (now-private) schema still
    // work exactly as before.
    expect((await get('owner', id)).statusCode).toBe(200);
    const patch = await harness.app.inject({
      method: 'PATCH', url: `/ontology-schemas/${id}`, headers: harness.bearer(tokens.owner),
      payload: { title: 'Still mine' },
    });
    expect(patch.statusCode).toBe(204);
  });

  it('400s a malformed schema id rather than handing Postgres a bad uuid', async () => {
    expect((await unpublish('moderator', 'not-a-uuid')).statusCode).toBe(400);
  });

  it('404s a well-formed id that names no schema', async () => {
    const GHOST = '99999999-9999-9999-9999-999999999999';
    expect((await unpublish('moderator', GHOST)).statusCode).toBe(404);
  });
});

// Decision 1's braces: a helper that throws loudly if request.user is absent,
// rather than letting a role check silently pass or crash on a bare property
// read. This is what protects a FUTURE role-guarded route that (unlike this
// one) forgets the storage-mode registration switch in routes/v1/index.ts —
// registered in sqlite mode, plugins/authDisabled.ts's no-op requireRole/
// authRequired would let any request through with request.user still null,
// and this is what turns that into a loud 500 instead of a silent admission.
//
// Exercised directly against the exported helper — not by building a second,
// sqlite-mode server (legacy sqlite storage + the reasoner + robot bootstrap
// have nothing to do with this task) — because the helper's contract does not
// depend on which server assembled the request.
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

// Belt-through-the-actual-no-op-plugin: proves that if the storage-mode
// registration switch in routes/v1/index.ts were ever bypassed and this
// route were reached with the real sqlite-mode auth wiring (authDisabled.ts's
// no-op authRequired/requireRole, request.user permanently null), the result
// is a loud 500 — never a 200/204 that would mean the request was silently
// admitted. This is the same guarantee as the unit test above, exercised
// through the real plugin rather than a fake request object.
describe('reached with sqlite mode\'s no-op auth wiring', () => {
  it('500s instead of silently succeeding', async () => {
    const app = Fastify();
    await app.register(sensible);
    const { default: authDisabledPlugin } = await import('../../plugins/authDisabled.js');
    await app.register(authDisabledPlugin);
    await app.register(moderationRoutes, { prefix: '/admin/schemas' });
    await app.ready();

    const res = await app.inject({
      method: 'POST', url: `/admin/schemas/${'11111111-1111-1111-1111-111111111111'}/unpublish`,
    });
    expect(res.statusCode).toBe(500);

    await app.close();
  });
});
