import { describe, it, expect } from 'vitest';
import { resolveAccess, atLeast, type AccessLevel, type GrantRow } from './resolve.js';
import type { RequestUser } from '../users/service.js';

const OWNER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function user(id: string, role: RequestUser['role'] = 'user'): RequestUser {
  return { id, subject: `kc-${id}`, role, tier: 'free' };
}
const schema = (visibility: 'private' | 'unlisted' | 'public') => ({ owner_id: OWNER, visibility });
const grant = (role: GrantRow['role']): GrantRow => ({ role });

describe('resolveAccess', () => {
  const cases: Array<[string, RequestUser | null, ReturnType<typeof schema>, GrantRow | null, AccessLevel]> = [
    // owner always wins, whatever the visibility
    ['owner, private',                       user(OWNER), schema('private'),  null,            'own'],
    ['owner, public',                        user(OWNER), schema('public'),   null,            'own'],

    // admins act as owners; moderators get read-only reach
    ['admin, private, no grant',             user(OTHER, 'admin'),     schema('private'), null, 'own'],
    ['moderator, private, no grant',         user(OTHER, 'moderator'), schema('private'), null, 'view'],
    ['moderator, public',                    user(OTHER, 'moderator'), schema('public'),  null, 'view'],

    // explicit grants
    ['grantee owner role, private',          user(OTHER), schema('private'), grant('owner'),  'own'],
    ['grantee editor, private',              user(OTHER), schema('private'), grant('editor'), 'edit'],
    ['grantee viewer, private',              user(OTHER), schema('private'), grant('viewer'), 'view'],

    // visibility, for a signed-in stranger
    ['stranger, private, no grant',          user(OTHER), schema('private'),  null, 'none'],
    ['stranger, unlisted',                   user(OTHER), schema('unlisted'), null, 'view'],
    ['stranger, public',                     user(OTHER), schema('public'),   null, 'view'],

    // visibility, anonymous
    ['anonymous, private',                   null, schema('private'),  null, 'none'],
    ['anonymous, unlisted',                  null, schema('unlisted'), null, 'view'],
    ['anonymous, public',                    null, schema('public'),   null, 'view'],

    // a grant must never *reduce* what visibility already allows
    ['viewer grant on a public schema',      user(OTHER), schema('public'), grant('viewer'), 'view'],
    ['editor grant on a public schema',      user(OTHER), schema('public'), grant('editor'), 'edit'],
  ];

  for (const [name, u, s, g, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(resolveAccess(u, s, g)).toBe(expected);
    });
  }

  it('never grants write access to an anonymous caller, whatever the inputs', () => {
    for (const visibility of ['private', 'unlisted', 'public'] as const) {
      for (const g of [null, grant('viewer'), grant('editor'), grant('owner')]) {
        // A grant row for an anonymous caller is nonsensical, but a bug elsewhere
        // could produce one; the resolver must not be the thing that trusts it.
        const level = resolveAccess(null, schema(visibility), g);
        expect(atLeast(level, 'edit')).toBe(false);
      }
    }
  });
});

describe('atLeast', () => {
  it('orders the levels', () => {
    expect(atLeast('own', 'edit')).toBe(true);
    expect(atLeast('edit', 'edit')).toBe(true);
    expect(atLeast('view', 'edit')).toBe(false);
    expect(atLeast('none', 'view')).toBe(false);
    expect(atLeast('own', 'own')).toBe(true);
    expect(atLeast('edit', 'own')).toBe(false);
  });
});
