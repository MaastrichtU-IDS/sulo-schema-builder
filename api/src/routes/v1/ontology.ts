import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Parser as N3Parser } from 'n3';
import { sparqlSelect, sparqlUpdate } from '../../services/sparql.service.js';
import { fetchFullSchema } from '../../services/schema.service.js';
import { PREFIXES } from '../../rdf/prefixes.js';
import { randomUUID } from 'crypto';

// ─── Upper concept fetcher ────────────────────────────────────────────────────

const OWL_CLASS     = 'http://www.w3.org/2002/07/owl#Class';
const RDFS_CLASS    = 'http://www.w3.org/2000/01/rdf-schema#Class';
const OWL_OBJ_PROP  = 'http://www.w3.org/2002/07/owl#ObjectProperty';
const OWL_DATA_PROP = 'http://www.w3.org/2002/07/owl#DatatypeProperty';
const RDF_PROPERTY  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#Property';
const RDF_TYPE      = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL    = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDFS_COMMENT  = 'http://www.w3.org/2000/01/rdf-schema#comment';

interface UpperConcept {
  iri: string;
  localName: string;
  type: 'class' | 'property';
  label?: string;
  comment?: string;
}

async function fetchUpperConcepts(ontologyIri: string): Promise<UpperConcept[]> {
  let text: string;
  let format: string;

  try {
    const res = await fetch(ontologyIri, {
      headers: { Accept: 'text/turtle;q=1, application/n-triples;q=0.9, text/n3;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    text = await res.text();
    const ct = res.headers.get('content-type') ?? '';
    format = ct.includes('n-triples') ? 'N-Triples'
           : ct.includes('n3')        ? 'N3'
           : 'Turtle';
  } catch {
    return [];
  }

  try {
    const parser = new N3Parser({ format });
    const quads  = parser.parse(text);

    const conceptTypes = new Map<string, 'class' | 'property'>();
    const labels       = new Map<string, string>();
    const comments     = new Map<string, string>();

    for (const quad of quads) {
      const s = quad.subject.termType === 'NamedNode' ? quad.subject.value : null;
      if (!s) continue;

      if (quad.predicate.value === RDF_TYPE) {
        const o = quad.object.value;
        if (o === OWL_CLASS || o === RDFS_CLASS) {
          if (!conceptTypes.has(s)) conceptTypes.set(s, 'class');
        } else if (o === OWL_OBJ_PROP || o === OWL_DATA_PROP || o === RDF_PROPERTY) {
          conceptTypes.set(s, 'property');
        }
      }
      if (quad.predicate.value === RDFS_LABEL) {
        if (!labels.has(s) || ('language' in quad.object && quad.object.language === 'en')) {
          labels.set(s, quad.object.value);
        }
      }
      if (quad.predicate.value === RDFS_COMMENT && !comments.has(s)) {
        comments.set(s, quad.object.value);
      }
    }

    return [...conceptTypes.entries()]
      .map(([iri, type]) => ({
        iri,
        type,
        localName: iri.split(/[/#]/).pop() ?? iri,
        label:   labels.get(iri),
        comment: comments.get(iri),
      }))
      .sort((a, b) => (a.label ?? a.localName).localeCompare(b.label ?? b.localName));
  } catch {
    return [];
  }
}

const SM = PREFIXES.suloschema;
const DCT = PREFIXES.dct;
const RDF = PREFIXES.rdf;
const XSD = PREFIXES.xsd;
const SHEXR = PREFIXES.suloschemaR;

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const CreateOntologySchemaBody = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  upperOntologyIri: z.string().url().optional(),
});

const UpdateOntologySchemaBody = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  upperOntologyIri: z.string().url().optional(),
});

const AddClassBody = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  mapsToConceptIri: z.string().url().optional(),
  superClassId: z.string().optional(),   // UUID of the parent class within this schema
});

const TripleTemplateBody = z.object({
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
});

const PropertyFeatureEnum = z.enum([
  'functional', 'inverseFunctional',
  'transitive', 'symmetric', 'asymmetric',
  'reflexive', 'irreflexive',
]);

const AddPropertyBody = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  propertyType: z.enum(['object', 'datatype']).default('datatype'),
  domainClassId: z.string().optional(),
  rangeClassIri: z.string().optional(),
  mappingPattern: z.array(TripleTemplateBody).optional(),
  regexPattern: z.string().optional(),
  regexVariable: z.string().optional(),
  isRequired: z.boolean().default(false),
  propertyFeatures: z.array(PropertyFeatureEnum).optional(),
  inversePropertyIri: z.string().optional(),
  disjointPropertyIris: z.array(z.string()).optional(),
});

const UpdateClassBody = z.object({
  name: z.string().min(1).optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  mapsToConceptIri: z.string().optional(),   // '' = remove mapping
  superClassId: z.string().optional(),        // '' = remove superclass
});

const UpdatePropertyBody = z.object({
  name: z.string().min(1).optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  propertyType: z.enum(['object', 'datatype']).optional(),
  domainClassId: z.string().optional(),
  rangeClassIri: z.string().optional(),
  mappingPattern: z.array(TripleTemplateBody).optional(),
  regexPattern: z.string().optional(),
  regexVariable: z.string().optional(),
  isRequired: z.boolean().optional(),
  propertyFeatures: z.array(PropertyFeatureEnum).optional(),
  inversePropertyIri: z.string().optional(),
  disjointPropertyIris: z.array(z.string()).optional(),
});

const IdParam = z.object({ id: z.string().min(1) });
const ClassIdParam = z.object({ id: z.string().min(1), classId: z.string().min(1) });
const PropIdParam = z.object({ id: z.string().min(1), propId: z.string().min(1) });

// ─── Helper ───────────────────────────────────────────────────────────────────

function schemaIri(id: string) { return `${SHEXR}ontology-schema/${id}`; }
function classIri(id: string) { return `${SHEXR}ontology-class/${id}`; }
function propIri(id: string) { return `${SHEXR}ontology-prop/${id}`; }
function lit(s: string) { return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"^^<${XSD}string>`; }
function iri(s: string) { return `<${s}>`; }

// ─── Routes ───────────────────────────────────────────────────────────────────

const ontologyRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /ontology-schemas — list all
  fastify.get('/', async () => {
    const sparql = `
      SELECT ?schema ?title ?description ?upperOntologyIri
      WHERE {
        ?schema a <${SM}OntologySchema> .
        OPTIONAL { ?schema <${DCT}title> ?title }
        OPTIONAL { ?schema <${DCT}description> ?description }
        OPTIONAL { ?schema <${SM}upperOntologyIri> ?upperOntologyIri }
      }
      ORDER BY ?title
    `;
    const rows = await sparqlSelect(fastify, sparql);
    return rows.map((row) => {
      const url = row['schema']?.value ?? '';
      return {
        id: url.split('/').pop() ?? url,
        url,
        title: row['title']?.value ?? '',
        description: row['description']?.value,
        upperOntologyIri: row['upperOntologyIri']?.value,
      };
    });
  });

  // GET /ontology-schemas/:id — get one with classes and properties
  fastify.get('/:id', async (request, reply) => {
    const { id } = IdParam.parse(request.params);

    // The full-schema fetch (metadata + classes + properties) is shared with
    // schemaMatching.service.ts, which needs to fetch two schemas the same way.
    const schema = await fetchFullSchema(fastify, id);
    if (!schema) return reply.notFound(`OntologySchema ${id} not found`);

    // This route additionally reports propertyFeatures/inverse/disjoint —
    // fields fetchFullSchema() doesn't need for shape-matching purposes —
    // fetched here as a second, targeted pass keyed by the property IRIs
    // fetchFullSchema() already resolved.
    const extraRows = await sparqlSelect(fastify, `
      SELECT ?prop ?regexPattern ?regexVariable ?propertyFeatures ?inversePropertyIri ?disjointPropertyIris
      WHERE {
        ${iri(schema.url)} <${SM}hasOntologyProperty> ?prop .
        OPTIONAL { ?prop <${SM}regexPattern> ?regexPattern }
        OPTIONAL { ?prop <${SM}regexVariable> ?regexVariable }
        OPTIONAL { ?prop <${SM}propertyFeatures> ?propertyFeatures }
        OPTIONAL { ?prop <${SM}inversePropertyIri> ?inversePropertyIri }
        OPTIONAL { ?prop <${SM}disjointPropertyIris> ?disjointPropertyIris }
      }
    `);
    const extraByUrl = new Map(extraRows.map((r) => [r['prop']?.value, r]));

    const properties = schema.properties.map((p) => {
      const r = extraByUrl.get(p.url);
      return {
        ...p,
        regexPattern: r?.['regexPattern']?.value,
        regexVariable: r?.['regexVariable']?.value,
        propertyFeatures: r?.['propertyFeatures']?.value
          ? (() => { try { return JSON.parse(r['propertyFeatures']!.value); } catch { return []; } })()
          : [],
        inversePropertyIri: r?.['inversePropertyIri']?.value,
        disjointPropertyIris: r?.['disjointPropertyIris']?.value
          ? (() => { try { return JSON.parse(r['disjointPropertyIris']!.value); } catch { return []; } })()
          : [],
      };
    });

    return { ...schema, properties };
  });

  // POST /ontology-schemas — create
  fastify.post('/', async (request, reply) => {
    const data = CreateOntologySchemaBody.parse(request.body);
    const id = randomUUID();
    const sIri = schemaIri(id);
    const now = new Date().toISOString();

    let triples = `
      ${iri(sIri)} a <${SM}OntologySchema> ;
        <${DCT}title> ${lit(data.title)} ;
        <${DCT}created> "${now}"^^<${XSD}dateTime> ;
        <${DCT}modified> "${now}"^^<${XSD}dateTime> .
    `;
    if (data.description) {
      triples += `\n      ${iri(sIri)} <${DCT}description> ${lit(data.description)} .`;
    }
    if (data.upperOntologyIri) {
      triples += `\n      ${iri(sIri)} <${SM}upperOntologyIri> ${iri(data.upperOntologyIri)} .`;
    }

    await sparqlUpdate(fastify, `INSERT DATA { ${triples} }`);
    return reply.code(201).send({ id, url: sIri, title: data.title, description: data.description, upperOntologyIri: data.upperOntologyIri, classes: [], properties: [] });
  });

  // PATCH /ontology-schemas/:id — update title/description/upperOntologyIri
  fastify.patch('/:id', async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    const data = UpdateOntologySchemaBody.parse(request.body);
    const sIri = schemaIri(id);
    const now = new Date().toISOString();

    // Build individual DELETE+INSERT statements for each field being updated
    const stmts: string[] = [];

    if (data.title !== undefined) {
      stmts.push(`
        DELETE { ${iri(sIri)} <${DCT}title> ?v }
        INSERT { ${iri(sIri)} <${DCT}title> ${lit(data.title)} }
        WHERE  { OPTIONAL { ${iri(sIri)} <${DCT}title> ?v } }
      `);
    }
    if (data.description !== undefined) {
      stmts.push(`
        DELETE { ${iri(sIri)} <${DCT}description> ?v }
        INSERT { ${iri(sIri)} <${DCT}description> ${lit(data.description)} }
        WHERE  { OPTIONAL { ${iri(sIri)} <${DCT}description> ?v } }
      `);
    }
    if (data.upperOntologyIri !== undefined) {
      stmts.push(`
        DELETE { ${iri(sIri)} <${SM}upperOntologyIri> ?v }
        INSERT { ${iri(sIri)} <${SM}upperOntologyIri> ${iri(data.upperOntologyIri)} }
        WHERE  { OPTIONAL { ${iri(sIri)} <${SM}upperOntologyIri> ?v } }
      `);
    }
    stmts.push(`
      DELETE { ${iri(sIri)} <${DCT}modified> ?v }
      INSERT { ${iri(sIri)} <${DCT}modified> "${now}"^^<${XSD}dateTime> }
      WHERE  { OPTIONAL { ${iri(sIri)} <${DCT}modified> ?v } }
    `);

    // Execute all statements as a SPARQL Update sequence (semicolon-separated)
    await sparqlUpdate(fastify, stmts.join(';\n'));

    return reply.code(204).send();
  });

  // DELETE /ontology-schemas/:id — delete schema and all its classes/properties
  fastify.delete('/:id', async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    const sIri = schemaIri(id);

    await sparqlUpdate(fastify, `
      DELETE { ?s ?p ?o }
      WHERE {
        { ${iri(sIri)} ?p ?o . BIND(${iri(sIri)} AS ?s) }
        UNION
        { ${iri(sIri)} <${SM}hasClass> ?s . ?s ?p ?o }
        UNION
        { ${iri(sIri)} <${SM}hasOntologyProperty> ?s . ?s ?p ?o }
      }
    `);
    return reply.code(204).send();
  });

  // GET /ontology-schemas/:id/upper-concepts — fetch owl:Class list from the upper ontology
  fastify.get('/:id/upper-concepts', async (request) => {
    const { id } = IdParam.parse(request.params);
    const sIri = schemaIri(id);

    const rows = await sparqlSelect(fastify, `
      SELECT ?upper WHERE { ${iri(sIri)} <${SM}upperOntologyIri> ?upper } LIMIT 1
    `);
    const upperIri = rows[0]?.['upper']?.value;
    if (!upperIri) return [];

    return fetchUpperConcepts(upperIri);
  });

  // POST /ontology-schemas/:id/classes — add a class
  fastify.post('/:id/classes', async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    const data = AddClassBody.parse(request.body);
    const sIri = schemaIri(id);
    const classId = randomUUID();
    const cIri = classIri(classId);

    let triples = `
      ${iri(cIri)} a <${SM}OntologyClass> ;
        <${DCT}identifier> ${lit(data.name)} .
      ${iri(sIri)} <${SM}hasClass> ${iri(cIri)} .
    `;
    if (data.label) {
      triples += `\n      ${iri(cIri)} <http://www.w3.org/2000/01/rdf-schema#label> ${lit(data.label)} .`;
    }
    if (data.description) {
      triples += `\n      ${iri(cIri)} <${DCT}description> ${lit(data.description)} .`;
    }
    if (data.mapsToConceptIri) {
      triples += `\n      ${iri(cIri)} <${SM}mapsToConcept> ${iri(data.mapsToConceptIri)} .`;
    }
    if (data.superClassId) {
      triples += `\n      ${iri(cIri)} <${SM}superClass> ${iri(classIri(data.superClassId))} .`;
    }

    await sparqlUpdate(fastify, `INSERT DATA { ${triples} }`);
    return reply.code(201).send({
      id: classId,
      url: cIri,
      name: data.name,
      label: data.label,
      description: data.description,
      mapsToConceptIri: data.mapsToConceptIri,
      superClassId: data.superClassId,
    });
  });

  // ─── SPARQL field-level helper ───────────────────────────────────────────────
  function setOrDelete(sIri: string, pred: string, value: string | null, asIri = false): string {
    const s = iri(sIri);
    const p = `<${pred}>`;
    const o = value ? (asIri ? iri(value) : lit(value)) : null;
    return o
      ? `DELETE { ${s} ${p} ?v } INSERT { ${s} ${p} ${o} } WHERE { OPTIONAL { ${s} ${p} ?v } }`
      : `DELETE { ${s} ${p} ?v } WHERE { OPTIONAL { ${s} ${p} ?v } }`;
  }

  // PATCH /ontology-schemas/:id/classes/:classId — update a class
  fastify.patch('/:id/classes/:classId', async (request, reply) => {
    const { classId } = ClassIdParam.parse(request.params);
    const data = UpdateClassBody.parse(request.body);
    const cIri = classIri(classId);
    const stmts: string[] = [];

    if (data.name !== undefined)
      stmts.push(setOrDelete(cIri, `${DCT}identifier`, data.name || null));
    if (data.label !== undefined)
      stmts.push(setOrDelete(cIri, 'http://www.w3.org/2000/01/rdf-schema#label', data.label || null));
    if (data.description !== undefined)
      stmts.push(setOrDelete(cIri, `${DCT}description`, data.description || null));
    if (data.mapsToConceptIri !== undefined)
      stmts.push(setOrDelete(cIri, `${SM}mapsToConcept`, data.mapsToConceptIri || null, true));
    if (data.superClassId !== undefined)
      stmts.push(setOrDelete(cIri, `${SM}superClass`,
        data.superClassId ? classIri(data.superClassId) : null, true));

    if (stmts.length) await sparqlUpdate(fastify, stmts.join(';\n'));
    return reply.code(204).send();
  });

  // PATCH /ontology-schemas/:id/properties/:propId — update a property
  fastify.patch('/:id/properties/:propId', async (request, reply) => {
    const { id, propId } = PropIdParam.parse(request.params);
    const data = UpdatePropertyBody.parse(request.body);
    const pIri = propIri(propId);
    const stmts: string[] = [];

    if (data.name !== undefined)
      stmts.push(setOrDelete(pIri, `${DCT}identifier`, data.name || null));
    if (data.label !== undefined)
      stmts.push(setOrDelete(pIri, 'http://www.w3.org/2000/01/rdf-schema#label', data.label || null));
    if (data.description !== undefined)
      stmts.push(setOrDelete(pIri, `${DCT}description`, data.description || null));
    if (data.propertyType !== undefined)
      stmts.push(setOrDelete(pIri, `${SM}propertyType`, data.propertyType));
    if (data.isRequired !== undefined)
      stmts.push(setOrDelete(pIri, `${SM}isRequired`, String(data.isRequired)));
    if (data.domainClassId !== undefined) {
      const domIri = data.domainClassId ? classIri(data.domainClassId) : null;
      stmts.push(setOrDelete(pIri, `${SM}domainClass`, domIri, true));
    }
    if (data.rangeClassIri !== undefined)
      stmts.push(setOrDelete(pIri, `${SM}rangeClassIri`, data.rangeClassIri || null, true));
    if (data.mappingPattern !== undefined) {
      const json = data.mappingPattern.length > 0 ? JSON.stringify(data.mappingPattern) : null;
      stmts.push(setOrDelete(pIri, `${SM}mappingPattern`, json));
    }
    if (data.regexPattern !== undefined)
      stmts.push(setOrDelete(pIri, `${SM}regexPattern`, data.regexPattern || null));
    if (data.regexVariable !== undefined)
      stmts.push(setOrDelete(pIri, `${SM}regexVariable`, data.regexVariable || null));
    if (data.propertyFeatures !== undefined) {
      const json = data.propertyFeatures.length > 0 ? JSON.stringify(data.propertyFeatures) : null;
      stmts.push(setOrDelete(pIri, `${SM}propertyFeatures`, json));
    }
    if (data.inversePropertyIri !== undefined)
      stmts.push(setOrDelete(pIri, `${SM}inversePropertyIri`, data.inversePropertyIri || null, true));
    if (data.disjointPropertyIris !== undefined) {
      const json = data.disjointPropertyIris.length > 0 ? JSON.stringify(data.disjointPropertyIris) : null;
      stmts.push(setOrDelete(pIri, `${SM}disjointPropertyIris`, json));
    }

    if (stmts.length) await sparqlUpdate(fastify, stmts.join(';\n'));
    return reply.code(204).send();
  });

  // DELETE /ontology-schemas/:id/classes/:classId — remove a class
  fastify.delete('/:id/classes/:classId', async (request, reply) => {
    const { id, classId } = ClassIdParam.parse(request.params);
    const sIri = schemaIri(id);
    const cIri = classIri(classId);

    await sparqlUpdate(fastify, `
      DELETE { ?s ?p ?o }
      WHERE {
        { ${iri(cIri)} ?p ?o . BIND(${iri(cIri)} AS ?s) }
        UNION
        { BIND(${iri(sIri)} AS ?s) . ?s <${SM}hasClass> ${iri(cIri)} . BIND(<${SM}hasClass> AS ?p) . BIND(${iri(cIri)} AS ?o) }
      }
    `);
    return reply.code(204).send();
  });

  // POST /ontology-schemas/:id/properties — add a property
  fastify.post('/:id/properties', async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    const data = AddPropertyBody.parse(request.body);
    const sIri = schemaIri(id);
    const propId = randomUUID();
    const pIri = propIri(propId);
    const domainIri = data.domainClassId ? classIri(data.domainClassId) : null;

    let triples = `
      ${iri(pIri)} a <${SM}OntologyProperty> ;
        <${DCT}identifier> ${lit(data.name)} ;
        <${SM}propertyType> ${lit(data.propertyType)} ;
        <${SM}isRequired> "${data.isRequired}"^^<${XSD}boolean> .
      ${iri(sIri)} <${SM}hasOntologyProperty> ${iri(pIri)} .
    `;
    if (data.label) {
      triples += `\n      ${iri(pIri)} <http://www.w3.org/2000/01/rdf-schema#label> ${lit(data.label)} .`;
    }
    if (data.description) {
      triples += `\n      ${iri(pIri)} <${DCT}description> ${lit(data.description)} .`;
    }
    if (domainIri) {
      triples += `\n      ${iri(pIri)} <${SM}domainClass> ${iri(domainIri)} .`;
    }
    if (data.rangeClassIri) {
      triples += `\n      ${iri(pIri)} <${SM}rangeClassIri> ${iri(data.rangeClassIri)} .`;
    }
    if (data.mappingPattern && data.mappingPattern.length > 0) {
      triples += `\n      ${iri(pIri)} <${SM}mappingPattern> ${lit(JSON.stringify(data.mappingPattern))} .`;
    }
    if (data.regexPattern) {
      triples += `\n      ${iri(pIri)} <${SM}regexPattern> ${lit(data.regexPattern)} .`;
    }
    if (data.regexVariable) {
      triples += `\n      ${iri(pIri)} <${SM}regexVariable> ${lit(data.regexVariable)} .`;
    }
    if (data.propertyFeatures && data.propertyFeatures.length > 0) {
      triples += `\n      ${iri(pIri)} <${SM}propertyFeatures> ${lit(JSON.stringify(data.propertyFeatures))} .`;
    }
    if (data.inversePropertyIri) {
      triples += `\n      ${iri(pIri)} <${SM}inversePropertyIri> ${iri(data.inversePropertyIri)} .`;
    }
    if (data.disjointPropertyIris && data.disjointPropertyIris.length > 0) {
      triples += `\n      ${iri(pIri)} <${SM}disjointPropertyIris> ${lit(JSON.stringify(data.disjointPropertyIris))} .`;
    }

    await sparqlUpdate(fastify, `INSERT DATA { ${triples} }`);
    return reply.code(201).send({
      id: propId,
      url: pIri,
      name: data.name,
      label: data.label,
      description: data.description,
      propertyType: data.propertyType,
      domainClassId: data.domainClassId,
      rangeClassIri: data.rangeClassIri,
      mappingPattern: data.mappingPattern ?? [],
      regexPattern: data.regexPattern,
      regexVariable: data.regexVariable,
      isRequired: data.isRequired,
      propertyFeatures: data.propertyFeatures ?? [],
      inversePropertyIri: data.inversePropertyIri,
      disjointPropertyIris: data.disjointPropertyIris ?? [],
    });
  });

  // DELETE /ontology-schemas/:id/properties/:propId — remove a property
  fastify.delete('/:id/properties/:propId', async (request, reply) => {
    const { id, propId } = PropIdParam.parse(request.params);
    const sIri = schemaIri(id);
    const pIri = propIri(propId);

    await sparqlUpdate(fastify, `
      DELETE { ?s ?p ?o }
      WHERE {
        { ${iri(pIri)} ?p ?o . BIND(${iri(pIri)} AS ?s) }
        UNION
        { BIND(${iri(sIri)} AS ?s) . ?s <${SM}hasOntologyProperty> ${iri(pIri)} . BIND(<${SM}hasOntologyProperty> AS ?p) . BIND(${iri(pIri)} AS ?o) }
      }
    `);
    return reply.code(204).send();
  });

};

export default ontologyRoutes;
