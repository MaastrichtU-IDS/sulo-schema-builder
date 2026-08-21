// cacheKeyFor is the whole point of this module: a reasoning verdict is only
// safe to serve from cache when the OWL, the SULO digest reasoned against and
// the ROBOT toolchain are ALL the same as when it was produced. The
// SULO-hash case gets its own describe block, ahead of the others, because
// it is the one that stops a stale "consistent" badge surviving an upper
// ontology update (spec §3) — the failure this whole plan exists to prevent.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import { cacheKeyFor, findReport, storeReport, type CacheKeyInput } from './cache.js';

let t: TestDb;

beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => { await truncateAll(t.db); });

const BASE_INPUT: CacheKeyInput = {
  contentHash: 'a'.repeat(64),
  suloHash: 'b'.repeat(64),
  robotVersion: '1.9.7',
};

describe('cacheKeyFor', () => {
  it('changes the key when only the SULO digest changes', () => {
    // The case that prevents a stale "consistent" verdict surviving a SULO
    // update: identical OWL, identical ROBOT version, different SULO copy.
    const before = cacheKeyFor(BASE_INPUT);
    const after = cacheKeyFor({ ...BASE_INPUT, suloHash: 'c'.repeat(64) });
    expect(after).not.toBe(before);
  });

  it('is deterministic: identical inputs give identical keys', () => {
    expect(cacheKeyFor(BASE_INPUT)).toBe(cacheKeyFor({ ...BASE_INPUT }));
  });

  it('changes the key when the content hash changes', () => {
    const before = cacheKeyFor(BASE_INPUT);
    const after = cacheKeyFor({ ...BASE_INPUT, contentHash: 'd'.repeat(64) });
    expect(after).not.toBe(before);
  });

  it('changes the key when the ROBOT version changes', () => {
    const before = cacheKeyFor(BASE_INPUT);
    const after = cacheKeyFor({ ...BASE_INPUT, robotVersion: '1.9.8' });
    expect(after).not.toBe(before);
  });

  it('produces a sha256 hex digest', () => {
    expect(cacheKeyFor(BASE_INPUT)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('findReport', () => {
  it('misses on a key nothing has stored', async () => {
    const result = await findReport(t.db, 'f'.repeat(64));
    expect(result).toBeUndefined();
  });

  it('hits on a key storeReport wrote', async () => {
    const cacheKey = cacheKeyFor(BASE_INPUT);
    await storeReport(t.db, {
      cacheKey,
      report: { consistent: true, reasoner: 'HermiT', clashes: [] },
      reasoner: 'HermiT',
      suloHash: BASE_INPUT.suloHash,
      durationMs: 1234,
    });

    const result = await findReport(t.db, cacheKey);
    expect(result).toBeDefined();
    expect(result!.cacheKey).toBe(cacheKey);
    expect(result!.reasoner).toBe('HermiT');
    expect(result!.suloHash).toBe(BASE_INPUT.suloHash);
    expect(result!.durationMs).toBe(1234);
  });
});

describe('storeReport', () => {
  it('round-trips its jsonb report exactly, including nested clashes and explanations', async () => {
    const cacheKey = cacheKeyFor(BASE_INPUT);
    const report = {
      consistent: false,
      reasoner: 'HermiT',
      clashes: [
        {
          kind: 'unsatisfiable-class',
          iri: 'https://example.org/schema/Widget',
          label: 'Widget',
          explanation: 'Widget is a subclass of both :A and :B, which are disjoint.\n- :A\n- :B',
        },
        {
          kind: 'inconsistent-ontology',
          explanation: 'The ontology as a whole has no model.',
        },
      ],
    };

    await storeReport(t.db, {
      cacheKey,
      report,
      reasoner: 'HermiT',
      suloHash: BASE_INPUT.suloHash,
      durationMs: 42,
    });

    const result = await findReport(t.db, cacheKey);
    expect(result).toBeDefined();
    expect(result!.report).toEqual(report);
  });

  it('is idempotent on a concurrent duplicate: the second write does not error and does not clobber the first', async () => {
    const cacheKey = cacheKeyFor(BASE_INPUT);
    const first = { consistent: true, reasoner: 'HermiT', clashes: [] };
    const second = { consistent: false, reasoner: 'HermiT', clashes: [{ kind: 'inconsistent-ontology', explanation: 'should never be visible' }] };

    await storeReport(t.db, {
      cacheKey, report: first, reasoner: 'HermiT', suloHash: BASE_INPUT.suloHash, durationMs: 100,
    });

    // A second worker finishing an equivalent run writes the same cache_key.
    // This must not throw a unique-violation, and must not overwrite the
    // first winner's row.
    await expect(
      storeReport(t.db, {
        cacheKey, report: second, reasoner: 'HermiT', suloHash: BASE_INPUT.suloHash, durationMs: 999,
      }),
    ).resolves.toBeUndefined();

    const result = await findReport(t.db, cacheKey);
    expect(result!.report).toEqual(first);
    expect(result!.durationMs).toBe(100);
  });
});
