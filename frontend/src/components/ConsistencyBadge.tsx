// The server-side consistency verdict, shown wherever a schema is open.
//
// This badge has more states than it first looks like it needs: never
// checked, queued, running, fresh-and-consistent, fresh-with-clashes,
// failed, and stale-because-quota-exhausted (distinct from a generic
// "pending" — it has to say when the caller may try again). All of the
// fetching and polling lives in ../api/report.ts, which plan 5 swaps for
// server-sent events; this component only ever calls its two hooks.
//
// The API does not yet tell a client its own access level on a schema (see
// plan 3 follow-up #5, still open), so this component cannot know for
// certain whether the caller holds `edit`. It does the one honest thing it
// can prove: hides the refresh control for an `anonymous` caller (who never
// holds `edit`), shows it for everyone else, and turns a 403 on the actual
// attempt into a plain-language message instead of a raw error.

import { useEffect, useState } from 'react';
import { useSchemaReport, useRefreshReport, type ConsistencyReport } from '../api/report.js';
import type { AuthStatus } from '../auth/AuthProvider.js';

function formatRetryAfter(seconds: number): string {
  if (seconds <= 0) return 'a moment';
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function ClashList({ report }: { report: ConsistencyReport }) {
  if (report.consistent) {
    return (
      <div className="flex items-start gap-2">
        <span className="text-emerald-600 text-lg leading-none">✓</span>
        <div>
          <p className="text-sm font-medium text-emerald-800">Consistent</p>
          <p className="text-xs text-emerald-700 mt-0.5">
            {report.reasoner} found no unsatisfiable classes and no logical inconsistency.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-rose-700">
        {report.clashes.length} {report.clashes.length === 1 ? 'problem' : 'problems'} found by {report.reasoner}
      </p>
      {report.clashes.map((clash, i) => (
        <div key={i} className="rounded-lg bg-rose-50 border border-rose-200 p-2">
          <p className="text-xs font-mono font-medium text-rose-800">
            {clash.label ?? clash.iri ?? (clash.kind === 'inconsistent-ontology' ? 'Inconsistent ontology' : 'Unsatisfiable class')}
          </p>
          <p className="text-xs text-rose-700 mt-1 whitespace-pre-wrap">{clash.explanation}</p>
        </div>
      ))}
    </div>
  );
}

export default function ConsistencyBadge({ schemaId, authStatus }: { schemaId: string; authStatus: AuthStatus }) {
  const reportQuery = useSchemaReport(schemaId);
  const refresh = useRefreshReport(schemaId);

  // These describe the outcome of the caller's *own last click*, not the
  // server's state — they are cleared as soon as that state visibly moves
  // on (see the effect below), so a stale message never outlives the
  // situation it described.
  const [quotaWaitCopy, setQuotaWaitCopy] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);

  const data = reportQuery.data;

  useEffect(() => {
    if (data && data.state !== 'stale') {
      setQuotaWaitCopy(null);
      setForbidden(false);
      setRefreshFailed(false);
    }
  }, [data?.state]);

  function handleRefresh() {
    setQuotaWaitCopy(null);
    setForbidden(false);
    setRefreshFailed(false);
    refresh.mutate(undefined, {
      onSuccess: (outcome) => {
        if (outcome.kind === 'rate_limited') setQuotaWaitCopy(formatRetryAfter(outcome.retryAfter));
        else if (outcome.kind === 'forbidden') setForbidden(true);
        else if (outcome.kind === 'error') setRefreshFailed(true);
      },
    });
  }

  // Anonymous never holds `edit` — that much the client can prove. Anyone
  // else (authenticated, or an auth-disabled deployment where there is no
  // access model to speak of) gets the control; a genuine lack of `edit`
  // surfaces as the `forbidden` message above once they actually try.
  const mayAttemptRefresh = authStatus === 'authenticated' || authStatus === 'disabled';

  function body() {
    if (quotaWaitCopy) {
      return (
        <p className="text-sm text-amber-700">
          You&rsquo;ve reached your hourly limit for consistency checks. Try again in {quotaWaitCopy}.
        </p>
      );
    }
    if (forbidden) {
      return (
        <p className="text-sm text-rose-600">
          You don&rsquo;t have permission to run a consistency check on this schema.
        </p>
      );
    }
    if (refreshFailed) {
      return <p className="text-sm text-red-500">Could not start a consistency check. Try again.</p>;
    }
    if (reportQuery.isLoading) {
      return <p className="text-sm text-slate-400">Checking status…</p>;
    }
    if (reportQuery.isError || !data) {
      return <p className="text-sm text-red-500">Could not load the consistency verdict for this schema.</p>;
    }

    switch (data.state) {
      case 'queued':
        return <p className="text-sm text-slate-500">Queued for a consistency check…</p>;
      case 'running':
        return <p className="text-sm text-slate-500">Checking consistency…</p>;
      case 'failed':
        return <p className="text-sm text-rose-600">The last consistency check failed. Try again.</p>;
      case 'fresh':
        return data.report ? <ClashList report={data.report} /> : (
          <p className="text-sm text-slate-400">This schema has not yet been checked for consistency.</p>
        );
      case 'stale':
      default:
        if (data.report) {
          // A verdict exists, but the schema changed since it was
          // computed — show it rather than nothing, flagged as possibly
          // out of date, so the caller has something to act on while a
          // fresh check is pending or not yet requested.
          return (
            <div className="space-y-1.5">
              <p className="text-xs text-amber-600">
                This verdict may be out of date — the schema has changed since it was computed.
              </p>
              <ClashList report={data.report} />
            </div>
          );
        }
        return (
          <p className="text-sm text-slate-400">This schema has not yet been checked for consistency.</p>
        );
    }
  }

  const isBusy = data?.state === 'queued' || data?.state === 'running' || refresh.isPending;
  const buttonLabel = data?.computedAt ? 'Refresh' : 'Check consistency';

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">{body()}</div>
        {mayAttemptRefresh && (
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isBusy}
            className="text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-3 py-1 rounded-lg transition-colors shrink-0"
          >
            {isBusy ? 'Checking…' : buttonLabel}
          </button>
        )}
      </div>
    </div>
  );
}
