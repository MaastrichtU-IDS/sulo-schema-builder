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

export const postgresConfig = {
  // Required when SCHEMA_STORAGE=postgres; unused by the desktop/SQLite path.
  url: optional('DATABASE_URL', 'postgres://sulo:sulo@localhost:5432/sulo'),
  poolMax: parseInt(optional('DATABASE_POOL_MAX', '10'), 10),
} as const;
