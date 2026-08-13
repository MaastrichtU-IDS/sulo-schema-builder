/**
 * One-time migration: dump every OntologySchema (+ classes + properties) held
 * in a live QLever instance and insert them into the new embedded SQLite
 * database. Run manually, once, against the old QLever-backed stack before
 * cutting over to the SQLite-backed API.
 *
 * Usage:
 *   npx tsx scripts/migrate-qlever-to-sqlite.ts \
 *     [--qlever-url http://localhost:7001/sparql] \
 *     [--db-path ../data/sulo.db]
 */
import { openDatabase } from '../src/db/connection.js';
import { PREFIXES } from '../src/rdf/prefixes.js';

const SM = PREFIXES.suloschema;
const DCT = PREFIXES.dct;
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const QLEVER_URL = arg('qlever-url', 'http://localhost:7001/sparql');
const DB_PATH = arg('db-path', new URL('../data/sulo.db', import.meta.url).pathname);

const PREFIX_BLOCK = Object.entries(PREFIXES).map(([k, v]) => `PREFIX ${k}: <${v}>`).join('\n');

type Binding = Record<string, { value: string }>;

async function sparqlSelect(query: string): Promise<Binding[]> {
  const res = await fetch(`${QLEVER_URL}?${new URLSearchParams({ query: `${PREFIX_BLOCK}\n${query}` })}`, {
    headers: { Accept: 'application/sparql-results+json' },
  });
  if (!res.ok) throw new Error(`SPARQL SELECT failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { results: { bindings: Binding[] } };
  return data.results.bindings;
}

function localId(iri: string): string {
  return iri.split('/').pop() ?? iri;
}

async function main() {
  console.log(`Reading from ${QLEVER_URL}, writing to ${DB_PATH}`);
  const db = openDatabase(DB_PATH);

  const schemaRows = await sparqlSelect(`
    SELECT ?schema ?title ?description ?upperOntologyIri ?baseUri
    WHERE {
      ?schema a <${SM}OntologySchema> .
      OPTIONAL { ?schema <${DCT}title> ?title }
      OPTIONAL { ?schema <${DCT}description> ?description }
      OPTIONAL { ?schema <${SM}upperOntologyIri> ?upperOntologyIri }
      OPTIONAL { ?schema <${SM}baseUri> ?baseUri }
    }
  `);

  const insertSchema = db.prepare(`
    INSERT OR REPLACE INTO schemas (id, title, description, upper_ontology_iri, base_uri, created_at, modified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertClass = db.prepare(`
    INSERT OR REPLACE INTO classes (id, schema_id, name, label, description, maps_to_concept_iri, super_class_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertProperty = db.prepare(`
    INSERT OR REPLACE INTO properties (
      id, schema_id, name, label, description, property_type,
      domain_class_id, range_class_iri, mapping_pattern,
      regex_pattern, regex_variable, is_required,
      property_features, inverse_property_iri, disjoint_property_iris
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let schemaCount = 0, classCount = 0, propCount = 0;

  for (const row of schemaRows) {
    const schemaIri = row['schema'].value;
    const schemaId = localId(schemaIri);
    const now = new Date().toISOString();

    insertSchema.run(
      schemaId,
      row['title']?.value ?? '',
      row['description']?.value ?? null,
      row['upperOntologyIri']?.value ?? null,
      row['baseUri']?.value ?? null,
      now, now,
    );
    schemaCount++;

    const classRows = await sparqlSelect(`
      SELECT ?cls ?name ?label ?description ?mapsTo ?superCls
      WHERE {
        <${schemaIri}> <${SM}hasClass> ?cls .
        OPTIONAL { ?cls <${DCT}identifier> ?name }
        OPTIONAL { ?cls <${RDFS_LABEL}> ?label }
        OPTIONAL { ?cls <${DCT}description> ?description }
        OPTIONAL { ?cls <${SM}mapsToConcept> ?mapsTo }
        OPTIONAL { ?cls <${SM}superClass> ?superCls }
      }
    `);

    const classPrefix = `${PREFIXES.suloschemaR}ontology-class/`;
    for (const c of classRows) {
      const superClsUrl = c['superCls']?.value;
      insertClass.run(
        localId(c['cls'].value),
        schemaId,
        c['name']?.value ?? '',
        c['label']?.value ?? null,
        c['description']?.value ?? null,
        c['mapsTo']?.value ?? null,
        superClsUrl && superClsUrl.startsWith(classPrefix) ? superClsUrl.slice(classPrefix.length) : null,
      );
      classCount++;
    }

    const propRows = await sparqlSelect(`
      SELECT ?prop ?name ?label ?description ?propertyType ?domainClass ?rangeClassIri ?mappingPattern ?regexPattern ?regexVariable ?isRequired ?propertyFeatures ?inversePropertyIri ?disjointPropertyIris
      WHERE {
        <${schemaIri}> <${SM}hasOntologyProperty> ?prop .
        OPTIONAL { ?prop <${DCT}identifier> ?name }
        OPTIONAL { ?prop <${RDFS_LABEL}> ?label }
        OPTIONAL { ?prop <${DCT}description> ?description }
        OPTIONAL { ?prop <${SM}propertyType> ?propertyType }
        OPTIONAL { ?prop <${SM}domainClass> ?domainClass }
        OPTIONAL { ?prop <${SM}rangeClassIri> ?rangeClassIri }
        OPTIONAL { ?prop <${SM}mappingPattern> ?mappingPattern }
        OPTIONAL { ?prop <${SM}regexPattern> ?regexPattern }
        OPTIONAL { ?prop <${SM}regexVariable> ?regexVariable }
        OPTIONAL { ?prop <${SM}isRequired> ?isRequired }
        OPTIONAL { ?prop <${SM}propertyFeatures> ?propertyFeatures }
        OPTIONAL { ?prop <${SM}inversePropertyIri> ?inversePropertyIri }
        OPTIONAL { ?prop <${SM}disjointPropertyIris> ?disjointPropertyIris }
      }
    `);

    for (const p of propRows) {
      const domainUrl = p['domainClass']?.value;
      insertProperty.run(
        localId(p['prop'].value),
        schemaId,
        p['name']?.value ?? '',
        p['label']?.value ?? null,
        p['description']?.value ?? null,
        (p['propertyType']?.value as string) ?? 'datatype',
        domainUrl ? localId(domainUrl) : null,
        p['rangeClassIri']?.value ?? null,
        p['mappingPattern']?.value ?? null,
        p['regexPattern']?.value ?? null,
        p['regexVariable']?.value ?? null,
        p['isRequired']?.value === 'true' ? 1 : 0,
        p['propertyFeatures']?.value ?? null,
        p['inversePropertyIri']?.value ?? null,
        p['disjointPropertyIris']?.value ?? null,
      );
      propCount++;
    }
  }

  db.close();
  console.log(`Migrated ${schemaCount} schemas, ${classCount} classes, ${propCount} properties into ${DB_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
