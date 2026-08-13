import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stand-in for the 91 MB release asset. The service only cares that the bytes
// hash to the pinned digest, so a short buffer exercises the same paths.
const JAR_BYTES = Buffer.from('pretend this is robot.jar');
const JAR_SHA = createHash('sha256').update(JAR_BYTES).digest('hex');

// Filled in by beforeAll; the mock reads them lazily through a getter so the
// hoisted factory doesn't need the temp dir to exist yet.
const shared = vi.hoisted(() => ({ dir: '', sha: '' }));

vi.mock('../config.js', () => ({
  config: {
    isPackaged: true,
    get reasoner() {
      return {
        robotJarPath: join(shared.dir, 'robot.jar'),
        robotVersion: '1.9.7',
        robotSha256: shared.sha,
      };
    },
  },
}));

async function freshService() {
  vi.resetModules();
  return import('./robot.service.js');
}

function mockFetch(body: Buffer, status = 200) {
  const fetchMock = vi.fn(async (url: string | URL) => {
    void url;
    // Response takes a BodyInit; a Node Buffer needs widening to a plain view.
    return new Response(new Uint8Array(body), {
      status,
      headers: { 'content-length': String(body.length) },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('ensureRobotJar', () => {
  const realFetch = globalThis.fetch;
  let jarPath: string;

  beforeAll(async () => {
    shared.dir = await mkdtemp(join(tmpdir(), 'robot-svc-'));
    shared.sha = JAR_SHA;
    jarPath = join(shared.dir, 'robot.jar');
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await rm(shared.dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(jarPath, { force: true });
    await rm(`${jarPath}.part`, { force: true });
  });

  it('uses an existing jar with the right digest without hitting the network', async () => {
    await writeFile(jarPath, JAR_BYTES);
    const fetchMock = mockFetch(JAR_BYTES);

    const { ensureRobotJar, getRobotStatus } = await freshService();
    await expect(ensureRobotJar()).resolves.toBe(jarPath);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getRobotStatus()).toMatchObject({ state: 'ready', path: jarPath });
  });

  it('downloads and verifies when the jar is missing', async () => {
    const fetchMock = mockFetch(JAR_BYTES);

    const { ensureRobotJar, getRobotStatus } = await freshService();
    await expect(ensureRobotJar()).resolves.toBe(jarPath);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/releases/download/v1.9.7/robot.jar');
    await expect(stat(jarPath)).resolves.toBeTruthy();
    expect(getRobotStatus().state).toBe('ready');
  });

  it('re-downloads a jar whose digest does not match', async () => {
    await writeFile(jarPath, Buffer.from('a stale or corrupt jar'));
    const fetchMock = mockFetch(JAR_BYTES);

    const { ensureRobotJar } = await freshService();
    await expect(ensureRobotJar()).resolves.toBe(jarPath);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects a corrupted download and leaves no partial file behind', async () => {
    mockFetch(Buffer.from('truncated payload'));

    const { ensureRobotJar, getRobotStatus } = await freshService();
    await expect(ensureRobotJar()).rejects.toThrow(/Checksum mismatch/);

    const status = getRobotStatus();
    expect(status.state).toBe('error');
    expect(status.error).toMatch(/Checksum mismatch/);
    // Neither the target nor the .part scratch file should survive a bad download.
    await expect(stat(jarPath)).rejects.toThrow();
    await expect(stat(`${jarPath}.part`)).rejects.toThrow();
  });

  it('records an HTTP failure as an error state', async () => {
    mockFetch(Buffer.from(''), 404);

    const { ensureRobotJar, getRobotStatus } = await freshService();
    await expect(ensureRobotJar()).rejects.toThrow(/HTTP 404/);
    expect(getRobotStatus().state).toBe('error');
  });

  it('shares one download between concurrent callers', async () => {
    const fetchMock = mockFetch(JAR_BYTES);

    const { ensureRobotJar } = await freshService();
    const [a, b, c] = await Promise.all([ensureRobotJar(), ensureRobotJar(), ensureRobotJar()]);

    expect([a, b, c]).toEqual([jarPath, jarPath, jarPath]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('lets a retry start over after a failure', async () => {
    mockFetch(Buffer.from('bad'));
    const { ensureRobotJar, getRobotStatus } = await freshService();
    await expect(ensureRobotJar()).rejects.toThrow();

    // A failed attempt must not be memoized, or Retry would replay the error.
    mockFetch(JAR_BYTES);
    await expect(ensureRobotJar()).resolves.toBe(jarPath);
    expect(getRobotStatus().state).toBe('ready');
  });
});
