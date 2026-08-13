import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { openDatabase } from '../../db/connection.js';
import ontologyRoutes from './ontology.js';

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(sensible);
  app.decorate('db', openDatabase(':memory:'));
  await app.register(ontologyRoutes, { prefix: '/ontology-schemas' });
  await app.ready();
  return app;
}

describe('ontology-schemas routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    app.db.close();
    await app.close();
  });

  it('creates a schema with empty classes/properties', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ontology-schemas',
      payload: { title: 'Test Schema', description: 'desc' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ title: 'Test Schema', description: 'desc', classes: [], properties: [] });
    expect(body.id).toBeTruthy();
    expect(body.url).toContain(body.id);
  });

  it('lists schemas ordered by title', async () => {
    await app.inject({ method: 'POST', url: '/ontology-schemas', payload: { title: 'Zebra' } });
    await app.inject({ method: 'POST', url: '/ontology-schemas', payload: { title: 'Alpha' } });

    const res = await app.inject({ method: 'GET', url: '/ontology-schemas' });
    const body = res.json();
    expect(body.map((s: { title: string }) => s.title)).toEqual(['Alpha', 'Zebra']);
  });

  it('404s on a missing schema', async () => {
    const res = await app.inject({ method: 'GET', url: '/ontology-schemas/does-not-exist' });
    expect(res.statusCode).toBe(404);
  });

  it('supports the full class/property CRUD flow with a mapping pattern', async () => {
    const schema = (await app.inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'Family Ontology' },
    })).json();

    const parent = (await app.inject({
      method: 'POST', url: `/ontology-schemas/${schema.id}/classes`,
      payload: { name: 'Person', label: 'Person' },
    })).json();

    const child = (await app.inject({
      method: 'POST', url: `/ontology-schemas/${schema.id}/classes`,
      payload: { name: 'ParentRole', superClassId: parent.id },
    })).json();
    expect(child.superClassId).toBe(parent.id);

    const mappingPattern = [
      { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?o1' },
      { subject: '?o1', predicate: 'https://w3id.org/sulo/isParticipantIn', object: '?value' },
    ];

    const prop = (await app.inject({
      method: 'POST', url: `/ontology-schemas/${schema.id}/properties`,
      payload: {
        name: 'hasChild',
        propertyType: 'object',
        domainClassId: parent.id,
        mappingPattern,
        propertyFeatures: ['transitive'],
        disjointPropertyIris: ['https://w3id.org/sulo/hasParent'],
        isRequired: true,
      },
    })).json();
    expect(prop.mappingPattern).toEqual(mappingPattern);
    expect(prop.propertyFeatures).toEqual(['transitive']);
    expect(prop.isRequired).toBe(true);

    const full = (await app.inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    expect(full.classes).toHaveLength(2);
    expect(full.properties).toHaveLength(1);
    expect(full.properties[0].mappingPattern).toEqual(mappingPattern);
    expect(full.properties[0].disjointPropertyIris).toEqual(['https://w3id.org/sulo/hasParent']);

    // Patch the mapping pattern and isRequired
    const patched = [{ subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?value' }];
    const patchRes = await app.inject({
      method: 'PATCH', url: `/ontology-schemas/${schema.id}/properties/${prop.id}`,
      payload: { mappingPattern: patched, isRequired: false },
    });
    expect(patchRes.statusCode).toBe(204);

    const afterPatch = (await app.inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    expect(afterPatch.properties[0].mappingPattern).toEqual(patched);
    expect(afterPatch.properties[0].isRequired).toBe(false);

    // Deleting the parent class clears the child's superClassId (ON DELETE SET NULL)
    // rather than cascading the delete, since super_class_id is not the ownership link.
    const delClassRes = await app.inject({
      method: 'DELETE', url: `/ontology-schemas/${schema.id}/classes/${parent.id}`,
    });
    expect(delClassRes.statusCode).toBe(204);
    const afterClassDelete = (await app.inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    const remainingChild = afterClassDelete.classes.find((c: { id: string }) => c.id === child.id);
    expect(remainingChild.superClassId).toBeUndefined();

    // Deleting the schema cascades to its remaining classes and properties.
    const delSchemaRes = await app.inject({ method: 'DELETE', url: `/ontology-schemas/${schema.id}` });
    expect(delSchemaRes.statusCode).toBe(204);
    const afterSchemaDelete = await app.inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` });
    expect(afterSchemaDelete.statusCode).toBe(404);
  });

  it('updates schema metadata via PATCH', async () => {
    const schema = (await app.inject({
      method: 'POST', url: '/ontology-schemas', payload: { title: 'Original' },
    })).json();

    const patchRes = await app.inject({
      method: 'PATCH', url: `/ontology-schemas/${schema.id}`,
      payload: { title: 'Renamed', upperOntologyIri: 'https://w3id.org/sulo/' },
    });
    expect(patchRes.statusCode).toBe(204);

    const updated = (await app.inject({ method: 'GET', url: `/ontology-schemas/${schema.id}` })).json();
    expect(updated.title).toBe('Renamed');
    expect(updated.upperOntologyIri).toBe('https://w3id.org/sulo/');
  });

  it('normalizes baseUri on create and update, and returns it from both list and single-schema reads', async () => {
    const created = (await app.inject({
      method: 'POST', url: '/ontology-schemas',
      payload: { title: 'Has Base', baseUri: 'https://example.org/family' },
    })).json();
    expect(created.baseUri).toBe('https://example.org/family/');

    const listed = (await app.inject({ method: 'GET', url: '/ontology-schemas' })).json();
    expect(listed.find((s: { id: string }) => s.id === created.id).baseUri).toBe('https://example.org/family/');

    const fetched = (await app.inject({ method: 'GET', url: `/ontology-schemas/${created.id}` })).json();
    expect(fetched.baseUri).toBe('https://example.org/family/');

    await app.inject({
      method: 'PATCH', url: `/ontology-schemas/${created.id}`,
      payload: { baseUri: 'https://example.org/family2#' },
    });
    const afterPatch = (await app.inject({ method: 'GET', url: `/ontology-schemas/${created.id}` })).json();
    expect(afterPatch.baseUri).toBe('https://example.org/family2#');
  });
});
