# Plan 1 follow-ups

Residuals from the final whole-branch review of `feat/multi-user-backend` (plan 1: foundation).
All ten review findings were fixed; these are what was deliberately deferred, ordered by how much
they matter. Written 2026-08-20.

Plan: `docs/superpowers/plans/2026-08-19-multi-user-backend-01-foundation.md`
Spec: `docs/superpowers/specs/2026-08-19-multi-user-backend-design.md`

## Security — close before exposing the web deployment publicly

**1. `POST /api/v1/reason` dereferences attacker-supplied `owl:imports` IRIs.**
The route accepts caller-supplied Turtle up to `maxInputBytes` and hands it to ROBOT/OWLAPI
(`api/src/services/reasoner.service.ts`), which resolves `owl:imports` over the network with no
allowlist, no DNS pinning and no size cap. This is a second anonymous "make the server fetch an
attacker IRI" path, and it sits outside the guarded helper that plan 1 introduced for the
upper-concept routes. Pre-existing, not introduced by this branch.
Design §7 already unregisters this route in postgres mode as part of plan 3's automatic reasoning
pipeline, which is the natural place to close it. Until then, treat the web deployment as
internal-only.

**2. `safeFetch`'s port allowlist is applied to the initial URL only.**
`publicUrlProblem()` checks the port before the request; the validating DNS lookup re-runs on every
redirect hop, but the port check does not, so a 30x to `http://public-host:22/` is still attempted.
Scheme is safe (a non-http(s) redirect is a network error per spec). The header comment at
`api/src/rdf/safeFetch.ts:21-22` overstates the guarantee — fix the comment with the code.

**3. No PR-time guard on the pkg import-type invariant** (final review I2).
`api/src/modules/schemas/repo.ts` and `service.ts` must keep `kysely` as `import type` or the
packaged desktop binary dies with `ERR_MODULE_NOT_FOUND` — and typecheck, tests and docker all stay
green when that breaks. The only guard is the sidecar smoke step in `release.yml`, which runs on
tags. There is no eslint config in the repo at all (both `lint` scripts are dead). Cheapest fix: a
vitest case walking static imports from `src/index.ts`, or `verbatimModuleSyntax: true` in
`api/tsconfig.json`.

**4. CSP is disabled with a stale rationale** (M5). `api/src/plugins/helmet.ts` cites Swagger UI;
there is no Swagger in the repo, and the SPA is now served to arbitrary visitors.

## Correctness / user-visible

**5. Clearing the upper-ontology IRI or base URI in the UI silently does nothing.**
The API accepts `''` as a clear and is tested; `frontend/src/pages/OntologyBuilderPage.tsx:3325`
(`onSaveMeta`) sends `values.upperOntologyIri || undefined`, so an emptied field omits the key and
the column is left untouched. 2-3 lines in the update path only — the create path needs no change,
and the same file already uses the right idiom at `:1183` and `:1292`. Anyone hand-testing the
clear behaviour will conclude it is broken.

**6. Production image ships a dangling `@sulo/schema-core` symlink** (I3).
`api/package.json` declares the dependency; `docker/api/Dockerfile`'s production stage never copies
`packages/`, so the link resolves to nothing. Inert today because no API file imports the package.
**Must land before plan 3's server-side OWL generation**, or the failure is a runtime
`ERR_MODULE_NOT_FOUND` visible only in the built image.

**7. `DATABASE_URL` defaults silently** (M6). `api/src/config/db.ts` falls back to
`postgres://sulo:sulo@localhost:5432/sulo` while `SCHEMA_STORAGE` now throws on a typo for exactly
the reason a misconfigured deployment must not come up quietly. Require it when
`storage === 'postgres'`.

**8. Child PATCH answers 400 before 404.** `service.assertClassInSchema` runs before the row
existence check, so PATCHing a nonexistent class with a foreign `superClassId` returns 400 rather
than 404. Ordering only.

## CI / build / ops

**9. CI never builds the deployment artifact.** No image build, no compose stack. The only evidence
the Docker path works is a manual local run. Add `docker build --target production` to `ci.yml`.

**10. Compose ≥ 2.24 is now required.** `docker-compose.yml` uses the long-form
`env_file: [{path, required}]`; older v2 plugins fail to parse the whole file. State the minimum in
the README.

**11. `prepare: tsc` in `packages/schema-core`** means a type error there now fails plain
`npm install`/`npm ci` for every workspace user, and costs the Docker layer cache in three stages.
Accepted trade-off for making a clean clone and a release build work at all — revisit if it chafes.

**12. Test code compiles into `dist/` and ships in the image** (M3). `api/tsconfig.json` excludes
`"test"`, a directory that does not exist (the harness is at `api/src/test/pg.ts`). Fix:
`"exclude": ["node_modules", "dist", "src/test", "src/**/*.test.ts"]`.

**13. `REASONER_MAX_CONCURRENT` defaults to 1**; design §6 specifies 2 on the server.

## Cross-mode leak

**14. SULO/Java settings persist through the frozen SQLite layer** (M4).
`api/src/services/sulo.service.ts` and `java.service.ts` import `legacy/sqlite/settings.js`, whose
handle is only bound by the SQLite plugin. In postgres mode `getSetting` returns `null` and
`setSetting` is a silent no-op, so `checkIsDue()` is always true and every anonymous
`POST /api/v1/reason/sulo/check` re-fetches `SULO_URL` and rewrites `dataDir/sulo.ttl` under only
the global 300/min limit. Design §9 says the legacy tree is registered only for
`SCHEMA_STORAGE=sqlite`; this is a live cross-mode dependency. Give settings a Postgres-backed or
in-memory implementation, or gate the route on `isPackaged` as `/reason/java-path` already is.

## Docs and dead code

**15.** Status-code divergences from the frozen route contradict `routes.ts`'s "identical status
codes" header comment: PATCH/DELETE of an unknown child returns 404 where legacy returned 204, and
`GET /:id/upper-concepts` on an unknown schema returns 404 where legacy returned `200 []`. The new
codes are better — fix the comment.

**16.** `README.md` still documents backup/restore via a `/sparql` CONSTRUCT endpoint and a
`qlever-init` service, neither of which exists; there is no `pg_dump` guidance. `TEST_CASES.md`
still points at `frontend/src/lib/ontologyExport.test.ts`, moved to `packages/schema-core/src/`.

**17.** Dead code inventory: `migrate:dist` script; `IdParam`/`ClassIdParam`/`PropIdParam` in
`modules/schemas/schemas.ts`; `void schema;` in `frontend/src/test/fakeBackend.ts`; the duplicate
`url` assignment in `service.getSchemaWithChildren`; `api/scripts/migrate-qlever-to-sqlite.ts`
(outside `tsconfig` include, never typechecked); the `./sparql/files` mount in
`docker-compose.override.yml`; `lint` scripts with no eslint config; `.gitignore`'s
`!.env.example` with no such file.

**18.** Rate limiting counts static assets — SPA chunks share the 300/min budget with API calls, so
a classroom behind one NAT can trip 429s on assets. Also, the two upper-concept routes carry
separate 30/min buckets (60/min combined per IP), and `guardedUpperConcepts` caches on the raw IRI
while the SULO check normalizes it, so trailing-slash variants get duplicate cache entries.

## For plan 2 specifically

- The seeded `LOCAL_OWNER_ID` row carries `global_role='admin'` and `quota_tier='staff'`, and its
  `subject` is `'local'`. That subject must never be issuable as a Keycloak `sub`.
- `getSchemaWithChildren` is not owner-scoped — it does not need to be until authentication exists,
  but the ACL resolver must not assume it is.
- Item 5 above (the UI clear) and item 6 (the dangling symlink) are the two that get more expensive
  the longer they wait.
