import { describe, it, expect } from 'vitest';
import { resolvePostgresConfig } from './db.js';

describe('resolvePostgresConfig', () => {
  it('requires DATABASE_URL in postgres mode', () => {
    expect(() => resolvePostgresConfig({}, 'postgres')).toThrow(/DATABASE_URL/);
    expect(() => resolvePostgresConfig({ DATABASE_URL: '  ' }, 'postgres')).toThrow(/DATABASE_URL/);
  });

  it('honours an explicit DATABASE_URL in postgres mode', () => {
    const cfg = resolvePostgresConfig({ DATABASE_URL: 'postgres://real-host/db' }, 'postgres');
    expect(cfg.url).toBe('postgres://real-host/db');
  });

  // The desktop/sqlite path never opens a Postgres pool at all — this must
  // never throw just because it happens to be resolved regardless of mode
  // (config/index.ts calls it unconditionally).
  it('falls back to the local default in sqlite mode, no DATABASE_URL required', () => {
    const cfg = resolvePostgresConfig({}, 'sqlite');
    expect(cfg.url).toBe('postgres://sulo:sulo@localhost:5432/sulo');
  });

  it('honours DATABASE_POOL_MAX, defaulting to 10', () => {
    expect(resolvePostgresConfig({ DATABASE_URL: 'x' }, 'postgres').poolMax).toBe(10);
    expect(resolvePostgresConfig({ DATABASE_URL: 'x', DATABASE_POOL_MAX: '25' }, 'postgres').poolMax).toBe(25);
  });
});
