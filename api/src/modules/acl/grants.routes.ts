// The sharing surface: list, grant, revoke, transfer — and the email lookup
// that makes any of it usable.
//
// Registered as a SIBLING of modules/schemas/routes.ts under the same
// /ontology-schemas prefix (see routes/v1/index.ts), so `:id` is the same
// parameter `requireAccess` already knows how to resolve. That arrangement is
// why this file registers `aclGuards` itself: `fastify-plugin` lets that plugin
// escape exactly one encapsulation level, not all of them, so a sibling does
// not inherit `request.schemaAccess`. Forgetting is SILENT — Fastify does not
// seal `request`, so the guard's assignment still works and every route still
// behaves — what is lost is the `decorators:` prerequisite assertion, i.e. a
// missing `pg` or `user` becomes a crash on the first guarded request instead
// of an error at boot. grants.test.ts asserts the boot failure directly, so
// deleting the registration below turns that test red.
//
// Every route that names a schema is guarded at `own`, which is what makes the
// three answers below fall out of modules/acl/guards.ts rather than being
// re-derived here: a stranger gets 404 (they may not learn the id is real), an
// editor-grantee gets 403 (they can already open it), and an anonymous caller
// can never reach `own` at all. The one decision this file adds on top is who
// may *transfer*, and even that comparison lives in guards.ts
// (`mayTransferOwnership`) next to `mayChangeVisibility`, for the same reason:
// the acl module is the single enforcement point for schema-level policy.
//
// ---------------------------------------------------------------------------
// GET /users/lookup?email= — AN AUTHENTICATED EMAIL-EXISTENCE ORACLE, ACCEPTED
// DELIBERATELY.
//
// Sharing has to turn something a human knows (a colleague's address) into a
// user id, and spec §5 defines grants to individual users. The alternative we
// considered and rejected was an invitation flow keyed on an opaque token, so
// that no lookup exists at all: it removes the oracle, but it adds token issue,
// storage, expiry, redemption and revocation — a larger surface than the rest
// of this module put together, and disproportionate for a tool serving a known
// institutional population. So the lookup exists, and the constraints below
// ARE the mitigation. None of them is decoration:
//
//   * exact match only, never a prefix, a fragment or a pattern (see
//     users/repo.ts#findByEmailExact — `=` against `lower(email)`, never
//     `like`/`ilike`). A caller cannot enumerate; they can only confirm.
//   * authenticated callers only (`authRequired`), so every probe is attributable
//     to a Keycloak identity and an anonymous crawler learns nothing.
//   * the response is `{ id, displayName }` and NEVER the address, the subject,
//     the role or the tier. It confirms only what the caller already typed.
//   * its own per-route budget (USER_LOOKUP_RATE_LIMIT), an order of magnitude
//     tighter than the global per-IP limit in server.ts, and keyed on the
//     *authenticated identity* rather than on the source address, because
//     guessing is a volume game and addresses are cheap to rotate.
//   * 404 when absent, in the same shape as every other 404 on this API, so the
//     answer carries no side channel beyond its status.
//
// RESIDUAL RISK, stated rather than hidden: a signed-in user CAN confirm
// whether any address they can already write down has an account here, one
// address at a time, at the rate limit. Display names are real names, so a
// confirmed hit also links an address to a person. A 409 additionally reveals
// that *two* accounts share an address — slightly more than "this one exists",
// and the price of refusing to guess which of them the caller meant. And the
// rate limit is a deployment setting, not an invariant: RATE_LIMIT_ENABLED=false
// (config/server.ts) removes @fastify/rate-limit entirely, and with it this
// route's budget — a deployment that sets it has accepted an unmetered oracle,
// which is a materially different bargain from the one described above.
//
// This is accepted — it is the minimum an interpersonal sharing feature can
// leak, it is attributable, and it is metered by default — and it is not
// accepted quietly: if this endpoint ever grows a pattern match, a bulk form,
// an unauthenticated caller, an IP-keyed limit or a looser one, the accepted
// risk no longer describes what is deployed.
// ---------------------------------------------------------------------------

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { aclGuards, mayTransferOwnership, requireAccess } from './guards.js';
import { deleteGrant, listGrants, transferOwnership, upsertGrant } from './grants.repo.js';
import { findByEmailExact } from '../users/repo.js';
import type { RequestUser } from '../users/service.js';

/**
 * The lookup's own budget. Deliberately far below server.ts's global limit
 * (300/minute): confirming one address is a legitimate act a few times a
 * minute, and a lever worth pulling thousands of times. Enforced whenever
 * config.rateLimitEnabled registers @fastify/rate-limit — same mechanism as
 * UPPER_CONCEPTS_RATE_LIMIT.
 *
 * `keyGenerator` is the load-bearing part, not the number. @fastify/rate-limit
 * defaults to `request.ip`, which would meter the wrong thing twice over: an
 * attacker rotating source addresses would get a fresh 20/minute per address
 * while remaining one attributable account (exactly the volume game the header
 * says this prevents), and — since nothing in this API sets `trustProxy` —
 * every caller behind an ingress or a shared egress would share one bucket, so
 * an anonymous flood could exhaust the budget for an entire institution.
 * Keying on the resolved user id fixes both: the meter follows the identity
 * that the audit trail would name. The IP remains the fallback for requests
 * with no identity, which is every request this route then answers 401 —
 * @fastify/rate-limit's hook runs on onRequest, i.e. *before* `authRequired`
 * rejects them, so an anonymous flood still has to be metered as something.
 * `request.user` is already populated by then: plugins/auth.ts sets it in its
 * own onRequest hook, and it is registered before the rate limiter in both
 * server.ts and the test harness.
 */
export const USER_LOOKUP_RATE_LIMIT = {
  max: 20,
  timeWindow: '1 minute',
  keyGenerator: (request: FastifyRequest) => request.user?.id ?? request.ip,
} as const;

/** Mirrors the CHECK on schema_grants.role (migration 001). */
const GrantBody = z.object({ role: z.enum(['viewer', 'editor', 'owner']) });
const TransferBody = z.object({ userId: z.string().uuid() });

/**
 * `:userId` is a uuid column in Postgres, so a non-uuid must be rejected
 * *before* the query, or a client typo becomes a 500. Same argument as the
 * guard's own `:id` check.
 */
const UserIdParam = z.object({ userId: z.string().uuid() });

/**
 * `?email=`. `.trim()` runs before the format check, so '%20' is a blank
 * address (400) rather than a scan for one. The 320-character bound is the
 * RFC 3696 maximum; the format check means a value that could never be an
 * address never reaches the database.
 */
const LookupQuery = z.object({ email: z.string().trim().min(3).max(320).email() });

/**
 * The guard's decoration. Same argument as modules/schemas/routes.ts's copy: a
 * route registered without the preHandler becomes a loud, self-describing 500
 * during development instead of a crash far from the mistake.
 */
function schemaAccess(request: FastifyRequest): NonNullable<FastifyRequest['schemaAccess']> {
  if (!request.schemaAccess) throw new Error('route is missing the requireAccess preHandler');
  return request.schemaAccess;
}

/**
 * The user performing a grant or a transfer.
 *
 * Non-null on every route below by construction, not by convention: `own` is
 * reachable only through `owner_id`, an explicit grant, or the admin role
 * (modules/acl/resolve.ts), and all three require an identity — an anonymous
 * caller resolves to at most `view`. Asserted rather than `!`-ed so that a
 * future change to that policy surfaces here instead of writing `null` into
 * granted_by.
 */
function actor(request: FastifyRequest): RequestUser {
  if (!request.user) throw new Error('reached an own-level route with no user — resolveAccess changed');
  return request.user;
}

const grantsRoutes: FastifyPluginAsync = async (fastify) => {
  // NOT inherited from the schema routes' registration — see the header.
  await fastify.register(aclGuards);

  fastify.get('/:id/grants', { preHandler: requireAccess('own') }, async (request) =>
    listGrants(fastify.pg, schemaAccess(request).schema.id));

  // PUT, not POST: the grant is named by its own URL and re-issuing it is
  // idempotent in the role it asks for. 200 with the resulting grant on both
  // create and update — the difference is not worth a status code the client
  // would have to branch on, and the body is what a sharing UI needs to render.
  fastify.put('/:id/grants/:userId', { preHandler: requireAccess('own') }, async (request, reply) => {
    const parsed = UserIdParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed user id');
    const { role } = GrantBody.parse(request.body);

    const { schema } = schemaAccess(request);
    const granteeId = parsed.data.userId;

    // A grant to someone who already has `own` from elsewhere is not harmless
    // redundancy: resolveAccess ignores it (highest match wins), so the row
    // would sit in the grants list claiming to be the reason for an access it
    // is not, and revoking it would appear to do nothing. Refuse instead.
    if (granteeId === schema.owner_id) {
      return reply.badRequest('The schema owner already has full access; grant it to someone else.');
    }
    if (granteeId === actor(request).id) {
      return reply.badRequest('You cannot grant access to yourself.');
    }

    const grant = await upsertGrant(fastify.pg, {
      schemaId: schema.id, granteeId, role, grantedBy: actor(request).id,
    });
    // No such user, and — because the check and the insert share one
    // transaction — nothing was written. Safe to distinguish from the schema's
    // own 404: the caller holds `own` here, so the id is not news to them.
    if (!grant) return reply.notFound('User not found');
    return grant;
  });

  fastify.delete('/:id/grants/:userId', { preHandler: requireAccess('own') }, async (request, reply) => {
    const parsed = UserIdParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed user id');

    const removed = await deleteGrant(fastify.pg, schemaAccess(request).schema.id, parsed.data.userId);
    // Not idempotent-204: an owner who revokes the wrong person, or who thinks
    // they revoked someone the list never contained, should be told. Nothing
    // leaks — a grant they cannot see is on a schema they hold `own` over.
    if (!removed) return reply.notFound('No such grant on this schema');
    return reply.code(204).send();
  });

  // POST rather than a PATCH of owner_id: this is one indivisible act (move
  // ownership, keep the previous owner an owner-grant) and not a field write.
  // owner_id is not exposed by any read route either (see mappers.ts).
  fastify.post('/:id/transfer', { preHandler: requireAccess('own') }, async (request, reply) => {
    const { userId } = TransferBody.parse(request.body);
    const { schema } = schemaAccess(request);

    // The one place `own` is not enough. An owner-grantee holds `own` — that is
    // what lets the previous owner keep working after a transfer — but giving a
    // schema away is the one act reserved for whoever currently holds it (or an
    // admin). Without this, a previous owner could transfer it straight back,
    // and "handing over" would not mean anything.
    if (!mayTransferOwnership(actor(request), schema)) {
      return reply.forbidden('Only the current owner may transfer this schema.');
    }
    if (userId === schema.owner_id) {
      return reply.badRequest('That user already owns this schema.');
    }

    const result = await transferOwnership(fastify.pg, {
      schemaId: schema.id,
      expectedOwnerId: schema.owner_id,
      newOwnerId: userId,
      actorId: actor(request).id,
    });
    if (result === 'no_such_user') return reply.notFound('User not found');
    // Someone else moved (or removed) this schema between the guard's read and
    // the transaction. Answering 409 rather than retrying keeps the decision
    // with the human who thought they owned it a moment ago.
    if (result === 'owner_changed') return reply.conflict('This schema changed owner; reload and try again.');
    return reply.code(204).send();
  });
};

/**
 * Mounted at /users (routes/v1/index.ts), not under /ontology-schemas: it names
 * no schema, so it carries no ACL guard — only `authRequired` and its own rate
 * limit. Read the header of this file before changing anything about it; the
 * constraints are the mitigation, not the styling.
 */
export const userLookupRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/lookup', {
    preHandler: fastify.authRequired,
    config: { rateLimit: USER_LOOKUP_RATE_LIMIT },
  }, async (request, reply) => {
    const { email } = LookupQuery.parse(request.query);

    const found = await findByEmailExact(fastify.pg, email);
    // Identical in shape to every other notFound on this API, and it does not
    // echo the address — the caller typed it, and the response repeating it
    // would put it into logs and referrers for no gain.
    if (found.length === 0) return reply.notFound('User not found');
    // users.email carries no unique constraint (see findByEmailExact), so this
    // is reachable. Picking one would silently share a schema with the wrong
    // person; saying so keeps the mistake visible and fixable.
    if (found.length > 1) {
      return reply.conflict('More than one account uses that address. Ask an administrator to resolve it.');
    }
    return found[0];
  });
};

export default grantsRoutes;
