import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as store from '../api/localStore.js';
import { setStorageModeForTests } from '../api/appConfig.js';
import {
  serializeSchema,
  parseSchemaExport,
  importSchemaExport,
  encodeShareFragment,
  decodeShareFragment,
} from './schemaTransfer.js';

setStorageModeForTests('browser');
afterAll(() => setStorageModeForTests(null));

async function reset() {
  for (const s of await store.listSchemas()) await store.deleteSchema(s.id);
}

/** A schema exercising every cross-reference kind: hierarchy, domain, range-by-IRI, mapping pattern, disjoint/inverse. */
async function buildFixture() {
  const schema = await store.createSchema({
    title: 'Clinical', description: 'demo', upperOntologyIri: 'https://w3id.org/sulo/',
  });
  const parent = await store.addClass(schema.id, { name: 'Event', mapsToConceptIri: 'https://w3id.org/sulo/Process' });
  const child = await store.addClass(schema.id, { name: 'Visit', superClassId: parent.id });
  const p1 = await store.addProperty(schema.id, {
    name: 'occursIn', propertyType: 'object',
    domainClassId: child.id, rangeClassIri: parent.url,
    mappingPattern: [{ subject: '?this', predicate: 'https://w3id.org/sulo/isPartOf', object: parent.url }],
    isRequired: true, propertyFeatures: ['functional'],
  });
  const p2 = await store.addProperty(schema.id, {
    name: 'precedes', propertyType: 'object', domainClassId: parent.id,
    inversePropertyIri: p1.url, disjointPropertyIris: [p1.url, 'https://example.org/external'],
    isRequired: false,
  });
  return { schema, parent, child, p1, p2 };
}

describe('schema export format', () => {
  beforeEach(reset);

  it('serializes and re-parses its own output', async () => {
    const { schema } = await buildFixture();
    const full = await store.getSchema(schema.id);
    const exported = serializeSchema(full);
    expect(exported.format).toBe('sulo-schema');
    const reparsed = parseSchemaExport(JSON.stringify(exported));
    expect(reparsed).toEqual(exported);
  });

  it('rejects garbage and foreign JSON', () => {
    expect(() => parseSchemaExport('not json')).toThrow(/JSON/);
    expect(() => parseSchemaExport('{"format":"other"}')).toThrow(/export/);
  });
});

describe('importSchemaExport', () => {
  beforeEach(reset);

  it('re-mints every id and remaps all cross-references', async () => {
    const { schema, parent, p1 } = await buildFixture();
    const exported = serializeSchema(await store.getSchema(schema.id));
    const { id: newId } = await importSchemaExport(exported);
    expect(newId).not.toBe(schema.id);

    const copy = await store.getSchema(newId);
    expect(copy.title).toBe('Clinical');
    expect(copy.classes).toHaveLength(2);
    expect(copy.properties).toHaveLength(2);

    const newParent = copy.classes.find((c) => c.name === 'Event')!;
    const newChild = copy.classes.find((c) => c.name === 'Visit')!;
    expect(newParent.id).not.toBe(parent.id);
    expect(newChild.superClassId).toBe(newParent.id);
    expect(newParent.mapsToConceptIri).toBe('https://w3id.org/sulo/Process');

    const newP1 = copy.properties.find((p) => p.name === 'occursIn')!;
    expect(newP1.domainClassId).toBe(newChild.id);
    expect(newP1.rangeClassIri).toBe(newParent.url);        // remapped to the new class IRI
    expect(newP1.rangeClassIri).not.toBe(parent.url);
    expect(newP1.mappingPattern[0].object).toBe(newParent.url);
    expect(newP1.mappingPattern[0].subject).toBe('?this');   // variables untouched
    expect(newP1.isRequired).toBe(true);
    expect(newP1.propertyFeatures).toEqual(['functional']);

    const newP2 = copy.properties.find((p) => p.name === 'precedes')!;
    expect(newP2.inversePropertyIri).toBe(newP1.url);        // remapped to the new property IRI
    expect(newP2.disjointPropertyIris).toContain(newP1.url);
    expect(newP2.disjointPropertyIris).toContain('https://example.org/external'); // external IRIs pass through
    expect(newP2.disjointPropertyIris).not.toContain(p1.url);
  });
});

describe('share-link codec', () => {
  beforeEach(reset);

  it('round-trips through deflate + base64url', async () => {
    const { schema } = await buildFixture();
    const exported = serializeSchema(await store.getSchema(schema.id));
    const fragment = await encodeShareFragment(exported);
    expect(fragment).toMatch(/^[\w-]+$/);   // URL-safe, no padding
    const decoded = await decodeShareFragment(fragment);
    expect(decoded).toEqual(exported);
  });

  it('rejects a truncated fragment', async () => {
    const { schema } = await buildFixture();
    const fragment = await encodeShareFragment(serializeSchema(await store.getSchema(schema.id)));
    await expect(decodeShareFragment(fragment.slice(0, 10))).rejects.toThrow(/damaged|truncated|export|JSON/i);
  });
});
