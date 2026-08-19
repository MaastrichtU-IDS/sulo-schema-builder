import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// pkg's own runtime defines `__dirname` as an ambient CJS-style global for
// every module inside its snapshot, regardless of source syntax. Gate on
// `process.pkg` too (only pkg's runtime sets it) — some test runners also
// define an ambient `__dirname`, so `typeof __dirname` alone is a false
// positive there.
//
// Known pkg bug (verified empirically): that ambient `__dirname` is the
// *entry file's* directory for every ESM module in the snapshot, not each
// file's own directory — e.g. dist/legacy/sqlite/connection.js still gets
// dist/, not dist/legacy/sqlite/. Since dist/index.js and dist/paths.js both
// live directly in dist/, calling this from paths.ts happens to be correct;
// anything nested deeper (like legacy/sqlite/connection.ts) must NOT call this
// itself — derive paths from paths.ts's already-correct base instead.
declare const __dirname: string | undefined;

export function pkgSafeDirname(moduleUrl: string): string {
  if ((process as unknown as { pkg?: unknown }).pkg && typeof __dirname !== 'undefined') {
    return __dirname;
  }
  return dirname(fileURLToPath(moduleUrl));
}
