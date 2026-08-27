import { describe, it, expect, vi } from 'vitest';
import { isPrivateAddress, publicUrlProblem, portCheckedConnector } from './safeFetch.js';

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

// Fix for: publicUrlProblem's port check only ever ran once, against the
// original URL — a redirect to a public host on a non-80/443 port sailed
// through, since only the private-address check re-ran on every hop. This is
// the connector every real connection attempt (initial request AND every
// redirect) goes through, so testing it directly is the actual proof the gap
// is closed, not just that the one-time pre-check still works.
describe('portCheckedConnector', () => {
  function fakeOptions(protocol: string, port: string) {
    return { hostname: 'example.org', protocol, port } as Parameters<typeof portCheckedConnector>[0];
  }

  it.each(['22', '3000', '6379', '8080', ''])('refuses port %s without reaching the network', (port) => {
    const callback = vi.fn();
    portCheckedConnector(fakeOptions('http:', port), callback);
    expect(callback).toHaveBeenCalledOnce();
    const [err, socket] = callback.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not 80 or 443/);
    expect(socket).toBeNull();
  });

  it('rejects synchronously, before any async DNS/connect work could start', () => {
    // If this ever delegated to the real connector for a bad port, the
    // callback would fire on a later microtask (after a real dns.lookup),
    // not before this line — a synchronous callback is direct evidence the
    // check short-circuits rather than merely running in parallel with it.
    const callback = vi.fn();
    portCheckedConnector(fakeOptions('http:', '22'), callback);
    expect(callback).toHaveBeenCalledOnce();
  });
});
