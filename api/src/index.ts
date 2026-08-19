import { config } from './config/index.js';
import { createServer } from './server.js';

const server = await createServer();

try {
  await server.listen({ port: config.port, host: config.host });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
