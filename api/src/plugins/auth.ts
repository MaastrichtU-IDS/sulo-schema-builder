// Verifies Keycloak-issued bearer tokens and attaches the local user row.
//
// Registered only in postgres mode (see server.ts): the packaged desktop build
// is single-user and loopback-bound, and pulling `jose` into that snapshot
// would buy nothing.

import fp from 'fastify-plugin';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { resolveUser, type RequestUser, type TokenClaims } from '../modules/users/service.js';
import type { AuthConfig } from '../config/auth.js';

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
  const getKey: JWTVerifyGetKey = auth.jwksJson
    ? createLocalJWKSet(JSON.parse(auth.jwksJson))
    : createRemoteJWKSet(new URL(auth.jwksUri));

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
      // decide whether that is fatal for this route. Logged at debug because a
      // public deployment sees expired tokens constantly.
      request.log.debug({ err }, 'bearer token rejected');
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
