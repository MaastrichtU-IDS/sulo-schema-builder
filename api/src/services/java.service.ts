// Locates a usable JVM for the ROBOT reasoner.
//
// The packaged desktop app ships no JRE, so this has to find whatever the user
// already has — and "find java" is deceptively unreliable on desktop:
//
//   * macOS ships a /usr/bin/java *stub* even with no JDK installed. Any
//     `which java` / existsSync() check is a false positive there, so every
//     candidate is verified by actually running it and checking the exit code.
//     Probing /usr/libexec/java_home before falling back to PATH also avoids
//     the stub popping its "No Java runtime present" install dialog.
//   * GUI apps don't inherit the shell PATH. An app launched from Finder, the
//     Dock or the Start Menu never sources .zshrc, so a JVM installed via
//     Homebrew/SDKMAN/asdf is invisible even though `java -version` works fine
//     in the user's terminal. The JAVA_HOME and java_home steps recover those.
//
// When nothing is found the user can supply a path explicitly; it is probed
// before being persisted, so a bad path is rejected with a reason rather than
// silently stored.

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { getSetting, SETTING_JAVA_PATH } from '../legacy/sqlite/settings.js';

/** ROBOT 1.9.x requires Java 11 or newer. */
export const MIN_JAVA_MAJOR = 11;

const PROBE_TIMEOUT_MS = 5_000;

export type JavaUnavailableReason = 'not_found' | 'too_old' | 'error';

export interface JavaResult {
  available: boolean;
  /** Absolute path or bare command that resolved, when available. */
  path?: string;
  /** Major version (8, 11, 21, …) — set whenever a version could be read. */
  version?: number;
  /** Raw version string as reported by the JVM, e.g. "21.0.2". */
  versionString?: string;
  reason?: JavaUnavailableReason;
  detail?: string;
}

/**
 * Extract the major version from `java -version` output.
 *
 * Handles the modern form (`openjdk version "21.0.2" 2024-01-16` → 21) and the
 * legacy 1.x form (`java version "1.8.0_392"` → 8), plus pre-release suffixes
 * like "21-ea".
 */
export function parseJavaVersion(output: string): number | null {
  const match = /version "([^"]+)"/.exec(output);
  if (!match) return null;

  const segments = match[1].split(/[._\-+]/);
  const first = Number(segments[0]);
  if (!Number.isInteger(first)) return null;

  // "1.8.0_392" — the major version is the second segment, not the first.
  if (first === 1) {
    const second = Number(segments[1]);
    return Number.isInteger(second) ? second : null;
  }
  return first;
}

export function javaBinaryName(): string {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

function run(command: string, args: string[]): Promise<{ ok: boolean; output: string; code?: string }> {
  return new Promise((res) => {
    execFile(command, args, { timeout: PROBE_TIMEOUT_MS }, (err, stdout, stderr) => {
      // `java -version` writes to stderr on every JVM to date, but read both so
      // a future release that moves it to stdout doesn't break detection.
      const output = `${stderr ?? ''}${stdout ?? ''}`;
      if (err) {
        res({ ok: false, output, code: (err as NodeJS.ErrnoException).code });
        return;
      }
      res({ ok: true, output });
    });
  });
}

/** Run a specific `java` binary and decide whether it is usable. */
export async function probeJava(path: string): Promise<JavaResult> {
  const { ok, output, code } = await run(path, ['-version']);

  if (!ok) {
    // macOS's stub exits non-zero with this message when no JDK is installed —
    // that's "no Java here", not a broken install, so report it as not_found.
    const isStub = /Unable to find any JVMs|No Java runtime/i.test(output);
    return {
      available: false,
      path,
      reason: code === 'ENOENT' || isStub ? 'not_found' : 'error',
      detail: output.trim().split('\n')[0] || `Could not run ${path}`,
    };
  }

  const version = parseJavaVersion(output);
  if (version === null) {
    return { available: false, path, reason: 'error', detail: 'Could not read a version from `java -version`.' };
  }

  const versionString = /version "([^"]+)"/.exec(output)?.[1];
  if (version < MIN_JAVA_MAJOR) {
    return {
      available: false,
      path,
      version,
      versionString,
      reason: 'too_old',
      detail: `Java ${version} found, but ROBOT needs ${MIN_JAVA_MAJOR} or newer.`,
    };
  }

  return { available: true, path, version, versionString };
}

/** macOS's JDK locator. Exits non-zero (quietly) when no JDK is installed. */
async function macJavaHome(): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  const { ok, output } = await run('/usr/libexec/java_home', ['-v', `${MIN_JAVA_MAJOR}+`]);
  const home = output.trim();
  return ok && home ? home : null;
}

async function candidatePaths(): Promise<string[]> {
  const paths: string[] = [];
  const push = (p: string | null | undefined) => {
    if (p && !paths.includes(p)) paths.push(p);
  };

  push(process.env.JAVA_PATH);
  push(getSetting(SETTING_JAVA_PATH));
  if (process.env.JAVA_HOME) push(resolve(process.env.JAVA_HOME, 'bin', javaBinaryName()));
  const home = await macJavaHome();
  if (home) push(resolve(home, 'bin', javaBinaryName()));
  push('java');

  return paths;
}

let cached: Promise<JavaResult> | null = null;

/**
 * First usable JVM from the candidate list, memoized for the process.
 * Call `invalidateJavaCache()` after the user supplies a new path.
 */
export function resolveJava(): Promise<JavaResult> {
  if (!cached) {
    cached = (async () => {
      let best: JavaResult | null = null;
      for (const path of await candidatePaths()) {
        const result = await probeJava(path);
        if (result.available) return result;
        // A JVM that's merely too old is more useful to report than "nothing
        // found at all" — it tells the user to upgrade rather than install.
        if (!best || (result.reason === 'too_old' && best.reason !== 'too_old')) best = result;
      }
      return best ?? { available: false, reason: 'not_found' as const };
    })();
  }
  return cached;
}

export function invalidateJavaCache(): void {
  cached = null;
}
