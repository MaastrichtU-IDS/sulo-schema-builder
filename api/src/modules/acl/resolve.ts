// The whole authorization policy, as one pure function.
//
// Kept free of I/O on purpose: the caller supplies the schema row and the
// requester's grant (loaded together in one query — see repo.ts), so this can be
// table-tested exhaustively, and every route in the API shares one definition of
// who may do what.
//
// Highest match wins. Note what is deliberately absent: no branch consults the
// route, the HTTP method, or anything else about the request. If a rule needs
// that context, it does not belong here.

import type { RequestUser } from '../users/service.js';
import type { SchemaRow } from '../../db/types.js';

export type AccessLevel = 'none' | 'view' | 'edit' | 'own';

export interface GrantRow {
  role: 'viewer' | 'editor' | 'owner';
}

const RANK: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2, own: 3 };

/** Does `level` satisfy `required`? */
export function atLeast(level: AccessLevel, required: Exclude<AccessLevel, 'none'>): boolean {
  return RANK[level] >= RANK[required];
}

const GRANT_LEVEL: Record<GrantRow['role'], AccessLevel> = {
  owner: 'own',
  editor: 'edit',
  viewer: 'view',
};

export function resolveAccess(
  user: RequestUser | null,
  schema: Pick<SchemaRow, 'owner_id' | 'visibility'>,
  grant: GrantRow | null,
): AccessLevel {
  // Anonymous callers get exactly what publication confers, and never more —
  // a grant row cannot apply to someone with no identity.
  if (!user) {
    return schema.visibility === 'private' ? 'none' : 'view';
  }

  const candidates: AccessLevel[] = [];

  if (user.role === 'admin') candidates.push('own');
  if (user.id === schema.owner_id) candidates.push('own');
  if (grant) candidates.push(GRANT_LEVEL[grant.role]);
  // A moderator can read anything, to handle abuse reports; the unpublish route
  // (Task 5) is what lets them act, and it is guarded by role, not by this level.
  if (user.role === 'moderator') candidates.push('view');
  if (schema.visibility !== 'private') candidates.push('view');

  return candidates.reduce<AccessLevel>((best, c) => (RANK[c] > RANK[best] ? c : best), 'none');
}
