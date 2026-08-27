import { describe, it, expect } from 'vitest';
import {
  extractNamedGroups,
  escTtl,
  shortenIri,
  buildOwlExpr,
  buildReverseOwlExpr,
  buildMermaid,
  generateExports,
  PROPERTY_FEATURE_OWL,
} from './ontologyExport.js';
import type {
  OntologyClass,
  OntologyProperty,
  OntologySchema,
  TripleTemplate,
} from './types.js';

// ─── Fixture builders ─────────────────────────────────────────────────────────

const CLASS_BASE = 'https://w3id.org/sulo/schema/resource/ontology-class/';
const PROP_BASE  = 'https://w3id.org/sulo/schema/resource/ontology-property/';

function cls(id: string, name: string, extra: Partial<OntologyClass> = {}): OntologyClass {
  return { id, url: `${CLASS_BASE}${id}`, name, ...extra };
}

function prop(id: string, name: string, extra: Partial<OntologyProperty> = {}): OntologyProperty {
  return {
    id, url: `${PROP_BASE}${id}`, name,
    propertyType: 'datatype',
    mappingPattern: [],
    isRequired: false,
    propertyFeatures: [],
    disjointPropertyIris: [],
    ...extra,
  };
}

function schema(classes: OntologyClass[], properties: OntologyProperty[], extra: Partial<OntologySchema> = {}): OntologySchema {
  return {
    id: 'sch1',
    url: 'https://w3id.org/sulo/schema/resource/ontology-schema/sch1',
    title: 'Test Schema',
    classes,
    properties,
    ...extra,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// extractNamedGroups
// ════════════════════════════════════════════════════════════════════════════

describe('extractNamedGroups', () => {
  it('extracts a single named group', () => {
    expect(extractNamedGroups('(?<family>[a-z]+)')).toEqual(['family']);
  });
  it('extracts multiple named groups in order', () => {
    expect(extractNamedGroups('(?<family>[a-z]+), (?<given>[a-z]+)')).toEqual(['family', 'given']);
  });
  it('ignores non-capturing groups', () => {
    expect(extractNamedGroups('(?:foo)(?<x>bar)')).toEqual(['x']);
  });
  it('returns [] when there are no named groups', () => {
    expect(extractNamedGroups('([a-z]+)')).toEqual([]);
    expect(extractNamedGroups('')).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// escTtl
// ════════════════════════════════════════════════════════════════════════════

describe('escTtl', () => {
  it('escapes double quotes', () => {
    expect(escTtl('say "hi"')).toBe('say \\"hi\\"');
  });
  it('escapes backslashes before quotes (order matters)', () => {
    expect(escTtl('a\\b')).toBe('a\\\\b');
  });
  it('escapes newlines', () => {
    expect(escTtl('line1\nline2')).toBe('line1\\nline2');
  });
  it('leaves plain text untouched', () => {
    expect(escTtl('plain text')).toBe('plain text');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// shortenIri
// ════════════════════════════════════════════════════════════════════════════

describe('shortenIri', () => {
  const pfx = {
    '':   'https://example.org/base/',
    xsd:  'http://www.w3.org/2001/XMLSchema#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  };
  it('uses the empty prefix for the base namespace', () => {
    expect(shortenIri('https://example.org/base/Foo', pfx)).toBe(':Foo');
  });
  it('uses a named prefix', () => {
    expect(shortenIri('http://www.w3.org/2001/XMLSchema#string', pfx)).toBe('xsd:string');
  });
  it('falls back to <iri> when no prefix matches', () => {
    expect(shortenIri('http://snomed.info/id/12345', pfx)).toBe('<http://snomed.info/id/12345>');
  });
  it('falls back to <iri> when the local part is not a valid name', () => {
    // local part "12345" starts with a digit → invalid local name → full IRI
    expect(shortenIri('https://example.org/base/12345', pfx)).toBe('<https://example.org/base/12345>');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// buildOwlExpr
// ════════════════════════════════════════════════════════════════════════════

describe('buildOwlExpr', () => {
  const pfx = { '': 'https://ex/', sulo: 'https://w3id.org/sulo/' };
  const classMap = new Map<string, string>();

  it('returns owl:Thing for an empty pattern', () => {
    expect(buildOwlExpr('?this', [], 'https://ex/Foo', pfx, classMap)).toBe('owl:Thing');
  });

  it('builds a someValuesFrom restriction terminating at ?value', () => {
    const pattern: TripleTemplate[] = [
      { subject: '?this', predicate: 'https://w3id.org/sulo/hasValue', object: '?value' },
    ];
    const out = buildOwlExpr('?this', pattern, 'http://www.w3.org/2001/XMLSchema#string', { ...pfx, xsd: 'http://www.w3.org/2001/XMLSchema#' }, classMap);
    expect(out).toContain('owl:Restriction');
    expect(out).toContain('owl:onProperty sulo:hasValue');
    expect(out).toContain('owl:someValuesFrom xsd:string');
  });

  it('treats rdf:type triples as intersection members and chains variables', () => {
    const pattern: TripleTemplate[] = [
      { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant', object: '?o1' },
      { subject: '?o1', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://ex/Role' },
      { subject: '?o1', predicate: 'https://w3id.org/sulo/isFeatureOf', object: '?value' },
    ];
    const out = buildOwlExpr('?this', pattern, 'https://ex/Person', pfx, classMap);
    // outer restriction on hasParticipant whose filler is an intersection of :Role + isFeatureOf restriction
    expect(out).toContain('owl:onProperty sulo:hasParticipant');
    expect(out).toContain('owl:intersectionOf');
    expect(out).toContain(':Role');
    expect(out).toContain('owl:onProperty sulo:isFeatureOf');
    expect(out).toContain('owl:someValuesFrom :Person');
  });

  // A "hasChild"-style n-ary pattern: two independent forward chains off
  // ?this and ?value converge on a shared ?o2 (a HavingChild process) rather
  // than one linear ?this→...→?value chain. ?o2 is only reachable from
  // ?value's side by walking the ?o3→?o2 edge backwards, which the plain
  // forward-only walk previously dropped entirely — the whole ChildRole/
  // isFeatureOf/?value tail vanished from the exported expression.
  it('folds a convergent n-ary pattern via an inverse restriction, reaching ?value through a shared node', () => {
    const pattern: TripleTemplate[] = [
      { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?o1' },
      { subject: '?o1', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://ex/ParentRole' },
      { subject: '?o1', predicate: 'https://w3id.org/sulo/isParticipantIn', object: '?o2' },
      { subject: '?o2', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://ex/HavingChild' },
      { subject: '?o3', predicate: 'https://w3id.org/sulo/isParticipantIn', object: '?o2' },
      { subject: '?o3', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://ex/ChildRole' },
      { subject: '?o3', predicate: 'https://w3id.org/sulo/isFeatureOf', object: '?value' },
    ];
    const out = buildOwlExpr('?this', pattern, 'https://ex/Person', pfx, classMap, 'https://ex/Person');
    expect(out).toContain(':Person');
    expect(out).toContain('owl:onProperty sulo:hasFeature');
    expect(out).toContain(':ParentRole');
    expect(out).toContain('owl:onProperty sulo:isParticipantIn');
    expect(out).toContain(':HavingChild');
    // the previously-dropped tail: reached only via the inverted isParticipantIn edge
    expect(out).toContain('owl:inverseOf sulo:isParticipantIn');
    expect(out).toContain(':ChildRole');
    expect(out).toContain('owl:onProperty sulo:isFeatureOf');
    expect(out).toContain('owl:someValuesFrom :Person');
  });
});

describe('buildReverseOwlExpr', () => {
  const pfx = { '': 'https://ex/', sulo: 'https://w3id.org/sulo/' };
  const classMap = new Map<string, string>();

  it('includes the range class and walks a linear chain back to the domain class', () => {
    const pattern: TripleTemplate[] = [
      { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant', object: '?o1' },
      { subject: '?o1', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://ex/Role' },
      { subject: '?o1', predicate: 'https://w3id.org/sulo/isFeatureOf', object: '?value' },
    ];
    const out = buildReverseOwlExpr('?value', pattern, 'https://ex/Visit', 'https://ex/Person', pfx, classMap);
    expect(out).toContain(':Person');
    expect(out).toContain('owl:inverseOf sulo:isFeatureOf');
    expect(out).toContain(':Role');
    expect(out).toContain('owl:inverseOf sulo:hasParticipant');
    expect(out).toContain(':Visit');
  });

  // Mirrors the buildOwlExpr n-ary test above, from the ?value side: reaching
  // back to ?o2 means walking the ?o3→?o2 edge forward (not inverted, since
  // we're now the one extending toward it), matching the domain-side result.
  it('folds a convergent n-ary pattern via a forward restriction when walking back from ?value', () => {
    const pattern: TripleTemplate[] = [
      { subject: '?this', predicate: 'https://w3id.org/sulo/hasFeature', object: '?o1' },
      { subject: '?o1', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://ex/ParentRole' },
      { subject: '?o1', predicate: 'https://w3id.org/sulo/isParticipantIn', object: '?o2' },
      { subject: '?o2', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://ex/HavingChild' },
      { subject: '?o3', predicate: 'https://w3id.org/sulo/isParticipantIn', object: '?o2' },
      { subject: '?o3', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://ex/ChildRole' },
      { subject: '?o3', predicate: 'https://w3id.org/sulo/isFeatureOf', object: '?value' },
    ];
    const out = buildReverseOwlExpr('?value', pattern, 'https://ex/Person', 'https://ex/Person', pfx, classMap);
    expect(out).toContain(':Person');
    expect(out).toContain('owl:inverseOf sulo:isFeatureOf');
    expect(out).toContain(':ChildRole');
    // the forward (non-inverted) hop from ?o3 to the shared ?o2 node
    expect(out).toContain('owl:onProperty sulo:isParticipantIn');
    expect(out).toContain(':HavingChild');
    expect(out).toContain('owl:inverseOf sulo:isParticipantIn');
    expect(out).toContain(':ParentRole');
    expect(out).toContain('owl:inverseOf sulo:hasFeature');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// buildMermaid
// ════════════════════════════════════════════════════════════════════════════

describe('buildMermaid', () => {
  it('emits classDiagram header and one class block per class', () => {
    const out = buildMermaid(schema([cls('c1', 'Visit'), cls('c2', 'Person')], []));
    expect(out.startsWith('classDiagram')).toBe(true);
    expect(out).toContain('class Visit {');
    expect(out).toContain('class Person {');
  });

  it('uses --> for object properties and ..> for datatype properties', () => {
    const c1 = cls('c1', 'Visit');
    const c2 = cls('c2', 'Person');
    const objProp = prop('p1', 'hasPatient', { propertyType: 'object', domainClassId: 'c1', rangeClassIri: c2.url });
    const dtProp  = prop('p2', 'hasDate',    { propertyType: 'datatype', domainClassId: 'c1', rangeClassIri: c2.url });
    const out = buildMermaid(schema([c1, c2], [objProp, dtProp]));
    expect(out).toContain('Visit --> Person : hasPatient');
    expect(out).toContain('Visit ..> Person : hasDate');
  });

  it('renders a SULO stereotype for SULO-mapped classes and inheritance edges', () => {
    const parent = cls('c1', 'Procedure');
    const child  = cls('c2', 'Measurement', { superClassId: 'c1', mapsToConceptIri: 'https://w3id.org/sulo/Process' });
    const out = buildMermaid(schema([parent, child], []));
    expect(out).toContain('<<sulo:Process>>');
    expect(out).toContain('Procedure <|-- Measurement');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// generateExports — Turtle (plain RDFS) vs OWL
// ════════════════════════════════════════════════════════════════════════════

describe('generateExports — plain vs OWL', () => {
  const c1 = cls('c1', 'Visit', { label: 'Clinical Visit', mapsToConceptIri: 'https://w3id.org/sulo/Process' });
  const s  = schema([c1], [], { upperOntologyIri: 'https://w3id.org/sulo/' });

  it('plain Turtle uses rdfs:Class and no owl: types', () => {
    const { turtlePlain } = generateExports(s);
    expect(turtlePlain).toContain('a rdfs:Class');
    expect(turtlePlain).not.toContain('owl:Class');
    expect(turtlePlain).not.toContain('owl:Ontology');
  });

  it('OWL Turtle declares owl:Ontology, owl:Class and owl:imports for SULO mappings', () => {
    const { turtleOwl } = generateExports(s);
    expect(turtleOwl).toContain('a owl:Ontology');
    expect(turtleOwl).toContain('a owl:Class');
    expect(turtleOwl).toContain('owl:imports <https://w3id.org/sulo/>');
    expect(turtleOwl).toContain('rdfs:subClassOf sulo:Process');
  });

  // The domain/range equivalent-class axioms need an anchor IRI to hang
  // owl:equivalentClass off of (there's no real class to attach it to — it's
  // synthesized per property). That anchor is a readable, deterministic
  // `{DomainClass}_{propertyName}_domain`/`_range` name under the schema's
  // own namespace, not a random UUID.
  it('mints readable, deterministic domain/range equivalent-class anchor IRIs instead of random UUIDs', () => {
    const visit  = cls('c1', 'ClinicalVisit', { mapsToConceptIri: 'https://w3id.org/sulo/Process' });
    const person = cls('c2', 'Person', { mapsToConceptIri: 'https://w3id.org/sulo/SpatialObject' });
    const p = prop('p1', 'hasPatient', {
      propertyType: 'object', domainClassId: 'c1', rangeClassIri: person.url,
      mappingPattern: [
        { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant', object: '?value' },
      ],
    });
    const s2 = schema([visit, person], [p], { upperOntologyIri: 'https://w3id.org/sulo/' });
    const { turtleOwl } = generateExports(s2);
    expect(turtleOwl).toContain('owl:equivalentClass');
    expect(turtleOwl).toContain(`rdfs:domain <${s2.url}/ClinicalVisit_hasPatient_domain>`);
    expect(turtleOwl).toContain(`<${s2.url}/ClinicalVisit_hasPatient_domain>\n    owl:equivalentClass`);
    expect(turtleOwl).toContain(`rdfs:range <${s2.url}/ClinicalVisit_hasPatient_range>`);
    expect(turtleOwl).toContain(`<${s2.url}/ClinicalVisit_hasPatient_range>\n    owl:equivalentClass`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// generateExports — custom baseUri
// ════════════════════════════════════════════════════════════════════════════

describe('generateExports — custom baseUri', () => {
  it('defaults to the schema URL when no baseUri is set', () => {
    const c1 = cls('c1', 'Visit');
    const s  = schema([c1], []);
    const { turtlePlain } = generateExports(s);
    expect(turtlePlain).toContain(`@prefix : <${s.url}/> .`);
  });

  it('mints class/property IRIs under a custom baseUri instead of the schema URL', () => {
    const c1 = cls('c1', 'Visit');
    const p1 = prop('p1', 'hasDate', { propertyType: 'datatype', domainClassId: 'c1' });
    const s  = schema([c1], [p1], { baseUri: 'https://example.org/family/' });
    const { turtlePlain } = generateExports(s);
    expect(turtlePlain).toContain('@prefix : <https://example.org/family/> .');
    expect(turtlePlain).toContain(':Visit');
    expect(turtlePlain).toContain(':hasDate');
    // the ontology document keeps its own identity IRI (schema.url) in the
    // header triple — only the class/property namespace changes
    expect(turtlePlain).toContain(s.url);
  });

  it('normalizes a baseUri with no trailing slash or hash', () => {
    const c1 = cls('c1', 'Visit');
    const s  = schema([c1], [], { baseUri: 'https://example.org/family' });
    const { turtlePlain } = generateExports(s);
    expect(turtlePlain).toContain('@prefix : <https://example.org/family/> .');
  });

  it('leaves a baseUri already ending in # untouched', () => {
    const c1 = cls('c1', 'Visit');
    const s  = schema([c1], [], { baseUri: 'https://example.org/family#' });
    const { turtlePlain } = generateExports(s);
    expect(turtlePlain).toContain('@prefix : <https://example.org/family#> .');
  });

  // The domain/range equivalent-class axioms need an anchor IRI to hang
  // owl:equivalentClass off of (there's no real class to attach it to — it's
  // synthesized per property). Those anchors are readable, deterministic
  // `{DomainClass}_{propertyName}_domain`/`_range` names under the schema's
  // own baseUri — not a random UUID, and not the hardcoded default
  // namespace, or a schema using a custom baseUri would export two
  // different namespaces.
  it('mints readable, deterministic domain/range equivalent-class anchor IRIs under the custom baseUri', () => {
    const visit   = cls('c1', 'ClinicalVisit', { mapsToConceptIri: 'https://w3id.org/sulo/Process' });
    const person  = cls('c2', 'Person', { mapsToConceptIri: 'https://w3id.org/sulo/SpatialObject' });
    const p = prop('p1', 'hasPatient', {
      propertyType: 'object', domainClassId: 'c1', rangeClassIri: person.url,
      mappingPattern: [
        { subject: '?this', predicate: 'https://w3id.org/sulo/hasParticipant', object: '?value' },
      ],
    });
    const s = schema([visit, person], [p], { baseUri: 'https://example.org/family/', upperOntologyIri: 'https://w3id.org/sulo/' });
    const { turtleOwl } = generateExports(s);
    expect(turtleOwl).toContain('owl:equivalentClass');
    expect(turtleOwl).not.toContain('w3id.org/sulo/schema/resource/ontology-class/');
    expect(turtleOwl).toContain('rdfs:domain <https://example.org/family/ClinicalVisit_hasPatient_domain>');
    expect(turtleOwl).toContain('<https://example.org/family/ClinicalVisit_hasPatient_domain>\n    owl:equivalentClass');
    expect(turtleOwl).toContain('rdfs:range <https://example.org/family/ClinicalVisit_hasPatient_range>');
    expect(turtleOwl).toContain('<https://example.org/family/ClinicalVisit_hasPatient_range>\n    owl:equivalentClass');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// generateExports — property characteristics (the feature we added)
// ════════════════════════════════════════════════════════════════════════════

describe('generateExports — property characteristics', () => {
  it('appends OWL characteristic types to the base property type', () => {
    const c1 = cls('c1', 'Visit');
    const p  = prop('p1', 'hasDate', {
      propertyType: 'object', domainClassId: 'c1',
      propertyFeatures: ['functional', 'transitive'],
    });
    const { turtleOwl } = generateExports(schema([c1], [p]));
    expect(turtleOwl).toContain(`a owl:ObjectProperty, ${PROPERTY_FEATURE_OWL.functional}, ${PROPERTY_FEATURE_OWL.transitive}`);
  });

  it('emits owl:inverseOf for a schema-name inverse and <iri> for an external one', () => {
    const c1 = cls('c1', 'Visit');
    const schemaInv = prop('p1', 'hasPatient', { propertyType: 'object', domainClassId: 'c1', inversePropertyIri: 'isPatientOf' });
    const externInv = prop('p2', 'sameAsThing', { propertyType: 'object', domainClassId: 'c1', inversePropertyIri: 'http://example.org/ext#inv' });
    const { turtleOwl } = generateExports(schema([c1], [schemaInv, externInv]));
    expect(turtleOwl).toContain('owl:inverseOf :isPatientOf');
    expect(turtleOwl).toContain('owl:inverseOf <http://example.org/ext#inv>');
  });

  it('emits owl:propertyDisjointWith for each disjoint reference', () => {
    const c1 = cls('c1', 'Visit');
    const p  = prop('p1', 'hasCareProvider', {
      propertyType: 'object', domainClassId: 'c1',
      disjointPropertyIris: ['hasPatient'],
    });
    const { turtleOwl } = generateExports(schema([c1], [p]));
    expect(turtleOwl).toContain('owl:propertyDisjointWith :hasPatient');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// generateExports — multi-range union (OWL owl:unionOf + SHACL sh:or)
// ════════════════════════════════════════════════════════════════════════════

describe('generateExports — multi-range union', () => {
  const visit = cls('c1', 'Visit');
  const code  = cls('c2', 'Code');
  const obs   = cls('c3', 'ObservableEntity');
  // same property name + domain, two distinct ranges → union
  const p1 = prop('p1', 'hasCode', { propertyType: 'object', domainClassId: 'c1', rangeClassIri: code.url });
  const p2 = prop('p2', 'hasCode', { propertyType: 'object', domainClassId: 'c1', rangeClassIri: obs.url });
  const s  = schema([visit, code, obs], [p1, p2]);

  it('OWL emits owl:unionOf over the distinct ranges', () => {
    const { turtleOwl } = generateExports(s);
    expect(turtleOwl).toContain('owl:unionOf');
    expect(turtleOwl).toContain(':Code');
    expect(turtleOwl).toContain(':ObservableEntity');
  });

  it('SHACL emits sh:or over the distinct ranges', () => {
    const { shaclTtl } = generateExports(s);
    expect(shaclTtl).toContain('sh:or (');
    expect(shaclTtl).toContain('[ sh:class :Code ]');
    expect(shaclTtl).toContain('[ sh:class :ObservableEntity ]');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// generateExports — SHACL cardinality and datatype
// ════════════════════════════════════════════════════════════════════════════

describe('generateExports — SHACL shapes', () => {
  const c1 = cls('c1', 'Measurement');
  const required = prop('p1', 'hasValue', {
    propertyType: 'datatype', domainClassId: 'c1',
    rangeClassIri: 'http://www.w3.org/2001/XMLSchema#float',
    isRequired: true,
  });
  const optional = prop('p2', 'note', {
    propertyType: 'datatype', domainClassId: 'c1',
    rangeClassIri: 'http://www.w3.org/2001/XMLSchema#string',
    isRequired: false,
  });
  const s = generateExports(schema([c1], [required, optional]));

  it('targets the class with a NodeShape', () => {
    expect(s.shaclTtl).toContain(':MeasurementShape');
    expect(s.shaclTtl).toContain('sh:targetClass :Measurement');
  });
  it('maps datatype range to sh:datatype', () => {
    expect(s.shaclTtl).toContain('sh:datatype xsd:float');
    expect(s.shaclTtl).toContain('sh:datatype xsd:string');
  });
  it('sets sh:minCount 1 for required, 0 for optional', () => {
    expect(s.shaclTtl).toMatch(/sh:path :hasValue ;[\s\S]*?sh:minCount 1/);
    expect(s.shaclTtl).toMatch(/sh:path :note ;[\s\S]*?sh:minCount 0/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// generateExports — external (non-SULO) class IRIs identified by their IRI
// ════════════════════════════════════════════════════════════════════════════

describe('generateExports — external concept IRIs', () => {
  it('identifies a class by its non-SULO mapsToConceptIri', () => {
    const sct = cls('c1', 'SCT_Procedure', { mapsToConceptIri: 'http://snomed.info/id/71388002' });
    const { turtleOwl } = generateExports(schema([sct], []));
    expect(turtleOwl).toContain('<http://snomed.info/id/71388002>');
  });
});
