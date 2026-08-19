import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import schemasRoutes from './routes.js';

let t: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
  t = await startTestDb();
  app = Fastify();
  await app.register(sensible);
  app.decorate('pg', t.db);
  await app.register(schemasRoutes, { prefix: '/ontology-schemas' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.stop();
});

beforeEach(async () => { await truncateAll(t.db); });

describe('ontology-schemas routes (postgres)', () => {
  it('creates a schema with empty classes/properties', async () => {
    const res = await app.inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'Test Schema', description: 'desc' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ title: 'Test Schema', description: 'desc', classes: [], properties: [] });
    expect(body.url).toContain(body.id);
  });

  it('lists schemas ordered by title', async () => {
    await app.inject({ method: 'POST', url: '/ontology-schemas', payload: { title: 'Zebra' } });
    await app.inject({ method: 'POST', url: '/ontology-schemas', payload: { title: 'Alpha' } });

    const body = (await app.inject({ method: 'GET', url: '/ontology-schemas' })).json();
    expect(body.map((s: { title: string }) => s.title)).toEqual(['Alpha', 'Zebra']);
  });

  it('404s on a missing schema', async () => {
    const res = await app.inject({
      method: 'GET', url: '/ontology-schemas/11111111-1111-1111-1111-111111111111',
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s on a malformed id instead of leaking a database error', async () => {
    const res = await app.inject({ method: 'GET', url: '/ontology-schemas/not-a-uuid' });
    expect(res.statusCode).toBe(400);
  });

  it('supports the full class/property CRUD flow with a mapping pattern', async () => {
    const schema = (await app.inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'Family Ontology' },
    })).json();

    const parent = (await app.inject({
      method: 'POST', url: `/ontology-schemas/${schema.id}/classes`, payload: { name: 'Person' },
    })).json();
    const child = (await app.inject({
      method: 'POST', url: `/ontology-schemas/${schema.id}/classes`,
      payload: { name: 'Parent', superClassId: parent.id },
    })).json();

    const prop = (await app.inject({
      method: 'POST', url: `/ontology-schemas/${schema.id}/properties`,
      payload: {
        name: 'hasChild', propertyType: 'object', domainClassId: child.id, rangeClassIri: parent.url,
        mappingPattern: [{ subject: '?this', predicate: 'https://example.org/p', object: '?value' }],
        isRequired: true, propertyFeatures: ['functional'],
      },
    })).json();
    expect(prop.mappingPattern).toHaveLength(1);

    await app.inject({
      method: 'PATCH', url: `/ontology-schemas/${schema.id}/properties/${prop.id}`,
      payload: { label: 'has child', isRequired: false },
    });

    const full = (await app.inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    expect(full.classes).toHaveLength(2);
    expect(full.properties[0]).toMatchObject({ label: 'has child', isRequired: false });

    expect((await app.inject({
      method: 'DELETE', url: `/ontology-schemas/${schema.id}/properties/${prop.id}`,
    })).statusCode).toBe(204);
    expect((await app.inject({
      method: 'DELETE', url: `/ontology-schemas/${schema.id}/classes/${child.id}`,
    })).statusCode).toBe(204);

    const after = (await app.inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    expect(after.properties).toHaveLength(0);
    expect(after.classes).toHaveLength(1);
  });

  it('updates schema metadata via PATCH', async () => {
    const schema = (await app.inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'Before' },
    })).json();

    expect((await app.inject({
      method: 'PATCH', url: `/ontology-schemas/${schema.id}`,
      payload: { title: 'After', description: 'new' },
    })).statusCode).toBe(204);

    const body = (await app.inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    expect(body).toMatchObject({ title: 'After', description: 'new' });
  });

  it('normalizes baseUri on create and update, and returns it from list and single reads', async () => {
    const schema = (await app.inject({
      method: 'POST', url: '/ontology-schemas',
      payload: { title: 'Based', baseUri: 'https://example.org/ns' },
    })).json();
    expect(schema.baseUri).toBe('https://example.org/ns/');

    const list = (await app.inject({ method: 'GET', url: '/ontology-schemas' })).json();
    expect(list[0].baseUri).toBe('https://example.org/ns/');

    await app.inject({
      method: 'PATCH', url: `/ontology-schemas/${schema.id}`,
      payload: { baseUri: 'https://example.org/other#' },
    });
    const single = (await app.inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    expect(single.baseUri).toBe('https://example.org/other#');
  });

  it('returns [] from upper-concepts when no upper ontology is set', async () => {
    const schema = (await app.inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'No upper' },
    })).json();

    const res = await app.inject({ method: 'GET', url: `/ontology-schemas/${schema.id}/upper-concepts` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
