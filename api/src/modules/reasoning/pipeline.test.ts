// The orchestration layer for spec §7's automatic reasoning pipeline. The
// reasoner is always injected here (`PipelineDeps.reason`) — this suite is
// about what the pipeline decides to do, never about HermiT itself, which
// Task 8's real end-to-end spec covers.
//
// Fixtures go through the schema HTTP surface (never a hand-inserted
// `schemas`/`users` row) for the same reason owl.test.ts and
// listing.test.ts do: truncateAll spares `users`, and the auth plugin's
// subject -> user cache means a fabricated id drifts from the real one.
// Every mutating request below ALSO exercises the real wiring in
// modules/schemas/service.ts (markDirty inside the mutation's own
// transaction, then scheduleCheck) — this file's own `stopPendingChecks()`
// in `afterAll` drops whatever those requests scheduled before the pool
// they'd read from is destroyed.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import { buildAuthedApp, type AuthedTestApp } from '../../test/authApp.js';
import type { ConsistencyReport } from '../../services/reasoner.service.js';
import { TIERS } from '../quota/tiers.js';
import { REASON_RUN } from '../quota/service.js';
import { findReport, storeReport } from './cache.js';
import { enqueue } from './queue.repo.js';
import {
  checkNow, markDirty, runOnce, scheduleCheck, stopPendingChecks, type PipelineDeps,
} from './pipeline.js';
import { sweepLoop } from './worker.js';

let t: TestDb;
let harness: AuthedTestApp;

beforeAll(async () => {
  t = await startTestDb();
  harness = await buildAuthedApp(t.db);
});

afterAll(async () => {
  stopPendingChecks();
  await harness.close();
  await t.stop();
});

beforeEach(async () => {
  await truncateAll(t.db);
  // scheduleCheck's debouncer is a lazily-built, process-wide singleton
  // (pipeline.ts documents this): the FIRST call anywhere in this file wins
  // its idle/max timings for every later call, unless reset. Nothing here
  // wants that cross-test coupling, and the debounce tests below need their
  // own short timings to actually take effect.
  stopPendingChecks();
});

const CONSISTENT: ConsistencyReport = { consistent: true, reasoner: 'HermiT', clashes: [] };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CreatedSchema { id: string; title: string }

async function createSchema(title = 'Pipeline fixture'): Promise<CreatedSchema> {
  const res = await harness.inject({ method: 'POST', url: '/ontology-schemas', payload: { title } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function addClass(schemaId: string, name: string): Promise<{ id: string }> {
  const res = await harness.inject({
    method: 'POST', url: `/ontology-schemas/${schemaId}/classes`, payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

/** Every schema created above belongs to this one fixture caller. */
async function ownerOf(schemaId: string): Promise<string> {
  const row = await t.db.selectFrom('schemas').select('owner_id').where('id', '=', schemaId).executeTakeFirstOrThrow();
  return row.owner_id;
}

async function reasonState(schemaId: string): Promise<string> {
  const row = await t.db.selectFrom('schemas').select('reason_state').where('id', '=', schemaId).executeTakeFirstOrThrow();
  return row.reason_state;
}

async function schemaRow(schemaId: string) {
  return t.db.selectFrom('schemas').selectAll().where('id', '=', schemaId).executeTakeFirstOrThrow();
}

function deps(reason: PipelineDeps['reason'] = async () => CONSISTENT): PipelineDeps {
  return { db: t.db, reason };
}

describe('markDirty', () => {
  it('sets reason_state stale only if the transaction actually commits', async () => {
    const schema = await createSchema();
    // Simulate "already checked": a prior successful run left it fresh.
    await t.db.updateTable('schemas').set({ reason_state: 'fresh' }).where('id', '=', schema.id).execute();

    await expect(t.db.transaction().execute(async (trx) => {
      await markDirty(trx, schema.id);
      throw new Error('boom — the write around markDirty failed');
    })).rejects.toThrow('boom');

    // The mark rolled back with everything else in its transaction.
    expect(await reasonState(schema.id)).toBe('fresh');

    await t.db.transaction().execute(async (trx) => { await markDirty(trx, schema.id); });
    expect(await reasonState(schema.id)).toBe('stale');
  });

  it('is wired into a real mutation: adding a class marks a fresh schema stale again', async () => {
    const schema = await createSchema();
    await t.db.updateTable('schemas').set({ reason_state: 'fresh' }).where('id', '=', schema.id).execute();

    await addClass(schema.id, 'Patient');

    expect(await reasonState(schema.id)).toBe('stale');
  });
});

describe('checkNow', () => {
  it('returns no-schema for an id that does not exist', async () => {
    const outcome = await checkNow(deps(), '00000000-0000-0000-0000-000000000000', null);
    expect(outcome).toEqual({ kind: 'no-schema' });
  });

  it('cache hit: settles fresh with no job and no run, and records a cache-hit usage event', async () => {
    const schema = await createSchema();
    const owner = await ownerOf(schema.id);

    // Learn the exact cache key checkNow will compute for this content by
    // asking it — it enqueues a job on a miss, which this test then discards
    // in favour of pre-seeding a report under that same key.
    const first = await checkNow(deps(), schema.id, owner);
    expect(first.kind).toBe('enqueued');
    if (first.kind !== 'enqueued') throw new Error('unreachable');

    await storeReport(t.db, {
      cacheKey: first.cacheKey, report: CONSISTENT, reasoner: 'HermiT', suloHash: 'irrelevant-for-this-assertion', durationMs: 5,
    });
    // Reset as if nothing had been enqueued, so the second call takes the
    // cache-hit branch rather than colliding with the job just created.
    await t.db.deleteFrom('reason_jobs').where('schema_id', '=', schema.id).execute();
    await t.db.updateTable('schemas').set({ reason_state: 'stale' }).where('id', '=', schema.id).execute();

    const second = await checkNow(deps(), schema.id, owner);
    expect(second).toEqual({ kind: 'cache-hit', cacheKey: first.cacheKey });
    expect(await reasonState(schema.id)).toBe('fresh');

    const events = await t.db.selectFrom('usage_events').selectAll().where('schema_id', '=', schema.id).execute();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: REASON_RUN, cache_hit: true, user_id: owner });
  });

  it('cache miss: enqueues exactly one job and leaves reason_state queued', async () => {
    const schema = await createSchema();
    const owner = await ownerOf(schema.id);

    const outcome = await checkNow(deps(), schema.id, owner);
    expect(outcome.kind).toBe('enqueued');
    expect(await reasonState(schema.id)).toBe('queued');

    const jobs = await t.db.selectFrom('reason_jobs').selectAll().where('schema_id', '=', schema.id).execute();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe('queued');
  });

  it('an OWL larger than the override cap is not enqueued: reason_state becomes failed', async () => {
    const schema = await createSchema();
    const owner = await ownerOf(schema.id);

    const outcome = await checkNow({ db: t.db, maxOwlBytesOverride: 1 }, schema.id, owner);
    expect(outcome).toEqual({ kind: 'owl-too-large' });
    expect(await reasonState(schema.id)).toBe('failed');

    const jobs = await t.db.selectFrom('reason_jobs').selectAll().where('schema_id', '=', schema.id).execute();
    expect(jobs).toHaveLength(0);
  });

  it('a quota denial leaves reason_state stale (not failed) and records no run', async () => {
    const schema = await createSchema();
    const owner = await ownerOf(schema.id);

    // Exhaust the free tier's runsPerHour with real (non-cache-hit) events.
    for (let i = 0; i < TIERS.free.runsPerHour; i += 1) {
      await t.db.insertInto('usage_events').values({
        user_id: owner, kind: REASON_RUN, schema_id: null, cost_ms: 10, cache_hit: false,
      }).execute();
    }

    const outcome = await checkNow(deps(), schema.id, owner);
    expect(outcome.kind).toBe('quota-denied');
    expect(await reasonState(schema.id)).toBe('stale');

    const jobs = await t.db.selectFrom('reason_jobs').selectAll().where('schema_id', '=', schema.id).execute();
    expect(jobs).toHaveLength(0);
    const newEvents = await t.db.selectFrom('usage_events').selectAll()
      .where('schema_id', '=', schema.id).execute();
    expect(newEvents).toHaveLength(0); // the denied attempt itself records nothing
  });

  it('a second edit landing WHILE a job runs is not clobbered by that job settling fresh', async () => {
    const schema = await createSchema();
    const owner = await ownerOf(schema.id);
    const enqueued = await checkNow(deps(), schema.id, owner);
    expect(enqueued.kind).toBe('enqueued');

    // runOnce fixes the OWL it will reason over BEFORE calling `reason` — so
    // an edit made from inside this fake `reason` callback genuinely
    // simulates one landing while the real JVM run would still be in
    // flight: the content it changes is not the content this job claimed.
    const runDeps = deps(async () => {
      await addClass(schema.id, 'NewDuringRun');
      return CONSISTENT;
    });
    const run = await runOnce(runDeps);
    expect(run).toMatchObject({ claimed: true, outcome: 'done' });

    // The job's report is valid for the OLD content, but no longer the
    // CURRENT content — settle() recomputes the current cache key and finds
    // it does not match, so this must not clear the newer edit's staleness.
    expect(await reasonState(schema.id)).toBe('stale');
    const row = await schemaRow(schema.id);
    expect(row.latest_report_key).not.toBeNull(); // still recorded — a valid report for the content it was computed against

    // Not queued twice either: addClass's own markDirty->scheduleCheck is
    // still sitting on a live (real, non-fake-timer) debounce timer that
    // has not fired yet — nothing here has raced ahead and created a second
    // job for the new content.
    const jobs = await t.db.selectFrom('reason_jobs').selectAll().where('schema_id', '=', schema.id).execute();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe('done');
  });
});

describe('runOnce', () => {
  it('moves a job queued -> running -> done, stores the report, and settles fresh', async () => {
    const schema = await createSchema();
    const owner = await ownerOf(schema.id);
    const enqueueOutcome = await checkNow(deps(), schema.id, owner);
    expect(enqueueOutcome.kind).toBe('enqueued');

    const result = await runOnce(deps());
    expect(result).toMatchObject({ claimed: true, schemaId: schema.id, outcome: 'done' });

    const row = await schemaRow(schema.id);
    expect(row.reason_state).toBe('fresh');
    expect(row.latest_report_key).not.toBeNull();

    const stored = await findReport(t.db, row.latest_report_key!);
    expect(stored?.report).toEqual(CONSISTENT);
  });

  it('returns claimed:false when nothing is queued', async () => {
    expect(await runOnce(deps())).toEqual({ claimed: false });
  });

  it('a reasoner failure sets reason_state failed without storing a report under that key', async () => {
    const schema = await createSchema();
    const owner = await ownerOf(schema.id);
    await checkNow(deps(), schema.id, owner);

    const failing = deps(async () => { throw new Error('HermiT blew up'); });
    const result = await runOnce(failing);
    expect(result).toMatchObject({ claimed: true, outcome: 'failed' });

    const row = await schemaRow(schema.id);
    expect(row.reason_state).toBe('failed');
    expect(row.latest_report_key).toBeNull();

    const jobs = await t.db.selectFrom('reason_jobs').selectAll().where('schema_id', '=', schema.id).execute();
    expect(jobs[0].state).toBe('failed');
    expect(jobs[0].error).toContain('HermiT blew up');
  });
});

describe('debounced scheduling', () => {
  // debounceCheck's downstream effect is observable through the database
  // (checkNow enqueues a job on this fresh schema's first check — it never
  // calls `deps.reason` itself, only a worker's runOnce does), so these
  // assert on reason_jobs/reason_state rather than on the fake reasoner.

  it('coalesces a burst of schedule() calls into exactly one check', async () => {
    const schema = await createSchema('Debounce burst');
    const owner = await ownerOf(schema.id);
    // createSchema() above already called scheduleCheck itself (with the
    // default, much longer timings) — that lazily built the module-wide
    // debouncer before this test's own short timings get a say. Reset it so
    // the very next scheduleCheck call below is what actually builds it.
    stopPendingChecks();
    const d = deps();
    d.debounceMs = 60;
    d.maxWaitMs = 5_000;

    scheduleCheck(d, schema.id, owner);
    await sleep(20);
    scheduleCheck(d, schema.id, owner); // resets the idle timer
    await sleep(20);
    scheduleCheck(d, schema.id, owner); // resets it again — ~40ms of "burst" so far

    // Not yet: only ~40ms has passed since the LAST schedule call, well under
    // the 60ms idle window.
    await sleep(30);
    expect(await reasonState(schema.id)).toBe('stale');

    // Now well past the 60ms idle window since the last schedule call — with
    // slack for checkNow's own sequence of real DB round trips to finish.
    await sleep(400);
    expect(await reasonState(schema.id)).toBe('queued');
    const jobs = await t.db.selectFrom('reason_jobs').selectAll().where('schema_id', '=', schema.id).execute();
    expect(jobs).toHaveLength(1); // one check fired for the whole burst, not three

    stopPendingChecks();
  });

  it('fires at the max-wait ceiling even when the idle timer never gets a chance to elapse', async () => {
    const schema = await createSchema('Debounce maxwait');
    const owner = await ownerOf(schema.id);
    stopPendingChecks(); // see the previous test's comment
    const d = deps();
    d.debounceMs = 80;
    d.maxWaitMs = 150;

    // Reschedules every 30ms — faster than the 80ms idle window, so idle
    // alone would never fire. Only the 150ms max-wait ceiling can.
    const interval = setInterval(() => scheduleCheck(d, schema.id, owner), 30);
    scheduleCheck(d, schema.id, owner);

    await sleep(250);
    clearInterval(interval);

    // Proof it fired despite continuous scheduling: a job now exists, which
    // only happens once checkNow has actually run.
    const jobs = await t.db.selectFrom('reason_jobs').selectAll().where('schema_id', '=', schema.id).execute();
    expect(jobs.length).toBeGreaterThanOrEqual(1);

    stopPendingChecks();
  });
});

describe('sweepLoop', () => {
  it('recovers a job whose worker died mid-run (stuck past its tier timeout)', async () => {
    const schema = await createSchema();
    const owner = await ownerOf(schema.id);
    await enqueue(t.db, { schemaId: schema.id, requestedBy: owner, cacheKey: 'fixture-key' });
    // Simulate a worker that claimed it and then vanished.
    await t.db.updateTable('reason_jobs')
      .set({ state: 'running', started_at: new Date(Date.now() - TIERS.free.timeoutMs - 5_000) })
      .where('schema_id', '=', schema.id)
      .execute();

    const result = await sweepLoop({ db: t.db, jobMaxAttempts: 3, staleAfterMs: 24 * 60 * 60 * 1000 });
    expect(result.requeuedJobs).toBe(1);
    expect(result.failedJobs).toBe(0);

    const job = await t.db.selectFrom('reason_jobs').selectAll().where('schema_id', '=', schema.id).executeTakeFirstOrThrow();
    expect(job.state).toBe('queued');
    expect(job.attempts).toBe(1);
  });

  it('re-checks a schema left stale past staleAfterMs, using its owner as the requester', async () => {
    const schema = await createSchema();
    // Backdate modified_at so it looks like it has sat stale for a while —
    // reason_state is already 'stale' from creation.
    await t.db.updateTable('schemas')
      .set({ modified_at: new Date(Date.now() - 10 * 60 * 1000) })
      .where('id', '=', schema.id)
      .execute();

    const result = await sweepLoop({ db: t.db, jobMaxAttempts: 3, staleAfterMs: 2 * 60 * 1000 });
    expect(result.staleSchemasRechecked).toBe(1);

    // A cache-miss check enqueues a job — proof the recheck actually ran.
    const jobs = await t.db.selectFrom('reason_jobs').selectAll().where('schema_id', '=', schema.id).execute();
    expect(jobs).toHaveLength(1);
  });

  it('does not touch a stale schema that has not aged past staleAfterMs', async () => {
    const schema = await createSchema();

    const result = await sweepLoop({ db: t.db, jobMaxAttempts: 3, staleAfterMs: 24 * 60 * 60 * 1000 });
    expect(result.staleSchemasRechecked).toBe(0);
  });
});
