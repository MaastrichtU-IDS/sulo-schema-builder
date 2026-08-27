// Fetches the ROBOT jar on first launch instead of embedding it in the binary.
//
// robot.jar is ~91 MB — packaging it as a pkg asset made every desktop download
// that much larger for a feature not every user reaches. Packaged builds now
// download it once into the per-user app-data dir; Docker and local dev are
// untouched (both already have `robot` on PATH via the image or the host).
//
// A truncated or interrupted download would otherwise leave a corrupt jar that
// fails confusingly forever, so the stream is hashed as it lands, checked
// against the pinned digest in config, and only then renamed into place. The
// rename is what makes the target path atomic: a reader either sees no jar or a
// complete verified one, never a partial write.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname } from 'node:path';
import { config } from '../config/index.js';

export type RobotState = 'missing' | 'downloading' | 'ready' | 'error';

export interface RobotStatus {
  state: RobotState;
  path?: string;
  /** Bytes written so far, while downloading. */
  received?: number;
  /** Total bytes from content-length, when the server reports one. */
  total?: number;
  error?: string;
  version: string;
}

let state: RobotState = 'missing';
let received = 0;
let total: number | undefined;
let error: string | undefined;

export function getRobotStatus(): RobotStatus {
  return {
    state,
    path: state === 'ready' ? config.reasoner.robotJarPath : undefined,
    ...(state === 'downloading' ? { received, total } : {}),
    ...(error ? { error } : {}),
    version: config.reasoner.robotVersion,
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function existsWithCorrectHash(path: string): Promise<boolean> {
  try {
    await stat(path);
  } catch {
    return false;
  }
  return (await sha256File(path)) === config.reasoner.robotSha256;
}

async function download(): Promise<void> {
  const target = config.reasoner.robotJarPath;
  const partial = `${target}.part`;
  const url = `https://github.com/ontodev/robot/releases/download/v${config.reasoner.robotVersion}/robot.jar`;

  await mkdir(dirname(target), { recursive: true });
  await rm(partial, { force: true });

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);

  const length = res.headers.get('content-length');
  total = length ? Number(length) : undefined;
  received = 0;

  const hash = createHash('sha256');
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    received += chunk.length;
  });

  try {
    await pipeline(source, createWriteStream(partial));
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }

  const digest = hash.digest('hex');
  if (digest !== config.reasoner.robotSha256) {
    await rm(partial, { force: true });
    throw new Error(
      `Checksum mismatch — the download was corrupted or the release changed (expected ${config.reasoner.robotSha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…).`,
    );
  }

  await rename(partial, target);
}

let inflight: Promise<string> | null = null;

/**
 * Resolve a usable robot.jar path, downloading it if this is the first launch.
 * Memoized while in flight so concurrent callers share one download rather than
 * racing two writes at the same target.
 */
export function ensureRobotJar(): Promise<string> {
  if (!inflight) {
    inflight = (async () => {
      const target = config.reasoner.robotJarPath;

      // Already present and intact — covers restarts and the offline escape
      // hatch where the user drops the jar in by hand.
      if (await existsWithCorrectHash(target)) {
        state = 'ready';
        error = undefined;
        return target;
      }

      state = 'downloading';
      error = undefined;
      try {
        await download();
        state = 'ready';
        return target;
      } catch (err) {
        state = 'error';
        error = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        // Let a later retry start fresh rather than replaying this result.
        inflight = null;
      }
    })();
  }
  return inflight;
}

/** Kick the download off without awaiting it — used at server start. */
export function startRobotDownload(): void {
  ensureRobotJar().catch(() => {
    /* state/error already recorded; surfaced via getRobotStatus() */
  });
}
