// The report endpoints (spec §7): `GET .../report` at view level (anonymous
// on a public schema, same as every other view-level read) and
// `POST .../report/refresh` at edit level, quota-checked.
//
// Registered as a SIBLING of modules/schemas/routes.ts under the same
// /ontology-schemas prefix (see routes/v1/index.ts) — same arrangement as
// modules/acl/grants.routes.ts, and for the same reason this file registers
// `aclGuards` itself: `fastify-plugin` lets that plugin escape exactly one
// encapsulation level, so a sibling plugin tree does not inherit
// `request.schemaAccess`. Forgetting is SILENT (Fastify does not seal
// `request`), which is why routes.test.ts has a test — mirroring
// grants.test.ts's — that fails specifically if this registration is removed.
//
// `reason_state` alone cannot say "never checked": it is both the column's
// initial default AND the state of a schema edited since its last successful
// check, and those must not look the same to a client. Disambiguated on
// `latest_report_key` (see buildReportPayload below) — null means never
// checked (no `report` in the response at all); present means a report
// exists, which the `stale` boolean says predates the current content or not.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { DB, SchemaRow } from '../../db/types.js';
import { aclGuards, requireAccess } from '../acl/guards.js';
import type { RequestUser } from '../users/service.js';
import { checkNow } from './pipeline.js';
import { findReport } from './cache.js';

/** Same argument as modules/schemas/routes.ts's own requireUser/schemaAccess helpers. */
function requireUser(request: FastifyRequest): RequestUser {
  if (!request.user) throw new Error('route is missing the authRequired preHandler');
  return request.user;
}

function schemaAccess(request: FastifyRequest): NonNullable<FastifyRequest['schemaAccess']> {
  if (!request.schemaAccess) throw new Error('route is missing the requireAccess preHandler');
  return request.schemaAccess;
}

async function buildReportPayload(db: Kysely<DB>, schema: SchemaRow) {
  let report: unknown;
  let computedAt: string | null = null;

  if (schema.latest_report_key) {
    const stored = await findReport(db, schema.latest_report_key);
    if (stored) {
      report = stored.report;
      computedAt = stored.createdAt.toISOString();
    }
  }

  return {
    state: schema.reason_state,
    ...(report !== undefined ? { report } : {}),
    cacheKey: schema.latest_report_key ?? '',
    computedAt,
    // Only ever true alongside a report: it means "this verdict predates the
    // current content" (an edit landed after the check that produced it),
    // never "no verdict exists at all" — that case has no `report` key and
    // this is simply false.
    stale: schema.reason_state === 'stale' && report !== undefined,
  };
}

const reasoningRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(aclGuards);

  fastify.get('/:id/report', { preHandler: requireAccess('view') }, async (request) =>
    buildReportPayload(fastify.pg, schemaAccess(request).schema));

  fastify.post('/:id/report/refresh', { preHandler: requireAccess('edit') }, async (request, reply) => {
    const schema = schemaAccess(request).schema;

    // A no-op success, not a duplicate run: the content this would check is
    // exactly the content the current report already describes.
    if (schema.reason_state === 'fresh') {
      return reply.code(200).send({ outcome: 'already-fresh' });
    }

    const outcome = await checkNow({ db: fastify.pg }, schema.id, requireUser(request).id);
    switch (outcome.kind) {
      case 'quota-denied':
        return reply.code(429).send({
          error: 'quota_exceeded',
          message: 'Hourly consistency-check limit reached.',
          retryAfter: outcome.retryAfterSeconds,
        });
      case 'owl-too-large':
        return reply.code(422).send({
          error: 'owl_too_large',
          message: 'This schema is too large to check automatically on your tier.',
        });
      case 'no-schema':
        // The guard already loaded this row; reachable only if it was
        // deleted in the instant between that load and this call.
        return reply.notFound('Schema not found');
      default:
        return reply.code(202).send({ outcome: outcome.kind });
    }
  });
};

export default reasoningRoutes;
