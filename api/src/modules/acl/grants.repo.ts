// Persistence for sharing: who holds a grant on a schema, and who owns it.
//
// Every function here is a privilege write, so two properties are structural
// rather than incidental:
//
//  1. Nothing is created for a grantee that does not exist, and the 404 that
//     says so is the truth rather than a guess. The existence check and the
//     insert run in ONE transaction and the check takes a SHARE lock on the
//     user row (`forShare`), so that row cannot be deleted between the two
//     statements: the check is authoritative for the whole transaction. Without
//     the lock the foreign key would still stop a bad row from surviving, but
//     the caller would get a bare 500 from a constraint violation where the
//     surrounding prose promises a 404 — a right answer for the database and a
//     wrong one for the API. A bare insert relying on the FK has that problem
//     always; a check in its own transaction would simply be a race.
//  2. A transfer re-reads and LOCKS the owner row (`forUpdate`) instead of
//     trusting the owner_id the guard loaded a moment earlier. Two owners
//     transferring the same schema at once would otherwise interleave into a
//     state where the losing transfer's "previous owner" grant is written for
//     someone who is no longer the previous owner.
//
// INVARIANT: `import type` only for kysely, as in modules/acl/repo.ts and
// modules/schemas/repo.ts. This file is statically reachable from dist/index.js
// (routes/v1/index.ts -> acl/grants.routes.ts -> here) in *both* storage modes,
// and pkg cannot snapshot kysely's top-level-await modules — a value import
// (including `sql`) crashes the packaged desktop binary at startup while
// typecheck, every test and the Docker image stay green.
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../db/types.js';
import { LOCAL_SUBJECT } from '../users/service.js';
import type { GrantRow } from './resolve.js';

export type GrantRole = GrantRow['role'];

/** A grant as the API reports it: a person, not a foreign key. */
export interface GrantWithGrantee {
  userId: string;
  /** From users.display_name, which the identity provider may not have set. */
  displayName: string | null;
  role: GrantRole;
  grantedAt: Date;
}

/**
 * The users a schema may be shared with or handed to, locked for the duration of
 * the caller's transaction.
 *
 * `forShare` is what makes the existence check authoritative rather than
 * advisory — see point 1 of the header. It is a *share* lock, so two concurrent
 * grants to the same person do not serialise against each other; only a delete
 * of that user waits, which is precisely the race the check is defending.
 *
 * LOCAL_SUBJECT is excluded because it is not a person. Migration 002's seed row
 * owns every schema created before authentication existed, and resolveUser
 * refuses to authenticate it, so it can never sign in — but its id is guessable
 * (…0001) and nothing else stops it being named as a grantee. Transferring a
 * schema to it would park ownership somewhere unreachable: the previous owner
 * keeps their consolation `owner` grant and so is not locked out, but the
 * transfer is gone until an administrator moves it back. "Not a person" is a
 * property of the row, so it belongs in the query both callers share.
 */
function grantableUser(trx: Transaction<DB>) {
  return trx
    .selectFrom('users')
    .forShare()
    .where('subject', '!=', LOCAL_SUBJECT);
}

/**
 * Everyone with an explicit grant on this schema. The owner is deliberately not
 * synthesised into the list: they hold access through `schemas.owner_id`, not
 * through a row here, and inventing one would make the list disagree with what
 * a revocation can actually remove.
 *
 * `role` is trusted from the column here — unlike modules/acl/repo.ts, which
 * validates it, because this list only ever renders. Nothing downstream of it
 * decides access, so an out-of-domain value could not escalate anything.
 */
export async function listGrants(db: Kysely<DB>, schemaId: string): Promise<GrantWithGrantee[]> {
  const rows = await db
    .selectFrom('schema_grants')
    // Inner, not left: the FK guarantees the user row, and a grantee who
    // somehow lacked one could not be displayed or revoked meaningfully.
    .innerJoin('users', 'users.id', 'schema_grants.grantee_id')
    .where('schema_grants.schema_id', '=', schemaId)
    .select([
      'schema_grants.grantee_id', 'schema_grants.role', 'schema_grants.created_at',
      'users.display_name',
    ])
    // A total order, so the list does not shuffle between reads.
    .orderBy('schema_grants.created_at')
    .orderBy('schema_grants.grantee_id')
    .execute();

  return rows.map((row) => ({
    userId: row.grantee_id,
    displayName: row.display_name,
    role: row.role,
    grantedAt: row.created_at,
  }));
}

export interface UpsertGrant {
  schemaId: string;
  granteeId: string;
  role: GrantRole;
  /** The user performing the grant; recorded in granted_by for the audit trail. */
  grantedBy: string;
}

/**
 * Creates the grant, or changes the role of an existing one. `undefined` means
 * there is no such user — the caller answers 404, and nothing was written.
 *
 * `(schema_id, grantee_id)` is the primary key, so a repeated PUT is an upsert
 * rather than a conflict: re-issuing a grant with a different role is the
 * normal way to promote or demote someone, and a 409 would force every client
 * to probe first. `created_at` moves with `granted_by` on an update, so the
 * pair always describes the same act — the grant as it now stands, and who
 * made it that way.
 */
export async function upsertGrant(
  db: Kysely<DB>, values: UpsertGrant,
): Promise<GrantWithGrantee | undefined> {
  return db.transaction().execute(async (trx) => {
    const grantee = await grantableUser(trx)
      .select(['id', 'display_name'])
      .where('id', '=', values.granteeId)
      .executeTakeFirst();
    if (!grantee) return undefined;

    const now = new Date();
    const row = await trx
      .insertInto('schema_grants')
      .values({
        schema_id: values.schemaId,
        grantee_id: values.granteeId,
        role: values.role,
        granted_by: values.grantedBy,
        created_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['schema_id', 'grantee_id']).doUpdateSet({
          role: values.role,
          granted_by: values.grantedBy,
          created_at: now,
        }),
      )
      .returning(['role', 'created_at'])
      .executeTakeFirstOrThrow();

    return {
      userId: grantee.id,
      displayName: grantee.display_name,
      role: row.role,
      grantedAt: row.created_at,
    };
  });
}

/** False when there was no such grant to remove. */
export async function deleteGrant(
  db: Kysely<DB>, schemaId: string, granteeId: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom('schema_grants')
    .where('schema_id', '=', schemaId)
    .where('grantee_id', '=', granteeId)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

export interface TransferOwnership {
  schemaId: string;
  /** The owner the caller was authorized against; re-checked under the lock. */
  expectedOwnerId: string;
  newOwnerId: string;
  /** Whoever is performing the transfer — the owner, or an admin acting for them. */
  actorId: string;
}

export type TransferResult =
  | 'transferred'
  /** No such newOwnerId; nothing was written. */
  | 'no_such_user'
  /** owner_id moved between the guard's read and this transaction. */
  | 'owner_changed';

/**
 * Moves `owner_id`, and leaves the previous owner an `owner` grant so that
 * handing a schema over is never a lockout — they keep read, write and
 * grant-management access, and lose exactly one thing: the ability to transfer
 * it again (that check is `mayTransferOwnership` in guards.ts, which reads
 * `owner_id` and so answers "no" for them from here on).
 *
 * The new owner's own grant row, if they had one, is deleted: they now hold
 * `own` through `owner_id`, and a row saying `viewer` next to that would be a
 * claim the resolver ignores — the same reason a self-grant is a 400 rather
 * than a redundant row.
 *
 * `modified_at` is deliberately untouched: it tracks changes to the schema's
 * *content* (see modules/schemas/repo.ts), and reasoning freshness is derived
 * from content, not from who holds the keys.
 */
export async function transferOwnership(
  db: Kysely<DB>, values: TransferOwnership,
): Promise<TransferResult> {
  return db.transaction().execute<TransferResult>(async (trx) => {
    // Locks the schema row for the rest of the transaction, so a concurrent
    // transfer of the same schema serialises behind this one rather than
    // interleaving with it.
    const current = await trx
      .selectFrom('schemas')
      .select('owner_id')
      .where('id', '=', values.schemaId)
      .forUpdate()
      .executeTakeFirst();
    // The guard loaded this row moments ago, so absence means it was deleted in
    // between — the same answer as "someone else changed it under us".
    if (!current) return 'owner_changed';
    if (current.owner_id !== values.expectedOwnerId) return 'owner_changed';

    const newOwner = await grantableUser(trx)
      .select('id')
      .where('id', '=', values.newOwnerId)
      .executeTakeFirst();
    if (!newOwner) return 'no_such_user';

    await trx
      .updateTable('schemas')
      .set({ owner_id: values.newOwnerId })
      .where('id', '=', values.schemaId)
      .execute();

    // They own it now; a grant row would say less than the truth.
    await trx
      .deleteFrom('schema_grants')
      .where('schema_id', '=', values.schemaId)
      .where('grantee_id', '=', values.newOwnerId)
      .execute();

    // Not a lockout. An upsert because the previous owner may already hold a
    // grant from an earlier transfer, and because 'owner' must win over it.
    await trx
      .insertInto('schema_grants')
      .values({
        schema_id: values.schemaId,
        grantee_id: current.owner_id,
        role: 'owner',
        granted_by: values.actorId,
        created_at: new Date(),
      })
      .onConflict((oc) =>
        oc.columns(['schema_id', 'grantee_id']).doUpdateSet({
          role: 'owner',
          granted_by: values.actorId,
          created_at: new Date(),
        }),
      )
      .execute();

    return 'transferred';
  });
}
