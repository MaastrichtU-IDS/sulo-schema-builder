import fp from 'fastify-plugin';
import type { Kysely } from 'kysely';
import { createKysely } from '../db/pg.js';
import type { DB } from '../db/types.js';
import { config } from '../config/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    pg: Kysely<DB>;
  }
}

export default fp(async (fastify) => {
  const { db } = createKysely(config.postgres.url, config.postgres.poolMax);
  fastify.decorate('pg', db);

  fastify.addHook('onClose', async () => {
    await db.destroy();
  });

  fastify.log.info('Postgres pool opened');
});
