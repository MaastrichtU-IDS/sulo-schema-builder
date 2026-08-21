// Maps verified token claims onto the local users row. Keycloak owns
// credentials; this is the mirror the rest of the API joins against.
//
// INVARIANT: `import type` only for kysely, as in modules/schemas/repo.ts and
// modules/acl/repo.ts. This file is statically reachable from dist/index.js
// (routes/v1/index.ts -> acl/grants.routes.ts -> acl/grants.repo.ts -> here,
// which imports LOCAL_SUBJECT as a value) in *both* storage modes, and pkg
// cannot snapshot kysely's top-level-await modules — a value import (including
// `sql`) crashes the packaged desktop binary at startup with
// ERR_MODULE_NOT_FOUND, while typecheck, every test and the Docker image stay
// green.
import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.js';
import * as repo from './repo.js';

/**
 * Subject of the pre-auth seed row (migration 002). It owns every schema
 * created before authentication existed. Keycloak must never be able to issue
 * it as a `sub`, or a signed-in user would inherit those schemas — hence the
 * explicit rejection in resolveUser rather than a comment asking nicely.
 */
export const LOCAL_SUBJECT = 'local';

/**
 * Thrown by resolveUser for a claim that is *intentionally* not an
 * authenticatable identity (no subject, or the reserved LOCAL_SUBJECT) — as
 * opposed to a failure to resolve an otherwise-valid one (e.g. the database
 * being unreachable). The distinction matters to callers: the auth plugin
 * treats this as ordinary anonymity (a 401 for a guarded route), while any
 * other error means the token was valid but the *server* could not answer,
 * which should surface as a 503, not a session problem.
 */
export class InvalidSubjectError extends Error {}

export interface TokenClaims {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  orcid?: string;
}

export interface RequestUser {
  id: string;
  subject: string;
  role: 'user' | 'moderator' | 'admin';
  tier: 'free' | 'verified' | 'staff';
}

export async function resolveUser(db: Kysely<DB>, claims: TokenClaims): Promise<RequestUser> {
  const subject = claims.sub?.trim();
  if (!subject) throw new InvalidSubjectError('token has no subject');
  if (subject === LOCAL_SUBJECT) {
    throw new InvalidSubjectError(`subject "${LOCAL_SUBJECT}" is reserved for the pre-auth seed row and cannot be authenticated`);
  }

  const row = await repo.upsertBySubject(db, {
    subject,
    email: claims.email?.trim() || null,
    displayName: claims.name?.trim() || claims.preferred_username?.trim() || null,
    orcid: claims.orcid?.trim() || null,
  });

  return { id: row.id, subject: row.subject, role: row.global_role, tier: row.quota_tier };
}
