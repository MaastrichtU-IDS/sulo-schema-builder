// HTTP surface for schemas; all persistence goes through service.ts. Payload
// *shapes* match the pre-existing SQLite path for the routes that predate
// this plan, but status codes do not: this plan added 404/403/401 where
// SQLite unconditionally answered 200 (see the three answers below), a
// `visibility` field, and `?scope=` — none of which the SQLite path has any
// equivalent for.
//
// AUTHORIZATION LIVES IN ONE PLACE. Every route that names a schema carries a
// `requireAccess(level)` preHandler (modules/acl/guards.ts), which loads the
// row and the caller's grant in one query, resolves the level with the pure
// policy in modules/acl/resolve.ts, and either answers 404/403/401 or hands the
// handler `request.schemaAccess`. No handler below re-fetches the schema, and
// none of them decides *who may* — the one named exception is PATCH /:id's
// `assertMayChangeVisibility` call, and even that only calls out to
// `mayChangeVisibility` in modules/acl/guards.ts, which is where the actual
// comparison lives. If you find yourself adding a permission check anywhere
// else in this file, the level on the route is wrong.
//
// The three answers are not interchangeable:
//   * 404 — the caller may not know this schema exists. Byte-identical to the
//     answer for a uuid that never existed, so the pair is not an oracle.
//   * 403 — the caller can already see it and lacks the level for what they
//     attempted.
//   * 401 — the caller can see it and the only missing thing is a session.
//
// The two routes that name no schema are guarded differently, because there is
// no row to resolve against: POST / needs a session (`fastify.authRequired`),
// and GET / needs only `requireSaneToken` — a caller whose token is expired or
// unresolvable is told so, rather than handed the list below.
//
// GET / takes `?scope=mine|shared|public` (ListSchemasQuery in schemas.ts),
// defaulting to `mine` when signed in and `public` otherwise. `mine`/`shared`
// name the caller's own relationship to a schema, so they are meaningless
// without a session — requesting either anonymously is 401, not "".
//
// `authRequired` is a decorator plugins/auth.ts provides and that plugin is
// registered only in postgres mode, so server.ts registers
// plugins/authDisabled.ts (a no-op guard) in the sqlite branch. This file is
// never *registered* there — routes/v1/index.ts mounts the SQLite routes
// instead — but it is statically imported in both modes, which is why
// modules/acl/repo.ts must keep kysely as an `import type` (see the invariant
// at the top of that file).
//
// Child writes stay scoped to the schema in the path (`.where('schema_id', …)`
// in repo.ts) and so do superClassId/domainClassId references (service.ts).
// That is deliberate and must not be removed now that the guard exists: the
// guard authorises on `:id`, and those writes key on the same `:id`.
//
// The one handler that leaves the process — GET /:id/upper-concepts — goes
// through the same guarded helper and the same per-route rate limit as the
// standalone proxy, never through the unguarded
// rdf/upperConcepts.ts#fetchUpperConcepts (desktop only).

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { guardedUpperConcepts, UPPER_CONCEPTS_RATE_LIMIT } from '../../rdf/guardedUpperConcepts.js';
import { aclGuards, mayChangeVisibility, requireAccess, requireSaneToken } from '../acl/guards.js';
import type { AccessLevel } from '../acl/resolve.js';
import type { RequestUser } from '../users/service.js';
import { checkQuota, recordUsage, SCHEMA_CREATE, UPPER_CONCEPTS_FETCH } from '../quota/service.js';
import * as service from './service.js';
import {
  AddClassBody, AddPropertyBody, CreateOntologySchemaBody, ListSchemasQuery,
  UpdateClassBody, UpdateOntologySchemaBody, UpdatePropertyBody,
} from './schemas.js';

/**
 * `request.user` is non-null after authRequired, but asserting that with `!` at
 * every call site means a route registered without the preHandler crashes
 * somewhere far from the mistake. This turns the same wiring error into a loud,
 * self-describing 500 during development.
 */
function requireUser(request: FastifyRequest): RequestUser {
  if (!request.user) throw new Error('route is missing the authRequired preHandler');
  return request.user;
}

/** Same argument as requireUser, for the guard's decoration. */
function schemaAccess(request: FastifyRequest): NonNullable<FastifyRequest['schemaAccess']> {
  if (!request.schemaAccess) throw new Error('route is missing the requireAccess preHandler');
  return request.schemaAccess;
}

// `:id` is validated by the guard (it has to be, or it would hand Postgres a
// bad uuid literal), so only the child ids are checked here.
const ClassIdParam = z.object({ classId: z.string().uuid() });
const PropIdParam = z.object({ propId: z.string().uuid() });

/**
 * Thrown by assertMayChangeVisibility. `statusCode < 500` is what
 * plugins/errorHandler.ts forwards as-is, so this reaches the caller as a
 * plain 403 with `message` intact — the same mechanism service.ts's
 * SchemaWriteError uses for 400s.
 */
class VisibilityChangeForbidden extends Error {
  readonly statusCode = 403;
  constructor() {
    super('Only the schema owner may change its visibility.');
    this.name = 'VisibilityChangeForbidden';
  }
}

/**
 * The one place in this file a single guard level is not the whole story.
 * PATCH /:id stays guarded at `edit` (see the module comment) so an editor
 * can still retitle or redescribe a schema — that is the point of the editor
 * role. But publication is an ownership decision, so changing `visibility`
 * itself needs `own`. The comparison (`mayChangeVisibility`) lives in
 * modules/acl/guards.ts, the single enforcement point for schema-level
 * policy — this is only the field-conditional call site and the 403 shape,
 * named and isolated here rather than an inline `if` in the handler.
 */
function assertMayChangeVisibility(level: AccessLevel): void {
  if (!mayChangeVisibility(level)) throw new VisibilityChangeForbidden();
}

const schemasRoutes: FastifyPluginAsync = async (fastify) => {
  // Creates request.schemaAccess. requireAccess is unusable without it, which
  // is why the two ship from one module.
  await fastify.register(aclGuards);

  // Open to anonymous callers: reading the catalogue needs no session. See the
  // module comment for what `?scope=` means and who may ask for it.
  //
  // `requireSaneToken` is not a session check, and this route is not guarded by
  // one. It separates "no token" (fine, `public` is a legitimate scope for
  // that) from "a token that is expired, unverifiable, or that the server
  // could not resolve" — which without it would answer as anonymous, i.e. tell
  // a signed-in user whose token has just expired that their schemas are gone
  // rather than that their session broke.
  fastify.get('/', { preHandler: requireSaneToken }, async (request, reply) => {
    const { scope: requested } = ListSchemasQuery.parse(request.query);
    const scope = requested ?? (request.user ? 'mine' : 'public');

    // Not a schema-level ACL decision (there is no row yet to resolve one
    // against) — just what a scope name means without a session. `mine`/
    // `shared` describe the caller's own relationship to a schema, which an
    // anonymous caller does not have, so this is 401 rather than [].
    if (scope !== 'public' && !request.user) return reply.unauthorized('Sign in to continue.');

    return service.listSchemasByScope(fastify.pg, scope, request.user?.id ?? null);
  });

  fastify.post('/', { preHandler: fastify.authRequired }, async (request, reply) => {
    const data = CreateOntologySchemaBody.parse(request.body);
    const user = requireUser(request);
    // spec §6: maxSchemas counts only what THIS user owns — checkQuota's
    // SCHEMA_CREATE branch already scopes it that way. Checked before the
    // insert, so a denial creates no row.
    const quota = await checkQuota(fastify.pg, user, SCHEMA_CREATE);
    if (!quota.allowed) {
      return reply.code(409).send({ error: 'quota_exceeded', message: quota.reason });
    }
    const created = await service.createSchema(fastify.pg, user.id, data);
    return reply.code(201).send(created);
  });

  fastify.get('/:id', { preHandler: requireAccess('view') }, async (request) => {
    const { schema, level } = schemaAccess(request);
    // The frontend has no other way to know whether it may show edit/delete
    // controls for this schema's classes/properties — schemaRowToSummary
    // deliberately omits owner_id (see its own comment), so `level` (already
    // computed by the requireAccess guard above) is the one thing that can
    // safely stand in for it without leaking who the owner actually is.
    return { ...(await service.schemaWithChildren(fastify.pg, schema)), accessLevel: level };
  });

  fastify.patch('/:id', { preHandler: requireAccess('edit') }, async (request, reply) => {
    const data = UpdateOntologySchemaBody.parse(request.body);
    if (data.visibility !== undefined) assertMayChangeVisibility(schemaAccess(request).level);
    await service.updateSchema(fastify.pg, schemaAccess(request).schema.id, data, requireUser(request).id);
    return reply.code(204).send();
  });

  fastify.delete('/:id', { preHandler: requireAccess('own') }, async (request, reply) => {
    await service.deleteSchema(fastify.pg, schemaAccess(request).schema.id);
    return reply.code(204).send();
  });

  fastify.get('/:id/upper-concepts', {
    // Reading is view-level, but making the server dereference a remote IRI
    // stays a privilege of signed-in users (plan 2, spec §5) — hence both
    // guards, not just the ACL one.
    preHandler: [fastify.authRequired, requireAccess('view')],
    // Same budget as the standalone proxy: both make this server fetch a
    // caller-influenced URL, and this one is the route the frontend uses.
    config: { rateLimit: UPPER_CONCEPTS_RATE_LIMIT },
  }, async (request, reply) => {
    const { schema } = schemaAccess(request);
    if (!schema.upper_ontology_iri) return [];

    // spec §6: the per-user budget on top of the per-route rate limit above —
    // it meters the remote fetches this server performs on a caller's
    // behalf, so it is checked before the fetch and NOT charged for a
    // response guardedUpperConcepts answers from its own cache (see
    // recordUsage below, gated on `!result.cacheHit`).
    const user = requireUser(request);
    const quota = await checkQuota(fastify.pg, user, UPPER_CONCEPTS_FETCH);
    if (!quota.allowed) {
      return reply.code(429).send({ error: 'quota_exceeded', message: quota.reason, retryAfter: quota.retryAfterSeconds });
    }

    const result = await guardedUpperConcepts(schema.upper_ontology_iri);
    if (result.ok) {
      if (!result.cacheHit) {
        await recordUsage(fastify.pg, {
          userId: user.id, kind: UPPER_CONCEPTS_FETCH, schemaId: schema.id, costMs: null, cacheHit: false,
        });
      }
      return result.concepts;
    }
    // Rows written before the write-time check existed (or by a future path that
    // skips it) can still hold a rejected IRI, so this stays a real branch.
    if (result.reason === 'too_large') return reply.unprocessableEntity(result.message);
    return reply.badRequest(result.message);
  });

  fastify.post('/:id/classes', { preHandler: requireAccess('edit') }, async (request, reply) => {
    // No existence probe: the guard already loaded the row, so the FK cannot be
    // tripped by an unknown schema id — an unknown one never reaches here.
    const data = AddClassBody.parse(request.body);
    const created = await service.addClass(fastify.pg, schemaAccess(request).schema.id, data, requireUser(request).id);
    return reply.code(201).send(created);
  });

  fastify.patch('/:id/classes/:classId', { preHandler: requireAccess('edit') }, async (request, reply) => {
    const parsed = ClassIdParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const schemaId = schemaAccess(request).schema.id;
    const data = UpdateClassBody.parse(request.body);
    const updated = await service.updateClass(fastify.pg, schemaId, parsed.data.classId, data, requireUser(request).id);
    if (!updated) return reply.notFound(`Class ${parsed.data.classId} not found in schema ${schemaId}`);
    return reply.code(204).send();
  });

  fastify.delete('/:id/classes/:classId', { preHandler: requireAccess('edit') }, async (request, reply) => {
    const parsed = ClassIdParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const schemaId = schemaAccess(request).schema.id;
    const deleted = await service.deleteClass(fastify.pg, schemaId, parsed.data.classId, requireUser(request).id);
    if (!deleted) return reply.notFound(`Class ${parsed.data.classId} not found in schema ${schemaId}`);
    return reply.code(204).send();
  });

  fastify.post('/:id/properties', { preHandler: requireAccess('edit') }, async (request, reply) => {
    const data = AddPropertyBody.parse(request.body);
    const created = await service.addProperty(fastify.pg, schemaAccess(request).schema.id, data, requireUser(request).id);
    return reply.code(201).send(created);
  });

  fastify.patch('/:id/properties/:propId', { preHandler: requireAccess('edit') }, async (request, reply) => {
    const parsed = PropIdParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const schemaId = schemaAccess(request).schema.id;
    const data = UpdatePropertyBody.parse(request.body);
    const updated = await service.updateProperty(fastify.pg, schemaId, parsed.data.propId, data, requireUser(request).id);
    if (!updated) return reply.notFound(`Property ${parsed.data.propId} not found in schema ${schemaId}`);
    return reply.code(204).send();
  });

  fastify.delete('/:id/properties/:propId', { preHandler: requireAccess('edit') }, async (request, reply) => {
    const parsed = PropIdParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const schemaId = schemaAccess(request).schema.id;
    const deleted = await service.deleteProperty(fastify.pg, schemaId, parsed.data.propId, requireUser(request).id);
    if (!deleted) return reply.notFound(`Property ${parsed.data.propId} not found in schema ${schemaId}`);
    return reply.code(204).send();
  });
};

export default schemasRoutes;
