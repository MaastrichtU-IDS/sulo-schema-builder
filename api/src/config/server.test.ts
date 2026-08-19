import { describe, it, expect, afterEach, vi } from 'vitest';

// config/server.ts reads the environment once, at import time, so each case
// needs a fresh module registry rather than a setter.
async function loadStorage(value: string | undefined): Promise<string> {
  vi.resetModules();
  if (value === undefined) delete process.env.SCHEMA_STORAGE;
  else process.env.SCHEMA_STORAGE = value;
  return (await import('./server.js')).storage;
}

afterEach(() => { delete process.env.SCHEMA_STORAGE; });

describe('SCHEMA_STORAGE', () => {
  it('defaults to sqlite', async () => {
    expect(await loadStorage(undefined)).toBe('sqlite');
  });

  it('accepts the two documented values', async () => {
    expect(await loadStorage('postgres')).toBe('postgres');
    expect(await loadStorage('sqlite')).toBe('sqlite');
  });

  it('refuses a typo instead of silently serving from a container-local SQLite file', async () => {
    for (const typo of ['postgress', 'Postgres', 'postgresql', 'browser', '']) {
      await expect(loadStorage(typo)).rejects.toThrow(/SCHEMA_STORAGE/);
    }
  });
});
