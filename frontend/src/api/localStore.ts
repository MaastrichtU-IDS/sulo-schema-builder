// Browser-side schema persistence (IndexedDB via Dexie).
//
// In browser storage mode the server keeps no schema state, and this module is
// the drop-in replacement for the REST CRUD surface: every function mirrors
// the corresponding route in api/src/routes/v1/ontology.ts — same shapes, same
// IRI minting, same PATCH semantics ('' clears a field), same delete side
// effects (cascade to classes/properties; orphaned superClassId/domainClassId
// references are nulled, as the server's foreign keys do).

import Dexie, { type Table } from 'dexie';
import type {
  OntologyClass,
  OntologyProperty,
  OntologySchema,
  OntologySchemaSummary,
  PropertyFeature,
  TripleTemplate,
} from './ontology.js';

// Must mint the same IRIs as the server (api/src/rdf/prefixes.ts +
// routes/v1/ontology.ts): the exports embed them, and cross-references
// (rangeClassIri, mapping patterns) store them verbatim.
const BASE = (import.meta.env.VITE_BASE_NAMESPACE as string | undefined) ?? 'https://w3id.org/sulo/schema/';
const SHEXR = `${BASE}resource/`;

export function schemaIri(id: string) { return `${SHEXR}ontology-schema/${id}`; }
export function classIri(id: string) { return `${SHEXR}ontology-class/${id}`; }
export function propIri(id: string) { return `${SHEXR}ontology-prop/${id}`; }

// ─── Database ────────────────────────────────────────────────────────────────

interface SchemaRow {
  id: string;
  title: string;
  description?: string;
  upperOntologyIri?: string;
  baseUri?: string;
  createdAt: string;
  modifiedAt: string;
}

interface ClassRow {
  id: string;
  schemaId: string;
  name: string;
  label?: string;
  description?: string;
  mapsToConceptIri?: string;
  superClassId?: string;
}

interface PropertyRow {
  id: string;
  schemaId: string;
  name: string;
  label?: string;
  description?: string;
  propertyType: 'object' | 'datatype';
  domainClassId?: string;
  rangeClassIri?: string;
  mappingPattern: TripleTemplate[];
  regexPattern?: string;
  regexVariable?: string;
  isRequired: boolean;
  propertyFeatures: PropertyFeature[];
  inversePropertyIri?: string;
  disjointPropertyIris: string[];
}

class SchemaBuilderDB extends Dexie {
  schemas!: Table<SchemaRow, string>;
  classes!: Table<ClassRow, string>;
  properties!: Table<PropertyRow, string>;

  constructor() {
    super('sulo-schema-builder');
    this.version(1).stores({
      schemas: 'id, title',
      classes: 'id, schemaId',
      properties: 'id, schemaId',
    });
  }
}

const db = new SchemaBuilderDB();

function normalizeBaseUri(uri: string): string {
  return /[/#]$/.test(uri) ? uri : `${uri}/`;
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}

function classToApi(row: ClassRow): OntologyClass {
  return {
    id: row.id,
    url: classIri(row.id),
    name: row.name,
    label: row.label,
    description: row.description,
    mapsToConceptIri: row.mapsToConceptIri,
    superClassId: row.superClassId,
  };
}

function propToApi(row: PropertyRow): OntologyProperty {
  return {
    id: row.id,
    url: propIri(row.id),
    name: row.name,
    label: row.label,
    description: row.description,
    propertyType: row.propertyType,
    domainClassId: row.domainClassId,
    rangeClassIri: row.rangeClassIri,
    mappingPattern: row.mappingPattern ?? [],
    regexPattern: row.regexPattern,
    regexVariable: row.regexVariable,
    isRequired: row.isRequired,
    propertyFeatures: row.propertyFeatures ?? [],
    inversePropertyIri: row.inversePropertyIri,
    disjointPropertyIris: row.disjointPropertyIris ?? [],
  };
}

// '' in a PATCH clears the field (same convention as the REST routes).
function patched(current: string | undefined, incoming: string | undefined): string | undefined {
  if (incoming === undefined) return current;
  return incoming === '' ? undefined : incoming;
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

export async function listSchemas(): Promise<OntologySchemaSummary[]> {
  const rows = await db.schemas.toArray();
  return rows
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((row) => ({
      id: row.id,
      url: schemaIri(row.id),
      title: row.title,
      description: row.description,
      upperOntologyIri: row.upperOntologyIri,
      baseUri: row.baseUri,
    }));
}

export async function getSchema(id: string): Promise<OntologySchema> {
  const row = await db.schemas.get(id);
  if (!row) throw new Error(`OntologySchema ${id} not found`);
  const [classRows, propRows] = await Promise.all([
    db.classes.where('schemaId').equals(id).toArray(),
    db.properties.where('schemaId').equals(id).toArray(),
  ]);
  return {
    id,
    url: schemaIri(id),
    title: row.title,
    description: row.description,
    upperOntologyIri: row.upperOntologyIri,
    baseUri: row.baseUri,
    classes: classRows.sort(byName).map(classToApi),
    properties: propRows.sort(byName).map(propToApi),
  };
}

export async function createSchema(data: {
  title: string;
  description?: string;
  upperOntologyIri?: string;
  baseUri?: string;
}): Promise<OntologySchema> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const baseUri = data.baseUri ? normalizeBaseUri(data.baseUri) : undefined;
  await db.schemas.add({
    id,
    title: data.title,
    description: data.description,
    upperOntologyIri: data.upperOntologyIri,
    baseUri,
    createdAt: now,
    modifiedAt: now,
  });
  return {
    id,
    url: schemaIri(id),
    title: data.title,
    description: data.description,
    upperOntologyIri: data.upperOntologyIri,
    baseUri,
    classes: [],
    properties: [],
  };
}

export async function updateSchema(id: string, data: {
  title?: string;
  description?: string;
  upperOntologyIri?: string;
  baseUri?: string;
}): Promise<void> {
  await db.transaction('rw', db.schemas, async () => {
    const row = await db.schemas.get(id);
    if (!row) return;
    if (data.title !== undefined) row.title = data.title;
    if (data.description !== undefined) row.description = data.description;
    if (data.upperOntologyIri !== undefined) row.upperOntologyIri = data.upperOntologyIri;
    if (data.baseUri !== undefined) row.baseUri = normalizeBaseUri(data.baseUri);
    row.modifiedAt = new Date().toISOString();
    await db.schemas.put(row);
  });
}

export async function deleteSchema(id: string): Promise<void> {
  await db.transaction('rw', [db.schemas, db.classes, db.properties], async () => {
    await db.classes.where('schemaId').equals(id).delete();
    await db.properties.where('schemaId').equals(id).delete();
    await db.schemas.delete(id);
  });
}

// ─── Classes ─────────────────────────────────────────────────────────────────

export async function addClass(schemaId: string, data: {
  name: string;
  label?: string;
  description?: string;
  mapsToConceptIri?: string;
  superClassId?: string;
}): Promise<OntologyClass> {
  const id = crypto.randomUUID();
  const row: ClassRow = { id, schemaId, ...data };
  await db.classes.add(row);
  return classToApi(row);
}

export async function updateClass(_schemaId: string, classId: string, data: {
  name?: string;
  label?: string;
  description?: string;
  mapsToConceptIri?: string;
  superClassId?: string;
}): Promise<void> {
  await db.transaction('rw', db.classes, async () => {
    const row = await db.classes.get(classId);
    if (!row) return;
    if (data.name !== undefined) row.name = data.name;
    row.label = patched(row.label, data.label);
    row.description = patched(row.description, data.description);
    row.mapsToConceptIri = patched(row.mapsToConceptIri, data.mapsToConceptIri);
    row.superClassId = patched(row.superClassId, data.superClassId);
    await db.classes.put(row);
  });
}

export async function deleteClass(schemaId: string, classId: string): Promise<void> {
  await db.transaction('rw', [db.classes, db.properties], async () => {
    await db.classes.delete(classId);
    // Mirror the server's ON DELETE SET NULL foreign keys.
    await db.classes.where('schemaId').equals(schemaId).modify((c) => {
      if (c.superClassId === classId) delete c.superClassId;
    });
    await db.properties.where('schemaId').equals(schemaId).modify((p) => {
      if (p.domainClassId === classId) delete p.domainClassId;
    });
  });
}

// ─── Properties ──────────────────────────────────────────────────────────────

export interface PropertyInput {
  name: string;
  label?: string;
  description?: string;
  propertyType: 'object' | 'datatype';
  domainClassId?: string;
  rangeClassIri?: string;
  mappingPattern?: TripleTemplate[];
  regexPattern?: string;
  regexVariable?: string;
  isRequired: boolean;
  propertyFeatures?: PropertyFeature[];
  inversePropertyIri?: string;
  disjointPropertyIris?: string[];
}

export async function addProperty(schemaId: string, data: PropertyInput): Promise<OntologyProperty> {
  const id = crypto.randomUUID();
  const row: PropertyRow = {
    id,
    schemaId,
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
  };
  await db.properties.add(row);
  return propToApi(row);
}

export async function updateProperty(_schemaId: string, propId: string, data: Partial<PropertyInput>): Promise<void> {
  await db.transaction('rw', db.properties, async () => {
    const row = await db.properties.get(propId);
    if (!row) return;
    if (data.name !== undefined) row.name = data.name;
    row.label = patched(row.label, data.label);
    row.description = patched(row.description, data.description);
    if (data.propertyType !== undefined) row.propertyType = data.propertyType;
    if (data.isRequired !== undefined) row.isRequired = data.isRequired;
    row.domainClassId = patched(row.domainClassId, data.domainClassId);
    row.rangeClassIri = patched(row.rangeClassIri, data.rangeClassIri);
    if (data.mappingPattern !== undefined) row.mappingPattern = data.mappingPattern;
    row.regexPattern = patched(row.regexPattern, data.regexPattern);
    row.regexVariable = patched(row.regexVariable, data.regexVariable);
    if (data.propertyFeatures !== undefined) row.propertyFeatures = data.propertyFeatures;
    row.inversePropertyIri = patched(row.inversePropertyIri, data.inversePropertyIri);
    if (data.disjointPropertyIris !== undefined) row.disjointPropertyIris = data.disjointPropertyIris;
    await db.properties.put(row);
  });
}

export async function deleteProperty(_schemaId: string, propId: string): Promise<void> {
  await db.properties.delete(propId);
}
