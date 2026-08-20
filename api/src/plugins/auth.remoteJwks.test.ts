// Proves AUTH_ISSUER and AUTH_JWKS_URI are genuinely independent: the plugin
// fetches signing keys from one address and checks the `iss` claim against a
// completely different, unreachable one, and verification still succeeds.
//
// This is the test that was impossible to write against the old AuthConfig,
// which derived jwksUri from issuer — there was no way to make them differ.
// That impossibility is why the coupling (see config/auth.ts) shipped and
// broke the compose stack outright: Keycloak's `iss` has to be the
// browser-facing URL, but the server-side JWKS fetch has to use in-network
// addressing, and those are not the same host inside a container.
//
// Deliberately does NOT use test/tokens.ts's createTestIssuer/jwksJson path:
// that hands the plugin a literal JWKS and takes the short-circuit in
// plugins/auth.ts that skips the network entirely (`auth.jwksJson` set). This
// test leaves jwksJson null so the plugin takes the real createRemoteJWKSet
// branch, against a JWKS this file serves itself over plain HTTP.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { createServer, type Server } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose';
import { startTestDb, truncateAll, type TestDb } from '../test/pg.js';

let t: TestDb;
let jwksServer: Server;
let jwksUri: string;
let privateKey: CryptoKey;
const KID = 'remote-test-key';

// Deliberately unreachable (RFC 5737 TEST-NET-1) and on a different host and
// port than the JWKS server below — nothing in this test, or in the plugin
// under test, ever dials this address. If it did, the test would hang or time
// out rather than pass, which is the point: the issuer is a string compared
// against the token's `iss` claim, never a URL the server fetches.
const UNREACHABLE_ISSUER = 'http://192.0.2.1:9/realms/sulo';
const AUDIENCE = 'sulo-api';

beforeAll(async () => {
  t = await startTestDb();

  const generated = await generateKeyPair('RS256');
  privateKey = generated.privateKey;
  const publicJwk = (await exportJWK(generated.publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const jwks = JSON.stringify({ keys: [publicJwk] });

  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(jwks);
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const address = jwksServer.address();
  if (!address || typeof address === 'string') throw new Error('expected the JWKS server to bind a TCP port');
  jwksUri = `http://127.0.0.1:${address.port}/protocol/openid-connect/certs`;
});

afterAll(async () => {
  await t.stop();
  await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
});

beforeEach(async () => {
  await truncateAll(t.db);
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(sensible);
  app.decorate('pg', t.db);

  const { default: authPlugin } = await import('./auth.js');
  await app.register(authPlugin, {
    auth: {
      enabled: true,
      issuer: UNREACHABLE_ISSUER,
      audience: AUDIENCE,
      jwksUri,
      jwksJson: null,
      clientId: 'sulo-spa',
      userCacheTtlMs: 60_000,
    },
  });

  app.get('/closed', { preHandler: app.authRequired }, async (request) => ({ id: request.user!.id }));

  await app.ready();
  return app;
}

async function sign(claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ sub: 'remote-subject-1', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(UNREACHABLE_ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(privateKey);
}

describe('auth plugin: remote JWKS fetch is independent of the issuer', () => {
  it('verifies a token by fetching keys from AUTH_JWKS_URI while AUTH_ISSUER stays a different, unreachable address', async () => {
    const app = await buildApp();
    const token = await sign();

    const res = await app.inject({ method: 'GET', url: '/closed', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBeTruthy();
    await app.close();
  });

  it('still rejects a token whose iss does not match AUTH_ISSUER, proving the issuer check is not bypassed', async () => {
    const app = await buildApp();
    const token = await sign();
    const forged = await new SignJWT({ sub: 'remote-subject-1' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuedAt()
      .setIssuer('http://not-the-configured-issuer.example/realms/sulo')
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(privateKey);

    const good = await app.inject({ method: 'GET', url: '/closed', headers: { authorization: `Bearer ${token}` } });
    const bad = await app.inject({ method: 'GET', url: '/closed', headers: { authorization: `Bearer ${forged}` } });

    expect(good.statusCode).toBe(200);
    expect(bad.statusCode).toBe(401);
    await app.close();
  });
});
