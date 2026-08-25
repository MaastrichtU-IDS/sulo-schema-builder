import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock the axios client module, not the network — same convention as
// ShareDialog.test.tsx and api/backend.test.ts.
const get = vi.fn();
const post = vi.fn();

vi.mock('../api/client.js', () => ({
  apiClient: { defaults: { baseURL: '/api/v1' }, get: (...args: unknown[]) => get(...args), post: (...args: unknown[]) => post(...args) },
  authHeader: async () => ({}),
}));

// report.ts now also opens an SSE subscription (events.ts's subscribeToSchema,
// a raw `fetch`) alongside the polled apiClient.get above. Most of this
// suite is about the polling fallback's own behaviour — unchanged by plan 5
// — so `beforeEach` below stubs `fetch` to fail immediately and
// consistently rather than actually reaching the network from jsdom: every
// case except the "live SSE subscription" describe block at the bottom
// exercises exactly the "SSE unavailable" path a real corporate proxy would
// produce. Those cases override the stub with a controllable stream instead.

const ConsistencyBadge = (await import('./ConsistencyBadge.js')).default;
const { REPORT_POLL_INTERVAL_MS } = await import('../api/report.js');

function axiosError(status: number, data?: unknown) {
  return { isAxiosError: true, response: { status, data: data ?? {} } };
}

function renderBadge(authStatus: 'loading' | 'disabled' | 'anonymous' | 'authenticated' = 'authenticated') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ConsistencyBadge schemaId="schema-1" authStatus={authStatus} />
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

function rejectingFetch() {
  return vi.fn().mockRejectedValue(new Error('SSE unavailable in this test environment'));
}

/** A ReadableStream events.ts's subscribeToSchema can read from, pushed to at the test's own pace. */
function controllableSseStream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
  const encoder = new TextEncoder();
  return {
    stream,
    push(text: string) { ctrl.enqueue(encoder.encode(text)); },
  };
}

describe('ConsistencyBadge', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    vi.stubGlobal('fetch', rejectingFetch());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a never-checked message and a refresh control for a caller who might have edit access', async () => {
    get.mockResolvedValue({
      data: { state: 'stale', cacheKey: 'k1', computedAt: null, stale: true },
    });

    renderBadge('authenticated');

    await waitFor(() => expect(screen.getByText(/not yet been checked/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /check consistency/i })).toBeInTheDocument();
  });

  it('shows a queued message', async () => {
    get.mockResolvedValue({
      data: { state: 'queued', cacheKey: 'k1', computedAt: null, stale: true },
    });

    renderBadge('authenticated');

    await waitFor(() => expect(screen.getByText(/queued/i)).toBeInTheDocument());
  });

  it('shows a running message', async () => {
    get.mockResolvedValue({
      data: { state: 'running', cacheKey: 'k1', computedAt: null, stale: true },
    });

    renderBadge('authenticated');

    await waitFor(() => expect(screen.getByText(/checking consistency/i)).toBeInTheDocument());
  });

  it('shows a consistent verdict when fresh and consistent', async () => {
    get.mockResolvedValue({
      data: {
        state: 'fresh',
        cacheKey: 'k1',
        computedAt: '2026-08-21T10:00:00Z',
        stale: false,
        report: { consistent: true, reasoner: 'HermiT', clashes: [] },
      },
    });

    renderBadge('authenticated');

    await waitFor(() => expect(screen.getByText(/^consistent$/i)).toBeInTheDocument());
    expect(screen.getByText(/hermit/i)).toBeInTheDocument();
  });

  it('shows clashes and their explanations when fresh and inconsistent', async () => {
    get.mockResolvedValue({
      data: {
        state: 'fresh',
        cacheKey: 'k1',
        computedAt: '2026-08-21T10:00:00Z',
        stale: false,
        report: {
          consistent: false,
          reasoner: 'HermiT',
          clashes: [
            {
              kind: 'unsatisfiable-class',
              label: 'Widget',
              explanation: 'Widget is a subclass of two disjoint classes.',
            },
          ],
        },
      },
    });

    renderBadge('authenticated');

    await waitFor(() => expect(screen.getByText('Widget', { exact: true })).toBeInTheDocument());
    expect(screen.getByText(/subclass of two disjoint classes/i)).toBeInTheDocument();
  });

  it('shows a failed message', async () => {
    get.mockResolvedValue({
      data: { state: 'failed', cacheKey: 'k1', computedAt: '2026-08-21T09:00:00Z', stale: true },
    });

    renderBadge('authenticated');

    await waitFor(() => expect(screen.getByText(/check failed/i)).toBeInTheDocument());
  });

  it('shows when to come back after a refresh attempt is quota-limited, not a generic pending message', async () => {
    get.mockResolvedValue({
      data: { state: 'stale', cacheKey: 'k1', computedAt: null, stale: true },
    });
    post.mockRejectedValue(axiosError(429, { retryAfter: 900 }));
    const user = userEvent.setup();

    renderBadge('authenticated');

    await waitFor(() => expect(screen.getByRole('button', { name: /check consistency/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /check consistency/i }));

    await waitFor(() => expect(screen.getByText(/15 minutes/i)).toBeInTheDocument());
    expect(screen.getByText(/try again/i)).toBeInTheDocument();
    // Not a generic "pending" — the quota message is distinct from the
    // never-checked copy that was showing before the click.
    expect(screen.queryByText(/not yet been checked/i)).not.toBeInTheDocument();
  });

  it('handles a 403 on refresh gracefully instead of a raw error', async () => {
    get.mockResolvedValue({
      data: { state: 'stale', cacheKey: 'k1', computedAt: null, stale: true },
    });
    post.mockRejectedValue(axiosError(403, { message: 'You do not have permission to do that.' }));
    const user = userEvent.setup();

    renderBadge('authenticated');

    await waitFor(() => expect(screen.getByRole('button', { name: /check consistency/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /check consistency/i }));

    await waitFor(() => expect(screen.getByText(/don.t have permission/i)).toBeInTheDocument());
    expect(screen.queryByText(/403/)).not.toBeInTheDocument();
  });

  it('lets an anonymous viewer of a public schema see the verdict', async () => {
    get.mockResolvedValue({
      data: {
        state: 'fresh',
        cacheKey: 'k1',
        computedAt: '2026-08-21T10:00:00Z',
        stale: false,
        report: { consistent: true, reasoner: 'HermiT', clashes: [] },
      },
    });

    renderBadge('anonymous');

    await waitFor(() => expect(screen.getByText(/^consistent$/i)).toBeInTheDocument());
  });

  it('hides the refresh control for a caller who cannot refresh (anonymous)', async () => {
    get.mockResolvedValue({
      data: { state: 'stale', cacheKey: 'k1', computedAt: null, stale: true },
    });

    renderBadge('anonymous');

    await waitFor(() => expect(screen.getByText(/not yet been checked/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /check consistency/i })).not.toBeInTheDocument();
  });

  it('polls while queued/running and stops once the state settles to fresh', async () => {
    vi.useFakeTimers();
    let call = 0;
    get.mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve({ data: { state: 'queued', cacheKey: 'k1', computedAt: null, stale: true } });
      if (call === 2) return Promise.resolve({ data: { state: 'running', cacheKey: 'k1', computedAt: null, stale: true } });
      return Promise.resolve({
        data: {
          state: 'fresh',
          cacheKey: 'k1',
          computedAt: '2026-08-21T10:00:00Z',
          stale: false,
          report: { consistent: true, reasoner: 'HermiT', clashes: [] },
        },
      });
    });

    renderBadge('authenticated');

    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    await act(async () => { await vi.advanceTimersByTimeAsync(REPORT_POLL_INTERVAL_MS); });
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    await act(async () => { await vi.advanceTimersByTimeAsync(REPORT_POLL_INTERVAL_MS); });
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3));

    const settledCalls = call;
    // Two more interval lengths with no further growth proves polling
    // actually stopped, rather than just having not fired again yet.
    await act(async () => { await vi.advanceTimersByTimeAsync(REPORT_POLL_INTERVAL_MS * 2); });
    expect(call).toBe(settledCalls);
  });

  // Found by e2e proof (frontend/e2e/reasoning-flow.spec.ts): every mutation
  // schedules a debounced check, but the debounce has an idle window before
  // it fires — a client that mounts during that window sees `stale`, not
  // `queued` yet. The old refetchInterval (queued/running only) never polled
  // from there, so a check that ran and settled entirely server-side left an
  // open tab stuck showing "not yet checked" forever.
  it('polls from an initial `stale` too, not only queued/running', async () => {
    vi.useFakeTimers();
    let call = 0;
    get.mockImplementation(() => {
      call += 1;
      // Mid-debounce: no job exists yet, so the first several polls still
      // read `stale` before the debounce fires and it moves to `queued`.
      if (call <= 2) return Promise.resolve({ data: { state: 'stale', cacheKey: '', computedAt: null, stale: false } });
      if (call === 3) return Promise.resolve({ data: { state: 'queued', cacheKey: 'k1', computedAt: null, stale: true } });
      return Promise.resolve({
        data: {
          state: 'fresh', cacheKey: 'k1', computedAt: '2026-08-21T10:00:00Z', stale: false,
          report: { consistent: true, reasoner: 'HermiT', clashes: [] },
        },
      });
    });

    renderBadge('authenticated');

    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(REPORT_POLL_INTERVAL_MS); });
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(REPORT_POLL_INTERVAL_MS); });
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    await act(async () => { await vi.advanceTimersByTimeAsync(REPORT_POLL_INTERVAL_MS); });
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(4));

    await vi.waitFor(() => expect(screen.getByText('Consistent')).toBeInTheDocument());
  });

  describe('live SSE subscription (plan 5)', () => {
    it('an event on the stream triggers a refetch, without waiting for the poll interval', async () => {
      const sse = controllableSseStream();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: sse.stream }));

      get.mockResolvedValueOnce({
        data: { state: 'stale', cacheKey: '', computedAt: null, stale: false },
      }).mockResolvedValueOnce({
        data: {
          state: 'fresh', cacheKey: 'k1', computedAt: '2026-08-21T10:00:00Z', stale: false,
          report: { consistent: true, reasoner: 'HermiT', clashes: [] },
        },
      });

      renderBadge('authenticated');
      // Waits for the INITIAL fetch to genuinely settle (not just for `get`
      // to have been called) before the stream event below: react-query
      // treats invalidateQueries called while a fetch for that key is
      // already in flight as a no-op (it never starts a redundant
      // concurrent fetch), so pushing the event any earlier would race the
      // component's own mount-time fetch — a real subscriber only connects
      // well after mount in practice, and this is that.
      await vi.waitFor(() => expect(screen.getByText(/not yet been checked/i)).toBeInTheDocument());
      expect(get).toHaveBeenCalledTimes(1);

      // No poll interval elapses here — only a real SSE event triggers the
      // second fetch below, proving the stream (not the fallback timer) did it.
      sse.push('data: {"schemaId":"schema-1","kind":"report","at":"2026-08-25T00:00:00Z"}\n\n');

      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(screen.getByText('Consistent')).toBeInTheDocument());
    });

    it('falls back to polling when the stream cannot connect at all', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', rejectingFetch());
      let call = 0;
      get.mockImplementation(() => {
        call += 1;
        if (call < 3) return Promise.resolve({ data: { state: 'queued', cacheKey: 'k1', computedAt: null, stale: true } });
        return Promise.resolve({
          data: {
            state: 'fresh', cacheKey: 'k1', computedAt: '2026-08-21T10:00:00Z', stale: false,
            report: { consistent: true, reasoner: 'HermiT', clashes: [] },
          },
        });
      });

      renderBadge('authenticated');
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      await act(async () => { await vi.advanceTimersByTimeAsync(REPORT_POLL_INTERVAL_MS); });
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
      await act(async () => { await vi.advanceTimersByTimeAsync(REPORT_POLL_INTERVAL_MS); });
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3));

      await vi.waitFor(() => expect(screen.getByText('Consistent')).toBeInTheDocument());
    });

    it('closes the stream on unmount', async () => {
      const abortSpy = vi.fn();
      const sse = controllableSseStream();
      const fetchMock = vi.fn((_url: string, init: RequestInit) => {
        init.signal?.addEventListener('abort', abortSpy);
        return Promise.resolve({ ok: true, body: sse.stream });
      });
      vi.stubGlobal('fetch', fetchMock);
      get.mockResolvedValue({ data: { state: 'stale', cacheKey: '', computedAt: null, stale: false } });

      const { unmount } = renderBadge('authenticated');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

      unmount();
      expect(abortSpy).toHaveBeenCalledOnce();
    });
  });
});
