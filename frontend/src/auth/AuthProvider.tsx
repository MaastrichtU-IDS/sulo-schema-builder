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
// covers a `/auth-config` that 404s or rejects, and a Keycloak `init()` that
// throws (e.g. the silent-check iframe being blocked).
//
// Tokens live only in this component's state / the Keycloak instance's own
// memory — nothing is written to localStorage or cookies by this code.

import { createContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type Keycloak from 'keycloak-js';
import { getAuthConfig } from '../api/authConfig.js';
import { createKeycloak } from './keycloak.js';
import { setTokenProvider } from '../api/client.js';

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

    async function run() {
      let config;
      try {
        config = await getAuthConfig();
      } catch {
        if (!cancelled) setStatus('disabled');
        return;
      }

      if (!config.enabled) {
        if (!cancelled) setStatus('disabled');
        return;
      }

      try {
        const keycloak = createKeycloak(config);
        keycloakRef.current = keycloak;

        const authenticated = await keycloak.init({
          onLoad: 'check-sso',
          pkceMethod: 'S256',
          silentCheckSsoRedirectUri: `${window.location.origin}/silent-check-sso.html`,
        });

        if (cancelled) return;

        if (authenticated) {
          setTokenProvider({
            getToken: async () => keycloak.token ?? null,
            refresh: async () => {
              try {
                // A 30s minimum-validity margin: renew slightly ahead of
                // expiry rather than racing the API's own verification.
                await keycloak.updateToken(30);
                return true;
              } catch {
                return false;
              }
            },
          });
          setUser({ name: keycloak.tokenParsed?.name, email: keycloak.tokenParsed?.email });
          setStatus('authenticated');
        } else {
          setStatus('anonymous');
        }
      } catch {
        keycloakRef.current = null;
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
