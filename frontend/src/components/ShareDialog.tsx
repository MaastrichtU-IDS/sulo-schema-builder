// The sharing UI: current visibility (owner only may change it), the list of
// grantees and their roles, a form that resolves an email to a grant, revoke,
// and ownership transfer.
//
// This component has no independent way to know "am I the owner" — no read
// route echoes the caller's access level (see mappers.ts#schemaRowToSummary,
// which deliberately omits owner_id). So it is derived from the one request
// that already answers the question: GET .../grants is guarded at `own`
// (api/src/modules/acl/grants.routes.ts), so a 200 IS proof of ownership and
// a 403 IS proof of its absence. That is why a viewer and an editor render
// identically here — both get the same 403 and the same read-only dialog —
// not because the two roles are indistinguishable in general, but because
// this is the one request where the server does not distinguish them either.
//
// Hiding the visibility control and the grant form from a non-owner is a UI
// nicety, not the enforcement point: the server still refuses the write at
// `own` (assertMayChangeVisibility, routes.ts) regardless of what this
// component renders.

import { useState, type FormEvent } from 'react';
import axios from 'axios';
import {
  useGrants, useUpsertGrant, useRevokeGrant, useTransferSchema, useLookupUser,
  type GrantRole, type LookupOutcome,
} from '../api/grants.js';
import { useUpdateOntologySchema, type OntologySchema } from '../api/ontology.js';

const VISIBILITY_OPTIONS = ['private', 'unlisted', 'public'] as const;
type Visibility = (typeof VISIBILITY_OPTIONS)[number];

const ROLE_OPTIONS: readonly GrantRole[] = ['viewer', 'editor', 'owner'];
const ROLE_LABELS: Record<GrantRole, string> = { viewer: 'Viewer', editor: 'Editor', owner: 'Owner' };

/**
 * users.display_name can be null — the identity provider does not always
 * set one, and GET /users/lookup deliberately never falls back to the email
 * (see grants.ts#lookupUserByEmail): echoing the address here, in a list
 * shown to whoever holds `own`, would undo exactly the refusal that keeps
 * the lookup from being an email-harvesting tool. So this is a placeholder
 * that is honest about what's missing — not a fabricated name, and not the
 * address — used consistently everywhere a grantee's name would otherwise go.
 */
const NO_DISPLAY_NAME = 'Unnamed account';

/**
 * A human-readable outcome for the email lookup, in place of a raw status
 * code. A 404 reads as "no account", which is the common and unremarkable
 * case — accounts are created on first sign-in — not a scary error; a 429
 * reads as "slow down", a distinct, actionable message rather than the same
 * generic failure a network error would show.
 */
function lookupOutcomeMessage(outcome: Exclude<LookupOutcome, { kind: 'found' }>): string {
  switch (outcome.kind) {
    case 'not_found':
      return 'No account with that address. Accounts are created the first time someone signs in, so this address may simply never have logged in yet.';
    case 'rate_limited':
      return 'Too many lookups in a short time — wait a minute and try again.';
    case 'ambiguous':
      return outcome.message;
    case 'error':
      return outcome.message;
  }
}

export default function ShareDialog({ schema, onClose }: { schema: OntologySchema; onClose: () => void }) {
  const grantsQuery = useGrants(schema.id);
  const upsertGrant = useUpsertGrant(schema.id);
  const revokeGrant = useRevokeGrant(schema.id);
  const transferSchema = useTransferSchema(schema.id);
  const lookupUser = useLookupUser();
  const updateVisibility = useUpdateOntologySchema(schema.id);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<GrantRole>('viewer');
  const [addError, setAddError] = useState<string | null>(null);
  const [transferEmail, setTransferEmail] = useState('');
  const [transferError, setTransferError] = useState<string | null>(null);

  const isForbidden = grantsQuery.isError
    && axios.isAxiosError(grantsQuery.error)
    && grantsQuery.error.response?.status === 403;
  // The only state this component can prove is "owner" (see the header) — a
  // 403, a genuine failure, or still loading all render read-only rather
  // than guessing.
  const canManage = grantsQuery.isSuccess;

  async function handleAddGrant(e: FormEvent) {
    e.preventDefault();
    setAddError(null);
    const outcome = await lookupUser.mutateAsync(email.trim());
    if (outcome.kind !== 'found') {
      setAddError(lookupOutcomeMessage(outcome));
      return;
    }
    try {
      await upsertGrant.mutateAsync({ userId: outcome.user.id, role });
      setEmail('');
      setRole('viewer');
    } catch {
      setAddError('Could not add that grant. Try again.');
    }
  }

  async function handleTransfer(e: FormEvent) {
    e.preventDefault();
    setTransferError(null);
    const outcome = await lookupUser.mutateAsync(transferEmail.trim());
    if (outcome.kind !== 'found') {
      setTransferError(lookupOutcomeMessage(outcome));
      return;
    }
    const label = outcome.user.displayName ?? NO_DISPLAY_NAME;
    if (!window.confirm(`Give ownership of "${schema.title}" to ${label}? You will keep an owner-level grant, so this is not a lockout.`)) {
      return;
    }
    try {
      await transferSchema.mutateAsync(outcome.user.id);
      setTransferEmail('');
    } catch {
      setTransferError('Could not transfer ownership. Try again.');
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 space-y-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="font-semibold text-slate-800 text-lg">Manage access to “{schema.title}”</h2>
        </div>

        {/* Visibility */}
        <div className="space-y-1">
          <label htmlFor="share-visibility" className="block text-sm font-medium text-slate-700">
            Visibility
          </label>
          {canManage ? (
            <select
              id="share-visibility"
              value={schema.visibility ?? 'private'}
              onChange={(e) => updateVisibility.mutate({ visibility: e.target.value as Visibility })}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 bg-white"
            >
              {VISIBILITY_OPTIONS.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          ) : (
            <div className="text-sm text-slate-600">{schema.visibility ?? 'private'}</div>
          )}
          {updateVisibility.isError && (
            <p className="text-xs text-red-500">Could not change visibility. Try again.</p>
          )}
        </div>

        {/* Grantees */}
        <div className="space-y-2">
          <div className="text-sm font-medium text-slate-700">People with access</div>
          {grantsQuery.isLoading && <div className="text-sm text-slate-400">Loading…</div>}
          {isForbidden && (
            <div className="text-sm text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
              Only the schema owner can manage sharing for this schema.
            </div>
          )}
          {grantsQuery.isError && !isForbidden && (
            <div className="text-sm text-red-500">Could not load the sharing settings for this schema.</div>
          )}
          {grantsQuery.isSuccess && grantsQuery.data.length === 0 && (
            <div className="text-sm text-slate-400">No one else has been granted access yet.</div>
          )}
          {grantsQuery.isSuccess && grantsQuery.data.length > 0 && (
            <ul className="space-y-1">
              {grantsQuery.data.map((grant) => (
                <li
                  key={grant.userId}
                  className="flex items-center justify-between gap-3 text-sm border border-slate-200 rounded-lg px-3 py-2"
                >
                  <span className="text-slate-700">
                    {grant.displayName ?? NO_DISPLAY_NAME}
                    <span className="text-slate-400"> · {ROLE_LABELS[grant.role]}</span>
                  </span>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => {
                        const label = grant.displayName ?? NO_DISPLAY_NAME;
                        if (window.confirm(`Remove access for ${label}?`)) revokeGrant.mutate(grant.userId);
                      }}
                      className="text-slate-400 hover:text-red-500 text-xs shrink-0"
                    >
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Add a grant */}
        {canManage && (
          <form onSubmit={handleAddGrant} className="space-y-2 border-t border-slate-100 pt-4">
            <div className="text-sm font-medium text-slate-700">Add someone</div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label htmlFor="share-add-email" className="sr-only">Email</label>
                <input
                  id="share-add-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="colleague@example.org"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                />
              </div>
              <select
                aria-label="Role"
                value={role}
                onChange={(e) => setRole(e.target.value as GrantRole)}
                className="border border-slate-300 rounded-lg px-2 py-2 text-sm shadow-sm bg-white"
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
              <button
                type="submit"
                disabled={lookupUser.isPending || upsertGrant.isPending}
                className="bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors shrink-0"
              >
                Add
              </button>
            </div>
            {addError && <p className="text-xs text-red-500">{addError}</p>}
          </form>
        )}

        {/* Transfer ownership */}
        {canManage && (
          <form onSubmit={handleTransfer} className="space-y-2 border-t border-slate-100 pt-4">
            <div className="text-sm font-medium text-slate-700">Transfer ownership</div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label htmlFor="share-transfer-email" className="sr-only">New owner&rsquo;s email</label>
                <input
                  id="share-transfer-email"
                  type="email"
                  required
                  value={transferEmail}
                  onChange={(e) => setTransferEmail(e.target.value)}
                  placeholder="new-owner@example.org"
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                />
              </div>
              <button
                type="submit"
                disabled={lookupUser.isPending || transferSchema.isPending}
                className="bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-700 text-sm font-medium px-4 py-2 rounded-lg transition-colors border border-slate-300 shrink-0"
              >
                Transfer
              </button>
            </div>
            {transferError && <p className="text-xs text-red-500">{transferError}</p>}
            <p className="text-xs text-slate-400">
              You will keep an owner-level grant on this schema, so this is not a lockout.
            </p>
          </form>
        )}

        <div className="flex justify-end">
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-700 px-4 py-1.5">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
