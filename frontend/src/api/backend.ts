// Storage dispatch: every schema CRUD call goes through here and lands either
// on the REST API (server mode — desktop/dev, SQLite behind Fastify) or on the
// in-browser store (browser mode — IndexedDB, see localStore.ts). The
// react-query hooks in ontology.ts are backend-agnostic.

import { apiClient } from './client.js';
import { getStorageMode } from './appConfig.js';
import * as local from './localStore.js';
import type {
  OntologyClass,
  OntologyProperty,
  OntologySchema,
  OntologySchemaSummary,
  UpperConcept,
} from './ontology.js';

type ClassInput = {
  name: string; label?: string; description?: string;
  mapsToConceptIri?: string; superClassId?: string;
};
type ClassPatch = Partial<ClassInput>;
export type PropertyInput = local.PropertyInput;
export type PropertyPatch = Partial<local.PropertyInput>;

async function isBrowser(): Promise<boolean> {
  return (await getStorageMode()) === 'browser';
}

export async function listSchemas(): Promise<OntologySchemaSummary[]> {
  if (await isBrowser()) return local.listSchemas();
  return apiClient.get('/ontology-schemas').then((r) => r.data);
}

export async function getSchema(id: string): Promise<OntologySchema> {
  if (await isBrowser()) return local.getSchema(id);
  return apiClient.get(`/ontology-schemas/${id}`).then((r) => r.data);
}

export async function createSchema(data: {
  title: string; description?: string; upperOntologyIri?: string; baseUri?: string;
}): Promise<OntologySchema> {
  if (await isBrowser()) return local.createSchema(data);
  return apiClient.post('/ontology-schemas', data).then((r) => r.data);
}

export async function updateSchema(id: string, data: {
  title?: string; description?: string; upperOntologyIri?: string; baseUri?: string;
}): Promise<void> {
  if (await isBrowser()) return local.updateSchema(id, data);
  await apiClient.patch(`/ontology-schemas/${id}`, data);
}

export async function deleteSchema(id: string): Promise<void> {
  if (await isBrowser()) return local.deleteSchema(id);
  await apiClient.delete(`/ontology-schemas/${id}`);
}

export async function addClass(schemaId: string, data: ClassInput): Promise<OntologyClass> {
  if (await isBrowser()) return local.addClass(schemaId, data);
  return apiClient.post(`/ontology-schemas/${schemaId}/classes`, data).then((r) => r.data);
}

export async function updateClass(schemaId: string, classId: string, data: ClassPatch): Promise<void> {
  if (await isBrowser()) return local.updateClass(schemaId, classId, data);
  await apiClient.patch(`/ontology-schemas/${schemaId}/classes/${classId}`, data);
}

export async function deleteClass(schemaId: string, classId: string): Promise<void> {
  if (await isBrowser()) return local.deleteClass(schemaId, classId);
  await apiClient.delete(`/ontology-schemas/${schemaId}/classes/${classId}`);
}

export async function addProperty(schemaId: string, data: PropertyInput): Promise<OntologyProperty> {
  if (await isBrowser()) return local.addProperty(schemaId, data);
  return apiClient.post(`/ontology-schemas/${schemaId}/properties`, data).then((r) => r.data);
}

export async function updateProperty(schemaId: string, propId: string, data: PropertyPatch): Promise<void> {
  if (await isBrowser()) return local.updateProperty(schemaId, propId, data);
  await apiClient.patch(`/ontology-schemas/${schemaId}/properties/${propId}`, data);
}

export async function deleteProperty(schemaId: string, propId: string): Promise<void> {
  if (await isBrowser()) return local.deleteProperty(schemaId, propId);
  await apiClient.delete(`/ontology-schemas/${schemaId}/properties/${propId}`);
}

export async function fetchUpperConcepts(schemaId: string): Promise<UpperConcept[]> {
  if (await isBrowser()) {
    // The schema lives here, so pass its IRI to the stateless proxy — the
    // browser can't dereference most ontology IRIs itself (no CORS headers).
    const schema = await local.getSchema(schemaId);
    if (!schema.upperOntologyIri) return [];
    return apiClient
      .get('/upper-concepts', { params: { iri: schema.upperOntologyIri } })
      .then((r) => r.data);
  }
  return apiClient.get(`/ontology-schemas/${schemaId}/upper-concepts`).then((r) => r.data);
}
