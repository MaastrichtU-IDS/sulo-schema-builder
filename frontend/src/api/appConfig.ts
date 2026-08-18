// Which storage backend this deployment uses. One SPA build serves every
// deployment, so the decision is the server's: GET /app-config returns
// 'server' (desktop app / local dev — REST + SQLite) or 'browser' (web
// deployment — schemas live in this visitor's IndexedDB).

import { apiClient } from './client.js';

export type StorageMode = 'server' | 'browser';

let cached: Promise<StorageMode> | null = null;
let testOverride: StorageMode | null = null;

export function getStorageMode(): Promise<StorageMode> {
  if (testOverride) return Promise.resolve(testOverride);
  if (!cached) {
    cached = apiClient
      .get('/app-config')
      .then((r) => (r.data?.storage === 'browser' ? 'browser' : 'server'))
      // An older API without the endpoint (or a hiccup) behaves like today.
      .catch((): StorageMode => 'server');
  }
  return cached;
}

/** Test seam — forces a mode without a network round-trip. */
export function setStorageModeForTests(mode: StorageMode | null): void {
  testOverride = mode;
  cached = null;
}
