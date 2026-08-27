// Content-addressed cache for reasoning verdicts (spec §3): a report is keyed
// by everything that could change what "consistent" means for a schema — the
// generated OWL (contentHash, modules/reasoning/owl.ts), the SULO copy the
// reasoner actually reasoned against (suloHash, services/sulo.service.ts's
// getSuloDigest), and the ROBOT/HermiT toolchain version
// (config.reasoner.robotVersion). Any one of the three changing must produce
// a different key: serving a report keyed on the other two alone would show
// a stale verdict, which is the specific failure this module exists to
// prevent — a green "consistent" badge computed against an upper ontology,
// or a reasoner version, that has since changed underneath it.
//
// INVARIANT: `import type` only for kysely here. This module will be
// reachable from routes/v1/index.ts once Tasks 5/6 wire it in, which both
// storage modes load, and pkg cannot snapshot kysely's top-level-await
// modules — a value import kills the packaged desktop binary at startup.
// See modules/reasoning/owl.ts for the most recent example of this banner.

import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.js';

export interface CacheKeyInput {
  contentHash: string;
  suloHash: string;
  robotVersion: string;
}

/** sha256(contentHash ‖ suloHash ‖ robotVersion), per spec §3. */
export function cacheKeyFor(input: CacheKeyInput): string {
  return createHash('sha256')
    .update(input.contentHash, 'utf8')
    .update(input.suloHash, 'utf8')
    .update(input.robotVersion, 'utf8')
    .digest('hex');
}

export interface StoredReport {
  cacheKey: string;
  /** Whatever shape the reasoner produced — see services/reasoner.service.ts's ConsistencyReport. */
  report: unknown;
  reasoner: string;
  suloHash: string;
  durationMs: number | null;
  createdAt: Date;
}

/** A cache hit for `cacheKey`, or `undefined` on a miss. */
export async function findReport(db: Kysely<DB>, cacheKey: string): Promise<StoredReport | undefined> {
  const row = await db
    .selectFrom('reasoning_reports')
    .select(['cache_key', 'report', 'reasoner', 'sulo_hash', 'duration_ms', 'created_at'])
    .where('cache_key', '=', cacheKey)
    .executeTakeFirst();
  if (!row) return undefined;

  return {
    cacheKey: row.cache_key,
    // node-postgres parses jsonb columns into JS values on the way out — the
    // same behaviour modules/schemas/service.ts's property_features column
    // relies on — so this is already the object storeReport wrote, not a
    // string needing JSON.parse.
    report: row.report,
    reasoner: row.reasoner,
    suloHash: row.sulo_hash,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

export interface StoreReportInput {
  cacheKey: string;
  report: unknown;
  reasoner: string;
  suloHash: string;
  durationMs: number | null;
}

/**
 * Persists a reasoning verdict under `cacheKey`.
 *
 * `on conflict do nothing` rather than a caught unique-violation: two workers
 * finishing equivalent runs at once both land on the same cache_key — that's
 * the whole point of content-addressing — so the second write is an expected
 * duplicate, not an error to recover from. Whichever row wins is equally
 * valid: cacheKeyFor guarantees both describe the same OWL, the same SULO
 * digest and the same ROBOT version.
 */
export async function storeReport(db: Kysely<DB>, input: StoreReportInput): Promise<void> {
  await db
    .insertInto('reasoning_reports')
    .values({
      cache_key: input.cacheKey,
      report: JSON.stringify(input.report),
      reasoner: input.reasoner,
      sulo_hash: input.suloHash,
      duration_ms: input.durationMs,
    })
    .onConflict((oc) => oc.column('cache_key').doNothing())
    .execute();
}
