import { describe, it, expect } from 'vitest';
import {
  NewSchemaFormSchema,
  NewClassFormSchema,
  NewPropertyFormSchema,
} from './formSchemas.js';

// ════════════════════════════════════════════════════════════════════════════
// Schema form
// ════════════════════════════════════════════════════════════════════════════

describe('NewSchemaFormSchema', () => {
  it('accepts a title with optional empty upper ontology IRI', () => {
    const r = NewSchemaFormSchema.safeParse({ title: 'My Schema', upperOntologyIri: '' });
    expect(r.success).toBe(true);
  });
  it('rejects an empty title', () => {
    const r = NewSchemaFormSchema.safeParse({ title: '' });
    expect(r.success).toBe(false);
  });
  it('rejects a malformed upper ontology IRI', () => {
    const r = NewSchemaFormSchema.safeParse({ title: 'X', upperOntologyIri: 'not a url' });
    expect(r.success).toBe(false);
  });
  it('accepts a valid upper ontology IRI', () => {
    const r = NewSchemaFormSchema.safeParse({ title: 'X', upperOntologyIri: 'https://w3id.org/sulo/' });
    expect(r.success).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Class form — name format
// ════════════════════════════════════════════════════════════════════════════

describe('NewClassFormSchema', () => {
  it('accepts a single-token name', () => {
    expect(NewClassFormSchema.safeParse({ name: 'ClinicalVisit' }).success).toBe(true);
  });
  it('rejects a name containing spaces', () => {
    const r = NewClassFormSchema.safeParse({ name: 'Clinical Visit' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe('No spaces allowed');
  });
  it('rejects an empty name', () => {
    expect(NewClassFormSchema.safeParse({ name: '' }).success).toBe(false);
  });
  it('leaves mapsToConceptIri unconstrained (any string)', () => {
    expect(NewClassFormSchema.safeParse({ name: 'Foo', mapsToConceptIri: 'not-a-url' }).success).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Property form
// ════════════════════════════════════════════════════════════════════════════

describe('NewPropertyFormSchema', () => {
  const valid = {
    name: 'hasCode',
    propertyType: 'object' as const,
    domainClassId: 'c1',
    isRequired: false,
  };

  it('accepts a minimal valid property', () => {
    expect(NewPropertyFormSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a property name with spaces', () => {
    expect(NewPropertyFormSchema.safeParse({ ...valid, name: 'has Code' }).success).toBe(false);
  });

  it('requires a domain class', () => {
    const r = NewPropertyFormSchema.safeParse({ ...valid, domainClassId: '' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.message === 'Domain class is required')).toBe(true);
  });

  it('rejects an invalid propertyType', () => {
    expect(NewPropertyFormSchema.safeParse({ ...valid, propertyType: 'annotation' }).success).toBe(false);
  });

  it('round-trips a mapping pattern array', () => {
    const mappingPattern = [
      { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant', object: '?o1' },
      { subject: '?o1', predicate: 'https://w3id.org/sulo/isFeatureOf', object: '?value' },
    ];
    const r = NewPropertyFormSchema.safeParse({ ...valid, mappingPattern });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.mappingPattern).toEqual(mappingPattern);
  });

  it('accepts propertyFeatures, inversePropertyIri and disjointPropertyIris', () => {
    const r = NewPropertyFormSchema.safeParse({
      ...valid,
      propertyFeatures: ['functional', 'transitive'],
      inversePropertyIri: 'isCodeOf',
      disjointPropertyIris: ['hasPatient', 'hasProvider'],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.propertyFeatures).toEqual(['functional', 'transitive']);
      expect(r.data.disjointPropertyIris).toEqual(['hasPatient', 'hasProvider']);
    }
  });

  it('rejects a mapping pattern triple missing a field', () => {
    const r = NewPropertyFormSchema.safeParse({
      ...valid,
      mappingPattern: [{ subject: '?this', predicate: 'p' }],
    });
    expect(r.success).toBe(false);
  });
});
