// Every filesystem location the server derives from its own install layout.
//
// This module must stay directly in `src/` so it compiles to `dist/paths.js`,
// a sibling of `dist/index.js`. Two runtimes resolve these paths and both have
// to land on the same directories:
//   * `node dist/index.js` — resolution is relative to this module's real
//     directory, so `resolve(moduleDir, '..', 'resources')` is only
//     `api/resources` while the compiled file sits directly in `dist/`. Move
//     this file to `src/config/` and a plain node run silently resolves
//     `dist/resources`, which does not exist.
//   * a pkg-packaged desktop binary — pkg's runtime reports the *entry file's*
//     directory as the ambient `__dirname` for every ESM module in the snapshot
//     (see pkgDirname.ts), which happens to be correct here precisely because
//     the entry point and this file share a directory.
// Nested modules (e.g. legacy/sqlite/connection.ts) must therefore never
// compute their own moduleDir; they derive paths from the constants here.

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { pkgSafeDirname } from './pkgDirname.js';
import { optional } from './config/env.js';

export const moduleDir = pkgSafeDirname(import.meta.url);

// pkg sets `process.pkg` inside a packaged desktop executable. There, the
// directory next to the binary isn't writable/persistent (and on macOS is
// inside the read-only app bundle), so user data moves to a per-user
// app-data directory — the same convention RDFCraft uses (`~/.rdfcraft`).
export const isPackaged = !!(process as unknown as { pkg?: unknown }).pkg;

function appDataDir(): string {
  if (process.platform === 'win32') {
    return resolve(process.env.APPDATA ?? resolve(homedir(), 'AppData', 'Roaming'), 'sulo-schema-builder');
  }
  return resolve(homedir(), '.sulo-schema-builder');
}

/**
 * Writable per-run state: the SQLite file, the downloaded ROBOT jar, the SULO
 * cache. A sibling `data/` dir of the api package normally (it survives
 * container restarts when mounted as a volume), the per-user app-data dir when
 * packaged as a desktop app.
 */
export const dataDir = isPackaged ? appDataDir() : resolve(moduleDir, '..', 'data');

/** Read-only assets shipped with the API: db-schema.sql, sulo.ttl, robot.jar. */
export const resourcesDir = resolve(moduleDir, '..', 'resources');

// Built frontend (frontend/dist), served directly by this server so a single
// process/container handles both the SPA and the API. Bundled as a pkg asset
// when packaged — readable at this same relative path without extraction,
// since only writes (the SQLite file) need a real path.
export const staticDir = optional('STATIC_DIR', resolve(moduleDir, '..', 'public'));
