// Per-tier resource limits (spec §6, "Quotas and fair scheduling"). The
// shape — three tiers, six fields — lives in code because it changes with a
// deploy, not at runtime; the *numbers* are env-overridable defaults kept in
// config/quota.ts alongside every other config module.
//
// `free` is deliberately the most restrictive tier on every field. That is
// not incidental: limitsFor() below falls back to it for any tier value it
// does not recognise.

import { config } from '../../config/index.js';

export interface TierLimits {
  /** Real (non-cache-hit) reasoning runs allowed per rolling hour. */
  runsPerHour: number;
  /** Simultaneous reasoning runs the tier may hold (the queue's per-user cap). */
  maxConcurrent: number;
  /** Ceiling on the server-generated OWL a reasoning run may submit. */
  maxOwlBytes: number;
  /** Wall-clock budget for a single reasoning run. */
  timeoutMs: number;
  /** Schemas the user may *own* at once. */
  maxSchemas: number;
  /** Upper-ontology proxy fetches allowed per rolling hour. */
  upperFetchPerHour: number;
}

export type QuotaTier = 'free' | 'verified' | 'staff';

export const TIERS: Record<QuotaTier, TierLimits> = config.quota;

/**
 * The tier `limitsFor` falls back to for anything it does not recognise.
 * Exported so a caller (or a test) can assert against the real config rather
 * than a hand-copied literal.
 */
export const FALLBACK_TIER: QuotaTier = 'free';

function isQuotaTier(value: string): value is QuotaTier {
  return value === 'free' || value === 'verified' || value === 'staff';
}

/**
 * Resolves a tier name to its limits, failing closed for anything unknown.
 *
 * Takes a plain `string` rather than `RequestUser['tier']`'s narrower
 * `'free'|'verified'|'staff'` union on purpose. That union is only as
 * trustworthy as the CHECK constraint behind `users.quota_tier`
 * (migrations/001_core.sql); it is unreachable *today*, but a future
 * migration that widens the constraint — adding a tier, or loosening it to
 * free-form text — would silently invalidate the compile-time guarantee while
 * this function keeps running against whatever string the database actually
 * returns. Falling back to the *most restrictive* tier, rather than throwing
 * or defaulting to `staff`, is the fail-closed choice: an unrecognised value
 * must never buy more quota than the safest known tier would.
 */
export function limitsFor(tier: string): TierLimits {
  return isQuotaTier(tier) ? TIERS[tier] : TIERS[FALLBACK_TIER];
}
