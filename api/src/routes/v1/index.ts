import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config.js';
import healthRoute from './health.js';
import appConfigRoute from './appConfig.js';
import upperConceptsRoute from './upperConcepts.js';
import ontologyRoutes from './ontology.js';
import reasonRoutes from './reason.js';

const v1Routes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(healthRoute);
  await fastify.register(appConfigRoute);
  await fastify.register(upperConceptsRoute);
  // In browser storage mode schemas never touch the server — the CRUD surface
  // (and with it the shared, unauthenticated database) simply doesn't exist.
  if (config.storage === 'sqlite') {
    await fastify.register(ontologyRoutes, { prefix: '/ontology-schemas' });
  }
  await fastify.register(reasonRoutes, { prefix: '/reason' });
};

export default v1Routes;
