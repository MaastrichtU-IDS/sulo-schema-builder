import type { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';

/**
 * Transparent proxy for SPARQL queries to QLever.
 * GET /sparql  — public read (SELECT, CONSTRUCT, ASK)
 * POST /sparql — update requires auth when AUTH_ENABLED=true
 */
const sparqlProxyRoute: FastifyPluginAsync = async (fastify) => {

  // Public SPARQL SELECT/CONSTRUCT/ASK
  fastify.get('/', async (request, reply) => {
    const qleverUrl = config.qlever.sparqlUrl;
    const queryString = new URLSearchParams(request.query as Record<string, string>).toString();
    const res = await fetch(`${qleverUrl}?${queryString}`, {
      headers: { Accept: request.headers['accept'] ?? 'application/sparql-results+json' },
    });
    reply.code(res.status);
    const body = await res.text();
    reply.header('Content-Type', res.headers.get('content-type') ?? 'application/json');
    return reply.send(body);
  });

  fastify.post('/', async (request, reply) => {
    const qleverUrl = config.qlever.updateUrl;
    const res = await fetch(qleverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': request.headers['content-type'] ?? 'application/sparql-update',
      },
      body: request.body as string,
    });
    reply.code(res.status);
    return reply.send(await res.text());
  });

};

export default sparqlProxyRoute;
