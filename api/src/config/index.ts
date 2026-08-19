// The single `config` object the rest of the API reads, assembled from the
// per-concern modules beside it. Filesystem locations live in ../paths.ts —
// see the comment there for why they cannot live in this directory.

import { serverConfig } from './server.js';
import { dbConfig, postgresConfig } from './db.js';
import { rdfConfig } from './rdf.js';
import { reasonerConfig } from './reasoner.js';

export const config = {
  ...serverConfig,
  db: dbConfig,
  postgres: postgresConfig,
  rdf: rdfConfig,
  reasoner: reasonerConfig,
} as const;
