// HTTP server settings and the storage-mode switch.

import { optional } from './env.js';
import { dataDir, isPackaged, resourcesDir, staticDir } from '../paths.js';

// 'postgres' is the multi-user web deployment; 'sqlite' is the frozen
// single-user desktop path. Packaged desktop builds are always 'sqlite'.
//
// Order matters. The packaged branch comes FIRST because a packaged build has
// no legitimate way to act on this variable at all, and validating before
// forcing made a stray value fatal to the desktop app: README's Postgres dev
// instructions tell a developer to `export SCHEMA_STORAGE=postgres`, and the
// Tauri shell spawns the sidecar with the environment it inherited, so
// launching the app from that shell threw here at import time. The process
// exited before it could listen, Tauri's wait_for_port timed out, and the only
// evidence was a line in the app-data log.
//
// For every non-packaged run an unrecognised value stays fatal rather than a
// silent fallback: a web deployment that typo'd `postgress` would otherwise come
// up happily on a container-local SQLite file and lose every schema when the
// container is replaced.
//
// `isPackaged` is a parameter rather than a module read because `process.pkg`
// cannot be mocked through the environment, and the packaged branch is exactly
// the one that broke.
export function resolveStorage(requested: string, packaged: boolean): 'postgres' | 'sqlite' {
  if (packaged) {
    if (requested !== 'sqlite') {
      // No logger exists this early; this is a misconfiguration the user has to
      // see, and the packaged app writes stdout to its own log file.
      console.warn(
        `SCHEMA_STORAGE=${requested} ignored: packaged desktop builds always use sqlite.`,
      );
    }
    return 'sqlite';
  }
  if (requested !== 'postgres' && requested !== 'sqlite') {
    throw new Error(
      `SCHEMA_STORAGE must be 'postgres' or 'sqlite', got '${requested}'.`,
    );
  }
  return requested;
}

export const storage: 'postgres' | 'sqlite' = resolveStorage(
  optional('SCHEMA_STORAGE', 'sqlite'),
  isPackaged,
);

// Per-IP rate limiting. Pointless on the desktop app (loopback, one user) and
// actively unhelpful there; on by default everywhere else.
const rateLimitEnabled = !isPackaged && optional('RATE_LIMIT_ENABLED', 'true') !== 'false';

export const serverConfig = {
  env: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '3000'), 10),
  // Loopback by default. The desktop app's webview connects over 127.0.0.1, so
  // binding wider gains nothing there and costs two things: the OS asks the
  // user to approve incoming connections on first launch (Windows Firewall,
  // macOS's "accept incoming network connections?"), and the REST API — with
  // no auth in front of it — becomes reachable by anything on the same
  // network. Deployments that must be reachable from another machine set
  // HOST=0.0.0.0 explicitly; the Docker image and compose file both do.
  host: optional('HOST', '127.0.0.1'),
  logLevel: optional('LOG_LEVEL', 'info'),
  isPackaged,
  storage,
  rateLimitEnabled,
  appDataDir: dataDir,
  resourcesDir,
  staticDir,
} as const;
