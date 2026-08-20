// The enforcement point, as a status matrix.
//
// Three trivial routes — one per guard level — over one schema per visibility,
// asked by every kind of caller. What the numbers mean, and why the test is a
// table rather than a handful of examples:
//
//   404  the caller may not know this schema exists. Byte-identical to the
//        answer for a uuid that never existed, or the pair is an existence
//        oracle: "403 here, 404 there" tells a stranger which uuids are real.
//   403  the caller can already *see* this schema and lacks the level for what
//        they attempted. Safe, because the id is not news to them.
//   401  the caller can see it and the only missing thing is a session — an
//        anonymous write on a public schema. Not 403: there is nothing to
//        forbid yet.
//   200  allowed.
//
// The expected statuses are written out per (caller, visibility) instead of
// being derived from resolveAccess, deliberately: a derivation would restate
// the implementation and pass even if the policy itself were wrong.
//
// Fixtures are built once in beforeAll and never truncated. Users are created
// through the token path (the auth plugin's onRequest upserts them), because
// test/pg.ts's truncateAll spares `users` on purpose and hand-inserted rows
// drift from the ids the plugin caches. The two role holders are promoted with
// an UPDATE *after* that first sight, which is why this app is built with
// userCacheTtlMs: 0 — otherwise the guard would answer from the pre-promotion
// snapshot for a minute.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import { startTestDb, type TestDb } from '../../test/pg.js';
import { buildAuthedApp, type AuthedTestApp } from '../../test/authApp.js';
import { aclGuards, requireAccess } from './guards.js';

const LEVELS = ['view', 'edit', 'own'] as const;
const VISIBILITIES = ['private', 'unlisted', 'public'] as const;

/** A well-formed uuid that is not, and never was, a schema. */
const GHOST = '99999999-9999-9999-9999-999999999999';

const guardedRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(aclGuards);

  // Lets the suite learn the user id the token path minted for a subject
  // without inserting a `users` row itself.
  fastify.get('/whoami', async (request) => ({ user: request.user }));

  for (const level of LEVELS) {
    fastify.get(`/${level}/:id`, { preHandler: requireAccess(level) }, async (request) => {
      // Reading request.schemaAccess rather than re-querying is the point of the
      // decorator: a handler that re-fetched could disagree with the guard.
      const access = request.schemaAccess!;
      return { level: access.level, id: access.schema.id, title: access.schema.title };
    });
  }
};

const SUBJECTS = {
  owner: 'kc-guard-owner',
  viewer: 'kc-guard-viewer',
  editor: 'kc-guard-editor',
  stranger: 'kc-guard-stranger',
  moderator: 'kc-guard-moderator',
  admin: 'kc-guard-admin',
  /** A moderator who *also* holds an explicit editor grant. */
  modGrantee: 'kc-guard-mod-grantee',
  /** Owns a different schema entirely — the existence-oracle probe. */
  otherOwner: 'kc-guard-other-owner',
} as const;

type Who = keyof typeof SUBJECTS | 'anonymous';

let t: TestDb;
let harness: AuthedTestApp;
const tokens = {} as Record<keyof typeof SUBJECTS, string>;
const userIds = {} as Record<keyof typeof SUBJECTS, string>;
const schemaIds = {} as Record<(typeof VISIBILITIES)[number], string>;
let otherSchemaId: string;

function headers(who: Who) {
  return who === 'anonymous' ? undefined : harness.bearer(tokens[who]);
}

function get(who: Who, level: (typeof LEVELS)[number], id: string) {
  return harness.app.inject({ method: 'GET', url: `/guard/${level}/${id}`, headers: headers(who) });
}

beforeAll(async () => {
  t = await startTestDb();
  harness = await buildAuthedApp(t.db, {
    routes: guardedRoutes, prefix: '/guard', userCacheTtlMs: 0,
  });

  for (const [name, subject] of Object.entries(SUBJECTS) as [keyof typeof SUBJECTS, string][]) {
    tokens[name] = await harness.issuer.sign({ sub: subject }, { expiresIn: '2h' });
    const res = await harness.app.inject({
      method: 'GET', url: '/guard/whoami', headers: harness.bearer(tokens[name]),
    });
    userIds[name] = res.json().user.id as string;
  }

  await t.db.updateTable('users').set({ global_role: 'moderator' })
    .where('subject', 'in', [SUBJECTS.moderator, SUBJECTS.modGrantee]).execute();
  await t.db.updateTable('users').set({ global_role: 'admin' })
    .where('subject', '=', SUBJECTS.admin).execute();

  for (const visibility of VISIBILITIES) {
    const row = await t.db.insertInto('schemas')
      .values({ owner_id: userIds.owner, title: `${visibility} schema`, visibility })
      .returning('id').executeTakeFirstOrThrow();
    schemaIds[visibility] = row.id;

    // viewer/editor hold their grant on all three, so the matrix below says
    // something about the interaction of a grant with each visibility rather
    // than only with `private`.
    await t.db.insertInto('schema_grants').values([
      { schema_id: row.id, grantee_id: userIds.viewer, role: 'viewer' },
      { schema_id: row.id, grantee_id: userIds.editor, role: 'editor' },
    ]).execute();
  }

  await t.db.insertInto('schema_grants')
    .values({ schema_id: schemaIds.private, grantee_id: userIds.modGrantee, role: 'editor' })
    .execute();

  otherSchemaId = (await t.db.insertInto('schemas')
    .values({ owner_id: userIds.otherOwner, title: 'someone else entirely', visibility: 'private' })
    .returning('id').executeTakeFirstOrThrow()).id;
});

afterAll(async () => {
  await harness.close();
  await t.stop();
});

/** [view, edit, own] */
type Statuses = readonly [number, number, number];

const MATRIX: Record<(typeof VISIBILITIES)[number], Partial<Record<Who, Statuses>>> = {
  private: {
    owner:     [200, 200, 200],
    admin:     [200, 200, 200],
    editor:    [200, 200, 403],
    viewer:    [200, 403, 403],
    // Reads anything to handle abuse reports; acting is a role-guarded route.
    moderator: [200, 403, 403],
    // Cannot see it at all, so never 403 — that would confirm the uuid.
    stranger:  [404, 404, 404],
    anonymous: [404, 404, 404],
  },
  unlisted: {
    owner:     [200, 200, 200],
    admin:     [200, 200, 200],
    editor:    [200, 200, 403],
    viewer:    [200, 403, 403],
    moderator: [200, 403, 403],
    stranger:  [200, 403, 403],
    // 401, not 403: publication already let them read it, so the missing
    // thing is a session.
    anonymous: [200, 401, 401],
  },
  public: {
    owner:     [200, 200, 200],
    admin:     [200, 200, 200],
    editor:    [200, 200, 403],
    viewer:    [200, 403, 403],
    moderator: [200, 403, 403],
    stranger:  [200, 403, 403],
    anonymous: [200, 401, 401],
  },
};

describe('requireAccess', () => {
  for (const visibility of VISIBILITIES) {
    for (const [who, statuses] of Object.entries(MATRIX[visibility]) as [Who, Statuses][]) {
      it(`${who} against a ${visibility} schema answers ${statuses.join('/')}`, async () => {
        for (const [i, level] of LEVELS.entries()) {
          const res = await get(who, level, schemaIds[visibility]);
          expect(res.statusCode, `${who} @ ${level} on ${visibility}`).toBe(statuses[i]);
        }
      });
    }
  }

  it('hands the handler the resolved level, so no handler re-queries', async () => {
    for (const [who, expected] of [
      ['owner', 'own'], ['admin', 'own'], ['editor', 'edit'], ['viewer', 'view'],
      ['moderator', 'view'], ['stranger', 'view'], ['anonymous', 'view'],
    ] as [Who, string][]) {
      const res = await get(who, 'view', schemaIds.public);
      expect(res.statusCode).toBe(200);
      expect(res.json(), who).toMatchObject({ level: expected, id: schemaIds.public });
    }
  });

  it('answers a nonexistent uuid exactly as it answers an invisible one', async () => {
    // Same status, same body, same content type — for the callers who cannot
    // see the private schema, including one who owns a *different* schema and
    // so is a perfectly ordinary authenticated user.
    for (const who of ['stranger', 'otherOwner', 'anonymous'] as Who[]) {
      for (const level of LEVELS) {
        const invisible = await get(who, level, schemaIds.private);
        const missing = await get(who, level, GHOST);

        expect(invisible.statusCode, `${who} @ ${level}`).toBe(404);
        expect(missing.statusCode, `${who} @ ${level}`).toBe(404);
        expect(missing.body, `${who} @ ${level}`).toBe(invisible.body);
        expect(missing.headers['content-type']).toBe(invisible.headers['content-type']);
      }
    }
  });

  it('404s a nonexistent uuid for everyone, including an owner and an admin', async () => {
    for (const who of Object.keys(SUBJECTS) as Who[]) {
      for (const level of LEVELS) {
        expect((await get(who, level, GHOST)).statusCode, `${who} @ ${level}`).toBe(404);
      }
    }
  });

  it('never lets a 403 escape for a schema the caller cannot see', async () => {
    // The failure this guards against is a future refactor that resolves the
    // level, notices it is insufficient, and answers 403 before checking
    // whether the caller could see the schema at all.
    for (const who of ['stranger', 'anonymous', 'otherOwner'] as Who[]) {
      for (const level of LEVELS) {
        const res = await get(who, level, schemaIds.private);
        expect(res.statusCode, `${who} @ ${level}`).not.toBe(403);
        expect(res.statusCode, `${who} @ ${level}`).not.toBe(401);
      }
    }
  });

  it('gives a moderator with an editor grant edit, not the view their role alone confers', async () => {
    // The one place a global role and an explicit grant interact. Highest match
    // wins, so the grant must lift the moderator above read-only.
    const granted = await get('modGrantee', 'edit', schemaIds.private);
    expect(granted.statusCode).toBe(200);
    expect(granted.json().level).toBe('edit');

    // And the role alone still does not.
    expect((await get('moderator', 'edit', schemaIds.private)).statusCode).toBe(403);
    // A grant is not an ownership promotion either.
    expect((await get('modGrantee', 'own', schemaIds.private)).statusCode).toBe(403);
  });

  it('leaves another user\'s private schema invisible even to a schema owner', async () => {
    for (const level of LEVELS) {
      expect((await get('owner', level, otherSchemaId)).statusCode).toBe(404);
    }
    expect((await get('otherOwner', 'own', otherSchemaId)).statusCode).toBe(200);
  });

  it('400s a malformed schema id instead of letting Postgres raise', async () => {
    const res = await harness.app.inject({
      method: 'GET', url: '/guard/view/not-a-uuid', headers: harness.bearer(tokens.owner),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/uuid|syntax|invalid input/i);
  });

  it('fails loudly on a grant role it does not recognise, rather than ignoring it', async () => {
    // The CHECK constraint makes this unreachable today, which is exactly why
    // the assertion is cheap: it keeps the loader honest if a later migration
    // adds a role and this code is not updated. Silently dropping an unknown
    // grant is the failure mode being ruled out — it would be a *quiet* denial
    // now, and a quiet escalation if the ranking ever changed.
    await sql`alter table schema_grants drop constraint schema_grants_role_check`.execute(t.db);
    try {
      await t.db.insertInto('schema_grants')
        .values({ schema_id: otherSchemaId, grantee_id: userIds.stranger, role: 'superuser' as never })
        .execute();

      const res = await get('stranger', 'view', otherSchemaId);
      expect(res.statusCode).toBe(500);
      // ...and the loud failure still says nothing about the database.
      expect(res.body).not.toMatch(/schema_grants|superuser|select|constraint/i);
    } finally {
      await t.db.deleteFrom('schema_grants')
        .where('schema_id', '=', otherSchemaId).where('grantee_id', '=', userIds.stranger).execute();
      await sql`alter table schema_grants add constraint schema_grants_role_check check (role in ('viewer','editor','owner'))`.execute(t.db);
    }
  });
});
