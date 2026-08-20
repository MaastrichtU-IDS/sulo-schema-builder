// Verifies Keycloak-issued bearer tokens and attaches the local user row.
//
// Registered only in postgres mode (see server.ts): the packaged desktop build
// is single-user and loopback-bound, and pulling `jose` into that snapshot
// would buy nothing.

import fp from 'fastify-plugin';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { resolveUser, type RequestUser, type TokenClaims } from '../modules/users/service.js';
import type { AuthConfig } from '../config/auth.js';

// A JWKS fetch failure, an unknown `kid`, and an expired token used to funnel
// into one catch logged at `debug` — indistinguishable at LOG_LEVEL=info, the
// shipped default. That silence is exactly what let AUTH_ISSUER/AUTH_JWKS_URI
// coupling (see config/auth.ts) cost a full task to diagnose: every request
// 401'd and nothing said why. Key-resolution and transport failures are a
// deployment problem — log them loudly. An expired or claim-mismatched token
// is normal traffic on a public deployment — keep those at `debug`.
function isJwksResolutionFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  // ERR_JWKS_NO_MATCHING_KEY: kid rotated out, or the JWKS came from the wrong
  // realm entirely. ERR_JWKS_TIMEOUT: jose's own fetch timeout. ERR_JOSE_GENERIC:
  // remote.js's catch-all for a non-200 JWKS response or an unparsable body.
  if (code === 'ERR_JWKS_NO_MATCHING_KEY' || code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JOSE_GENERIC') {
    return true;
  }
  // A DNS failure, ECONNREFUSED, or TLS error reaches here as a plain
  // TypeError with no jose `code` at all — the message `fetch()` itself uses.
  return /fetch failed/i.test(err.message);
}

// Bounded: each reload() carries jose's own 5s fetch timeout, so this is at
// most one retry after a short backoff, never an unbounded hang or a loop. A
// misconfigured or unreachable Keycloak must fail the boot loudly — the
// alternative, discovered the hard way, is every request 401ing with nothing
// in the logs to explain it. A transient outage gets one extra chance before
// that happens.
async function prefetchJwks(remoteSet: ReturnType<typeof createRemoteJWKSet>, jwksUri: string, log: FastifyBaseLogger) {
  try {
    await remoteSet.reload();
  } catch (first) {
    log.warn({ err: first, jwksUri }, 'JWKS pre-fetch failed at startup; retrying once');
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      await remoteSet.reload();
    } catch (second) {
      throw new Error(
        `Could not fetch the JWKS from AUTH_JWKS_URI (${jwksUri}) after a retry — refusing to start serving an ` +
          `API that would 401 every request. Is Keycloak reachable at that address from inside this network?`,
        { cause: second },
      );
    }
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authRequired: preHandlerHookHandler;
    requireRole: (...roles: RequestUser['role'][]) => preHandlerHookHandler;
  }
  interface FastifyRequest {
    user: RequestUser | null;
  }
}

export interface AuthPluginOptions {
  auth: AuthConfig;
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (!/^bearer$/i.test(scheme) || rest.length !== 1) return null;
  return rest[0].trim() || null;
}

export default fp<AuthPluginOptions>(async (fastify, opts) => {
  // Depends on fastify.pg (from ../plugins/pg.ts) and on @fastify/sensible's
  // reply.unauthorized/forbidden. Declaring them here turns a missing
  // decorator into a clear registration-time error instead of a confusing
  // runtime crash the first time a guarded route is hit.
  const auth = opts.auth;

  // A literal JWKS (tests) verifies offline; a deployment fetches and caches
  // Keycloak's, re-fetching on an unknown `kid` so a key rotation heals itself.
  let remoteSet: ReturnType<typeof createRemoteJWKSet> | undefined;
  const getKey: JWTVerifyGetKey = auth.jwksJson
    ? createLocalJWKSet(JSON.parse(auth.jwksJson))
    : (remoteSet = createRemoteJWKSet(new URL(auth.jwksUri)));

  // Fetch once at registration instead of lazily on the first request: a
  // misconfigured or unreachable identity provider then fails the boot,
  // rather than silently 401ing every user until someone notices.
  if (remoteSet) {
    await prefetchJwks(remoteSet, auth.jwksUri, fastify.log);
  }

  // Subject → user, so a burst of requests from one client is one database
  // round-trip. Short TTL: an administrator's role change must take effect
  // without a restart.
  const cache = new Map<string, { at: number; user: RequestUser }>();

  fastify.decorateRequest('user', null);

  fastify.addHook('onRequest', async (request) => {
    const token = bearer(request);
    if (!token) return;

    let claims: TokenClaims;
    try {
      const { payload } = await jwtVerify(token, getKey, {
        issuer: auth.issuer,
        audience: auth.audience,
        clockTolerance: 5,
      });
      claims = payload as unknown as TokenClaims;
    } catch (err) {
      // An unverifiable token is anonymity, not an error: the guards below
      // decide whether that is fatal for this route. Most rejections (expired,
      // wrong audience/issuer) are routine on a public deployment and logged at
      // debug. A key-resolution or transport failure means every token is about
      // to be rejected the same way, indistinguishable from an expired one at
      // this log level — that is the failure mode this branch exists to end.
      if (isJwksResolutionFailure(err)) {
        request.log.error({ err, jwksUri: auth.jwksUri }, 'JWKS key resolution or fetch failed; every bearer token will be rejected until this is fixed');
      } else {
        request.log.debug({ err }, 'bearer token rejected');
      }
      return;
    }

    const cached = cache.get(claims.sub);
    if (cached && Date.now() - cached.at < auth.userCacheTtlMs) {
      request.user = cached.user;
      return;
    }

    try {
      const user = await resolveUser(fastify.pg, claims);
      cache.set(claims.sub, { at: Date.now(), user });
      request.user = user;
    } catch (err) {
      request.log.warn({ err, sub: claims.sub }, 'could not resolve a verified token to a user');
    }
  });

  fastify.decorate('authRequired', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) return reply.unauthorized('Sign in to continue.');
  });

  fastify.decorate('requireRole', (...roles: RequestUser['role'][]) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) return reply.unauthorized('Sign in to continue.');
      if (!roles.includes(request.user.role)) return reply.forbidden('Your account cannot perform this action.');
    });
}, {
  name: 'auth',
  decorators: { fastify: ['pg'], reply: ['unauthorized', 'forbidden'] },
});
