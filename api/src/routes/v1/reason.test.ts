// spec §7: POST /reason (client-supplied Turtle) must not exist in postgres
// mode — the automatic pipeline reasons only over schemas the server itself
// generated OWL for, and this route was the last surface where a caller made
// the host spawn a JVM over bytes it chose. It survives in sqlite mode, where
// the reasoner is the local user's own machine.
//
// config/server.ts's `storage` is read once at import time from the
// environment, so each branch below needs a fresh module registry — the same
// pattern config/server.test.ts uses for the same reason.

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fastifySensible from '@fastify/sensible';

const AUTH_ENV_KEYS = ['SCHEMA_STORAGE', 'DATABASE_URL', 'AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_REQUIRE_JWKS_AT_BOOT'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of AUTH_ENV_KEYS) savedEnv[key] = process.env[key];

afterEach(() => {
  for (const key of AUTH_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function buildApp(storage: 'postgres' | 'sqlite') {
  vi.resetModules();
  process.env.SCHEMA_STORAGE = storage;
  if (storage === 'postgres') {
    // config/index.ts resolves the auth and postgres config eagerly at
    // import time regardless of whether plugins/auth.ts or a real pool is
    // ever used — these are dummy values so that resolution does not throw;
    // requireJwksAtBoot is only consulted by the plugin itself, which this
    // test never loads, and no query is ever run against DATABASE_URL.
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    process.env.AUTH_ISSUER = 'http://localhost:8088/realms/test';
    process.env.AUTH_AUDIENCE = 'sulo-spa';
    process.env.AUTH_REQUIRE_JWKS_AT_BOOT = 'false';
  }

  const app = Fastify();
  await app.register(fastifySensible);
  if (storage === 'sqlite') {
    const { default: authDisabled } = await import('../../plugins/authDisabled.js');
    await app.register(authDisabled);
  } else {
    // POST / is never registered in this mode, so nothing under it needs a
    // real authRequired — but GET /status (unguarded) is registered either
    // way and the plugin file itself is loaded regardless of branch.
    app.decorate('authRequired', async () => {});
  }
  const { default: reasonRoutes } = await import('./reason.js');
  await app.register(reasonRoutes, { prefix: '/reason' });
  return app;
}

describe('POST /reason (client-supplied Turtle)', () => {
  it('is not registered in postgres mode — 404, same as any unregistered path', async () => {
    const app = await buildApp('postgres');
    const res = await app.inject({
      method: 'POST', url: '/reason', payload: { turtle: '@prefix ex: <http://example.org/> . ex:a ex:b ex:c .' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('is still registered and reachable in sqlite mode', async () => {
    const app = await buildApp('sqlite');
    const res = await app.inject({
      method: 'POST', url: '/reason', payload: { turtle: '@prefix ex: <http://example.org/> . ex:a a ex:B .' },
    });
    // Not asserting a specific success body here: whether this dev/CI
    // environment has ROBOT on PATH is orthogonal to what this test is
    // actually about (route REGISTRATION), and reasoner.service.test.ts plus
    // Task 8's e2e already cover the reasoning itself against a real JVM. The
    // one thing this proves is that the route exists at all — a 404 here
    // would mean the opposite of the postgres-mode case above.
    expect(res.statusCode).not.toBe(404);
    await app.close();
  });

  it('GET /reason/status stays registered in both modes', async () => {
    for (const storage of ['postgres', 'sqlite'] as const) {
      const app = await buildApp(storage);
      const res = await app.inject({ method: 'GET', url: '/reason/status' });
      expect(res.statusCode, storage).toBe(200);
      await app.close();
    }
  });
});
