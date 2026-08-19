// GET /upper-concepts?iri=… — stateless upper-ontology proxy.
//
// Exists because the browser cannot dereference most ontology IRIs itself:
// w3id.org redirects, OBO PURLs etc. rarely send CORS headers. The server
// fetches the given IRI on the caller's behalf and returns its upper
// concepts; the caller passes the IRI explicitly rather than the server
// reading it from a schema row.
//
// This is the one endpoint where an anonymous visitor makes the server fetch
// an arbitrary URL, so it is deliberately paranoid:
//  - SULO itself is answered from the bundled/cached copy — no network
//  - everything else goes through safeFetchText (public-address-only DNS
//    pinning, port allowlist, size cap; see rdf/safeFetch.ts)
//  - results are cached a few minutes so a classroom pointing at the same
//    upper ontology doesn't hammer the remote host through us
//  - per-IP rate limit (active when @fastify/rate-limit is registered)

import type { FastifyPluginAsync } from 'fastify';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { config } from '../../config/index.js';
import { parseOntology } from '../../rdf/fetchOntology.js';
import { safeFetchText, publicUrlProblem, ResponseTooLargeError } from '../../rdf/safeFetch.js';
import { extractUpperConcepts, type UpperConcept } from '../../rdf/upperConcepts.js';
import { resolveSuloPath } from '../../services/sulo.service.js';

const Query = z.object({ iri: z.string().min(1).max(2048) });

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
const cache = new Map<string, { at: number; concepts: UpperConcept[] }>();

function normalizeIri(iri: string): string {
  return iri.replace(/\/+$/, '');
}

async function bundledSuloConcepts(): Promise<UpperConcept[]> {
  const text = await readFile(resolveSuloPath(), 'utf8');
  const doc = parseOntology(text);
  return doc ? extractUpperConcepts(doc.quads) : [];
}

const upperConceptsRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get('/upper-concepts', {
    config: {
      // Enforced whenever config.rateLimitEnabled registers the plugin.
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  }, async (request, reply) => {
    const { iri } = Query.parse(request.query);

    const problem = publicUrlProblem(iri);
    if (problem) {
      return reply.code(400).send({ error: 'iri_not_allowed', message: problem });
    }

    // SULO is bundled with the server — never fetched on a visitor's behalf.
    if (normalizeIri(iri) === normalizeIri(config.reasoner.suloUrl)) {
      return bundledSuloConcepts();
    }

    const cached = cache.get(iri);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.concepts;

    let concepts: UpperConcept[] = [];
    try {
      const res = await safeFetchText(iri, {
        accept: 'text/turtle;q=1, application/n-triples;q=0.9, text/n3;q=0.8',
      });
      if (res) {
        const format = res.contentType.includes('n-triples') ? 'N-Triples'
                     : res.contentType.includes('n3')        ? 'N3'
                     : 'Turtle';
        const doc = parseOntology(res.text, format);
        concepts = doc ? extractUpperConcepts(doc.quads) : [];
      }
    } catch (err) {
      if (err instanceof ResponseTooLargeError) {
        return reply.code(422).send({ error: 'ontology_too_large', message: 'That ontology document is too large to process.' });
      }
      return reply.code(400).send({
        error: 'iri_not_allowed',
        message: err instanceof Error ? err.message : 'The IRI could not be fetched.',
      });
    }

    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(iri, { at: Date.now(), concepts });
    return concepts;
  });
};

export default upperConceptsRoute;
