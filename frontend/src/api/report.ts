// The server-side consistency verdict for a schema: fetching the latest
// report and asking for a fresh one. Mirrors the shape the reasoning
// pipeline fixes (see plan 04's report cache and queue) — read that plan's
// contract before changing these types.
//
// Every bit of fetching lives here, not in the component, because plan 5
// swaps this polling for server-sent events: that swap should touch this
// file and nothing else. `ConsistencyBadge.tsx` only ever calls the two
// hooks below.

import axios from 'axios';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client.js';
import type { ConsistencyReport } from '@sulo/schema-core';

export type { ConsistencyReport };

export type ReportState = 'stale' | 'queued' | 'running' | 'fresh' | 'failed';

export interface SchemaReport {
  state: ReportState;
  /** Present once a verdict has ever been computed — absent for a schema that has never been checked. */
  report?: ConsistencyReport;
  cacheKey: string;
  computedAt: string | null;
  stale: boolean;
}

async function fetchReport(schemaId: string): Promise<SchemaReport> {
  return apiClient.get(`/ontology-schemas/${schemaId}/report`).then((r) => r.data);
}

/**
 * How often to poll while a check is in flight (`queued`/`running`).
 * `refetchInterval` below turns itself off the moment the state settles to
 * `fresh`/`failed` — an open tab must not keep hammering this endpoint
 * forever, which is exactly the load the hourly refresh quota
 * (POST .../report/refresh) exists to bound. 4 seconds is fast enough that
 * someone watching the badge sees it move within a handful of polls, and
 * slow enough that a reasoner run lasting tens of seconds costs single-digit
 * requests rather than dozens.
 */
export const REPORT_POLL_INTERVAL_MS = 4000;

const reportKey = (schemaId: string) => ['schema-report', schemaId];

/**
 * Readable by anyone who may read the schema — including an anonymous
 * viewer of a public one (grants.routes.ts's `own`-only pattern does not
 * apply here; the report endpoint is gated at read level). No `retry:
 * false` here: a transient failure fetching the verdict is worth retrying
 * the way any other read is, unlike grants.ts's ownership probe where a 403
 * is itself the answer.
 */
export function useSchemaReport(schemaId: string) {
  return useQuery<SchemaReport>({
    queryKey: reportKey(schemaId),
    queryFn: () => fetchReport(schemaId),
    enabled: !!schemaId,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'queued' || state === 'running' ? REPORT_POLL_INTERVAL_MS : false;
    },
  });
}

/**
 * A human-readable outcome for POST .../report/refresh, mirroring
 * grants.ts#LookupOutcome: a 403 (caller lacks `edit`) and a 429 (over the
 * hourly quota) are both routine, expected responses to react to, not raw
 * errors to decode. `retryAfter` is in seconds, as the refresh endpoint
 * reports it.
 */
export type RefreshOutcome =
  | { kind: 'ok' }
  | { kind: 'forbidden' }
  | { kind: 'rate_limited'; retryAfter: number }
  | { kind: 'error' };

async function refreshReport(schemaId: string): Promise<RefreshOutcome> {
  try {
    await apiClient.post(`/ontology-schemas/${schemaId}/report/refresh`);
    return { kind: 'ok' };
  } catch (err) {
    if (!axios.isAxiosError(err)) return { kind: 'error' };
    const status = err.response?.status;
    if (status === 403) return { kind: 'forbidden' };
    if (status === 429) {
      const retryAfter = Number(err.response?.data?.retryAfter ?? 0);
      return { kind: 'rate_limited', retryAfter };
    }
    return { kind: 'error' };
  }
}

/** A mutation rather than a query: refresh is triggered by a button click, not rendered on mount. */
export function useRefreshReport(schemaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => refreshReport(schemaId),
    onSuccess: (outcome) => {
      // A successful queue-admission means the state is about to change
      // (to `queued`) — refetch now instead of waiting for the next poll so
      // the badge reacts immediately to the caller's own click.
      if (outcome.kind === 'ok') qc.invalidateQueries({ queryKey: reportKey(schemaId) });
    },
  });
}
