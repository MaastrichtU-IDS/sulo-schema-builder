import type { FastifyPluginAsync } from 'fastify';
import healthRoute from './health.js';
import ontologyRoutes from './ontology.js';

const v1Routes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(healthRoute);
  await fastify.register(ontologyRoutes, { prefix: '/ontology-schemas' });
};

export default v1Routes;
