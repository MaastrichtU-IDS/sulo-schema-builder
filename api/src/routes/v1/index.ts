import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config/index.js';
import healthRoute from './health.js';
import authConfigRoute from './authConfig.js';
import upperConceptsRoute from './upperConcepts.js';
import reasonRoutes from './reason.js';
import schemasRoutes from '../../modules/schemas/routes.js';
import grantsRoutes, { userLookupRoutes } from '../../modules/acl/grants.routes.js';
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
  // expose the same paths and payloads for the routes the frontend has always
  // had, so it cannot tell them apart.
  //
  // Sharing is the one thing only the Postgres mode can offer: the desktop app
  // is single-user, loopback-bound and has no `users` table to grant to. The
  // grants routes are a sibling of the schema routes under the SAME prefix, so
  // `:id` stays the parameter requireAccess resolves — and, being a sibling,
  // they register `aclGuards` themselves (see the header of grants.routes.ts).
  if (config.storage === 'postgres') {
    await fastify.register(schemasRoutes, { prefix: '/ontology-schemas' });
    await fastify.register(grantsRoutes, { prefix: '/ontology-schemas' });
    // Names no schema, so it is guarded by a session and its own rate limit
    // rather than by the ACL. Its privacy posture is argued in full at the top
    // of grants.routes.ts — read that before touching it.
    await fastify.register(userLookupRoutes, { prefix: '/users' });
  } else {
    await fastify.register(legacySqliteRoutes, { prefix: '/ontology-schemas' });
  }
  await fastify.register(reasonRoutes, { prefix: '/reason' });
};

export default v1Routes;
