// The client half of spec §8's change publication: a live subscription to
// one schema's SSE stream (api/src/modules/events/sse.ts).
//
// `fetch` + `ReadableStream`, deliberately never `EventSource` — the
// platform's own built-in SSE client cannot set request headers at all, and
// this stream needs `Authorization` the same way every other authenticated
// request does. The alternative, a token in the URL's query string, writes
// credentials into every access log and proxy log between here and the
// server; api/src/modules/events/sse.ts's own header makes the same
// argument from the server side.
//
// The payload is a HINT ONLY (`{ schemaId, kind, at }`, spec §8) — this
// module never reads anything out of it beyond deciding *that* something
// changed. The caller (report.ts) reacts by refetching through the
// ACL-checked endpoint it already polls, never by trusting this payload's
// shape or contents.

import { apiClient, authHeader } from './client.js';

export interface SchemaChangedEvent {
  schemaId: string;
  kind: 'mutated' | 'report';
  at: string;
}

export interface SubscribeToSchemaOptions {
  /** A real event arrived — the caller should refetch. */
  onEvent: (event: SchemaChangedEvent) => void;
  /** The stream ended or never connected — the caller should fall back to polling. */
  onError: () => void;
  /** The connection is confirmed open — the caller may stop polling. */
  onOpen?: () => void;
}

/**
 * Subscribes to `schemaId`'s change stream. Returns an unsubscribe function
 * that aborts the underlying fetch — call it on unmount, or the connection
 * (and the server-side handler holding it open) leaks for as long as the
 * page lives.
 *
 * Never throws: every failure mode (a non-2xx response, a network error, the
 * stream ending on its own) reaches the caller through `onError`, exactly
 * like a proxy silently blocking the connection would — from here, the two
 * are indistinguishable, and both mean "fall back to polling."
 */
export function subscribeToSchema(schemaId: string, opts: SubscribeToSchemaOptions): () => void {
  const controller = new AbortController();

  (async () => {
    let response: Response;
    try {
      const headers = await authHeader();
      response = await fetch(`${apiClient.defaults.baseURL}/ontology-schemas/${schemaId}/events`, {
        headers, signal: controller.signal,
      });
    } catch {
      if (!controller.signal.aborted) opts.onError();
      return;
    }

    if (!response.ok || !response.body) {
      if (!controller.signal.aborted) opts.onError();
      return;
    }

    opts.onOpen?.();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary: number;
        // eslint-disable-next-line no-cond-assign
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          handleMessage(raw, opts.onEvent);
        }
      }
    } catch {
      // A read error mid-stream (the connection dropped) — fall through to
      // the same "stream ended" handling below rather than a separate branch.
    }

    // The stream ended — either the server closed it or the connection
    // dropped. Not an error if WE closed it (unsubscribe called controller.abort()).
    if (!controller.signal.aborted) opts.onError();
  })();

  return () => controller.abort();
}

/** A `: comment` (including the keep-alive) carries no `data:` line and is silently skipped. */
function handleMessage(raw: string, onEvent: (event: SchemaChangedEvent) => void): void {
  const dataLine = raw.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) return;
  try {
    onEvent(JSON.parse(dataLine.slice('data:'.length).trim()) as SchemaChangedEvent);
  } catch {
    // Malformed payload — nothing to act on, and this module never trusts
    // the payload's contents beyond "something happened" regardless.
  }
}
