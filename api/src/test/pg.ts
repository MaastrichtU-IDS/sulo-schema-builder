// Shared Postgres test harness. One container per test file: start it in
// beforeAll, truncate between tests, stop it in afterAll.
//
// Lives under src/ (not api/test/) because api/tsconfig.json sets
// rootDir: "src" — a file outside src/ imported from a src/**/*.test.ts file
// would fail `tsc --noEmit` with TS6059 (file not under rootDir).

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { resolve } from 'node:path';
import { runMigrations } from '../db/migrate.js';
import type { DB } from '../db/types.js';

export interface TestDb {
  db: Kysely<DB>;
  pool: Pool;
  stop: () => Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool, resolve(import.meta.dirname, '..', '..', 'migrations'));
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    pool,
    stop: async () => {
      await db.destroy();
      await container.stop();
    },
  };
}

/** Clears schema data between tests; leaves the seeded users row intact. */
export async function truncateAll(db: Kysely<DB>): Promise<void> {
  await sql`truncate table usage_events, reason_jobs, schema_grants, properties, classes, schemas, reasoning_reports restart identity cascade`.execute(db);
}
