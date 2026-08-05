import type { FastifyInstance } from 'fastify';
import { sparqlSelect } from './sparql.service.js';
import { PREFIXES } from '../rdf/prefixes.js';

const SM = PREFIXES.suloschema;
const DCT = PREFIXES.dct;
const SHEXR = PREFIXES.suloschemaR;

export interface FullOntologyClass {
  id: string;
  url: string;
  name: string;
  label?: string;
  description?: string;
  mapsToConceptIri?: string;
  superClassId?: string;
}

export interface FullTripleTemplate {
  subject: string;
  predicate: string;
  object: string;
}

export interface FullOntologyProperty {
  id: string;
  url: string;
  name: string;
  label?: string;
  description?: string;
  propertyType: 'object' | 'datatype';
  domainClassId?: string;
  rangeClassIri?: string;
  mappingPattern: FullTripleTemplate[];
  isRequired: boolean;
}

export interface FullOntologySchema {
  id: string;
  url: string;
  title: string;
  description?: string;
  upperOntologyIri?: string;
  classes: FullOntologyClass[];
  properties: FullOntologyProperty[];
}

function schemaIri(id: string) {
  return `${SHEXR}ontology-schema/${id}`;
}
function classIri(id: string) {
  return `${SHEXR}ontology-class/${id}`;
}
function iri(s: string) {
  return `<${s}>`;
}

/**
 * Fetch a schema's full classes+properties, exactly as GET /ontology-schemas/:id
 * returns it. Extracted here (rather than left inline in that route) so
 * schemaMatching.service.ts can fetch two schemas the same way, without
 * duplicating the SPARQL queries.
 */
export async function fetchFullSchema(fastify: FastifyInstance, id: string): Promise<FullOntologySchema | null> {
  const sIri = schemaIri(id);

  const metaRows = await sparqlSelect(fastify, `
    SELECT ?title ?description ?upperOntologyIri
    WHERE {
      ${iri(sIri)} a <${SM}OntologySchema> .
      OPTIONAL { ${iri(sIri)} <${DCT}title> ?title }
      OPTIONAL { ${iri(sIri)} <${DCT}description> ?description }
      OPTIONAL { ${iri(sIri)} <${SM}upperOntologyIri> ?upperOntologyIri }
    }
  `);
  if (!metaRows.length) return null;
  const meta = metaRows[0];

  const classRows = await sparqlSelect(fastify, `
    SELECT ?cls ?name ?label ?description ?mapsTo ?superCls
    WHERE {
      ${iri(sIri)} <${SM}hasClass> ?cls .
      OPTIONAL { ?cls <${DCT}identifier> ?name }
      OPTIONAL { ?cls <http://www.w3.org/2000/01/rdf-schema#label> ?label }
      OPTIONAL { ?cls <${DCT}description> ?description }
      OPTIONAL { ?cls <${SM}mapsToConcept> ?mapsTo }
      OPTIONAL { ?cls <${SM}superClass> ?superCls }
    }
    ORDER BY ?name
  `);

  const propRows = await sparqlSelect(fastify, `
    SELECT ?prop ?name ?label ?description ?propertyType ?domainClass ?rangeClassIri ?mappingPattern ?isRequired
    WHERE {
      ${iri(sIri)} <${SM}hasOntologyProperty> ?prop .
      OPTIONAL { ?prop <${DCT}identifier> ?name }
      OPTIONAL { ?prop <http://www.w3.org/2000/01/rdf-schema#label> ?label }
      OPTIONAL { ?prop <${DCT}description> ?description }
      OPTIONAL { ?prop <${SM}propertyType> ?propertyType }
      OPTIONAL { ?prop <${SM}domainClass> ?domainClass }
      OPTIONAL { ?prop <${SM}rangeClassIri> ?rangeClassIri }
      OPTIONAL { ?prop <${SM}mappingPattern> ?mappingPattern }
      OPTIONAL { ?prop <${SM}isRequired> ?isRequired }
    }
    ORDER BY ?name
  `);

  const classPrefix = classIri('');
  const classes: FullOntologyClass[] = classRows.map((r) => {
    const url = r['cls']?.value ?? '';
    const superClsUrl = r['superCls']?.value;
    const superClassId =
      superClsUrl && superClsUrl.startsWith(classPrefix) ? superClsUrl.slice(classPrefix.length) : undefined;
    return {
      id: url.split('/').pop() ?? url,
      url,
      name: r['name']?.value ?? '',
      label: r['label']?.value,
      description: r['description']?.value,
      mapsToConceptIri: r['mapsTo']?.value,
      superClassId,
    };
  });

  const properties: FullOntologyProperty[] = propRows.map((r) => {
    const url = r['prop']?.value ?? '';
    const domainUrl = r['domainClass']?.value;
    return {
      id: url.split('/').pop() ?? url,
      url,
      name: r['name']?.value ?? '',
      label: r['label']?.value,
      description: r['description']?.value,
      propertyType: (r['propertyType']?.value ?? 'datatype') as 'object' | 'datatype',
      domainClassId: domainUrl ? (domainUrl.split('/').pop() ?? domainUrl) : undefined,
      rangeClassIri: r['rangeClassIri']?.value,
      mappingPattern: r['mappingPattern']?.value
        ? (() => {
            try {
              return JSON.parse(r['mappingPattern']!.value) as FullTripleTemplate[];
            } catch {
              return [];
            }
          })()
        : [],
      isRequired: r['isRequired']?.value === 'true',
    };
  });

  return {
    id,
    url: sIri,
    title: meta['title']?.value ?? '',
    description: meta['description']?.value,
    upperOntologyIri: meta['upperOntologyIri']?.value,
    classes,
    properties,
  };
}
