// Orchestration over repo.ts: input normalisation, PATCH semantics ('' clears
// a field, absent leaves it), and assembling the full API response shape.

// INVARIANT: `import type` only for kysely here and in repo.ts — a value import
// breaks the packaged desktop binary. The reason is spelled out at the top of
// repo.ts.
import type { Kysely } from 'kysely';
import type { DB, SchemaRow } from '../../db/types.js';
import { publicUrlProblem } from '../../rdf/safeFetch.js';
import * as repo from './repo.js';
import { classRowToApi, normalizeBaseUri, propertyRowToApi, schemaIri, schemaRowToSummary } from './mappers.js';

/**
 * A client mistake this layer detects that the routes cannot: it needs a
 * database round-trip, or it is a policy rule rather than a shape rule.
 *
 * `statusCode` is what plugins/errorHandler.ts reads — anything below 500 is
 * forwarded to the caller as-is, so this becomes a 400 with `message` intact
 * without every route needing its own try/catch.
 */
export class SchemaWriteError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'SchemaWriteError';
  }
}

/**
 * An upper-ontology IRI is not just metadata: GET /:id/upper-concepts makes the
 * server dereference it. Rejecting it here means a hostile value (cloud
 * metadata, loopback, a non-standard port) can never be *stored*, so the read
 * side has nothing to defend against even if a future caller forgets the guard.
 * The same policy runs again at fetch time — see rdf/guardedUpperConcepts.ts.
 */
function assertFetchableIri(iri: string | undefined): void {
  if (iri === undefined || iri === '') return;
  const problem = publicUrlProblem(iri);
  if (problem) throw new SchemaWriteError(`upperOntologyIri: ${problem}`);
}

/**
 * `superClassId` and `domainClassId` are foreign keys onto classes(id) with no
 * schema predicate, so the database happily accepts a class from *another*
 * schema and builds a cross-schema edge — an incoherent export today and, once
 * plan 2 authorizes on `:id`, a write (and a read-back primitive) reaching into
 * a schema the caller has no grant on. The scoping the FK cannot express is
 * enforced here.
 */
async function assertClassInSchema(
  db: Kysely<DB>, schemaId: string, field: string, classId: string | undefined,
): Promise<void> {
  if (classId === undefined || classId === '') return;
  if (!(await repo.classInSchema(db, schemaId, classId))) {
    throw new SchemaWriteError(`${field}: no class ${classId} in this schema`);
  }
}

export interface SchemaInput {
  title: string;
  description?: string;
  upperOntologyIri?: string;
  baseUri?: string;
  visibility?: 'private' | 'unlisted' | 'public';
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

/** Thin pass-through: repo.listSchemasByScope already returns rows sorted and scoped. */
export async function listSchemasByScope(
  db: Kysely<DB>, scope: repo.ListScope, userId: string | null,
) {
  return (await repo.listSchemasByScope(db, { scope, userId })).map(schemaRowToSummary);
}

/**
 * The full API shape for a schema row the caller already holds.
 *
 * This is the only way to get that shape: there is deliberately no sibling
 * "fetch by id and assemble" function. Every production caller reaches this
 * through requireAccess/schemaAccess (modules/acl/guards.ts), which has
 * already loaded and authorized the row — an unscoped read-by-id sitting next
 * to this one is exactly the shape a future handler would reach for by
 * accident, bypassing the guard entirely. If you need the full shape for a
 * row you have not already authorized, load and check it yourself first;
 * do not add that convenience here.
 */
export async function schemaWithChildren(db: Kysely<DB>, row: SchemaRow) {
  const [classes, properties] = await Promise.all([
    repo.listClasses(db, row.id),
    repo.listProperties(db, row.id),
  ]);

  return {
    ...schemaRowToSummary(row),
    url: schemaIri(row.id),
    classes: classes.map(classRowToApi),
    properties: properties.map(propertyRowToApi),
  };
}

export async function createSchema(db: Kysely<DB>, ownerId: string, input: SchemaInput) {
  assertFetchableIri(input.upperOntologyIri);
  const row = await repo.insertSchema(db, {
    owner_id: ownerId,
    title: input.title,
    // '' behaves the same on create as it does on PATCH: an absent value and a
    // cleared one both land as NULL rather than an empty string.
    description: nullable(input.description) ?? null,
    upper_ontology_iri: nullable(input.upperOntologyIri) ?? null,
    base_uri: input.baseUri ? normalizeBaseUri(input.baseUri) : null,
    // Omitted (rather than set to a literal 'private') when absent, so the
    // column's own default is what actually applies — one definition of
    // "private" instead of two that could drift.
    ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
  });
  return { ...schemaRowToSummary(row), classes: [], properties: [] };
}

export async function updateSchema(db: Kysely<DB>, id: string, patch: SchemaPatch): Promise<void> {
  assertFetchableIri(patch.upperOntologyIri);
  await repo.patchSchema(db, id, {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: nullable(patch.description) } : {}),
    ...(patch.upperOntologyIri !== undefined ? { upper_ontology_iri: nullable(patch.upperOntologyIri) } : {}),
    ...(patch.baseUri !== undefined
      ? { base_uri: patch.baseUri === '' ? null : normalizeBaseUri(patch.baseUri) }
      : {}),
    // Whether the caller is *allowed* to set this is decided in routes.ts
    // (assertMayChangeVisibility) before this function is ever called — this
    // layer only knows how to write the column, not who may ask it to.
    ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
  });
}

export async function deleteSchema(db: Kysely<DB>, id: string): Promise<void> {
  await repo.removeSchema(db, id);
}

export async function addClass(db: Kysely<DB>, schemaId: string, input: ClassInput) {
  await assertClassInSchema(db, schemaId, 'superClassId', input.superClassId);
  const row = await repo.insertClass(db, {
    schema_id: schemaId,
    name: input.name,
    label: input.label ?? null,
    description: input.description ?? null,
    maps_to_concept_iri: input.mapsToConceptIri ?? null,
    super_class_id: nullable(input.superClassId) ?? null,
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
  if (patch.superClassId === classId) {
    throw new SchemaWriteError('superClassId: a class cannot be its own superclass');
  }
  await assertClassInSchema(db, schemaId, 'superClassId', patch.superClassId);
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
  await assertClassInSchema(db, schemaId, 'domainClassId', input.domainClassId);
  const row = await repo.insertProperty(db, {
    schema_id: schemaId,
    name: input.name,
    label: input.label ?? null,
    description: input.description ?? null,
    property_type: input.propertyType,
    domain_class_id: nullable(input.domainClassId) ?? null,
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
  await assertClassInSchema(db, schemaId, 'domainClassId', patch.domainClassId);
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
