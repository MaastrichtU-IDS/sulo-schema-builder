// Orchestration over repo.ts: input normalisation, PATCH semantics ('' clears
// a field, absent leaves it), and assembling the full API response shape.

// INVARIANT: `import type` only for kysely here and in repo.ts — a value import
// breaks the packaged desktop binary. The reason is spelled out at the top of
// repo.ts.
import type { Kysely } from 'kysely';
import type { DB, SchemaRow } from '../../db/types.js';
import { publicUrlProblem } from '../../rdf/safeFetch.js';
import { markDirty, scheduleCheck } from '../reasoning/pipeline.js';
import * as repo from './repo.js';
import { classRowToApi, normalizeBaseUri, propertyRowToApi, schemaIri, schemaRowToSummary } from './mappers.js';

/**
 * Marks `schemaId` dirty in the SAME transaction as the write that just
 * changed it (spec §7 step 1), then — once that transaction has actually
 * committed — schedules a debounced check for it. The two are deliberately
 * not the same step: `markDirty` must roll back with everything else if the
 * write fails (a failed mutation must leave no dirty mark), while scheduling
 * a check is an in-memory side effect with nothing to roll back and every
 * reason to wait until the write it is about to read is durable.
 *
 * `actorId` becomes the check's `requestedBy` — whose tier gates the
 * automatic run if one is needed (modules/reasoning/pipeline.ts). Every
 * mutating route passes the caller's own id; there is no path today where a
 * schema is written without a signed-in caller behind it.
 */
/**
 * `shouldMark` guards the child-write routes (update/delete class or
 * property): `repo.patchClass`/`removeClass`/etc. return the number of rows
 * matched, and a class/property id that does not exist in this schema
 * matches none — the route turns that into a 404, and it must not carry a
 * dirty mark for a write that never happened. Defaults to "always", which is
 * right for an insert (it either succeeds or throws) and for `updateSchema`'s
 * content patch (unconditionally targeted at `id`, never "no such row" —
 * that would already be a 404 from the ACL guard before this runs).
 */
async function withDirtyMark<T>(
  db: Kysely<DB>, schemaId: string, actorId: string | null, write: (trx: Kysely<DB>) => Promise<T>,
  shouldMark: (result: T) => boolean = () => true,
): Promise<T> {
  const result = await db.transaction().execute(async (trx) => {
    const value = await write(trx);
    if (shouldMark(value)) {
      await markDirty(trx, schemaId);
      // Dynamic import, not a static one: notify.ts holds a real kysely
      // `sql` value (pg_notify has no query-builder method), and this file
      // sits on routes/v1/index.ts's eager import graph in both storage
      // modes. See notify.ts's own header for the full argument.
      const { notifySchemaChanged } = await import('../events/notify.js');
      await notifySchemaChanged(trx, schemaId, 'mutated');
    }
    return value;
  });
  if (shouldMark(result)) scheduleCheck({ db }, schemaId, actorId);
  return result;
}

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
 * This is the only way *routes* get that shape: every route reaches this
 * through requireAccess/schemaAccess (modules/acl/guards.ts), which has
 * already loaded and authorized the row — an unscoped read-by-id sitting next
 * to this one is exactly the shape a future handler would reach for by
 * accident, bypassing the guard entirely. If you need the full shape for a
 * row you have not already authorized, load and check it yourself first; do
 * not add that convenience here. `schemaForReasoning` below is the one
 * deliberate exception, for the one caller that is not a request.
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

/**
 * The unscoped read-by-id `schemaWithChildren`'s own doc comment warns future
 * handlers off: this is that read, and it exists on purpose. The reasoning
 * pipeline (modules/reasoning/owl.ts) generates OWL from a debounced job, not
 * a request — there is no caller to authorize, and the whole point is that
 * the generated document describes the schema exactly as stored, not as any
 * one caller is allowed to see it. Do not call this from a route; routes
 * authorize through requireAccess/schemaAccess and then use
 * `schemaWithChildren(db, row)` with the row the guard already loaded.
 */
export async function schemaForReasoning(db: Kysely<DB>, id: string) {
  const row = await repo.getSchemaRow(db, id);
  if (!row) return undefined;
  return schemaWithChildren(db, row);
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
  // No transaction/markDirty needed: the column default already leaves a
  // brand-new row `reason_state = 'stale'`. Scheduling a check now (rather
  // than waiting for the sweep to notice it, minutes later) is what makes a
  // freshly created schema's badge move on its own.
  scheduleCheck({ db }, row.id, ownerId);
  return { ...schemaRowToSummary(row), classes: [], properties: [] };
}

export async function updateSchema(db: Kysely<DB>, id: string, patch: SchemaPatch, actorId: string | null): Promise<void> {
  assertFetchableIri(patch.upperOntologyIri);
  const values = {
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
  };

  // A patch touching ONLY visibility cannot change what the reasoner sees —
  // mirrors repo.patchSchema's own modified_at distinction, for the same
  // reason: publication is not a content edit.
  const keys = Object.keys(values);
  const isVisibilityOnly = keys.length > 0 && keys.every((key) => key === 'visibility');
  if (isVisibilityOnly) {
    await repo.patchSchema(db, id, values);
    return;
  }
  await withDirtyMark(db, id, actorId, (trx) => repo.patchSchema(trx, id, values));
}

export async function deleteSchema(db: Kysely<DB>, id: string): Promise<void> {
  await repo.removeSchema(db, id);
}

export async function addClass(db: Kysely<DB>, schemaId: string, input: ClassInput, actorId: string | null) {
  await assertClassInSchema(db, schemaId, 'superClassId', input.superClassId);
  const row = await withDirtyMark(db, schemaId, actorId, (trx) => repo.insertClass(trx, {
    schema_id: schemaId,
    name: input.name,
    label: input.label ?? null,
    description: input.description ?? null,
    maps_to_concept_iri: input.mapsToConceptIri ?? null,
    super_class_id: nullable(input.superClassId) ?? null,
  }));
  return classRowToApi(row);
}

/**
 * Scoped to `schemaId`: a class is only reachable through the schema that owns
 * it. Returns false when nothing matched, which the route turns into a 404 —
 * and, per `withDirtyMark`'s `shouldMark`, carries no dirty mark either.
 */
export async function updateClass(
  db: Kysely<DB>, schemaId: string, classId: string, patch: ClassPatch, actorId: string | null,
): Promise<boolean> {
  if (patch.superClassId === classId) {
    throw new SchemaWriteError('superClassId: a class cannot be its own superclass');
  }
  await assertClassInSchema(db, schemaId, 'superClassId', patch.superClassId);
  const matched = await withDirtyMark(db, schemaId, actorId, (trx) => repo.patchClass(trx, schemaId, classId, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.label !== undefined ? { label: nullable(patch.label) } : {}),
    ...(patch.description !== undefined ? { description: nullable(patch.description) } : {}),
    ...(patch.mapsToConceptIri !== undefined ? { maps_to_concept_iri: nullable(patch.mapsToConceptIri) } : {}),
    ...(patch.superClassId !== undefined ? { super_class_id: nullable(patch.superClassId) } : {}),
  }), (n) => n > 0);
  return matched > 0;
}

export async function deleteClass(db: Kysely<DB>, schemaId: string, classId: string, actorId: string | null): Promise<boolean> {
  const matched = await withDirtyMark(
    db, schemaId, actorId, (trx) => repo.removeClass(trx, schemaId, classId), (n) => n > 0,
  );
  return matched > 0;
}

export async function addProperty(db: Kysely<DB>, schemaId: string, input: PropertyInput, actorId: string | null) {
  await assertClassInSchema(db, schemaId, 'domainClassId', input.domainClassId);
  const row = await withDirtyMark(db, schemaId, actorId, (trx) => repo.insertProperty(trx, {
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
  }));
  return propertyRowToApi(row);
}

/** Scoped to `schemaId` for the same reason as updateClass. */
export async function updateProperty(
  db: Kysely<DB>, schemaId: string, propId: string, patch: PropertyPatch, actorId: string | null,
): Promise<boolean> {
  await assertClassInSchema(db, schemaId, 'domainClassId', patch.domainClassId);
  const matched = await withDirtyMark(db, schemaId, actorId, (trx) => repo.patchProperty(trx, schemaId, propId, {
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
  }), (n) => n > 0);
  return matched > 0;
}

export async function deleteProperty(db: Kysely<DB>, schemaId: string, propId: string, actorId: string | null): Promise<boolean> {
  const matched = await withDirtyMark(
    db, schemaId, actorId, (trx) => repo.removeProperty(trx, schemaId, propId), (n) => n > 0,
  );
  return matched > 0;
}
