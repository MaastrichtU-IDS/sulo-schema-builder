// The SSE route's interesting failures are all about time and connection
// lifecycle, not request/response shape — see the module header for why
// each required case here earns its own test rather than being folded into
// one big scenario.
//
// The routes are mounted exactly as routes/v1/index.ts mounts them (schema
// and sse trees sharing /ontology-schemas), so the sibling `aclGuards`
// registration this arrangement requires is exercised rather than assumed —
// same convention as grants.test.ts and reasoning/routes.test.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyPluginAsync } from 'fastify';
import sensible from '@fastify/sensible';
import type { LightMyRequestResponse } from 'fastify';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import { buildAuthedApp, type AuthedTestApp } from '../../test/authApp.js';
import errorHandler from '../../plugins/errorHandler.js';
import schemasRoutes from '../schemas/routes.js';
import { stopPendingChecks } from '../reasoning/pipeline.js';
import { startListener, stopListener, subscriberCount, LISTENER_APPLICATION_NAME } from './listener.js';
import sseRoutes from './sse.js';

const apiRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(schemasRoutes, { prefix: '/ontology-schemas' });
  await fastify.register(sseRoutes, { prefix: '/ontology-schemas' });
};

let t: TestDb;
let harness: AuthedTestApp;

beforeAll(async () => {
  t = await startTestDb();
  harness = await buildAuthedApp(t.db, { routes: apiRoutes, prefix: '' });
  await startListener({ url: t.connectionString });
});

afterAll(async () => {
  await stopListener();
  stopPendingChecks();
  await harness.close();
  await t.stop();
});

beforeEach(async () => { await truncateAll(t.db); });

async function newSchema(visibility: 'private' | 'public' = 'private'): Promise<string> {
  const res = await harness.inject({ method: 'POST', url: '/ontology-schemas', payload: { title: 'SSE fixture' } });
  expect(res.statusCode).toBe(201);
  const id = res.json().id;
  if (visibility !== 'private') {
    await t.db.updateTable('schemas').set({ visibility }).where('id', '=', id).execute();
  }
  return id;
}

/**
 * Wraps a payloadAsStream response into an async reader over discrete SSE
 * messages (split on the blank line every event/comment ends with).
 *
 * `abort` is what actually simulates "the client went away": light-my-
 * request's mock request object is never exposed on `res.raw.req` for a
 * streaming response (only its non-streaming completion path sets that),
 * so destroying the response stream from this side stops US reading, but
 * never reaches the SERVER's `request.raw`, which is what the route's own
 * cleanup listens on. `stream.addAbortSignal` (wired in via inject's own
 * `signal` option) is the one documented way light-my-request lets a test
 * destroy the REQUEST side, at a moment of the test's choosing rather than
 * whenever the mock's internal read-loop happens to finish.
 */
function sseReader(res: LightMyRequestResponse, abort: () => void) {
  const stream = res.stream();
  let buffer = '';
  const queued: string[] = [];
  const waiters: Array<(msg: string) => void> = [];

  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    // eslint-disable-next-line no-cond-assign
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const message = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else queued.push(message);
    }
  });

  return {
    next(timeoutMs = 5000): Promise<string> {
      const queuedMsg = queued.shift();
      if (queuedMsg !== undefined) return Promise.resolve(queuedMsg);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for an SSE message')), timeoutMs);
        waiters.push((msg) => { clearTimeout(timer); resolve(msg); });
      });
    },
    close(): void {
      abort();
      stream.destroy();
    },
  };
}

async function openStream(url: string, headers?: Record<string, string>, appOverride?: AuthedTestApp['app']) {
  const controller = new AbortController();
  const app = appOverride ?? harness.app;
  const res = await app.inject({ method: 'GET', url, headers, payloadAsStream: true, signal: controller.signal });
  return { res, reader: sseReader(res, () => controller.abort()) };
}

describe('GET /:id/events', () => {
  it('a stranger (anonymous, private schema) gets 404, identical to a nonexistent id', async () => {
    const schemaId = await newSchema('private');
    const real = await harness.app.inject({ method: 'GET', url: `/ontology-schemas/${schemaId}/events` });
    const ghost = await harness.app.inject({ method: 'GET', url: '/ontology-schemas/99999999-9999-9999-9999-999999999999/events' });
    expect(real.statusCode).toBe(404);
    expect(ghost.statusCode).toBe(404);
    expect(real.json()).toEqual(ghost.json());
  });

  it('an anonymous caller is a first-class subscriber on a public schema', async () => {
    const schemaId = await newSchema('public');
    const { res, reader } = await openStream(`/ontology-schemas/${schemaId}/events`);
    try {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      // The connect-time comment (':ok'), proving the stream is genuinely
      // open before any real event.
      await expect(reader.next()).resolves.toContain(':ok');
    } finally {
      reader.close();
    }
  });

  it('a subscriber receives an event after a mutation to ITS schema, and not after a mutation to a different one', async () => {
    // Public, so the subscribing connection (opened with the bare
    // `harness.app.inject`, not the bearer-attaching `harness.inject`
    // wrapper — payloadAsStream needs the former) needs no auth of its own.
    const schemaId = await newSchema('public');
    const otherSchemaId = await newSchema('public');
    const { reader } = await openStream(`/ontology-schemas/${schemaId}/events`);
    await reader.next(); // the connect-time ':ok'

    // A mutation to the OTHER schema must not appear on this stream.
    await harness.inject({ method: 'POST', url: `/ontology-schemas/${otherSchemaId}/classes`, payload: { name: 'Elsewhere' } });

    // A mutation to THIS schema must.
    await harness.inject({ method: 'POST', url: `/ontology-schemas/${schemaId}/classes`, payload: { name: 'HereToo' } });
    const message = await reader.next();
    expect(message).toContain('data:');
    const payload = JSON.parse(message.replace(/^data:\s*/, ''));
    expect(payload).toMatchObject({ schemaId, kind: 'mutated' });

    reader.close();
  });

  it('a disconnected client is cleaned up: the subscriber count returns to zero', async () => {
    const schemaId = await newSchema('public');
    expect(subscriberCount(schemaId)).toBe(0);

    const { reader } = await openStream(`/ontology-schemas/${schemaId}/events`);
    await reader.next(); // wait for the connection to actually be established
    expect(subscriberCount(schemaId)).toBe(1);

    reader.close();
    // The server's 'close' handler runs asynchronously relative to the
    // client-side stream.destroy() above.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(subscriberCount(schemaId)).toBe(0);
  });

  it('sends a periodic keep-alive comment', async () => {
    const schemaId = await newSchema('public');

    // A dedicated app (not the shared `harness`), registering sse.ts with a
    // fast keepAliveMs override so this test does not wait out the real
    // 20s default — but with the REAL auth plugin underneath, via
    // buildAuthedApp, since aclGuards' decorator prerequisites
    // (`user`, `authError`) come from plugins/auth.ts, never from
    // plugins/authDisabled.ts's no-ops, and the two are never combined in
    // any real deployment mode.
    const fastKeepAlive: FastifyPluginAsync = async (fastify) => {
      await fastify.register(sseRoutes, { prefix: '/ontology-schemas', keepAliveMs: 50 });
    };
    const fastHarness = await buildAuthedApp(t.db, { routes: fastKeepAlive, prefix: '' });
    try {
      const { reader } = await openStream(`/ontology-schemas/${schemaId}/events`, undefined, fastHarness.app);
      try {
        await reader.next(); // ':ok'
        const keepAlive = await reader.next(500);
        expect(keepAlive.trim()).toBe(': keep-alive');
      } finally {
        reader.close();
      }
    } finally {
      await fastHarness.close();
    }
  });

  it('the listener reconnects after its connection is dropped, and a later notification still arrives', async () => {
    const schemaId = await newSchema('public');
    const { reader } = await openStream(`/ontology-schemas/${schemaId}/events`);
    await reader.next(); // ':ok'

    const before = await t.pool.query(
      "select pid from pg_stat_activity where application_name = $1", [LISTENER_APPLICATION_NAME],
    );
    expect(before.rows.length, 'the listener\'s own backend should be visible in pg_stat_activity').toBe(1);
    await t.pool.query('select pg_terminate_backend($1)', [before.rows[0].pid]);

    // Give the reconnect loop a moment (INITIAL_RECONNECT_DELAY_MS plus the
    // connect + LISTEN round trip) before proving it actually came back.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const after = await t.pool.query(
      "select pid from pg_stat_activity where application_name = $1", [LISTENER_APPLICATION_NAME],
    );
    expect(after.rows.length).toBe(1);
    expect(after.rows[0].pid).not.toBe(before.rows[0].pid);

    await harness.inject({ method: 'POST', url: `/ontology-schemas/${schemaId}/classes`, payload: { name: 'AfterReconnect' } });
    const message = await reader.next(5000);
    expect(message).toContain('data:');
    const payload = JSON.parse(message.replace(/^data:\s*/, ''));
    expect(payload).toMatchObject({ schemaId });

    reader.close();
  });
});

// Mirrors grants.test.ts's own version of this test: `fastify-plugin` lets
// aclGuards escape exactly one encapsulation level, so a plugin tree
// registering this file's routes as a sibling does not inherit the
// decorator — this file has to register aclGuards itself. Forgetting is
// otherwise silent (Fastify does not seal `request`), so this is the one
// test that actually fails if the registration is removed.
describe('the aclGuards registration this plugin owns', () => {
  it('refuses to boot on an instance without the auth plugin request decorators', async () => {
    const app = Fastify();
    await app.register(sensible);
    await app.register(errorHandler);
    app.decorate('pg', t.db);
    app.register(sseRoutes, { prefix: '/ontology-schemas' });

    await expect(app.ready().then(() => 'booted')).rejects.toThrow(/user/);
    await app.close();
  });
});
