import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setTokenProvider } from './client.js';
import { subscribeToSchema } from './events.js';

function controllableStream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
  const encoder = new TextEncoder();
  return {
    stream,
    push(text: string) { ctrl.enqueue(encoder.encode(text)); },
    end() { ctrl.close(); },
    errorWith(err: unknown) { try { ctrl.error(err); } catch { /* already closed */ } },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setTokenProvider(null);
});

describe('subscribeToSchema', () => {
  it('attaches the Authorization header from the current token provider', async () => {
    setTokenProvider({ getToken: async () => 'the-token', refresh: async () => true });
    const { stream } = controllableStream();
    fetchMock.mockResolvedValue({ ok: true, body: stream });

    const unsubscribe = subscribeToSchema('schema-1', { onEvent: vi.fn(), onError: vi.fn() });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer the-token' });
    unsubscribe();
  });

  it('calls onEvent for a data: line and ignores comment lines (including the keep-alive)', async () => {
    const handle = controllableStream();
    fetchMock.mockResolvedValue({ ok: true, body: handle.stream });
    const onEvent = vi.fn();

    const unsubscribe = subscribeToSchema('schema-1', { onEvent, onError: vi.fn() });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    handle.push(':ok\n\n');
    handle.push(': keep-alive\n\n');
    handle.push('data: {"schemaId":"schema-1","kind":"mutated","at":"2026-08-25T00:00:00Z"}\n\n');

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    expect(onEvent).toHaveBeenCalledWith({ schemaId: 'schema-1', kind: 'mutated', at: '2026-08-25T00:00:00Z' });

    unsubscribe();
  });

  it('calls onOpen once the connection is confirmed, before any event', async () => {
    const handle = controllableStream();
    fetchMock.mockResolvedValue({ ok: true, body: handle.stream });
    const onOpen = vi.fn();

    const unsubscribe = subscribeToSchema('schema-1', { onEvent: vi.fn(), onError: vi.fn(), onOpen });
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledOnce());

    unsubscribe();
  });

  it('calls onError when the fetch itself rejects (network failure)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const onError = vi.fn();

    subscribeToSchema('schema-1', { onEvent: vi.fn(), onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  });

  it('calls onError when the response is not ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, body: null });
    const onError = vi.fn();

    subscribeToSchema('schema-1', { onEvent: vi.fn(), onError });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  });

  it('calls onError when the stream ends on its own (a proxy silently dropping it) rather than going silent', async () => {
    const handle = controllableStream();
    fetchMock.mockResolvedValue({ ok: true, body: handle.stream });
    const onError = vi.fn();

    subscribeToSchema('schema-1', { onEvent: vi.fn(), onError });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    handle.end(); // the server (or a proxy) closed the connection
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
  });

  it('unsubscribing aborts the connection: no onEvent or onError fires afterward, even if the stream then errors', async () => {
    const handle = controllableStream();
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => {
        handle.errorWith(new DOMException('aborted', 'AbortError'));
      });
      return Promise.resolve({ ok: true, body: handle.stream });
    });
    const onEvent = vi.fn();
    const onError = vi.fn();

    const unsubscribe = subscribeToSchema('schema-1', { onEvent, onError });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    unsubscribe();
    // Give the aborted read's rejection a turn to (not) reach the handlers.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
