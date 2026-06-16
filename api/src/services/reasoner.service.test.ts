import { describe, it, expect } from 'vitest';
import {
  stripMdLinks,
  parseUnsatisfiability,
  parseInconsistency,
} from './reasoner.service.js';

// Real ROBOT `explain` output samples (HermiT, SULO 0.2.14), captured from the
// CLI. The parser must be robust to this exact shape.

describe('stripMdLinks', () => {
  it('replaces Markdown links with their text', () => {
    expect(stripMdLinks('[object](https://w3id.org/sulo/Object) SubClassOf [Nothing](x)'))
      .toBe('object SubClassOf Nothing');
  });
  it('leaves plain text untouched', () => {
    expect(stripMdLinks('Reflexive: foo')).toBe('Reflexive: foo');
  });
});

describe('parseUnsatisfiability', () => {
  const UNSAT_MD = `## [Eternity](https://ex.org/Eternity) SubClassOf [Nothing](http://www.w3.org/2002/07/owl#Nothing) ##

  - [Eternity](https://ex.org/Eternity) SubClassOf [time](https://w3id.org/sulo/Time)
    - [time](https://w3id.org/sulo/Time) DisjointUnionOf [duration](https://w3id.org/sulo/Duration), [time instant](https://w3id.org/sulo/TimeInstant), [time interval](https://w3id.org/sulo/TimeInterval)
  - [Eternity](https://ex.org/Eternity) DisjointWith [time interval](https://w3id.org/sulo/TimeInterval)


## [ObjectWithProcessPart](https://ex.org/ObjectWithProcessPart) SubClassOf [Nothing](http://www.w3.org/2002/07/owl#Nothing) ##

  - [ObjectWithProcessPart](https://ex.org/ObjectWithProcessPart) SubClassOf [object](https://w3id.org/sulo/Object)
    - [object](https://w3id.org/sulo/Object) SubClassOf not ([has part](https://w3id.org/sulo/hasPart) some [process](https://w3id.org/sulo/Process))
  - [ObjectWithProcessPart](https://ex.org/ObjectWithProcessPart) SubClassOf [has part](https://w3id.org/sulo/hasPart) some [process](https://w3id.org/sulo/Process)

# Axiom Impact
## Axioms used 1 times
- [Eternity](https://ex.org/Eternity) SubClassOf [time](https://w3id.org/sulo/Time) [<https://w3id.org/sulo/>]
`;

  it('returns one clash per unsatisfiable class', () => {
    const clashes = parseUnsatisfiability(UNSAT_MD);
    expect(clashes).toHaveLength(2);
    expect(clashes.map((c) => c.label)).toEqual(['Eternity', 'ObjectWithProcessPart']);
    expect(clashes[0].iri).toBe('https://ex.org/Eternity');
    expect(clashes.every((c) => c.kind === 'unsatisfiable-class')).toBe(true);
  });

  it('strips links from explanations and stops before the Axiom Impact section', () => {
    const [eternity] = parseUnsatisfiability(UNSAT_MD);
    expect(eternity.explanation).toContain('Eternity SubClassOf time');
    expect(eternity.explanation).toContain('time DisjointUnionOf duration, time instant, time interval');
    expect(eternity.explanation).not.toContain('[');
    expect(eternity.explanation).not.toContain('Axiom Impact');
  });

  it('handles "No explanations found." as consistent (no clashes)', () => {
    expect(parseUnsatisfiability('No explanations found.')).toEqual([]);
    expect(parseUnsatisfiability('')).toEqual([]);
  });

  it('drops the owl:Nothing header itself (not a real class clash)', () => {
    const md = `## [Nothing](http://www.w3.org/2002/07/owl#Nothing) SubClassOf [Nothing](http://www.w3.org/2002/07/owl#Nothing) ##\n  - trivial\n`;
    expect(parseUnsatisfiability(md)).toEqual([]);
  });
});

describe('parseInconsistency', () => {
  const INCON_MD = `## [Thing](http://www.w3.org/2002/07/owl#Thing) SubClassOf [Nothing](http://www.w3.org/2002/07/owl#Nothing) ##

  -  Reflexive: [is part of](https://w3id.org/sulo/isPartOf)
  - [object](https://w3id.org/sulo/Object) SubClassOf not ([has part](https://w3id.org/sulo/hasPart) some [process](https://w3id.org/sulo/Process))
  - [x](https://ex.org/x) Type [process](https://w3id.org/sulo/Process)
  - [x](https://ex.org/x) Type [object](https://w3id.org/sulo/Object)

# Axiom Impact
`;

  it('returns a single inconsistency clash naming the offending individual', () => {
    const clash = parseInconsistency(INCON_MD);
    expect(clash).not.toBeNull();
    expect(clash!.kind).toBe('inconsistent-ontology');
    expect(clash!.explanation).toContain('inconsistent');
    expect(clash!.explanation).toContain('involving: x');
    expect(clash!.explanation).not.toContain('[');
  });

  it('returns null when consistent', () => {
    expect(parseInconsistency('No explanations found.')).toBeNull();
    expect(parseInconsistency('')).toBeNull();
  });
});
