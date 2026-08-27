import { describe, it, expect, beforeEach, vi } from 'vitest';
import { apiClient, setTokenProvider } from './client.js';

// Reaching into `interceptors.*.handlers` is not part of axios's public
// typings, so a plain access fails `tsc --noEmit`. The cast below is the
// documented seam for unit-testing interceptors as pure functions, without a
// network or a mock server — see the task brief for the rationale. Keeping
// the cast in one place (this helper) means the rest of the test stays typed
// against the real handler signatures.
interface InterceptorHandler<TFulfilled, TRejected> {
  fulfilled: TFulfilled;
  rejected?: TRejected;
}
interface InterceptorManagerWithHandlers<TFulfilled, TRejected> {
  handlers: Array<InterceptorHandler<TFulfilled, TRejected> | null>;
}

type RequestConfig = { headers: Record<string, string>; __retried?: boolean; adapter?: unknown };
type RequestFulfilled = (config: RequestConfig) => Promise<RequestConfig>;

function requestHandlers() {
  return (
    apiClient.interceptors.request as unknown as InterceptorManagerWithHandlers<RequestFulfilled, never>
  ).handlers;
}

type ResponseRejected = (error: unknown) => Promise<unknown>;

function responseHandlers() {
  return (
    apiClient.interceptors.response as unknown as InterceptorManagerWithHandlers<
      (r: unknown) => unknown,
      ResponseRejected
    >
  ).handlers;
}

describe('apiClient auth interceptor', () => {
  beforeEach(() => {
    setTokenProvider(null);
  });

  it('sends no Authorization header when no provider is set', async () => {
    const config = await requestHandlers()[0]!.fulfilled({ headers: {} });
    expect(config.headers.Authorization).toBeUndefined();
  });

  it('attaches the bearer token from the provider', async () => {
    setTokenProvider({ getToken: async () => 'tok-123', refresh: async () => true });
    const config = await requestHandlers()[0]!.fulfilled({ headers: {} });
    expect(config.headers.Authorization).toBe('Bearer tok-123');
  });

  it('omits the header when the provider returns no token', async () => {
    setTokenProvider({ getToken: async () => null, refresh: async () => true });
    const config = await requestHandlers()[0]!.fulfilled({ headers: {} });
    expect(config.headers.Authorization).toBeUndefined();
  });

  it('refreshes once and retries on a 401', async () => {
    const refresh = vi.fn(async () => true);
    setTokenProvider({ getToken: async () => 'tok-123', refresh });

    const retry = vi.fn(async () => ({ data: 'ok' }));
    const rejected = responseHandlers()[0]!.rejected!;
    const result = await rejected({
      response: { status: 401 },
      config: { headers: {}, __retried: undefined, adapter: retry },
    });

    // axios's dispatchRequest fills in response defaults (e.g. `headers`)
    // around whatever the adapter resolves, so match on the payload rather
    // than the whole object.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ data: 'ok' });
  });

  it('does not loop: a second 401 on the retried request rejects', async () => {
    const refresh = vi.fn(async () => true);
    setTokenProvider({ getToken: async () => 'tok-123', refresh });

    const rejected = responseHandlers()[0]!.rejected!;
    await expect(
      rejected({ response: { status: 401 }, config: { headers: {}, __retried: true } }),
    ).rejects.toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});
