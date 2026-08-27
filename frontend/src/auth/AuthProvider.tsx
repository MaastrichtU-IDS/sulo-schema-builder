// Discovers whether this deployment requires authentication and, if so,
// signs the visitor in through Keycloak's own hosted pages.
//
// `onLoad: 'check-sso'` (not `'login-required'`) is deliberate: the builder
// must stay usable for an anonymous visitor on the desktop build, and must
// not bounce a first-time web visitor to a login page before they have seen
// the app. `check-sso` needs the silent-check page at
// `public/silent-check-sso.html`.
//
// Every failure mode here degrades to `'disabled'` rather than rendering
// nothing: a builder that works without login beats a white screen. That
// covers a Keycloak `init()` that throws (e.g. the silent-check iframe being
// blocked) — degraded to immediately, since retrying a browser-side init
// failure would just repeat it — and a `/auth-config` that keeps rejecting
// after retrying with backoff (below).
//
// `/auth-config` rejecting is deliberately NOT the same as it resolving with
// `{ enabled: false }`: a reject means the question couldn't even be asked
// (API restarting, a proxy 502) and is worth retrying; `enabled: false` is a
// real, load-bearing answer from a server that IS up, and is not retried.
//
// Tokens live only in this component's state / the Keycloak instance's own
// memory — nothing is written to localStorage or cookies by this code.

import { createContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type Keycloak from 'keycloak-js';
import { getAuthConfig, type AuthConfig } from '../api/authConfig.js';
import { createKeycloak } from './keycloak.js';
import { setTokenProvider } from '../api/client.js';

// Backoff before giving up on a rejecting /auth-config and finally degrading
// to 'disabled'. Bounded and short: this delays first paint of the
// sign-in/anonymous UI on a healthy deployment by nothing (the happy path
// never enters this loop), and on an unhealthy one it is a few seconds of
// "loading" rather than an instant, permanent "disabled".
const AUTH_CONFIG_RETRY_DELAYS_MS = [300, 900, 2000];

export type AuthStatus = 'loading' | 'disabled' | 'anonymous' | 'authenticated';

export interface AuthUser {
  name?: string;
  email?: string;
}

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  login: () => void;
  logout: () => void;
}

const defaultValue: AuthContextValue = {
  status: 'loading',
  user: null,
  login: () => {},
  logout: () => {},
};

export const AuthContext = createContext<AuthContextValue>(defaultValue);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const keycloakRef = useRef<Keycloak | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Deliberately does not check `cancelled` to cut its own execution
    // short — only the `run()` below's setStatus calls are guarded by it.
    // Bailing out here on a stale StrictMode double-invoke run would (like
    // the ref-clobbering hazard the "keeps the live authenticated instance"
    // test below guards) leave that run's Keycloak instance never
    // constructed, silently changing which effect run "wins" from the one
    // React's own semantics dictate.
    async function fetchAuthConfigWithRetry(): Promise<AuthConfig | undefined> {
      for (let attempt = 0; ; attempt++) {
        try {
          return await getAuthConfig();
        } catch {
          if (attempt >= AUTH_CONFIG_RETRY_DELAYS_MS.length) {
            // Retries exhausted — this deployment may genuinely be
            // unreachable, but a white screen (stuck on 'loading' forever)
            // would be worse than degrading to the anonymous-capable UI.
            return undefined;
          }
          await new Promise((resolve) => setTimeout(resolve, AUTH_CONFIG_RETRY_DELAYS_MS[attempt]));
        }
      }
    }

    async function run() {
      const config = await fetchAuthConfigWithRetry();
      if (!config) {
        if (!cancelled) setStatus('disabled');
        return;
      }

      if (!config.enabled) {
        if (!cancelled) setStatus('disabled');
        return;
      }

      let keycloak: Keycloak | undefined;
      try {
        keycloak = createKeycloak(config);
        keycloakRef.current = keycloak;

        const authenticated = await keycloak.init({
          onLoad: 'check-sso',
          pkceMethod: 'S256',
          silentCheckSsoRedirectUri: `${window.location.origin}/silent-check-sso.html`,
        });

        if (cancelled) return;

        if (authenticated) {
          // `keycloak` is `let`-declared (so the catch block below can tell
          // whether it's still the ref's owner), and TS doesn't narrow a
          // `let` across a closure boundary — capture it in a `const` here
          // so the closures below keep the non-undefined type.
          const activeKeycloak = keycloak;
          setTokenProvider({
            getToken: async () => activeKeycloak.token ?? null,
            refresh: async () => {
              try {
                // A 30s minimum-validity margin: renew slightly ahead of
                // expiry rather than racing the API's own verification.
                await activeKeycloak.updateToken(30);
                return true;
              } catch {
                return false;
              }
            },
          });
          setUser({ name: activeKeycloak.tokenParsed?.name, email: activeKeycloak.tokenParsed?.email });
          setStatus('authenticated');
        } else {
          setStatus('anonymous');
        }
      } catch {
        // Under React.StrictMode's dev double-invoke, two effect runs each
        // construct their own Keycloak instance. If this (aborted) run's
        // init() rejects after the *other*, live run already installed a
        // working instance and authenticated, clearing the ref
        // unconditionally would null out the live instance — making
        // login()/logout() permanent no-ops while status/user keep
        // reporting authenticated. Only clear the ref if it still points at
        // *this* run's instance.
        if (keycloakRef.current === keycloak) keycloakRef.current = null;
        if (!cancelled) setStatus('disabled');
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = () => keycloakRef.current?.login();
  const logout = () => {
    setTokenProvider(null);
    setUser(null);
    keycloakRef.current?.logout();
  };

  return <AuthContext.Provider value={{ status, user, login, logout }}>{children}</AuthContext.Provider>;
}
