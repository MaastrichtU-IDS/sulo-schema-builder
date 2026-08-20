// HTTP surface for schemas. Identical paths, payloads and status codes to the
// SQLite path this replaces; all persistence goes through service.ts.
//
// Every route here requires a verified session — `fastify.authRequired` on all
// twelve — and ownership follows the token: GET / and POST / are keyed on
// request.user.id, so a caller lists and creates only their own schemas.
// LOCAL_OWNER_ID is no longer involved; the seeded row it names still exists and
// still owns the pre-authentication schemas, it is simply nobody's session.
//
// The guard is read unconditionally, in both storage modes. `authRequired` is a
// decorator plugins/auth.ts provides and that plugin is registered only in
// postgres mode, so server.ts registers plugins/authDisabled.ts (a no-op guard)
// in the sqlite branch. That keeps this file free of `config.auth.enabled`
// branches — see the comment in plugins/authDisabled.ts for the full argument.
//
// What is NOT here yet is per-schema authorization: visibility, grants,
// cross-user reads of a schema by id, `?scope=` filtering and the 404-not-403
// rule (design §5) all arrive in plan 3. Until then an authenticated caller who
// knows a uuid can still read and mutate another user's schema. Child mutations
// are at least scoped to the schema in the path (not the child id alone), and so
// are superClassId/domainClassId references (in service.ts), so the guard plan 3
// attaches to `:id` is the same key every write already uses.
//
// The one handler that leaves the process — GET /:id/upper-concepts — goes
// through the same guarded helper and the same per-route rate limit as the
// standalone proxy, never through the unguarded
// rdf/upperConcepts.ts#fetchUpperConcepts (desktop only).

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { guardedUpperConcepts, UPPER_CONCEPTS_RATE_LIMIT } from '../../rdf/guardedUpperConcepts.js';
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

/** Route params are uuids in Postgres; a non-uuid is a client error, not a 500. */
const UuidParam = z.object({ id: z.string().uuid() });
const UuidClassParam = z.object({ id: z.string().uuid(), classId: z.string().uuid() });
const UuidPropParam = z.object({ id: z.string().uuid(), propId: z.string().uuid() });

const schemasRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', { preHandler: fastify.authRequired }, async (request) =>
    service.listSchemas(fastify.pg, requireUser(request).id));

  fastify.get('/:id', { preHandler: fastify.authRequired }, async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    const schema = await service.getSchemaWithChildren(fastify.pg, parsed.data.id);
    if (!schema) return reply.notFound(`OntologySchema ${parsed.data.id} not found`);
    return schema;
  });

  fastify.post('/', { preHandler: fastify.authRequired }, async (request, reply) => {
    const data = CreateOntologySchemaBody.parse(request.body);
    const created = await service.createSchema(fastify.pg, requireUser(request).id, data);
    return reply.code(201).send(created);
  });

  fastify.patch('/:id', { preHandler: fastify.authRequired }, async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    const data = UpdateOntologySchemaBody.parse(request.body);
    await service.updateSchema(fastify.pg, parsed.data.id, data);
    return reply.code(204).send();
  });

  fastify.delete('/:id', { preHandler: fastify.authRequired }, async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    await service.deleteSchema(fastify.pg, parsed.data.id);
    return reply.code(204).send();
  });

  fastify.get('/:id/upper-concepts', {
    preHandler: fastify.authRequired,
    // Same budget as the standalone proxy: both make this server fetch a
    // caller-influenced URL, and this one is the route the frontend uses.
    config: { rateLimit: UPPER_CONCEPTS_RATE_LIMIT },
  }, async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    const schema = await service.getSchemaWithChildren(fastify.pg, parsed.data.id);
    if (!schema) return reply.notFound(`OntologySchema ${parsed.data.id} not found`);
    if (!schema.upperOntologyIri) return [];

    const result = await guardedUpperConcepts(schema.upperOntologyIri);
    if (result.ok) return result.concepts;
    // Rows written before the write-time check existed (or by a future path that
    // skips it) can still hold a rejected IRI, so this stays a real branch.
    if (result.reason === 'too_large') return reply.unprocessableEntity(result.message);
    return reply.badRequest(result.message);
  });

  fastify.post('/:id/classes', { preHandler: fastify.authRequired }, async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    // Without this the insert would hit classes_schema_id_fkey and surface as a
    // 500; an unknown schema is a 404, the same as reading it.
    if (!(await service.schemaExists(fastify.pg, parsed.data.id))) {
      return reply.notFound(`OntologySchema ${parsed.data.id} not found`);
    }

    const data = AddClassBody.parse(request.body);
    const created = await service.addClass(fastify.pg, parsed.data.id, data);
    return reply.code(201).send(created);
  });

  fastify.patch('/:id/classes/:classId', { preHandler: fastify.authRequired }, async (request, reply) => {
    const parsed = UuidClassParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const data = UpdateClassBody.parse(request.body);
    const updated = await service.updateClass(fastify.pg, parsed.data.id, parsed.data.classId, data);
    if (!updated) return reply.notFound(`Class ${parsed.data.classId} not found in schema ${parsed.data.id}`);
    return reply.code(204).send();
  });

  fastify.delete('/:id/classes/:classId', { preHandler: fastify.authRequired }, async (request, reply) => {
    const parsed = UuidClassParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const deleted = await service.deleteClass(fastify.pg, parsed.data.id, parsed.data.classId);
    if (!deleted) return reply.notFound(`Class ${parsed.data.classId} not found in schema ${parsed.data.id}`);
    return reply.code(204).send();
  });

  fastify.post('/:id/properties', { preHandler: fastify.authRequired }, async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    if (!(await service.schemaExists(fastify.pg, parsed.data.id))) {
      return reply.notFound(`OntologySchema ${parsed.data.id} not found`);
    }

    const data = AddPropertyBody.parse(request.body);
    const created = await service.addProperty(fastify.pg, parsed.data.id, data);
    return reply.code(201).send(created);
  });

  fastify.patch('/:id/properties/:propId', { preHandler: fastify.authRequired }, async (request, reply) => {
    const parsed = UuidPropParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const data = UpdatePropertyBody.parse(request.body);
    const updated = await service.updateProperty(fastify.pg, parsed.data.id, parsed.data.propId, data);
    if (!updated) return reply.notFound(`Property ${parsed.data.propId} not found in schema ${parsed.data.id}`);
    return reply.code(204).send();
  });

  fastify.delete('/:id/properties/:propId', { preHandler: fastify.authRequired }, async (request, reply) => {
    const parsed = UuidPropParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const deleted = await service.deleteProperty(fastify.pg, parsed.data.id, parsed.data.propId);
    if (!deleted) return reply.notFound(`Property ${parsed.data.propId} not found in schema ${parsed.data.id}`);
    return reply.code(204).send();
  });
};

export default schemasRoutes;
