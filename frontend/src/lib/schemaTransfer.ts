// Moving a schema between browsers/machines: versioned JSON file export, a
// compressed "share string" a caller can paste anywhere text goes, and an
// import that re-mints every id.
//
// Import can't reuse the exported ids/IRIs: classes and properties
// cross-reference each other both by id (superClassId, domainClassId) and by
// full IRI (rangeClassIri, mapping-pattern triples, inversePropertyIri,
// disjointPropertyIris), and the receiving store mints fresh UUIDs. So the
// import runs in passes: create everything, build old→new maps for both ids
// and IRIs, then patch the references through those maps. References that
// don't resolve (e.g. an external property IRI, an xsd: range) pass through
// untouched.
//
// The share string is deliberately not a URL: it's meant to be pasted into
// any SULO Schema Builder's own "paste to import" field, local or remote,
// never sent to a server on its own — so no server/proxy URL length limit
// applies. It can still be embedded after `SHARE_FRAGMENT_PREFIX` in a real
// URL for the auto-import-on-visit path (SchemaListPage's own hash listener),
// which is why the codec and the prefix still live here unchanged; the UI
// just no longer builds that URL by default. The practical ceiling is
// chat/LMS text-field handling, hence SHARE_LINK_LIMIT with a file-export
// fallback in the UI.

import { z } from 'zod';
import * as backend from '../api/backend.js';
import type { OntologySchema, PropertyFeature, TripleTemplate } from '../api/ontology.js';

// ─── Format ──────────────────────────────────────────────────────────────────

export const SCHEMA_EXPORT_FORMAT = 'sulo-schema';
export const SCHEMA_EXPORT_VERSION = 1;

const TripleTemplateSchema = z.object({
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
});

const PropertyFeatureSchema = z.enum([
  'functional', 'inverseFunctional',
  'transitive', 'symmetric', 'asymmetric',
  'reflexive', 'irreflexive',
]);

const ExportedClassSchema = z.object({
  id: z.string(),
  url: z.string(),
  name: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  mapsToConceptIri: z.string().optional(),
  superClassId: z.string().optional(),
});

const ExportedPropertySchema = z.object({
  id: z.string(),
  url: z.string(),
  name: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  propertyType: z.enum(['object', 'datatype']),
  domainClassId: z.string().optional(),
  rangeClassIri: z.string().optional(),
  mappingPattern: z.array(TripleTemplateSchema).default([]),
  regexPattern: z.string().optional(),
  regexVariable: z.string().optional(),
  isRequired: z.boolean().default(false),
  propertyFeatures: z.array(PropertyFeatureSchema).default([]),
  inversePropertyIri: z.string().optional(),
  disjointPropertyIris: z.array(z.string()).default([]),
});

export const SchemaExportSchema = z.object({
  format: z.literal(SCHEMA_EXPORT_FORMAT),
  version: z.literal(SCHEMA_EXPORT_VERSION),
  schema: z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    upperOntologyIri: z.string().optional(),
    baseUri: z.string().optional(),
    classes: z.array(ExportedClassSchema).default([]),
    properties: z.array(ExportedPropertySchema).default([]),
  }),
});

export type SchemaExport = z.infer<typeof SchemaExportSchema>;

export function serializeSchema(schema: OntologySchema): SchemaExport {
  return {
    format: SCHEMA_EXPORT_FORMAT,
    version: SCHEMA_EXPORT_VERSION,
    schema: {
      title: schema.title,
      description: schema.description,
      upperOntologyIri: schema.upperOntologyIri,
      baseUri: schema.baseUri,
      classes: schema.classes.map((c) => ({
        id: c.id, url: c.url, name: c.name, label: c.label, description: c.description,
        mapsToConceptIri: c.mapsToConceptIri, superClassId: c.superClassId,
      })),
      properties: schema.properties.map((p) => ({
        id: p.id, url: p.url, name: p.name, label: p.label, description: p.description,
        propertyType: p.propertyType, domainClassId: p.domainClassId, rangeClassIri: p.rangeClassIri,
        mappingPattern: p.mappingPattern, regexPattern: p.regexPattern, regexVariable: p.regexVariable,
        isRequired: p.isRequired, propertyFeatures: p.propertyFeatures,
        inversePropertyIri: p.inversePropertyIri, disjointPropertyIris: p.disjointPropertyIris,
      })),
    },
  };
}

/** Parse untrusted JSON text into a validated export, or throw with a readable message. */
export function parseSchemaExport(text: string): SchemaExport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file.');
  }
  const result = SchemaExportSchema.safeParse(raw);
  if (!result.success) {
    throw new Error('Not a SULO Schema Builder export (or from an incompatible version).');
  }
  return result.data;
}

// ─── Import (re-mint ids, remap references) ──────────────────────────────────

export async function importSchemaExport(file: SchemaExport): Promise<{ id: string }> {
  const { schema } = file;
  const created = await backend.createSchema({
    title: schema.title,
    description: schema.description,
    upperOntologyIri: schema.upperOntologyIri,
    baseUri: schema.baseUri,
  });

  const classIdMap = new Map<string, string>();
  const iriMap = new Map<string, string>();

  // Classes, pass 1: create without superClassId (parents may not exist yet).
  for (const cls of schema.classes) {
    const newCls = await backend.addClass(created.id, {
      name: cls.name, label: cls.label, description: cls.description,
      mapsToConceptIri: cls.mapsToConceptIri,
    });
    classIdMap.set(cls.id, newCls.id);
    iriMap.set(cls.url, newCls.url);
  }

  // Classes, pass 2: wire up the hierarchy.
  for (const cls of schema.classes) {
    const parent = cls.superClassId && classIdMap.get(cls.superClassId);
    if (parent) {
      await backend.updateClass(created.id, classIdMap.get(cls.id)!, { superClassId: parent });
    }
  }

  const mapIri = (iri: string) => iriMap.get(iri) ?? iri;
  const remapTriples = (triples: TripleTemplate[]): TripleTemplate[] =>
    triples.map((t) => ({ subject: mapIri(t.subject), predicate: mapIri(t.predicate), object: mapIri(t.object) }));

  // Properties, pass 1: create without inverse/disjoint links (those reference
  // property IRIs that don't exist until every property is created).
  const propIdMap = new Map<string, string>();
  for (const prop of schema.properties) {
    const newProp = await backend.addProperty(created.id, {
      name: prop.name, label: prop.label, description: prop.description,
      propertyType: prop.propertyType,
      domainClassId: prop.domainClassId ? classIdMap.get(prop.domainClassId) : undefined,
      rangeClassIri: prop.rangeClassIri ? mapIri(prop.rangeClassIri) : undefined,
      mappingPattern: remapTriples(prop.mappingPattern),
      regexPattern: prop.regexPattern, regexVariable: prop.regexVariable,
      isRequired: prop.isRequired,
      propertyFeatures: prop.propertyFeatures as PropertyFeature[],
    });
    propIdMap.set(prop.id, newProp.id);
    iriMap.set(prop.url, newProp.url);
  }

  // Properties, pass 2: inverse/disjoint references through the final IRI map.
  for (const prop of schema.properties) {
    if (!prop.inversePropertyIri && prop.disjointPropertyIris.length === 0) continue;
    await backend.updateProperty(created.id, propIdMap.get(prop.id)!, {
      inversePropertyIri: prop.inversePropertyIri ? mapIri(prop.inversePropertyIri) : undefined,
      disjointPropertyIris: prop.disjointPropertyIris.map(mapIri),
    });
  }

  return { id: created.id };
}

// ─── Share-link codec (deflate + base64url in the URL fragment) ──────────────

/** Links longer than this are refused in favour of file export. */
export const SHARE_LINK_LIMIT = 8_000;

export const SHARE_FRAGMENT_PREFIX = '#s=';

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pipeThrough(bytes: Uint8Array, stream: { readable: ReadableStream; writable: WritableStream }): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes).catch(() => {});
  void writer.close().catch(() => {});
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

/** Encode an export as a URL fragment value (without the `#s=` prefix). */
export async function encodeShareFragment(file: SchemaExport): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(file));
  const deflated = await pipeThrough(json, new CompressionStream('deflate-raw'));
  return bytesToBase64Url(deflated);
}

/** Decode and validate a share string. Throws on anything malformed. */
export async function decodeShareFragment(fragment: string): Promise<SchemaExport> {
  let inflated: Uint8Array;
  try {
    inflated = await pipeThrough(base64UrlToBytes(fragment), new DecompressionStream('deflate-raw'));
  } catch {
    throw new Error('This share string is damaged or truncated.');
  }
  return parseSchemaExport(new TextDecoder().decode(inflated));
}
