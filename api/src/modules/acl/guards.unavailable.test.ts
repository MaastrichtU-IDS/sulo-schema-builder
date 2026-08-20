// The guard's 503 branch: a verified token the *server* could not resolve to a
// user (Postgres unreachable, pool exhausted) is an outage, not a session
// problem and not anonymity.
//
// Fix round 1, finding 5. Worth its own file because it needs the opposite of a
// working database, and the branch is decided before the schema row is loaded —
// so no container is required at all. The failure is injected the way
// plugins/auth.test.ts injects it: a `pg` handle whose first call throws, which
// is what makes resolveUser raise something that is not an InvalidSubjectError.
//
// What this rules out: answering the 404 rule instead. During an outage that
// would tell a signed-in caller their own private schema does not exist, and
// the SPA would refresh a token that is perfectly fine and get the same answer
// forever.

import { describe, it, expect } from 'vitest';
import type { FastifyPluginAsync } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.js';
import { buildAuthedApp } from '../../test/authApp.js';
import { aclGuards, requireAccess, requireSaneToken } from './guards.js';

const SOME_UUID = '33333333-3333-3333-3333-333333333333';

/** Throws on the first query, however it is reached. */
const brokenPg = new Proxy({}, {
  get() {
    return () => { throw new Error('connection terminated unexpectedly'); };
  },
}) as unknown as Kysely<DB>;

const routes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(aclGuards);
  fastify.get('/view/:id', { preHandler: requireAccess('view') }, async () => ({ ok: true }));
  fastify.get('/list', { preHandler: requireSaneToken }, async () => []);
};

describe('requireAccess when the user lookup itself fails', () => {
  it('answers 503 for a verified token, and never a misleading 404', async () => {
    const harness = await buildAuthedApp(brokenPg, { routes, prefix: '/guard' });
    try {
      const token = await harness.issuer.sign({ sub: 'kc-outage' }, { expiresIn: '2h' });

      const guarded = await harness.app.inject({
        method: 'GET', url: `/guard/view/${SOME_UUID}`, headers: harness.bearer(token),
      });
      expect(guarded.statusCode).toBe(503);

      // The anonymous-allowed route has to agree: 503, not `200 []`.
      const listed = await harness.app.inject({
        method: 'GET', url: '/guard/list', headers: harness.bearer(token),
      });
      expect(listed.statusCode).toBe(503);

      // An anonymous caller in the same outage has no user to fail to resolve,
      // so the schema query is what breaks: a masked 500. Still never a 404 —
      // nothing here may be reported as "no such schema".
      const anon = await harness.app.inject({ method: 'GET', url: `/guard/view/${SOME_UUID}` });
      expect(anon.statusCode).toBe(500);
      expect(anon.body).not.toMatch(/connection terminated|not found/i);
    } finally {
      await harness.close();
    }
  });
});
