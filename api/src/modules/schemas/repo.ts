// Every query against schemas/classes/properties lives here. Callers pass the
// Kysely instance in; nothing in this file reads global state, so tests can
// point it at a throwaway container.

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

export async function patchClass(db: Kysely<DB>, id: string, values: ClassUpdate): Promise<void> {
  if (Object.keys(values).length === 0) return;
  await db.updateTable('classes').set(values).where('id', '=', id).execute();
}

export async function removeClass(db: Kysely<DB>, id: string): Promise<void> {
  await db.deleteFrom('classes').where('id', '=', id).execute();
}

export async function listProperties(db: Kysely<DB>, schemaId: string): Promise<PropertyRow[]> {
  return db.selectFrom('properties').selectAll().where('schema_id', '=', schemaId).orderBy('name').execute();
}

export async function insertProperty(db: Kysely<DB>, values: NewProperty): Promise<PropertyRow> {
  return db.insertInto('properties').values(values).returningAll().executeTakeFirstOrThrow();
}

export async function patchProperty(db: Kysely<DB>, id: string, values: PropertyUpdate): Promise<void> {
  if (Object.keys(values).length === 0) return;
  await db.updateTable('properties').set(values).where('id', '=', id).execute();
}

export async function removeProperty(db: Kysely<DB>, id: string): Promise<void> {
  await db.deleteFrom('properties').where('id', '=', id).execute();
}
