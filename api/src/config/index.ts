// The single `config` object the rest of the API reads, assembled from the
// per-concern modules beside it. Filesystem locations live in ../paths.ts —
// see the comment there for why they cannot live in this directory.

import { serverConfig, storage } from './server.js';
import { dbConfig, resolvePostgresConfig } from './db.js';
import { rdfConfig } from './rdf.js';
import { reasonerConfig } from './reasoner.js';
import { resolveAuthConfig } from './auth.js';
import { quotaConfig } from './quota.js';
import { eventsConfig } from './events.js';

export const config = {
  ...serverConfig,
  db: dbConfig,
  postgres: resolvePostgresConfig(process.env, storage),
  rdf: rdfConfig,
  reasoner: reasonerConfig,
  auth: resolveAuthConfig(process.env, storage),
  quota: quotaConfig,
  events: eventsConfig,
} as const;
