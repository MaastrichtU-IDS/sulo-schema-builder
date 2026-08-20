// The single enforcement point. Handlers contain no permission logic: they read
// request.schemaAccess, which exists only if the guard let them run.
//
// The status codes encode the design's information policy:
//   - cannot see it at all           → 404, identical to a nonexistent id
//   - can see it, lacks the level    → 403 (the id is already known to them)
//   - can see it, but is anonymous   → 401 (a session is the missing thing)
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
 * Creates the `schemaAccess` request decorator. Registering this is what makes
 * `requireAccess` usable, which is the point of pairing them in one module:
 * there is no way to wire the guard up and forget the decorator.
 *
 * `fp` (rather than a plain plugin) so the decorator lands on the root request
 * prototype no matter how deeply nested the route tree that registers it is.
 * Register it exactly once per server.
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

export function requireAccess(required: 'view' | 'edit' | 'own'): preHandlerHookHandler {
  return async function accessGuard(request: FastifyRequest, reply: FastifyReply) {
    // A verified token the *server* failed to resolve to a user is not
    // anonymity (plugins/auth.ts): answering 404/401 here would tell a
    // signed-in user their own schema had vanished, or ask them to sign in
    // again, during an outage that has nothing to do with their session.
    if (request.authError === 'unavailable') return reply.serviceUnavailable();

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
