// HTTP server settings and the storage-mode switch.

import { optional } from './env.js';
import { dataDir, isPackaged, resourcesDir, staticDir } from '../paths.js';

// 'postgres' is the multi-user web deployment; 'sqlite' is the frozen
// single-user desktop path. Packaged desktop builds are always 'sqlite'.
//
// Unrecognised values are fatal rather than a silent fallback: a web deployment
// that typo'd `postgress` would otherwise come up happily on a container-local
// SQLite file and lose every schema when the container is replaced.
function resolveStorage(): 'postgres' | 'sqlite' {
  const requested = optional('SCHEMA_STORAGE', 'sqlite');
  if (requested !== 'postgres' && requested !== 'sqlite') {
    throw new Error(
      `SCHEMA_STORAGE must be 'postgres' or 'sqlite', got '${requested}'.`,
    );
  }
  if (isPackaged && requested === 'postgres') {
    // No logger exists this early; this is a misconfiguration the user has to
    // see, and the packaged app writes stdout to its own log file.
    console.warn("SCHEMA_STORAGE=postgres ignored: packaged desktop builds always use sqlite.");
    return 'sqlite';
  }
  return requested;
}

export const storage: 'postgres' | 'sqlite' = resolveStorage();

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
