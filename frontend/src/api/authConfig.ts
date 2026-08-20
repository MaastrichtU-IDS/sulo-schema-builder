// GET /auth-config — what the SPA needs before it can authenticate.
//
// One SPA build serves every deployment, so it cannot know at compile time
// whether it is talking to the multi-user web API (auth required) or the
// packaged desktop sidecar (no login UI, no bearer tokens). This module asks
// the server, once, and memoises the answer — the same shape the deleted
// appConfig.ts used for the (now-removed) storage-mode discovery.
//
// A builder that works without login beats a white screen: any failure to
// reach the endpoint — a stale API, a network hiccup — degrades to
// `{ enabled: false }` rather than surfacing an error.

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
      .catch((): AuthConfig => ({ enabled: false }));
  }
  return cached;
}

/** Test seam — forces the next call to re-fetch rather than reuse the cache. */
export function resetAuthConfigForTests(): void {
  cached = null;
}
