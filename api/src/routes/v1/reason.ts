import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { reasonOntologyDL, ReasonerUnavailableError } from '../../services/reasoner.service.js';

const ReasonBody = z.object({
  // The OWL Turtle to check (frontend sends generateExports().turtleOwl).
  turtle: z.string().min(1).max(5_000_000),
});

const reasonRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /reason/status — lets the UI decide whether to offer the server check.
  fastify.get('/status', async () => ({ enabled: config.reasoner.enabled, reasoner: 'HermiT' }));

  // POST /reason — run a full OWL DL consistency check (SULO + user OWL via HermiT).
  fastify.post('/', async (request, reply) => {
    const { turtle } = ReasonBody.parse(request.body);
    try {
      const report = await reasonOntologyDL(turtle);
      return reply.send(report);
    } catch (err) {
      if (err instanceof ReasonerUnavailableError) {
        return reply.code(503).send({ error: 'reasoner_unavailable', message: err.message });
      }
      // A non-zero ROBOT exit usually means a malformed ontology / parse error.
      request.log.error({ err }, 'reasoner failed');
      const stderr = (err as { stderr?: string }).stderr;
      return reply.code(422).send({
        error: 'reasoning_failed',
        message: 'The reasoner could not process this ontology.',
        detail: stderr?.slice(0, 2000),
      });
    }
  });
};

export default reasonRoutes;
