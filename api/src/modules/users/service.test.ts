import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestDb, truncateAll, type TestDb } from '../../test/pg.js';
import * as service from './service.js';

let t: TestDb;

beforeAll(async () => { t = await startTestDb(); });
afterAll(async () => { await t.stop(); });
beforeEach(async () => { await truncateAll(t.db); });

describe('users service', () => {
  it('provisions a user on first sight and returns defaults', async () => {
    const user = await service.resolveUser(t.db, { sub: 'kc-1', email: 'a@example.org', name: 'Ada' });

    expect(user.id).toBeTruthy();
    expect(user.subject).toBe('kc-1');
    expect(user.role).toBe('user');
    expect(user.tier).toBe('free');
  });

  it('is idempotent: the same subject keeps the same id', async () => {
    const first = await service.resolveUser(t.db, { sub: 'kc-1', email: 'a@example.org' });
    const second = await service.resolveUser(t.db, { sub: 'kc-1', email: 'a@example.org' });

    expect(second.id).toBe(first.id);
    const { rows } = await t.pool.query('select count(*)::int as n from users where subject = $1', ['kc-1']);
    expect(rows[0].n).toBe(1);
  });

  it('refreshes mirrored claims and last_seen_at on a later sighting', async () => {
    await service.resolveUser(t.db, { sub: 'kc-1', email: 'old@example.org', name: 'Old' });
    await service.resolveUser(t.db, { sub: 'kc-1', email: 'new@example.org', name: 'New', orcid: '0000-0002-1825-0097' });

    const { rows } = await t.pool.query(
      'select email, display_name, orcid, last_seen_at from users where subject = $1', ['kc-1'],
    );
    expect(rows[0].email).toBe('new@example.org');
    expect(rows[0].display_name).toBe('New');
    expect(rows[0].orcid).toBe('0000-0002-1825-0097');
    expect(rows[0].last_seen_at).not.toBeNull();
  });

  it('never overwrites a role or tier an administrator set', async () => {
    const user = await service.resolveUser(t.db, { sub: 'kc-1' });
    await t.pool.query('update users set global_role = $1, quota_tier = $2 where id = $3', ['admin', 'staff', user.id]);

    const again = await service.resolveUser(t.db, { sub: 'kc-1' });
    expect(again.role).toBe('admin');
    expect(again.tier).toBe('staff');
  });

  it('falls back to preferred_username when no name claim is present', async () => {
    await service.resolveUser(t.db, { sub: 'kc-2', preferred_username: 'ada' });
    const { rows } = await t.pool.query('select display_name from users where subject = $1', ['kc-2']);
    expect(rows[0].display_name).toBe('ada');
  });

  it('refuses the reserved local subject', async () => {
    await expect(service.resolveUser(t.db, { sub: 'local' })).rejects.toThrow(/reserved/i);
  });
});
