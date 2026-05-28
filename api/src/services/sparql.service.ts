import type { FastifyInstance } from 'fastify';
import { sparqlPrefixes } from '../rdf/prefixes.js';

type SparqlBinding = Record<string, { value: string; type: string; datatype?: string }>;

interface SparqlSelectResult {
  head: { vars: string[] };
  results: { bindings: SparqlBinding[] };
}

interface SparqlAskResult {
  boolean: boolean;
}

/**
 * Execute a SPARQL SELECT query and return bindings as plain objects.
 */
export async function sparqlSelect(
  fastify: FastifyInstance,
  query: string
): Promise<SparqlBinding[]> {
  const fullQuery = `${sparqlPrefixes()}\n${query}`;
  const res = await fastify.sparql.query.select(fullQuery, {
    headers: { Accept: 'application/sparql-results+json' },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SPARQL SELECT failed (${res.status}): ${body}`);
  }

  const data = await res.json() as SparqlSelectResult;
  return data.results.bindings;
}

/**
 * Execute a SPARQL UPDATE (INSERT/DELETE).
 *
 * sparql-http-client's SimpleClient.store is always null, so we use a direct
 * fetch POST to the QLever update endpoint. QLever requires a non-empty
 * access token passed as the `access-token` query parameter.
 */
export async function sparqlUpdate(
  fastify: FastifyInstance,
  update: string
): Promise<void> {
  const { config } = await import('../config.js');
  const fullUpdate = `${sparqlPrefixes()}\n${update}`;
  const client = fastify.sparql;

  const res = await client.postUrlencoded(fullUpdate, { update: true });

  if (res && typeof (res as Response).ok !== 'undefined' && !(res as Response).ok) {
    const body = await (res as Response).text();
    throw new Error(`SPARQL UPDATE failed (${(res as Response).status}): ${body}`);
  }
}

/**
 * Execute a SPARQL ASK query.
 */
export async function sparqlAsk(
  fastify: FastifyInstance,
  query: string
): Promise<boolean> {
  const fullQuery = `${sparqlPrefixes()}\n${query}`;
  const res = await fastify.sparql.query.ask(fullQuery, {
    headers: { Accept: 'application/sparql-results+json' },
  });

  if (!res.ok) {
    throw new Error(`SPARQL ASK failed (${res.status})`);
  }

  const data = await res.json() as SparqlAskResult;
  return data.boolean;
}
