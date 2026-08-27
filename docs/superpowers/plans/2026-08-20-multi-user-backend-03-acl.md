# Multi-user Backend — Plan 3: Authorization (visibility, grants, roles)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A schema is reachable exactly by the people entitled to it — its owner, the users it is shared with, and (when published) anyone at all — with one resolver deciding every case and one enforcement point applying it.

**Architecture:** A pure `resolveAccess(user, schema, grant) → 'none' | 'view' | 'edit' | 'own'` function holds the whole policy and is table-tested without a database. A single preHandler factory loads the schema row LEFT JOINed to the requester's grant in one query, resolves the level, and asserts the route's minimum; handlers keep no permission logic. `none` on a schema the caller cannot see answers **404, not 403**, so ids do not leak existence. Anonymous callers become first-class for reads of `public`/`unlisted` schemas, which means the blanket `authRequired` from plan 2 is replaced per route by an access requirement — writes still demand a session. `schema_grants` (already in migration 001) gets a management API, and listing gains `?scope=mine|shared|public`.

**Scope boundary:** no quotas, no reasoning queue or report cache, no SSE, no admin console beyond the single moderator unpublish route that design §5 names. Those are plans 4 and 5.

**Tech Stack:** Fastify 5, Kysely, Postgres 16, zod 3, vitest 2 + `@testcontainers/postgresql`, React 18 + react-query 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-19-multi-user-backend-design.md` section 5 (and section 3 for `schema_grants`).

**Predecessors:** plan 1 (`…-01-foundation.md`) and plan 2 (`…-02-identity.md`), both complete. Their open items are catalogued in `2026-08-20-plan-01-followups.md` and `2026-08-20-plan-02-followups.md`. **Two of those are load-bearing here and are called out at the tasks that must handle them.**

## Global Constraints

- Node 22; TypeScript strict, NodeNext ESM — **every relative import ends in `.js`**.
- Postgres only through Kysely. Migrations are plain `.sql` in `api/migrations/`, `NNN_description.sql`, never edited once applied. **This plan should need no new migration** — `schema_grants`, `schemas.visibility` and the partial index on `visibility='public'` all exist from migration 001. If you find you need one, stop and report it: it means the model and the spec have diverged.
- **404, never 403, for a schema the caller may not see.** A 403 confirms the id exists. The only 403s in this plan are for a caller who *can* see a schema but lacks the level for the action they attempted.
- The frozen SQLite desktop path (`api/src/legacy/sqlite/`, `SCHEMA_STORAGE=sqlite`) is single-user with no auth and **gets no ACL**. Do not touch it. The packaged binary must still build and boot.
- **Plan-2 follow-up #1 is a blocker for the moderator route:** `plugins/authDisabled.ts` supplies `requireRole` as a no-op in sqlite mode, so a role-guarded route there would pass the guard and then crash on `request.user.role`. The moderator route must be postgres-only by construction, or must go through a helper that fails loudly. Task 5 owns this.
- **Plan-2 follow-up #2 is a trap for every test here:** `api/src/test/pg.ts`'s `truncateAll` deliberately spares `users`, and the auth plugin caches subject→user for `userCacheTtlMs`. A test that truncates `users`, or that reuses a subject across differing expectations, will produce FK violations and stale-id failures that look like product bugs. Create your fixture users through the normal token path and let `truncateAll` clear only schema data.
- Anonymous access is **read-only and never reaches the reasoner or the upper-ontology proxy** (plan 2 closed that; do not reopen it). Anonymous callers may read public/unlisted schemas and nothing else.
- `unlisted` means reachable by id but excluded from public listings — a **list-query** concern, not an access-check concern. Do not conflate them.
- Commit after every task. Never `git commit` outside the steps that say to; never push, open a PR, or amend an existing commit.

---

### Task 1: The access resolver

**Files:**
- Create: `api/src/modules/acl/resolve.ts`, `api/src/modules/acl/resolve.test.ts`
- Test: `api/src/modules/acl/resolve.test.ts`

**Interfaces:**
- Consumes: `RequestUser` from `api/src/modules/users/service.js`; `SchemaRow` from `api/src/db/types.js`.
- Produces:
  ```ts
  export type AccessLevel = 'none' | 'view' | 'edit' | 'own';
  export interface GrantRow { role: 'viewer' | 'editor' | 'owner' }
  export function resolveAccess(
    user: RequestUser | null,
    schema: Pick<SchemaRow, 'owner_id' | 'visibility'>,
    grant: GrantRow | null,
  ): AccessLevel;
  export function atLeast(level: AccessLevel, required: Exclude<AccessLevel, 'none'>): boolean;
  ```

This task is pure logic with no I/O, which is exactly why it is first and why its test is a table: every later task trusts it.

- [ ] **Step 1: Write the failing table test**

Create `api/src/modules/acl/resolve.test.ts`. Enumerate the matrix rather than sampling it — the combinations are the specification:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w sulo-schema-builder-api -- src/modules/acl/resolve.test.ts`
Expected: FAIL — `Cannot find module './resolve.js'`.

- [ ] **Step 3: Write the resolver**

```ts
// The whole authorization policy, as one pure function.
//
// Kept free of I/O on purpose: the caller supplies the schema row and the
// requester's grant (loaded together in one query — see repo.ts), so this can be
// table-tested exhaustively, and every route in the API shares one definition of
// who may do what.
//
// Highest match wins. Note what is deliberately absent: no branch consults the
// route, the HTTP method, or anything else about the request. If a rule needs
// that context, it does not belong here.

import type { RequestUser } from '../users/service.js';
import type { SchemaRow } from '../../db/types.js';

export type AccessLevel = 'none' | 'view' | 'edit' | 'own';

export interface GrantRow {
  role: 'viewer' | 'editor' | 'owner';
}

const RANK: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2, own: 3 };

/** Does `level` satisfy `required`? */
export function atLeast(level: AccessLevel, required: Exclude<AccessLevel, 'none'>): boolean {
  return RANK[level] >= RANK[required];
}

const GRANT_LEVEL: Record<GrantRow['role'], AccessLevel> = {
  owner: 'own',
  editor: 'edit',
  viewer: 'view',
};

export function resolveAccess(
  user: RequestUser | null,
  schema: Pick<SchemaRow, 'owner_id' | 'visibility'>,
  grant: GrantRow | null,
): AccessLevel {
  // Anonymous callers get exactly what publication confers, and never more —
  // a grant row cannot apply to someone with no identity.
  if (!user) {
    return schema.visibility === 'private' ? 'none' : 'view';
  }

  const candidates: AccessLevel[] = [];

  if (user.role === 'admin') candidates.push('own');
  if (user.id === schema.owner_id) candidates.push('own');
  if (grant) candidates.push(GRANT_LEVEL[grant.role]);
  // A moderator can read anything, to handle abuse reports; the unpublish route
  // (Task 5) is what lets them act, and it is guarded by role, not by this level.
  if (user.role === 'moderator') candidates.push('view');
  if (schema.visibility !== 'private') candidates.push('view');

  return candidates.reduce<AccessLevel>((best, c) => (RANK[c] > RANK[best] ? c : best), 'none');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w sulo-schema-builder-api -- src/modules/acl/resolve.test.ts`
Expected: PASS (18 cases + 2).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add -A
git commit -m "feat(acl): the access resolver, as one pure table-tested function

resolveAccess(user, schema, grant) is the whole policy: ownership, global roles,
per-schema grants and visibility, with anonymous callers limited to what
publication confers. No I/O, so the matrix is enumerated in a test rather than
sampled."
```

---

### Task 2: The enforcement point

**Files:**
- Create: `api/src/modules/acl/repo.ts`, `api/src/modules/acl/guards.ts`, `api/src/modules/acl/guards.test.ts`
- Modify: `api/src/modules/schemas/routes.ts`
- Test: `api/src/modules/acl/guards.test.ts`, plus `api/src/modules/schemas/routes.auth.test.ts` updated

**Interfaces:**
- Consumes: `resolveAccess`/`atLeast` (Task 1); `fastify.pg`; `request.user`.
- Produces:
  - `repo.ts`: `loadSchemaAccess(db, schemaId, userId: string | null)` → `{ schema: SchemaRow, grant: GrantRow | null } | undefined`, **one query**.
  - `guards.ts`: `requireAccess(level: 'view' | 'edit' | 'own'): preHandlerHookHandler`, which on success decorates `request.schemaAccess = { schema, level }` so the handler does not re-query; and the `FastifyRequest` augmentation for it.

- [ ] **Step 1: Write the failing guard test**

Create `api/src/modules/acl/guards.test.ts`. Build a Fastify app with the auth plugin (reuse `api/src/test/authApp.ts`) and three trivial routes guarded at `view`, `edit` and `own`, then assert the status matrix for: the owner, a viewer-grantee, an editor-grantee, a signed-in stranger, a moderator, an admin, and an anonymous caller — against a private, an unlisted and a public schema. The assertions that carry the design:

- a stranger and an anonymous caller both get **404** on a private schema at every level — never 403;
- a viewer-grantee gets 200 at `view` and **403** at `edit` (they can see it, so 403 leaks nothing);
- an anonymous caller gets 200 at `view` on public/unlisted and **401** at `edit` (a session is the missing thing, not permission);
- a moderator gets 200 at `view` on a private schema and 403 at `edit`;
- an admin gets 200 at all three levels;
- a nonexistent uuid gets 404 identically for every caller, including the owner of some *other* schema — the response must not differ from the private-schema case, or the pair becomes an existence oracle.

Write the fixtures through the token path (`createTestIssuer()` + a request per subject) rather than inserting `users` rows directly, per the global constraint about `truncateAll` and the auth cache.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w sulo-schema-builder-api -- src/modules/acl/guards.test.ts`
Expected: FAIL — `Cannot find module './guards.js'`.

- [ ] **Step 3: Write the one-query loader**

```ts
// One query per guarded request: the schema row plus *this* requester's grant.
//
// A LEFT JOIN rather than two round trips, because the guard runs on every
// request to every schema route and the pair is always needed together.

import type { Kysely } from 'kysely';
import type { DB, SchemaRow } from '../../db/types.js';
import type { GrantRow } from './resolve.js';

export interface SchemaAccessRow {
  schema: SchemaRow;
  grant: GrantRow | null;
}

export async function loadSchemaAccess(
  db: Kysely<DB>,
  schemaId: string,
  userId: string | null,
): Promise<SchemaAccessRow | undefined> {
  const row = await db
    .selectFrom('schemas')
    .leftJoin('schema_grants', (join) =>
      join
        .onRef('schema_grants.schema_id', '=', 'schemas.id')
        // A null userId (anonymous) must match no grant row. Comparing to null
        // in SQL yields unknown, so the join simply produces no match — but be
        // explicit rather than relying on that.
        .on('schema_grants.grantee_id', '=', userId ?? '00000000-0000-0000-0000-000000000000'),
    )
    .where('schemas.id', '=', schemaId)
    .selectAll('schemas')
    .select('schema_grants.role as grant_role')
    .executeTakeFirst();

  if (!row) return undefined;

  const { grant_role: grantRole, ...schema } = row as SchemaRow & { grant_role: GrantRow['role'] | null };
  return { schema, grant: grantRole ? { role: grantRole } : null };
}
```

If Kysely's typing of the extra column fights you, prefer an explicit `select([...])` listing the schema columns over widening the cast — the cast is the part that will rot.

- [ ] **Step 4: Write the guard factory**

```ts
// The single enforcement point. Handlers contain no permission logic: they read
// request.schemaAccess, which exists only if the guard let them run.
//
// The status codes encode the design's information policy:
//   - cannot see it at all           → 404, identical to a nonexistent id
//   - can see it, lacks the level    → 403 (the id is already known to them)
//   - can see it, but is anonymous   → 401 (a session is the missing thing)

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { atLeast, resolveAccess, type AccessLevel } from './resolve.js';
import { loadSchemaAccess } from './repo.js';
import type { SchemaRow } from '../../db/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    schemaAccess: { schema: SchemaRow; level: AccessLevel } | null;
  }
}

export function requireAccess(required: 'view' | 'edit' | 'own'): preHandlerHookHandler {
  return async function accessGuard(request: FastifyRequest, reply: FastifyReply) {
    const { id } = request.params as { id?: string };
    if (!id) throw new Error('requireAccess used on a route without an :id parameter');

    const loaded = await loadSchemaAccess(request.server.pg, id, request.user?.id ?? null);
    // Deliberately the same answer as "you may not see this one".
    if (!loaded) return reply.notFound('Schema not found');

    const level = resolveAccess(request.user, loaded.schema, loaded.grant);
    if (level === 'none') return reply.notFound('Schema not found');

    if (!atLeast(level, required)) {
      if (!request.user) return reply.unauthorized('Sign in to continue.');
      return reply.forbidden('You do not have permission to do that.');
    }

    request.schemaAccess = { schema: loaded.schema, level };
  };
}
```

- [ ] **Step 5: Re-wire the schema routes**

In `api/src/modules/schemas/routes.ts`, replace the blanket `fastify.authRequired` with the per-route requirement. `decorateRequest('schemaAccess', null)` belongs wherever the guard's plugin registration lives — decide where and say so.

| Route | preHandler |
| --- | --- |
| `GET /` | none — anonymous is allowed, and Task 3 makes `?scope` decide what is listed |
| `POST /` | `fastify.authRequired` (no schema exists yet to resolve against) |
| `GET /:id` | `requireAccess('view')` |
| `PATCH /:id` | `requireAccess('edit')` |
| `DELETE /:id` | `requireAccess('own')` |
| `GET /:id/upper-concepts` | `[fastify.authRequired, requireAccess('view')]` — reading is view-level, but making the server dereference a remote IRI stays a privilege of signed-in users (plan 2, spec §5) |
| `POST\|PATCH\|DELETE /:id/classes…`, `…/properties…` | `requireAccess('edit')` |

Handlers that previously re-fetched the schema should use `request.schemaAccess!.schema` instead. **Do not remove the existing schema-scoping on child writes** (`.where('schema_id', …)`) — the guard authorises on `:id` and the write keys on `:id`, and that agreement is the whole reason plan 1's fix round scoped them.

- [ ] **Step 6: Run the guard test to verify it passes, then fix up plan 2's suite**

`routes.auth.test.ts` asserts 401 on every route without a token. That is now wrong for the read routes by design: `GET /:id` on a public schema is 200 anonymously, and `GET /` is 200 with an empty or public-scoped list. Update those expectations and **add a comment recording that the change is intentional**, naming this plan — otherwise the next reader will read it as a regression. Every write route must still be 401 without a token.

- [ ] **Step 7: Full suites, both modes, and commit**

```bash
npm run typecheck && npm test
npm run build -w sulo-schema-builder-api
node api/dist/index.js &   # sqlite mode: unchanged, no ACL, no token needed
sleep 2 && curl -sf localhost:3000/api/v1/ontology-schemas && kill %1
node api/scripts/package-desktop.mjs && NODE_ENV=production api/pkg-dist/sulo-schema-builder-api &
sleep 3 && curl -sf localhost:3000/api/v1/health; kill %1
git add -A
git commit -m "feat(acl): one enforcement point for every schema route

A preHandler factory loads the schema and the requester's grant in one query,
resolves the level, and asserts the route's minimum. Unseeable schemas answer 404
identically to nonexistent ones; a caller who can see a schema but lacks the level
gets 403, and an anonymous one gets 401. Reads of public and unlisted schemas no
longer require a session."
```

---

### Task 3: Listing, visibility and scopes

**Files:**
- Modify: `api/src/modules/schemas/repo.ts`, `api/src/modules/schemas/service.ts`, `api/src/modules/schemas/schemas.ts`, `api/src/modules/schemas/routes.ts`
- Create: `api/src/modules/schemas/listing.test.ts`
- Test: `api/src/modules/schemas/listing.test.ts`

**Interfaces:**
- Produces: `GET /ontology-schemas?scope=mine|shared|public` (default `mine` for a signed-in caller, `public` for an anonymous one); `visibility` accepted by `PATCH /ontology-schemas/:id` at `own` level and returned by every read; `repo.listSchemasByScope(db, { scope, userId })`.

- [ ] **Step 1: Write the failing listing test**

Cover, against a real container: `mine` returns only owned schemas regardless of visibility; `shared` returns only schemas granted to the caller and never their own; `public` returns `public` schemas from every owner but **never `unlisted`** ones; an anonymous caller defaults to `public` and cannot request `mine` or `shared` (401); an unknown `scope` value is 400; ordering stays by title; and `visibility` round-trips through create, patch and read. Include a schema that is both owned and granted to the caller, and assert it appears once, not twice.

- [ ] **Step 2: Run it to verify it fails, then implement**

Add `visibility` to `CreateOntologySchemaBody` and `UpdateOntologySchemaBody` as `z.enum(['private','unlisted','public']).optional()`. Add the scope query parser. `listSchemasByScope` is three shapes of one query — `owner_id = :me`; an inner join on `schema_grants` for `:me`; `visibility = 'public'`. Keep `unlisted` out of the `public` branch: that is the entire difference between the two published states.

Changing `visibility` requires `own`, not `edit` — publication is an ownership decision, so the `PATCH /:id` route stays at `edit` for the other fields and rejects a `visibility` change from a mere editor with 403. Say in your report how you expressed that, since it is the one place a route needs two levels.

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck && npm test
git add -A
git commit -m "feat(acl): visibility and scoped listing

Schemas can be private, unlisted or public; listing takes scope=mine|shared|public
and defaults sensibly for anonymous callers. Unlisted schemas are reachable by id
but never appear in the public list, and only an owner may change visibility."
```

---

### Task 4: The grants API

**Files:**
- Create: `api/src/modules/acl/grants.repo.ts`, `api/src/modules/acl/grants.routes.ts`, `api/src/modules/acl/grants.test.ts`
- Modify: `api/src/routes/v1/index.ts`, `api/src/modules/users/repo.ts` (a lookup)
- Test: `api/src/modules/acl/grants.test.ts`

**Interfaces:**
- Produces: `GET /ontology-schemas/:id/grants` (own), `PUT /ontology-schemas/:id/grants/:userId` with `{ role }` (own), `DELETE /ontology-schemas/:id/grants/:userId` (own), `POST /ontology-schemas/:id/transfer` with `{ userId }` (own), and `GET /users/lookup?email=` (authenticated).

- [ ] **Step 1: Decide and document the lookup's privacy posture — before writing it**

Sharing needs a way to turn something a human knows (an email address) into a user id. That endpoint is an email-existence oracle by construction. Constrain it and write the reasoning into the file's header comment:
- exact-match only, never a prefix or fuzzy search;
- authenticated callers only;
- returns `{ id, displayName }` and **never** the email back, so it confirms only what the caller already typed;
- its own per-route rate limit, tighter than the global one;
- 404 when absent, with the same shape as any other 404.

If you judge a different design better — an invitation flow keyed on an opaque token, say, so no lookup is needed at all — stop and report it rather than building both. That is a spec-level question and it is worth asking before there is code to throw away.

- [ ] **Step 2: Write the failing grants test**

Cover: an owner grants `viewer` and the grantee can then read but not write; an owner upgrades that grant to `editor` (a `PUT` on an existing pair updates rather than erroring) and the grantee can write; an owner revokes and the grantee immediately gets 404 again; an `editor` cannot manage grants (403); a stranger gets 404 on the grants endpoint; granting to a nonexistent user id is 404 and creates nothing; a self-grant by the owner is rejected (400) rather than creating a redundant row; `GET /grants` returns grantee display names, not just ids; transfer moves `owner_id`, leaves the previous owner with an `owner` grant so they are not locked out, and can only be performed by the current owner; and after transfer the new owner can transfer again while the old one cannot.

The revocation case deserves care: the auth plugin caches subject→user, **not** grants, so a revocation must take effect on the next request. Assert that explicitly — if it does not, something is caching more than it should.

- [ ] **Step 3: Implement, then verify and commit**

`PUT` is an upsert on `(schema_id, grantee_id)`; `granted_by` records the actor. Register the routes under the existing `/ontology-schemas` prefix so the guard's `:id` param resolution keeps working.

```bash
npm run typecheck && npm test
git add -A
git commit -m "feat(acl): grant, revoke and transfer

An owner can share a schema with individual users as viewer, editor or owner,
list who has access, revoke it, or hand ownership over — keeping an owner grant
for themselves so a transfer is not a lockout. Sharing resolves an email to a
user through a deliberately narrow, authenticated, rate-limited exact-match
lookup."
```

---

### Task 5: Moderation

**Files:**
- Create: `api/src/modules/acl/moderation.routes.ts`, `api/src/modules/acl/moderation.test.ts`
- Modify: `api/src/routes/v1/index.ts`
- Test: `api/src/modules/acl/moderation.test.ts`

**Interfaces:**
- Produces: `POST /admin/schemas/:id/unpublish` — forces `visibility` to `private`, requires global role `moderator` or `admin`.

- [ ] **Step 1: Handle the sqlite-mode role-guard blocker first**

`plugins/authDisabled.ts` supplies `requireRole` as a **no-op** in sqlite mode, so this route would admit anyone there and then crash on `request.user.role`. Pick one and record why in the file:
- register these routes only when `config.storage === 'postgres'` (mirrors how the schemas module is already selected in `routes/v1/index.ts`), or
- route them through a helper that throws loudly when `request.user` is absent.

The first is stronger — a route that cannot exist cannot be reached — but the second protects any future role-guarded route someone adds without thinking. Doing both is cheap.

- [ ] **Step 2: Write the failing test, implement, verify, commit**

Cover: a moderator unpublishes a public schema (200, `visibility` becomes `private`, it leaves the public list); the same call by an ordinary signed-in user is **404, not 403** — a non-moderator must not learn that an admin surface exists at that path; an anonymous caller gets 401; an admin can also do it; the owner's own access is unchanged afterwards; and an already-private schema is a no-op success rather than an error.

That 404-for-non-moderators choice differs from the 403 the schema routes give a known-but-unauthorised caller, because here the *route* is the secret, not the schema. Write that reasoning into the file.

```bash
npm run typecheck && npm test
git add -A
git commit -m "feat(acl): moderator unpublish

A moderator or admin can force a schema private for abuse handling. The route
answers 404 to everyone else, including signed-in users: here the admin surface
itself is what should not be discoverable."
```

---

### Task 6: The sharing UI

**Files:**
- Create: `frontend/src/components/ShareDialog.tsx`, `frontend/src/components/ShareDialog.test.tsx`, `frontend/src/api/grants.ts`
- Modify: `frontend/src/api/backend.ts`, `frontend/src/api/ontology.ts`, `frontend/src/pages/OntologyBuilderPage.tsx` (wiring only)
- Test: `frontend/src/components/ShareDialog.test.tsx`

**Interfaces:**
- Produces: react-query hooks for the grants and visibility endpoints; a share dialog; scope tabs on the list.

- [ ] **Step 1: Write the failing dialog test, then implement**

The dialog shows the current visibility with a control to change it (owner only), the list of grantees with their roles, a form that resolves an email and adds a grant, and a revoke action. Cover: a viewer sees the dialog read-only; an editor cannot change visibility; a failed email lookup shows "no account with that address" rather than a raw 404; and adding a grant invalidates the grants query.

Scope tabs (`Mine` / `Shared with me` / `Public`) drive the `?scope=` parameter. An anonymous visitor sees only `Public` and a read-only builder.

**Keep `OntologyBuilderPage.tsx` (4065 lines) to wiring only** — mount the dialog, pass the schema, read `useAuth()`. If the read-only-for-viewers state cannot be expressed without restructuring that file, say so in your report and ship the dialog without it rather than starting a refactor this plan did not budget for.

- [ ] **Step 2: Verify and commit**

```bash
npm run build -w @sulo/schema-core && npm run typecheck && npm test
npm run build -w sulo-schema-builder-frontend
git add -A
git commit -m "feat(acl): share dialog and scope tabs"
```

---

### Task 7: End-to-end, two users

**Files:**
- Create: `frontend/e2e/sharing-flow.spec.ts`
- Modify: `docker/keycloak/seed-test-user.sh` (a second user), `.github/workflows/ci.yml`
- Test: `frontend/e2e/sharing-flow.spec.ts`

This is the assertion plan 2 could not make: **owner-scoped listing proved against the server, not the UI gate.** Plan 2's sign-out assertion was tautological because the anonymous prompt replaces the whole list; here a second real account makes it load-bearing.

- [ ] **Step 1: Seed a second user, then write the spec**

Extend the seed script with a second account, keeping it idempotent. Then assert, through real logins: Alice creates a private schema; Bob signs in and gets 404 on its id (via `request`, so it is the server's answer, not the UI's); Alice shares it as viewer; Bob now reads it but his write is refused; Alice publishes a second schema and an anonymous context reads it without signing in; an anonymous write is 401; Alice's `?scope=mine` never contains Bob's schemas and Bob's `?scope=shared` contains exactly the shared one.

- [ ] **Step 2: Run it locally and wire CI**

```bash
docker compose -f docker-compose.yml down -v && docker compose -f docker-compose.yml up -d --build
docker compose -f docker-compose.yml exec -T keycloak sh /opt/keycloak/bin/seed-test-user.sh
npx playwright test -c frontend/playwright.config.ts frontend/e2e/sharing-flow.spec.ts
docker compose -f docker-compose.yml down
```

Add it to the existing `e2e-auth` job rather than a new one — same stack, same seeding, and one more spec is cheaper than a second cold build. Report per-assertion results, and if a real defect surfaces, **stop and report it** instead of adjusting the test.

```bash
git add -A
git commit -m "test(acl): prove isolation and sharing with two real accounts"
```

---

## Self-Review

**Spec coverage (§5):**

| Requirement | Task |
| --- | --- |
| `resolveAccess(user, schema, grant)`, highest match wins | 1 |
| admin → own; owner → own; grants → own/edit/view; moderator → view; visibility → view incl. anonymous | 1 |
| 404-not-403 for what the caller may not see | 2 |
| One preHandler, one query (schema LEFT JOIN grant), no permission logic in handlers | 2 |
| Child routes resolve the parent schema and require edit | 2 |
| `?scope=mine\|shared\|public`; unlisted excluded from public listings but reachable by id | 3 |
| Report/upper-concepts reads inherit view level (upper-concepts still needs a session) | 2 |
| Grant management requires own | 4 |
| Ownership transfer is an explicit route, not a PATCH field | 4 |
| Moderator unpublish | 5 |

Deferred by design: quotas and usage accounting, the reasoning queue and report cache, SSE, the wider admin surface (plans 4-5). No migration is needed — every column and table this plan uses shipped in migration 001.

**Type consistency:** `AccessLevel`, `GrantRow`, `resolveAccess` and `atLeast` are declared once in `modules/acl/resolve.ts` and consumed by `guards.ts`, `grants.routes.ts` and `moderation.routes.ts`. `loadSchemaAccess`'s return type is the guard's input. `request.schemaAccess` is augmented once, in `guards.ts`, and read by the schema handlers.

**The two judgement calls I expect to be argued with, flagged here so they are argued deliberately:** the email lookup in Task 4 is an existence oracle whose constraints are a trade, not a solution (Step 1 invites a counter-proposal); and Task 5's 404-for-non-moderators intentionally differs from the 403 the schema routes give, because at `/admin/*` the route is the secret rather than the resource.
