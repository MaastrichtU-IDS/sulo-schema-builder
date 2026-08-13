import fp from 'fastify-plugin';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../db/connection.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
  }
}

export default fp(async (fastify) => {
  const db = openDatabase();

  fastify.decorate('db', db);
  fastify.addHook('onClose', (instance, done) => {
    instance.db.close();
    done();
  });

  fastify.log.info(`SQLite database opened at ${db.name}`);
});
