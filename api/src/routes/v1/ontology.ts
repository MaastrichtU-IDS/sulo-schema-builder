import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Parser as N3Parser } from 'n3';
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

const SHEXR = PREFIXES.suloschemaR;

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const CreateOntologySchemaBody = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  upperOntologyIri: z.string().url().optional(),
  // Overrides the auto-generated ontology-schema/{id} namespace: when set,
  // every class/property IRI this schema mints (:ClassName, :propertyName)
  // resolves under this prefix instead. Must end in '/' or '#' for exports
  // to concatenate a local name onto it correctly — normalized on write.
  baseUri: z.string().url().optional(),
});

const UpdateOntologySchemaBody = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  upperOntologyIri: z.string().url().optional(),
  baseUri: z.string().url().optional(),
});

function normalizeBaseUri(uri: string): string {
  return /[/#]$/.test(uri) ? uri : `${uri}/`;
}

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

// ─── Helpers ────────────────────────────────────────────────────────────────

function schemaIri(id: string) { return `${SHEXR}ontology-schema/${id}`; }
function classIri(id: string) { return `${SHEXR}ontology-class/${id}`; }
function propIri(id: string) { return `${SHEXR}ontology-prop/${id}`; }

function parseJsonArray(value: string | null): unknown[] {
  if (!value) return [];
  try { return JSON.parse(value); } catch { return []; }
}

interface SchemaRow {
  id: string;
  title: string;
  description: string | null;
  upper_ontology_iri: string | null;
  base_uri: string | null;
}

interface ClassRow {
  id: string;
  schema_id: string;
  name: string;
  label: string | null;
  description: string | null;
  maps_to_concept_iri: string | null;
  super_class_id: string | null;
}

interface PropertyRow {
  id: string;
  schema_id: string;
  name: string;
  label: string | null;
  description: string | null;
  property_type: 'object' | 'datatype';
  domain_class_id: string | null;
  range_class_iri: string | null;
  mapping_pattern: string | null;
  regex_pattern: string | null;
  regex_variable: string | null;
  is_required: number;
  property_features: string | null;
  inverse_property_iri: string | null;
  disjoint_property_iris: string | null;
}

function classRowToApi(row: ClassRow) {
  return {
    id: row.id,
    url: classIri(row.id),
    name: row.name,
    label: row.label ?? undefined,
    description: row.description ?? undefined,
    mapsToConceptIri: row.maps_to_concept_iri ?? undefined,
    superClassId: row.super_class_id ?? undefined,
  };
}

function propertyRowToApi(row: PropertyRow) {
  return {
    id: row.id,
    url: propIri(row.id),
    name: row.name,
    label: row.label ?? undefined,
    description: row.description ?? undefined,
    propertyType: row.property_type,
    domainClassId: row.domain_class_id ?? undefined,
    rangeClassIri: row.range_class_iri ?? undefined,
    mappingPattern: parseJsonArray(row.mapping_pattern),
    regexPattern: row.regex_pattern ?? undefined,
    regexVariable: row.regex_variable ?? undefined,
    isRequired: row.is_required === 1,
    propertyFeatures: parseJsonArray(row.property_features),
    inversePropertyIri: row.inverse_property_iri ?? undefined,
    disjointPropertyIris: parseJsonArray(row.disjoint_property_iris),
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const ontologyRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /ontology-schemas — list all
  fastify.get('/', async () => {
    const rows = fastify.db
      .prepare('SELECT id, title, description, upper_ontology_iri, base_uri FROM schemas ORDER BY title')
      .all() as SchemaRow[];

    return rows.map((row) => ({
      id: row.id,
      url: schemaIri(row.id),
      title: row.title,
      description: row.description ?? undefined,
      upperOntologyIri: row.upper_ontology_iri ?? undefined,
      baseUri: row.base_uri ?? undefined,
    }));
  });

  // GET /ontology-schemas/:id — get one with classes and properties
  fastify.get('/:id', async (request, reply) => {
    const { id } = IdParam.parse(request.params);

    const meta = fastify.db
      .prepare('SELECT id, title, description, upper_ontology_iri, base_uri FROM schemas WHERE id = ?')
      .get(id) as SchemaRow | undefined;
    if (!meta) return reply.notFound(`OntologySchema ${id} not found`);

    const classRows = fastify.db
      .prepare('SELECT * FROM classes WHERE schema_id = ? ORDER BY name')
      .all(id) as ClassRow[];

    const propRows = fastify.db
      .prepare('SELECT * FROM properties WHERE schema_id = ? ORDER BY name')
      .all(id) as PropertyRow[];

    return {
      id,
      url: schemaIri(id),
      title: meta.title,
      description: meta.description ?? undefined,
      upperOntologyIri: meta.upper_ontology_iri ?? undefined,
      baseUri: meta.base_uri ?? undefined,
      classes: classRows.map(classRowToApi),
      properties: propRows.map(propertyRowToApi),
    };
  });

  // POST /ontology-schemas — create
  fastify.post('/', async (request, reply) => {
    const data = CreateOntologySchemaBody.parse(request.body);
    const id = randomUUID();
    const now = new Date().toISOString();
    const baseUri = data.baseUri ? normalizeBaseUri(data.baseUri) : undefined;

    fastify.db
      .prepare(`
        INSERT INTO schemas (id, title, description, upper_ontology_iri, base_uri, created_at, modified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, data.title, data.description ?? null, data.upperOntologyIri ?? null, baseUri ?? null, now, now);

    return reply.code(201).send({
      id, url: schemaIri(id), title: data.title, description: data.description,
      upperOntologyIri: data.upperOntologyIri, baseUri, classes: [], properties: [],
    });
  });

  // PATCH /ontology-schemas/:id — update title/description/upperOntologyIri
  fastify.patch('/:id', async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    const data = UpdateOntologySchemaBody.parse(request.body);
    const now = new Date().toISOString();

    const sets: string[] = ['modified_at = ?'];
    const params: unknown[] = [now];

    if (data.title !== undefined) { sets.push('title = ?'); params.push(data.title); }
    if (data.description !== undefined) { sets.push('description = ?'); params.push(data.description); }
    if (data.upperOntologyIri !== undefined) { sets.push('upper_ontology_iri = ?'); params.push(data.upperOntologyIri); }
    if (data.baseUri !== undefined) { sets.push('base_uri = ?'); params.push(normalizeBaseUri(data.baseUri)); }

    fastify.db
      .prepare(`UPDATE schemas SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, id);

    return reply.code(204).send();
  });

  // DELETE /ontology-schemas/:id — delete schema and all its classes/properties
  fastify.delete('/:id', async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    fastify.db.prepare('DELETE FROM schemas WHERE id = ?').run(id);
    return reply.code(204).send();
  });

  // GET /ontology-schemas/:id/upper-concepts — fetch owl:Class list from the upper ontology
  fastify.get('/:id/upper-concepts', async (request) => {
    const { id } = IdParam.parse(request.params);

    const row = fastify.db
      .prepare('SELECT upper_ontology_iri FROM schemas WHERE id = ?')
      .get(id) as { upper_ontology_iri: string | null } | undefined;
    if (!row?.upper_ontology_iri) return [];

    return fetchUpperConcepts(row.upper_ontology_iri);
  });

  // POST /ontology-schemas/:id/classes — add a class
  fastify.post('/:id/classes', async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    const data = AddClassBody.parse(request.body);
    const classId = randomUUID();

    fastify.db
      .prepare(`
        INSERT INTO classes (id, schema_id, name, label, description, maps_to_concept_iri, super_class_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        classId, id, data.name, data.label ?? null, data.description ?? null,
        data.mapsToConceptIri ?? null, data.superClassId ?? null,
      );

    return reply.code(201).send({
      id: classId,
      url: classIri(classId),
      name: data.name,
      label: data.label,
      description: data.description,
      mapsToConceptIri: data.mapsToConceptIri,
      superClassId: data.superClassId,
    });
  });

  // PATCH /ontology-schemas/:id/classes/:classId — update a class
  fastify.patch('/:id/classes/:classId', async (request, reply) => {
    const { classId } = ClassIdParam.parse(request.params);
    const data = UpdateClassBody.parse(request.body);

    const sets: string[] = [];
    const params: unknown[] = [];

    if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
    if (data.label !== undefined) { sets.push('label = ?'); params.push(data.label || null); }
    if (data.description !== undefined) { sets.push('description = ?'); params.push(data.description || null); }
    if (data.mapsToConceptIri !== undefined) { sets.push('maps_to_concept_iri = ?'); params.push(data.mapsToConceptIri || null); }
    if (data.superClassId !== undefined) { sets.push('super_class_id = ?'); params.push(data.superClassId || null); }

    if (sets.length) {
      fastify.db
        .prepare(`UPDATE classes SET ${sets.join(', ')} WHERE id = ?`)
        .run(...params, classId);
    }
    return reply.code(204).send();
  });

  // PATCH /ontology-schemas/:id/properties/:propId — update a property
  fastify.patch('/:id/properties/:propId', async (request, reply) => {
    const { propId } = PropIdParam.parse(request.params);
    const data = UpdatePropertyBody.parse(request.body);

    const sets: string[] = [];
    const params: unknown[] = [];

    if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
    if (data.label !== undefined) { sets.push('label = ?'); params.push(data.label || null); }
    if (data.description !== undefined) { sets.push('description = ?'); params.push(data.description || null); }
    if (data.propertyType !== undefined) { sets.push('property_type = ?'); params.push(data.propertyType); }
    if (data.isRequired !== undefined) { sets.push('is_required = ?'); params.push(data.isRequired ? 1 : 0); }
    if (data.domainClassId !== undefined) { sets.push('domain_class_id = ?'); params.push(data.domainClassId || null); }
    if (data.rangeClassIri !== undefined) { sets.push('range_class_iri = ?'); params.push(data.rangeClassIri || null); }
    if (data.mappingPattern !== undefined) {
      sets.push('mapping_pattern = ?');
      params.push(data.mappingPattern.length > 0 ? JSON.stringify(data.mappingPattern) : null);
    }
    if (data.regexPattern !== undefined) { sets.push('regex_pattern = ?'); params.push(data.regexPattern || null); }
    if (data.regexVariable !== undefined) { sets.push('regex_variable = ?'); params.push(data.regexVariable || null); }
    if (data.propertyFeatures !== undefined) {
      sets.push('property_features = ?');
      params.push(data.propertyFeatures.length > 0 ? JSON.stringify(data.propertyFeatures) : null);
    }
    if (data.inversePropertyIri !== undefined) { sets.push('inverse_property_iri = ?'); params.push(data.inversePropertyIri || null); }
    if (data.disjointPropertyIris !== undefined) {
      sets.push('disjoint_property_iris = ?');
      params.push(data.disjointPropertyIris.length > 0 ? JSON.stringify(data.disjointPropertyIris) : null);
    }

    if (sets.length) {
      fastify.db
        .prepare(`UPDATE properties SET ${sets.join(', ')} WHERE id = ?`)
        .run(...params, propId);
    }
    return reply.code(204).send();
  });

  // DELETE /ontology-schemas/:id/classes/:classId — remove a class
  fastify.delete('/:id/classes/:classId', async (request, reply) => {
    const { classId } = ClassIdParam.parse(request.params);
    fastify.db.prepare('DELETE FROM classes WHERE id = ?').run(classId);
    return reply.code(204).send();
  });

  // POST /ontology-schemas/:id/properties — add a property
  fastify.post('/:id/properties', async (request, reply) => {
    const { id } = IdParam.parse(request.params);
    const data = AddPropertyBody.parse(request.body);
    const propId = randomUUID();

    fastify.db
      .prepare(`
        INSERT INTO properties (
          id, schema_id, name, label, description, property_type,
          domain_class_id, range_class_iri, mapping_pattern,
          regex_pattern, regex_variable, is_required,
          property_features, inverse_property_iri, disjoint_property_iris
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        propId, id, data.name, data.label ?? null, data.description ?? null, data.propertyType,
        data.domainClassId ?? null, data.rangeClassIri ?? null,
        data.mappingPattern && data.mappingPattern.length > 0 ? JSON.stringify(data.mappingPattern) : null,
        data.regexPattern ?? null, data.regexVariable ?? null, data.isRequired ? 1 : 0,
        data.propertyFeatures && data.propertyFeatures.length > 0 ? JSON.stringify(data.propertyFeatures) : null,
        data.inversePropertyIri ?? null,
        data.disjointPropertyIris && data.disjointPropertyIris.length > 0 ? JSON.stringify(data.disjointPropertyIris) : null,
      );

    return reply.code(201).send({
      id: propId,
      url: propIri(propId),
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
    const { propId } = PropIdParam.parse(request.params);
    fastify.db.prepare('DELETE FROM properties WHERE id = ?').run(propId);
    return reply.code(204).send();
  });

};

export default ontologyRoutes;
