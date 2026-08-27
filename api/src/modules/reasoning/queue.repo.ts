// The durable job queue behind automatic reasoning (spec §6, §7): `reason_jobs`
// survives a restart, one pending (queued or running) job per schema is
// enforced by a partial unique index rather than application logic, and
// claiming is fair across users — a `free` user's backlog cannot starve a
// `staff` user's single job in the same queue.
//
// INVARIANT: `import type` only for kysely here, as in modules/reasoning/
// {owl,cache}.ts. This module will be reachable from routes/v1/index.ts once
// Task 5 wires the pipeline in, which both storage modes load, and pkg
// cannot snapshot kysely's top-level-await modules — a value import kills the
// packaged desktop binary at startup.

import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.js';
import { TIERS } from '../quota/tiers.js';

export type EnqueueResult = 'queued' | 'already-pending';

export interface EnqueueInput {
  schemaId: string;
  /** Whoever's edit triggered the check; null only once a requester's user row is gone (schemas.requested_by is on delete set null). */
  requestedBy: string | null;
  cacheKey: string;
}

/**
 * `on conflict … where … do nothing` targets the exact partial unique index
 * from migration 001 (`reason_jobs_one_active_per_schema`) — Postgres will
 * only infer a partial index as the conflict target when the WHERE clause
 * here matches it verbatim. A plain `.column('schema_id').doNothing()`
 * would not match this index at all and the insert would attempt to violate
 * it instead of silently no-opping.
 */
export async function enqueue(db: Kysely<DB>, input: EnqueueInput): Promise<EnqueueResult> {
  const result = await db
    .insertInto('reason_jobs')
    .values({
      schema_id: input.schemaId,
      requested_by: input.requestedBy,
      cache_key: input.cacheKey,
      state: 'queued',
    })
    .onConflict((oc) => oc.column('schema_id').where('state', 'in', ['queued', 'running']).doNothing())
    .executeTakeFirst();

  // insertInto(...).executeTakeFirst() on a no-op conflict reports
  // numInsertedOrUpdatedRows: 0n; a real insert reports 1n.
  return result.numInsertedOrUpdatedRows && result.numInsertedOrUpdatedRows > 0n
    ? 'queued'
    : 'already-pending';
}

export interface ClaimedJob {
  id: number;
  schemaId: string;
  requestedBy: string | null;
  cacheKey: string;
  attempts: number;
  enqueuedAt: Date;
  startedAt: Date;
}

function claimedJobFromRow(row: {
  id: string | number; schema_id: string; requested_by: string | null; cache_key: string;
  attempts: number; enqueued_at: Date; started_at: Date | null;
}): ClaimedJob {
  return {
    id: Number(row.id),
    schemaId: row.schema_id,
    requestedBy: row.requested_by,
    cacheKey: row.cache_key,
    attempts: row.attempts,
    enqueuedAt: row.enqueued_at,
    // Never null on a row this function just claimed: `started_at = now()` is
    // set in the same statement that produced this row.
    startedAt: row.started_at as Date,
  };
}

/**
 * Claims one queued job with `FOR UPDATE SKIP LOCKED`, marks it `running` and
 * returns it — or `undefined` if nothing is eligible right now.
 *
 * "Eligible" excludes any job whose requester already holds `running` jobs at
 * or above their tier's `maxConcurrent` (spec §6's fair scheduling), and among
 * what remains, orders by (that requester's running count ascending,
 * `enqueued_at` ascending) — so a worker that already has one user's job
 * running picks up a different user's job next, rather than the same user's
 * second one, before anyone else gets a turn.
 *
 * One statement, not a read-then-write pair: a candidate is locked
 * (`for update of rj skip locked`) and updated in the same query, so two
 * concurrent callers can never both claim it — the second one's lock attempt
 * skips the row entirely and moves on to the next candidate instead of
 * blocking on it.
 *
 * `requested_by is not distinct from` (rather than `=`) groups every job whose
 * requester's user row is gone (on delete set null) into one shared "no
 * requester" bucket for the running-count and cap check, using the fallback
 * tier's cap. That is deliberately conservative — several deleted users'
 * orphaned jobs sharing one cap — rather than exempting them from the cap
 * entirely, which unbounded orphaned backlog would defeat the point of.
 */
export async function claimNext(db: Kysely<DB>): Promise<ClaimedJob | undefined> {
  const row = await sql<{
    id: string; schema_id: string; requested_by: string | null; cache_key: string;
    attempts: number; enqueued_at: Date; started_at: Date | null;
  }>`
    with candidates as (
      select
        rj.id,
        coalesce(u.quota_tier, 'free') as tier,
        (
          select count(*) from reason_jobs r2
          where r2.requested_by is not distinct from rj.requested_by
            and r2.state = 'running'
        ) as running_count,
        rj.enqueued_at
      from reason_jobs rj
      left join users u on u.id = rj.requested_by
      where rj.state = 'queued'
    ),
    eligible as (
      select id, running_count, enqueued_at
      from candidates
      where running_count < case tier
        when 'verified' then ${TIERS.verified.maxConcurrent}::int
        when 'staff' then ${TIERS.staff.maxConcurrent}::int
        else ${TIERS.free.maxConcurrent}::int
      end
    ),
    picked as (
      select rj.id
      from reason_jobs rj
      join eligible e on e.id = rj.id
      order by e.running_count asc, e.enqueued_at asc
      limit 1
      for update of rj skip locked
    )
    update reason_jobs
    set state = 'running', started_at = now()
    where id = (select id from picked)
    returning id, schema_id, requested_by, cache_key, attempts, enqueued_at, started_at
  `.execute(db);

  const claimed = row.rows[0];
  return claimed ? claimedJobFromRow(claimed) : undefined;
}

export type FinishOutcome = { status: 'done' } | { status: 'failed'; error: string };

/** Terminal state for a claimed job. Never returned by claimNext again. */
export async function finish(db: Kysely<DB>, jobId: number, outcome: FinishOutcome): Promise<void> {
  await db
    .updateTable('reason_jobs')
    .set({
      state: outcome.status,
      finished_at: new Date(),
      ...(outcome.status === 'failed' ? { error: outcome.error } : {}),
    })
    .where('id', '=', jobId)
    .execute();
}

export interface SweepResult {
  /** Requeued (state -> 'queued', attempts incremented) to run again. */
  requeued: number;
  /** Gave up (state -> 'failed') after reaching maxAttempts. */
  failedOut: number;
}

/**
 * Recovers `running` jobs whose worker died mid-run: a job older than its
 * requester's tier `timeoutMs` is requeued with `attempts` incremented, or
 * marked `failed` once `attempts` would reach `maxAttempts`. Without this, a
 * crashed worker leaves a job (and the schema's `reason_state`) stuck
 * `running`/`queued`-adjacent forever, since nothing else ever revisits it.
 *
 * Row-locked (`for update skip locked`) so two sweepers running at once (two
 * replicas, or a sweep overlapping a slow previous one) never both act on the
 * same job.
 */
export async function sweepStuck(db: Kysely<DB>, opts: { maxAttempts: number }): Promise<SweepResult> {
  const stuck = await sql<{
    id: string; attempts: number;
  }>`
    select rj.id, rj.attempts
    from reason_jobs rj
    left join users u on u.id = rj.requested_by
    where rj.state = 'running'
      and rj.started_at < now() - make_interval(secs => case coalesce(u.quota_tier, 'free')
          when 'verified' then ${TIERS.verified.timeoutMs}::numeric
          when 'staff' then ${TIERS.staff.timeoutMs}::numeric
          else ${TIERS.free.timeoutMs}::numeric
        end / 1000)
    for update of rj skip locked
  `.execute(db);

  let requeued = 0;
  let failedOut = 0;
  for (const job of stuck.rows) {
    const id = Number(job.id);
    const nextAttempts = job.attempts + 1;
    if (nextAttempts >= opts.maxAttempts) {
      await db.updateTable('reason_jobs')
        .set({ state: 'failed', attempts: nextAttempts, finished_at: new Date(), error: 'timed out (stuck job, no worker finished it)' })
        .where('id', '=', id)
        .execute();
      failedOut += 1;
    } else {
      await db.updateTable('reason_jobs')
        .set({ state: 'queued', attempts: nextAttempts, started_at: null })
        .where('id', '=', id)
        .execute();
      requeued += 1;
    }
  }
  return { requeued, failedOut };
}
