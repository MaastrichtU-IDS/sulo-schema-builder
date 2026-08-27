// The quota service is the enforcement point spec §6 describes: cache hits
// are free (automatic reasoning fires on every save, so charging for a hit
// would exhaust a tier in minutes of ordinary editing — that is why it leads
// the case list below), a denial says *when* capacity returns rather than
// just that it is gone, `maxSchemas` counts only what a user owns, and an
// unrecognised tier fails closed rather than open.
//
// Fixture users are built through the token path, never by inserting `users`
// rows directly: test/pg.ts's truncateAll spares that table on purpose, and
// the auth plugin caches subject -> user, so a hand-inserted row would drift
// from the id the plugin resolves (see guards.test.ts and moderation.test.ts
// for the same rule). `schemas`, `schema_grants` and `usage_events` have no
// such cache, so fixtures on those go in directly — including the backdated
// `created_at` the sliding-window case needs, which no route could produce.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyPluginAsync } from 'fastify';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import { buildAuthedApp, type AuthedTestApp } from '../../test/authApp.js';
import { TIERS, limitsFor, FALLBACK_TIER } from './tiers.js';
import { checkQuota, recordUsage, SCHEMA_CREATE, type QuotaUser } from './service.js';

const REASON = 'reason';

// Lets the suite learn the user id/tier the token path minted for a subject,
// exactly as guards.test.ts's /whoami does — without this suite needing any
// of the schema routes, since every schema fixture below is inserted
// directly.
const whoami: FastifyPluginAsync = async (fastify) => {
  fastify.get('/whoami', async (request) => ({ user: request.user }));
};

const SUBJECTS = {
  alice: 'kc-quota-alice',
  staffer: 'kc-quota-staffer',
  owner: 'kc-quota-owner',
  grantee: 'kc-quota-grantee',
} as const;

let t: TestDb;
let harness: AuthedTestApp;
const userIds = {} as Record<keyof typeof SUBJECTS, string>;

beforeAll(async () => {
  t = await startTestDb();
  // userCacheTtlMs: 0 because `staffer` is promoted with a raw UPDATE after
  // its first sight below (mirrors guards.test.ts) — with the default TTL
  // the guard/plugin would keep answering from the pre-promotion snapshot.
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

function quotaUser(who: keyof typeof SUBJECTS, tier: string): QuotaUser {
  return { id: userIds[who], tier };
}

/** Direct insert — usage_events has no auth-cache interaction (see header). */
async function insertEvent(
  userId: string,
  opts: { kind?: string; cacheHit?: boolean; createdAt?: Date },
): Promise<void> {
  await t.db.insertInto('usage_events').values({
    user_id: userId,
    kind: opts.kind ?? REASON,
    schema_id: null,
    cost_ms: 50,
    cache_hit: opts.cacheHit ?? false,
    ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
  }).execute();
}

/** Direct insert — schemas has no auth-cache interaction either. */
async function insertSchemas(ownerId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const row = await t.db.insertInto('schemas').values({
      owner_id: ownerId,
      title: `quota-fixture-${i}`,
      description: null,
      upper_ontology_iri: null,
      base_uri: null,
    }).returning('id').executeTakeFirstOrThrow();
    ids.push(row.id);
  }
  return ids;
}

async function grantAccess(schemaId: string, granteeId: string): Promise<void> {
  await t.db.insertInto('schema_grants').values({
    schema_id: schemaId, grantee_id: granteeId, role: 'viewer', granted_by: null,
  }).execute();
}

describe('limitsFor', () => {
  it('resolves each known tier to its own limits', () => {
    expect(limitsFor('free')).toBe(TIERS.free);
    expect(limitsFor('verified')).toBe(TIERS.verified);
    expect(limitsFor('staff')).toBe(TIERS.staff);
  });

  it('falls back to the most restrictive tier for an unrecognised value', () => {
    expect(limitsFor('not-a-real-tier')).toBe(TIERS[FALLBACK_TIER]);
    expect(limitsFor('')).toBe(TIERS[FALLBACK_TIER]);
  });
});

describe('checkQuota', () => {
  it('allows a fresh user with no usage history', async () => {
    const result = await checkQuota(t.db, quotaUser('alice', 'free'), REASON);
    expect(result).toEqual({ allowed: true });
  });

  // Lead case: this is what makes automatic reasoning on every save
  // survivable. If a cache hit counted, ordinary editing would exhaust a
  // free-tier user's whole hourly budget in minutes.
  it('does not count cache hits toward runsPerHour, however many there are', async () => {
    for (let i = 0; i < TIERS.free.runsPerHour; i += 1) {
      await insertEvent(userIds.alice, { cacheHit: true });
    }
    const result = await checkQuota(t.db, quotaUser('alice', 'free'), REASON);
    expect(result).toEqual({ allowed: true });
  });

  it('exhausts the tier on runsPerHour real runs, denying with a retryAfterSeconds ' +
    'derived from the oldest event in the window', async () => {
    const oldestAge = 10 * 60 * 1000; // 10 minutes ago
    await insertEvent(userIds.alice, { createdAt: new Date(Date.now() - oldestAge) });
    for (let i = 1; i < TIERS.free.runsPerHour; i += 1) {
      await insertEvent(userIds.alice, {});
    }

    const result = await checkQuota(t.db, quotaUser('alice', 'free'), REASON);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('unreachable');

    // Capacity returns one hour after the OLDEST counted event, not a
    // constant: expected ~= 3600s - 600s = 3000s. A few seconds of slack for
    // however long the test itself took to run.
    const expectedSeconds = Math.round((60 * 60 * 1000 - oldestAge) / 1000);
    expect(result.retryAfterSeconds).toBeGreaterThan(expectedSeconds - 5);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(expectedSeconds + 2);
    expect(result.reason).toMatch(/runs-per-hour/i);
  });

  it('derives a DIFFERENT retryAfterSeconds for a different oldest event, proving it is not a constant', async () => {
    const oldestAge = 40 * 60 * 1000; // 40 minutes ago
    await insertEvent(userIds.alice, { createdAt: new Date(Date.now() - oldestAge) });
    for (let i = 1; i < TIERS.free.runsPerHour; i += 1) {
      await insertEvent(userIds.alice, {});
    }

    const result = await checkQuota(t.db, quotaUser('alice', 'free'), REASON);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('unreachable');

    const expectedSeconds = Math.round((60 * 60 * 1000 - oldestAge) / 1000);
    expect(result.retryAfterSeconds).toBeGreaterThan(expectedSeconds - 5);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(expectedSeconds + 2);
  });

  it('slides the window: an event older than an hour does not count', async () => {
    const overAnHourAgo = new Date(Date.now() - 61 * 60 * 1000);
    for (let i = 0; i < TIERS.free.runsPerHour; i += 1) {
      await insertEvent(userIds.alice, { createdAt: overAnHourAgo });
    }

    const result = await checkQuota(t.db, quotaUser('alice', 'free'), REASON);
    expect(result).toEqual({ allowed: true });
  });

  it('lets a staff user through where a free user with the same history is denied', async () => {
    for (let i = 0; i < TIERS.free.runsPerHour; i += 1) {
      await insertEvent(userIds.alice, {});
      await insertEvent(userIds.staffer, {});
    }

    const freeResult = await checkQuota(t.db, quotaUser('alice', 'free'), REASON);
    const staffResult = await checkQuota(t.db, quotaUser('staffer', 'staff'), REASON);

    expect(freeResult.allowed).toBe(false);
    expect(staffResult).toEqual({ allowed: true });
  });

  it('enforces maxSchemas at creation, counting only schemas the user owns', async () => {
    await insertSchemas(userIds.owner, TIERS.free.maxSchemas);

    const ownerResult = await checkQuota(t.db, quotaUser('owner', 'free'), SCHEMA_CREATE);
    expect(ownerResult.allowed).toBe(false);
    if (ownerResult.allowed) throw new Error('unreachable');
    expect(ownerResult.reason).toMatch(/schema limit/i);
  });

  it('does not count schemas shared with a user via a grant against THEIR maxSchemas', async () => {
    const schemaIds = await insertSchemas(userIds.owner, TIERS.free.maxSchemas);
    for (const schemaId of schemaIds) {
      await grantAccess(schemaId, userIds.grantee);
    }

    // The owner is at their limit...
    const ownerResult = await checkQuota(t.db, quotaUser('owner', 'free'), SCHEMA_CREATE);
    expect(ownerResult.allowed).toBe(false);

    // ...but the grantee owns none of those schemas, so they are unaffected.
    const granteeResult = await checkQuota(t.db, quotaUser('grantee', 'free'), SCHEMA_CREATE);
    expect(granteeResult).toEqual({ allowed: true });
  });

  it('fails closed for an unrecognised tier value: falls back to free\'s limits, not staff\'s', async () => {
    // users.quota_tier is CHECK-constrained today, so this value can never
    // actually reach the database — the point is that checkQuota must not
    // trust the type system's 'free'|'verified'|'staff' union if a future
    // migration ever widens that constraint. Recording exactly free's cap of
    // REAL runs and then asking under a bogus tier distinguishes "fell back
    // to free" (denied) from "fell back to permissive" (would still be
    // allowed under staff's 1000/hour).
    for (let i = 0; i < TIERS.free.runsPerHour; i += 1) {
      await insertEvent(userIds.alice, {});
    }

    const result = await checkQuota(t.db, quotaUser('alice', 'not-a-real-tier'), REASON);
    expect(result.allowed).toBe(false);
  });
});

describe('recordUsage', () => {
  it('records a usage event that checkQuota subsequently counts', async () => {
    await recordUsage(t.db, { userId: userIds.alice, kind: REASON, schemaId: null, costMs: 42, cacheHit: false });
    const { rows } = await t.pool.query(
      'select kind, cost_ms, cache_hit from usage_events where user_id = $1', [userIds.alice],
    );
    expect(rows).toEqual([{ kind: REASON, cost_ms: 42, cache_hit: false }]);
  });

  it('swallows a failed write instead of throwing into the caller', async () => {
    // No such user: usage_events.user_id references users(id), so this insert
    // violates the FK — exactly the kind of metering failure recordUsage
    // exists to survive rather than propagate.
    const noSuchUser = '00000000-0000-0000-0000-000000000099';
    await expect(recordUsage(t.db, {
      userId: noSuchUser, kind: REASON, schemaId: null, costMs: 1, cacheHit: false,
    })).resolves.toBeUndefined();

    const { rows } = await t.pool.query('select 1 from usage_events where user_id = $1', [noSuchUser]);
    expect(rows).toHaveLength(0);
  });
});
