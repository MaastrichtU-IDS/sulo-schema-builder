// The operator surface (spec §5): user roster and tier changes, aggregated
// reasoning usage, and the reason_jobs queue — the things plan 3's
// moderation route deliberately did not cover (that one is abuse handling
// by a moderator OR admin; this one is deployment operation, admin only).
//
// AUTHORIZATION IS A GLOBAL ROLE, exactly like moderation.routes.ts, and this
// file follows that one's pattern in full — read its header before touching
// this one, because every decision there applies here unchanged:
//
//   * `requireAdmin` does NOT call `fastify.requireRole` — it needs a 404 for
//     the wrong role (decision 2 below), and `requireRole` answers with a
//     403. A moderator gets 404 here too, not just an ordinary user: this
//     surface has nothing to do with moderation, and a moderator is not an
//     admin.
//   * THE BELT — routes/v1/index.ts registers this plugin only inside its
//     `config.storage === 'postgres'` branch. `plugins/authDisabled.ts`
//     supplies `requireRole` as a no-op in sqlite mode, and a role-guarded
//     route registered there would admit anyone and then crash on
//     `request.user.role` — a route never registered cannot be reached in
//     either mode.
//   * THE BRACES — `requireUserOrThrow` below throws if `request.user` is
//     absent when a route's own preHandler chain should have guaranteed it
//     is not. Insurance for a future route that copies this pattern but
//     skips the belt or reorders the preHandlers, not a path any request
//     reaching here in postgres mode can actually take.
//   * The non-admin rejection is byte-for-byte `server.ts`'s
//     `setNotFoundHandler` shape, not `reply.notFound()` — on an admin
//     surface the ROUTE is the secret, and a client must not be able to
//     distinguish "hidden" from "never existed" by response body any more
//     than by status code. admin.test.ts asserts the byte-equality against
//     a real unregistered sibling path, not a hand-written literal.
//   * Anonymous gets the ordinary `fastify.authRequired` 401 — a session is
//     the only thing missing there, and there is no secret a 401 would leak
//     that a 404 would not.

import type { FastifyPluginAsync, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { RequestUser } from '../users/service.js';
import * as repo from './repo.js';

/** Same argument as moderation.routes.ts's own requireUserOrThrow. */
export function requireUserOrThrow(request: FastifyRequest): RequestUser {
  if (!request.user) {
    throw new Error(
      'admin route reached with request.user absent — fastify.authRequired should have '
      + 'already answered 401/503 for this request. This must be impossible in postgres mode; '
      + 'reaching it means either the preHandler order changed, or this route is registered '
      + 'somewhere authRequired/requireRole are the sqlite-mode no-ops (plugins/authDisabled.ts).',
    );
  }
  return request.user;
}

/** Admin only. See the module header for the byte-identical 404 this answers to everyone else. */
function requireAdmin(): preHandlerHookHandler {
  return async (request, reply) => {
    const user = requireUserOrThrow(request);
    if (user.role !== 'admin') {
      return reply.code(404).send({
        error: 'not_found',
        message: `Route ${request.method}:${request.url} not found`,
      });
    }
  };
}

const IdParam = z.object({ id: z.string().uuid() });
const JobIdParam = z.object({ id: z.coerce.number().int().positive() });

const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const UsageQuery = z.object({
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const PatchUserBody = z.object({
  globalRole: z.enum(['user', 'moderator', 'admin']).optional(),
  quotaTier: z.enum(['free', 'verified', 'staff']).optional(),
});

// Default lookback for GET /usage when the caller doesn't say — the point of
// the query is "who is spending the reasoner lately", and 30 days is enough
// to see a term's worth of use without scanning the whole table by default.
const DEFAULT_USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const adminRoutes: FastifyPluginAsync = async (fastify) => {
  const guarded = [fastify.authRequired, requireAdmin()];

  fastify.get('/users', { preHandler: guarded }, async (request) => {
    const { limit, offset } = PageQuery.parse(request.query);
    return repo.listUsers(fastify.pg, { limit: limit ?? 50, offset: offset ?? 0 });
  });

  fastify.patch('/users/:id', { preHandler: guarded }, async (request, reply) => {
    const parsedId = IdParam.safeParse(request.params);
    if (!parsedId.success) return reply.badRequest('Malformed user id');
    const patch = PatchUserBody.parse(request.body);
    const actor = requireUserOrThrow(request);

    // An accidental self-demotion locks the last admin out with no recovery
    // path short of a psql prompt — refused outright rather than left to an
    // operator's own care. Every other field (including one's own tier) is
    // unrestricted.
    if (parsedId.data.id === actor.id && patch.globalRole !== undefined && patch.globalRole !== 'admin') {
      return reply.badRequest('You cannot remove your own admin role.');
    }

    const updated = await repo.updateUser(fastify.pg, parsedId.data.id, patch);
    if (!updated) return reply.notFound('User not found');
    return reply.code(204).send();
  });

  fastify.get('/usage', { preHandler: guarded }, async (request) => {
    const { since, limit, offset } = UsageQuery.parse(request.query);
    const sinceDate = since ? new Date(since) : new Date(Date.now() - DEFAULT_USAGE_WINDOW_MS);
    return repo.usageSummary(fastify.pg, sinceDate, { limit: limit ?? 100, offset: offset ?? 0 });
  });

  fastify.get('/jobs', { preHandler: guarded }, async (request) => {
    const { limit, offset } = PageQuery.parse(request.query);
    return repo.listJobs(fastify.pg, { limit: limit ?? 50, offset: offset ?? 0 });
  });

  fastify.post('/jobs/:id/requeue', { preHandler: guarded }, async (request, reply) => {
    const parsed = JobIdParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed job id');

    const outcome = await repo.requeueJob(fastify.pg, parsed.data.id);
    switch (outcome) {
      case 'not-found':
        return reply.notFound('Job not found');
      case 'not-stuck':
        return reply.badRequest('Only a running or failed job can be requeued');
      case 'conflict':
        return reply.conflict('Another job is already queued or running for this schema');
      case 'requeued':
        return reply.code(204).send();
    }
  });
};

export default adminRoutes;
