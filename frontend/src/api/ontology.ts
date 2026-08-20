import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client.js';
import * as backend from './backend.js';
import type {
  OntologyClass,
  TripleTemplate,
  PropertyFeature,
  OntologyProperty,
  OntologySchema,
  OntologySchemaSummary,
  ServerClash,
  ConsistencyReport,
} from '@sulo/schema-core';

// ─── Types ────────────────────────────────────────────────────────────────────

export type {
  OntologyClass,
  TripleTemplate,
  PropertyFeature,
  OntologyProperty,
  OntologySchema,
  OntologySchemaSummary,
  ServerClash,
  ConsistencyReport,
};

export interface JavaStatus {
  available: boolean;
  path?: string;
  /** Major version, e.g. 21. */
  version?: number;
  /** As the JVM reports it, e.g. "21.0.2". */
  versionString?: string;
  reason?: 'not_found' | 'too_old' | 'error';
  detail?: string;
}

export interface RobotStatus {
  state: 'missing' | 'downloading' | 'ready' | 'error';
  path?: string;
  received?: number;
  total?: number;
  error?: string;
  version: string;
}

export interface SuloStatus {
  version?: string;
  modified?: string;
  source: 'bundled' | 'downloaded' | 'override';
  path: string;
  checkedAt?: string;
  updateError?: string;
}

export interface ReasonerStatus {
  enabled: boolean;
  reasoner: string;
  /**
   * True only for the packaged desktop app, which finds a JVM and downloads
   * ROBOT itself. Docker and local dev get both from the environment, so
   * there is no setup UI to offer and the check button shows unconditionally.
   */
  managed: boolean;
  java: JavaStatus;
  robot: RobotStatus;
  sulo: SuloStatus;
}

/** Whether the server offers the full OWL DL (HermiT) consistency check. */
export async function getReasonerStatus(): Promise<ReasonerStatus> {
  const { data } = await apiClient.get('/reason/status');
  return data;
}

/** Point the app at an existing JVM. Rejects with a 400 if it isn't usable. */
export async function setJavaPath(path: string): Promise<ReasonerStatus> {
  const { data } = await apiClient.post('/reason/java-path', { path });
  return data;
}

/** Retry a failed or not-yet-started ROBOT download. */
export async function retryRobotDownload(): Promise<ReasonerStatus> {
  const { data } = await apiClient.post('/reason/robot/download');
  return data;
}

/** Run a full OWL DL consistency check (SULO + user OWL via HermiT) on the server. */
export async function reasonOntologyServer(turtle: string): Promise<ConsistencyReport> {
  const { data } = await apiClient.post('/reason', { turtle });
  return data;
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

/**
 * `enabled` lets a caller hold off fetching until it knows which scope to
 * ask for — e.g. the schema list page, which must not fire a `public`
 * request while auth status is still `loading` only to immediately refetch
 * once it resolves to `authenticated`.
 */
export function useOntologySchemas(scope?: backend.SchemaScope, enabled = true) {
  return useQuery<OntologySchemaSummary[]>({
    queryKey: ['ontology-schemas', scope ?? null],
    queryFn: () => backend.listSchemas(scope),
    enabled,
  });
}

export function useOntologySchema(id: string) {
  return useQuery<OntologySchema>({
    queryKey: ['ontology-schema', id],
    queryFn: () => backend.getSchema(id),
    enabled: !!id,
  });
}

export function useCreateOntologySchema() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { title: string; description?: string; upperOntologyIri?: string; baseUri?: string }) =>
      backend.createSchema(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ontology-schemas'] }),
  });
}

export function useUpdateOntologySchema(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      title?: string; description?: string; upperOntologyIri?: string; baseUri?: string;
      visibility?: 'private' | 'unlisted' | 'public';
    }) => backend.updateSchema(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ontology-schema', id] });
      qc.invalidateQueries({ queryKey: ['ontology-schemas'] });
    },
  });
}

export function useDeleteOntologySchema() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => backend.deleteSchema(id),
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
    queryFn: () => backend.fetchUpperConcepts(schemaId),
    enabled: enabled && !!schemaId,
    staleTime: 5 * 60 * 1000, // cache for 5 min — the upper ontology rarely changes
  });
}

export function useAddOntologyClass(schemaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; label?: string; description?: string; mapsToConceptIri?: string; superClassId?: string }) =>
      backend.addClass(schemaId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ontology-schema', schemaId] }),
  });
}

export function useUpdateOntologyClass(schemaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ classId, data }: {
      classId: string;
      data: { name?: string; label?: string; description?: string; mapsToConceptIri?: string; superClassId?: string };
    }) => backend.updateClass(schemaId, classId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ontology-schema', schemaId] }),
  });
}

export function useDeleteOntologyClass(schemaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (classId: string) => backend.deleteClass(schemaId, classId),
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
    }) => backend.addProperty(schemaId, data),
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
    }) => backend.updateProperty(schemaId, propId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ontology-schema', schemaId] }),
  });
}

export function useDeleteOntologyProperty(schemaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (propId: string) => backend.deleteProperty(schemaId, propId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ontology-schema', schemaId] }),
  });
}
