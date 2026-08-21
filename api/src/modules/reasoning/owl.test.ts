// generateOwl(db, schemaId) is the foundation the rest of plan 4's caching and
// quota work sits on: it turns a stored schema into the Turtle a reasoner
// checks and a content hash the cache keys on. The properties that matter are
// not "does it produce Turtle" but "is it the SAME Turtle every time nothing
// changed" — see the determinism tests below, which are the point of this
// file rather than incidental coverage.
//
// Fixtures go through the token path and the schema HTTP surface (never a
// hand-inserted `users`/`schemas` row) for the same reason listing.test.ts
// and routes.auth.test.ts do: truncateAll spares `users` on purpose, and the
// auth plugin's subject->user cache means a fabricated id drifts from the one
// the plugin would actually resolve.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import { buildAuthedApp, type AuthedTestApp } from '../../test/authApp.js';
import { generateOwl } from './owl.js';

let t: TestDb;
let harness: AuthedTestApp;

beforeAll(async () => {
  t = await startTestDb();
  harness = await buildAuthedApp(t.db);
});

afterAll(async () => {
  await harness.close();
  await t.stop();
});

beforeEach(async () => { await truncateAll(t.db); });

interface CreatedSchema { id: string; title: string }
interface CreatedClass { id: string; name: string }

/** Creates a schema through the API, as the harness's fixture caller. */
async function createSchema(
  input: { title: string; baseUri?: string },
): Promise<CreatedSchema> {
  const res = await harness.inject({ method: 'POST', url: '/ontology-schemas', payload: input });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function addClass(
  schemaId: string, name: string,
): Promise<CreatedClass> {
  const res = await harness.inject({
    method: 'POST', url: `/ontology-schemas/${schemaId}/classes`, payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function addProperty(
  schemaId: string,
  input: {
    name: string; domainClassId?: string; isRequired?: boolean; propertyFeatures?: string[];
  },
): Promise<{ id: string }> {
  const res = await harness.inject({
    method: 'POST', url: `/ontology-schemas/${schemaId}/properties`, payload: input,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function patchProperty(
  schemaId: string, propId: string, patch: { isRequired?: boolean; propertyFeatures?: string[] },
): Promise<void> {
  const res = await harness.inject({
    method: 'PATCH', url: `/ontology-schemas/${schemaId}/properties/${propId}`,
    payload: patch,
  });
  expect(res.statusCode).toBe(204);
}

describe('generateOwl', () => {
  it('produces non-empty Turtle that mints the class and property under the schema namespace', async () => {
    const schema = await createSchema({ title: 'Widgets' });
    const cls = await addClass(schema.id, 'Widget');
    await addProperty(schema.id, { name: 'hasSerial', domainClassId: cls.id });

    const result = await generateOwl(t.db, schema.id);
    expect(result).toBeDefined();
    expect(result!.turtle.length).toBeGreaterThan(0);
    expect(result!.turtle).toContain(':Widget');
    expect(result!.turtle).toContain(':hasSerial');
    expect(result!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is byte-identical across repeated calls for the same unchanged schema', async () => {
    const schema = await createSchema({ title: 'Repeat' });
    const cls = await addClass(schema.id, 'Thing');
    await addProperty(schema.id, { name: 'hasLabel', domainClassId: cls.id });

    const first = await generateOwl(t.db, schema.id);
    const second = await generateOwl(t.db, schema.id);
    expect(first).toBeDefined();
    expect(second!.turtle).toBe(first!.turtle);
    expect(second!.contentHash).toBe(first!.contentHash);
  });

  it('is unaffected by the order classes and properties were inserted in', async () => {
    // Same content, opposite insertion order, on two different schema rows.
    // The repository orders children by name, so the two Turtle documents
    // must agree once each schema's own id-derived header line is normalized
    // away.
    const schemaA = await createSchema({ title: 'Order', baseUri: 'https://example.org/order/' });
    const alpha = await addClass(schemaA.id, 'Alpha');
    const beta = await addClass(schemaA.id, 'Beta');
    await addProperty(schemaA.id, { name: 'toBeta', domainClassId: beta.id });
    await addProperty(schemaA.id, { name: 'toAlpha', domainClassId: alpha.id });

    const schemaB = await createSchema({ title: 'Order', baseUri: 'https://example.org/order/' });
    const beta2 = await addClass(schemaB.id, 'Beta');
    const alpha2 = await addClass(schemaB.id, 'Alpha');
    await addProperty(schemaB.id, { name: 'toAlpha', domainClassId: alpha2.id });
    await addProperty(schemaB.id, { name: 'toBeta', domainClassId: beta2.id });

    const resultA = await generateOwl(t.db, schemaA.id);
    const resultB = await generateOwl(t.db, schemaB.id);
    expect(resultA).toBeDefined();
    expect(resultB).toBeDefined();

    // The only place a schema's own id can appear is the ontology header
    // triple's subject (schema.url embeds the row id); baseUri makes every
    // other IRI in the document id-independent. Normalize that one line out
    // before comparing.
    const normalize = (turtle: string, id: string) => turtle.split(id).join('SCHEMA_ID');
    expect(normalize(resultA!.turtle, schemaA.id)).toBe(normalize(resultB!.turtle, schemaB.id));
  });

  it('mints class and property IRIs under baseUri when one is set', async () => {
    const schema = await createSchema({ title: 'Based', baseUri: 'https://example.org/based/' });
    await addClass(schema.id, 'Item');

    const result = await generateOwl(t.db, schema.id);
    expect(result!.turtle).toContain('@prefix : <https://example.org/based/> .');
    expect(result!.turtle).toContain(':Item');
  });

  it('changes the hash when a property\'s features change, and leaves it equal when nothing does', async () => {
    // propertyFeatures reaches turtleOwl directly (ontologyExport.ts folds it
    // into the property's rdf:type list), so this is a real OWL-content
    // change, unlike isRequired below.
    const schema = await createSchema({ title: 'Flags' });
    const cls = await addClass(schema.id, 'Thing');
    const prop = await addProperty(schema.id, { name: 'hasFlag', domainClassId: cls.id, propertyFeatures: [] });

    const before = await generateOwl(t.db, schema.id);
    const again = await generateOwl(t.db, schema.id);
    expect(again!.contentHash).toBe(before!.contentHash);

    await patchProperty(schema.id, prop.id, { propertyFeatures: ['functional'] });
    const after = await generateOwl(t.db, schema.id);
    expect(after!.contentHash).not.toBe(before!.contentHash);
  });

  it('leaves the hash unchanged when only isRequired changes, since that flag never reaches turtleOwl', async () => {
    // Spec §3 (docs/superpowers/specs/2026-08-19-multi-user-backend-design.md):
    // content_hash is the hash of the generated OWL alone, precisely so that a
    // mutation producing byte-identical OWL is detected as a no-op and skips
    // the reasoning pipeline. isRequired is exactly that case — it only ever
    // reaches shaclTtl (sh:minCount), never turtleOwl — so this is the one
    // test that must never be "fixed" into asserting the opposite.
    const schema = await createSchema({ title: 'Required' });
    const cls = await addClass(schema.id, 'Thing');
    const prop = await addProperty(schema.id, { name: 'hasFlag', domainClassId: cls.id, isRequired: false });

    const before = await generateOwl(t.db, schema.id);
    await patchProperty(schema.id, prop.id, { isRequired: true });
    const after = await generateOwl(t.db, schema.id);

    expect(after!.contentHash).toBe(before!.contentHash);
    expect(after!.turtle).toBe(before!.turtle);
  });

  it('returns undefined for a schema id that does not exist, not an empty document', async () => {
    const result = await generateOwl(t.db, '00000000-0000-0000-0000-000000000000');
    expect(result).toBeUndefined();
  });
});
