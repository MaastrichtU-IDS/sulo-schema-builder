import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config/index.js';
import healthRoute from './health.js';
import authConfigRoute from './authConfig.js';
import upperConceptsRoute from './upperConcepts.js';
import reasonRoutes from './reason.js';
import schemasRoutes from '../../modules/schemas/routes.js';
import legacySqliteRoutes from '../../legacy/sqlite/ontology.routes.js';

const v1Routes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(healthRoute);
  // Before every guarded route below, and unguarded itself: this is how a
  // client discovers whether it has to authenticate at all, so requiring a
  // token here would make logging in impossible.
  await fastify.register(authConfigRoute);
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
