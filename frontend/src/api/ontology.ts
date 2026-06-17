import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client.js';

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
  classes: OntologyClass[];
  properties: OntologyProperty[];
}

export interface OntologySchemaSummary {
  id: string;
  url: string;
  title: string;
  description?: string;
  upperOntologyIri?: string;
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

/** Whether the server offers the full OWL DL (HermiT) consistency check. */
export async function getReasonerStatus(): Promise<{ enabled: boolean; reasoner: string }> {
  const { data } = await apiClient.get('/reason/status');
  return data;
}

/** Run a full OWL DL consistency check (SULO + user OWL via HermiT) on the server. */
export async function reasonOntologyServer(turtle: string): Promise<ConsistencyReport> {
  const { data } = await apiClient.post('/reason', { turtle });
  return data;
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

export function useOntologySchemas() {
  return useQuery<OntologySchemaSummary[]>({
    queryKey: ['ontology-schemas'],
    queryFn: () => apiClient.get('/ontology-schemas').then((r) => r.data),
  });
}

export function useOntologySchema(id: string) {
  return useQuery<OntologySchema>({
    queryKey: ['ontology-schema', id],
    queryFn: () => apiClient.get(`/ontology-schemas/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateOntologySchema() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { title: string; description?: string; upperOntologyIri?: string }) =>
      apiClient.post('/ontology-schemas', data).then((r) => r.data as OntologySchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ontology-schemas'] }),
  });
}

export function useUpdateOntologySchema(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { title?: string; description?: string; upperOntologyIri?: string }) =>
      apiClient.patch(`/ontology-schemas/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ontology-schema', id] });
      qc.invalidateQueries({ queryKey: ['ontology-schemas'] });
    },
  });
}

export function useDeleteOntologySchema() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/ontology-schemas/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ontology-schemas'] }),
  });
}

export interface UpperConcept {
  iri: string;
  localName: string;
  type: 'class' | 'property';
  label?: string;
  comment?: string;
}

export function useUpperConcepts(schemaId: string, enabled: boolean) {
  return useQuery<UpperConcept[]>({
    queryKey: ['upper-concepts', schemaId],
    queryFn: () => apiClient.get(`/ontology-schemas/${schemaId}/upper-concepts`).then((r) => r.data),
    enabled: enabled && !!schemaId,
    staleTime: 5 * 60 * 1000, // cache for 5 min — the upper ontology rarely changes
  });
}

export function useAddOntologyClass(schemaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; label?: string; description?: string; mapsToConceptIri?: string; superClassId?: string }) =>
      apiClient.post(`/ontology-schemas/${schemaId}/classes`, data).then((r) => r.data as OntologyClass),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ontology-schema', schemaId] }),
  });
}

export function useUpdateOntologyClass(schemaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ classId, data }: {
      classId: string;
      data: { name?: string; label?: string; description?: string; mapsToConceptIri?: string; superClassId?: string };
    }) => apiClient.patch(`/ontology-schemas/${schemaId}/classes/${classId}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ontology-schema', schemaId] }),
  });
}

export function useDeleteOntologyClass(schemaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (classId: string) => apiClient.delete(`/ontology-schemas/${schemaId}/classes/${classId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ontology-schema', schemaId] }),
  });
}

export function useAddOntologyProperty(schemaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      label?: string;
      description?: string;
      propertyType: 'object' | 'datatype';
      domainClassId?: string;
      rangeClassIri?: string;
      mappingPattern?: TripleTemplate[];
      regexPattern?: string;
      regexVariable?: string;
      isRequired: boolean;
      propertyFeatures?: PropertyFeature[];
      inversePropertyIri?: string;
      disjointPropertyIris?: string[];
    }) => apiClient.post(`/ontology-schemas/${schemaId}/properties`, data).then((r) => r.data as OntologyProperty),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ontology-schema', schemaId] }),
  });
}

export function useUpdateOntologyProperty(schemaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ propId, data }: {
      propId: string;
      data: {
        name?: string; label?: string; description?: string;
        propertyType?: 'object' | 'datatype'; domainClassId?: string;
        rangeClassIri?: string; mappingPattern?: TripleTemplate[];
        regexPattern?: string; regexVariable?: string; isRequired?: boolean;
        propertyFeatures?: PropertyFeature[]; inversePropertyIri?: string; disjointPropertyIris?: string[];
      };
    }) => apiClient.patch(`/ontology-schemas/${schemaId}/properties/${propId}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ontology-schema', schemaId] }),
  });
}

export function useDeleteOntologyProperty(schemaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (propId: string) => apiClient.delete(`/ontology-schemas/${schemaId}/properties/${propId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ontology-schema', schemaId] }),
  });
}
