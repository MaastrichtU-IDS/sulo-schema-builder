// Standalone migration entry point. Run before starting the server — never
// from inside it, so N replicas cannot race each other.
//   npm run migrate -w sulo-schema-builder-api

import { Pool } from 'pg';
import { resolve } from 'node:path';
import { runMigrations } from '../src/db/migrate.js';
import { config } from '../src/config.js';

const pool = new Pool({ connectionString: config.postgres.url });
try {
  const applied = await runMigrations(pool, resolve(import.meta.dirname, '..', 'migrations'));
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'already up to date');
} finally {
  await pool.end();
}
