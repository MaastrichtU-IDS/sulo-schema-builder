// HTTP surface for schemas. Identical paths, payloads and status codes to the
// SQLite path this replaces; all persistence goes through service.ts.
//
// No authorization yet — every schema belongs to LOCAL_OWNER_ID until plan 2
// introduces authentication and the ACL guards.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { fetchUpperConcepts } from '../../rdf/upperConcepts.js';
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

  fastify.get('/:id/upper-concepts', async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    const schema = await service.getSchemaWithChildren(fastify.pg, parsed.data.id);
    if (!schema) return reply.notFound(`OntologySchema ${parsed.data.id} not found`);
    if (!schema.upperOntologyIri) return [];
    return fetchUpperConcepts(schema.upperOntologyIri);
  });

  fastify.post('/:id/classes', async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    const data = AddClassBody.parse(request.body);
    const created = await service.addClass(fastify.pg, parsed.data.id, data);
    return reply.code(201).send(created);
  });

  fastify.patch('/:id/classes/:classId', async (request, reply) => {
    const parsed = UuidClassParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const data = UpdateClassBody.parse(request.body);
    await service.updateClass(fastify.pg, parsed.data.classId, data);
    return reply.code(204).send();
  });

  fastify.delete('/:id/classes/:classId', async (request, reply) => {
    const parsed = UuidClassParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    await service.deleteClass(fastify.pg, parsed.data.classId);
    return reply.code(204).send();
  });

  fastify.post('/:id/properties', async (request, reply) => {
    const parsed = UuidParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed schema id');

    const data = AddPropertyBody.parse(request.body);
    const created = await service.addProperty(fastify.pg, parsed.data.id, data);
    return reply.code(201).send(created);
  });

  fastify.patch('/:id/properties/:propId', async (request, reply) => {
    const parsed = UuidPropParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    const data = UpdatePropertyBody.parse(request.body);
    await service.updateProperty(fastify.pg, parsed.data.propId, data);
    return reply.code(204).send();
  });

  fastify.delete('/:id/properties/:propId', async (request, reply) => {
    const parsed = UuidPropParam.safeParse(request.params);
    if (!parsed.success) return reply.badRequest('Malformed id');

    await service.deleteProperty(fastify.pg, parsed.data.propId);
    return reply.code(204).send();
  });
};

export default schemasRoutes;
