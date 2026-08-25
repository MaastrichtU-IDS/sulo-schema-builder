import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import { buildAuthedApp, type AuthedTestApp } from '../../test/authApp.js';
import { stopPendingChecks } from '../reasoning/pipeline.js';

let t: TestDb;
let harness: AuthedTestApp;

/**
 * Every request below is made by one fixed signed-in caller.
 *
 * These tests are about request/response behaviour — validation, status codes,
 * PATCH semantics, SSRF policy — so a session is background noise the harness
 * attaches for them (api/src/test/authApp.ts). Identity itself is the subject of
 * routes.auth.test.ts: who owns a new schema, who can list it, what happens
 * with no token at all.
 */
let inject: AuthedTestApp['inject'];

beforeAll(async () => {
  t = await startTestDb();
  harness = await buildAuthedApp(t.db);
  inject = harness.inject;
});

afterAll(async () => {
  // Every mutating request below schedules a debounced reasoning check
  // against this file's own db/pool (schemas/service.ts) — drop those before
  // that pool is destroyed, so a leftover timer never fires against a dead
  // connection while a later, unrelated test file is running.
  stopPendingChecks();
  await harness.close();
  await t.stop();
});

beforeEach(async () => { await truncateAll(t.db); });

describe('ontology-schemas routes (postgres)', () => {
  it('creates a schema with empty classes/properties', async () => {
    const res = await inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'Test Schema', description: 'desc' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ title: 'Test Schema', description: 'desc', classes: [], properties: [] });
    expect(body.url).toContain(body.id);
  });

  it('lists schemas ordered by title', async () => {
    await inject({ method: 'POST', url: '/ontology-schemas', payload: { title: 'Zebra' } });
    await inject({ method: 'POST', url: '/ontology-schemas', payload: { title: 'Alpha' } });

    const body = (await inject({ method: 'GET', url: '/ontology-schemas' })).json();
    expect(body.map((s: { title: string }) => s.title)).toEqual(['Alpha', 'Zebra']);
  });

  it('404s on a missing schema', async () => {
    const res = await inject({
      method: 'GET', url: '/ontology-schemas/11111111-1111-1111-1111-111111111111',
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s on a malformed id instead of leaking a database error', async () => {
    const res = await inject({ method: 'GET', url: '/ontology-schemas/not-a-uuid' });
    expect(res.statusCode).toBe(400);
  });

  it('supports the full class/property CRUD flow with a mapping pattern', async () => {
    const schema = (await inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'Family Ontology' },
    })).json();

    const parent = (await inject({
      method: 'POST', url: `/ontology-schemas/${schema.id}/classes`, payload: { name: 'Person' },
    })).json();
    const child = (await inject({
      method: 'POST', url: `/ontology-schemas/${schema.id}/classes`,
      payload: { name: 'Parent', superClassId: parent.id },
    })).json();

    const prop = (await inject({
      method: 'POST', url: `/ontology-schemas/${schema.id}/properties`,
      payload: {
        name: 'hasChild', propertyType: 'object', domainClassId: child.id, rangeClassIri: parent.url,
        mappingPattern: [{ subject: '?this', predicate: 'https://example.org/p', object: '?value' }],
        isRequired: true, propertyFeatures: ['functional'],
      },
    })).json();
    expect(prop.mappingPattern).toHaveLength(1);

    await inject({
      method: 'PATCH', url: `/ontology-schemas/${schema.id}/properties/${prop.id}`,
      payload: { label: 'has child', isRequired: false },
    });

    const full = (await inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    expect(full.classes).toHaveLength(2);
    expect(full.properties[0]).toMatchObject({ label: 'has child', isRequired: false });

    expect((await inject({
      method: 'DELETE', url: `/ontology-schemas/${schema.id}/properties/${prop.id}`,
    })).statusCode).toBe(204);
    expect((await inject({
      method: 'DELETE', url: `/ontology-schemas/${schema.id}/classes/${child.id}`,
    })).statusCode).toBe(204);

    const after = (await inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    expect(after.properties).toHaveLength(0);
    expect(after.classes).toHaveLength(1);
  });

  it('updates schema metadata via PATCH', async () => {
    const schema = (await inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'Before' },
    })).json();

    expect((await inject({
      method: 'PATCH', url: `/ontology-schemas/${schema.id}`,
      payload: { title: 'After', description: 'new' },
    })).statusCode).toBe(204);

    const body = (await inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    expect(body).toMatchObject({ title: 'After', description: 'new' });
  });

  it('normalizes baseUri on create and update, and returns it from list and single reads', async () => {
    const schema = (await inject({
      method: 'POST', url: '/ontology-schemas',
      payload: { title: 'Based', baseUri: 'https://example.org/ns' },
    })).json();
    expect(schema.baseUri).toBe('https://example.org/ns/');

    const list = (await inject({ method: 'GET', url: '/ontology-schemas' })).json();
    expect(list[0].baseUri).toBe('https://example.org/ns/');

    await inject({
      method: 'PATCH', url: `/ontology-schemas/${schema.id}`,
      payload: { baseUri: 'https://example.org/other#' },
    });
    const single = (await inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    expect(single.baseUri).toBe('https://example.org/other#');
  });

  it('returns [] from upper-concepts when no upper ontology is set', async () => {
    const schema = (await inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'No upper' },
    })).json();

    const res = await inject({ method: 'GET', url: `/ontology-schemas/${schema.id}/upper-concepts` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('404s when adding a class or property to a well-formed but unknown schema id', async () => {
    const ghost = '11111111-1111-1111-1111-111111111111';

    for (const [url, payload] of [
      [`/ontology-schemas/${ghost}/classes`, { name: 'Person' }],
      [`/ontology-schemas/${ghost}/properties`, { name: 'p', propertyType: 'datatype' }],
    ] as const) {
      const res = await inject({ method: 'POST', url, payload });
      expect(res.statusCode).toBe(404);
      // A foreign-key violation must never reach the client verbatim.
      expect(res.body).not.toMatch(/constraint|foreign key|insert or update|fkey/i);
    }
  });

  it('400s on a malformed body instead of 500ing with the raw validation dump', async () => {
    const create = await inject({ method: 'POST', url: '/ontology-schemas', payload: { description: 'no title' } });
    expect(create.statusCode).toBe(400);

    const schema = (await inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'Valid' },
    })).json();

    const badClass = await inject({
      method: 'POST', url: `/ontology-schemas/${schema.id}/classes`, payload: { label: 'no name' },
    });
    expect(badClass.statusCode).toBe(400);

    const badProp = await inject({
      method: 'POST', url: `/ontology-schemas/${schema.id}/properties`,
      payload: { name: 'p', propertyType: 'nonsense' },
    });
    expect(badProp.statusCode).toBe(400);

    const badPatch = await inject({
      method: 'PATCH', url: `/ontology-schemas/${schema.id}`, payload: { title: '' },
    });
    expect(badPatch.statusCode).toBe(400);
  });

  it('404s when mutating a class or property through a different schema id', async () => {
    const a = (await inject({ method: 'POST', url: '/ontology-schemas', payload: { title: 'A' } })).json();
    const b = (await inject({ method: 'POST', url: '/ontology-schemas', payload: { title: 'B' } })).json();

    const cls = (await inject({
      method: 'POST', url: `/ontology-schemas/${a.id}/classes`, payload: { name: 'Person', label: 'person' },
    })).json();
    const prop = (await inject({
      method: 'POST', url: `/ontology-schemas/${a.id}/properties`,
      payload: { name: 'hasName', propertyType: 'datatype', label: 'has name' },
    })).json();

    for (const [method, url] of [
      ['PATCH', `/ontology-schemas/${b.id}/classes/${cls.id}`],
      ['DELETE', `/ontology-schemas/${b.id}/classes/${cls.id}`],
      ['PATCH', `/ontology-schemas/${b.id}/properties/${prop.id}`],
      ['DELETE', `/ontology-schemas/${b.id}/properties/${prop.id}`],
    ] as const) {
      const res = await inject({ method, url, payload: { label: 'hacked' } });
      expect(res.statusCode).toBe(404);
    }

    const untouched = (await inject({ method: 'GET', url: `/ontology-schemas/${a.id}` })).json();
    expect(untouched.classes[0].label).toBe('person');
    expect(untouched.properties[0].label).toBe('has name');
  });

  // Was the last route that answered a bare 500: super_class_id/domain_class_id
  // are foreign keys onto classes(id) with no schema predicate, so an unknown
  // id tripped classes_super_class_id_fkey. Now pre-checked in the same schema,
  // which is also what stops a cross-schema hierarchy edge (see below).
  it('400s on a superClassId that names no class in this schema', async () => {
    const schema = (await inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'Constrained' },
    })).json();

    const res = await inject({
      method: 'POST', url: `/ontology-schemas/${schema.id}/classes`,
      payload: { name: 'Orphan', superClassId: '11111111-1111-1111-1111-111111111111' },
    });

    expect(res.statusCode).toBe(400);
    // Whatever the status, no SQL, table or constraint name may reach a client.
    expect(res.body).not.toMatch(/constraint|fkey|insert or update|Internal Server Error/i);
    expect(res.json().message).toMatch(/superClassId/);
  });

  // I6: the reference is checked against the schema in the path, not just
  // against classes(id). Without this, POST /ontology-schemas/A/classes with a
  // superClassId from schema B builds a cross-schema edge — an incoherent
  // export today, and a cross-tenant write once plan 2 authorizes on `:id`.
  it('refuses a superClassId or domainClassId belonging to another schema', async () => {
    const a = (await inject({ method: 'POST', url: '/ontology-schemas', payload: { title: 'A' } })).json();
    const b = (await inject({ method: 'POST', url: '/ontology-schemas', payload: { title: 'B' } })).json();

    const foreign = (await inject({
      method: 'POST', url: `/ontology-schemas/${b.id}/classes`, payload: { name: 'Outsider' },
    })).json();
    const mine = (await inject({
      method: 'POST', url: `/ontology-schemas/${a.id}/classes`, payload: { name: 'Insider' },
    })).json();
    const myProp = (await inject({
      method: 'POST', url: `/ontology-schemas/${a.id}/properties`,
      payload: { name: 'hasThing', propertyType: 'datatype' },
    })).json();

    for (const [method, url, payload] of [
      ['POST',  `/ontology-schemas/${a.id}/classes`,    { name: 'Child', superClassId: foreign.id }],
      ['PATCH', `/ontology-schemas/${a.id}/classes/${mine.id}`, { superClassId: foreign.id }],
      ['POST',  `/ontology-schemas/${a.id}/properties`, { name: 'p', propertyType: 'datatype', domainClassId: foreign.id }],
      ['PATCH', `/ontology-schemas/${a.id}/properties/${myProp.id}`, { domainClassId: foreign.id }],
    ] as const) {
      const res = await inject({ method, url, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/superClassId|domainClassId/);
    }

    // Nothing crossed over, and the same ids still work inside their own schema.
    const inA = (await inject({ method: 'GET', url: `/ontology-schemas/${a.id}` })).json();
    expect(inA.classes).toHaveLength(1);
    expect(inA.classes[0].superClassId).toBeUndefined();
    expect(inA.properties[0].domainClassId).toBeUndefined();

    expect((await inject({
      method: 'PATCH', url: `/ontology-schemas/${a.id}/properties/${myProp.id}`,
      payload: { domainClassId: mine.id },
    })).statusCode).toBe(204);
  });

  it('refuses to make a class its own superclass', async () => {
    const schema = (await inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'Loop' },
    })).json();
    const cls = (await inject({
      method: 'POST', url: `/ontology-schemas/${schema.id}/classes`, payload: { name: 'Ouroboros' },
    })).json();

    const res = await inject({
      method: 'PATCH', url: `/ontology-schemas/${schema.id}/classes/${cls.id}`,
      payload: { superClassId: cls.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/own superclass/);
  });

  // I5: service.ts has always implemented '' as "clear this nullable column",
  // but the validators rejected '' for both IRI fields, so the clear was
  // unreachable and only the frontend's test double modelled it.
  it("treats '' as a clear for description, upperOntologyIri and baseUri", async () => {
    const schema = (await inject({
      method: 'POST', url: '/ontology-schemas',
      payload: {
        title: 'Clearable', description: 'a description',
        upperOntologyIri: 'https://w3id.org/sulo/', baseUri: 'https://example.org/ns/',
      },
    })).json();
    expect(schema).toMatchObject({
      description: 'a description',
      upperOntologyIri: 'https://w3id.org/sulo/',
      baseUri: 'https://example.org/ns/',
    });

    expect((await inject({
      method: 'PATCH', url: `/ontology-schemas/${schema.id}`,
      payload: { description: '', upperOntologyIri: '', baseUri: '' },
    })).statusCode).toBe(204);

    const cleared = (await inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    expect(cleared.description).toBeUndefined();
    expect(cleared.upperOntologyIri).toBeUndefined();
    expect(cleared.baseUri).toBeUndefined();
    expect(cleared.title).toBe('Clearable');
  });

  it("still rejects a non-empty non-URL in either IRI field, on create and on patch", async () => {
    for (const field of ['upperOntologyIri', 'baseUri'] as const) {
      const create = await inject({
        method: 'POST', url: '/ontology-schemas', payload: { title: 'Bad', [field]: 'not a url' },
      });
      expect(create.statusCode).toBe(400);

      const schema = (await inject({
        method: 'POST', url: '/ontology-schemas', payload: { title: `Good ${field}` },
      })).json();
      const patch = await inject({
        method: 'PATCH', url: `/ontology-schemas/${schema.id}`, payload: { [field]: 'not a url' },
      });
      expect(patch.statusCode).toBe(400);
    }
  });

  // C1, write side: upperOntologyIri is not inert metadata — the upper-concepts
  // route dereferences it. `z.string().url()` accepts the cloud-metadata
  // endpoint, so the policy check has to run in the service.
  it('refuses to store an upperOntologyIri the server must not dereference', async () => {
    for (const iri of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1/x',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://example.org:3000/api/v1/health',
    ]) {
      const create = await inject({
        method: 'POST', url: '/ontology-schemas', payload: { title: 'SSRF', upperOntologyIri: iri },
      });
      expect(create.statusCode).toBe(400);
      expect(create.json().message).toMatch(/upperOntologyIri/);

      const schema = (await inject({
        method: 'POST', url: '/ontology-schemas', payload: { title: 'SSRF patch' },
      })).json();
      const patch = await inject({
        method: 'PATCH', url: `/ontology-schemas/${schema.id}`, payload: { upperOntologyIri: iri },
      });
      expect(patch.statusCode).toBe(400);
    }

    // Nothing hostile was persisted by any of the attempts above.
    const { rows } = await t.pool.query(
      'select count(*)::int as n from schemas where upper_ontology_iri is not null',
    );
    expect(rows[0].n).toBe(0);
  });

  // C1, read side: the write-time check is not the boundary. A row written
  // before it existed — or by any future path that forgets it — must still not
  // become an outbound request, so the route re-applies the policy at fetch
  // time. Planted directly through the database to bypass validation entirely.
  it('refuses to dereference a hostile upperOntologyIri already in the database', async () => {
    const schema = (await inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'Legacy row' },
    })).json();
    await t.pool.query(
      'update schemas set upper_ontology_iri = $1 where id = $2',
      ['http://169.254.169.254/latest/meta-data/', schema.id],
    );

    const res = await inject({ method: 'GET', url: `/ontology-schemas/${schema.id}/upper-concepts` });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/private address|not allowed|Internal hostnames/i);
  });
});
