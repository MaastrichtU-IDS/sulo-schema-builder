# Plan 2 follow-ups

Residuals from the final review of plan 2 (identity) on `feat/multi-user-backend`. All seventeen
review findings were fixed; these are what was deliberately deferred, ordered by how much they
matter. Written 2026-08-20. Plan 1's separate list is in `2026-08-20-plan-01-followups.md` and is
still open.

Plan: `docs/superpowers/plans/2026-08-20-multi-user-backend-02-identity.md`
Spec: `docs/superpowers/specs/2026-08-19-multi-user-backend-design.md` §4

## Blocks plan 3

**1. The no-op `requireRole` admits, then leaves `request.user` null.**
`api/src/plugins/authDisabled.ts`. In sqlite mode the guard is a no-op, so plan 3's moderator route
(`POST /admin/schemas/:id/unpublish`, spec §5) would pass the guard and then crash on
`request.user.role`. Either make role-guarded routes postgres-only by construction, or route them
through a `requireUser`-style helper that fails loudly. **Put this in the plan-3 brief.**

**2. `truncateAll` deliberately spares `users`.**
`api/src/test/pg.ts`. That is the only reason the shared-harness suites work. A plan-3 test that
truncates `users` while the 60 s subject cache still holds the old id will get FK violations that
look like product bugs. Worth a comment at the function before someone loses an hour to it.

**3. The seeded `LOCAL_OWNER_ID` row is privileged, not ordinary.**
`api/migrations/002_local_owner.sql`, `api/src/db/constants.ts`. Several comments (and plan 1's
text) call it "an ordinary user record", but it carries `global_role='admin'`, `quota_tier='staff'`
and a reserved subject no session can occupy. Under plan 3's resolver, `admin` → `own` on every
schema, so the wording needs to say "a privileged row no session can ever occupy".

## Security hardening

**4. The user cache is an unbounded `Map`, not the LRU the spec claims.**
`api/src/plugins/auth.ts`. Entries for subjects that stop appearing are never evicted, so memory
grows with distinct authenticated users over the process lifetime. Negligible at classroom scale.
Bound it, or correct spec §4's wording.

**5. Revocation lag is real and now documented but not reduced.**
A role change or a Keycloak-side disable stays effective for up to `userCacheTtlMs` (60 s default),
and Keycloak-issued access tokens stay valid for `accessTokenLifespan` (300 s) regardless. If that
is too long for the eventual deployment, shorten both — and note there is no local ban path at all:
deleting a `users` row cascades away every schema they own and the next request re-creates the row
as a fresh free account. An `enabled` column checked in `resolveUser` is the smallest real fix.

**6. `jwtVerify` does not require `exp`.**
`api/src/plugins/auth.ts`. A validly signed token omitting `exp` would pass. Only reachable by
whoever holds Keycloak's signing key, so theoretical — but `requiredClaims: ['exp']` is free.

**7. Claims are cast, not shape-validated.**
`api/src/plugins/auth.ts`. A misconfigured IdP mapper sending a non-string `email`/`name` makes
`.trim()` throw; the plugin's catch turns that into a 401 plus a warn (not a 500, as an earlier note
claimed). Validating the claim shape would give a clearer signal.

**8. No `algorithms` allowlist on `jwtVerify`.**
Defence in depth only — `jose` already blocks `alg: none` and RSA→HMAC confusion. If added, make it
configurable, since an operator can change Keycloak's signature algorithm.

**9. Rate limiting runs before the auth guards.**
`api/src/server.ts`. `@fastify/rate-limit` is an `onRequest` hook and the guards are `preHandler`,
so anonymous 401s still spend the IP budget — and the auth `onRequest` hook is registered *before*
the limiter, so an anonymous caller costs an RSA verification ahead of the limiter. Bounded by
jose's 30 s JWKS cooldown. Plan 4's per-user quota work must decide this deliberately rather than
inherit it.

**10. `isJwksResolutionFailure` string-matches `/fetch failed/i`.**
`api/src/plugins/auth.ts`. undici's wording is not a documented contract; if it drifts,
DNS/ECONNREFUSED/TLS failures silently fall back to `debug`, partially reintroducing the
undiagnosability that cost a whole task to find.

**11. `request.user` is the same object as the cache entry.**
`api/src/plugins/auth.ts`. Any future handler that mutates `request.user` poisons every subsequent
request from that subject for the rest of the TTL. A `{ ...cached.user }` copy is free.

## Correctness / UX

**12. The `orcid` claim the code reads is never produced.**
`api/src/modules/users/service.ts` reads `claims.orcid`, but the realm has no
`oidc-usermodel-attribute-mapper` emitting it and no `identityProviderMappers` importing the
brokered ORCID subject. So `users.orcid` (spec §3) is permanently null even after
`configure-idps.sh` enables ORCID. Add both mappers, or mark the column reserved.

**13. Residual StrictMode hole: the live run can lose the auth-code exchange.**
`frontend/src/auth/AuthProvider.tsx`. The ref is now guarded by instance identity, but
`setStatus('disabled')` is still gated only on this run's `cancelled`. Dev only: returning from
Keycloak with `?code=…`, if the aborted run wins the exchange, the live run's `init()` rejects on a
used code and the app claims auth is off right after a successful login. Gate the status write on
ref ownership too, or use a module-level init guard.

**14. No exit from `'authenticated'` when a refresh fails.**
`frontend/src/auth/AuthProvider.tsx`. `refresh()` returns `false` and nothing else happens: the nav
bar keeps showing the user and "Sign out" while every API call 401s. Clear the provider and go
`'anonymous'`.

**15. Anonymous visitors still fire the schema-list query.**
`frontend/src/pages/OntologyBuilderPage.tsx`. It 401s and retries once via react-query's default.
Inert, but `enabled: status !== 'anonymous'` is one line and the codebase already uses that pattern.

## Documentation and hygiene

**16. Comments overstate the pkg guarantee.**
`api/src/plugins/auth.ts`, `api/src/plugins/authDisabled.ts`, and this plan's own text say `jose`
and `kysely` are "kept out of the packaged snapshot" / "must not enter the import graph". Verified
inaccurate: pkg statically discovers the `await import()` target and bundles the source as a dead
asset. The accurate claim — and the one the two prior incidents were actually about — is that they
must never be **evaluated** in the packaged binary. `import type` erasure (used in
`modules/schemas/repo.ts`) is the stronger technique, since no `require` survives compilation at
all. Fix the wording; no code change needed.

**17. `README.md`'s new `.env`-precedence sentence overclaims for `HOST`.**
`HOST` is still hardcoded to `0.0.0.0` in compose with no interpolation — correct for a container,
but the sentence as written implies every variable in the table above it can be overridden from
`.env`.

**18. Untested CI paths.** The `e2e-auth` job has never run on a real GitHub runner:
`playwright install --with-deps` and the 30-minute timeout budget (cold cacheless multi-stage build
+ ROBOT jar download + JRE install + two `npm ci` + frontend build + Keycloak image pull) are both
unverified. Also `frontend/src/api/client.test.ts` selects interceptors by array position, so an
interceptor registered earlier by another module would silently redirect its assertions.

**19. Dead code.** `findBySubject` in `api/src/modules/users/repo.ts` is exported and called
nowhere, including tests. `frontend/playwright.config.ts`'s `use.baseURL` is dead — both specs
define their own absolute `BASE` (pre-existing). No `parseIssuer` unit test exists
(`frontend/src/auth/keycloak.ts`); its edge cases were hand-traced correct but only implicitly
exercised.

**20. `seed-test-user.sh` passes the password as a `kcadm` CLI argument**, visible via `ps` inside
the container. A fixed, disclosed, local/CI-only credential, so low severity.

## Manual step outstanding

`.env.example` is permission-blocked for every agent in this environment. It needs, at minimum:

```
AUTH_JWKS_URI=
AUTH_REQUIRE_JWKS_AT_BOOT=
```

The README documents both; the compose defaults mean an unset value still yields a working local
stack.
