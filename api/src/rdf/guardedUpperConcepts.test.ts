// The guard in front of the only caller-influenced dereference this server
// performs. Every case here must be decided *without* touching the network:
// these IRIs are exactly the ones an anonymous visitor would supply to turn the
// API into an SSRF proxy, and reaching DNS at all would already be a finding.

import { describe, it, expect, beforeEach } from 'vitest';
import { clearUpperConceptsCache, guardedUpperConcepts } from './guardedUpperConcepts.js';

beforeEach(() => { clearUpperConceptsCache(); });

describe('guardedUpperConcepts', () => {
  // The exact payload from the C1 finding, plus its neighbours. Stored on a
  // schema row, GET /ontology-schemas/:id/upper-concepts used to dereference
  // this with a bare fetch and `redirect: 'follow'`.
  it.each([
    ['cloud metadata (link-local)', 'http://169.254.169.254/latest/meta-data/'],
    ['GCP metadata by name',        'http://metadata.google.internal/computeMetadata/v1/'],
    ['loopback literal',            'http://127.0.0.1/x'],
    ['loopback by name',            'http://localhost/x'],
    ['decimal-encoded loopback',    'http://2130706433/'],
    ['IPv6 loopback',               'http://[::1]/x'],
    ['RFC 1918',                    'https://10.0.0.5/ontology.ttl'],
    ['docker-internal name',        'http://db.internal/x'],
    ['the API itself, off-port',    'http://example.org:3000/api/v1/health'],
    ['a non-http scheme',           'file:///etc/passwd'],
    ['credentials in the URL',      'http://user:pass@example.org/'],
    ['not a URL at all',            'ontology.ttl'],
  ])('refuses %s', async (_label, iri) => {
    const result = await guardedUpperConcepts(iri);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_allowed');
    expect(result.message).toBeTruthy();
  });

  // `http://2130706433/` is the case a string-level blocklist misses: the URL
  // parser expands it to 127.0.0.1, so the pre-check catches it here — and if a
  // form ever slipped past, safeFetch's validating DNS lookup is the backstop.
  it('reports the private-address reason for an encoded loopback address', async () => {
    const result = await guardedUpperConcepts('http://2130706433/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/private address/i);
  });

  // SULO is bundled, so the ontology the app actually uses is served from disk
  // and no visitor can make us dereference it.
  it('answers the bundled SULO IRI from disk', async () => {
    const result = await guardedUpperConcepts('https://w3id.org/sulo/');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.concepts.length).toBeGreaterThan(5);
      expect(result.concepts.every((c) => c.iri.startsWith('http'))).toBe(true);
    }
  });
});
