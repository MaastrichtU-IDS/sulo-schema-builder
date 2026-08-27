import axios from 'axios';

export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api/v1',
});

/**
 * How the client obtains a token. Set by AuthProvider once Keycloak is ready;
 * left null on the desktop build, where the API needs no token. Keeping this
 * an injected seam (rather than importing Keycloak here) is what lets the
 * interceptors be unit-tested and keeps the API layer free of auth machinery.
 */
export interface TokenProvider {
  getToken: () => Promise<string | null>;
  refresh: () => Promise<boolean>;
}

let tokenProvider: TokenProvider | null = null;

export function setTokenProvider(provider: TokenProvider | null): void {
  tokenProvider = provider;
}

/**
 * The `Authorization` header this session would attach right now, for a
 * caller that cannot use the axios instance's own interceptor above —
 * events.ts's raw `fetch` (an SSE stream, which `EventSource` cannot set a
 * header on at all) is the one place that needs this today. Empty on the
 * desktop build, where `tokenProvider` is never set because the API needs
 * no token there.
 */
export async function authHeader(): Promise<Record<string, string>> {
  const token = await tokenProvider?.getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

apiClient.interceptors.request.use(async (config) => {
  const token = await tokenProvider?.getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error?.config;
    // One refresh-and-retry per request: an access token that expired mid-flight
    // is routine, but a 401 on the retried request means the session is gone and
    // looping would hammer both Keycloak and the API.
    if (error?.response?.status === 401 && tokenProvider && config && !config.__retried) {
      config.__retried = true;
      const refreshed = await tokenProvider.refresh();
      if (refreshed) return apiClient.request(config);
    }
    throw error;
  },
);
