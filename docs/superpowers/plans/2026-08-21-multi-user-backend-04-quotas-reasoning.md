# Multi-user Backend — Plan 4: Quotas and automatic reasoning

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saving a schema gets it checked. The server generates the OWL itself, reasons over it at most once per distinct content, remembers the verdict, shows it on the schema page — to anonymous readers too when the schema is public — and no single user can spend the whole host's reasoning budget.

**Architecture:** Every mutation marks its schema dirty. A debouncer waits for the edit burst to end, generates OWL from the database through `@sulo/schema-core` (the same generator the frontend uses, so the verdict describes the stored schema rather than whatever a client claimed), hashes it together with the SULO and ROBOT versions, and either reuses a cached report or enqueues a durable job. Workers claim jobs with `FOR UPDATE SKIP LOCKED`, ordered so one user's backlog cannot starve everyone else's. Quotas are per-tier, counted from `usage_events`, and **cache hits are free** — otherwise ordinary editing would exhaust a tier in minutes. `POST /reason` with client-supplied Turtle stops existing in postgres mode, which removes the last anonymous path to the JVM.

**Scope boundary:** no SSE (plan 5) — the frontend polls the report endpoint for now, and plan 5 replaces the polling with `LISTEN`/`NOTIFY`. No admin console beyond what plan 3 shipped.

**Tech Stack:** Fastify 5, Kysely, Postgres 16 (`FOR UPDATE SKIP LOCKED`, partial unique indexes), ROBOT + HermiT via `execFile`, `@sulo/schema-core`, vitest 2 + `@testcontainers/postgresql`, React 18 + react-query 5.

**Spec:** `docs/superpowers/specs/2026-08-19-multi-user-backend-design.md` — sections 6 (Quotas and fair scheduling) and 7 (Automatic reasoning pipeline), plus §3 for `reasoning_reports`, `reason_jobs` and `usage_events`.

**Predecessors:** plans 1-3, all complete and reviewed. Their open items live in `2026-08-20-plan-01-followups.md`, `2026-08-20-plan-02-followups.md` and `2026-08-21-plan-03-followups.md`. **Three of those are load-bearing here and are called out at the tasks that must handle them.**

## Global Constraints

- Node 22; TypeScript strict, NodeNext ESM — **every relative import ends in `.js`**.
- Postgres only through Kysely. Migrations are plain `.sql` in `api/migrations/`, `NNN_description.sql`, never edited once applied. **`reasoning_reports`, `reason_jobs` and `usage_events` already exist from migration 001**, including the partial unique index `reason_jobs (schema_id) where state in ('queued','running')`. This plan needs **one** new migration at most (an index; see Task 4) — if you find you need more, stop and report it, because it means the model and the spec have diverged.
- **`import type` only for kysely in any file reachable from `routes/v1/index.ts`.** Six files carry that invariant banner today; pkg cannot snapshot kysely values and the packaged desktop binary dies at startup if one is evaluated. This has already broken twice. Any new file on that graph gets the banner.
- **The frozen SQLite desktop path keeps today's reasoning behaviour exactly**: `POST /reason` with client-supplied Turtle, the in-process FIFO gate, no quotas, no queue, no cache. Everything this plan adds is postgres-mode only. The packaged binary must build and boot.
- **Cache hits do not consume quota**, and a report is only valid for the SULO and ROBOT versions that produced it — both go into the cache key, so a SULO update invalidates rather than silently serving a verdict computed against a different upper ontology.
- Anonymous callers may **read** a cached report for a `public`/`unlisted` schema (plan 3's `requireAccess('view')` already expresses this) and may never cause a run.
- Commit after every task. Never `git commit` outside the steps that say to; never push, open a PR, or amend an existing commit.

---

### Task 1: Server-side OWL generation

**Files:**
- Create: `api/src/modules/reasoning/owl.ts`, `api/src/modules/reasoning/owl.test.ts`
- Modify: `docker/api/Dockerfile` (production and development stages), `api/src/modules/schemas/service.ts` (expose what the generator needs, if anything is missing)
- Test: `api/src/modules/reasoning/owl.test.ts`

**Interfaces:**
- Produces: `generateOwl(db, schemaId)` → `{ turtle: string; contentHash: string } | undefined` (undefined when the schema does not exist), where `contentHash` is `sha256(turtle)`.

**This task is a prerequisite, not a feature.** Nothing in `api/src` imports `@sulo/schema-core` today — the dependency is declared and unused — and **the production Docker stage never copies `packages/`**, so the workspace symlink dangles in the image. That is plan-01 follow-up #6, which says in as many words that it must land before server-side OWL generation. Fix it here or every later task in this plan works locally and fails in the deployed image.

- [ ] **Step 1: Write the failing generator test**

Create `api/src/modules/reasoning/owl.test.ts`, against a real container. The cases that matter:

- a schema with classes and properties produces non-empty Turtle containing the minted class and property IRIs;
- **the same schema generates byte-identical Turtle on repeated calls** (this is the property the whole cache depends on — if generation is not deterministic, every save is a cache miss and a JVM run);
- **row insertion order does not change the output**: build two schemas with the same content inserted in different orders and assert equal Turtle, since the repository orders by name;
- a schema whose `baseUri` is set mints IRIs under it;
- changing one property's `isRequired` changes the hash, and changing nothing leaves it equal;
- a nonexistent id returns `undefined`, not an empty document (an empty document would hash stably and cache a meaningless "consistent" verdict).

- [ ] **Step 2: Run it to verify it fails, then implement**

```ts
// Generates the OWL the reasoner checks, from the database rather than from
// anything a client sent. Uses @sulo/schema-core — the same generator the
// frontend uses for its downloads — so the verdict shown on a schema page
// describes the schema as stored.
//
// INVARIANT: `import type` only for kysely here. This module is reachable from
// routes/v1/index.ts, which both storage modes load, and pkg cannot snapshot
// kysely's top-level-await modules — a value import kills the packaged desktop
// binary at startup. See modules/acl/grants.repo.ts for the same note.

import { createHash } from 'node:crypto';
import { generateExports } from '@sulo/schema-core';
import type { Kysely } from 'kysely';
import type { DB } from '../../db/types.js';
import * as service from '../schemas/service.js';

export interface GeneratedOwl {
  turtle: string;
  contentHash: string;
}

export async function generateOwl(db: Kysely<DB>, schemaId: string): Promise<GeneratedOwl | undefined> {
  const schema = await service.schemaById(db, schemaId);
  if (!schema) return undefined;

  const { turtleOwl } = generateExports(schema);
  return {
    turtle: turtleOwl,
    contentHash: createHash('sha256').update(turtleOwl, 'utf8').digest('hex'),
  };
}
```

`service.schemaById` may not exist under that name — plan 3 deleted an unscoped `getSchemaWithChildren` precisely because it was an ungated read-by-id. **Do not resurrect it.** This module is called from the pipeline, not from a request, so it legitimately needs an unguarded read; add it under a name that says so (`schemaForReasoning`, say) with a comment explaining why it is exempt from the guard rule, and keep the guarded `schemaWithChildren(db, row)` as the only thing routes use.

- [ ] **Step 3: Fix the image, then prove it**

In `docker/api/Dockerfile`'s **production** stage, copy the built package before the workspace install so the symlink resolves: the manifest and `dist` from the builder, matching what the `development` stage already does. Then:

```bash
docker compose -f docker-compose.yml build api
docker compose -f docker-compose.yml up -d
# prove the module resolves *inside the image*, not just on the host
docker compose -f docker-compose.yml exec api node -e "import('@sulo/schema-core').then(m => console.log(typeof m.generateExports))"
docker compose -f docker-compose.yml down
```

Expected: `function`. A `ERR_MODULE_NOT_FOUND` here is the dangling symlink, and it is exactly what this step exists to catch.

- [ ] **Step 4: Full gates and commit**

Root `npm run typecheck` and `npm test`; `npm run build -w sulo-schema-builder-api`; `node api/scripts/package-desktop.mjs`, boot the binary with `NODE_ENV=production`, curl `/api/v1/health`. The packaged gate matters here specifically: you have added a real import of `@sulo/schema-core` to a module on the shared graph.

```bash
git add -A
git commit -m "feat(reasoning): generate the OWL to be checked from the database

Uses the same @sulo/schema-core generator the frontend does, so a verdict
describes the stored schema rather than a client's claim about it, and ships
the package into the production image, which never carried it."
```

---

### Task 2: Tiers, usage accounting and the quota service

**Files:**
- Create: `api/src/modules/quota/tiers.ts`, `api/src/modules/quota/service.ts`, `api/src/modules/quota/service.test.ts`
- Modify: `api/src/config/quota.ts` (new), `api/src/config/index.ts`
- Test: `api/src/modules/quota/service.test.ts`

**Interfaces:**
- Produces: `TIERS` (a `Record<'free'|'verified'|'staff', TierLimits>`), `limitsFor(tier)`, `recordUsage(db, {userId, kind, schemaId, costMs, cacheHit})`, and `checkQuota(db, user, kind)` → `{ allowed: true } | { allowed: false; retryAfterSeconds: number; reason: string }`.

Spec §6's numbers, which are the defaults and must be env-overridable:

```ts
free:     { runsPerHour: 20,   maxConcurrent: 1, maxOwlBytes: 1_000_000, timeoutMs: 60_000,  maxSchemas: 20,   upperFetchPerHour: 30 }
verified: { runsPerHour: 100,  maxConcurrent: 2, maxOwlBytes: 3_000_000, timeoutMs: 120_000, maxSchemas: 200,  upperFetchPerHour: 120 }
staff:    { runsPerHour: 1000, maxConcurrent: 4, maxOwlBytes: 5_000_000, timeoutMs: 300_000, maxSchemas: 2000, upperFetchPerHour: 600 }
```

- [ ] **Step 1: Write the failing quota test**

Required cases, all against a real container, with users created through the token path (`truncateAll` spares `users`, and the auth plugin caches subject→user — inserting rows directly produces FK and stale-id failures that look like product bugs):

- a fresh user is allowed;
- **a cache hit does not count**: record `runsPerHour` cache-hit events and assert the user is still allowed — this is the case that makes automatic reasoning survivable, so it is the one to write first;
- `runsPerHour` real runs exhausts the tier, and the denial carries a `retryAfterSeconds` derived from the oldest event in the window, not a constant;
- the window slides: an event older than an hour does not count (insert with a backdated `created_at`);
- tiers differ — a `staff` user is still allowed where a `free` user is denied;
- `maxSchemas` is enforced at creation and counts only schemas the user **owns**, not ones shared with them;
- an unknown tier value falls back to the most restrictive tier rather than throwing or defaulting to permissive.

That last one deserves a moment: `users.quota_tier` is CHECK-constrained, so an unknown value should be impossible — but "impossible" states reached through a future migration should fail closed, not open.

- [ ] **Step 2: Implement, verify, commit**

Count with a single index-backed aggregate over `usage_events (user_id, created_at desc)` — the index exists from migration 001. `recordUsage` must never throw into a caller's critical path: a metering failure should be logged and swallowed, because losing an audit row is better than failing a reasoning run that succeeded. Say in the report where you drew that line.

```bash
npm run typecheck && npm test
git add -A
git commit -m "feat(quota): per-tier limits counted from usage_events

Cache hits are free, so ordinary editing cannot exhaust a tier; denials carry
a real retry-after derived from the window's oldest event; an unrecognised tier
fails closed."
```

---

### Task 3: The content-addressed report cache

**Files:**
- Create: `api/src/modules/reasoning/cache.ts`, `api/src/modules/reasoning/cache.test.ts`
- Test: `api/src/modules/reasoning/cache.test.ts`

**Interfaces:**
- Produces: `cacheKeyFor({ contentHash, suloHash, robotVersion })` → string; `findReport(db, cacheKey)`; `storeReport(db, { cacheKey, report, reasoner, suloHash, durationMs })`.

- [ ] **Step 1: Decide and test what makes a verdict stale**

The key is `sha256(contentHash ‖ suloHash ‖ robotVersion)` per spec §3. `contentHash` comes from Task 1; `robotVersion` from `config.reasoner.robotVersion`; **`suloHash` you must add** — `services/sulo.service.ts` resolves which SULO file is in play (`resolveSuloPath`) but exposes no digest. Add one, cache it in memory keyed by path+mtime so every save does not re-read a megabyte of Turtle, and make sure `checkForSuloUpdate` invalidates it.

Required cases: identical inputs give identical keys; a different `contentHash`, `suloHash` or `robotVersion` each change the key; `findReport` misses on an unknown key and hits on a stored one; `storeReport` is idempotent on the same key (a concurrent duplicate must not error — use `on conflict do nothing`); and a stored report round-trips its `jsonb` structure exactly, including nested `clashes`.

Write the SULO-hash-changes-the-key case explicitly. It is the one that prevents the single worst failure mode in this plan: showing a user a green "consistent" badge computed against an ontology that has since changed underneath it.

- [ ] **Step 2: Implement, verify, commit**

```bash
npm run typecheck && npm test
git add -A
git commit -m "feat(reasoning): content-addressed report cache

A verdict is keyed by the OWL, the SULO digest and the ROBOT version together,
so a toolchain or upper-ontology change invalidates rather than silently
serving a verdict computed against something else."
```

---

### Task 4: The durable queue and fair scheduler

**Files:**
- Create: `api/src/modules/reasoning/queue.repo.ts`, `api/src/modules/reasoning/queue.test.ts`, `api/migrations/003_reason_jobs_scheduling.sql` (only if Step 1 concludes an index is needed)
- Test: `api/src/modules/reasoning/queue.test.ts`

**Interfaces:**
- Produces: `enqueue(db, {schemaId, requestedBy, cacheKey})` → `'queued' | 'already-pending'`; `claimNext(db, …)` → a claimed job or undefined; `finish(db, jobId, outcome)`; `sweepStuck(db, {maxAttempts})`.

**AMENDED before dispatch** (a reviewer spotted this while reviewing Task 2, as the same failure shape as
that task's two plan gaps): the concurrency cap and the wall-clock timeout are **per tier**, not global.
Spec §6 says claiming skips "users already at their tier's `maxConcurrent`" and enforces "a per-tier
wall-clock timeout" — so a flat `maxPerUser` / `runningTimeoutMs` scalar would define the numbers in
`TIERS` (Task 2 already did) and then silently lose the tier differentiation at the only place it matters.

Concretely: `claimNext` must resolve each *candidate's* cap from that requester's own tier (join `users`,
or resolve `limitsFor(tier)` per candidate), so a `staff` user may hold 4 running jobs while a `free` user
is skipped at 1 — in the same queue, in the same statement. `sweepStuck` must likewise compare each
running job's age against the requester's tier `timeoutMs` rather than one number for everyone. Add a test
with two users on different tiers proving both: a `free` user is skipped at their cap while a `staff` user
is still claimable, and a long-running `free` job is swept before a `staff` job of the same age.

The global `REASONER_MAX_CONCURRENT` ceiling stays what it is — a cap on total JVMs, orthogonal to and
enforced above the per-user tier caps.

- [ ] **Step 1: Write the failing queue test — the concurrency cases are the point**

Migration 001 already has `create unique index reason_jobs_one_active_per_schema on reason_jobs (schema_id) where state in ('queued','running')`. Judge whether `claimNext`'s ordering needs a supporting index and add migration 003 only if so; say either way in your report.

Required cases:
- `enqueue` twice for one schema yields `'already-pending'` the second time and leaves exactly one row (the partial unique index is what enforces this — assert the row count, and use `on conflict do nothing` rather than catching an error);
- `claimNext` marks the job `running` and sets `started_at`;
- **two concurrent `claimNext` calls never return the same job** — run them against two pool clients and assert two distinct ids (or one plus undefined). This is what `FOR UPDATE SKIP LOCKED` buys and it is worth proving rather than assuming;
- **fairness**: with user A holding 5 queued jobs and user B holding 1, and `maxPerUser: 1`, a worker that already has A's job running must claim **B's**, not A's second. Build the state explicitly;
- a user at `maxPerUser` running jobs is skipped, and becomes claimable again once one finishes;
- `sweepStuck` requeues a `running` job whose `started_at` is older than the timeout, increments `attempts`, and marks it `failed` at `maxAttempts` rather than looping forever;
- `finish` with success and with failure both leave a terminal state that `claimNext` will not return.

- [ ] **Step 2: Implement, verify, commit**

The claim is one statement: select the candidate with `for update skip locked`, ordered by (the requester's running count ascending, `enqueued_at` ascending), excluding users at their cap, then update it to `running` and return it. Prefer one CTE-based statement over a read-then-write pair — the latter reintroduces exactly the race the lock is there to prevent.

```bash
npm run typecheck && npm test
git add -A
git commit -m "feat(reasoning): durable queue with fair, race-free claiming

Jobs survive a restart, one pending job per schema is enforced by the database
rather than by hope, and claiming skips users at their concurrency cap so one
person's backlog cannot starve everyone else's."
```

---

### Task 5: The pipeline — dirty marking, debounce, worker

**Files:**
- Create: `api/src/modules/reasoning/pipeline.ts`, `api/src/modules/reasoning/debounce.ts`, `api/src/modules/reasoning/worker.ts`, `api/src/modules/reasoning/pipeline.test.ts`
- Modify: `api/src/modules/schemas/service.ts` (mark dirty in the same transaction as each mutation), `api/src/server.ts` (start the worker and the sweep in postgres mode only)
- Test: `api/src/modules/reasoning/pipeline.test.ts`

**Interfaces:**
- Produces: `markDirty(trx, schemaId)`; `scheduleCheck(deps, schemaId, requestedBy)`; `runOnce(deps)` (claim → reason → store → settle, returning what it did); `startWorkers(deps)` / `stopWorkers()`; `sweepLoop(deps)`.

- [ ] **Step 1: Write the failing pipeline test with a fake reasoner**

Inject the reasoner rather than spawning a JVM: the pipeline's job is orchestration, and a fake makes the interesting cases cheap. Required:

- a mutation sets `reason_state='stale'` **in the same transaction** — assert that a failed mutation leaves no dirty mark;
- a stale schema whose generated OWL hashes to a **known** cache key resolves to `fresh` with **no job enqueued and no run**, and records a `cache_hit` usage event;
- a stale schema with an unknown key enqueues exactly one job, and `runOnce` moves it `queued → running → done`, stores the report, sets `latest_report_key` and `reason_state='fresh'`;
- a reasoner failure sets `reason_state='failed'` and records the error, without poisoning the cache with a failed verdict;
- an OWL larger than the tier's `maxOwlBytes` is **not** enqueued: `reason_state='failed'` with a reason the UI can show, per spec §6;
- a quota denial leaves `reason_state='stale'` (not `failed`) so the check resumes later, and records nothing as a run;
- **a newer edit during a run supersedes the queued follow-up rather than queueing two** — the partial unique index does the work, but assert the end state;
- the debouncer coalesces a burst into one check, and its 30 s max-wait fires for a schema being edited continuously;
- `sweepStuck` recovers a job whose worker died mid-run (simulate by leaving it `running` with an old `started_at`).

- [ ] **Step 2: Implement, verify, commit**

Two details worth getting right rather than discovering later. The debouncer's timers are per-process, so a multi-replica deployment needs the sweep to catch schemas left `stale` — that is why the sweep exists, and it should also pick up `stale` rows older than a couple of minutes, not only stuck `running` jobs. And the worker must not be started in sqlite mode: `server.ts` already branches on `config.storage === 'postgres'` for the pg plugin and auth, so start it there, and make sure a `stopWorkers()` runs on `onClose` so tests and reloads do not leak timers.

```bash
npm run typecheck && npm test
git add -A
git commit -m "feat(reasoning): check a schema after the edit burst settles

Mutations mark their schema dirty in the same transaction; a debouncer waits
for the burst, reuses a cached verdict when the content is unchanged, and
otherwise enqueues one job. Oversized OWL and exhausted quotas are reported
states, not silent stalls."
```

---

### Task 6: The report endpoints, and retiring client-supplied Turtle

**Files:**
- Create: `api/src/modules/reasoning/routes.ts`, `api/src/modules/reasoning/routes.test.ts`
- Modify: `api/src/routes/v1/index.ts`, `api/src/routes/v1/reason.ts`
- Test: `api/src/modules/reasoning/routes.test.ts`

**Interfaces:**
- Produces: `GET /ontology-schemas/:id/report` → `{ state, report?, cacheKey, computedAt, stale }` at **view** level; `POST /ontology-schemas/:id/report/refresh` at **edit** level, quota-checked.

**AMENDED after Task 2** (which found the gap): this task also owns the two quota call sites the plan
originally implemented but never wired, both of which are spec §6 requirements:

- **`maxSchemas` on `POST /ontology-schemas`** — `checkQuota(db, user, SCHEMA_CREATE)` before the insert,
  answering **409** with `quota_exceeded` and the tier's limit in the message. Task 2 built and tested the
  logic, including that it counts only schemas the user *owns*; nothing calls it. Test both the allowed
  path and the 409, and assert the 409 creates no row.
- **`upperFetchPerHour` on both upper-concept routes** — the schema-scoped `GET /:id/upper-concepts` and the
  standalone `GET /upper-concepts?iri=`. Both already require a session and carry a per-route rate limit;
  the quota is the per-user budget on top of it, and it is the only thing that meters the *remote fetches*
  this deployment performs on a user's behalf. Record a `usage_events` row per fetch (`kind:
  'upper_concepts_fetch'`) so the metering exists, and answer 429 with `retryAfter` when exhausted.
  A cached upper-concepts response must not consume budget, for the same reason a cached report does not.

- [ ] **Step 1: Decide what leaves the building, then write the failing test**

Both routes are ACL-guarded through plan 3's `requireAccess`, so **register `aclGuards` in this plugin** — `fp` escapes one encapsulation level only, and forgetting is silent because Fastify does not seal `request`. Plan 3's `grants.test.ts` has a test that fails if the registration is removed; write the equivalent here.

Required cases: an owner reads a report; a `viewer` grantee reads it; an **anonymous** caller reads it for a `public` schema and gets 404 for a private one (identical to a nonexistent id); a `viewer` cannot refresh (403) while an editor can; a refresh over quota returns 429 with `retryAfter`; a refresh on a schema whose report is already fresh is a no-op success rather than a duplicate run; and the response for a schema that has never been checked says so explicitly rather than returning a null-shaped report.

**CLARIFIED after Task 7** (which built the client against this contract and found the ambiguity):
`reason_state` alone cannot express "never checked", because `stale` is both the column's initial default
*and* the state of a schema edited since its last successful check. Those two look identical to a client
and must not, since one shows "not checked yet" and the other should keep showing the previous verdict
while a new one is computed. Disambiguate on `latest_report_key`:

- `state: 'stale'` with `latest_report_key` **null** → never checked. Return no `report`, and let the
  client say so.
- `state: 'stale'` with a `latest_report_key` → edited since the last check. Return the **previous**
  report alongside `stale: true`, so the UI can show the old verdict greyed rather than blanking it.

So the response's top-level `stale` boolean means "this verdict predates the current content", and it is
only ever true when a `report` is present. Task 7 already handles the second case (an untested path in its
suite, by its own disclosure) — add the coverage when you land the endpoint, and assert both shapes.

Then the deletion, which is the security half of this task: **`POST /reason` (client-supplied Turtle) must not be registered in postgres mode.** Spec §7 is explicit, and it removes the last path by which a caller makes the host spawn a JVM over bytes it chose. Keep it in sqlite mode, where the reasoner is the local user's own machine. Assert both: the route 404s in postgres mode and still works in sqlite mode.

- [ ] **Step 2: Implement, verify, commit**

```bash
npm run typecheck && npm test
npm run build -w sulo-schema-builder-api && node api/scripts/package-desktop.mjs
# sqlite mode must still reason from client-supplied Turtle
git add -A
git commit -m "feat(reasoning): report endpoints, and no more client-supplied Turtle

A verdict is readable by anyone who may read the schema, including anonymous
readers of a public one; refreshing needs edit and spends quota. The web
deployment no longer reasons over bytes a caller chose — the desktop build,
where the JVM is the user's own, still does."
```

---

### Task 7: Show the verdict

**Files:**
- Create: `frontend/src/api/report.ts`, `frontend/src/components/ConsistencyBadge.tsx`, `frontend/src/components/ConsistencyBadge.test.tsx`
- Modify: `frontend/src/pages/OntologyBuilderPage.tsx` (wiring only)
- Test: `frontend/src/components/ConsistencyBadge.test.tsx`

- [ ] **Step 1: Write the failing badge test, then implement**

The badge is the whole point of the plan from a user's perspective, and it has more states than it first appears: never checked, queued, running, fresh-and-consistent, fresh-with-clashes, failed, and **stale-because-quota-exhausted** (which needs to say when to come back, not just "pending"). Cover each, plus: an anonymous viewer of a public schema sees the verdict; clashes are listed with their explanations; and the refresh control is absent for a caller who cannot refresh.

Poll the report endpoint while the state is `queued`/`running` and stop when it settles — plan 5 replaces the polling with SSE, so keep the fetching in `frontend/src/api/report.ts` where it can be swapped without touching the component.

`OntologyBuilderPage.tsx` stays wiring-only. Note it has no test harness at all (plan-3 follow-up #7), so anything with real logic belongs in the component, where it can be tested.

- [ ] **Step 2: Verify and commit**

```bash
npm run build -w @sulo/schema-core && npm run typecheck && npm test
npm run build -w sulo-schema-builder-frontend
git add -A
git commit -m "feat(reasoning): show the latest verdict on the schema page"
```

---

### Task 8: Prove the pipeline end to end

**Files:**
- Create: `frontend/e2e/reasoning-flow.spec.ts`
- Modify: `.github/workflows/ci.yml`
- Test: `frontend/e2e/reasoning-flow.spec.ts`

- [ ] **Step 1: Write the spec, run it, report per assertion**

Against the real stack with a real JVM: sign in, create a schema with a deliberate contradiction (an `owl:disjointWith` pair plus an instance forced into both, or the simplest thing HermiT reports as unsatisfiable), wait for the badge to settle, and assert the clash is shown. Then: fix the contradiction, watch it return to consistent, and **re-introduce the original contradiction and assert the verdict comes back from cache** — that last one is the plan's central claim and nothing else tests it end to end. Finally, publish the schema and assert an anonymous context can read the verdict.

Add it to the existing `e2e-auth` job; note it needs the ROBOT jar and a JRE, which the image already has. Report the wall-clock, because a reasoning e2e is the slowest thing in CI and the 30-minute budget may need revisiting.

**If any assertion fails, stop and report it.** After seven tasks of unit-level proof, a failure here is the most valuable output this plan can produce.

```bash
git add -A
git commit -m "test(reasoning): prove the save-check-cache loop against a real reasoner"
```

---

## Self-Review

**Spec coverage (§6, §7):**

| Requirement | Task |
| --- | --- |
| Per-tier limits (runs/hour, concurrency, OWL bytes, timeout, schemas, upper fetches) | 2 |
| Cache hits do not consume quota | 2, 5 |
| Denials carry a real retry-after; oversized OWL is a reported state | 2, 5 |
| `maxSchemas` at creation, owned schemas only | 2 |
| Durable `reason_jobs`; one pending job per schema | 4 |
| `FOR UPDATE SKIP LOCKED`, fair claiming, per-user cap | 4 |
| Recovery sweep for stuck jobs and lost debounce timers | 4, 5 |
| Mutation marks dirty in the same transaction | 5 |
| Debounce 5 s idle / 30 s max wait, coalescing a burst | 5 |
| Server-side OWL from the DB via the shared generator | 1 |
| Cache key includes SULO digest and ROBOT version | 3 |
| `GET …/report` at view level, anonymous on public | 6 |
| `POST …/report/refresh` at edit level, quota-checked | 6 |
| `POST /reason` unregistered in postgres mode | 6 |
| Verdict visible on the schema page, anonymous included | 7 |

Deferred by design: SSE (plan 5 — Task 7 polls deliberately, in a module built to be swapped), and the admin surface beyond plan 3's unpublish.

**Carried-forward items this plan must close, restated because each is a silent failure:** plan-01 follow-up #6 (the production image never copies `packages/`, so `@sulo/schema-core` dangles — Task 1); the packaged-binary `import type` invariant (six files today, more here — Tasks 1, 3, 4, 5); and plan-3 follow-up #8's missing `schema_grants(grantee_id)` index, which Task 4 should fold into migration 003 if it writes one at all.

**The two judgement calls I expect to be argued with:** `recordUsage` swallowing its own failures (losing an audit row beats failing a successful run — Task 2 asks for the line to be drawn explicitly), and Task 7 polling rather than waiting for plan 5's SSE (shipping a visible verdict now beats a prettier mechanism later, provided the fetching stays swappable).
