import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { startTestDb, truncateAll, type TestDb } from '../test/pg.js';
import { createTestIssuer, type TestIssuer } from '../test/tokens.js';

let t: TestDb;
let issuer: TestIssuer;

beforeAll(async () => {
  t = await startTestDb();
  issuer = await createTestIssuer();
});
afterAll(async () => { await t.stop(); });
beforeEach(async () => { await truncateAll(t.db); });

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(sensible);
  app.decorate('pg', t.db);

  const { default: authPlugin } = await import('./auth.js');
  await app.register(authPlugin, {
    auth: {
      enabled: true,
      issuer: issuer.issuer,
      audience: issuer.audience,
      jwksUri: `${issuer.issuer}/protocol/openid-connect/certs`,
      jwksJson: issuer.jwks,
      clientId: 'sulo-spa',
      userCacheTtlMs: 60_000,
    },
  });

  app.get('/open', async (request) => ({ user: request.user?.subject ?? null }));
  app.get('/closed', { preHandler: app.authRequired }, async (request) => ({ id: request.user!.id }));
  app.get('/admin-only', { preHandler: [app.authRequired, app.requireRole('admin')] }, async () => ({ ok: true }));

  await app.ready();
  return app;
}

describe('auth plugin', () => {
  it('leaves request.user null on an unauthenticated open route', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/open' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: null });
    await app.close();
  });

  it('401s a guarded route with no token', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/closed' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('accepts a valid token and provisions the user', async () => {
    const app = await buildApp();
    const token = await issuer.sign({ sub: 'kc-42', email: 'a@example.org' });

    const res = await app.inject({ method: 'GET', url: '/closed', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBeTruthy();

    const { rows } = await t.pool.query('select subject from users where subject = $1', ['kc-42']);
    expect(rows).toHaveLength(1);
    await app.close();
  });

  it('rejects a token from the wrong issuer', async () => {
    const app = await buildApp();
    const token = await issuer.sign({ sub: 'kc-42' }, { issuer: 'https://evil.example/realms/sulo' });
    const res = await app.inject({ method: 'GET', url: '/closed', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a token minted for another audience', async () => {
    const app = await buildApp();
    const token = await issuer.sign({ sub: 'kc-42' }, { audience: 'account' });
    const res = await app.inject({ method: 'GET', url: '/closed', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an expired token', async () => {
    const app = await buildApp();
    const token = await issuer.sign({ sub: 'kc-42' }, { expiresIn: '-1m' });
    const res = await app.inject({ method: 'GET', url: '/closed', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a malformed authorization header', async () => {
    const app = await buildApp();
    for (const authorization of ['', 'Bearer', 'Basic abc', 'Bearer not.a.jwt']) {
      const res = await app.inject({ method: 'GET', url: '/closed', headers: { authorization } });
      expect(res.statusCode).toBe(401);
    }
    await app.close();
  });

  it('403s a role-guarded route for an ordinary user, and allows an admin', async () => {
    const app = await buildApp();
    const token = await issuer.sign({ sub: 'kc-42' });

    const denied = await app.inject({ method: 'GET', url: '/admin-only', headers: { authorization: `Bearer ${token}` } });
    expect(denied.statusCode).toBe(403);

    await t.pool.query('update users set global_role = $1 where subject = $2', ['admin', 'kc-42']);
    // The role cache is keyed by subject with a TTL, so a fresh app instance
    // proves the guard reads the database rather than the token.
    const app2 = await buildApp();
    const allowed = await app2.inject({ method: 'GET', url: '/admin-only', headers: { authorization: `Bearer ${token}` } });
    expect(allowed.statusCode).toBe(200);

    await app.close();
    await app2.close();
  });

  it('refuses a token whose subject is the reserved local seed', async () => {
    const app = await buildApp();
    const token = await issuer.sign({ sub: 'local' });
    const res = await app.inject({ method: 'GET', url: '/closed', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
