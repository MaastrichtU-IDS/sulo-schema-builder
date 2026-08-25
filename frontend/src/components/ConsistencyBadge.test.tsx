import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock the axios client module, not the network — same convention as
// ShareDialog.test.tsx and api/backend.test.ts.
const get = vi.fn();
const post = vi.fn();

vi.mock('../api/client.js', () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
  },
}));

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

describe('ConsistencyBadge', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
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
});
