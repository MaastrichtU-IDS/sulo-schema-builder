// HTTP surface for schemas. Identical paths, payloads and status codes to the
// SQLite path this replaces; all persistence goes through service.ts.
//
// AUTHORIZATION LIVES IN ONE PLACE. Every route that names a schema carries a
// `requireAccess(level)` preHandler (modules/acl/guards.ts), which loads the
// row and the caller's grant in one query, resolves the level with the pure
// policy in modules/acl/resolve.ts, and either answers 404/403/401 or hands the
// handler `request.schemaAccess`. No handler below re-fetches the schema, and
// none of them contains a permission check — if you find yourself adding one,
// the level on the route is wrong.
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
// and GET / needs nothing — an anonymous caller gets an empty list until Task 3
// adds `?scope=`.
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
import { aclGuards, requireAccess } from '../acl/guards.js';
import type { RequestUser } from '../users/service.js';
import * as service from './service.js';
import {
  AddClassBody, AddPropertyBody, CreateOntologySchemaBody,
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

const schemasRoutes: FastifyPluginAsync = async (fastify) => {
  // Creates request.schemaAccess. requireAccess is unusable without it, which
  // is why the two ship from one module.
  await fastify.register(aclGuards);

  // Unguarded on purpose: reading the catalogue is open. A signed-in caller
  // still sees only their own schemas — public listing arrives with `?scope=`
  // in Task 3, and until then anonymous means an empty list rather than an
  // accidental dump of every row.
  fastify.get('/', async (request) => {
    if (!request.user) return [];
    return service.listSchemas(fastify.pg, request.user.id);
  });

  fastify.post('/', { preHandler: fastify.authRequired }, async (request, reply) => {
    const data = CreateOntologySchemaBody.parse(request.body);
    const created = await service.createSchema(fastify.pg, requireUser(request).id, data);
    return reply.code(201).send(created);
  });

  fastify.get('/:id', { preHandler: requireAccess('view') }, async (request) =>
    service.schemaWithChildren(fastify.pg, schemaAccess(request).schema));

  fastify.patch('/:id', { preHandler: requireAccess('edit') }, async (request, reply) => {
    const data = UpdateOntologySchemaBody.parse(request.body);
    await service.updateSchema(fastify.pg, schemaAccess(request).schema.id, data);
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

    const result = await guardedUpperConcepts(schema.upper_ontology_iri);
    if (result.ok) return result.concepts;
    // Rows written before the write-time check existed (or by a future path that
    // skips it) can still hold a rejected IRI, so this stays a real branch.
    if (result.reason === 'too_large') return reply.unprocessableEntity(result.message);
    return reply.badRequest(result.message);
  });

  fastify.post('/:id/classes', { preHandler: requireAccess('edit') }, async (request, reply) => {
    // No existence probe: the guard already loaded the row, so the FK cannot be
    // tripped by an unknown schema id — an unknown one never reaches here.
    const data = AddClassBody.parse(request.body);
    const created = await service.addClass(fastify.pg, schemaAccess(request).schema.id, data);
    return reply.code(201).send(created);
  });

  fastify.patch('/:id/classes/:classId', { preHandler: requireAccess('edit') }, async (request, reply) => {
    const parsed = ClassIdParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const schemaId = schemaAccess(request).schema.id;
    const data = UpdateClassBody.parse(request.body);
    const updated = await service.updateClass(fastify.pg, schemaId, parsed.data.classId, data);
    if (!updated) return reply.notFound(`Class ${parsed.data.classId} not found in schema ${schemaId}`);
    return reply.code(204).send();
  });

  fastify.delete('/:id/classes/:classId', { preHandler: requireAccess('edit') }, async (request, reply) => {
    const parsed = ClassIdParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const schemaId = schemaAccess(request).schema.id;
    const deleted = await service.deleteClass(fastify.pg, schemaId, parsed.data.classId);
    if (!deleted) return reply.notFound(`Class ${parsed.data.classId} not found in schema ${schemaId}`);
    return reply.code(204).send();
  });

  fastify.post('/:id/properties', { preHandler: requireAccess('edit') }, async (request, reply) => {
    const data = AddPropertyBody.parse(request.body);
    const created = await service.addProperty(fastify.pg, schemaAccess(request).schema.id, data);
    return reply.code(201).send(created);
  });

  fastify.patch('/:id/properties/:propId', { preHandler: requireAccess('edit') }, async (request, reply) => {
    const parsed = PropIdParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const schemaId = schemaAccess(request).schema.id;
    const data = UpdatePropertyBody.parse(request.body);
    const updated = await service.updateProperty(fastify.pg, schemaId, parsed.data.propId, data);
    if (!updated) return reply.notFound(`Property ${parsed.data.propId} not found in schema ${schemaId}`);
    return reply.code(204).send();
  });

  fastify.delete('/:id/properties/:propId', { preHandler: requireAccess('edit') }, async (request, reply) => {
    const parsed = PropIdParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const schemaId = schemaAccess(request).schema.id;
    const deleted = await service.deleteProperty(fastify.pg, schemaId, parsed.data.propId);
    if (!deleted) return reply.notFound(`Property ${parsed.data.propId} not found in schema ${schemaId}`);
    return reply.code(204).send();
  });
};

export default schemasRoutes;
