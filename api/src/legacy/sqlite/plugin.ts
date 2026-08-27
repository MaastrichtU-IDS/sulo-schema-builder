import fp from 'fastify-plugin';
import type { Database } from 'better-sqlite3';
import { openDatabase } from './connection.js';
import { bindSettingsDb, unbindSettingsDb } from './settings.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
  }
}

export default fp(async (fastify) => {
  const db = openDatabase();

  fastify.decorate('db', db);
  // Services that run outside a request (java/sulo) read app settings through
  // this handle rather than threading a Database through every call site.
  bindSettingsDb(db);

  fastify.addHook('onClose', (instance, done) => {
    unbindSettingsDb();
    instance.db.close();
    done();
  });

  fastify.log.info(`SQLite database opened at ${db.name}`);
});
