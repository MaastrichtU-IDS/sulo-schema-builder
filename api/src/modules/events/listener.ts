// One dedicated `pg.Client` per API process holds `LISTEN schema_changed`
// for the process's whole lifetime (spec §8) and fans out in-process to
// whatever `subscribe()` has registered — never a connection borrowed from
// the Kysely pool, which would otherwise block a pool slot forever, and
// never Kysely itself, which has no long-lived listener API.
//
// INVARIANT: this module is loaded with a dynamic `import()` from
// server.ts's postgres branch, never a static one — it is a raw `pg.Client`,
// a real value the packaged desktop binary's shared import graph must never
// see reachable (see notify.ts's header for the fuller version of this
// argument; this module is the other place it applies, and unlike
// notify.ts it is never called from a file already on that graph, so there
// is no dynamic-import call site to point to here — server.ts's is it).
//
// RECONNECTION IS NOT OPTIONAL. A `pg` client that loses its socket does not
// resubscribe itself — it just goes quiet. Without the retry loop below,
// one blip (a Postgres restart, a network hiccup) would silently and
// permanently stop every "your schema changed" event for the rest of the
// process's life, and the UI would look fine while being wrong: sse.ts's
// keep-alive comment keeps every open connection *looking* healthy, so
// nothing downstream would ever notice.

import { Client } from 'pg';
import { config } from '../../config/index.js';
import { SCHEMA_CHANGED_CHANNEL, type SchemaChangedPayload } from './notify.js';

export type ChangeHandler = (payload: SchemaChangedPayload) => void;

/** schemaId -> the handlers currently subscribed to it. */
const subscribers = new Map<string, Set<ChangeHandler>>();

let client: Client | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let stopped = true;
let reconnectDelayMs = 0;

const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Set on every connection so a test (or an operator at a psql prompt) can
 * find and terminate exactly this backend without guessing which one it is
 * among the pool's other connections — `select pg_terminate_backend(pid)
 * from pg_stat_activity where application_name = 'sulo-events-listener'`.
 * Exported so sse.test.ts's reconnect case does exactly that rather than
 * duplicating the literal.
 */
export const LISTENER_APPLICATION_NAME = 'sulo-events-listener';

function fanOut(payload: SchemaChangedPayload): void {
  const handlers = subscribers.get(payload.schemaId);
  if (!handlers || handlers.size === 0) return;
  for (const handler of handlers) handler(payload);
}

function scheduleReconnect(url: string): void {
  if (stopped || reconnectTimer) return;
  reconnectDelayMs = reconnectDelayMs === 0
    ? INITIAL_RECONNECT_DELAY_MS
    : Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect(url).catch((err) => {
      console.error('[events] listener reconnect failed', err);
      scheduleReconnect(url);
    });
  }, reconnectDelayMs).unref(); // never the reason a process (or a test) fails to exit
}

/** Fresh client, LISTENing, wired to reconnect on loss. Resolves once LISTEN is confirmed. */
async function connect(url: string): Promise<void> {
  const c = new Client({ connectionString: url, application_name: LISTENER_APPLICATION_NAME });

  // A connection can die via 'error' (the socket itself failing) or a clean
  // 'end' (the server closing it, e.g. pg_terminate_backend) without a
  // preceding 'error' — both mean the same thing here, and each must
  // trigger reconnect exactly once, not twice for the same loss.
  let handled = false;
  const onLost = () => {
    if (handled) return;
    handled = true;
    if (client === c) client = undefined;
    if (!stopped) scheduleReconnect(url);
  };
  c.on('error', (err) => {
    console.error('[events] listener connection error', err);
    onLost();
  });
  c.on('end', onLost);

  c.on('notification', (msg) => {
    if (msg.channel !== SCHEMA_CHANGED_CHANNEL || !msg.payload) return;
    try {
      fanOut(JSON.parse(msg.payload) as SchemaChangedPayload);
    } catch (err) {
      console.error('[events] malformed notification payload, dropped', err);
    }
  });

  await c.connect();
  await c.query(`LISTEN ${SCHEMA_CHANGED_CHANNEL}`);
  client = c;
  reconnectDelayMs = 0; // a successful connect resets backoff for the NEXT loss
}

export interface ListenerOptions {
  /** Test seam: point at a different database than config.postgres.url. */
  url?: string;
}

/** Starts the process-wide LISTEN. Idempotent-ish: call once, from server.ts's postgres branch. */
export async function startListener(opts: ListenerOptions = {}): Promise<void> {
  stopped = false;
  reconnectDelayMs = 0;
  await connect(opts.url ?? config.postgres.url);
}

/** Stops the listener, cancels any pending reconnect, and drops every subscriber. */
export async function stopListener(): Promise<void> {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  const c = client;
  client = undefined;
  subscribers.clear();
  if (c) {
    // 'end' still fires on a client we are deliberately closing — `stopped`
    // is already true by the time it does, so onLost's guard is what keeps
    // this from scheduling a pointless reconnect.
    await c.end().catch(() => { /* already gone; nothing to clean up */ });
  }
}

/** Subscribes `handler` to `schemaId`'s changes. Returns an unsubscribe function. */
export function subscribe(schemaId: string, handler: ChangeHandler): () => void {
  let handlers = subscribers.get(schemaId);
  if (!handlers) {
    handlers = new Set();
    subscribers.set(schemaId, handlers);
  }
  handlers.add(handler);

  return () => {
    const current = subscribers.get(schemaId);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) subscribers.delete(schemaId);
  };
}

/** Test/observability seam: total subscriber count, or just `schemaId`'s. */
export function subscriberCount(schemaId?: string): number {
  if (schemaId !== undefined) return subscribers.get(schemaId)?.size ?? 0;
  let total = 0;
  for (const handlers of subscribers.values()) total += handlers.size;
  return total;
}
