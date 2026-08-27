// RDF namespace the API mints IRIs under. Changing this changes every IRI in
// every export, so it is deployment-wide configuration, not per-schema.

import { optional } from './env.js';

export const rdfConfig = {
  baseNamespace: optional('BASE_NAMESPACE', 'https://w3id.org/sulo/schema/'),
} as const;
