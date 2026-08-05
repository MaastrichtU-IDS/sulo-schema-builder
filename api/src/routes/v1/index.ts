import type { FastifyPluginAsync } from 'fastify';
import healthRoute from './health.js';
import ontologyRoutes from './ontology.js';
import reasonRoutes from './reason.js';
import matchingRoutes from './matching.js';

const v1Routes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(healthRoute);
  await fastify.register(ontologyRoutes, { prefix: '/ontology-schemas' });
  await fastify.register(reasonRoutes, { prefix: '/reason' });
  await fastify.register(matchingRoutes, { prefix: '/matching' });
};

export default v1Routes;
