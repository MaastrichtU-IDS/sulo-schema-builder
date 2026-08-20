// Sharing, as a status matrix over one schema.
//
// This suite is the contract for four privilege surfaces — list, grant, revoke,
// transfer — plus the email lookup that turns something a human knows into a
// user id. Every case here is about *who may*, so the numbers matter as much as
// the behaviour, and they follow the same policy the guard suite established:
//
//   404  the caller may not know this schema exists (a stranger).
//   403  the caller can already see it and lacks `own` (an editor-grantee).
//   400  the request named something real but incoherent (a self-grant).
//   401  the only missing thing is a session (the lookup, unauthenticated).
//
// "An editor gets 403 and a stranger gets 404" is the pair that proves the
// guard is doing the work: if both answered the same, the endpoint would either
// be an existence oracle or be hiding a schema from someone who can already
// open it.
//
// Fixture users are built through the token path — the auth plugin's onRequest
// upserts a `users` row on first sight — never by inserting `users` directly:
// test/pg.ts's truncateAll spares that table on purpose, and a hand-inserted
// row drifts from the id the plugin caches. Their ids are then read back once.
//
// The routes are mounted exactly as routes/v1/index.ts mounts them (three
// sibling plugins, the grants and schema trees sharing the /ontology-schemas
// prefix), so the sibling registration of `aclGuards` this arrangement requires
// is exercised rather than assumed. What happens when someone deletes that
// registration is asserted separately, at the bottom of this file.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyPluginAsync } from 'fastify';
import sensible from '@fastify/sensible';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import { buildAuthedApp, type AuthedTestApp } from '../../test/authApp.js';
import errorHandler from '../../plugins/errorHandler.js';
import schemasRoutes from '../schemas/routes.js';
import grantsRoutes, { userLookupRoutes, USER_LOOKUP_RATE_LIMIT } from './grants.routes.js';

/** A well-formed uuid that is not, and never was, a user. */
const GHOST_USER = '99999999-9999-9999-9999-999999999999';
/** The global per-IP budget server.ts registers. The lookup must be tighter. */
const GLOBAL_RATE_LIMIT_MAX = 300;

const PEOPLE = {
  owner: { subject: 'kc-grants-owner', email: 'olive@grants.invalid', name: 'Olive Owner' },
  grantee: { subject: 'kc-grants-grantee', email: 'gene@grants.invalid', name: 'Gene Grantee' },
  editor: { subject: 'kc-grants-editor', email: 'edda@grants.invalid', name: 'Edda Editor' },
  stranger: { subject: 'kc-grants-stranger', email: 'stan@grants.invalid', name: 'Stan Stranger' },
  heir: { subject: 'kc-grants-heir', email: 'hera@grants.invalid', name: 'Hera Heir' },
  third: { subject: 'kc-grants-third', email: 'thea@grants.invalid', name: 'Thea Third' },
} as const;

type Who = keyof typeof PEOPLE;

// Mirrors routes/v1/index.ts's postgres branch: the grants routes are a sibling
// of the schema routes under the same prefix, and the lookup lives elsewhere.
const apiRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(schemasRoutes, { prefix: '/ontology-schemas' });
  await fastify.register(grantsRoutes, { prefix: '/ontology-schemas' });
  await fastify.register(userLookupRoutes, { prefix: '/users' });
};

let t: TestDb;
let harness: AuthedTestApp;
const tokens = {} as Record<Who, string>;
const userIds = {} as Record<Who, string>;

const auth = (who: Who) => harness.bearer(tokens[who]);

beforeAll(async () => {
  t = await startTestDb();
  harness = await buildAuthedApp(t.db, { routes: apiRoutes, prefix: '' });

  for (const [who, person] of Object.entries(PEOPLE) as [Who, typeof PEOPLE[Who]][]) {
    tokens[who] = await harness.issuer.sign(
      { sub: person.subject, email: person.email, name: person.name }, { expiresIn: '2h' },
    );
    // First sight: the auth plugin's onRequest upserts the users row.
    const seen = await harness.app.inject({
      method: 'GET', url: '/ontology-schemas', headers: auth(who),
    });
    expect(seen.statusCode, `first sight of ${who}`).toBe(200);

    const { rows } = await t.pool.query('select id from users where subject = $1', [person.subject]);
    userIds[who] = rows[0].id;
  }
});

afterAll(async () => {
  await harness.close();
  await t.stop();
});

beforeEach(async () => { await truncateAll(t.db); });

/** A private schema created through the API by `who`. */
async function newSchema(who: Who = 'owner', title = 'Shared thing'): Promise<string> {
  const res = await harness.app.inject({
    method: 'POST', url: '/ontology-schemas', headers: auth(who), payload: { title },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

function put(who: Who, schemaId: string, userId: string, role: string) {
  return harness.app.inject({
    method: 'PUT', url: `/ontology-schemas/${schemaId}/grants/${userId}`,
    headers: auth(who), payload: { role },
  });
}

function del(who: Who, schemaId: string, userId: string) {
  return harness.app.inject({
    method: 'DELETE', url: `/ontology-schemas/${schemaId}/grants/${userId}`, headers: auth(who),
  });
}

function list(who: Who, schemaId: string) {
  return harness.app.inject({
    method: 'GET', url: `/ontology-schemas/${schemaId}/grants`, headers: auth(who),
  });
}

function transfer(who: Who, schemaId: string, userId: string) {
  return harness.app.inject({
    method: 'POST', url: `/ontology-schemas/${schemaId}/transfer`,
    headers: auth(who), payload: { userId },
  });
}

function read(who: Who, schemaId: string) {
  return harness.app.inject({ method: 'GET', url: `/ontology-schemas/${schemaId}`, headers: auth(who) });
}

function write(who: Who, schemaId: string, title = 'Retitled') {
  return harness.app.inject({
    method: 'PATCH', url: `/ontology-schemas/${schemaId}`, headers: auth(who), payload: { title },
  });
}

async function grantRows(schemaId: string) {
  const { rows } = await t.pool.query(
    'select grantee_id, role, granted_by from schema_grants where schema_id = $1 order by grantee_id',
    [schemaId],
  );
  return rows as { grantee_id: string; role: string; granted_by: string | null }[];
}

async function ownerOf(schemaId: string): Promise<string> {
  const { rows } = await t.pool.query('select owner_id from schemas where id = $1', [schemaId]);
  return rows[0].owner_id;
}

describe('grants', () => {
  it('lets a viewer-grantee read but not write, and records who granted it', async () => {
    const id = await newSchema();
    // Before the grant, the schema is private and Gene is nobody.
    expect((await read('grantee', id)).statusCode).toBe(404);

    const granted = await put('owner', id, userIds.grantee, 'viewer');
    expect(granted.statusCode).toBe(200);
    expect(granted.json()).toMatchObject({ userId: userIds.grantee, role: 'viewer' });

    expect((await read('grantee', id)).statusCode).toBe(200);
    expect((await write('grantee', id)).statusCode).toBe(403);

    expect(await grantRows(id)).toEqual([
      { grantee_id: userIds.grantee, role: 'viewer', granted_by: userIds.owner },
    ]);
  });

  it('upgrades an existing grant on a repeated PUT rather than erroring, and keeps one row', async () => {
    const id = await newSchema();
    expect((await put('owner', id, userIds.grantee, 'viewer')).statusCode).toBe(200);

    const upgraded = await put('owner', id, userIds.grantee, 'editor');
    expect(upgraded.statusCode).toBe(200);
    expect(upgraded.json().role).toBe('editor');

    expect((await write('grantee', id)).statusCode).toBe(204);
    expect(await grantRows(id)).toEqual([
      { grantee_id: userIds.grantee, role: 'editor', granted_by: userIds.owner },
    ]);
  });

  // The auth plugin caches subject -> user for 60s; it does *not* cache grants,
  // and the guard reloads them on every request. So a revocation has to bite on
  // the very next call. If this test ever fails, something is caching more than
  // it should — do not "fix" it by lowering a TTL.
  it('makes a revocation effective on the next request', async () => {
    const id = await newSchema();
    await put('owner', id, userIds.grantee, 'editor');
    expect((await read('grantee', id)).statusCode).toBe(200);

    expect((await del('owner', id, userIds.grantee)).statusCode).toBe(204);

    expect((await read('grantee', id)).statusCode).toBe(404);
    expect((await write('grantee', id)).statusCode).toBe(404);
    expect(await grantRows(id)).toEqual([]);
  });

  it('404s a revocation of a grant that does not exist', async () => {
    const id = await newSchema();
    expect((await del('owner', id, userIds.grantee)).statusCode).toBe(404);
  });

  // The pair that proves the guard is doing the work. An editor can open the
  // schema, so hiding it from them would be a lie — 403. A stranger cannot, so
  // 403 would tell them the id is real — 404.
  it('403s every grants route for an editor-grantee', async () => {
    const id = await newSchema();
    await put('owner', id, userIds.editor, 'editor');

    expect((await list('editor', id)).statusCode).toBe(403);
    expect((await put('editor', id, userIds.stranger, 'viewer')).statusCode).toBe(403);
    expect((await del('editor', id, userIds.editor)).statusCode).toBe(403);
    expect((await transfer('editor', id, userIds.editor)).statusCode).toBe(403);
    // And nothing happened.
    expect((await grantRows(id)).map((r) => r.grantee_id)).toEqual([userIds.editor]);
    expect(await ownerOf(id)).toBe(userIds.owner);
  });

  it('404s every grants route for a stranger, identically to a schema that never existed', async () => {
    const id = await newSchema();
    const GHOST_SCHEMA = '88888888-8888-8888-8888-888888888888';

    const strangerList = await list('stranger', id);
    const ghostList = await list('stranger', GHOST_SCHEMA);
    expect(strangerList.statusCode).toBe(404);
    expect(strangerList.body).toBe(ghostList.body);

    expect((await put('stranger', id, userIds.stranger, 'owner')).statusCode).toBe(404);
    expect((await del('stranger', id, userIds.owner)).statusCode).toBe(404);
    expect((await transfer('stranger', id, userIds.stranger)).statusCode).toBe(404);
    expect(await grantRows(id)).toEqual([]);
    expect(await ownerOf(id)).toBe(userIds.owner);
  });

  it('404s a grant to a user id that does not exist, and creates nothing', async () => {
    const id = await newSchema();
    const res = await put('owner', id, GHOST_USER, 'editor');
    expect(res.statusCode).toBe(404);
    expect(await grantRows(id)).toEqual([]);
  });

  it('400s a malformed user id rather than handing Postgres a bad uuid', async () => {
    const id = await newSchema();
    expect((await put('owner', id, 'not-a-uuid', 'editor')).statusCode).toBe(400);
    expect((await del('owner', id, 'not-a-uuid')).statusCode).toBe(400);
    expect((await transfer('owner', id, 'not-a-uuid')).statusCode).toBe(400);
  });

  it('400s a role that is not one of the three', async () => {
    const id = await newSchema();
    expect((await put('owner', id, userIds.grantee, 'admin')).statusCode).toBe(400);
    expect(await grantRows(id)).toEqual([]);
  });

  // A grant to the owner is redundant: resolveAccess already gives them `own`
  // from owner_id, so the row would change nothing and claim something false.
  it('400s a self-grant by the owner rather than creating a redundant row', async () => {
    const id = await newSchema();
    const res = await put('owner', id, userIds.owner, 'viewer');
    expect(res.statusCode).toBe(400);
    expect(await grantRows(id)).toEqual([]);
  });

  it('lists grantees with their display names, not just their ids', async () => {
    const id = await newSchema();
    await put('owner', id, userIds.grantee, 'viewer');
    await put('owner', id, userIds.editor, 'editor');

    const res = await list('owner', id);
    expect(res.statusCode).toBe(200);
    const byName = (res.json() as { displayName: string }[])
      .slice()
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    expect(byName).toMatchObject([
      { userId: userIds.editor, displayName: PEOPLE.editor.name, role: 'editor' },
      { userId: userIds.grantee, displayName: PEOPLE.grantee.name, role: 'viewer' },
    ]);
  });

  // Managing grants is what an `owner` grant is *for*; transfer is not (see the
  // transfer suite). Asserting the positive here keeps the 403 above honest:
  // it is about the level, not about "only owner_id may touch this".
  it('lets an owner-grantee manage grants', async () => {
    const id = await newSchema();
    await put('owner', id, userIds.heir, 'owner');

    expect((await list('heir', id)).statusCode).toBe(200);
    expect((await put('heir', id, userIds.grantee, 'viewer')).statusCode).toBe(200);
    expect((await del('heir', id, userIds.grantee)).statusCode).toBe(204);
  });
});

describe('ownership transfer', () => {
  it('moves owner_id and leaves the previous owner an owner grant, so it is not a lockout', async () => {
    const id = await newSchema();
    const res = await transfer('owner', id, userIds.heir);
    expect(res.statusCode).toBe(204);

    expect(await ownerOf(id)).toBe(userIds.heir);
    expect(await grantRows(id)).toEqual([
      { grantee_id: userIds.owner, role: 'owner', granted_by: userIds.owner },
    ]);

    // Not locked out: the previous owner can still read and write it.
    expect((await read('owner', id)).statusCode).toBe(200);
    expect((await write('owner', id)).statusCode).toBe(204);

    // And the new owner sees them in the list, by name.
    const listed = await list('heir', id);
    expect(listed.json()).toMatchObject([
      { userId: userIds.owner, displayName: PEOPLE.owner.name, role: 'owner' },
    ]);
  });

  it('drops the new owner stale grant instead of leaving a row that claims less than they have', async () => {
    const id = await newSchema();
    await put('owner', id, userIds.heir, 'viewer');

    expect((await transfer('owner', id, userIds.heir)).statusCode).toBe(204);
    expect((await grantRows(id)).map((r) => r.grantee_id)).toEqual([userIds.owner]);
  });

  // The crux of "not a lockout without becoming a free-for-all": the previous
  // owner keeps `own` through their grant, which is enough to read, write and
  // manage grants — and deliberately NOT enough to transfer the schema back.
  it('lets the new owner transfer again and refuses the old one', async () => {
    const id = await newSchema();
    await transfer('owner', id, userIds.heir);

    expect((await transfer('owner', id, userIds.owner)).statusCode).toBe(403);
    expect(await ownerOf(id)).toBe(userIds.heir);

    expect((await transfer('heir', id, userIds.third)).statusCode).toBe(204);
    expect(await ownerOf(id)).toBe(userIds.third);
  });

  it('404s a transfer to a user id that does not exist, and moves nothing', async () => {
    const id = await newSchema();
    expect((await transfer('owner', id, GHOST_USER)).statusCode).toBe(404);
    expect(await ownerOf(id)).toBe(userIds.owner);
    expect(await grantRows(id)).toEqual([]);
  });

  it('400s a transfer to the current owner', async () => {
    const id = await newSchema();
    expect((await transfer('owner', id, userIds.owner)).statusCode).toBe(400);
    expect(await grantRows(id)).toEqual([]);
  });
});

describe('the email lookup', () => {
  const lookup = (email: string, who?: Who) => harness.app.inject({
    method: 'GET', url: `/users/lookup?email=${encodeURIComponent(email)}`,
    headers: who ? auth(who) : undefined,
  });

  it('resolves an exact address to an id and a display name, and echoes nothing else', async () => {
    const res = await lookup(PEOPLE.grantee.email, 'owner');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: userIds.grantee, displayName: PEOPLE.grantee.name });
    // It must confirm only what the caller already typed — never hand back the
    // address (or a subject, or a role) it found.
    expect(res.body).not.toContain(PEOPLE.grantee.email);
    expect(res.body).not.toContain(PEOPLE.grantee.subject);
  });

  it('matches without regard to case, because an address is not case-sensitive to a human', async () => {
    const res = await lookup(PEOPLE.grantee.email.toUpperCase(), 'owner');
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(userIds.grantee);
  });

  it('never matches a prefix, a suffix or a fragment', async () => {
    for (const probe of [
      PEOPLE.grantee.email.slice(0, 4),
      PEOPLE.grantee.email.replace('@', '+x@'),
      `x${PEOPLE.grantee.email}`,
      `${PEOPLE.grantee.email}x`,
    ]) {
      const res = await lookup(probe, 'owner');
      expect([400, 404], `probe ${probe}`).toContain(res.statusCode);
      expect(res.body, `probe ${probe}`).not.toContain('"id"');
    }
  });

  it('404s an address nobody uses, shaped like every other 404 and echoing nothing', async () => {
    const absent = 'nobody@grants.invalid';
    const res = await lookup(absent, 'owner');
    const schema404 = await harness.app.inject({
      method: 'GET', url: '/ontology-schemas/88888888-8888-8888-8888-888888888888', headers: auth('owner'),
    });

    expect(res.statusCode).toBe(404);
    expect(Object.keys(res.json()).sort()).toEqual(Object.keys(schema404.json()).sort());
    expect(res.body).not.toContain(absent);
  });

  it('401s an anonymous caller, and 401s a broken session', async () => {
    expect((await lookup(PEOPLE.grantee.email)).statusCode).toBe(401);

    const broken = await harness.app.inject({
      method: 'GET', url: `/users/lookup?email=${encodeURIComponent(PEOPLE.grantee.email)}`,
      headers: harness.bearer('not.a.real.jwt'),
    });
    expect(broken.statusCode).toBe(401);
  });

  it('400s a missing, blank or unparseable address instead of scanning', async () => {
    for (const query of ['', '?email=', '?email=%20', '?email=not-an-address']) {
      const res = await harness.app.inject({
        method: 'GET', url: `/users/lookup${query}`, headers: auth('owner'),
      });
      expect(res.statusCode, `query ${JSON.stringify(query)}`).toBe(400);
    }
  });

  // users.email carries no unique constraint (Keycloak owns identity, and two
  // subjects can legitimately mirror one address), so this branch is reachable
  // in production. Both accounts are created through the token path, which is
  // exactly how the duplicate would arise.
  it('409s an address two accounts share rather than guessing which one', async () => {
    const shared = 'twins@grants.invalid';
    for (const sub of ['kc-grants-twin-a', 'kc-grants-twin-b']) {
      const token = await harness.issuer.sign(
        { sub, email: shared, name: 'A Twin' }, { expiresIn: '2h' },
      );
      const seen = await harness.app.inject({
        method: 'GET', url: '/ontology-schemas', headers: harness.bearer(token),
      });
      expect(seen.statusCode, `first sight of ${sub}`).toBe(200);
    }

    const res = await lookup(shared, 'owner');
    expect(res.statusCode).toBe(409);
    expect(res.body).not.toContain(shared);
  });

  // The rate limit is one of the four mitigations that make an authenticated
  // existence oracle acceptable, so it is asserted rather than assumed. A fresh
  // app, because the counter is per-instance and this test exhausts it.
  it('enforces its own budget, tighter than the global one', async () => {
    expect(USER_LOOKUP_RATE_LIMIT.max).toBeLessThan(GLOBAL_RATE_LIMIT_MAX);

    const limited = await buildAuthedApp(t.db, {
      routes: apiRoutes, prefix: '', rateLimit: { max: GLOBAL_RATE_LIMIT_MAX, timeWindow: '1 minute' },
    });
    try {
      const token = await limited.issuer.sign({ sub: PEOPLE.owner.subject }, { expiresIn: '2h' });
      const url = `/users/lookup?email=${encodeURIComponent(PEOPLE.grantee.email)}`;
      const hit = () => limited.app.inject({ method: 'GET', url, headers: limited.bearer(token) });

      for (let i = 0; i < USER_LOOKUP_RATE_LIMIT.max; i += 1) {
        expect((await hit()).statusCode, `request ${i + 1}`).toBe(200);
      }
      expect((await hit()).statusCode).toBe(429);

      // The global budget is untouched, so this is the route's own limit.
      const elsewhere = await limited.app.inject({
        method: 'GET', url: '/ontology-schemas', headers: limited.bearer(token),
      });
      expect(elsewhere.statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

// The other half of mayTransferOwnership: `own` is not enough to transfer, but
// the admin role is, without the admin owning anything. Its own app because the
// promotion has to be visible to the guard immediately — the deployment's 60s
// subject -> user cache would otherwise answer from the pre-promotion snapshot
// and this would look like a policy bug.
describe('an admin', () => {
  it('may transfer a schema it does not own, leaving the real previous owner the grant', async () => {
    const promoted = await buildAuthedApp(t.db, {
      routes: apiRoutes, prefix: '', userCacheTtlMs: 0,
    });
    try {
      const ADMIN = 'kc-grants-admin';
      const adminToken = await promoted.issuer.sign(
        { sub: ADMIN, email: 'ada@grants.invalid', name: 'Ada Admin' }, { expiresIn: '2h' },
      );
      const ownerToken = await promoted.issuer.sign(
        { sub: PEOPLE.owner.subject }, { expiresIn: '2h' },
      );

      // First sight through the token path, then the promotion.
      await promoted.app.inject({
        method: 'GET', url: '/ontology-schemas', headers: promoted.bearer(adminToken),
      });
      await t.pool.query("update users set global_role = 'admin' where subject = $1", [ADMIN]);
      const { rows } = await t.pool.query('select id from users where subject = $1', [ADMIN]);
      const adminId: string = rows[0].id;

      const created = await promoted.app.inject({
        method: 'POST', url: '/ontology-schemas',
        headers: promoted.bearer(ownerToken), payload: { title: 'Handled by an admin' },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id;

      const res = await promoted.app.inject({
        method: 'POST', url: `/ontology-schemas/${id}/transfer`,
        headers: promoted.bearer(adminToken), payload: { userId: userIds.heir },
      });
      expect(res.statusCode).toBe(204);
      expect(await ownerOf(id)).toBe(userIds.heir);

      // The consolation grant goes to whoever *was* the owner, not to the admin
      // who acted — granted_by is what records the actor.
      expect(await grantRows(id)).toEqual([
        { grantee_id: userIds.owner, role: 'owner', granted_by: adminId },
      ]);
    } finally {
      await promoted.close();
    }
  });
});

// Decision 1 of this task, made executable. `fastify-plugin` lets aclGuards
// escape exactly one encapsulation level, so a plugin tree that registers the
// grants routes as a *sibling* of the schema routes does not inherit the
// decorator: this file's plugin has to register aclGuards itself. Forgetting is
// otherwise silent — Fastify does not seal `request`, so the guard's assignment
// still works and every test above would still pass. What is actually lost is
// the `decorators:` prerequisite assertion, so that is what this asserts: on an
// instance missing the auth plugin's request decorators, registering the grants
// routes must fail at boot. Delete the `register(aclGuards)` line in
// grants.routes.ts and this test goes green-to-red.
describe('the aclGuards registration this plugin owns', () => {
  it('refuses to boot on an instance without the auth plugin request decorators', async () => {
    const app = Fastify();
    await app.register(sensible);
    await app.register(errorHandler);
    app.decorate('pg', t.db);
    app.register(grantsRoutes, { prefix: '/ontology-schemas' });

    // `.then(() => 'booted')` so that a *successful* boot fails this
    // assertion with a readable message instead of vitest touching a getter on
    // the resolved instance.
    await expect(app.ready().then(() => 'booted')).rejects.toThrow(/user/);
    await app.close();
  });
});
