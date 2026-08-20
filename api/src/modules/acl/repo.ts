// One query per guarded request: the schema row plus *this* requester's grant.
//
// A LEFT JOIN rather than two round trips, because the guard runs on every
// request to every schema route and the pair is always needed together.

// INVARIANT: `import type` only for kysely, here as in modules/schemas/repo.ts.
// This file is statically reachable from dist/index.js (routes/v1/index.ts ->
// modules/schemas/routes.ts -> acl/guards.ts -> here) in *both* storage modes,
// and pkg cannot snapshot kysely's top-level-await modules — a value import
// crashes the packaged desktop binary at startup while typecheck, every test
// and the Docker image stay green.
import type { Kysely } from 'kysely';
import type { DB, SchemaRow } from '../../db/types.js';
import type { GrantRow } from './resolve.js';

/**
 * Stands in for "this requester has no identity" in the join predicate.
 *
 * Anonymous callers must match no grant row. `grantee_id = null` would evaluate
 * to unknown and produce no match anyway, but relying on SQL's null semantics
 * for an authorization predicate is the kind of subtlety that survives one
 * refactor and not two. All-zeros is unreachable as a real users.id:
 * gen_random_uuid() cannot mint it and migration 002's seed row is ...0001.
 */
const NO_SUCH_USER = '00000000-0000-0000-0000-000000000000';

export interface SchemaAccessRow {
  schema: SchemaRow;
  grant: GrantRow | null;
}

/**
 * The database CHECK on schema_grants.role is the only thing keeping this
 * column inside its domain, and resolve.ts's GRANT_LEVEL lookup would return
 * undefined for anything else — which its `RANK[c] > RANK[best]` comparison
 * then silently drops, i.e. an unrecognised role would be an *ignored* grant.
 * Fail here instead, at the boundary where the value enters the process: a
 * migration that adds a role and forgets this map should break loudly.
 */
function assertGrantRole(value: unknown): GrantRow['role'] {
  if (value === 'viewer' || value === 'editor' || value === 'owner') return value;
  // Safe to name the value: errorHandler.ts logs 500s in full and answers with
  // a bare "Internal Server Error", so nothing here reaches the caller.
  throw new Error(
    `schema_grants.role holds ${JSON.stringify(value)}, which is not a known grant role — ` +
      'refusing to resolve access from it',
  );
}

export async function loadSchemaAccess(
  db: Kysely<DB>,
  schemaId: string,
  userId: string | null,
): Promise<SchemaAccessRow | undefined> {
  const row = await db
    .selectFrom('schemas')
    .leftJoin('schema_grants', (join) =>
      join
        .onRef('schema_grants.schema_id', '=', 'schemas.id')
        .on('schema_grants.grantee_id', '=', userId ?? NO_SUCH_USER),
    )
    .where('schemas.id', '=', schemaId)
    .selectAll('schemas')
    .select('schema_grants.role as grant_role')
    .executeTakeFirst();

  if (!row) return undefined;

  const { grant_role: grantRole, ...schema } = row;
  // A missing join partner is `null`; treated as "no grant" rather than fed to
  // the assertion, which exists for values that are present but unknown.
  const grant = grantRole === null || grantRole === undefined
    ? null
    : { role: assertGrantRole(grantRole) };
  return { schema, grant };
}
