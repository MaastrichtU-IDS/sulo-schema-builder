// Every schema CRUD call goes through here to the REST API. There is exactly
// one storage backend: the server. (Browser/IndexedDB storage was removed —
// see docs/superpowers/specs/2026-08-19-multi-user-backend-design.md.)

import { apiClient } from './client.js';
import type {
  OntologyClass,
  OntologyProperty,
  OntologySchema,
  OntologySchemaSummary,
  UpperConcept,
} from './ontology.js';

export type ClassInput = {
  name: string; label?: string; description?: string;
  mapsToConceptIri?: string; superClassId?: string;
};
export type ClassPatch = Partial<ClassInput>;

export type PropertyInput = {
  name: string;
  label?: string;
  description?: string;
  propertyType: 'object' | 'datatype';
  domainClassId?: string;
  rangeClassIri?: string;
  mappingPattern?: { subject: string; predicate: string; object: string }[];
  regexPattern?: string;
  regexVariable?: string;
  isRequired?: boolean;
  propertyFeatures?: string[];
  inversePropertyIri?: string;
  disjointPropertyIris?: string[];
};
export type PropertyPatch = Partial<PropertyInput>;

export type SchemaScope = 'mine' | 'shared' | 'public';

/**
 * `scope` is only meaningful against the Postgres (web) backend — see the
 * module comment in api/src/modules/schemas/routes.ts. Omitting it (the
 * desktop/SQLite path, which ignores the parameter entirely) preserves the
 * exact call shape the existing test asserts: `get('/ontology-schemas')`
 * with no second argument.
 */
export async function listSchemas(scope?: SchemaScope): Promise<OntologySchemaSummary[]> {
  const request = scope
    ? apiClient.get('/ontology-schemas', { params: { scope } })
    : apiClient.get('/ontology-schemas');
  return request.then((r) => r.data);
}

export async function getSchema(id: string): Promise<OntologySchema> {
  return apiClient.get(`/ontology-schemas/${id}`).then((r) => r.data);
}

export async function createSchema(data: {
  title: string; description?: string; upperOntologyIri?: string; baseUri?: string;
}): Promise<OntologySchema> {
  return apiClient.post('/ontology-schemas', data).then((r) => r.data);
}

export async function updateSchema(id: string, data: {
  title?: string; description?: string; upperOntologyIri?: string; baseUri?: string;
  /** Accepted by the server only from a caller at `own` — see ShareDialog. */
  visibility?: 'private' | 'unlisted' | 'public';
}): Promise<void> {
  await apiClient.patch(`/ontology-schemas/${id}`, data);
}

export async function deleteSchema(id: string): Promise<void> {
  await apiClient.delete(`/ontology-schemas/${id}`);
}

export async function addClass(schemaId: string, data: ClassInput): Promise<OntologyClass> {
  return apiClient.post(`/ontology-schemas/${schemaId}/classes`, data).then((r) => r.data);
}

export async function updateClass(schemaId: string, classId: string, data: ClassPatch): Promise<void> {
  await apiClient.patch(`/ontology-schemas/${schemaId}/classes/${classId}`, data);
}

export async function deleteClass(schemaId: string, classId: string): Promise<void> {
  await apiClient.delete(`/ontology-schemas/${schemaId}/classes/${classId}`);
}

export async function addProperty(schemaId: string, data: PropertyInput): Promise<OntologyProperty> {
  return apiClient.post(`/ontology-schemas/${schemaId}/properties`, data).then((r) => r.data);
}

export async function updateProperty(schemaId: string, propId: string, data: PropertyPatch): Promise<void> {
  await apiClient.patch(`/ontology-schemas/${schemaId}/properties/${propId}`, data);
}

export async function deleteProperty(schemaId: string, propId: string): Promise<void> {
  await apiClient.delete(`/ontology-schemas/${schemaId}/properties/${propId}`);
}

export async function fetchUpperConcepts(schemaId: string): Promise<UpperConcept[]> {
  return apiClient.get(`/ontology-schemas/${schemaId}/upper-concepts`).then((r) => r.data);
}
