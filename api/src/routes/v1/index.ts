import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config/index.js';
import healthRoute from './health.js';
import upperConceptsRoute from './upperConcepts.js';
import reasonRoutes from './reason.js';
import schemasRoutes from '../../modules/schemas/routes.js';
import legacySqliteRoutes from '../../legacy/sqlite/ontology.routes.js';

const v1Routes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(healthRoute);
  await fastify.register(upperConceptsRoute);
  // One storage mode is live per process: Postgres for the multi-user web
  // deployment, the frozen SQLite path for the packaged desktop app. Both
  // expose the same paths and payloads, so the frontend cannot tell them apart.
  await fastify.register(
    config.storage === 'postgres' ? schemasRoutes : legacySqliteRoutes,
    { prefix: '/ontology-schemas' },
  );
  await fastify.register(reasonRoutes, { prefix: '/reason' });
};

export default v1Routes;
