// checkForSuloUpdate's own responsibility to bust getSuloDigest()'s memo the
// moment it replaces the file on disk — see sulo.service.ts's
// resetSuloDigestCache() call right after the rename. Split out from
// sulo.digest.test.ts (which covers the plain memoise/recompute-on-mtime-
// change behaviour via the real config + SULO_TTL_PATH) because vi.mock is
// file-scoped in vitest: mocking config/index.js and rdf/fetchOntology.js
// here, to drive checkForSuloUpdate's non-override download path, would
// otherwise also apply to — and break — that file's env-var-override cases.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOntology } from '../rdf/fetchOntology.js';

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

// These cases need suloBundledPath and suloCachePath under test control too
// (SULO_TTL_PATH alone forces the 'override' source, and checkForSuloUpdate
// deliberately never replaces an override file — see sulo.service.ts's own
// comment on currentSource()), so config is mocked directly, the way
// robot.service.test.ts mocks it for the same reason.
const shared = vi.hoisted(() => ({ bundledPath: '', cachePath: '' }));

vi.mock('../config/index.js', () => ({
  config: {
    get reasoner() {
      return {
        suloPath: shared.bundledPath,
        suloBundledPath: shared.bundledPath,
        suloCachePath: shared.cachePath,
        suloUrl: 'https://example.test/sulo/',
        suloCheckIntervalMs: 0,
      };
    },
  },
}));

vi.mock('../rdf/fetchOntology.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rdf/fetchOntology.js')>();
  return { ...actual, fetchOntologyDocument: vi.fn() };
});

describe('getSuloDigest + checkForSuloUpdate', () => {
  let dir: string;
  let bundledPath: string;
  let cachePath: string;

  async function freshSuloService() {
    vi.resetModules();
    return import('./sulo.service.js');
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sulo-update-'));
    bundledPath = join(dir, 'bundled.ttl');
    cachePath = join(dir, 'downloaded.ttl');
    shared.bundledPath = bundledPath;
    shared.cachePath = cachePath;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('invalidates the digest the moment it downloads a newer copy', async () => {
    const original = suloDoc({ version: '0.2.3' });
    await writeFile(bundledPath, original, 'utf-8');

    const service = await freshSuloService();
    const { fetchOntologyDocument } = await import('../rdf/fetchOntology.js');

    const digestBundled = service.getSuloDigest();
    expect(digestBundled).toBe(sha256(original));

    const newer = suloDoc({ version: '0.2.14' });
    vi.mocked(fetchOntologyDocument).mockResolvedValueOnce({
      text: newer,
      quads: parseOntology(newer)!.quads,
    });

    await expect(service.checkForSuloUpdate(true)).resolves.toBe(true);

    const digestDownloaded = service.getSuloDigest();
    expect(digestDownloaded).not.toBe(digestBundled);
    expect(digestDownloaded).toBe(sha256(newer));
  });

  it('invalidates again when a later check replaces the already-downloaded copy at the same path', async () => {
    const firstDownload = suloDoc({ version: '0.2.10' });
    await writeFile(bundledPath, suloDoc({ version: '0.2.3' }), 'utf-8');
    // Pre-seed the cache path so currentSource() is already 'downloaded'
    // before this test's own update runs.
    await writeFile(cachePath, firstDownload, 'utf-8');

    const service = await freshSuloService();
    const { fetchOntologyDocument } = await import('../rdf/fetchOntology.js');

    const digestFirstDownload = service.getSuloDigest();
    expect(digestFirstDownload).toBe(sha256(firstDownload));

    const evenNewer = suloDoc({ version: '0.2.14' });
    vi.mocked(fetchOntologyDocument).mockResolvedValueOnce({
      text: evenNewer,
      quads: parseOntology(evenNewer)!.quads,
    });

    await expect(service.checkForSuloUpdate(true)).resolves.toBe(true);

    const digestSecondDownload = service.getSuloDigest();
    expect(digestSecondDownload).not.toBe(digestFirstDownload);
    expect(digestSecondDownload).toBe(sha256(evenNewer));
  });
});
