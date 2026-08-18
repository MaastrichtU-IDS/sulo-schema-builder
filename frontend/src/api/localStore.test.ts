// Runs against fake-indexeddb — the import below must precede the localStore
// import so Dexie binds to the fake backend.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import * as store from './localStore.js';

async function reset() {
  for (const s of await store.listSchemas()) await store.deleteSchema(s.id);
}

describe('localStore', () => {
  beforeEach(reset);

  it('creates, lists (ordered by title) and fetches schemas', async () => {
    await store.createSchema({ title: 'Zebra' });
    const alpha = await store.createSchema({ title: 'Alpha', description: 'first', baseUri: 'https://example.org/x' });

    const list = await store.listSchemas();
    expect(list.map((s) => s.title)).toEqual(['Alpha', 'Zebra']);
    // baseUri normalized to end in a separator, like the server does
    expect(list[0].baseUri).toBe('https://example.org/x/');

    const full = await store.getSchema(alpha.id);
    expect(full).toMatchObject({ title: 'Alpha', description: 'first', classes: [], properties: [] });
    expect(full.url).toContain(alpha.id);
  });

  it('throws on a missing schema', async () => {
    await expect(store.getSchema('nope')).rejects.toThrow(/not found/);
  });

  it('supports class CRUD with the ""-clears-field patch convention', async () => {
    const schema = await store.createSchema({ title: 'S' });
    const parent = await store.addClass(schema.id, { name: 'Parent' });
    const child = await store.addClass(schema.id, { name: 'Child', label: 'kid', superClassId: parent.id });

    await store.updateClass(schema.id, child.id, { label: '', description: 'now described' });
    let full = await store.getSchema(schema.id);
    let got = full.classes.find((c) => c.id === child.id)!;
    expect(got.label).toBeUndefined();
    expect(got.description).toBe('now described');
    expect(got.superClassId).toBe(parent.id);

    await store.updateClass(schema.id, child.id, { superClassId: '' });
    full = await store.getSchema(schema.id);
    got = full.classes.find((c) => c.id === child.id)!;
    expect(got.superClassId).toBeUndefined();
  });

  it('nulls dangling references when a class is deleted (like the server FKs)', async () => {
    const schema = await store.createSchema({ title: 'S' });
    const parent = await store.addClass(schema.id, { name: 'Parent' });
    const child = await store.addClass(schema.id, { name: 'Child', superClassId: parent.id });
    const prop = await store.addProperty(schema.id, {
      name: 'p', propertyType: 'object', domainClassId: parent.id, isRequired: false,
    });

    await store.deleteClass(schema.id, parent.id);
    const full = await store.getSchema(schema.id);
    expect(full.classes.map((c) => c.id)).toEqual([child.id]);
    expect(full.classes[0].superClassId).toBeUndefined();
    expect(full.properties.find((p) => p.id === prop.id)!.domainClassId).toBeUndefined();
  });

  it('round-trips property arrays and deletes cascade with the schema', async () => {
    const schema = await store.createSchema({ title: 'S' });
    const cls = await store.addClass(schema.id, { name: 'C' });
    const prop = await store.addProperty(schema.id, {
      name: 'hasPart',
      propertyType: 'object',
      domainClassId: cls.id,
      rangeClassIri: cls.url,
      mappingPattern: [{ subject: '?this', predicate: 'https://w3id.org/sulo/hasPart', object: '?value' }],
      isRequired: true,
      propertyFeatures: ['transitive'],
      disjointPropertyIris: ['https://example.org/other'],
    });

    let full = await store.getSchema(schema.id);
    const got = full.properties.find((p) => p.id === prop.id)!;
    expect(got.mappingPattern).toHaveLength(1);
    expect(got.propertyFeatures).toEqual(['transitive']);
    expect(got.disjointPropertyIris).toEqual(['https://example.org/other']);
    expect(got.isRequired).toBe(true);

    await store.deleteSchema(schema.id);
    expect(await store.listSchemas()).toEqual([]);
    // orphaned rows are gone too: a fresh schema starts empty
    const again = await store.createSchema({ title: 'S2' });
    full = await store.getSchema(again.id);
    expect(full.classes).toEqual([]);
    expect(full.properties).toEqual([]);
  });
});
