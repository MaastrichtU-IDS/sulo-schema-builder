import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OntologySchema } from '../api/ontology.js';

// Mock the axios client module, not the network — same convention as
// api/backend.test.ts and auth/AuthProvider.test.tsx.
const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock('../api/client.js', () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    put: (...args: unknown[]) => put(...args),
    patch: (...args: unknown[]) => patch(...args),
    delete: (...args: unknown[]) => del(...args),
  },
}));

const ShareDialog = (await import('./ShareDialog.js')).default;

function axiosError(status: number, message?: string) {
  return { isAxiosError: true, response: { status, data: message ? { message } : {} } };
}

function renderDialog(overrides: Partial<OntologySchema> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const schema: OntologySchema = {
    id: 'schema-1',
    url: 'https://example/ontology-schema/schema-1',
    title: 'Test Schema',
    visibility: 'private',
    classes: [],
    properties: [],
    ...overrides,
  };
  const onClose = vi.fn();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ShareDialog schema={schema} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { ...utils, onClose, schema };
}

describe('ShareDialog', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    put.mockReset();
    patch.mockReset();
    del.mockReset();
  });

  it('renders read-only for a viewer (grants fetch 403s)', async () => {
    get.mockRejectedValue(axiosError(403, 'You do not have permission to do that.'));

    renderDialog();

    await waitFor(() =>
      expect(screen.getByText(/only the schema owner can manage sharing/i)).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText(/visibility/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^add$/i })).not.toBeInTheDocument();
  });

  it('does not let an editor change visibility (same own-only 403)', async () => {
    get.mockRejectedValue(axiosError(403, 'You do not have permission to do that.'));

    renderDialog();

    await waitFor(() => expect(get).toHaveBeenCalled());
    // No visibility control is rendered at all — the server enforces `own`,
    // and an editor is never shown a control that would only 403.
    expect(screen.queryByLabelText(/visibility/i)).not.toBeInTheDocument();
    expect(screen.getByText('private')).toBeInTheDocument();
  });

  it('gives the owner a working visibility control and grant form', async () => {
    get.mockImplementation((url: string) => {
      if (url.includes('/grants')) return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    renderDialog();

    await waitFor(() => expect(screen.getByLabelText(/visibility/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^add$/i })).toBeInTheDocument();
  });

  it('reports a failed email lookup as "no account with that address", not a raw 404', async () => {
    get.mockImplementation((url: string) => {
      if (url.includes('/grants')) return Promise.resolve({ data: [] });
      if (url.includes('/users/lookup')) return Promise.reject(axiosError(404, 'User not found'));
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    const user = userEvent.setup();

    renderDialog();
    await waitFor(() => expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/^email$/i), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(screen.getByText(/no account with that address/i)).toBeInTheDocument());
    expect(screen.queryByText(/404/)).not.toBeInTheDocument();
    expect(screen.queryByText(/user not found/i)).not.toBeInTheDocument();
  });

  it('reports a rate-limited lookup distinctly from a not-found one', async () => {
    get.mockImplementation((url: string) => {
      if (url.includes('/grants')) return Promise.resolve({ data: [] });
      if (url.includes('/users/lookup')) return Promise.reject(axiosError(429));
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    const user = userEvent.setup();

    renderDialog();
    await waitFor(() => expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/^email$/i), 'someone@example.com');
    await user.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(screen.getByText(/too many lookups/i)).toBeInTheDocument());
    expect(screen.queryByText(/no account with that address/i)).not.toBeInTheDocument();
  });

  it('invalidates the grants query after adding a grant', async () => {
    let grantsCalls = 0;
    get.mockImplementation((url: string) => {
      if (url.includes('/grants')) {
        grantsCalls += 1;
        return Promise.resolve({ data: [] });
      }
      if (url.includes('/users/lookup')) {
        return Promise.resolve({ data: { id: 'user-2', displayName: 'Bob' } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    put.mockResolvedValue({
      data: { userId: 'user-2', displayName: 'Bob', role: 'viewer', grantedAt: new Date().toISOString() },
    });
    const user = userEvent.setup();

    renderDialog();
    await waitFor(() => expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument());
    const callsBeforeAdd = grantsCalls;

    await user.type(screen.getByLabelText(/^email$/i), 'bob@example.com');
    await user.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/ontology-schemas/schema-1/grants/user-2', { role: 'viewer' }),
    );
    await waitFor(() => expect(grantsCalls).toBeGreaterThan(callsBeforeAdd));
  });

  it('transfers ownership to the resolved userId and invalidates the grants and schema queries', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    get.mockImplementation((url: string) => {
      if (url.includes('/grants')) return Promise.resolve({ data: [] });
      if (url.includes('/users/lookup')) {
        return Promise.resolve({ data: { id: 'user-9', displayName: 'Alice' } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    post.mockResolvedValue({ data: undefined });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const schema: OntologySchema = {
      id: 'schema-1',
      url: 'https://example/ontology-schema/schema-1',
      title: 'Test Schema',
      visibility: 'private',
      classes: [],
      properties: [],
    };
    render(
      <QueryClientProvider client={queryClient}>
        <ShareDialog schema={schema} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();

    await waitFor(() => expect(screen.getByLabelText(/new owner/i)).toBeInTheDocument());
    await user.type(screen.getByLabelText(/new owner/i), 'alice@example.com');
    await user.click(screen.getByRole('button', { name: /^transfer$/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/ontology-schemas/schema-1/transfer', { userId: 'user-9' }),
    );
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['schema-grants', 'schema-1'] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ontology-schema', 'schema-1'] });
  });
});
