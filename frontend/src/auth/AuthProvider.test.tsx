import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Shared mock state, hoisted above the vi.mock factories below so both the
// factories and the test bodies can read/reset it.
const h = vi.hoisted(() => {
  const instances: Array<{
    login: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    updateToken: ReturnType<typeof vi.fn>;
    init: ReturnType<typeof vi.fn>;
    token: string | undefined;
    tokenParsed: { name?: string; email?: string } | undefined;
  }> = [];
  let nextAuthenticated = false;
  let nextTokenParsed: { name?: string; email?: string } | undefined = undefined;
  let nextInitError: Error | null = null;

  return { instances, get nextAuthenticated() { return nextAuthenticated; },
    setNextAuthenticated: (v: boolean) => { nextAuthenticated = v; },
    setNextTokenParsed: (v: { name?: string; email?: string } | undefined) => { nextTokenParsed = v; },
    getNextTokenParsed: () => nextTokenParsed,
    setNextInitError: (e: Error | null) => { nextInitError = e; },
    getNextInitError: () => nextInitError,
  };
});

vi.mock('keycloak-js', () => {
  class FakeKeycloak {
    login = vi.fn();
    logout = vi.fn();
    updateToken = vi.fn(async () => true);
    token: string | undefined;
    tokenParsed: { name?: string; email?: string } | undefined;
    init = vi.fn(async () => {
      if (h.getNextInitError()) throw h.getNextInitError();
      const authenticated = h.nextAuthenticated;
      if (authenticated) {
        this.token = 'tok-abc';
        this.tokenParsed = h.getNextTokenParsed();
      }
      return authenticated;
    });

    constructor() {
      h.instances.push(this as unknown as (typeof h.instances)[number]);
    }
  }
  return { default: FakeKeycloak };
});

const apiGet = vi.fn();
const setTokenProviderMock = vi.fn();

vi.mock('../api/client.js', () => ({
  apiClient: { get: (...args: unknown[]) => apiGet(...args) },
  setTokenProvider: (...args: unknown[]) => setTokenProviderMock(...args),
}));

import { AuthProvider } from './AuthProvider.js';
import { useAuth } from './useAuth.js';
import { resetAuthConfigForTests } from '../api/authConfig.js';

const ISSUER = 'http://localhost:8088/realms/sulo';

function renderAuth() {
  return renderHook(() => useAuth(), {
    wrapper: ({ children }) => <AuthProvider>{children}</AuthProvider>,
  });
}

describe('AuthProvider', () => {
  beforeEach(() => {
    apiGet.mockReset();
    setTokenProviderMock.mockReset();
    h.instances.length = 0;
    h.setNextAuthenticated(false);
    h.setNextTokenParsed(undefined);
    h.setNextInitError(null);
    resetAuthConfigForTests();
  });

  it('is "loading" while /auth-config is in flight', async () => {
    let resolveConfig: (v: unknown) => void = () => {};
    apiGet.mockReturnValue(new Promise((resolve) => { resolveConfig = resolve; }));

    const { result } = renderAuth();

    expect(result.current.status).toBe('loading');

    resolveConfig({ data: { enabled: false } });
    await waitFor(() => expect(result.current.status).toBe('disabled'));
  });

  it('degrades to "disabled" when the endpoint reports enabled: false, without touching Keycloak', async () => {
    apiGet.mockResolvedValue({ data: { enabled: false } });

    const { result } = renderAuth();

    await waitFor(() => expect(result.current.status).toBe('disabled'));
    expect(h.instances).toHaveLength(0);
    expect(setTokenProviderMock).not.toHaveBeenCalled();
  });

  it('is "anonymous" when enabled and Keycloak reports not-authenticated; login() delegates to Keycloak', async () => {
    apiGet.mockResolvedValue({ data: { enabled: true, issuer: ISSUER, clientId: 'sulo-spa' } });
    h.setNextAuthenticated(false);

    const { result } = renderAuth();

    await waitFor(() => expect(result.current.status).toBe('anonymous'));
    expect(h.instances).toHaveLength(1);

    result.current.login();
    expect(h.instances[0].login).toHaveBeenCalledTimes(1);
  });

  it('is "authenticated" with the token\'s name/email when Keycloak reports authenticated, and installs a token provider', async () => {
    apiGet.mockResolvedValue({ data: { enabled: true, issuer: ISSUER, clientId: 'sulo-spa' } });
    h.setNextAuthenticated(true);
    h.setNextTokenParsed({ name: 'Ada Lovelace', email: 'ada@example.org' });

    const { result } = renderAuth();

    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    expect(result.current.user).toEqual({ name: 'Ada Lovelace', email: 'ada@example.org' });
    expect(setTokenProviderMock).toHaveBeenCalledTimes(1);

    const provider = setTokenProviderMock.mock.calls[0][0];
    await expect(provider.getToken()).resolves.toBe('tok-abc');
  });

  it('degrades to "disabled" rather than rendering nothing when /auth-config rejects', async () => {
    apiGet.mockRejectedValue(new Error('network down'));

    const { result } = renderAuth();

    await waitFor(() => expect(result.current.status).toBe('disabled'));
    expect(h.instances).toHaveLength(0);
  });

  it('degrades to "disabled" when Keycloak init() throws', async () => {
    apiGet.mockResolvedValue({ data: { enabled: true, issuer: ISSUER, clientId: 'sulo-spa' } });
    h.setNextInitError(new Error('iframe blocked'));

    const { result } = renderAuth();

    await waitFor(() => expect(result.current.status).toBe('disabled'));
  });
});
