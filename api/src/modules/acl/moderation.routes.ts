// Abuse handling: force a schema private, regardless of who owns it, who can
// see it, or what its current visibility already is.
//
// AUTHORIZATION HERE IS A GLOBAL ROLE, NOT A SCHEMA-LEVEL ONE. Every other
// mutating route in this API goes through requireAccess (modules/acl/guards.ts)
// because "who may do this" depends on this caller's relationship to THIS
// schema — owner, grantee, or neither. Unpublishing is different: a moderator
// or admin may act on ANY schema precisely because they are not the owner and
// hold no grant on it. resolve.ts already gives every moderator `view` on
// every schema (to read abuse reports), but that level is not what lets them
// act here — `view` is nowhere near `own`, and this route needs neither.
// requireAccess is deliberately not used, and `aclGuards`/`request.schemaAccess`
// are never touched, so this file does not register `aclGuards` either — there
// is nothing here for a sibling to forget.
//
// ---------------------------------------------------------------------------
// DECISION 1 — closing plugins/authDisabled.ts's role-guard blocker.
//
// In sqlite mode, authDisabled.ts supplies `requireRole` (and `authRequired`)
// as no-ops, because the packaged desktop app is single-user and has nobody to
// authenticate. A role-guarded route registered there would have those no-ops
// let every request through, unchanged, into a handler that then reads
// `request.user.role` — which is `null.role` in that mode, forever. Closed two
// ways, because both are cheap and they fail differently:
//
//   * THE BELT — routes/v1/index.ts registers this plugin only inside its
//     `config.storage === 'postgres'` branch, the same branch that already
//     selects the Postgres schema/grants routes over the sqlite ones. A route
//     that is never registered cannot be reached at all, in either mode. This
//     is the stronger closure, and the one that actually matters in
//     production: nothing below this comment runs unless a real, non-no-op
//     `requireRole`/`authRequired` is what registered it.
//
//   * THE BRACES — `requireUserOrThrow` below. `fastify.authRequired` runs as
//     this route's first preHandler and already answers 401 (anonymous, or a
//     token that failed to verify) and 503 (a verified token the server could
//     not resolve) before the role check ever runs — see plugins/auth.ts. So
//     by the time `requireModerator`'s preHandler runs in postgres mode,
//     `request.user` is guaranteed non-null. The throw below is not for that
//     case; it is insurance for a route someone adds LATER that copies this
//     pattern but skips the belt, or reorders the preHandlers, or is otherwise
//     reachable while `request.user` is still null. Where a no-op `requireRole`
//     would let such a request through unchanged (silently admitting it) and a
//     bare `request.user.role` read would crash with an unhelpful
//     "Cannot read properties of null", this throws a message that names the
//     actual mistake and reaches the caller as a masked 500 (plugins/
//     errorHandler.ts) — loud in the server log, and never a success.
//     moderation.test.ts exercises this directly, including through the real
//     authDisabled.ts plugin, without needing a second server build.
// ---------------------------------------------------------------------------
//
// DECISION 2 — a non-moderator gets 404, not the schema routes' 403.
//
// modules/acl/guards.ts's guard answers 403 to a caller who can already see a
// schema and merely lacks the level to act on it: the id is not news to them,
// so confirming it changes nothing. That reasoning does not transfer here. An
// ordinary signed-in user asking THIS route about a schema they can see (even
// one they own) has learned nothing about the schema either way — what a 403
// would hand them is the existence of an admin surface at this path, at all.
// The route itself is the secret, not the schema, so it must be answered
// EXACTLY like a path that was never registered — not merely with the same
// status code. server.ts's `setNotFoundHandler` is what a genuinely
// unregistered /api/* path answers with:
//
//   { error: 'not_found', message: `Route ${request.method}:${request.url} not found` }
//
// — snake_case `error`, no `statusCode`/`code` key, and a message echoing the
// route. `reply.notFound()` (the shape every other 404 on this API uses,
// including the schema-not-found branch below) goes through
// plugins/errorHandler.ts's pass-through and Fastify's own default handler
// instead, which serializes as `{ error: 'Not Found', message: 'Not Found',
// statusCode: 404 }` — a second, distinguishable JSON shape for the same
// status. A client that cannot tell 404 apart from "never registered" by
// status code alone could still tell them apart by body, which leaks exactly
// the fact this decision exists to hide. So the role-rejection branch below
// constructs the object literally, byte-for-byte the same as server.ts's, on
// purpose — not through `reply.notFound()` — and moderation.test.ts asserts
// the byte-equality against a real sibling path that is genuinely
// unregistered, not against a hand-written expected literal. A future reader
// who "fixes" this to `reply.notFound()` (matching every other 404 on this
// API) would be reopening exactly this leak; a future reader who changes
// server.ts's shape must update this branch too, or the two drift apart and
// the leak returns from the other direction.
//
// DECISION 3 — an anonymous caller gets 401.
//
// Ordinary `fastify.authRequired` behaviour: a session is the one thing
// missing, and unlike decision 2 there is no admin-surface secret to protect
// from an anonymous caller that a 404 would preserve and a 401 would not — an
// anonymous caller already cannot tell a 401 apart from any other guarded
// route on this API answering the same way.
// ---------------------------------------------------------------------------

import type { FastifyPluginAsync, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { getSchemaRow, patchSchema } from '../schemas/repo.js';
import type { RequestUser } from '../users/service.js';

const IdParam = z.object({ id: z.string().uuid() });

/**
 * Decision 1's braces. See the module header for the full argument: every
 * reachable caller of this in postgres mode already has `request.user` set,
 * because `fastify.authRequired` runs first. This exists for the caller that
 * is not supposed to be reachable at all.
 */
export function requireUserOrThrow(request: FastifyRequest): RequestUser {
  if (!request.user) {
    throw new Error(
      'moderation route reached with request.user absent — fastify.authRequired should have '
      + 'already answered 401/503 for this request. This must be impossible in postgres mode; '
      + 'reaching it means either the preHandler order changed, or this route is registered '
      + 'somewhere authRequired/requireRole are the sqlite-mode no-ops (plugins/authDisabled.ts).',
    );
  }
  return request.user;
}

/**
 * Moderator or admin only. See decisions 2 and 3 above for the two answers
 * this hands out, and the module header for why `request.user` being absent
 * here throws rather than 401s: `fastify.authRequired`, registered ahead of
 * this in the route below, already owns that answer.
 */
function requireModerator(): preHandlerHookHandler {
  return async (request, reply) => {
    const user = requireUserOrThrow(request);
    if (user.role !== 'moderator' && user.role !== 'admin') {
      // 404, not 403 — decision 2. NOT `reply.notFound()`: that answers with
      // a different JSON shape than a route Fastify never matched at all
      // (server.ts's `setNotFoundHandler`), which would let a client
      // distinguish "hidden" from "never existed" by body even though both
      // answer 404 — exactly the leak decision 2 exists to prevent. This is
      // server.ts's shape, copied byte-for-byte on purpose; see the module
      // header for the full argument and moderation.test.ts for the
      // byte-equality assertion against a real unregistered sibling path.
      return reply.code(404).send({
        error: 'not_found',
        message: `Route ${request.method}:${request.url} not found`,
      });
    }
  };
}

const moderationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/:id/unpublish', {
    // authRequired first: it is what makes decision 1's braces true, and it
    // owns decision 3 (401 for anonymous) and the 503-for-an-outage answer
    // every other guarded route on this API gives, for free.
    preHandler: [fastify.authRequired, requireModerator()],
  }, async (request, reply) => {
    const parsed = IdParam.safeParse(request.params);
    // Same argument as every other `:id` on this API: `id` is a uuid column,
    // so a non-uuid must be rejected before it reaches Postgres as a literal.
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    const schema = await getSchemaRow(fastify.pg, parsed.data.id);
    // The id is not news to a moderator or admin — they hold the role, not a
    // per-schema level — so this is an ordinary 404, not the guard's "may not
    // even confirm it exists" one.
    if (!schema) return reply.notFound('Schema not found');

    // Idempotent: setting an already-private schema to private again is a
    // no-op write, not a special case to detect and refuse. Nothing else about
    // the row changes — owner_id and every grant are untouched, so the
    // owner's own access (via owner_id, independent of visibility — see
    // resolve.ts) is exactly what it was before this call.
    await patchSchema(fastify.pg, schema.id, { visibility: 'private' });
    return reply.code(204).send();
  });
};

export default moderationRoutes;
