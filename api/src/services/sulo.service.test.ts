import { describe, it, expect } from 'vitest';
import { parseOntology } from '../rdf/fetchOntology.js';
import { compareVersions, readSuloMetadata, validateSulo, isNewer } from './sulo.service.js';

const PREAMBLE = `
@prefix owl:     <http://www.w3.org/2002/07/owl#> .
@prefix rdfs:    <http://www.w3.org/2000/01/rdf-schema#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
@prefix sulo:    <https://w3id.org/sulo/> .
`;

/** A minimal but structurally valid SULO document. */
function suloDoc(opts: { version?: string; modified?: string; classes?: number } = {}): string {
  const { version = '0.2.14', modified = '2026-05-19', classes = 21 } = opts;
  const header = [
    'sulo: a owl:Ontology',
    `    rdfs:label "Simplified Upper Level Ontology"@en`,
    ...(version ? [`    owl:versionInfo "${version}"`] : []),
    ...(modified ? [`    dcterms:modified "${modified}"`] : []),
  ].join(' ;\n') + ' .\n';

  const body = Array.from({ length: classes }, (_, i) => `sulo:Class${i} a owl:Class .`).join('\n');
  return `${PREAMBLE}\n${header}\n${body}\n`;
}

function quadsOf(ttl: string) {
  const parsed = parseOntology(ttl);
  if (!parsed) throw new Error('fixture failed to parse');
  return parsed.quads;
}

describe('compareVersions', () => {
  it('compares numerically, not lexically', () => {
    // SULO's own history is the motivating case: 0.2.14 succeeds 0.2.3, but
    // "0.2.14" sorts *before* "0.2.3" as a string.
    expect(compareVersions('0.2.14', '0.2.3')).toBeGreaterThan(0);
    expect(compareVersions('0.2.3', '0.2.14')).toBeLessThan(0);
  });

  it('treats equal versions as equal, including differing segment counts', () => {
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });

  it('returns null when a segment is not numeric', () => {
    expect(compareVersions('1.2.x', '1.2.3')).toBeNull();
    expect(compareVersions('draft', '1.0')).toBeNull();
  });
});

describe('readSuloMetadata', () => {
  it('pulls version and modified date off the ontology header', () => {
    expect(readSuloMetadata(quadsOf(suloDoc()))).toMatchObject({
      iri: 'https://w3id.org/sulo/',
      version: '0.2.14',
      modified: '2026-05-19',
    });
  });

  it('returns an empty result when there is no owl:Ontology', () => {
    expect(readSuloMetadata(quadsOf(`${PREAMBLE}\nsulo:Thing a owl:Class .`))).toEqual({});
  });
});

describe('validateSulo', () => {
  it('accepts a real-shaped SULO document', () => {
    expect(validateSulo(quadsOf(suloDoc()))).toEqual({ ok: true });
  });

  it('rejects a document with no ontology declaration', () => {
    const result = validateSulo(quadsOf(`${PREAMBLE}\nsulo:Thing a owl:Class .`));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/owl:Ontology/);
  });

  it('rejects a truncated document that parses but lost its classes', () => {
    const result = validateSulo(quadsOf(suloDoc({ classes: 2 })));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/owl:Class/);
  });

  it('rejects a captive-portal HTML body, which never parses as Turtle', () => {
    // parseOntology returns null rather than throwing, which is what keeps a
    // hotel wifi login page from ever reaching validateSulo in the first place.
    expect(parseOntology('<!DOCTYPE html><html><body>Sign in</body></html>')).toBeNull();
  });
});

describe('isNewer', () => {
  it('prefers versionInfo when both sides have one', () => {
    expect(isNewer({ version: '0.2.3' }, { version: '0.2.14' })).toBe(true);
    expect(isNewer({ version: '0.2.14' }, { version: '0.2.3' })).toBe(false);
    expect(isNewer({ version: '0.2.14' }, { version: '0.2.14' })).toBe(false);
  });

  it('falls back to dcterms:modified when versions are missing or uncomparable', () => {
    expect(isNewer({ modified: '2026-05-19' }, { modified: '2026-06-01' })).toBe(true);
    expect(isNewer({ modified: '2026-06-01' }, { modified: '2026-05-19' })).toBe(false);
    expect(
      isNewer({ version: 'draft', modified: '2026-05-19' }, { version: 'final', modified: '2026-06-01' }),
    ).toBe(true);
  });

  it('does not churn the cached copy when there is no usable signal', () => {
    expect(isNewer({}, {})).toBe(false);
    expect(isNewer({ version: '0.2.14' }, {})).toBe(false);
  });
});
