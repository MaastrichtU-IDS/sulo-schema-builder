import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveStorage } from './server.js';

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

  // `process.pkg` is not env-mockable, so the packaged branch is exercised
  // through resolveStorage directly. It must never throw: a stray
  // SCHEMA_STORAGE in the shell that launched the desktop app (README's own
  // Postgres dev instructions export one) used to kill the sidecar at import
  // time, before Fastify could listen and before any log existed to explain it.
  describe('packaged desktop builds', () => {
    it('forces sqlite and warns instead of throwing, whatever was requested', () => {
      for (const requested of ['postgres', 'postgress', 'Postgres', 'browser', '']) {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(resolveStorage(requested, true)).toBe('sqlite');
          expect(warn).toHaveBeenCalledOnce();
        } finally {
          warn.mockRestore();
        }
      }
    });

    it('stays quiet when sqlite was what was asked for', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(resolveStorage('sqlite', true)).toBe('sqlite');
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('still rejects a typo when not packaged', () => {
      expect(() => resolveStorage('postgress', false)).toThrow(/SCHEMA_STORAGE/);
      expect(resolveStorage('postgres', false)).toBe('postgres');
    });
  });
});
