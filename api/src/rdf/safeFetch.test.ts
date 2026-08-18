import { describe, it, expect } from 'vitest';
import { isPrivateAddress, publicUrlProblem } from './safeFetch.js';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.0.0.5', '172.16.0.1', '172.31.255.1',
    '192.168.1.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '224.0.0.1',
    '240.0.0.1', '255.255.255.255', '192.0.2.10', '198.51.100.7', '203.0.113.9',
    '198.18.0.1', '192.0.0.170',
  ])('flags private/reserved IPv4 %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1',
    '2001:db8::1', '::ffff:127.0.0.1', '::ffff:192.168.0.1', '64:ff9b::a00:1',
  ])('flags private/reserved IPv6 %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '151.101.1.140', '2606:4700::1111', '::ffff:8.8.8.8'])(
    'allows public %s',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );

  it('fails closed on unparseable input', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('999.1.1.1')).toBe(true);
  });
});

describe('publicUrlProblem', () => {
  it('accepts ordinary public http(s) URLs', () => {
    expect(publicUrlProblem('https://w3id.org/sulo/')).toBeNull();
    expect(publicUrlProblem('http://purl.obolibrary.org/obo/go.owl')).toBeNull();
    expect(publicUrlProblem('https://example.org:443/x')).toBeNull();
  });

  it('rejects non-http schemes', () => {
    expect(publicUrlProblem('file:///etc/passwd')).toMatch(/http/);
    expect(publicUrlProblem('ftp://example.org/x')).toMatch(/http/);
    expect(publicUrlProblem('gopher://example.org/')).toMatch(/http/);
  });

  it('rejects non-standard ports', () => {
    expect(publicUrlProblem('http://example.org:3000/api')).toMatch(/port/i);
    expect(publicUrlProblem('http://example.org:6379/')).toMatch(/port/i);
  });

  it('rejects internal hostnames and private IP literals', () => {
    expect(publicUrlProblem('http://localhost/x')).toBeTruthy();
    expect(publicUrlProblem('http://foo.localhost/x')).toBeTruthy();
    expect(publicUrlProblem('http://printer.local/x')).toBeTruthy();
    expect(publicUrlProblem('http://db.internal/x')).toBeTruthy();
    expect(publicUrlProblem('http://127.0.0.1/x')).toBeTruthy();
    expect(publicUrlProblem('http://169.254.169.254/latest/meta-data/')).toBeTruthy();
    expect(publicUrlProblem('http://[::1]/x')).toBeTruthy();
  });

  it('rejects credentials and garbage', () => {
    expect(publicUrlProblem('http://user:pass@example.org/')).toMatch(/redentials/);
    expect(publicUrlProblem('not a url')).toMatch(/valid URL/);
  });
});
