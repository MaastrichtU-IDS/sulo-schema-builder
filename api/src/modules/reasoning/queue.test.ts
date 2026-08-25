// The durable queue is where spec §6's fair scheduling actually lives: this
// suite proves the database — not application code — enforces one pending
// job per schema, race-free claiming under real concurrency, and per-tier
// caps that let a `staff` user through a queue a `free` user is capped out
// of. See modules/quota/service.test.ts for why fixture users go through the
// token path rather than a direct insert.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyPluginAsync } from 'fastify';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import { buildAuthedApp, type AuthedTestApp } from '../../test/authApp.js';
import { TIERS } from '../quota/tiers.js';
import { claimNext, enqueue, finish, sweepStuck } from './queue.repo.js';

const whoami: FastifyPluginAsync = async (fastify) => {
  fastify.get('/whoami', async (request) => ({ user: request.user }));
};

const SUBJECTS = {
  alice: 'kc-queue-alice',
  bob: 'kc-queue-bob',
  staffer: 'kc-queue-staffer',
} as const;

let t: TestDb;
let harness: AuthedTestApp;
const userIds = {} as Record<keyof typeof SUBJECTS, string>;

beforeAll(async () => {
  t = await startTestDb();
  harness = await buildAuthedApp(t.db, { routes: whoami, prefix: '', userCacheTtlMs: 0 });

  for (const [who, subject] of Object.entries(SUBJECTS) as [keyof typeof SUBJECTS, string][]) {
    const token = await harness.issuer.sign({ sub: subject }, { expiresIn: '2h' });
    const res = await harness.app.inject({ method: 'GET', url: '/whoami', headers: harness.bearer(token) });
    expect(res.statusCode, `first sight of ${who}`).toBe(200);
    userIds[who] = res.json().user.id as string;
  }

  await t.db.updateTable('users').set({ quota_tier: 'staff' })
    .where('subject', '=', SUBJECTS.staffer).execute();
});

afterAll(async () => {
  await harness.close();
  await t.stop();
});

beforeEach(async () => { await truncateAll(t.db); });

/** One schema row per call — reason_jobs.schema_id is a real FK. */
async function insertSchema(ownerId: string): Promise<string> {
  const row = await t.db.insertInto('schemas').values({
    owner_id: ownerId, title: 'queue-fixture', description: null,
    upper_ontology_iri: null, base_uri: null,
  }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

async function insertRunningJob(opts: {
  schemaId: string; requestedBy: string; startedAt: Date; attempts?: number;
}): Promise<number> {
  const row = await t.db.insertInto('reason_jobs').values({
    schema_id: opts.schemaId,
    requested_by: opts.requestedBy,
    cache_key: 'fixture-cache-key',
    state: 'running',
    started_at: opts.startedAt,
    attempts: opts.attempts ?? 0,
  }).returning('id').executeTakeFirstOrThrow();
  return Number(row.id);
}

describe('enqueue', () => {
  it('yields "already-pending" the second time for the same schema, leaving exactly one row', async () => {
    const schemaId = await insertSchema(userIds.alice);
    const first = await enqueue(t.db, { schemaId, requestedBy: userIds.alice, cacheKey: 'k1' });
    const second = await enqueue(t.db, { schemaId, requestedBy: userIds.alice, cacheKey: 'k2' });

    expect(first).toBe('queued');
    expect(second).toBe('already-pending');

    const rows = await t.db.selectFrom('reason_jobs').selectAll().where('schema_id', '=', schemaId).execute();
    expect(rows).toHaveLength(1);
    // The first insert's cache_key stands — the conflict did nothing, it did
    // not update the row to the second call's key.
    expect(rows[0].cache_key).toBe('k1');
  });

  it('allows enqueueing again once the prior job reached a terminal state', async () => {
    const schemaId = await insertSchema(userIds.alice);
    await enqueue(t.db, { schemaId, requestedBy: userIds.alice, cacheKey: 'k1' });
    const claimed = await claimNext(t.db);
    await finish(t.db, claimed!.id, { status: 'done' });

    const result = await enqueue(t.db, { schemaId, requestedBy: userIds.alice, cacheKey: 'k2' });
    expect(result).toBe('queued');
  });
});

describe('claimNext', () => {
  it('marks the claimed job running and sets started_at', async () => {
    const schemaId = await insertSchema(userIds.alice);
    await enqueue(t.db, { schemaId, requestedBy: userIds.alice, cacheKey: 'k1' });

    const claimed = await claimNext(t.db);
    expect(claimed?.schemaId).toBe(schemaId);
    expect(claimed?.startedAt).toBeInstanceOf(Date);

    const row = await t.db.selectFrom('reason_jobs').selectAll()
      .where('id', '=', claimed!.id).executeTakeFirstOrThrow();
    expect(row.state).toBe('running');
    expect(row.started_at).not.toBeNull();
  });

  it('returns undefined when nothing is queued', async () => {
    expect(await claimNext(t.db)).toBeUndefined();
  });

  it('never lets two concurrent callers claim the same job', async () => {
    const schemaA = await insertSchema(userIds.alice);
    const schemaB = await insertSchema(userIds.bob);
    await enqueue(t.db, { schemaId: schemaA, requestedBy: userIds.alice, cacheKey: 'ka' });
    await enqueue(t.db, { schemaId: schemaB, requestedBy: userIds.bob, cacheKey: 'kb' });

    const [first, second] = await Promise.all([claimNext(t.db), claimNext(t.db)]);
    const ids = [first?.id, second?.id].filter((id): id is number => id !== undefined);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('fairness: a worker already running one user\'s job claims a DIFFERENT user\'s next, not that user\'s second', async () => {
    // Alice: 5 queued jobs, each on its own schema (one-active-per-schema is
    // per SCHEMA, not per user). Bob: 1 queued job, enqueued after Alice's.
    const aliceSchemas: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const schemaId = await insertSchema(userIds.alice);
      aliceSchemas.push(schemaId);
      await enqueue(t.db, { schemaId, requestedBy: userIds.alice, cacheKey: `alice-${i}` });
    }
    const bobSchema = await insertSchema(userIds.bob);
    await enqueue(t.db, { schemaId: bobSchema, requestedBy: userIds.bob, cacheKey: 'bob-0' });

    // First claim: nobody has anything running yet, so the oldest enqueued
    // job wins — Alice's first.
    const claim1 = await claimNext(t.db);
    expect(claim1?.schemaId).toBe(aliceSchemas[0]);

    // Second claim: Alice now holds one RUNNING job — at free tier's
    // maxConcurrent (1) — so every one of her remaining 4 queued jobs is
    // ineligible. Bob's is the only eligible job left, despite being enqueued
    // after four of Alice's.
    const claim2 = await claimNext(t.db);
    expect(claim2?.schemaId).toBe(bobSchema);
  });

  it('skips a user at their tier maxConcurrent, and they become claimable again once a job finishes', async () => {
    expect(TIERS.free.maxConcurrent).toBe(1);
    const schema1 = await insertSchema(userIds.alice);
    const schema2 = await insertSchema(userIds.alice);
    await enqueue(t.db, { schemaId: schema1, requestedBy: userIds.alice, cacheKey: 'a1' });
    await enqueue(t.db, { schemaId: schema2, requestedBy: userIds.alice, cacheKey: 'a2' });

    const first = await claimNext(t.db);
    expect(first?.schemaId).toBe(schema1);

    // Alice is now at her cap (1 running) with one more queued — ineligible.
    expect(await claimNext(t.db)).toBeUndefined();

    await finish(t.db, first!.id, { status: 'done' });

    const second = await claimNext(t.db);
    expect(second?.schemaId).toBe(schema2);
  });

  it('lets a staff user through a queue where a free user at the same point is capped out', async () => {
    const freeSchema1 = await insertSchema(userIds.alice);
    const freeSchema2 = await insertSchema(userIds.alice);
    const staffSchema = await insertSchema(userIds.staffer);
    await enqueue(t.db, { schemaId: freeSchema1, requestedBy: userIds.alice, cacheKey: 'f1' });
    await enqueue(t.db, { schemaId: freeSchema2, requestedBy: userIds.alice, cacheKey: 'f2' });
    await enqueue(t.db, { schemaId: staffSchema, requestedBy: userIds.staffer, cacheKey: 's1' });

    const first = await claimNext(t.db);
    expect(first?.schemaId).toBe(freeSchema1);

    // Alice (free, maxConcurrent 1) is now capped; the staffer is not.
    const second = await claimNext(t.db);
    expect(second?.schemaId).toBe(staffSchema);
  });
});

describe('finish', () => {
  it('leaves a terminal state that claimNext will never return again, for both outcomes', async () => {
    const schemaA = await insertSchema(userIds.alice);
    const schemaB = await insertSchema(userIds.bob);
    await enqueue(t.db, { schemaId: schemaA, requestedBy: userIds.alice, cacheKey: 'ka' });
    await enqueue(t.db, { schemaId: schemaB, requestedBy: userIds.bob, cacheKey: 'kb' });

    const jobA = await claimNext(t.db);
    const jobB = await claimNext(t.db);
    await finish(t.db, jobA!.id, { status: 'done' });
    await finish(t.db, jobB!.id, { status: 'failed', error: 'boom' });

    expect(await claimNext(t.db)).toBeUndefined();

    const rowA = await t.db.selectFrom('reason_jobs').selectAll().where('id', '=', jobA!.id).executeTakeFirstOrThrow();
    const rowB = await t.db.selectFrom('reason_jobs').selectAll().where('id', '=', jobB!.id).executeTakeFirstOrThrow();
    expect(rowA.state).toBe('done');
    expect(rowA.finished_at).not.toBeNull();
    expect(rowB.state).toBe('failed');
    expect(rowB.error).toBe('boom');
  });
});

describe('sweepStuck', () => {
  it('requeues a running job past its timeout, incrementing attempts', async () => {
    const schemaId = await insertSchema(userIds.alice);
    const staleStart = new Date(Date.now() - TIERS.free.timeoutMs - 5_000);
    const jobId = await insertRunningJob({ schemaId, requestedBy: userIds.alice, startedAt: staleStart });

    const result = await sweepStuck(t.db, { maxAttempts: 3 });
    expect(result).toEqual({ requeued: 1, failedOut: 0 });

    const row = await t.db.selectFrom('reason_jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(row.state).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.started_at).toBeNull();
  });

  it('marks a job failed once maxAttempts would be reached, rather than requeueing forever', async () => {
    const schemaId = await insertSchema(userIds.alice);
    const staleStart = new Date(Date.now() - TIERS.free.timeoutMs - 5_000);
    const jobId = await insertRunningJob({ schemaId, requestedBy: userIds.alice, startedAt: staleStart, attempts: 2 });

    const result = await sweepStuck(t.db, { maxAttempts: 3 });
    expect(result).toEqual({ requeued: 0, failedOut: 1 });

    const row = await t.db.selectFrom('reason_jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(row.state).toBe('failed');
    expect(row.attempts).toBe(3);
    expect(row.finished_at).not.toBeNull();
  });

  it('does not touch a running job still inside its timeout', async () => {
    const schemaId = await insertSchema(userIds.alice);
    const recentStart = new Date(Date.now() - 1_000);
    const jobId = await insertRunningJob({ schemaId, requestedBy: userIds.alice, startedAt: recentStart });

    const result = await sweepStuck(t.db, { maxAttempts: 3 });
    expect(result).toEqual({ requeued: 0, failedOut: 0 });

    const row = await t.db.selectFrom('reason_jobs').selectAll().where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(row.state).toBe('running');
  });

  it('sweeps a free user\'s job at the same age a staff user\'s job survives, per-tier timeouts', async () => {
    expect(TIERS.staff.timeoutMs).toBeGreaterThan(TIERS.free.timeoutMs);
    const sameAge = new Date(Date.now() - TIERS.free.timeoutMs - 5_000);

    const freeSchema = await insertSchema(userIds.alice);
    const staffSchema = await insertSchema(userIds.staffer);
    const freeJobId = await insertRunningJob({ schemaId: freeSchema, requestedBy: userIds.alice, startedAt: sameAge });
    const staffJobId = await insertRunningJob({ schemaId: staffSchema, requestedBy: userIds.staffer, startedAt: sameAge });

    const result = await sweepStuck(t.db, { maxAttempts: 3 });
    expect(result).toEqual({ requeued: 1, failedOut: 0 });

    const freeRow = await t.db.selectFrom('reason_jobs').selectAll().where('id', '=', freeJobId).executeTakeFirstOrThrow();
    const staffRow = await t.db.selectFrom('reason_jobs').selectAll().where('id', '=', staffJobId).executeTakeFirstOrThrow();
    expect(freeRow.state).toBe('queued');
    expect(staffRow.state).toBe('running');
  });
});
