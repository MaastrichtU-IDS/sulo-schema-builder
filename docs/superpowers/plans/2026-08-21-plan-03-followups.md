# Plan 3 follow-ups

Residuals from the final review of plan 3 (authorization) on `feat/multi-user-backend`. All eleven
final-review findings were fixed; these are what was deliberately deferred, ordered by how much they
matter. Written 2026-08-21. Plans 1 and 2 have their own still-open lists
(`2026-08-20-plan-01-followups.md`, `2026-08-20-plan-02-followups.md`).

Plan: `docs/superpowers/plans/2026-08-20-multi-user-backend-03-acl.md`
Spec: `docs/superpowers/specs/2026-08-19-multi-user-backend-design.md` §5

## Spec gaps — decide before plan 4 builds on them

**1. A moderator's unpublish is reversible by the abuser, in one request, with no trace.**
`POST /admin/schemas/:id/unpublish` sets `visibility='private'` and leaves `owner_id` and every grant
untouched. The owner resolves to `own` regardless of visibility, and `own` may set visibility — so the
owner sends one `PATCH /ontology-schemas/:id {"visibility":"public"}` and the schema is public again.
There is no audit record that it was ever unpublished (design §3 has no moderation-log table), so the
moderation surface is **advisory only**.
Fix needs a migration, hence plan 4/5: a `publication_locked` (or `moderated_at`) column on `schemas`
that `mayChangeVisibility` consults, plus the moderation log §3 lacks. Minimum interim step: a test
asserting the *current* behaviour, so the gap is visible rather than accidental.

**2. `global_role` now confers system-wide authority, which makes the revocation lag matter.**
Before plan 3, `global_role` bought nothing at the route layer. Now `admin` resolves to `own` on every
schema in the deployment. Combined with the 60 s subject→user cache and Keycloak's 300 s
`accessTokenLifespan`, a demoted or disabled admin keeps read/edit/delete/grant/transfer on
**everything** for up to five minutes, and there is no local ban path (plan-2 follow-up #5). A demoted
moderator likewise keeps `view` on every private schema plus the unpublish route.
This is plan-2 follow-up #5 with the severity raised, not a new item — fix it there (the `enabled`
column checked in `resolveUser`, and a shorter token lifespan).

## Guardrails

**3. Six files are now bound by the packaged-binary import-type invariant, with no automated check.**
`modules/schemas/{repo,service}.ts`, `modules/acl/{repo,grants.repo}.ts` and — new in plan 3 —
`modules/users/{service,repo}.ts` all carry a banner saying kysely must stay `import type`, because
they are statically reachable from `dist/index.js` in both storage modes and pkg cannot snapshot
kysely values. The only guard is the tag-triggered sidecar smoke test in `release.yml`. This has
already broken the packaged binary twice.
`verbatimModuleSyntax: true` in `api/tsconfig.json` would make the whole class a compile error — it is
plan-01 follow-up #3 and worth promoting, but it may cascade across the repo, so it needs its own pass.

**4. `feat/multi-user-backend` has never been pushed, so `e2e-auth` has never run on a runner.**
Confirmed: no `origin/feat/multi-user-backend`, no upstream. Every CI change across plans 2 and 3 —
`playwright install --with-deps`, the 30-minute budget, the two-spec invocation, `workers: 1` — is
validated only against local `docker compose`. This is *why* Task 6's `auth-flow.spec.ts` regression
survived four commits, and plan 3 doubled the job's workload on top of it. Also plan-2 follow-up #18.
**Needs the user's authorization to push.**

## Missing capability the frontend needs

**5. No read route exposes the caller's access level.**
`requireAccess` computes `schemaAccess.level` and `GET /:id` discards it, so a client can only learn
whether it holds `view`/`edit`/`own` by attempting an action and reading the failure. Consequences
today: `ShareDialog` infers ownership from a 200 on `GET /grants` (correct for "am I at `own`", but not
the same as ownership — see #6), and the page-wide read-only state for viewers could not be built at
all. Fix: add `access: 'view' | 'edit' | 'own'` to the `GET /:id` response. It leaks nothing —
`owner_id` is withheld because it identifies a *third party*, whereas `access` describes only the
caller's own capability. One line, since the guard already has it.

**6. The transfer form is shown to callers who cannot use it.**
Following from #5: a previous owner keeps an `owner` grant by design, and an admin holds `own` on
everything, so both reach `own` without being the owner. They see the Transfer form and now get a
correct 403 message ("Only the current owner may transfer this schema") — but the form should not have
been offered. Hide it once #5 lands.

**7. `OntologyBuilderPage.tsx` (3300+ lines) has no test harness at all.**
The anonymous-CTA fix in the final wave is verified only by typecheck and a build. Any future
behavioural change to that page is equally unverifiable. Splitting the file is plan-01 follow-up #17;
until then, new logic belongs in extracted components that *can* be tested.

## Performance

**8. `schema_grants` has no index on `grantee_id`.** The PK is `(schema_id, grantee_id)`, so the
`?scope=shared` query — which filters on `grantee_id` alone — cannot use the PK prefix and sequential
scans. The guard's own LEFT JOIN is fine (it pins `schemas.id` first). Same class as plan-2's
`lower(email)` index; both want one migration in plan 4.

## Test coverage

**9. Five of the six child-write routes are unpinned in the tightening direction.** The final wave
added an editor-grantee `POST /:id/classes` success assertion, so that one route is pinned at `edit`.
The other five (`PATCH`/`DELETE` classes, `POST`/`PATCH`/`DELETE` properties) would still pass the
whole suite if promoted to `own`. One editor-grantee assertion per route closes it.

**10. The moderation 404 byte-equality guard is one-directional.** The test builds a *replica* of
`server.ts`'s catch-all handler rather than requesting a genuinely unregistered path, so the moderation
route drifting is caught but `server.ts` drifting is not — both sides could move together silently. The
same 404 shape now lives in three places with no shared source of truth.

**11. `sharing-flow.spec.ts` has never run against a stack it did not create.** The final wave made
assertion 6 re-runnable by reading only; the e2e was not executed because an unrelated Docker stack
occupied the ports. Worth one clean run before merge.

## Smaller items

**12. `fastify.requireRole` has no production consumer.** The moderation route built `requireModerator`
instead, because it needs 404-not-403. The decorator is exercised only by its own test. Either delete
it or give it the one caller it was built for.

**13. An `Authorization` header that `bearer()` cannot parse at all** now sets `authError = 'invalid'`,
but the reserved `'local'` subject still reads as plain anonymity — so a token minted for it yields
`200 []` on `GET /` rather than a 401. Harmless (that subject can never authenticate) but inconsistent.

**14. `UPPER_CONCEPTS_RATE_LIMIT` is IP-keyed** on two authenticated routes, exactly the weakness fixed
for the user lookup. Same one-line `keyGenerator`. And nothing sets `trustProxy`, so behind an ingress
the global 300/min is one bucket for the whole deployment. Plan-2 follow-up territory; plan 3 only
confirmed it.

**15. `api/src/test/authApp.ts`'s docstring** says `prefix` is mandatory when `routes` is given; the
code silently defaults it to `''`.
