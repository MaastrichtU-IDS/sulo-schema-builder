// Builds the schema surface exactly as the multi-user web deployment wires it:
// @fastify/sensible, the shared error handler, a `pg` handle, the auth plugin,
// then the schema routes at /ontology-schemas.
//
// Extracted rather than copied a third time because the order above is not
// free-form. plugins/auth.ts declares
// `decorators: { fastify: ['pg'], reply: ['unauthorized','forbidden'] }`, so
// sensible and the `pg` decorator must already exist when it registers, and the
// tokens a suite mints have to come from the same offline issuer whose JWKS the
// plugin was handed. Getting either subtly wrong in a copy produces a
// registration-time error or a uniform 401 that looks like a product bug.

import Fastify, {
  type FastifyInstance, type InjectOptions, type LightMyRequestResponse,
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

export interface AuthedTestApp {
  app: FastifyInstance;
  issuer: TestIssuer;
  /** Authorization header for an arbitrary token (e.g. another subject's). */
  bearer(token: string): { authorization: string };
  /** app.inject(), authenticated as FIXTURE_SUBJECT. */
  inject(opts: InjectOptions): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export async function buildAuthedApp(db: Kysely<DB>): Promise<AuthedTestApp> {
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
      userCacheTtlMs: 60_000,
    },
  });
  await app.register(schemasRoutes, { prefix: '/ontology-schemas' });
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
