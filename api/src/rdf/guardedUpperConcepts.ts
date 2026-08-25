// The one code path by which a caller can make this server dereference a
// remote IRI, and therefore the only place that dereference is allowed to
// happen in the multi-user web deployment.
//
// There is no authentication yet, so both routes that reach this helper are
// effectively anonymous:
//   * GET /api/v1/upper-concepts?iri=…            (routes/v1/upperConcepts.ts)
//   * GET /api/v1/ontology-schemas/:id/upper-concepts
//     (modules/schemas/routes.ts — the IRI comes from the schema row, but an
//     anonymous caller can create that row, so it is attacker-controlled too)
// Both are consequently held to the same rules, which is the entire reason this
// module exists instead of each route doing its own fetch:
//   - SULO itself is answered from the bundled/cached copy — no network at all
//   - everything else goes through safeFetchText: http(s) only, ports 80/443
//     only, no URL credentials, and a DNS lookup wired into the connecting
//     socket that drops every private/reserved address on every redirect hop
//     (see rdf/safeFetch.ts)
//   - the body is read incrementally and abandoned past safeFetchText's byte
//     cap, so a multi-GB URL cannot be buffered into memory before parsing
//   - results are cached for a few minutes so a classroom pointing at the same
//     upper ontology does not hammer the remote host through us
//
// The unguarded sibling, rdf/upperConcepts.ts#fetchUpperConcepts, is reserved
// for the frozen single-user desktop path (legacy/sqlite/) where the operator
// and the caller are the same person.
//
// Failures are returned, not thrown, so each route can map them onto its own
// error vocabulary (@fastify/sensible in the schemas module, an explicit
// `{ error, message }` body on the standalone proxy).

import { readFile } from 'node:fs/promises';
import { config } from '../config/index.js';
import { parseOntology } from './fetchOntology.js';
import { publicUrlProblem, ResponseTooLargeError, safeFetchText } from './safeFetch.js';
import { extractUpperConcepts, type UpperConcept } from './upperConcepts.js';
import { resolveSuloPath } from '../services/sulo.service.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
const cache = new Map<string, { at: number; concepts: UpperConcept[] }>();

const ACCEPT = 'text/turtle;q=1, application/n-triples;q=0.9, text/n3;q=0.8';

/**
 * Per-route budget shared by both callers: a remote fetch is orders of magnitude
 * more expensive than any other endpoint, so the two routes that can trigger one
 * spend from the same allowance shape. Enforced whenever
 * config.rateLimitEnabled registers @fastify/rate-limit.
 */
export const UPPER_CONCEPTS_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

export type GuardedUpperConceptsResult =
  /**
   * `cacheHit` distinguishes "answered from the in-memory cache or the
   * bundled SULO copy" (no remote fetch happened) from "just fetched over
   * the network" — modules/schemas/routes.ts and routes/v1/upperConcepts.ts
   * use it to decide whether this call actually spent any of the caller's
   * `upperFetchPerHour` quota (spec §6: a cached response must not).
   */
  | { ok: true; concepts: UpperConcept[]; cacheHit: boolean }
  /** The IRI violated the fetch policy — a 400 for both callers. */
  | { ok: false; reason: 'not_allowed'; message: string }
  /** The document was fetchable but too big to parse — a 422 for both callers. */
  | { ok: false; reason: 'too_large'; message: string };

function normalizeIri(iri: string): string {
  return iri.replace(/\/+$/, '');
}

async function bundledSuloConcepts(): Promise<UpperConcept[]> {
  const text = await readFile(resolveSuloPath(), 'utf8');
  const doc = parseOntology(text);
  return doc ? extractUpperConcepts(doc.quads) : [];
}

/**
 * Dereference `iri` under the SSRF/size policy above and extract its upper
 * concepts. Never throws for a caller-supplied IRI; ordinary network failures
 * (unreachable, non-2xx, unparseable) yield an empty concept list, matching
 * fetchOntologyDocument's "no new information" convention.
 */
export async function guardedUpperConcepts(iri: string): Promise<GuardedUpperConceptsResult> {
  const problem = publicUrlProblem(iri);
  if (problem) return { ok: false, reason: 'not_allowed', message: problem };

  // SULO is bundled with the server — never fetched on a caller's behalf.
  if (normalizeIri(iri) === normalizeIri(config.reasoner.suloUrl)) {
    return { ok: true, concepts: await bundledSuloConcepts(), cacheHit: true };
  }

  const cached = cache.get(iri);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ok: true, concepts: cached.concepts, cacheHit: true };
  }

  let concepts: UpperConcept[] = [];
  try {
    const res = await safeFetchText(iri, { accept: ACCEPT });
    if (res) {
      const format = res.contentType.includes('n-triples') ? 'N-Triples'
                   : res.contentType.includes('n3')        ? 'N3'
                   : 'Turtle';
      const doc = parseOntology(res.text, format);
      concepts = doc ? extractUpperConcepts(doc.quads) : [];
    }
  } catch (err) {
    if (err instanceof ResponseTooLargeError) {
      return {
        ok: false,
        reason: 'too_large',
        message: 'That ontology document is too large to process.',
      };
    }
    return {
      ok: false,
      reason: 'not_allowed',
      message: err instanceof Error ? err.message : 'The IRI could not be fetched.',
    };
  }

  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(iri, { at: Date.now(), concepts });
  return { ok: true, concepts, cacheHit: false };
}

/** Test seam: the module-level cache would otherwise leak between suites. */
export function clearUpperConceptsCache(): void {
  cache.clear();
}
