// Builds the schema surface exactly as the multi-user web deployment wires it:
// @fastify/sensible, the shared error handler, a `pg` handle, the auth plugin,
// then the schema routes at /ontology-schemas (or whatever AuthedAppOptions
// overrides).
//
// Extracted rather than copied a third time because the order above is not
// free-form. plugins/auth.ts declares
// `decorators: { fastify: ['pg'], reply: ['unauthorized','forbidden','serviceUnavailable'] }`,
// so sensible and the `pg` decorator must already exist when it registers, and the
// tokens a suite mints have to come from the same offline issuer whose JWKS the
// plugin was handed. Getting either subtly wrong in a copy produces a
// registration-time error or a uniform 401 that looks like a product bug.

import Fastify, {
  type FastifyInstance, type FastifyPluginAsync, type InjectOptions, type LightMyRequestResponse,
} from 'fastify';
import sensible from '@fastify/sensible';
import type { Kysely } from 'kysely';
import type { DB } from '../db/types.js';
import errorHandler from '../plugins/errorHandler.js';
import schemasRoutes from '../modules/schemas/routes.js';
import { createTestIssuer, type TestIssuer } from './tokens.js';

/**
 * The caller that suites which do not care about identity authenticate as.
 * Deliberately not `'local'`: that subject is reserved for the pre-auth seed
 * row and the auth plugin refuses it.
 */
export const FIXTURE_SUBJECT = 'kc-fixture-subject';

/**
 * Overrides for suites that need something other than the default wiring.
 * Everything a caller does not set stays exactly as the web deployment has it,
 * so an override is visible at the call site rather than hidden in a copy of
 * this file.
 */
export interface AuthedAppOptions {
  /**
   * Register this route tree instead of the schema routes. The ACL guard suite
   * mounts three trivial routes (one per guard level) so that the matrix it
   * asserts is about the guard and nothing else; `prefix` is then mandatory,
   * because '/ontology-schemas' would be a lie.
   */
  routes?: FastifyPluginAsync;
  prefix?: string;
  /**
   * Subject -> user cache TTL. The default matches the deployment. A suite that
   * promotes a fixture user's global_role *after* the token path created the row
   * must pass 0, or the guard keeps answering from the pre-promotion snapshot
   * for a minute and the failure looks like a policy bug.
   */
  userCacheTtlMs?: number;
  /**
   * Register @fastify/rate-limit with this global budget before the routes, as
   * server.ts does. Only the suites that assert a *per-route* limit need it —
   * the route's own `config.rateLimit` is inert without the plugin, so without
   * this a test could not tell a declared limit from a forgotten one. Left off
   * by default: a shared counter across an entire suite turns an unrelated test
   * into a 429.
   */
  rateLimit?: { max: number; timeWindow: string };
  /**
   * Mirrors config/auth.ts's AuthConfig.adminGroup. `null` (the default)
   * matches every suite's existing behaviour: a token's `groups` claim,
   * even if present, confers nothing.
   */
  adminGroup?: string | null;
}

export interface AuthedTestApp {
  app: FastifyInstance;
  issuer: TestIssuer;
  /** Authorization header for an arbitrary token (e.g. another subject's). */
  bearer(token: string): { authorization: string };
  /** app.inject(), authenticated as FIXTURE_SUBJECT. */
  inject(opts: InjectOptions): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export async function buildAuthedApp(
  db: Kysely<DB>, opts: AuthedAppOptions = {},
): Promise<AuthedTestApp> {
  const issuer = await createTestIssuer();

  const app = Fastify();
  await app.register(sensible);
  // Same handler the real server registers: without it a ZodError or a database
  // error would leave here as a 500 carrying internals.
  await app.register(errorHandler);
  app.decorate('pg', db);

  // Dynamic import, mirroring server.ts — see the comment there for why `jose`
  // must never appear in a static import graph reachable from index.ts.
  const { default: authPlugin } = await import('../plugins/auth.js');
  await app.register(authPlugin, {
    auth: {
      enabled: true,
      issuer: issuer.issuer,
      audience: issuer.audience,
      jwksUri: `${issuer.issuer}/protocol/openid-connect/certs`,
      jwksJson: issuer.jwks,
      clientId: 'sulo-spa',
      userCacheTtlMs: opts.userCacheTtlMs ?? 60_000,
      requireJwksAtBoot: true,
      adminGroup: opts.adminGroup ?? null,
    },
  });
  // Before the routes, so their per-route `config.rateLimit` is picked up.
  if (opts.rateLimit) {
    const { default: rateLimit } = await import('@fastify/rate-limit');
    await app.register(rateLimit, opts.rateLimit);
  }
  await app.register(opts.routes ?? schemasRoutes, {
    prefix: opts.prefix ?? (opts.routes ? '' : '/ontology-schemas'),
  });
  await app.ready();

  // One long-lived token for the whole file: a container start plus a few dozen
  // requests can outrun the issuer's 5-minute default, and an expiry mid-suite
  // shows up as an unrelated-looking 401.
  const fixtureToken = await issuer.sign({ sub: FIXTURE_SUBJECT }, { expiresIn: '2h' });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  return {
    app,
    issuer,
    bearer,
    inject: (opts) => app.inject({ ...opts, headers: { ...opts.headers, ...bearer(fixtureToken) } }),
    close: () => app.close(),
  };
}
