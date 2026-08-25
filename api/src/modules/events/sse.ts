// GET /:id/events — SSE, gated by the same view-level ACL every other read
// on a schema goes through (spec §8). An anonymous reader of a public
// schema is a first-class subscriber here, exactly as it is on
// GET .../report; a private schema answers 404, identical to a nonexistent
// id — requireAccess gives this for free at CONNECT time, but an SSE route
// authorises once and then holds the connection open for as long as the
// client wants, which is a different animal from an ordinary
// request/response route, so sse.test.ts asserts it directly rather than
// trusting the guard by inference.
//
// Registered as a SIBLING of modules/schemas/routes.ts under the same
// /ontology-schemas prefix (see routes/v1/index.ts) — same arrangement as
// modules/reasoning/routes.ts, and for the same reason this file registers
// `aclGuards` itself: `fastify-plugin` lets that plugin escape exactly one
// encapsulation level, so a sibling plugin tree does not inherit
// `request.schemaAccess`. Forgetting is SILENT (Fastify does not seal
// `request`), which is why sse.test.ts has a test — mirroring
// grants.test.ts's — that fails specifically if this registration is
// removed.
//
// INVARIANT: this file is reachable from routes/v1/index.ts in every
// storage mode (it is registered unconditionally there, the same way
// reasoning/routes.ts is), so it must never statically import listener.ts
// — that module holds a real `pg.Client` value. `events()` below is the
// only way this file touches it, loaded with a dynamic `import()` inside
// the route handler that needs it, mirroring reasoning/pipeline.ts's
// `queueRepo()`/`eventsNotify()`.

import type { FastifyPluginAsync, FastifyPluginOptions, FastifyRequest } from 'fastify';
import { config } from '../../config/index.js';
import { aclGuards, requireAccess } from '../acl/guards.js';

function events(): Promise<typeof import('./listener.js')> {
  return import('./listener.js');
}

/** Same argument as modules/schemas/routes.ts's own schemaAccess helper. */
function schemaAccess(request: FastifyRequest): NonNullable<FastifyRequest['schemaAccess']> {
  if (!request.schemaAccess) throw new Error('route is missing the requireAccess preHandler');
  return request.schemaAccess;
}

export interface SseOptions extends FastifyPluginOptions {
  /** Test seam: a fast keep-alive so a suite does not wait 20s for one. Production never sets this. */
  keepAliveMs?: number;
}

const sseRoutes: FastifyPluginAsync<SseOptions> = async (fastify, opts) => {
  await fastify.register(aclGuards);

  fastify.get('/:id/events', { preHandler: requireAccess('view') }, async (request, reply) => {
    const schemaId = schemaAccess(request).schema.id;
    const { subscribe } = await events();

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disables response buffering on an nginx (or nginx-compatible) proxy
      // sitting in front of this server — otherwise SSE chunks can sit
      // unflushed until the proxy's own buffer fills, and the client sees
      // nothing for minutes at a time. A no-op, harmless header everywhere
      // else.
      'X-Accel-Buffering': 'no',
    });
    // Flushes the headers immediately and confirms to the client (and to
    // this route's own tests) that the stream is open, before the first
    // real event or keep-alive.
    reply.raw.write(':ok\n\n');

    const send = (payload: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const unsubscribe = subscribe(schemaId, send);

    const keepAliveMs = opts.keepAliveMs ?? config.events.sseKeepAliveMs;
    const keepAlive = setInterval(() => {
      reply.raw.write(': keep-alive\n\n');
    }, keepAliveMs);
    // Never the reason a test process (or, in principle, this server) fails
    // to exit — the real cleanup path is the 'close' handler below, which
    // fires long before process shutdown in every real scenario.
    keepAlive.unref();

    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });
};

export default sseRoutes;
