// One error handler for the whole server, so nothing a route throws can echo
// internals back to a client.
//
// Two shapes reach here regularly and neither carries a status code of its own,
// which means Fastify's default handler would answer 500 and serialize the
// error into the response body:
//   * a ZodError from a `Body.parse(request.body)` call — a client mistake, and
//     the raw issue array is noise to anyone but the developer;
//   * a database error (e.g. a foreign-key violation) — a 500 that must never
//     ship the constraint name, table name or SQL text to the caller.
// Errors that already know their status (@fastify/sensible's httpErrors,
// Fastify's own validation errors) are passed through unchanged so response
// bodies the frontend already parses keep their exact shape.

import fp from 'fastify-plugin';
import type { FastifyError } from 'fastify';
import { ZodError } from 'zod';

/** `path.to.field: message`, or just the message for a whole-body failure. */
function describe(error: ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

export default fp(async (fastify) => {
  fastify.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error instanceof ZodError) {
      request.log.info({ issues: error.issues }, 'request failed schema validation');
      return reply.badRequest(describe(error));
    }

    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) return reply.send(error);

    // Log the real error (stack, driver detail) and answer with none of it.
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(statusCode).send({
      error: 'internal_server_error',
      message: 'Internal Server Error',
    });
  });
});
