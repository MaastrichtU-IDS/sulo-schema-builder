// Per-tier quota defaults (spec §6, "Quotas and fair scheduling"). The three
// tiers and their six fields are fixed in code (modules/quota/tiers.ts); the
// *numbers* below are env-overridable so a live deployment can widen or
// tighten a tier without a redeploy, exactly like reasoner.ts's knobs.

import { optional } from './env.js';

function int(name: string, fallback: number): number {
  return parseInt(optional(name, String(fallback)), 10);
}

export const quotaConfig = {
  free: {
    runsPerHour: int('QUOTA_FREE_RUNS_PER_HOUR', 20),
    maxConcurrent: int('QUOTA_FREE_MAX_CONCURRENT', 1),
    maxOwlBytes: int('QUOTA_FREE_MAX_OWL_BYTES', 1_000_000),
    timeoutMs: int('QUOTA_FREE_TIMEOUT_MS', 60_000),
    maxSchemas: int('QUOTA_FREE_MAX_SCHEMAS', 20),
    upperFetchPerHour: int('QUOTA_FREE_UPPER_FETCH_PER_HOUR', 30),
  },
  verified: {
    runsPerHour: int('QUOTA_VERIFIED_RUNS_PER_HOUR', 100),
    maxConcurrent: int('QUOTA_VERIFIED_MAX_CONCURRENT', 2),
    maxOwlBytes: int('QUOTA_VERIFIED_MAX_OWL_BYTES', 3_000_000),
    timeoutMs: int('QUOTA_VERIFIED_TIMEOUT_MS', 120_000),
    maxSchemas: int('QUOTA_VERIFIED_MAX_SCHEMAS', 200),
    upperFetchPerHour: int('QUOTA_VERIFIED_UPPER_FETCH_PER_HOUR', 120),
  },
  staff: {
    runsPerHour: int('QUOTA_STAFF_RUNS_PER_HOUR', 1000),
    maxConcurrent: int('QUOTA_STAFF_MAX_CONCURRENT', 4),
    maxOwlBytes: int('QUOTA_STAFF_MAX_OWL_BYTES', 5_000_000),
    timeoutMs: int('QUOTA_STAFF_TIMEOUT_MS', 300_000),
    maxSchemas: int('QUOTA_STAFF_MAX_SCHEMAS', 2000),
    upperFetchPerHour: int('QUOTA_STAFF_UPPER_FETCH_PER_HOUR', 600),
  },
} as const;
