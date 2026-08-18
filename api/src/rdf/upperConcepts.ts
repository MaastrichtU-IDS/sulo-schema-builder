// Extracting the class/property list of an upper ontology from its quads.
// Shared by the schema-scoped route (sqlite storage; ontology.ts) and the
// stateless proxy route (browser storage; upperConcepts.ts).

import type { Quad } from 'n3';
import { fetchOntologyDocument } from './fetchOntology.js';

const OWL_CLASS     = 'http://www.w3.org/2002/07/owl#Class';
const RDFS_CLASS    = 'http://www.w3.org/2000/01/rdf-schema#Class';
const OWL_OBJ_PROP  = 'http://www.w3.org/2002/07/owl#ObjectProperty';
const OWL_DATA_PROP = 'http://www.w3.org/2002/07/owl#DatatypeProperty';
const RDF_PROPERTY  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#Property';
const RDF_TYPE      = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL    = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDFS_COMMENT  = 'http://www.w3.org/2000/01/rdf-schema#comment';

export interface UpperConcept {
  iri: string;
  localName: string;
  type: 'class' | 'property';
  label?: string;
  comment?: string;
}

export function extractUpperConcepts(quads: Quad[]): UpperConcept[] {
  const conceptTypes = new Map<string, 'class' | 'property'>();
  const labels       = new Map<string, string>();
  const comments     = new Map<string, string>();

  for (const quad of quads) {
    const s = quad.subject.termType === 'NamedNode' ? quad.subject.value : null;
    if (!s) continue;

    if (quad.predicate.value === RDF_TYPE) {
      const o = quad.object.value;
      if (o === OWL_CLASS || o === RDFS_CLASS) {
        if (!conceptTypes.has(s)) conceptTypes.set(s, 'class');
      } else if (o === OWL_OBJ_PROP || o === OWL_DATA_PROP || o === RDF_PROPERTY) {
        conceptTypes.set(s, 'property');
      }
    }
    if (quad.predicate.value === RDFS_LABEL) {
      if (!labels.has(s) || ('language' in quad.object && quad.object.language === 'en')) {
        labels.set(s, quad.object.value);
      }
    }
    if (quad.predicate.value === RDFS_COMMENT && !comments.has(s)) {
      comments.set(s, quad.object.value);
    }
  }

  return [...conceptTypes.entries()]
    .map(([iri, type]) => ({
      iri,
      type,
      localName: iri.split(/[/#]/).pop() ?? iri,
      label:   labels.get(iri),
      comment: comments.get(iri),
    }))
    .sort((a, b) => (a.label ?? a.localName).localeCompare(b.label ?? b.localName));
}

/** Dereference an upper-ontology IRI and extract its concepts (unguarded — desktop/dev path). */
export async function fetchUpperConcepts(ontologyIri: string): Promise<UpperConcept[]> {
  const doc = await fetchOntologyDocument(ontologyIri);
  if (!doc) return [];
  try {
    return extractUpperConcepts(doc.quads);
  } catch {
    return [];
  }
}
