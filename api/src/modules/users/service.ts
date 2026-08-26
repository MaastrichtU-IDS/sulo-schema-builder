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
  /**
   * Keycloak group paths (e.g. `["/admins"]`), present only when a
   * group-membership protocol mapper is configured on the client — see
   * docker/keycloak/realm-sulo.json. Untrusted shape: a claim from any other
   * identity provider, or an older token minted before the mapper existed,
   * simply won't have it. withGroupAdminOverride below treats anything that
   * isn't an array of strings as "no groups" rather than throwing.
   */
  groups?: unknown;
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

/**
 * Keycloak-group-based admin, additive on top of `global_role`: membership in
 * `adminGroup` elevates a caller to admin for this request, but the reverse
 * never happens here — a caller already `admin` in Postgres (promoted by
 * hand through `PATCH /admin/users/:id`, or by an earlier group membership a
 * now-stale token no longer carries) stays admin regardless of what this
 * token's `groups` claim says. `adminGroup: null` (the default — see
 * config/auth.ts) makes this a no-op for every deployment that doesn't use
 * Keycloak groups for this at all.
 *
 * Deliberately never written back to Postgres: `global_role` still means
 * exactly what it always has (an operator's own explicit grant), and a group
 * membership that lapses stops conferring admin on this caller's very next
 * token without needing a corresponding "un-promote" anywhere.
 */
export function withGroupAdminOverride(
  user: RequestUser, claims: TokenClaims, adminGroup: string | null,
): RequestUser {
  if (!adminGroup || user.role === 'admin') return user;
  const groups = claims.groups;
  if (!Array.isArray(groups) || !groups.includes(adminGroup)) return user;
  return { ...user, role: 'admin' };
}
