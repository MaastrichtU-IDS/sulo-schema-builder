// getSuloDigest() is what a reasoning verdict's cache key is keyed on
// (modules/reasoning/cache.ts's suloHash). Getting its invalidation right is
// the point of this file, not incidental coverage: a memo that survives a
// SULO replacement means a "consistent" badge can be served against an
// upper ontology that no longer exists on disk — the single worst failure
// mode in the wider caching plan.
//
// Kept in its own file (rather than folded into sulo.service.test.ts, which
// only exercises the pure helpers) because these cases need module-level
// state reset between tests (vi.resetModules + a fresh dynamic import) and,
// for the checkForSuloUpdate cases, a mocked config and a mocked network
// fetch — machinery the pure-helper suite has no reason to carry.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A minimal but structurally valid SULO document, mirroring sulo.service.test.ts's fixture. */
function suloDoc(opts: { version?: string; classes?: number } = {}): string {
  const { version = '0.2.14', classes = 21 } = opts;
  const header = [
    'sulo: a owl:Ontology',
    `    rdfs:label "Simplified Upper Level Ontology"@en`,
    `    owl:versionInfo "${version}"`,
  ].join(' ;\n') + ' .\n';
  const body = Array.from({ length: classes }, (_, i) => `sulo:Class${i} a owl:Class .`).join('\n');
  return [
    '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
    '@prefix sulo: <https://w3id.org/sulo/> .',
    '',
    header,
    body,
    '',
  ].join('\n');
}

describe('getSuloDigest', () => {
  let dir: string;
  let filePath: string;

  async function freshSuloService() {
    vi.resetModules();
    return import('./sulo.service.js');
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sulo-digest-'));
    filePath = join(dir, 'sulo.ttl');
    // The existing SULO_TTL_PATH override lets resolveSuloPath() point at a
    // fully test-controlled file without touching anything in resources/.
    process.env.SULO_TTL_PATH = filePath;
  });

  afterEach(async () => {
    delete process.env.SULO_TTL_PATH;
    await rm(dir, { recursive: true, force: true });
  });

  it('hashes the file resolveSuloPath() currently returns', async () => {
    const content = suloDoc();
    await writeFile(filePath, content, 'utf-8');

    const { getSuloDigest } = await freshSuloService();
    expect(getSuloDigest()).toBe(sha256(content));
  });

  it('is stable across repeated calls when the file has not changed', async () => {
    await writeFile(filePath, suloDoc(), 'utf-8');

    const { getSuloDigest } = await freshSuloService();
    const first = getSuloDigest();
    const second = getSuloDigest();
    expect(second).toBe(first);
  });

  it('recomputes when the file at the same path is rewritten', async () => {
    const before = suloDoc({ version: '0.2.14' });
    await writeFile(filePath, before, 'utf-8');

    const { getSuloDigest } = await freshSuloService();
    const digestBefore = getSuloDigest();
    expect(digestBefore).toBe(sha256(before));

    // Same path, new content and a new mtime — the exact shape of an
    // operator hand-editing an override file while the server is running.
    const after = suloDoc({ version: '0.2.15' });
    await writeFile(filePath, after, 'utf-8');

    const digestAfter = getSuloDigest();
    expect(digestAfter).not.toBe(digestBefore);
    expect(digestAfter).toBe(sha256(after));
  });
});
