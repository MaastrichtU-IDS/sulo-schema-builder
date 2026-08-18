// GET /app-config — tells the SPA (one build for every deployment) which
// storage backend to use: 'server' keeps the REST/SQLite data layer (desktop,
// local dev), 'browser' means schemas live in the visitor's IndexedDB and the
// CRUD routes are not even registered (web deployment).

import type { FastifyPluginAsync } from 'fastify';
import { config } from '../../config.js';

const appConfigRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/app-config', async () => ({
    storage: config.storage === 'browser' ? 'browser' : 'server',
  }));
};

export default appConfigRoute;
