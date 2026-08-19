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

export interface OntologySchema {
  id: string;
  url: string;
  title: string;
  description?: string;
  upperOntologyIri?: string;
  /** Overrides `url` as the namespace all classes/properties are minted under, when set. */
  baseUri?: string;
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
