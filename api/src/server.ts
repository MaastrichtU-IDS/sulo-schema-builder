import Fastify from 'fastify';
import { config } from './config.js';

// Plugins
import corsPlugin from './plugins/cors.js';
import helmetPlugin from './plugins/helmet.js';
import sensiblePlugin from './plugins/sensible.js';
import dbPlugin from './plugins/db.js';
import staticFilesPlugin from './plugins/staticFiles.js';

// Routes
import v1Routes from './routes/v1/index.js';

// Background bootstrap
import { startRobotDownload } from './services/robot.service.js';
import { startSuloUpdateCheck } from './services/sulo.service.js';

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
  await server.register(dbPlugin);
  await server.register(staticFilesPlugin);

  await server.register(v1Routes, { prefix: '/api/v1' });

  // Packaged desktop builds fetch their own reasoning toolchain. Both of these
  // are deliberately not awaited: the app has to start (and be usable for
  // everything except the consistency check) with no network at all. Progress
  // and failures are reported through GET /api/v1/reason/status.
  if (config.isPackaged && config.reasoner.enabled) {
    startRobotDownload();
    startSuloUpdateCheck();
  }

  // Unmatched /api/* routes stay a JSON 404; everything else falls back to
  // the SPA's index.html so client-side routes (e.g. /ontology/:id) survive
  // a hard refresh.
  server.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found', message: `Route ${request.method}:${request.url} not found` });
    }
    return reply.sendFile('index.html');
  });

  return server;
}
