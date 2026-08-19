// HTTP surface for schemas. Identical paths, payloads and status codes to the
// SQLite path this replaces; all persistence goes through service.ts.
//
// No authorization yet — every schema belongs to LOCAL_OWNER_ID until plan 2
// introduces authentication and the ACL guards. Child mutations are nonetheless
// scoped to the schema in the path (not the child id alone), and so are
// superClassId/domainClassId references (in service.ts), so the guard plan 2
// attaches to `:id` is the same key every write already uses.
//
// These routes are the live surface of the multi-user web deployment, which
// means every handler here is reachable anonymously. The one that leaves the
// process — GET /:id/upper-concepts — therefore goes through the same guarded
// helper and the same per-route rate limit as the standalone proxy, never
// through the unguarded rdf/upperConcepts.ts#fetchUpperConcepts (desktop only).

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { guardedUpperConcepts, UPPER_CONCEPTS_RATE_LIMIT } from '../../rdf/guardedUpperConcepts.js';
import { LOCAL_OWNER_ID } from '../../db/constants.js';
import * as service from './service.js';
import {
  AddClassBody, AddPropertyBody, CreateOntologySchemaBody,
  UpdateClassBody, UpdateOntologySchemaBody, UpdatePropertyBody,
} from './schemas.js';

/** Route params are uuids in Postgres; a non-uuid is a client error, not a 500. */
const UuidParam = z.object({ id: z.string().uuid() });
const UuidClassParam = z.object({ id: z.string().uuid(), classId: z.string().uuid() });
const UuidPropParam = z.object({ id: z.string().uuid(), propId: z.string().uuid() });

const schemasRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => service.listSchemas(fastify.pg, LOCAL_OWNER_ID));

  fastify.get('/:id', async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    const schema = await service.getSchemaWithChildren(fastify.pg, parsed.data.id);
    if (!schema) return reply.notFound(`OntologySchema ${parsed.data.id} not found`);
    return schema;
  });

  fastify.post('/', async (request, reply) => {
    const data = CreateOntologySchemaBody.parse(request.body);
    const created = await service.createSchema(fastify.pg, LOCAL_OWNER_ID, data);
    return reply.code(201).send(created);
  });

  fastify.patch('/:id', async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    const data = UpdateOntologySchemaBody.parse(request.body);
    await service.updateSchema(fastify.pg, parsed.data.id, data);
    return reply.code(204).send();
  });

  fastify.delete('/:id', async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    await service.deleteSchema(fastify.pg, parsed.data.id);
    return reply.code(204).send();
  });

  fastify.get('/:id/upper-concepts', {
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

  fastify.post('/:id/classes', async (request, reply) => {
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

  fastify.patch('/:id/classes/:classId', async (request, reply) => {
    const parsed = UuidClassParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const data = UpdateClassBody.parse(request.body);
    const updated = await service.updateClass(fastify.pg, parsed.data.id, parsed.data.classId, data);
    if (!updated) return reply.notFound(`Class ${parsed.data.classId} not found in schema ${parsed.data.id}`);
    return reply.code(204).send();
  });

  fastify.delete('/:id/classes/:classId', async (request, reply) => {
    const parsed = UuidClassParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const deleted = await service.deleteClass(fastify.pg, parsed.data.id, parsed.data.classId);
    if (!deleted) return reply.notFound(`Class ${parsed.data.classId} not found in schema ${parsed.data.id}`);
    return reply.code(204).send();
  });

  fastify.post('/:id/properties', async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    if (!(await service.schemaExists(fastify.pg, parsed.data.id))) {
      return reply.notFound(`OntologySchema ${parsed.data.id} not found`);
    }

    const data = AddPropertyBody.parse(request.body);
    const created = await service.addProperty(fastify.pg, parsed.data.id, data);
    return reply.code(201).send(created);
  });

  fastify.patch('/:id/properties/:propId', async (request, reply) => {
    const parsed = UuidPropParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const data = UpdatePropertyBody.parse(request.body);
    const updated = await service.updateProperty(fastify.pg, parsed.data.id, parsed.data.propId, data);
    if (!updated) return reply.notFound(`Property ${parsed.data.propId} not found in schema ${parsed.data.id}`);
    return reply.code(204).send();
  });

  fastify.delete('/:id/properties/:propId', async (request, reply) => {
    const parsed = UuidPropParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const deleted = await service.deleteProperty(fastify.pg, parsed.data.id, parsed.data.propId);
    if (!deleted) return reply.notFound(`Property ${parsed.data.propId} not found in schema ${parsed.data.id}`);
    return reply.code(204).send();
  });
};

export default schemasRoutes;
