// Server-side full OWL DL reasoning via ROBOT + HermiT.

import { resolve } from 'node:path';
import { optional } from './env.js';
import { dataDir, isPackaged, resourcesDir } from '../paths.js';
import { storage } from './server.js';

export const reasonerConfig = {
  enabled: optional('REASONER_ENABLED', 'true') !== 'false',
  // Docker bundles a `robot` launcher script (JRE + robot.jar) on PATH.
  // Packaged builds have no such script, so they invoke `java -jar` on the
  // bundled resources/robot.jar directly instead (extracted to a real path
  // at runtime — see reasoner.service.ts — since the JVM can't open a file
  // through pkg's virtual filesystem).
  command: isPackaged ? optional('JAVA_PATH', 'java') : optional('ROBOT_PATH', 'robot'),
  baseArgs: isPackaged ? ['-Xmx2g', '-jar'] : ([] as string[]),
  // ROBOT jar. At ~91 MB it is far too large to embed in every packaged
  // binary for a feature not every user touches, so packaged builds download
  // it into the per-user app-data dir on first launch (robot.service.ts) and
  // verify it against the pinned digest below. Non-packaged runs keep using a
  // jar sitting in resources/, if one was placed there.
  robotJarPath: isPackaged ? resolve(dataDir, 'robot.jar') : resolve(resourcesDir, 'robot.jar'),
  robotVersion: '1.9.7',
  // sha256 of v1.9.7's robot.jar. ROBOT publishes no checksum file, so this
  // was computed once from the release asset; bump it with robotVersion.
  robotSha256: '91890c2e83d0f092dd08731376f154b36610544cfbe8685337a1bf7244ccaa2d',
  // Full SULO ontology bundled with the API (api/resources/sulo.ttl, resolved
  // through paths.ts). This is the offline fallback and first-launch seed; a
  // newer copy fetched from suloUrl lands in suloCachePath and wins when
  // present (sulo.service.ts). SULO_TTL_PATH overrides both.
  suloPath: optional('SULO_TTL_PATH', resolve(resourcesDir, 'sulo.ttl')),
  suloBundledPath: resolve(resourcesDir, 'sulo.ttl'),
  suloCachePath: resolve(dataDir, 'sulo.ttl'),
  suloUrl: optional('SULO_URL', 'https://w3id.org/sulo/'),
  // How long a SULO update check is considered fresh (ms). 24h.
  suloCheckIntervalMs: parseInt(optional('SULO_CHECK_INTERVAL_MS', String(24 * 60 * 60 * 1000)), 10),
  // Hard cap on a single reasoning run (ms).
  timeoutMs: parseInt(optional('REASONER_TIMEOUT_MS', '60000'), 10),
  // How many reasoning runs may execute at once. Each run spawns a JVM, so
  // on a shared web deployment this is the lever that keeps N students
  // clicking "Check consistency" from OOMing the host. Excess requests wait
  // in a short queue (reasoner.service.ts) and overflow is rejected.
  maxConcurrent: parseInt(optional('REASONER_MAX_CONCURRENT', '1'), 10),
  maxQueue: parseInt(optional('REASONER_MAX_QUEUE', '8'), 10),
  // Upper bound on the submitted Turtle. A hand-built schema is a few hundred
  // KB at most. The multi-user web deployment caps lower than the desktop
  // path, matching the free tier's ceiling in the design doc §6 — one shared
  // host reasoning for N users cannot afford desktop-sized inputs.
  maxInputBytes: parseInt(
    optional('REASONER_MAX_INPUT_BYTES', storage === 'postgres' ? '1000000' : '5000000'),
    10,
  ),
  // Max explanations to fetch per clash.
  maxExplanations: parseInt(optional('REASONER_MAX_EXPLANATIONS', '1'), 10),
} as const;
