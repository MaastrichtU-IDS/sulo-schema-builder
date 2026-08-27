// SSRF-hardened fetch for every caller-influenced dereference the web
// deployment performs — both upper-concept routes, through
// rdf/guardedUpperConcepts.ts.
//
// The web deployment lets an anonymous visitor make the server dereference an
// arbitrary IRI, which is a textbook SSRF target: cloud metadata endpoints
// (169.254.169.254), the loopback API itself, anything on the container
// network. String-level checks are not enough — `http://2130706433/` resolves
// to 127.0.0.1, and a hostname can resolve publicly during a pre-check and
// privately at connect time (DNS rebinding). So the guard here operates at the
// only layer that is authoritative: DNS resolution results, enforced by the
// same lookup the socket actually connects with.
//
//  - scheme must be http/https, port must be 80/443
//  - a few obviously-internal hostname suffixes are rejected up front for a
//    clearer error, but this is UX, not the security boundary
//  - the undici Agent's connect() uses a custom lookup that resolves the
//    hostname and drops every private/reserved address; if none survive, the
//    connection fails. Because the *connection itself* uses the filtered
//    result, rebinding and exotic IP encodings are covered.
//  - the port allowlist is enforced by a custom connector (portCheckedConnector,
//    below), not just publicUrlProblem's one-time pre-check — a redirect to a
//    public host on a non-80/443 port (e.g. probing an internal service that
//    happens to have a public IP) is refused at connect time on *every* hop,
//    the same layer the private-address check already lives at
//  - redirects are followed by undici's fetch through the same Agent, so every
//    hop re-enters both the port check and the validating lookup
//  - the response body is read incrementally and aborted past maxBytes

import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';

// ─── Address classification (pure — unit-tested) ────────────────────────────────

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const b = Number(p);
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
    n = n * 256 + b;
  }
  return n;
}

const PRIVATE_V4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // RFC 1918
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (cloud metadata lives here)
  ['172.16.0.0', 12],    // RFC 1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.168.0.0', 16],   // RFC 1918
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + broadcast
];

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → refuse
  return PRIVATE_V4_RANGES.some(([base, bits]) => {
    const b = ipv4ToInt(base)!;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((b & mask) >>> 0);
  });
}

/**
 * True when `ip` is loopback, private, link-local, multicast or otherwise
 * reserved — anything a public ontology has no business resolving to.
 * Unparseable input counts as private (fail closed).
 */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind !== 6) return true;

  const lower = ip.toLowerCase();
  // IPv4-mapped / IPv4-translated (::ffff:a.b.c.d, 64:ff9b::a.b.c.d) — judge
  // by the embedded IPv4.
  const v4Tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (v4Tail) return isPrivateV4(v4Tail);

  if (lower === '::' || lower === '::1') return true;
  const first = parseInt(lower.split(':', 1)[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true;                    // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true;                    // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true;                    // fec0::/10 (deprecated site-local)
  if ((first & 0xff00) === 0xff00) return true;                    // ff00::/8 multicast
  if (lower.startsWith('2001:db8')) return true;                   // documentation
  if (lower.startsWith('64:ff9b')) return true;                    // NAT64 without parseable tail
  return false;
}

/**
 * Fast, user-friendly rejection for names that are internal by construction.
 * Returns a human-readable problem, or null when the URL passes. This is a
 * pre-check only — the real enforcement happens at DNS-resolution time.
 */
export function publicUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Not a valid URL.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Only http(s) IRIs can be fetched.';
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    return 'Only ports 80 and 443 are allowed.';
  }
  if (url.username || url.password) {
    return 'Credentials in the URL are not allowed.';
  }
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  const bracketless = host.replace(/^\[|\]$/g, '');
  if (isIP(bracketless) && isPrivateAddress(bracketless)) {
    return 'The IRI resolves to a private address.';
  }
  if (
    host === 'localhost' ||
    ['.localhost', '.local', '.internal', '.home.arpa'].some((s) => host.endsWith(s))
  ) {
    return 'Internal hostnames are not allowed.';
  }
  return null;
}

// ─── Validating agent ───────────────────────────────────────────────────────────

class PrivateAddressError extends Error {
  constructor(hostname: string) {
    super(`Refusing to connect: ${hostname} resolves only to private addresses`);
  }
}

class DisallowedPortError extends Error {
  constructor(port: string) {
    super(`Refusing to connect: port ${port} is not 80 or 443`);
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  addresses: Array<{ address: string; family: number }>,
) => void;

function safeLookup(hostname: string, options: unknown, callback: LookupCallback): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const publicOnly = addresses.filter((a) => !isPrivateAddress(a.address));
    if (publicOnly.length === 0) {
      return callback(new PrivateAddressError(hostname), []);
    }
    callback(null, publicOnly);
  });
}

// undici resolves the target port (defaulting per scheme) before invoking the
// connector, so `options.port` here is always the port this specific
// connection attempt is about to use — the initial request AND every
// redirect hop alike, unlike publicUrlProblem's one-time pre-check on the
// original URL.
const baseConnector = buildConnector({
  // undici's types don't expose `lookup`, but it is forwarded to
  // net/tls.connect, which honours it.
  lookup: safeLookup,
  timeout: 10_000,
} as Parameters<typeof buildConnector>[0]);

/**
 * Exported for a direct, network-free unit test — the port check itself is a
 * pure decision over `options`, and asserting it here is far more reliable
 * than trying to force a real redirect-to-a-bad-port through an actual
 * socket in a test. The delegation to `baseConnector` for an allowed port is
 * what actually opens a connection, and is exercised only indirectly, via
 * every real fetch this module makes.
 */
export function portCheckedConnector(
  options: Parameters<typeof baseConnector>[0],
  callback: Parameters<typeof baseConnector>[1],
): void {
  if (options.port !== '80' && options.port !== '443') {
    callback(new DisallowedPortError(options.port), null);
    return;
  }
  baseConnector(options, callback);
}

// One agent for the process: connections (and every redirect hop fetched
// through it) go through portCheckedConnector, so the socket can only ever
// be opened on port 80/443 to an address that passed isPrivateAddress.
const publicOnlyAgent = new Agent({ connect: portCheckedConnector });

// ─── Guarded fetch ──────────────────────────────────────────────────────────────

export interface SafeFetchResult {
  text: string;
  contentType: string;
}

export class ResponseTooLargeError extends Error {}

/**
 * Fetch a public http(s) URL with the validating agent and an incremental
 * size cap. Throws on any policy violation; returns null on ordinary fetch
 * failures (non-2xx, timeout, unreachable) to match fetchOntologyDocument's
 * "no new information" convention.
 */
export async function safeFetchText(
  rawUrl: string,
  { timeoutMs = 10_000, maxBytes = 15 * 1024 * 1024, accept }: {
    timeoutMs?: number;
    maxBytes?: number;
    accept?: string;
  } = {},
): Promise<SafeFetchResult | null> {
  const problem = publicUrlProblem(rawUrl);
  if (problem) throw new Error(problem);

  const signal = AbortSignal.timeout(timeoutMs);
  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(rawUrl, {
      headers: accept ? { Accept: accept } : undefined,
      redirect: 'follow',
      signal,
      dispatcher: publicOnlyAgent,
    });
  } catch (err) {
    // Surface deliberate policy rejections (from either the connector or the
    // lookup, on the initial request or any redirect hop); collapse network
    // noise to null.
    const cause = String(err instanceof Error ? (err.cause ?? err.message) : err);
    if (/private addresses/.test(cause)) throw new Error('The IRI resolves to a private address.');
    if (/is not 80 or 443/.test(cause)) throw new Error('A redirect pointed at a port other than 80 or 443.');
    return null;
  }
  if (!res.ok || !res.body) return null;

  const contentType = res.headers.get('content-type') ?? '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(`Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), contentType };
}
