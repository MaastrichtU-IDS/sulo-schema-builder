// The sharing surface: who holds a grant on a schema, and the email lookup
// that turns an address a human already knows into a grantee. Mirrors
// api/src/modules/acl/grants.routes.ts — read the header of that file before
// changing the shapes or the error handling below; the constraints described
// there (exact-match lookup, no address echoed back, its own rate limit) are
// why the lookup answers with an outcome type instead of a raw response.

import axios from 'axios';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client.js';

export type GrantRole = 'viewer' | 'editor' | 'owner';

/** A grant as the API reports it — see grants.repo.ts#GrantWithGrantee. */
export interface Grant {
  userId: string;
  /**
   * From users.display_name. Null whenever the identity provider never set
   * one — the lookup endpoint deliberately never falls back to the email
   * (see lookupUserByEmail below), so this list must not either, or it would
   * leak the very address that refusal is protecting.
   */
  displayName: string | null;
  role: GrantRole;
  grantedAt: string;
}

export async function fetchGrants(schemaId: string): Promise<Grant[]> {
  return apiClient.get(`/ontology-schemas/${schemaId}/grants`).then((r) => r.data);
}

export async function putGrant(schemaId: string, userId: string, role: GrantRole): Promise<Grant> {
  return apiClient.put(`/ontology-schemas/${schemaId}/grants/${userId}`, { role }).then((r) => r.data);
}

export async function revokeGrant(schemaId: string, userId: string): Promise<void> {
  await apiClient.delete(`/ontology-schemas/${schemaId}/grants/${userId}`);
}

export async function transferSchema(schemaId: string, userId: string): Promise<void> {
  await apiClient.post(`/ontology-schemas/${schemaId}/transfer`, { userId });
}

export interface LookedUpUser {
  id: string;
  displayName: string | null;
}

/**
 * A human-readable outcome for GET /users/lookup, rather than a raw HTTP
 * status the caller has to decode. `not_found` is deliberately not phrased
 * as an error: accounts are created on first sign-in (see
 * api/src/modules/users/service.ts), so the common reason for this outcome
 * is "that person has never logged in here yet", not a typo.
 */
export type LookupOutcome =
  | { kind: 'found'; user: LookedUpUser }
  | { kind: 'not_found' }
  | { kind: 'rate_limited' }
  /** 409 — the address is not unique. Server message already omits the address. */
  | { kind: 'ambiguous'; message: string }
  | { kind: 'error'; message: string };

export async function lookupUserByEmail(email: string): Promise<LookupOutcome> {
  try {
    const { data } = await apiClient.get<LookedUpUser>('/users/lookup', { params: { email } });
    return { kind: 'found', user: data };
  } catch (err) {
    if (!axios.isAxiosError(err)) {
      return { kind: 'error', message: 'Could not reach the server to look that up. Check your connection and try again.' };
    }
    const status = err.response?.status;
    if (status === 404) return { kind: 'not_found' };
    if (status === 429) return { kind: 'rate_limited' };
    if (status === 409) {
      return {
        kind: 'ambiguous',
        message: err.response?.data?.message ?? 'More than one account uses that address. Ask an administrator to resolve it.',
      };
    }
    return { kind: 'error', message: 'Could not reach the server to look that up. Check your connection and try again.' };
  }
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

const grantsKey = (schemaId: string) => ['schema-grants', schemaId];

/**
 * GET .../grants is guarded at `own` (grants.routes.ts), so this query's
 * outcome doubles as the frontend's only signal for "am I the owner": a 200
 * is proof, a 403 is proof of its absence. `retry: false` because that 403
 * is not transient — retrying would only delay the read-only answer.
 */
export function useGrants(schemaId: string) {
  return useQuery<Grant[]>({
    queryKey: grantsKey(schemaId),
    queryFn: () => fetchGrants(schemaId),
    enabled: !!schemaId,
    retry: false,
  });
}

export function useUpsertGrant(schemaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: GrantRole }) => putGrant(schemaId, userId, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: grantsKey(schemaId) }),
  });
}

export function useRevokeGrant(schemaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => revokeGrant(schemaId, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: grantsKey(schemaId) }),
  });
}

export function useTransferSchema(schemaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => transferSchema(schemaId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: grantsKey(schemaId) });
      qc.invalidateQueries({ queryKey: ['ontology-schema', schemaId] });
    },
  });
}

/** A mutation rather than a query: the lookup is triggered by a form submit, not rendered on mount. */
export function useLookupUser() {
  return useMutation({ mutationFn: (email: string) => lookupUserByEmail(email) });
}
