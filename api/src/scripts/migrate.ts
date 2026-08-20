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
// Deliberately the db config module, not the aggregate `config` from
// config/index.js. That aggregate also resolves the *auth* config, which
// fail-fasts when SCHEMA_STORAGE=postgres and AUTH_ISSUER is unset — and
// docker/api/Dockerfile bakes SCHEMA_STORAGE=postgres into the image while
// compose's one-shot `migrate` service is given only DATABASE_URL. Importing
// the aggregate therefore made `node dist/scripts/migrate.js` abort before it
// opened a connection, which took the whole stack down with it (the api
// service depends on migrate completing). Applying DDL needs a database URL
// and nothing else; the server keeps validating everything it needs.
import { postgresConfig } from '../config/db.js';

// api/src/scripts/ and api/dist/scripts/ are both two levels under api/, so
// this resolves to api/migrations from either the tsx or the compiled run.
const migrationsDir = resolve(import.meta.dirname, '..', '..', 'migrations');

const pool = new Pool({ connectionString: postgresConfig.url });
try {
  const applied = await runMigrations(pool, migrationsDir);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'already up to date');
} finally {
  await pool.end();
}
