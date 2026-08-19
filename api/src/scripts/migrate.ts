// Standalone migration entry point. Run before starting the server — never
// from inside it, so N replicas cannot race each other.
//   npm run migrate -w sulo-schema-builder-api        (local dev, via tsx)
//   node api/dist/scripts/migrate.js                  (containers/production)
//
// It lives under src/ so `tsc` emits dist/scripts/migrate.js: the production
// image installs with `npm ci --omit=dev`, which leaves no tsx to run a .ts
// entry point with.

import { Pool } from 'pg';
import { resolve } from 'node:path';
import { runMigrations } from '../db/migrate.js';
import { config } from '../config/index.js';

// api/src/scripts/ and api/dist/scripts/ are both two levels under api/, so
// this resolves to api/migrations from either the tsx or the compiled run.
const migrationsDir = resolve(import.meta.dirname, '..', '..', 'migrations');

const pool = new Pool({ connectionString: config.postgres.url });
try {
  const applied = await runMigrations(pool, migrationsDir);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'already up to date');
} finally {
  await pool.end();
}
