// Every query against schemas/classes/properties lives here. Callers pass the
// Kysely instance in; nothing in this file reads global state, so tests can
// point it at a throwaway container.

// INVARIANT: kysely must only ever be imported here as `import type`, and the
// same holds for service.ts. This file is statically reachable from
// dist/index.js (routes/v1/index.ts -> modules/schemas/routes.ts -> service.ts
// -> here), and pkg cannot snapshot kysely's top-level-await modules: a value
// import — `import { sql } from 'kysely'` is the tempting one — crashes the
// packaged desktop binary at startup with ERR_MODULE_NOT_FOUND, while
// typecheck, every test and the Docker image all stay green. Need raw SQL?
// Put it behind the lazily-loaded plugins/pg.ts side of the graph instead.
// See api/src/server.ts and the release workflow's sidecar smoke test.
import type { Kysely } from 'kysely';
import type {
  ClassRow, ClassUpdate, DB, NewClass, NewProperty, NewSchema,
  PropertyRow, PropertyUpdate, SchemaRow, SchemaUpdate,
} from '../../db/types.js';

export async function listSchemas(db: Kysely<DB>, ownerId: string): Promise<SchemaRow[]> {
  return db.selectFrom('schemas').selectAll().where('owner_id', '=', ownerId).orderBy('title').execute();
}

export async function getSchemaRow(db: Kysely<DB>, id: string): Promise<SchemaRow | undefined> {
  return db.selectFrom('schemas').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function insertSchema(db: Kysely<DB>, values: NewSchema): Promise<SchemaRow> {
  return db.insertInto('schemas').values(values).returningAll().executeTakeFirstOrThrow();
}

export async function patchSchema(db: Kysely<DB>, id: string, values: SchemaUpdate): Promise<void> {
  await db.updateTable('schemas').set({ ...values, modified_at: new Date() }).where('id', '=', id).execute();
}

export async function removeSchema(db: Kysely<DB>, id: string): Promise<void> {
  await db.deleteFrom('schemas').where('id', '=', id).execute();
}

export async function listClasses(db: Kysely<DB>, schemaId: string): Promise<ClassRow[]> {
  return db.selectFrom('classes').selectAll().where('schema_id', '=', schemaId).orderBy('name').execute();
}

export async function insertClass(db: Kysely<DB>, values: NewClass): Promise<ClassRow> {
  return db.insertInto('classes').values(values).returningAll().executeTakeFirstOrThrow();
}

/**
 * Does this class belong to this schema? Only needed for the empty-patch case,
 * where there is nothing to SET and therefore no update row count to read.
 */
async function classInSchema(db: Kysely<DB>, schemaId: string, id: string): Promise<number> {
  const row = await db.selectFrom('classes').select('id')
    .where('id', '=', id).where('schema_id', '=', schemaId).executeTakeFirst();
  return row ? 1 : 0;
}

/**
 * Every child mutation is keyed on (schema_id, id), never on the child id
 * alone: the route already authorizes the caller for `schema_id`, so a write
 * that matched on the child id alone would let a caller reach through one
 * schema to touch another's rows. Returns the number of rows matched so the
 * caller can answer 404 instead of a silent 204.
 */
export async function patchClass(
  db: Kysely<DB>, schemaId: string, id: string, values: ClassUpdate,
): Promise<number> {
  if (Object.keys(values).length === 0) return classInSchema(db, schemaId, id);
  const result = await db.updateTable('classes').set(values)
    .where('id', '=', id).where('schema_id', '=', schemaId).executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export async function removeClass(db: Kysely<DB>, schemaId: string, id: string): Promise<number> {
  const result = await db.deleteFrom('classes')
    .where('id', '=', id).where('schema_id', '=', schemaId).executeTakeFirst();
  return Number(result.numDeletedRows);
}

export async function listProperties(db: Kysely<DB>, schemaId: string): Promise<PropertyRow[]> {
  return db.selectFrom('properties').selectAll().where('schema_id', '=', schemaId).orderBy('name').execute();
}

export async function insertProperty(db: Kysely<DB>, values: NewProperty): Promise<PropertyRow> {
  return db.insertInto('properties').values(values).returningAll().executeTakeFirstOrThrow();
}

/** Empty-patch counterpart of classInSchema. */
async function propertyInSchema(db: Kysely<DB>, schemaId: string, id: string): Promise<number> {
  const row = await db.selectFrom('properties').select('id')
    .where('id', '=', id).where('schema_id', '=', schemaId).executeTakeFirst();
  return row ? 1 : 0;
}

/** Schema-scoped for the same reason as patchClass; same row-count contract. */
export async function patchProperty(
  db: Kysely<DB>, schemaId: string, id: string, values: PropertyUpdate,
): Promise<number> {
  if (Object.keys(values).length === 0) return propertyInSchema(db, schemaId, id);
  const result = await db.updateTable('properties').set(values)
    .where('id', '=', id).where('schema_id', '=', schemaId).executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export async function removeProperty(db: Kysely<DB>, schemaId: string, id: string): Promise<number> {
  const result = await db.deleteFrom('properties')
    .where('id', '=', id).where('schema_id', '=', schemaId).executeTakeFirst();
  return Number(result.numDeletedRows);
}
