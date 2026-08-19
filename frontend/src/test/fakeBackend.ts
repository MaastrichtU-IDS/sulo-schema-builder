// In-memory stand-in for src/api/backend.ts, used by tests that need a real
// read-after-write store (schema import, share links). Mints the same IRIs as
// the server so exports and cross-references round-trip identically.

import type {
  OntologyClass,
  OntologyProperty,
  OntologySchema,
  OntologySchemaSummary,
} from '../api/ontology.js';
import type { ClassInput, ClassPatch, PropertyInput, PropertyPatch } from '../api/backend.js';

const BASE = 'https://w3id.org/sulo/schema/';
const SHEXR = `${BASE}resource/`;
export const schemaIri = (id: string) => `${SHEXR}ontology-schema/${id}`;
export const classIri = (id: string) => `${SHEXR}ontology-class/${id}`;
export const propIri = (id: string) => `${SHEXR}ontology-prop/${id}`;

function normalizeBaseUri(uri: string): string {
  return /[/#]$/.test(uri) ? uri : `${uri}/`;
}

/** '' clears a nullable field, undefined leaves it untouched — server PATCH semantics. */
function applyPatch<T extends object>(target: T, patch: Partial<Record<keyof T, unknown>>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    (target as Record<string, unknown>)[key] = value === '' ? undefined : value;
  }
}

export function createFakeBackend() {
  const schemas = new Map<string, OntologySchema>();

  async function getSchema(id: string): Promise<OntologySchema> {
    const found = schemas.get(id);
    if (!found) throw new Error(`schema ${id} not found`);
    return {
      ...found,
      classes: [...found.classes].sort((a, b) => a.name.localeCompare(b.name)),
      properties: [...found.properties].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  return {
    reset(): void {
      schemas.clear();
    },

    async listSchemas(): Promise<OntologySchemaSummary[]> {
      return [...schemas.values()]
        .map(({ classes: _c, properties: _p, ...summary }) => summary)
        .sort((a, b) => a.title.localeCompare(b.title));
    },

    getSchema,

    async createSchema(data: {
      title: string; description?: string; upperOntologyIri?: string; baseUri?: string;
    }): Promise<OntologySchema> {
      const id = crypto.randomUUID();
      const schema: OntologySchema = {
        id,
        url: schemaIri(id),
        title: data.title,
        description: data.description,
        upperOntologyIri: data.upperOntologyIri,
        baseUri: data.baseUri ? normalizeBaseUri(data.baseUri) : undefined,
        classes: [],
        properties: [],
      };
      schemas.set(id, schema);
      return schema;
    },

    async updateSchema(id: string, data: {
      title?: string; description?: string; upperOntologyIri?: string; baseUri?: string;
    }): Promise<void> {
      const schema = await getSchema(id);
      const stored = schemas.get(id)!;
      applyPatch(stored, { ...data, baseUri: data.baseUri ? normalizeBaseUri(data.baseUri) : data.baseUri });
      void schema;
    },

    async deleteSchema(id: string): Promise<void> {
      schemas.delete(id);
    },

    async addClass(schemaId: string, data: ClassInput): Promise<OntologyClass> {
      const stored = schemas.get(schemaId)!;
      const id = crypto.randomUUID();
      const cls: OntologyClass = { id, url: classIri(id), ...data };
      stored.classes.push(cls);
      return cls;
    },

    async updateClass(schemaId: string, classId: string, data: ClassPatch): Promise<void> {
      const cls = schemas.get(schemaId)!.classes.find((c) => c.id === classId)!;
      applyPatch(cls, data);
    },

    async deleteClass(schemaId: string, classId: string): Promise<void> {
      const stored = schemas.get(schemaId)!;
      stored.classes = stored.classes.filter((c) => c.id !== classId);
      for (const c of stored.classes) if (c.superClassId === classId) c.superClassId = undefined;
      for (const p of stored.properties) if (p.domainClassId === classId) p.domainClassId = undefined;
    },

    async addProperty(schemaId: string, data: PropertyInput): Promise<OntologyProperty> {
      const stored = schemas.get(schemaId)!;
      const id = crypto.randomUUID();
      const prop = {
        id,
        url: propIri(id),
        ...data,
        isRequired: data.isRequired ?? false,
        mappingPattern: data.mappingPattern ?? [],
        propertyFeatures: data.propertyFeatures ?? [],
        disjointPropertyIris: data.disjointPropertyIris ?? [],
      } as OntologyProperty;
      stored.properties.push(prop);
      return prop;
    },

    async updateProperty(schemaId: string, propId: string, data: PropertyPatch): Promise<void> {
      const prop = schemas.get(schemaId)!.properties.find((p) => p.id === propId)!;
      applyPatch(prop, data);
    },

    async deleteProperty(schemaId: string, propId: string): Promise<void> {
      const stored = schemas.get(schemaId)!;
      stored.properties = stored.properties.filter((p) => p.id !== propId);
    },

    async fetchUpperConcepts(): Promise<never[]> {
      return [];
    },
  };
}
