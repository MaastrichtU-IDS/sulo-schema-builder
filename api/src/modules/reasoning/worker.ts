// Runs the pipeline: N claim-and-reason loops plus the recovery sweep, both
// postgres-mode only (server.ts starts this in that branch alone — the
// frozen sqlite desktop path keeps its old in-process FIFO in reason.ts,
// untouched by any of this). `startWorkers`/`stopWorkers` is the one pair
// server.ts calls; `stopWorkers` also clears pipeline.ts's debounce timers,
// so a test or a reload never leaks a live setTimeout.

import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.js';
import { config } from '../../config/index.js';
import { sweepStuck } from './queue.repo.js';
import { findStaleSchemas, stopPendingChecks, runOnce, checkNow, type PipelineDeps } from './pipeline.js';

export interface WorkerDeps extends PipelineDeps {
  /** Claim loops to run concurrently. Defaults to config.reasoner.maxConcurrent — the same ceiling that gates JVM spawns, so a worker is never left waiting on a slot reasoner.service.ts's own semaphore would have given it anyway. */
  concurrency?: number;
  pollIntervalMs?: number;
  sweepIntervalMs?: number;
  staleAfterMs?: number;
  jobMaxAttempts?: number;
}

interface LoopHandle { stopped: boolean }

let workerHandles: LoopHandle[] = [];
let sweepTimer: NodeJS.Timeout | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function claimLoop(deps: WorkerDeps, handle: LoopHandle): Promise<void> {
  const pollMs = deps.pollIntervalMs ?? config.reasoner.workerPollIntervalMs;
  while (!handle.stopped) {
    let claimedSomething = false;
    try {
      const result = await runOnce(deps);
      claimedSomething = result.claimed;
    } catch (err) {
      // A claim/reason/store round trip failing outright (a dropped
      // connection, say) must not kill the loop — the next iteration tries
      // again, and the job itself is recovered by the sweep if it was left
      // half-claimed.
      console.error('[reasoning] worker iteration failed', err);
    }
    if (!claimedSomething) await sleep(pollMs);
  }
}

export interface SweepResult {
  requeuedJobs: number;
  failedJobs: number;
  staleSchemasRechecked: number;
}

/**
 * One sweep pass: recover jobs whose worker died mid-run (queue.repo.ts's
 * `sweepStuck`), then re-trigger a check for every schema that has sat
 * `stale` too long — a debounce timer lost to a process restart, or one that
 * fired and lost a race with `already-pending` and nothing ever revisited it
 * (pipeline.ts's `checkNow` documents that gap; this is its safety net).
 *
 * Re-checking uses the schema's OWNER as the requester: there is no live
 * request behind a sweep-triggered check, and the owner is whose reasoning
 * budget a schema draws from by default.
 */
export async function sweepLoop(deps: WorkerDeps): Promise<SweepResult> {
  const { requeued, failedOut } = await sweepStuck(deps.db, {
    maxAttempts: deps.jobMaxAttempts ?? config.reasoner.jobMaxAttempts,
  });

  const stale = await findStaleSchemas(deps.db, deps.staleAfterMs ?? config.reasoner.staleSweepAfterMs);
  for (const schema of stale) {
    try {
      await checkNow(deps, schema.id, schema.ownerId);
    } catch (err) {
      console.error('[reasoning] sweep-triggered check failed', { schemaId: schema.id, err });
    }
  }

  return { requeuedJobs: requeued, failedJobs: failedOut, staleSchemasRechecked: stale.length };
}

/** Starts `concurrency` claim loops and the periodic sweep. Postgres mode only. */
export function startWorkers(deps: WorkerDeps): void {
  const concurrency = deps.concurrency ?? config.reasoner.maxConcurrent;
  workerHandles = Array.from({ length: concurrency }, () => {
    const handle: LoopHandle = { stopped: false };
    void claimLoop(deps, handle);
    return handle;
  });

  const sweepMs = deps.sweepIntervalMs ?? config.reasoner.sweepIntervalMs;
  sweepTimer = setInterval(() => {
    sweepLoop(deps).catch((err) => console.error('[reasoning] sweep failed', err));
  }, sweepMs);
  // Never keeps the process alive on its own — a test that starts workers
  // and forgets to stop them should still exit, not hang on this timer.
  sweepTimer.unref();
}

/** Stops every claim loop, the sweep, and pipeline.ts's pending debounce timers. */
export function stopWorkers(): void {
  for (const handle of workerHandles) handle.stopped = true;
  workerHandles = [];
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
  stopPendingChecks();
}
