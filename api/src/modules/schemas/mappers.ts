// Row → API shape. The IRIs minted here are embedded in exports and stored
// verbatim in cross-references (rangeClassIri, mapping patterns), so they must
// stay byte-identical to the values the SQLite path produced.

import { PREFIXES } from '../../rdf/prefixes.js';
import type { ClassRow, PropertyRow, SchemaRow } from '../../db/types.js';

const SHEXR = PREFIXES.suloschemaR;

export const schemaIri = (id: string) => `${SHEXR}ontology-schema/${id}`;
export const classIri = (id: string) => `${SHEXR}ontology-class/${id}`;
export const propIri = (id: string) => `${SHEXR}ontology-prop/${id}`;

export function normalizeBaseUri(uri: string): string {
  return /[/#]$/.test(uri) ? uri : `${uri}/`;
}

// row.owner_id is deliberately not exposed here: an anonymous reader of a
// public schema has no business learning the owner's internal user id, and
// nothing on the frontend needs it (the ACL guard already answers "can I
// write this", which is what owner_id would otherwise be a proxy for).
export function schemaRowToSummary(row: SchemaRow) {
  return {
    id: row.id,
    url: schemaIri(row.id),
    title: row.title,
    description: row.description ?? undefined,
    upperOntologyIri: row.upper_ontology_iri ?? undefined,
    baseUri: row.base_uri ?? undefined,
    visibility: row.visibility,
  };
}

export function classRowToApi(row: ClassRow) {
  return {
    id: row.id,
    url: classIri(row.id),
    name: row.name,
    label: row.label ?? undefined,
    description: row.description ?? undefined,
    mapsToConceptIri: row.maps_to_concept_iri ?? undefined,
    superClassId: row.super_class_id ?? undefined,
  };
}

export function propertyRowToApi(row: PropertyRow) {
  return {
    id: row.id,
    url: propIri(row.id),
    name: row.name,
    label: row.label ?? undefined,
    description: row.description ?? undefined,
    propertyType: row.property_type,
    domainClassId: row.domain_class_id ?? undefined,
    rangeClassIri: row.range_class_iri ?? undefined,
    mappingPattern: row.mapping_pattern ?? [],
    regexPattern: row.regex_pattern ?? undefined,
    regexVariable: row.regex_variable ?? undefined,
    isRequired: row.is_required,
    propertyFeatures: row.property_features ?? [],
    inversePropertyIri: row.inverse_property_iri ?? undefined,
    disjointPropertyIris: row.disjoint_property_iris ?? [],
  };
}
