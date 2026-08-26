// Queries behind the admin surface (spec §5): user roster and tier changes,
// aggregated reasoning usage, and the reason_jobs queue's raw state.
//
// INVARIANT: `import type` only for kysely, as in modules/schemas/repo.ts and
// the other files carrying this banner. This module is reachable from
// routes/v1/index.ts (via admin/routes.ts) in postgres mode's own branch
// only, but the file itself is still statically imported by that route file
// regardless of which branch runs at request time — see server.ts's comment
// on why the desktop build's import graph still has to stay kysely-value-free.
import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.js';

export interface Page {
  limit: number;
  offset: number;
}

export interface AdminUserRow {
  id: string;
  subject: string;
  email: string | null;
  displayName: string | null;
  globalRole: 'user' | 'moderator' | 'admin';
  quotaTier: 'free' | 'verified' | 'staff';
  createdAt: Date;
  lastSeenAt: Date | null;
  /** Schemas this user owns — not schemas shared with them (mirrors modules/quota/service.ts's maxSchemas count). */
  schemaCount: number;
}

export async function listUsers(db: Kysely<DB>, page: Page): Promise<{ users: AdminUserRow[]; total: number }> {
  const [rows, totalRow] = await Promise.all([
    db.selectFrom('users as u')
      .leftJoin('schemas as s', 's.owner_id', 'u.id')
      .select((eb) => [
        'u.id', 'u.subject', 'u.email', 'u.display_name', 'u.global_role', 'u.quota_tier',
        'u.created_at', 'u.last_seen_at',
        eb.fn.count<string>('s.id').as('schema_count'),
      ])
      .groupBy(['u.id'])
      .orderBy('u.created_at', 'asc')
      .limit(page.limit)
      .offset(page.offset)
      .execute(),
    db.selectFrom('users').select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);

  return {
    total: Number(totalRow.count),
    users: rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      email: r.email,
      displayName: r.display_name,
      globalRole: r.global_role,
      quotaTier: r.quota_tier,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      schemaCount: Number(r.schema_count),
    })),
  };
}

export interface UpdateUserPatch {
  globalRole?: 'user' | 'moderator' | 'admin';
  quotaTier?: 'free' | 'verified' | 'staff';
}

/** Returns false when `id` matches no user — the route turns that into a 404. */
export async function updateUser(db: Kysely<DB>, id: string, patch: UpdateUserPatch): Promise<boolean> {
  const values: Record<string, string> = {};
  if (patch.globalRole !== undefined) values.global_role = patch.globalRole;
  if (patch.quotaTier !== undefined) values.quota_tier = patch.quotaTier;
  if (Object.keys(values).length === 0) return true; // nothing to change; existence checked below regardless

  const result = await db.updateTable('users').set(values).where('id', '=', id).executeTakeFirst();
  return (result.numUpdatedRows ?? 0n) > 0n;
}

export interface UsageSummaryRow {
  userId: string | null;
  subject: string | null;
  kind: string;
  cacheHits: number;
  realRuns: number;
  totalCostMs: number;
}

/**
 * Aggregated, never raw rows (spec §6's own reason this exists: cache hits
 * are free, so an operator needs to see who is actually spending the
 * reasoner, not a firehose of individual events).
 */
export async function usageSummary(
  db: Kysely<DB>, since: Date, page: Page,
): Promise<{ rows: UsageSummaryRow[]; total: number }> {
  const base = db.selectFrom('usage_events as e')
    .leftJoin('users as u', 'u.id', 'e.user_id')
    .where('e.created_at', '>=', since);

  const [rows, totalRow] = await Promise.all([
    base
      .select((eb) => [
        'e.user_id', 'u.subject', 'e.kind',
        eb.fn.countAll<string>().filterWhere('e.cache_hit', '=', true).as('cache_hits'),
        eb.fn.countAll<string>().filterWhere('e.cache_hit', '=', false).as('real_runs'),
        eb.fn.coalesce(eb.fn.sum<string>('e.cost_ms'), eb.lit(0)).as('total_cost_ms'),
      ])
      .groupBy(['e.user_id', 'u.subject', 'e.kind'])
      .orderBy('total_cost_ms', 'desc')
      .limit(page.limit)
      .offset(page.offset)
      .execute(),
    // Count of GROUPS, not rows — a plain countAll over `base` would count
    // usage_events rows, not the aggregated (user, kind) pairs this endpoint
    // actually paginates.
    db.selectFrom(() => base.select(['e.user_id', 'e.kind']).groupBy(['e.user_id', 'e.kind']).as('grouped'))
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow(),
  ]);

  return {
    total: Number(totalRow.count),
    rows: rows.map((r) => ({
      userId: r.user_id,
      subject: r.subject,
      kind: r.kind,
      cacheHits: Number(r.cache_hits),
      realRuns: Number(r.real_runs),
      totalCostMs: Number(r.total_cost_ms),
    })),
  };
}

export interface AdminJobRow {
  id: number;
  schemaId: string;
  requestedBy: string | null;
  cacheKey: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  enqueuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
}

export async function listJobs(db: Kysely<DB>, page: Page): Promise<{ jobs: AdminJobRow[]; total: number }> {
  const [rows, totalRow] = await Promise.all([
    db.selectFrom('reason_jobs')
      .selectAll()
      .orderBy('enqueued_at', 'desc')
      .limit(page.limit)
      .offset(page.offset)
      .execute(),
    db.selectFrom('reason_jobs').select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow(),
  ]);

  return {
    total: Number(totalRow.count),
    jobs: rows.map((r) => ({
      id: Number(r.id),
      schemaId: r.schema_id,
      requestedBy: r.requested_by,
      cacheKey: r.cache_key,
      state: r.state,
      attempts: r.attempts,
      enqueuedAt: r.enqueued_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      error: r.error,
    })),
  };
}

export type RequeueOutcome = 'requeued' | 'not-found' | 'not-stuck' | 'conflict';

/**
 * Manually requeues a `running` or `failed` job — the operator-facing escape
 * hatch for one that queue.repo.ts's own sweep hasn't (yet, or won't:
 * `failed` is terminal to the sweep) recovered. Resets `attempts` to 0: a
 * human explicitly intervening is a fresh start, not another automatic
 * retry to count against the sweep's own maxAttempts ceiling.
 *
 * `conflict` (not thrown as a raw constraint violation) is the one real
 * failure mode: the partial unique index (migration 001) allows only one
 * queued-or-running row per schema, and this schema already has a
 * different one — requeuing this row would violate it.
 */
export async function requeueJob(db: Kysely<DB>, jobId: number): Promise<RequeueOutcome> {
  const job = await db.selectFrom('reason_jobs').select(['id', 'state']).where('id', '=', jobId).executeTakeFirst();
  if (!job) return 'not-found';
  if (job.state !== 'running' && job.state !== 'failed') return 'not-stuck';

  try {
    await db.updateTable('reason_jobs')
      .set({ state: 'queued', attempts: 0, started_at: null, finished_at: null, error: null })
      .where('id', '=', jobId)
      .execute();
  } catch (err) {
    // Postgres unique_violation.
    if ((err as { code?: string }).code === '23505') return 'conflict';
    throw err;
  }
  return 'requeued';
}
