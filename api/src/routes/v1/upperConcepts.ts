// GET /upper-concepts?iri=… — stateless upper-ontology proxy.
//
// Exists because a browser cannot dereference most ontology IRIs itself:
// w3id.org redirects, OBO PURLs etc. rarely send CORS headers. The server
// fetches the given IRI on the caller's behalf and returns its upper
// concepts; the caller passes the IRI explicitly rather than the server
// reading it from a schema row.
//
// The two endpoints that make this server fetch a caller-influenced URL — this
// one and the schema-scoped GET /ontology-schemas/:id/upper-concepts — share a
// single guarded implementation, rdf/guardedUpperConcepts.ts, which is where the
// SSRF, size-cap and caching rules are documented. This route only translates
// its result into HTTP and adds a per-route rate limit; the schema-scoped route
// carries the same limit.
//
// Authenticated in postgres mode (design §5): making this server dereference an
// arbitrary remote IRI is a privilege, not a public utility, even behind
// safeFetch — an anonymous visitor would otherwise get a free SSRF-shaped probe
// and a share of the fetch budget. In the packaged desktop mode the guard is the
// no-op from plugins/authDisabled.ts, which is what keeps this line unconditional.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../../config/index.js';
import { guardedUpperConcepts, UPPER_CONCEPTS_RATE_LIMIT } from '../../rdf/guardedUpperConcepts.js';
import { checkQuota, recordUsage, UPPER_CONCEPTS_FETCH } from '../../modules/quota/service.js';

const Query = z.object({ iri: z.string().min(1).max(2048) });

const upperConceptsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/upper-concepts', {
    preHandler: fastify.authRequired,
    config: { rateLimit: UPPER_CONCEPTS_RATE_LIMIT },
  }, async (request, reply) => {
    const { iri } = Query.parse(request.query);

    // Quota only exists in postgres mode: `request.user` is always null in
    // sqlite mode (plugins/authDisabled.ts's no-op authRequired), where
    // there is no users table to charge and this route's guard is already
    // the no-op that keeps the desktop path exactly as it was.
    if (config.storage === 'postgres' && request.user) {
      const quota = await checkQuota(fastify.pg, request.user, UPPER_CONCEPTS_FETCH);
      if (!quota.allowed) {
        return reply.code(429).send({ error: 'quota_exceeded', message: quota.reason, retryAfter: quota.retryAfterSeconds });
      }
    }

    const result = await guardedUpperConcepts(iri);
    if (result.ok) {
      if (config.storage === 'postgres' && request.user && !result.cacheHit) {
        await recordUsage(fastify.pg, {
          userId: request.user.id, kind: UPPER_CONCEPTS_FETCH, schemaId: null, costMs: null, cacheHit: false,
        });
      }
      return result.concepts;
    }

    if (result.reason === 'too_large') {
      return reply.code(422).send({ error: 'ontology_too_large', message: result.message });
    }
    return reply.code(400).send({ error: 'iri_not_allowed', message: result.message });
  });
};

export default upperConceptsRoute;
