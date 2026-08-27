// Persistence settings for both storage modes. Exactly one of them is live at
// runtime, selected by `storage` in server.ts.

import { resolve } from 'node:path';
import { optional } from './env.js';
import { dataDir } from '../paths.js';

export const dbConfig = {
  // Embedded SQLite database file (frozen desktop path). Defaults to a sibling
  // `data/` dir of the api package (survives container restarts when that dir
  // is a volume mount), or the per-user app-data dir when packaged as a
  // desktop app.
  path: optional('DB_PATH', resolve(dataDir, 'sulo.db')),
} as const;

export interface PostgresConfig {
  url: string;
  poolMax: number;
}

/**
 * Same fail-fast shape as config/auth.ts's resolveAuthConfig: a Postgres
 * deployment that cannot say where its own database is must not start
 * quietly against the packaged-in local default (`localhost:5432`, sulo/sulo)
 * and serve traffic against a database that was never meant to be
 * production — the desktop/sqlite path never consults this at all, so it
 * costs that mode nothing to require it here.
 */
export function resolvePostgresConfig(env: Record<string, string | undefined>, storage: 'postgres' | 'sqlite'): PostgresConfig {
  const poolMax = parseInt(env.DATABASE_POOL_MAX?.trim() || '10', 10);
  if (storage !== 'postgres') {
    return { url: env.DATABASE_URL?.trim() || 'postgres://sulo:sulo@localhost:5432/sulo', poolMax };
  }
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error('DATABASE_URL is required when SCHEMA_STORAGE=postgres (refusing to serve against the packaged-in local default)');
  }
  return { url, poolMax };
}
