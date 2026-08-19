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

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { guardedUpperConcepts, UPPER_CONCEPTS_RATE_LIMIT } from '../../rdf/guardedUpperConcepts.js';

const Query = z.object({ iri: z.string().min(1).max(2048) });

const upperConceptsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/upper-concepts', {
    config: { rateLimit: UPPER_CONCEPTS_RATE_LIMIT },
  }, async (request, reply) => {
    const { iri } = Query.parse(request.query);

    const result = await guardedUpperConcepts(iri);
    if (result.ok) return result.concepts;

    if (result.reason === 'too_large') {
      return reply.code(422).send({ error: 'ontology_too_large', message: result.message });
    }
    return reply.code(400).send({ error: 'iri_not_allowed', message: result.message });
  });
};

export default upperConceptsRoute;
