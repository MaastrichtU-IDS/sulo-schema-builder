import 'dotenv/config';

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

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

} as const;
