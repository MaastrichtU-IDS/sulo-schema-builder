// Orchestration over repo.ts: input normalisation, PATCH semantics ('' clears
// a field, absent leaves it), and assembling the full API response shape.

// INVARIANT: `import type` only for kysely here and in repo.ts — a value import
// breaks the packaged desktop binary. The reason is spelled out at the top of
// repo.ts.
import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.js';
import * as repo from './repo.js';
import { classRowToApi, normalizeBaseUri, propertyRowToApi, schemaIri, schemaRowToSummary } from './mappers.js';

export interface SchemaInput {
  title: string;
  description?: string;
  upperOntologyIri?: string;
  baseUri?: string;
}
export type SchemaPatch = Partial<SchemaInput>;

export interface ClassInput {
  name: string;
  label?: string;
  description?: string;
  mapsToConceptIri?: string;
  superClassId?: string;
}
export type ClassPatch = Partial<ClassInput>;

export interface PropertyInput {
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
}
export type PropertyPatch = Partial<PropertyInput>;

/** '' means "clear this nullable column"; undefined means "leave it alone". */
function nullable(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === '' ? null : value;
}

function jsonOrNull(value: unknown[] | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value.length > 0 ? JSON.stringify(value) : null;
}

export async function listSchemas(db: Kysely<DB>, ownerId: string) {
  return (await repo.listSchemas(db, ownerId)).map(schemaRowToSummary);
}

/** Cheap existence probe, so a child insert can 404 instead of tripping an FK. */
export async function schemaExists(db: Kysely<DB>, id: string): Promise<boolean> {
  return (await repo.getSchemaRow(db, id)) !== undefined;
}

export async function getSchemaWithChildren(db: Kysely<DB>, id: string) {
  const row = await repo.getSchemaRow(db, id);
  if (!row) return undefined;

  const [classes, properties] = await Promise.all([
    repo.listClasses(db, id),
    repo.listProperties(db, id),
  ]);

  return {
    ...schemaRowToSummary(row),
    url: schemaIri(row.id),
    classes: classes.map(classRowToApi),
    properties: properties.map(propertyRowToApi),
  };
}

export async function createSchema(db: Kysely<DB>, ownerId: string, input: SchemaInput) {
  const row = await repo.insertSchema(db, {
    owner_id: ownerId,
    title: input.title,
    description: input.description ?? null,
    upper_ontology_iri: input.upperOntologyIri ?? null,
    base_uri: input.baseUri ? normalizeBaseUri(input.baseUri) : null,
  });
  return { ...schemaRowToSummary(row), classes: [], properties: [] };
}

export async function updateSchema(db: Kysely<DB>, id: string, patch: SchemaPatch): Promise<void> {
  await repo.patchSchema(db, id, {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: nullable(patch.description) } : {}),
    ...(patch.upperOntologyIri !== undefined ? { upper_ontology_iri: nullable(patch.upperOntologyIri) } : {}),
    ...(patch.baseUri !== undefined
      ? { base_uri: patch.baseUri === '' ? null : normalizeBaseUri(patch.baseUri) }
      : {}),
  });
}

export async function deleteSchema(db: Kysely<DB>, id: string): Promise<void> {
  await repo.removeSchema(db, id);
}

export async function addClass(db: Kysely<DB>, schemaId: string, input: ClassInput) {
  const row = await repo.insertClass(db, {
    schema_id: schemaId,
    name: input.name,
    label: input.label ?? null,
    description: input.description ?? null,
    maps_to_concept_iri: input.mapsToConceptIri ?? null,
    super_class_id: input.superClassId ?? null,
  });
  return classRowToApi(row);
}

/**
 * Scoped to `schemaId`: a class is only reachable through the schema that owns
 * it. Returns false when nothing matched, which the route turns into a 404.
 */
export async function updateClass(
  db: Kysely<DB>, schemaId: string, classId: string, patch: ClassPatch,
): Promise<boolean> {
  const matched = await repo.patchClass(db, schemaId, classId, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.label !== undefined ? { label: nullable(patch.label) } : {}),
    ...(patch.description !== undefined ? { description: nullable(patch.description) } : {}),
    ...(patch.mapsToConceptIri !== undefined ? { maps_to_concept_iri: nullable(patch.mapsToConceptIri) } : {}),
    ...(patch.superClassId !== undefined ? { super_class_id: nullable(patch.superClassId) } : {}),
  });
  return matched > 0;
}

export async function deleteClass(db: Kysely<DB>, schemaId: string, classId: string): Promise<boolean> {
  return (await repo.removeClass(db, schemaId, classId)) > 0;
}

export async function addProperty(db: Kysely<DB>, schemaId: string, input: PropertyInput) {
  const row = await repo.insertProperty(db, {
    schema_id: schemaId,
    name: input.name,
    label: input.label ?? null,
    description: input.description ?? null,
    property_type: input.propertyType,
    domain_class_id: input.domainClassId ?? null,
    range_class_iri: input.rangeClassIri ?? null,
    mapping_pattern: jsonOrNull(input.mappingPattern) ?? null,
    regex_pattern: input.regexPattern ?? null,
    regex_variable: input.regexVariable ?? null,
    is_required: input.isRequired ?? false,
    property_features: jsonOrNull(input.propertyFeatures) ?? null,
    inverse_property_iri: input.inversePropertyIri ?? null,
    disjoint_property_iris: jsonOrNull(input.disjointPropertyIris) ?? null,
  });
  return propertyRowToApi(row);
}

/** Scoped to `schemaId` for the same reason as updateClass. */
export async function updateProperty(
  db: Kysely<DB>, schemaId: string, propId: string, patch: PropertyPatch,
): Promise<boolean> {
  const matched = await repo.patchProperty(db, schemaId, propId, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.label !== undefined ? { label: nullable(patch.label) } : {}),
    ...(patch.description !== undefined ? { description: nullable(patch.description) } : {}),
    ...(patch.propertyType !== undefined ? { property_type: patch.propertyType } : {}),
    ...(patch.domainClassId !== undefined ? { domain_class_id: nullable(patch.domainClassId) } : {}),
    ...(patch.rangeClassIri !== undefined ? { range_class_iri: nullable(patch.rangeClassIri) } : {}),
    ...(patch.mappingPattern !== undefined ? { mapping_pattern: jsonOrNull(patch.mappingPattern) } : {}),
    ...(patch.regexPattern !== undefined ? { regex_pattern: nullable(patch.regexPattern) } : {}),
    ...(patch.regexVariable !== undefined ? { regex_variable: nullable(patch.regexVariable) } : {}),
    ...(patch.isRequired !== undefined ? { is_required: patch.isRequired } : {}),
    ...(patch.propertyFeatures !== undefined ? { property_features: jsonOrNull(patch.propertyFeatures) } : {}),
    ...(patch.inversePropertyIri !== undefined ? { inverse_property_iri: nullable(patch.inversePropertyIri) } : {}),
    ...(patch.disjointPropertyIris !== undefined
      ? { disjoint_property_iris: jsonOrNull(patch.disjointPropertyIris) }
      : {}),
  });
  return matched > 0;
}

export async function deleteProperty(db: Kysely<DB>, schemaId: string, propId: string): Promise<boolean> {
  return (await repo.removeProperty(db, schemaId, propId)) > 0;
}
