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
