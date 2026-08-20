import type { FastifyInstance } from 'fastify';
import { config } from './config/index.js';
import { createServer } from './server.js';

let server: FastifyInstance;
try {
  server = await createServer();
} catch (err) {
  // No fastify instance exists yet to log through — createServer() can now
  // throw before one is built (plugins/auth.ts's boot-time JWKS pre-fetch, so
  // a misconfigured or unreachable identity provider fails loudly instead of
  // 401ing every request). console.error mirrors the precedent in
  // config/server.ts for the same "no logger exists this early" problem, and
  // still ends in the same process.exit(1) as the listen() failure below.
  console.error(err);
  process.exit(1);
}

try {
  await server.listen({ port: config.port, host: config.host });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
