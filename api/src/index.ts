import { config } from './config.js';
import { createServer } from './server.js';

const server = await createServer();

try {
  await server.listen({ port: config.port, host: '0.0.0.0' });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
