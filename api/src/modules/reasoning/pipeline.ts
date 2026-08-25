// Orchestrates spec §7's automatic reasoning pipeline: a mutation marks its
// schema dirty, a debouncer waits for the edit burst to end, the debounced
// check either reuses a cached verdict or enqueues a durable job, and a
// worker (worker.ts) later claims that job and runs the actual reasoner.
//
// This module owns the ORCHESTRATION only — deciding what should happen next
// for a schema — not the reasoner invocation itself, which is injected
// (`PipelineDeps.reason`, defaulting to services/reasoner.service.ts's real
// HermiT run) so tests can exercise every branch without a JVM.
//
// INVARIANT: `import type` only for kysely here. This module is ALREADY
// reachable from routes/v1/index.ts as of this plan's own Task 5 — not only
// once Task 6 wires the report routes in — because modules/schemas/service.ts
// now imports `markDirty`/`scheduleCheck` from here, and service.ts sits on
// that graph in both storage modes. pkg cannot snapshot kysely's
// top-level-await modules; a value import kills the packaged desktop binary
// at startup.
//
// The same rule extends one hop further than usual: `queue.repo.ts` needs a
// REAL kysely value (`sql`, for its raw CTEs) and is therefore never
// statically imported here — only `queueRepo()` below, loaded with a dynamic
// `import()` inside the functions that actually need it (checkNow, runOnce).
// Those functions are only ever CALLED in postgres mode, but a `import { x }
// from './queue.repo.js'` at this file's top level would still eagerly run
// queue.repo.ts's module body — including its `sql` import — the moment
// schemas/service.ts (and therefore routes/v1/index.ts) loads, in EITHER
// storage mode. A dynamic `import()` defers that to call time instead.

import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.js';
import { config } from '../../config/index.js';
import { reasonOntologyDL, type ConsistencyReport } from '../../services/reasoner.service.js';
import { getSuloDigest } from '../../services/sulo.service.js';
import { limitsFor, FALLBACK_TIER } from '../quota/tiers.js';
import { checkQuota, recordUsage, REASON_RUN, type QuotaResult } from '../quota/service.js';
import { generateOwl } from './owl.js';
import { cacheKeyFor, findReport, storeReport } from './cache.js';
import type { ClaimedJob } from './queue.repo.js';
import { createDebouncer, type Debouncer } from './debounce.js';

/** The only way this module touches queue.repo.ts's VALUES — see the header. */
function queueRepo(): Promise<typeof import('./queue.repo.js')> {
  return import('./queue.repo.js');
}

/** Same reasoning as queueRepo() above, for notify.ts's real kysely `sql` value. */
function eventsNotify(): Promise<typeof import('../events/notify.js')> {
  return import('../events/notify.js');
}

export interface PipelineDeps {
  db: Kysely<DB>;
  /** Injected so tests never spawn a JVM. Defaults to the real HermiT run. */
  reason?: (turtleOwl: string) => Promise<ConsistencyReport>;
  debounceMs?: number;
  maxWaitMs?: number;
  /**
   * Test seam only: real tiers cap the generated OWL in the hundreds of
   * kilobytes to megabytes (modules/quota/tiers.ts), which nothing this
   * module's own tests can afford to construct. Real callers never set this.
   */
  maxOwlBytesOverride?: number;
}

/** Sets the one column a mutation needs to touch here, in the caller's own transaction. */
export async function markDirty(trx: Kysely<DB>, schemaId: string): Promise<void> {
  await trx.updateTable('schemas').set({ reason_state: 'stale' }).where('id', '=', schemaId).execute();
}

async function tierFor(db: Kysely<DB>, userId: string | null): Promise<string> {
  if (!userId) return FALLBACK_TIER;
  const row = await db.selectFrom('users').select('quota_tier').where('id', '=', userId).executeTakeFirst();
  return row?.quota_tier ?? FALLBACK_TIER;
}

/**
 * Writes the outcome of a completed check for `contentHash`/`cacheKey` onto
 * the schema row — shared by the cache-hit path (checkNow) and a worker's
 * completed job (runOnce), since both end with "we now have a definitive
 * report for this exact content; is the schema still that content?"
 *
 * That question is answered by REGENERATING the OWL right now and comparing
 * its cache key to the one being settled, rather than trusting the schema's
 * `reason_state` column as a version marker. `reason_state` cannot serve that
 * purpose: markDirty sets it to 'stale' unconditionally on every mutation, so
 * a second edit landing while this check was in flight already looks
 * identical, in that column alone, to no edit at all. Comparing against
 * fresh generation is cheap (no JVM — it's a query plus a template render)
 * and is the only thing that actually distinguishes the two cases.
 *
 * `latest_report_key`/`content_hash` are written either way: a report that
 * no longer matches the CURRENT content is still a valid, better-than-nothing
 * verdict for the content it was computed against, which is exactly what the
 * `stale`-with-a-`report` UI state (plan 5 task 6's contract) shows. Only
 * `reason_state` depends on currency. A schema left `stale` here is not lost:
 * the edit that made it current already has its own scheduleCheck in flight,
 * and the recovery sweep (worker.ts) picks up anything that doesn't land.
 */
async function settle(db: Kysely<DB>, schemaId: string, cacheKey: string, contentHash: string): Promise<void> {
  const current = await generateOwl(db, schemaId);
  if (!current) return; // Deleted between the check starting and finishing.

  const isCurrent = cacheKeyFor({
    contentHash: current.contentHash,
    suloHash: getSuloDigest(),
    robotVersion: config.reasoner.robotVersion,
  }) === cacheKey;

  await db.updateTable('schemas')
    .set({ latest_report_key: cacheKey, content_hash: contentHash, reason_state: isCurrent ? 'fresh' : 'stale' })
    .where('id', '=', schemaId)
    .execute();

  const { notifySchemaChanged } = await eventsNotify();
  await notifySchemaChanged(db, schemaId, 'report');
}

export type CheckOutcome =
  | { kind: 'no-schema' }
  | { kind: 'cache-hit'; cacheKey: string }
  | { kind: 'enqueued'; cacheKey: string }
  | { kind: 'already-pending'; cacheKey: string }
  | { kind: 'owl-too-large' }
  | { kind: 'quota-denied'; retryAfterSeconds: number };

/**
 * Generates OWL for `schemaId` right now and either settles it from the
 * cache or enqueues a job for it — the unit of work a debounce firing (or
 * the sweep, for a schema that has sat `stale` too long) performs. Exported
 * directly (not only reachable through the debounce timer) because most of
 * its branches — cache hit, oversized OWL, quota denial — have nothing to do
 * with timing and are far cheaper to test by calling this than by waiting on
 * a real or faked timer.
 */
export async function checkNow(deps: PipelineDeps, schemaId: string, requestedBy: string | null): Promise<CheckOutcome> {
  const generated = await generateOwl(deps.db, schemaId);
  if (!generated) return { kind: 'no-schema' };

  const suloHash = getSuloDigest();
  const robotVersion = config.reasoner.robotVersion;
  const cacheKey = cacheKeyFor({ contentHash: generated.contentHash, suloHash, robotVersion });

  const existing = await findReport(deps.db, cacheKey);
  if (existing) {
    await settle(deps.db, schemaId, cacheKey, generated.contentHash);
    await recordUsage(deps.db, { userId: requestedBy, kind: REASON_RUN, schemaId, costMs: 0, cacheHit: true });
    return { kind: 'cache-hit', cacheKey };
  }

  const tier = await tierFor(deps.db, requestedBy);
  const owlBytes = Buffer.byteLength(generated.turtle, 'utf8');
  const maxOwlBytes = deps.maxOwlBytesOverride ?? limitsFor(tier).maxOwlBytes;
  if (owlBytes > maxOwlBytes) {
    // Not enqueued at all (spec §6): the reasoner would reject it anyway, and
    // this way no job, no queue slot and no quota are ever spent on it.
    await deps.db.updateTable('schemas').set({ reason_state: 'failed' }).where('id', '=', schemaId).execute();
    const { notifySchemaChanged } = await eventsNotify();
    await notifySchemaChanged(deps.db, schemaId, 'report');
    return { kind: 'owl-too-large' };
  }

  // `requestedBy ?? ''` is deliberate, not a null-coalescing shortcut: an
  // automatic check always has a real requester in practice (every mutation
  // path and the sweep's owner-id fallback supply one) — `null` reaching
  // here would mean a caller skipped that. Passing '' rather than throwing
  // means such a caller sees an always-allowed, unmetered check (no
  // usage_events row can ever match an empty user_id) instead of a crash;
  // it fails safe for an input this module's own callers should never send.
  const quota: QuotaResult = await checkQuota(deps.db, { id: requestedBy ?? '', tier }, REASON_RUN);
  if (!quota.allowed) {
    // reason_state stays whatever markDirty left it ('stale'): the check
    // simply did not run. It resumes on the next edit's own scheduleCheck, or
    // via the sweep once the schema has sat stale long enough, whichever
    // comes first — by which point capacity may have returned.
    return { kind: 'quota-denied', retryAfterSeconds: quota.retryAfterSeconds };
  }

  const { enqueue } = await queueRepo();
  const enqueued = await enqueue(deps.db, { schemaId, requestedBy, cacheKey });
  if (enqueued === 'queued') {
    await deps.db.updateTable('schemas').set({ reason_state: 'queued' }).where('id', '=', schemaId).execute();
    const { notifySchemaChanged } = await eventsNotify();
    await notifySchemaChanged(deps.db, schemaId, 'mutated');
    return { kind: 'enqueued', cacheKey };
  }
  // Already a queued/running job for this schema (the partial unique index
  // enforces it) — do not touch reason_state; leave it exactly as the
  // mutation that triggered this check left it.
  return { kind: 'already-pending', cacheKey };
}

// ─── Debounced scheduling ───────────────────────────────────────────────────

/**
 * The debouncer is process-wide, matching spec §7's "in-memory schemaId ->
 * timer map" — one burst-coalescer per process, not per caller. `pending`
 * carries the most recently supplied `deps`/`requestedBy` for each scheduled
 * schema, so a burst of edits by different callers settles on whichever
 * scheduled last, which is also whichever is about to be checked.
 */
const pending = new Map<string, { deps: PipelineDeps; requestedBy: string | null }>();
let debouncer: Debouncer | undefined;

function fireCheck(schemaId: string): void {
  const entry = pending.get(schemaId);
  pending.delete(schemaId);
  if (!entry) return;
  checkNow(entry.deps, schemaId, entry.requestedBy).catch((err) => {
    console.error('[reasoning] scheduled check failed', { schemaId, err });
  });
}

/** Schedules (or reschedules) a debounced check for `schemaId`. Fire-and-forget: never awaited by its caller. */
export function scheduleCheck(deps: PipelineDeps, schemaId: string, requestedBy: string | null): void {
  const idleMs = deps.debounceMs ?? config.reasoner.debounceMs;
  const maxMs = deps.maxWaitMs ?? config.reasoner.debounceMaxMs;
  pending.set(schemaId, { deps, requestedBy });
  // Built lazily from the FIRST call's idle/max — real deployments call this
  // with one config throughout a process's life. resetPipelineForTests below
  // is how a suite gets a clean debouncer between cases that need different
  // timings.
  if (!debouncer) debouncer = createDebouncer(fireCheck, { idleMs, maxMs });
  debouncer.schedule(schemaId);
}

/**
 * Drops every pending debounce timer and the debouncer itself. Not just a
 * test seam: worker.ts's `stopWorkers` calls this too, since a process
 * shutdown (or a reload in dev) must not leave a live `setTimeout` behind
 * any more than it should leave a claim loop running.
 */
export function stopPendingChecks(): void {
  debouncer?.stopAll();
  debouncer = undefined;
  pending.clear();
}

// ─── The worker's unit of work ──────────────────────────────────────────────

export type RunOnceResult =
  | { claimed: false }
  | { claimed: true; jobId: number; schemaId: string; outcome: 'done' | 'failed' };

/**
 * Claims one job (queue.repo.ts's `claimNext` — `FOR UPDATE SKIP LOCKED`,
 * fair across users) and runs it to completion: regenerate OWL, reuse a
 * cache entry if one now exists (another worker may have finished an
 * equivalent job while this one waited), otherwise call the reasoner, store
 * the report, and settle the schema.
 *
 * OWL is regenerated from the database HERE rather than trusting the job's
 * own `cache_key` for what to check: a job only records that a check was
 * warranted at enqueue time, never the OWL itself, and the schema may have
 * changed again before a worker got to it. Reasoning over whatever is
 * current and settling under ITS cache key (recomputed below) means a run
 * this process already paid for always produces a report for real content,
 * never one filed under a key that no longer describes anything — case 7 in
 * plan 4 task 5's brief.
 */
export async function runOnce(deps: PipelineDeps): Promise<RunOnceResult> {
  const { claimNext, finish } = await queueRepo();
  const job: ClaimedJob | undefined = await claimNext(deps.db);
  if (!job) return { claimed: false };

  // `WHERE reason_state = 'queued'`: a newer edit landing between enqueue and
  // this claim already reset the schema to 'stale' (markDirty is
  // unconditional), and that is more informative to a subscriber than
  // 'running' would be — this update simply does not apply then. Notify
  // either way; a client that was actually still 'stale' just refetches and
  // sees no change, which costs one read on an ACL-checked endpoint it
  // already polls.
  await deps.db.updateTable('schemas').set({ reason_state: 'running' })
    .where('id', '=', job.schemaId).where('reason_state', '=', 'queued').execute();
  const { notifySchemaChanged } = await eventsNotify();
  await notifySchemaChanged(deps.db, job.schemaId, 'mutated');

  const generated = await generateOwl(deps.db, job.schemaId);
  if (!generated) {
    // The schema was deleted after this job was enqueued. Nothing left to
    // check, settle, or store a report for.
    await finish(deps.db, job.id, { status: 'failed', error: 'schema no longer exists' });
    return { claimed: true, jobId: job.id, schemaId: job.schemaId, outcome: 'failed' };
  }

  const suloHash = getSuloDigest();
  const robotVersion = config.reasoner.robotVersion;
  const cacheKey = cacheKeyFor({ contentHash: generated.contentHash, suloHash, robotVersion });

  const existing = await findReport(deps.db, cacheKey);
  if (existing) {
    await finish(deps.db, job.id, { status: 'done' });
    await recordUsage(deps.db, { userId: job.requestedBy, kind: REASON_RUN, schemaId: job.schemaId, costMs: 0, cacheHit: true });
    await settle(deps.db, job.schemaId, cacheKey, generated.contentHash);
    return { claimed: true, jobId: job.id, schemaId: job.schemaId, outcome: 'done' };
  }

  const reason = deps.reason ?? reasonOntologyDL;
  const startedAt = Date.now();
  try {
    const report = await reason(generated.turtle);
    const durationMs = Date.now() - startedAt;
    await storeReport(deps.db, { cacheKey, report, reasoner: report.reasoner, suloHash, durationMs });
    await finish(deps.db, job.id, { status: 'done' });
    await recordUsage(deps.db, { userId: job.requestedBy, kind: REASON_RUN, schemaId: job.schemaId, costMs: durationMs, cacheHit: false });
    await settle(deps.db, job.schemaId, cacheKey, generated.contentHash);
    return { claimed: true, jobId: job.id, schemaId: job.schemaId, outcome: 'done' };
  } catch (err) {
    // Deliberately does NOT call settle/storeReport: a failed run has no
    // verdict to cache, and caching nothing under this key means the next
    // check (another edit, or the sweep) tries again rather than being
    // permanently told "failed" for content that was never actually reasoned
    // over successfully.
    await finish(deps.db, job.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    await deps.db.updateTable('schemas').set({ reason_state: 'failed' }).where('id', '=', job.schemaId).execute();
    await notifySchemaChanged(deps.db, job.schemaId, 'report');
    return { claimed: true, jobId: job.id, schemaId: job.schemaId, outcome: 'failed' };
  }
}

/** Schemas left `stale` at least `staleAfterMs` ago — a debounce timer lost to a restart or another replica. */
export async function findStaleSchemas(db: Kysely<DB>, staleAfterMs: number): Promise<Array<{ id: string; ownerId: string }>> {
  const threshold = new Date(Date.now() - staleAfterMs);
  const rows = await db
    .selectFrom('schemas')
    .select(['id', 'owner_id'])
    .where('reason_state', '=', 'stale')
    .where('modified_at', '<', threshold)
    .execute();
  return rows.map((r) => ({ id: r.id, ownerId: r.owner_id }));
}
