import type { Kysely, Selectable } from 'kysely';
import type { DB, UsersTable } from '../../db/types.js';

export type UserRow = Selectable<UsersTable>;

export interface UpsertUser {
  subject: string;
  email: string | null;
  displayName: string | null;
  orcid: string | null;
}

/**
 * Creates the mirror row on first sight, refreshes the mirrored claims after.
 * global_role and quota_tier are deliberately absent from the update: they are
 * administrative state, not token state, so a later sign-in must not reset a
 * promotion.
 */
export async function upsertBySubject(db: Kysely<DB>, values: UpsertUser): Promise<UserRow> {
  return db
    .insertInto('users')
    .values({
      subject: values.subject,
      email: values.email,
      display_name: values.displayName,
      orcid: values.orcid,
      last_seen_at: new Date(),
    })
    .onConflict((oc) =>
      oc.column('subject').doUpdateSet({
        email: values.email,
        display_name: values.displayName,
        orcid: values.orcid,
        last_seen_at: new Date(),
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function findBySubject(db: Kysely<DB>, subject: string): Promise<UserRow | undefined> {
  return db.selectFrom('users').selectAll().where('subject', '=', subject).executeTakeFirst();
}

/** What the sharing UI is allowed to learn about a user it looked up. */
export interface UserIdentity {
  id: string;
  displayName: string | null;
}

/**
 * Resolves one exact email address to at most two candidate identities.
 *
 * EXACT, never a prefix or a pattern: the value is compared with `=`, so no
 * caller-supplied fragment can ever match more than the address they typed.
 * The comparison is case-insensitive because an email address is not
 * case-sensitive to the human retyping a colleague's — `lower(email)` rather
 * than `ilike`, which would make the value a pattern and `%` a wildcard.
 *
 * `limit 2` rather than 1: migration 001 puts no unique constraint on
 * users.email (Keycloak owns identity, and two subjects can legitimately
 * mirror the same address), so the *caller* has to notice ambiguity instead of
 * silently sharing a schema with whichever row sorted first. See the header of
 * modules/acl/grants.routes.ts for what it does with that.
 *
 * There is no index on lower(email); at an institutional population this is a
 * sequential scan over a few thousand rows, and the route's own rate limit
 * (USER_LOOKUP_RATE_LIMIT) is what keeps that from being a lever. Add a
 * functional index before that assumption stops holding.
 */
export async function findByEmailExact(db: Kysely<DB>, email: string): Promise<UserIdentity[]> {
  const rows = await db
    .selectFrom('users')
    .select(['id', 'display_name'])
    .where((eb) => eb(eb.fn<string>('lower', ['email']), '=', email.trim().toLowerCase()))
    .limit(2)
    .execute();

  return rows.map((row) => ({ id: row.id, displayName: row.display_name }));
}
