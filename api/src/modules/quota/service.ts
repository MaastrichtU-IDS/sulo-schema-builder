// The metering and enforcement half of plan 4's quotas (spec §6):
// `recordUsage` appends one row to `usage_events` per reasoning-adjacent
// action, and `checkQuota` answers "may this user do `kind` right now?" from
// that ledger plus the current state of `schemas`. Nothing calls either yet —
// Task 5 wires the automatic pipeline and Task 6 the on-demand refresh route;
// this module is the enforcement point both of them will share.
//
// INVARIANT: `import type` only for kysely, as in modules/schemas/repo.ts and
// the other five files carrying this banner today. This module is not yet on
// routes/v1/index.ts's import graph — Task 5/6 put it there — but pkg cannot
// snapshot kysely's top-level-await modules, and a value import here would
// crash the packaged desktop binary at startup the moment it is. Keeping the
// discipline from this module's first line avoids relitigating it later.

import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.js';
import { limitsFor, type TierLimits } from './tiers.js';

/** A rolling-hour window, in milliseconds. */
const WINDOW_MS = 60 * 60 * 1000;

/**
 * The one quota `kind` that is not time-boxed: capacity returns when a
 * schema is deleted, not when a clock reaches some instant. Exported so a
 * future caller (the `POST /ontology-schemas` handler, per spec §6, not yet
 * wired to this module) names the same string this module switches on.
 */
export const SCHEMA_CREATE = 'schema_create';

/**
 * The minimum a caller needs to identify whose quota to check. Deliberately
 * not `RequestUser` from modules/users/service.ts: `tier` here is a plain
 * `string`, not that type's `'free'|'verified'|'staff'` union, because
 * `limitsFor` (modules/quota/tiers.ts) exists specifically to handle a tier
 * value outside that union without the type system hiding the case from
 * either of them. A real `RequestUser` satisfies this structurally, so
 * callers pass `request.user` straight through.
 */
export interface QuotaUser {
  id: string;
  tier: string;
}

export interface RecordUsageInput {
  userId: string | null;
  kind: string;
  schemaId: string | null;
  costMs: number | null;
  cacheHit: boolean;
}

/**
 * Appends one `usage_events` row. Never throws.
 *
 * By the time this is called, the thing it is billing for (typically a
 * reasoning run) has already happened and already succeeded — recordUsage's
 * only job is to leave a receipt. A metering failure (a dropped connection, a
 * pool exhausted by something else entirely) is logged and swallowed rather
 * than raised, because turning a lost audit row into a failed response for an
 * otherwise-successful run is strictly worse than the missing row itself.
 * This is the entire body of the function, which is deliberate: there is
 * nothing else in here that could fail for an unrelated reason, so the
 * try/catch wraps all of it rather than some narrower slice.
 *
 * `checkQuota`, right below, is the other half of this module and does NOT
 * share this property — see its own comment for why a decision must never be
 * swallowed the way a receipt can be.
 */
export async function recordUsage(db: Kysely<DB>, input: RecordUsageInput): Promise<void> {
  try {
    await db
      .insertInto('usage_events')
      .values({
        user_id: input.userId,
        kind: input.kind,
        schema_id: input.schemaId,
        cost_ms: input.costMs,
        cache_hit: input.cacheHit,
      })
      .execute();
  } catch (err) {
    // No structured logger is threaded this deep — this runs from the
    // pipeline and the worker, not from a request with `request.log` — so
    // this mirrors index.ts's own console.error for the same reason it uses
    // one: whatever logs a swallowed failure must not itself be able to
    // throw and defeat the swallow.
    console.error('[quota] failed to record a usage event; continuing without it', {
      kind: input.kind, userId: input.userId, schemaId: input.schemaId, err,
    });
  }
}

export type QuotaResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; reason: string };

/**
 * Decides whether `user` may do `kind` right now.
 *
 * Unlike recordUsage, this is allowed — required — to throw on a database
 * failure rather than swallow one. A gate that swallows its own failure has
 * to pick between two silent wrongs: fail open (an outage quietly grants
 * unlimited use) or fail closed with a fabricated denial (indistinguishable
 * from a real quota exhaustion, which would mislead whoever debugs it later).
 * Propagating lets the caller's error handler answer 503 — what an
 * unreachable database actually is, as opposed to a policy decision.
 */
export async function checkQuota(db: Kysely<DB>, user: QuotaUser, kind: string): Promise<QuotaResult> {
  const limits = limitsFor(user.tier);
  return kind === SCHEMA_CREATE
    ? checkSchemaCount(db, user.id, limits)
    : checkRunsWindow(db, user.id, kind, limits);
}

async function checkSchemaCount(db: Kysely<DB>, userId: string, limits: TierLimits): Promise<QuotaResult> {
  const row = await db
    .selectFrom('schemas')
    .select((eb) => eb.fn.count<string>('id').as('count'))
    .where('owner_id', '=', userId)
    .executeTakeFirstOrThrow();

  if (Number(row.count) < limits.maxSchemas) return { allowed: true };

  return {
    allowed: false,
    // Not time-boxed: nothing about waiting frees a schema slot, only
    // deleting one does. 0 says "no wait helps", as opposed to a rate
    // denial's positive retryAfterSeconds, which says "this one does".
    retryAfterSeconds: 0,
    reason: `schema limit reached (${limits.maxSchemas} owned)`,
  };
}

/**
 * Counts real (non-cache-hit) events of `kind` for `userId` in the trailing
 * hour with one index-backed aggregate over usage_events(user_id,
 * created_at desc) (migration 001), returning both the count and the
 * window's oldest surviving event in the same query — the latter is what
 * lets a denial say *when* capacity returns instead of a made-up number.
 */
async function checkRunsWindow(
  db: Kysely<DB>, userId: string, kind: string, limits: TierLimits,
): Promise<QuotaResult> {
  const windowStart = new Date(Date.now() - WINDOW_MS);
  const row = await db
    .selectFrom('usage_events')
    .select((eb) => [
      eb.fn.count<string>('id').as('count'),
      eb.fn.min('created_at').as('oldest'),
    ])
    .where('user_id', '=', userId)
    .where('kind', '=', kind)
    .where('cache_hit', '=', false)
    .where('created_at', '>', windowStart)
    .executeTakeFirstOrThrow();

  if (Number(row.count) < limits.runsPerHour) return { allowed: true };

  // Reachable only when count > 0 (limits.runsPerHour is always positive),
  // so `oldest` is never null here.
  const oldest = row.oldest instanceof Date ? row.oldest : new Date(row.oldest as string);
  const retryAfterSeconds = Math.max(1, Math.ceil((oldest.getTime() + WINDOW_MS - Date.now()) / 1000));
  return {
    allowed: false,
    retryAfterSeconds,
    reason: `runs-per-hour limit reached (${limits.runsPerHour}/hour)`,
  };
}
