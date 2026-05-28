import fp from 'fastify-plugin';
import { SimpleClient } from 'sparql-http-client';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    sparql: SimpleClient;
  }
}

export default fp(async (fastify) => {
  const client = new SimpleClient({
    endpointUrl: config.qlever.sparqlUrl,
    updateUrl: config.qlever.updateUrl,
    headers: {
      'Authorization': `Bearer ${config.qlever.accessToken}`,
    }
  });


  fastify.decorate('sparql', client);

  fastify.log.info(`SPARQL client connected to ${config.qlever.sparqlUrl}`);
});
