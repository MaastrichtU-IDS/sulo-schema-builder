// Shared "GET an ontology IRI and parse it" step.
//
// Both the upper-concept autocomplete (modules/schemas/routes.ts, and the
// frozen legacy/sqlite path) and the SULO update check
// (services/sulo.service.ts) dereference the same kind of IRI in the same way,
// so the fetch, content-type sniffing and N3 parse live here rather than being
// written twice with slightly different failure handling.
//
// Every failure — unreachable host, non-2xx, unparseable body — collapses to
// null. Callers treat a failed fetch as "no new information", never as an
// error worth surfacing: this runs on a desktop app that is routinely offline.

import { Parser as N3Parser } from 'n3';
import type { Quad } from 'n3';

export interface OntologyDocument {
  text: string;
  quads: Quad[];
}

export function parseOntology(text: string, format = 'Turtle'): OntologyDocument | null {
  try {
    return { text, quads: new N3Parser({ format }).parse(text) };
  } catch {
    return null;
  }
}

export async function fetchOntologyDocument(
  iri: string,
  timeoutMs = 10_000,
): Promise<OntologyDocument | null> {
  let text: string;
  let format: string;

  try {
    const res = await fetch(iri, {
      headers: { Accept: 'text/turtle;q=1, application/n-triples;q=0.9, text/n3;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    text = await res.text();
    const ct = res.headers.get('content-type') ?? '';
    format = ct.includes('n-triples') ? 'N-Triples'
           : ct.includes('n3')        ? 'N3'
           : 'Turtle';
  } catch {
    return null;
  }

  return parseOntology(text, format);
}
