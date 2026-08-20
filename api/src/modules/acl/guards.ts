// The single enforcement point. Handlers contain no permission logic: they read
// request.schemaAccess, which exists only if the guard let them run.
//
// The status codes encode the design's information policy:
//   - cannot see it at all           → 404, identical to a nonexistent id
//   - can see it, lacks the level    → 403 (the id is already known to them)
//   - can see it, but is anonymous   → 401 (a session is the missing thing)
//
// Two answers come *before* the row is loaded, because they depend only on the
// token and so leak nothing, and because after the load the 404 rule would
// swallow them: 503 for a verified token the server could not resolve, and 401
// for a token that did not verify at all. See rejectBrokenToken.
//
// Nothing here consults the route or the HTTP method: the route declares the
// level it needs, and resolve.ts decides who has it. That split is what makes
// the policy testable as a table (resolve.test.ts) and the wiring auditable as
// a list (the preHandlers in modules/schemas/routes.ts).

import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { atLeast, resolveAccess, type AccessLevel } from './resolve.js';
import { loadSchemaAccess } from './repo.js';
import type { SchemaRow } from '../../db/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    schemaAccess: { schema: SchemaRow; level: AccessLevel } | null;
  }
}

/**
 * `:id` is a uuid column in Postgres, so a non-uuid must be rejected *before*
 * the query — otherwise the guard hands Postgres a bad literal and a client
 * typo becomes a 500. Same shape check the routes used to do in each handler.
 */
const SchemaId = z.string().uuid();

/**
 * Creates the `schemaAccess` request decorator, and asserts everything
 * `requireAccess` reaches for. Pairing the two in one module is the point:
 * there is no way to import the guard and not see what it needs.
 *
 * `fp` (rather than a plain plugin) so the decorator is added to the instance
 * that registers this, rather than to a throwaway child of it — it escapes
 * *one* encapsulation level, not all of them. It is **not** global: a sibling
 * plugin mounted under the same prefix does not see `schemaAccess`, and a
 * sibling that registers its own copy does not collide (checked against the
 * installed fastify 5.12.1). So the grants routes (task 4) and the moderation
 * routes (task 5) must each register `aclGuards` themselves.
 *
 * Forgetting to is SILENT, which is the part worth knowing. Fastify does not
 * seal `request`, so the assignment at the end of the guard still works and the
 * route still behaves correctly; what is lost is the `decorators:` prerequisite
 * check below, so a missing `pg` or `user` surfaces as a crash on the first
 * guarded request instead of an error at boot.
 */
export const aclGuards = fp(async (fastify) => {
  fastify.decorateRequest('schemaAccess', null);
}, {
  name: 'acl-guards',
  // Everything requireAccess reaches for, asserted at registration time rather
  // than on the first guarded request: `pg` from plugins/pg.ts, `user` and
  // `authError` from plugins/auth.ts, the rest from @fastify/sensible.
  decorators: {
    fastify: ['pg'],
    request: ['user', 'authError'],
    reply: ['badRequest', 'notFound', 'unauthorized', 'forbidden', 'serviceUnavailable'],
  },
});

/**
 * A request whose `user` is null for a reason other than plain anonymity.
 *
 * Both answers are decided from the token alone, so both are safe to give
 * *before* the schema row is loaded — and both have to be, because after the
 * load the 404 rule would swallow them: a signed-in caller with an expired
 * token would be told their own private schema does not exist, and one hitting
 * a Postgres outage would be told the same. Neither message is true, and
 * neither tells the SPA the one thing it can act on.
 *
 * Shared by `requireAccess` and by `requireSaneToken` (below) so the guarded
 * and the anonymous-allowed routes cannot drift apart on it.
 *
 * Returns true when it has answered.
 */
function rejectBrokenToken(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.authError === 'unavailable') {
    reply.serviceUnavailable();
    return true;
  }
  if (request.authError === 'invalid') {
    reply.unauthorized('Your session is no longer valid. Sign in again.');
    return true;
  }
  return false;
}

/**
 * For the routes that *allow* anonymity and so carry no `requireAccess`: an
 * absent session is fine, a broken one is not. Without this, GET / answers
 * `200 []` to a caller whose token expired an hour ago — "all your schemas are
 * gone" — and 503s become 200s during an outage.
 */
export const requireSaneToken: preHandlerHookHandler = async (request, reply) => {
  if (rejectBrokenToken(request, reply)) return reply;
};

/**
 * Whether `level` may change a schema's `visibility`.
 *
 * Publication is an ownership decision, not an editing one: PATCH /:id
 * (modules/schemas/routes.ts) stays guarded at `edit` overall — so an editor
 * can still retitle or redescribe a schema, which is the point of the editor
 * role — but changing `visibility` itself needs `own`. The comparison lives
 * here, next to `atLeast` and `requireAccess`, because this module is the
 * single enforcement point for schema-level policy (spec §5); routes.ts
 * holds only the field-conditional call site and the 403 it answers with,
 * not the decision of who may.
 */
export function mayChangeVisibility(level: AccessLevel): boolean {
  return atLeast(level, 'own');
}

export function requireAccess(required: 'view' | 'edit' | 'own'): preHandlerHookHandler {
  return async function accessGuard(request: FastifyRequest, reply: FastifyReply) {
    if (rejectBrokenToken(request, reply)) return reply;

    const { id } = request.params as { id?: string };
    if (id === undefined) throw new Error('requireAccess used on a route without an :id parameter');
    if (!SchemaId.safeParse(id).success) return reply.badRequest('Malformed schema id');

    const loaded = await loadSchemaAccess(request.server.pg, id, request.user?.id ?? null);
    // Deliberately the same answer as "you may not see this one".
    if (!loaded) return reply.notFound('Schema not found');

    const level = resolveAccess(request.user, loaded.schema, loaded.grant);
    if (level === 'none') return reply.notFound('Schema not found');

    if (!atLeast(level, required)) {
      if (!request.user) return reply.unauthorized('Sign in to continue.');
      return reply.forbidden('You do not have permission to do that.');
    }

    request.schemaAccess = { schema: loaded.schema, level };
  };
}
