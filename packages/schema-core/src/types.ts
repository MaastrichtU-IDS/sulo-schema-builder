// ─── Types ────────────────────────────────────────────────────────────────────

export interface OntologyClass {
  id: string;
  url: string;
  name: string;
  label?: string;
  description?: string;
  mapsToConceptIri?: string;
  superClassId?: string;
}

export interface TripleTemplate {
  subject: string;   // e.g. "?this", "?o1"
  predicate: string; // full predicate IRI
  object: string;    // e.g. "?value", "?o1", "?o2"
}

export type PropertyFeature =
  | 'functional' | 'inverseFunctional'
  | 'transitive' | 'symmetric' | 'asymmetric'
  | 'reflexive'  | 'irreflexive';

export interface OntologyProperty {
  id: string;
  url: string;
  name: string;
  label?: string;
  description?: string;
  propertyType: 'object' | 'datatype';
  domainClassId?: string;
  rangeClassIri?: string;
  mappingPattern: TripleTemplate[];
  regexPattern?: string;
  regexVariable?: string;
  isRequired: boolean;
  propertyFeatures: PropertyFeature[];
  inversePropertyIri?: string;
  disjointPropertyIris: string[];
}

/**
 * Absent on the SQLite (desktop) storage path, which has no `users` table and
 * so no sharing at all — see api/src/routes/v1/index.ts. Present whenever the
 * Postgres web deployment answers (api/src/modules/schemas/mappers.ts), which
 * is what lets the frontend's ShareDialog treat "no visibility on this
 * schema" as "there is nothing to share here" rather than defaulting silently.
 */
export type SchemaVisibility = 'private' | 'unlisted' | 'public';

export interface OntologySchema {
  id: string;
  url: string;
  title: string;
  description?: string;
  upperOntologyIri?: string;
  /** Overrides `url` as the namespace all classes/properties are minted under, when set. */
  baseUri?: string;
  visibility?: SchemaVisibility;
  classes: OntologyClass[];
  properties: OntologyProperty[];
}

export interface OntologySchemaSummary {
  id: string;
  url: string;
  title: string;
  description?: string;
  upperOntologyIri?: string;
  baseUri?: string;
  visibility?: SchemaVisibility;
}

// ─── Server-side full OWL DL reasoning ──────────────────────────────────────────

export interface ServerClash {
  kind: 'unsatisfiable-class' | 'inconsistent-ontology';
  iri?: string;
  label?: string;
  explanation: string;
}

export interface ConsistencyReport {
  consistent: boolean;
  reasoner: string;
  clashes: ServerClash[];
}
