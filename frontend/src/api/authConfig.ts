// GET /auth-config — what the SPA needs before it can authenticate.
//
// One SPA build serves every deployment, so it cannot know at compile time
// whether it is talking to the multi-user web API (auth required) or the
// packaged desktop sidecar (no login UI, no bearer tokens). This module asks
// the server, once, and memoises the answer — the same shape the deleted
// appConfig.ts used for the (now-removed) storage-mode discovery.
//
// Only a *successful* answer is memoised. A failure to even ask — a stale
// API restarting, a proxy 502ing this one route — must not be cached: doing
// so used to latch this deployment as permanently unauthenticated ("disabled")
// after one transient hiccup, with no recovery short of a manual reload. This
// rejects instead, so the caller (AuthProvider) can tell "couldn't ask" apart
// from "asked, and it's genuinely off" and retry with backoff rather than
// giving up on the first failure.

import { apiClient } from './client.js';

export interface AuthConfig {
  enabled: boolean;
  issuer?: string;
  clientId?: string;
}

let cached: Promise<AuthConfig> | null = null;

export function getAuthConfig(): Promise<AuthConfig> {
  if (!cached) {
    cached = apiClient
      .get('/auth-config')
      .then((r) => r.data as AuthConfig)
      .catch((err: unknown) => {
        // Don't memoise a failure to ask — see the module comment. Clear the
        // cache before rethrowing so the next call (AuthProvider's retry)
        // gets a fresh attempt instead of replaying this same rejection.
        cached = null;
        throw err;
      });
  }
  return cached;
}

/** Test seam — forces the next call to re-fetch rather than reuse the cache. */
export function resetAuthConfigForTests(): void {
  cached = null;
}
