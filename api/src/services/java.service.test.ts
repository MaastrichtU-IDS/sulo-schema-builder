import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJavaVersion, probeJava, MIN_JAVA_MAJOR } from './java.service.js';

describe('parseJavaVersion', () => {
  it('reads the modern format', () => {
    expect(parseJavaVersion('openjdk version "21.0.2" 2024-01-16')).toBe(21);
    expect(parseJavaVersion('openjdk version "11.0.22" 2024-01-16')).toBe(11);
  });

  it('reads the legacy 1.x format as its second segment', () => {
    // The trap: "1.8.0_392" is Java 8, not Java 1.
    expect(parseJavaVersion('java version "1.8.0_392"')).toBe(8);
  });

  it('handles pre-release and bare majors', () => {
    expect(parseJavaVersion('openjdk version "21-ea" 2023-09-19')).toBe(21);
    expect(parseJavaVersion('openjdk version "17"')).toBe(17);
  });

  it('returns null for output with no version at all', () => {
    expect(parseJavaVersion('command not found')).toBeNull();
    expect(parseJavaVersion('')).toBeNull();
    expect(parseJavaVersion('version "not-a-number"')).toBeNull();
  });
});

describe('probeJava', () => {
  let dir: string;

  async function fakeJava(name: string, body: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf-8');
    await chmod(path, 0o755);
    return path;
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'java-probe-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts a modern JVM', async () => {
    const path = await fakeJava('good', 'echo \'openjdk version "21.0.2" 2024-01-16\' >&2');
    const result = await probeJava(path);
    expect(result).toMatchObject({ available: true, version: 21, versionString: '21.0.2' });
  });

  it('rejects a JVM older than ROBOT supports', async () => {
    const path = await fakeJava('old', 'echo \'java version "1.8.0_392"\' >&2');
    const result = await probeJava(path);
    expect(result.available).toBe(false);
    expect(result.reason).toBe('too_old');
    expect(result.version).toBe(8);
    expect(result.detail).toContain(String(MIN_JAVA_MAJOR));
  });

  it('reports a missing binary as not_found', async () => {
    const result = await probeJava(join(dir, 'does-not-exist'));
    expect(result).toMatchObject({ available: false, reason: 'not_found' });
  });

  it("treats macOS's stub java as not_found rather than a broken install", async () => {
    // /usr/bin/java exists on a Mac with no JDK and exits non-zero like this,
    // which is why existence checks are not enough to detect a usable JVM.
    const path = await fakeJava('stub', "echo 'Unable to find any JVMs matching version \"(null)\".' >&2\nexit 1");
    const result = await probeJava(path);
    expect(result).toMatchObject({ available: false, reason: 'not_found' });
  });

  it('reports an unparseable but runnable binary as error', async () => {
    const path = await fakeJava('weird', "echo 'hello' >&2");
    const result = await probeJava(path);
    expect(result).toMatchObject({ available: false, reason: 'error' });
  });
});
