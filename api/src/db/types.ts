import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface UsersTable {
  id: Generated<string>;
  subject: string;
  email: string | null;
  display_name: string | null;
  orcid: string | null;
  global_role: Generated<'user' | 'moderator' | 'admin'>;
  quota_tier: Generated<'free' | 'verified' | 'staff'>;
  created_at: Timestamp;
  last_seen_at: Timestamp | null;
}

export interface SchemasTable {
  id: Generated<string>;
  owner_id: string;
  title: string;
  description: string | null;
  upper_ontology_iri: string | null;
  base_uri: string | null;
  visibility: Generated<'private' | 'unlisted' | 'public'>;
  content_hash: string | null;
  latest_report_key: string | null;
  reason_state: Generated<'stale' | 'queued' | 'running' | 'fresh' | 'failed'>;
  created_at: Timestamp;
  modified_at: Timestamp;
}

export interface ClassesTable {
  id: Generated<string>;
  schema_id: string;
  name: string;
  label: string | null;
  description: string | null;
  maps_to_concept_iri: string | null;
  super_class_id: string | null;
}

export interface TripleTemplateJson {
  subject: string;
  predicate: string;
  object: string;
}

export interface PropertiesTable {
  id: Generated<string>;
  schema_id: string;
  name: string;
  label: string | null;
  description: string | null;
  property_type: Generated<'object' | 'datatype'>;
  domain_class_id: string | null;
  range_class_iri: string | null;
  mapping_pattern: ColumnType<TripleTemplateJson[] | null, string | null, string | null>;
  regex_pattern: string | null;
  regex_variable: string | null;
  is_required: Generated<boolean>;
  property_features: ColumnType<string[] | null, string | null, string | null>;
  inverse_property_iri: string | null;
  disjoint_property_iris: ColumnType<string[] | null, string | null, string | null>;
}

export interface SchemaGrantsTable {
  schema_id: string;
  grantee_id: string;
  role: 'viewer' | 'editor' | 'owner';
  granted_by: string | null;
  created_at: Timestamp;
}

export interface ReasoningReportsTable {
  cache_key: string;
  report: ColumnType<unknown, string, string>;
  reasoner: string;
  sulo_hash: string;
  duration_ms: number | null;
  created_at: Timestamp;
}

export interface ReasonJobsTable {
  id: Generated<number>;
  schema_id: string;
  requested_by: string | null;
  cache_key: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  attempts: Generated<number>;
  enqueued_at: Timestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
  error: string | null;
}

export interface UsageEventsTable {
  id: Generated<number>;
  user_id: string | null;
  kind: string;
  schema_id: string | null;
  cost_ms: number | null;
  cache_hit: Generated<boolean>;
  created_at: Timestamp;
}

export interface DB {
  users: UsersTable;
  schemas: SchemasTable;
  classes: ClassesTable;
  properties: PropertiesTable;
  schema_grants: SchemaGrantsTable;
  reasoning_reports: ReasoningReportsTable;
  reason_jobs: ReasonJobsTable;
  usage_events: UsageEventsTable;
}

export type SchemaRow = Selectable<SchemasTable>;
export type NewSchema = Insertable<SchemasTable>;
export type SchemaUpdate = Updateable<SchemasTable>;
export type ClassRow = Selectable<ClassesTable>;
export type NewClass = Insertable<ClassesTable>;
export type ClassUpdate = Updateable<ClassesTable>;
export type PropertyRow = Selectable<PropertiesTable>;
export type NewProperty = Insertable<PropertiesTable>;
export type PropertyUpdate = Updateable<PropertiesTable>;
