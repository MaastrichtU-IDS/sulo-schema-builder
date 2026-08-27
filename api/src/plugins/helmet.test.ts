import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import helmetPlugin from './helmet.js';
import type { AuthConfig } from '../config/auth.js';

const BASE_AUTH: AuthConfig = {
  enabled: false,
  issuer: '',
  audience: '',
  jwksUri: '',
  jwksJson: null,
  clientId: '',
  userCacheTtlMs: 60_000,
  requireJwksAtBoot: true,
  adminGroup: null,
};

async function buildApp(auth: AuthConfig) {
  const app = Fastify();
  await app.register(helmetPlugin, { auth });
  app.get('/', async () => ({ ok: true }));
  await app.ready();
  return app;
}

// Fix for: CSP was `contentSecurityPolicy: false` outright, with a stale
// "Swagger UI" rationale — this repo has never shipped Swagger, and the SPA
// is served to arbitrary visitors (plan-01 follow-up #4).
describe('helmet plugin', () => {
  it('sets a real Content-Security-Policy header, not none at all', async () => {
    const app = await buildApp(BASE_AUTH);
    const res = await app.inject({ method: 'GET', url: '/' });
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    await app.close();
  });

  it("restricts connect-src to 'self' when auth is disabled (desktop/sqlite mode)", async () => {
    const app = await buildApp(BASE_AUTH);
    const res = await app.inject({ method: 'GET', url: '/' });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toMatch(/connect-src 'self'(?!.*http)/);
    await app.close();
  });

  // keycloak-js's code->token exchange and silent refresh are background
  // fetch/XHR calls to AUTH_ISSUER's own origin, made directly from the
  // browser — without this, every sign-in on a real deployment breaks with
  // nothing but a browser-console CSP violation to explain why.
  it("adds the Keycloak issuer's origin to connect-src when auth is enabled", async () => {
    const app = await buildApp({
      ...BASE_AUTH,
      enabled: true,
      issuer: 'http://keycloak.example.org:8088/realms/sulo',
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toMatch(/connect-src[^;]*'self'/);
    expect(csp).toContain('http://keycloak.example.org:8088');
    await app.close();
  });

  // Caught by actually driving a sign-in through a real browser against this
  // CSP: keycloak-js's init() also opens a hidden iframe at the issuer's
  // origin (the third-party-cookie/silent-SSO check). Without an explicit
  // frame-src, it falls back to default-src 'self' and silently blocks that
  // iframe's content — init()'s promise never resolves, so AuthProvider
  // never leaves 'loading' and the entire nav bar looks like the desktop
  // build, with nothing in the console to explain why.
  it("adds the Keycloak issuer's origin to frame-src too, for keycloak-js's silent-SSO iframe", async () => {
    const app = await buildApp({
      ...BASE_AUTH,
      enabled: true,
      issuer: 'http://keycloak.example.org:8088/realms/sulo',
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toMatch(/frame-src[^;]*'self'/);
    expect(csp).toMatch(/frame-src[^;]*http:\/\/keycloak\.example\.org:8088/);
    await app.close();
  });

  it("restricts frame-src to 'self' when auth is disabled (desktop/sqlite mode)", async () => {
    const app = await buildApp(BASE_AUTH);
    const res = await app.inject({ method: 'GET', url: '/' });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toMatch(/frame-src 'self'(?!.*http)/);
    await app.close();
  });
});
