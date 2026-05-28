import Fastify from 'fastify';
import { config } from './config.js';

// Plugins
import corsPlugin from './plugins/cors.js';
import helmetPlugin from './plugins/helmet.js';
import sensiblePlugin from './plugins/sensible.js';
import sparqlClientPlugin from './plugins/sparqlClient.js';

// Routes
import v1Routes from './routes/v1/index.js';
import sparqlProxyRoute from './routes/sparqlProxy.js';

export async function createServer() {
  const server = Fastify({
    logger: {
      level: config.logLevel,
      ...(config.env === 'development' && {
        transport: { target: 'pino-pretty' },
      }),
    },
  });

  await server.register(corsPlugin);
  await server.register(helmetPlugin);
  await server.register(sensiblePlugin);
  await server.register(sparqlClientPlugin);

  await server.register(v1Routes, { prefix: '/api/v1' });
  await server.register(sparqlProxyRoute, { prefix: '/sparql' });

  return server;
}
