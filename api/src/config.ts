import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export const config = {
  env: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '3000'), 10),
  logLevel: optional('LOG_LEVEL', 'info'),

  qlever: {
    sparqlUrl: optional('QLEVER_SPARQL_URL', 'http://qlever:7001/sparql'),
    updateUrl: optional('QLEVER_UPDATE_URL', 'http://qlever:7001/update'),
    accessToken: optional('QLEVER_ACCESS_TOKEN', ''),
  },

  rdf: {
    baseNamespace: optional('BASE_NAMESPACE', 'https://w3id.org/sulo/schema/'),
  },

  // Server-side full OWL DL reasoning via ROBOT + HermiT.
  reasoner: {
    enabled: optional('REASONER_ENABLED', 'true') !== 'false',
    // Path to the `robot` launcher (a JRE must be on PATH for it).
    robotPath: optional('ROBOT_PATH', 'robot'),
    // Full SULO ontology bundled with the API (../../resources/sulo.ttl from dist/config.js).
    suloPath: optional('SULO_TTL_PATH', resolve(__dirname, '..', 'resources', 'sulo.ttl')),
    // Hard cap on a single reasoning run (ms).
    timeoutMs: parseInt(optional('REASONER_TIMEOUT_MS', '60000'), 10),
    // Max explanations to fetch per clash.
    maxExplanations: parseInt(optional('REASONER_MAX_EXPLANATIONS', '1'), 10),
  },

  // ShEx ShapeMap-based cross-schema transformability checking (shexSpec/shape-map).
  shex: {
    // The `shex-validate` binary installed by the @shexjs/cli dependency.
    shexValidatePath: optional(
      'SHEX_VALIDATE_PATH',
      resolve(__dirname, '..', 'node_modules', '.bin', 'shex-validate'),
    ),
    timeoutMs: parseInt(optional('SHEX_TIMEOUT_MS', '15000'), 10),
  },

} as const;
