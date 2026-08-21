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

export type ListScope = 'mine' | 'shared' | 'public';

/**
 * Three shapes of one query, chosen by `scope` rather than combined into one
 * WHERE with ORs: `mine` is owner_id = :me, `shared` is an inner join on
 * schema_grants for :me (and never the caller's own row), `public` is
 * visibility = 'public' from every owner. Keeping them as separate branches
 * means a schema can never surface via two predicates in the same response —
 * there is nothing to de-duplicate, because at most one branch ever runs.
 *
 * `unlisted` is deliberately absent from the `public` branch: that omission
 * is the entire difference between the two published visibilities. A schema
 * is still reachable at `GET /:id` by anyone who has the id (modules/acl);
 * this is only what a caller with no id yet can discover by browsing.
 *
 * Authorization — whether `mine`/`shared` may run at all for this caller —
 * is routes.ts's job, decided from the token before this runs. A null
 * `userId` here just means "no caller to match against", so `mine`/`shared`
 * answer an empty list rather than throwing; the 401 for that combination is
 * a route-level answer, not a story this query needs to tell.
 */
export async function listSchemasByScope(
  db: Kysely<DB>,
  params: { scope: ListScope; userId: string | null },
): Promise<SchemaRow[]> {
  const { scope, userId } = params;

  if (scope === 'public') {
    return db.selectFrom('schemas').selectAll()
      .where('visibility', '=', 'public')
      .orderBy('title')
      .execute();
  }

  if (userId === null) return [];

  if (scope === 'mine') {
    return db.selectFrom('schemas').selectAll()
      .where('owner_id', '=', userId)
      .orderBy('title')
      .execute();
  }

  // shared: schema_grants.(schema_id, grantee_id) is the primary key, so this
  // join matches at most one grant row per schema for this caller — no
  // DISTINCT needed to keep a schema from appearing twice. `owner_id != :me`
  // excludes a schema this caller owns even if a grant row also names them
  // (e.g. a stray self-grant): `shared` never includes the caller's own.
  return db.selectFrom('schemas')
    .innerJoin('schema_grants', 'schema_grants.schema_id', 'schemas.id')
    .where('schema_grants.grantee_id', '=', userId)
    .where('schemas.owner_id', '!=', userId)
    .selectAll('schemas')
    .orderBy('schemas.title')
    .execute();
}

export async function getSchemaRow(db: Kysely<DB>, id: string): Promise<SchemaRow | undefined> {
  return db.selectFrom('schemas').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function insertSchema(db: Kysely<DB>, values: NewSchema): Promise<SchemaRow> {
  return db.insertInto('schemas').values(values).returningAll().executeTakeFirstOrThrow();
}

/**
 * `modified_at` tracks the schema's *content*, not who may see it or who
 * owns it — matching transferOwnership's own comment in grants.repo.ts, which
 * leaves it untouched for the same reason. A patch that sets only
 * `visibility` is a publication decision, not a content edit, so it must not
 * bump it; anything else in the patch (including visibility alongside a
 * content field) does. An empty patch — nothing to set at all — still bumps
 * it, matching this function's behaviour before this distinction existed,
 * rather than issuing a no-op `UPDATE ... SET` with no columns.
 */
export async function patchSchema(db: Kysely<DB>, id: string, values: SchemaUpdate): Promise<void> {
  const keys = Object.keys(values);
  const isVisibilityOnly = keys.length > 0 && keys.every((key) => key === 'visibility');
  await db.updateTable('schemas')
    .set({ ...values, ...(isVisibilityOnly ? {} : { modified_at: new Date() }) })
    .where('id', '=', id)
    .execute();
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
 * Does this class belong to this schema?
 *
 * Two callers, both about schema scoping: the empty-patch case below (nothing to
 * SET, so there is no update row count to read), and service.ts's check that a
 * superClassId/domainClassId names a class in the *same* schema. The
 * classes.super_class_id and properties.domain_class_id foreign keys reference
 * classes(id) with no schema predicate, so nothing in the database stops a
 * cross-schema reference — this query is that constraint.
 */
export async function classInSchema(db: Kysely<DB>, schemaId: string, id: string): Promise<boolean> {
  const row = await db.selectFrom('classes').select('id')
    .where('id', '=', id).where('schema_id', '=', schemaId).executeTakeFirst();
  return row !== undefined;
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
  if (Object.keys(values).length === 0) return (await classInSchema(db, schemaId, id)) ? 1 : 0;
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
