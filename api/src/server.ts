import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { config } from './config/index.js';

// Plugins
import corsPlugin from './plugins/cors.js';
import helmetPlugin from './plugins/helmet.js';
import sensiblePlugin from './plugins/sensible.js';
import errorHandlerPlugin from './plugins/errorHandler.js';
import sqlitePlugin from './legacy/sqlite/plugin.js';
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
  // After sensible (it uses reply.badRequest) and before any route, so both
  // storage modes and the reason routes share it.
  await server.register(errorHandlerPlugin);
  // Whichever database the selected storage mode needs, and only that one:
  // the SQLite plugin opens a file, the Postgres plugin opens a pool.
  //
  // The Postgres plugin is loaded lazily, and the asymmetry is deliberate.
  // `kysely` cannot be snapshotted by pkg (its top-level-await modules fall
  // back to source, and their relative imports then fail to resolve inside
  // /snapshot), so a static import of plugins/pg.js crashes the packaged
  // desktop binary at startup — even though `storage` is forced to 'sqlite'
  // there and the pool is never opened. The reverse trick is not available:
  // pkg's snapshot cannot execute `import()` at all
  // (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING), so the branch the desktop build
  // *does* take has to be a static import.
  if (config.storage === 'postgres') {
    const { default: pgPlugin } = await import('./plugins/pg.js');
    await server.register(pgPlugin);
  } else {
    await server.register(sqlitePlugin);
  }
  await server.register(staticFilesPlugin);

  if (config.rateLimitEnabled) {
    // Per-IP limits, with stricter per-route settings on the expensive
    // endpoints (reason, upper-concepts).
    await server.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  }

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
