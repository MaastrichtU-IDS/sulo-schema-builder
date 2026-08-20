import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../../config/index.js';
import { reasonOntologyDL, ReasonerBusyError, ReasonerUnavailableError } from '../../services/reasoner.service.js';
import { invalidateJavaCache, probeJava, resolveJava } from '../../services/java.service.js';
import { ensureRobotJar, getRobotStatus } from '../../services/robot.service.js';
import { checkForSuloUpdate, getSuloStatus } from '../../services/sulo.service.js';
import { setSetting, SETTING_JAVA_PATH } from '../../legacy/sqlite/settings.js';

const ReasonBody = z.object({
  // The OWL Turtle to check (frontend sends generateExports().turtleOwl).
  // Web deployments cap this far lower than desktop (config.reasoner.maxInputBytes).
  turtle: z.string().min(1).max(config.reasoner.maxInputBytes),
});

const JavaPathBody = z.object({
  path: z.string().min(1),
});

/**
 * Whether this deployment manages its own reasoning toolchain.
 *
 * Docker bakes a JRE and a `robot` launcher into the image, and local dev
 * expects `robot` on PATH — in both, Java and ROBOT are the environment's
 * business and the UI should just show the check button. Only packaged desktop
 * builds discover a JVM and download the jar themselves, and only there does
 * the setup UI have anything to offer.
 */
const managed = config.isPackaged;

async function buildStatus() {
  if (!managed) {
    return {
      enabled: config.reasoner.enabled,
      reasoner: 'HermiT',
      managed,
      java: { available: true },
      robot: { state: 'ready' as const, version: config.reasoner.robotVersion },
      sulo: getSuloStatus(),
    };
  }

  const java = await resolveJava();
  return {
    enabled: config.reasoner.enabled,
    reasoner: 'HermiT',
    managed,
    java: {
      available: java.available,
      ...(java.path && java.available ? { path: java.path } : {}),
      ...(java.version ? { version: java.version } : {}),
      ...(java.versionString ? { versionString: java.versionString } : {}),
      ...(java.reason ? { reason: java.reason } : {}),
      ...(java.detail ? { detail: java.detail } : {}),
    },
    robot: getRobotStatus(),
    sulo: getSuloStatus(),
  };
}

const reasonRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /reason/status — lets the UI decide what to offer: the check button, a
  // "install Java" prompt, download progress, or a retry.
  //
  // Deliberately unguarded: the SPA renders its setup/capability state before
  // the user has signed in, and this answers with nothing caller-specific —
  // whether the reasoner is enabled, which ROBOT version, whether a JVM was
  // found. The two routes that actually *spend* reasoner time are guarded below.
  fastify.get('/status', async () => buildStatus());

  // POST /reason/java-path — point the app at an existing JVM.
  // Probed before it is persisted, so a bad path comes back with a reason
  // instead of being stored and failing later at reasoning time.
  fastify.post('/java-path', async (request, reply) => {
    // Desktop-only setup: everywhere else the JVM comes with the environment,
    // and on a shared web server this must not be settable by visitors.
    if (!managed) {
      return reply.code(403).send({ error: 'not_managed', message: 'The Java path is managed by the environment here.' });
    }
    const { path } = JavaPathBody.parse(request.body);
    const result = await probeJava(path.trim());

    if (!result.available) {
      return reply.code(400).send({
        error: 'java_unusable',
        reason: result.reason,
        message: result.detail ?? `Could not use ${path} as a Java runtime.`,
      });
    }

    setSetting(SETTING_JAVA_PATH, path.trim());
    invalidateJavaCache();
    return buildStatus();
  });

  // POST /reason/robot/download — retry a failed or not-yet-started download.
  fastify.post('/robot/download', async () => {
    if (managed) ensureRobotJar().catch(() => { /* surfaced via status */ });
    return buildStatus();
  });

  // POST /reason/sulo/check — force a SULO update check, ignoring the interval.
  // Guarded: it bypasses the interval and makes the server fetch the upstream
  // ontology, so an anonymous caller could hammer it. (/java-path and
  // /robot/download need no guard — both already 403 unless `managed`.)
  fastify.post('/sulo/check', { preHandler: fastify.authRequired }, async () => {
    await checkForSuloUpdate(true);
    return buildStatus();
  });

  // POST /reason — run a full OWL DL consistency check (SULO + user OWL via HermiT).
  // Guarded (design §5): a reasoning run is the most expensive thing this
  // server does, and an anonymous caller can never trigger one.
  fastify.post('/', {
    preHandler: fastify.authRequired,
    config: {
      // Enforced whenever config.rateLimitEnabled registers the plugin.
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
  }, async (request, reply) => {
    const { turtle } = ReasonBody.parse(request.body);
    try {
      const report = await reasonOntologyDL(turtle);
      return reply.send(report);
    } catch (err) {
      if (err instanceof ReasonerBusyError) {
        return reply.code(429).send({ error: 'reasoner_busy', message: err.message });
      }
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
