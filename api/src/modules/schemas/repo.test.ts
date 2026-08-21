import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import { LOCAL_OWNER_ID } from '../../db/constants.js';
import * as service from './service.js';
import * as repo from './repo.js';

let t: TestDb;

beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => { await truncateAll(t.db); });

/**
 * service.schemaWithChildren deliberately takes a row, not an id — it exists
 * for callers that already hold one from an authorized read (see its own
 * comment). This test file has no ACL guard to authorize through, so it
 * reads the row directly the way moderation.routes.ts does, and assembles
 * the same full shape production code gets after requireAccess.
 */
async function readBack(id: string) {
  const row = await repo.getSchemaRow(t.db, id);
  if (!row) return undefined;
  return service.schemaWithChildren(t.db, row);
}

describe('schemas service', () => {
  it('creates a schema and reads it back with empty children', async () => {
    const created = await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Clinical', description: 'demo' });

    expect(created.id).toBeTruthy();
    expect(created.url).toContain(created.id);

    const full = await readBack(created.id);
    expect(full).toMatchObject({ title: 'Clinical', description: 'demo', classes: [], properties: [] });
  });

  it('normalizes baseUri on create and on update', async () => {
    const created = await service.createSchema(t.db, LOCAL_OWNER_ID, {
      title: 'A', baseUri: 'https://example.org/ns',
    });
    expect(created.baseUri).toBe('https://example.org/ns/');

    await service.updateSchema(t.db, created.id, { baseUri: 'https://example.org/other#' });
    expect((await readBack(created.id))!.baseUri).toBe('https://example.org/other#');
  });

  // grants.repo.ts's transferOwnership documents modified_at as tracking
  // *content*, not publication state — this pins repo.ts#patchSchema to that
  // same rule now that both files agree on it.
  it('bumps modified_at for a content patch but not for a visibility-only one', async () => {
    const created = await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Freshness' });
    const initial = (await repo.getSchemaRow(t.db, created.id))!;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.updateSchema(t.db, created.id, { visibility: 'public' });
    const afterVisibility = (await repo.getSchemaRow(t.db, created.id))!;
    expect(afterVisibility.modified_at.getTime()).toBe(initial.modified_at.getTime());

    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.updateSchema(t.db, created.id, { title: 'Freshness v2' });
    const afterContent = (await repo.getSchemaRow(t.db, created.id))!;
    expect(afterContent.modified_at.getTime()).toBeGreaterThan(initial.modified_at.getTime());
  });

  it('lists an owner schemas ordered by title', async () => {
    await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Zebra' });
    await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Alpha' });

    // service.listSchemas/repo.listSchemas were deleted as dead code (the
    // production `mine` scope has used listSchemasByScope since plan 3); this
    // is the same owner_id = :me, orderBy(title) query under its current name.
    const list = await service.listSchemasByScope(t.db, 'mine', LOCAL_OWNER_ID);
    expect(list.map((s) => s.title)).toEqual(['Alpha', 'Zebra']);
  });

  it('returns undefined for a missing schema', async () => {
    expect(await readBack('11111111-1111-1111-1111-111111111111')).toBeUndefined();
  });

  it('round-trips classes and properties including jsonb columns', async () => {
    const schema = await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Family' });
    const parent = await service.addClass(t.db, schema.id, { name: 'Event' });
    const child = await service.addClass(t.db, schema.id, { name: 'Visit', superClassId: parent.id });

    const prop = await service.addProperty(t.db, schema.id, {
      name: 'occursIn',
      propertyType: 'object',
      domainClassId: child.id,
      rangeClassIri: parent.url,
      mappingPattern: [{ subject: '?this', predicate: 'https://w3id.org/sulo/isPartOf', object: parent.url }],
      isRequired: true,
      propertyFeatures: ['functional'],
      disjointPropertyIris: ['https://example.org/external'],
    });

    const full = (await readBack(schema.id))!;
    expect(full.classes.map((c) => c.name)).toEqual(['Event', 'Visit']);
    expect(full.classes.find((c) => c.name === 'Visit')!.superClassId).toBe(parent.id);

    const readProp = full.properties.find((p) => p.id === prop.id)!;
    expect(readProp.mappingPattern).toEqual([
      { subject: '?this', predicate: 'https://w3id.org/sulo/isPartOf', object: parent.url },
    ]);
    expect(readProp.propertyFeatures).toEqual(['functional']);
    expect(readProp.disjointPropertyIris).toEqual(['https://example.org/external']);
    expect(readProp.isRequired).toBe(true);
  });

  it('treats an empty-string patch value as a field clear', async () => {
    const schema = await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Family' });
    const parent = await service.addClass(t.db, schema.id, { name: 'Event' });
    const child = await service.addClass(t.db, schema.id, {
      name: 'Visit', superClassId: parent.id, mapsToConceptIri: 'https://w3id.org/sulo/Process',
    });

    await service.updateClass(t.db, schema.id, child.id, { superClassId: '', mapsToConceptIri: '' });

    const full = (await readBack(schema.id))!;
    const updated = full.classes.find((c) => c.id === child.id)!;
    expect(updated.superClassId).toBeUndefined();
    expect(updated.mapsToConceptIri).toBeUndefined();
    expect(updated.name).toBe('Visit');
  });

  it('cascades deletes to classes and properties', async () => {
    const schema = await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Doomed' });
    await service.addClass(t.db, schema.id, { name: 'Gone' });
    await service.addProperty(t.db, schema.id, { name: 'alsoGone', propertyType: 'datatype' });

    await service.deleteSchema(t.db, schema.id);

    expect(await readBack(schema.id)).toBeUndefined();
    const { rows } = await t.pool.query('select count(*)::int as n from classes');
    expect(rows[0].n).toBe(0);
  });

  it('nulls the domain reference when a class a property points at is deleted', async () => {
    const schema = await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Refs' });
    const cls = await service.addClass(t.db, schema.id, { name: 'Subject' });
    const prop = await service.addProperty(t.db, schema.id, {
      name: 'hasName', propertyType: 'datatype', domainClassId: cls.id,
    });

    await service.deleteClass(t.db, schema.id, cls.id);

    const full = (await readBack(schema.id))!;
    expect(full.properties.find((p) => p.id === prop.id)!.domainClassId).toBeUndefined();
  });

  // Every child mutation is keyed on (schema_id, child_id), not on the child id
  // alone. Harmless while one local user owns everything; the same shape is
  // horizontal privilege escalation once an ACL authorizes on the schema id.
  it('refuses to mutate or delete a child through another schema id', async () => {
    const a = await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'A' });
    const b = await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'B' });
    const cls = await service.addClass(t.db, a.id, { name: 'Person', label: 'person' });
    const prop = await service.addProperty(t.db, a.id, {
      name: 'hasName', propertyType: 'datatype', label: 'has name',
    });

    expect(await service.updateClass(t.db, b.id, cls.id, { label: 'hacked' })).toBe(false);
    expect(await service.deleteClass(t.db, b.id, cls.id)).toBe(false);
    expect(await service.updateProperty(t.db, b.id, prop.id, { label: 'hacked' })).toBe(false);
    expect(await service.deleteProperty(t.db, b.id, prop.id)).toBe(false);
    // An empty patch cannot rely on an UPDATE's row count, so it probes instead.
    expect(await service.updateClass(t.db, b.id, cls.id, {})).toBe(false);

    const untouched = (await readBack(a.id))!;
    expect(untouched.classes).toHaveLength(1);
    expect(untouched.classes[0].label).toBe('person');
    expect(untouched.properties).toHaveLength(1);
    expect(untouched.properties[0].label).toBe('has name');

    // The owning schema id still works, including the empty-patch path.
    expect(await service.updateClass(t.db, a.id, cls.id, {})).toBe(true);
    expect(await service.updateClass(t.db, a.id, cls.id, { label: 'ok' })).toBe(true);
    expect(await service.deleteProperty(t.db, a.id, prop.id)).toBe(true);
    expect(await service.deleteClass(t.db, a.id, cls.id)).toBe(true);
  });

  // The 400 the routes answer for a cross-schema reference or a hostile
  // upperOntologyIri is not set in a route: it comes from this class, which
  // plugins/errorHandler.ts forwards verbatim because statusCode < 500. If that
  // field ever regresses, every one of those checks silently becomes a 500 that
  // logs a stack and tells the caller nothing.
  it('raises a client error, not a server error, for a rejected write', async () => {
    const schema = await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Guarded' });
    const other = await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Other' });
    const foreign = await service.addClass(t.db, other.id, { name: 'Outsider' });

    for (const attempt of [
      () => service.addClass(t.db, schema.id, { name: 'X', superClassId: foreign.id }),
      () => service.addProperty(t.db, schema.id, { name: 'p', propertyType: 'datatype', domainClassId: foreign.id }),
      () => service.createSchema(t.db, LOCAL_OWNER_ID, {
        title: 'Y', upperOntologyIri: 'http://169.254.169.254/latest/meta-data/',
      }),
      () => service.updateSchema(t.db, schema.id, { upperOntologyIri: 'http://127.0.0.1/x' }),
    ]) {
      await expect(attempt()).rejects.toMatchObject({
        name: 'SchemaWriteError',
        statusCode: 400,
      });
    }
  });

  it('reports a missing child as not found rather than silently succeeding', async () => {
    const schema = await service.createSchema(t.db, LOCAL_OWNER_ID, { title: 'Empty' });
    const ghost = '11111111-1111-1111-1111-111111111111';

    expect(await service.updateClass(t.db, schema.id, ghost, { label: 'x' })).toBe(false);
    expect(await service.deleteClass(t.db, schema.id, ghost)).toBe(false);
    expect(await service.updateProperty(t.db, schema.id, ghost, { label: 'x' })).toBe(false);
    expect(await service.deleteProperty(t.db, schema.id, ghost)).toBe(false);
  });
});
