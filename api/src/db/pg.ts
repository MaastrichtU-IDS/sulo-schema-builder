import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from './types.js';

export function createKysely(url: string, poolMax: number): { db: Kysely<DB>; pool: Pool } {
  const pool = new Pool({ connectionString: url, max: poolMax });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool };
}
