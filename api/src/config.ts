import 'dotenv/config';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { pkgSafeDirname } from './pkgDirname.js';

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const moduleDir = pkgSafeDirname(import.meta.url);

// pkg sets `process.pkg` inside a packaged desktop executable. There, the
// directory next to the binary isn't writable/persistent (and on macOS is
// inside the read-only app bundle), so user data moves to a per-user
// app-data directory — the same convention RDFCraft uses (`~/.rdfcraft`).
const isPackaged = !!(process as unknown as { pkg?: unknown }).pkg;

function appDataDir(): string {
  if (process.platform === 'win32') {
    return resolve(process.env.APPDATA ?? resolve(homedir(), 'AppData', 'Roaming'), 'sulo-schema-builder');
  }
  return resolve(homedir(), '.sulo-schema-builder');
}

const dataDir = isPackaged ? appDataDir() : resolve(moduleDir, '..', 'data');
// dist/config.js lives directly in dist/, so moduleDir-relative resolution
// is reliable here even inside a pkg snapshot (see pkgDirname.ts) — other,
// nested files (e.g. db/connection.ts) derive their resource paths from
// this instead of computing their own moduleDir.
const resourcesDir = resolve(moduleDir, '..', 'resources');

export const config = {
  env: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '3000'), 10),
  logLevel: optional('LOG_LEVEL', 'info'),
  isPackaged,
  appDataDir: dataDir,
  resourcesDir,

  db: {
    // Embedded SQLite database file. Defaults to a sibling `data/` dir of the
    // api package (survives container restarts when that dir is a volume
    // mount), or the per-user app-data dir when packaged as a desktop app.
    path: optional('DB_PATH', resolve(dataDir, 'sulo.db')),
  },

  // Built frontend (frontend/dist), served directly by this server so a
  // single process/container handles both the SPA and the API. Bundled as a
  // pkg asset when packaged — readable at this same relative path without
  // extraction, since only writes (the SQLite file above) need a real path.
  staticDir: optional('STATIC_DIR', resolve(moduleDir, '..', 'public')),

  rdf: {
    baseNamespace: optional('BASE_NAMESPACE', 'https://w3id.org/sulo/schema/'),
  },

  // Server-side full OWL DL reasoning via ROBOT + HermiT.
  reasoner: {
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
    // Full SULO ontology bundled with the API (../../resources/sulo.ttl from
    // dist/config.js). This is the offline fallback and first-launch seed; a
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
    // Max explanations to fetch per clash.
    maxExplanations: parseInt(optional('REASONER_MAX_EXPLANATIONS', '1'), 10),
  },

} as const;
