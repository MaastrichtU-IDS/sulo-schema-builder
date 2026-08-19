import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { resolve } from 'node:path';
import { runMigrations } from './migrate.js';

const MIGRATIONS_DIR = resolve(import.meta.dirname, '..', '..', 'migrations');

describe('runMigrations', () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('applies every migration once and is idempotent', async () => {
    const first = await runMigrations(pool, MIGRATIONS_DIR);
    expect(first).toContain('001_core.sql');
    expect(first).toContain('002_local_owner.sql');

    const second = await runMigrations(pool, MIGRATIONS_DIR);
    expect(second).toEqual([]);
  });

  it('creates the core tables with their constraints', async () => {
    await runMigrations(pool, MIGRATIONS_DIR);

    const { rows } = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual(
      [
        'classes', 'properties', 'reason_jobs', 'reasoning_reports',
        'schema_migrations', 'schema_grants', 'schemas', 'usage_events', 'users',
      ].sort(),
    );

    await expect(
      pool.query(`insert into schemas (owner_id, title, visibility)
                  values ('00000000-0000-0000-0000-000000000001', 'bad', 'nonsense')`),
    ).rejects.toThrow(/visibility/);
  });

  it('seeds exactly one local owner', async () => {
    await runMigrations(pool, MIGRATIONS_DIR);

    const { rows } = await pool.query<{ id: string; subject: string }>('select id, subject from users');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('00000000-0000-0000-0000-000000000001');
    expect(rows[0].subject).toBe('local');
  });
});
