# Multi-user Backend — Plan 5: Change publication and administration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A schema page updates itself when something changes it, instead of asking every few seconds; and an operator can see who is using the deployment, adjust a user's tier, and deal with a stuck job — without a psql prompt.

**Architecture:** Postgres `NOTIFY` carries **hints only** — `{ kind, at }`, never data — on a channel per schema. One dedicated `pg` connection per API process holds the `LISTEN` and fans out in-process to SSE subscribers on `GET /ontology-schemas/:id/events`, gated by plan 3's `requireAccess('view')` so an anonymous reader of a public schema is a first-class subscriber and a private schema leaks nothing. The frontend replaces plan 4's polling by swapping the implementation inside `frontend/src/api/report.ts` — that file exists precisely so this is a one-file change. Admin routes are role-guarded the way plan 3's moderation route is: **404, not 403, for everyone else**, because on an admin surface the route itself is the secret.

**Scope boundary:** this is the last plan of the five. It does not add a moderation audit log or make unpublish irreversible (plan-3 follow-up #1 — that needs a migration and a product decision), does not close the identity follow-ups (the `enabled` ban path, `requiredClaims`, the unbounded user cache), and does not touch the deferred index work beyond what Task 1 needs.

**Tech Stack:** Fastify 5, Postgres `LISTEN`/`NOTIFY` via `pg`, SSE over `fetch` + `ReadableStream` (never `EventSource` — see below), Kysely, React 18 + react-query 5, vitest 2 + `@testcontainers/postgresql`, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-19-multi-user-backend-design.md` — section 8 (Change publication) and the admin surface named in section 5.

**Predecessors:** plans 1-4. Their open items live in the four follow-up files under `docs/superpowers/plans/`. **Read `2026-08-21-plan-03-followups.md` #5 before Task 4** — the API still does not tell a client its own access level, and the admin UI will want it.

## Global Constraints

- Node 22; TypeScript strict, NodeNext ESM — **every relative import ends in `.js`**.
- Postgres only through Kysely for queries. `LISTEN`/`NOTIFY` needs a raw `pg` client (Kysely has no long-lived listener API) — that is the one sanctioned exception, and it must be a **separate** connection, never one borrowed from the pool, or it will block a pool slot for the process's lifetime.
- **`import type` only for kysely in any file reachable from `routes/v1/index.ts`.** Seven files carry that banner now. pkg cannot snapshot kysely values and the packaged desktop binary dies at startup if one is evaluated — this has broken twice. The listener module holds a real `pg` client, so **it must not be statically imported** from the shared graph; load it the way `plugins/pg.js` is loaded, inside the postgres branch of `server.ts`.
- **The frozen SQLite desktop path gets none of this**: no listener, no SSE route, no admin routes. It is single-user and loopback-bound. The packaged binary must build and boot.
- **NOTIFY payloads carry no schema data.** Postgres caps a payload at 8000 bytes, and more importantly a payload is delivered to every listener in the process regardless of who may read the schema — so the payload is a hint and the client refetches through the ACL-checked endpoints it already uses. Never put a report, a title, or an owner id in a notification.
- **SSE, not `EventSource`.** `EventSource` cannot set an `Authorization` header, and a token in the query string lands in access logs and proxy logs. Consume the stream with `fetch` + `ReadableStream`, which plan 2's axios interceptor pattern already implies for auth.
- Commit after every task. Never `git commit` outside the steps that say to; never push, open a PR, or amend an existing commit.

---

### Task 1: Notify on change

**Files:**
- Create: `api/src/modules/events/notify.ts`, `api/src/modules/events/notify.test.ts`
- Modify: `api/src/modules/schemas/service.ts`, `api/src/modules/reasoning/pipeline.ts` (both already run inside transactions), possibly `api/migrations/00N_*.sql` (only if Step 1 concludes one is needed)
- Test: `api/src/modules/events/notify.test.ts`

**Interfaces:**
- Produces: `notifySchemaChanged(trx, schemaId, kind)` where `kind` is `'mutated' | 'report'`; the channel name helper `channelFor(schemaId)`.

- [ ] **Step 1: Decide the channel shape before writing anything**

Two options, and the choice has consequences a test will not catch:

- **One channel per schema** (`schema:<uuid>`) — a listener subscribes only to what it needs, but `LISTEN` is per-connection and the set of channels grows with the number of open pages. Postgres handles thousands of channels fine, but the process must `LISTEN`/`UNLISTEN` dynamically as subscribers come and go, and that bookkeeping is where the bugs live.
- **One channel for everything** (`schema_changed`) with the schema id in the payload — one `LISTEN` for the process's lifetime, trivial bookkeeping, but every notification wakes every process and the in-process fanout does the filtering.

Pick one, write the reasoning into the module header, and say in your report what you chose and what you gave up. For a deployment of this size (a classroom, not a public SaaS) the second is probably right and the first is probably premature — but decide deliberately rather than by default.

- [ ] **Step 2: Write the failing test**

Required cases, against a real container:
- a mutation inside a transaction produces exactly one notification, delivered to a listener, carrying the schema id and `kind: 'mutated'`;
- **a rolled-back transaction produces none** — this is the case that matters, and it is why the notify goes inside the transaction: `NOTIFY` is transactional in Postgres, so a failed mutation must not tell clients something changed;
- the reasoning pipeline's settle produces `kind: 'report'`;
- the payload is well under 8000 bytes and contains no title, report or owner id (assert on the parsed keys, not just the length);
- two rapid mutations produce two notifications rather than being silently coalesced (coalescing is the client's job, not the database's).

- [ ] **Step 3: Implement, verify, commit**

Use `pg_notify(channel, payload)` through Kysely's `sql` template rather than a raw `NOTIFY` statement, so the payload is parameterised — a schema id is a uuid and cannot inject, but the next person to add a field may not be so careful.

```bash
npm run typecheck && npm test
git add -A
git commit -m "feat(events): announce schema and report changes transactionally

NOTIFY rides inside the mutation's transaction, so a rolled-back write announces
nothing, and the payload is a hint — clients refetch through the endpoints that
already check who may read what."
```

---

### Task 2: The listener and the SSE route

**Files:**
- Create: `api/src/modules/events/listener.ts`, `api/src/modules/events/sse.ts`, `api/src/modules/events/sse.test.ts`
- Modify: `api/src/server.ts` (start the listener in the postgres branch only), `api/src/routes/v1/index.ts`
- Test: `api/src/modules/events/sse.test.ts`

**Interfaces:**
- Produces: `startListener(config)` / `stopListener()`; `subscribe(schemaId, handler)` → unsubscribe; `GET /ontology-schemas/:id/events` (SSE) at **view** level.

- [ ] **Step 1: Write the failing SSE test**

This is the task where the interesting failures live, so the cases are the deliverable:

- a subscriber on a schema receives an event after a mutation to **that** schema, and **not** after a mutation to a different one;
- **an anonymous subscriber to a `public` schema receives events**; an anonymous subscriber to a `private` one gets **404**, identical to a nonexistent id (plan 3's rule, and `requireAccess('view')` should give it to you for free — but assert it, because an SSE route that authorises only at connect time is a different animal from a request/response one);
- **a client that disconnects is cleaned up**: assert the subscriber count returns to zero, because a leak here is a slow death — every abandoned tab holds a handler and an open response forever;
- the stream sends a periodic keep-alive comment, or documents why not: proxies and load balancers commonly kill an idle connection after 30-60s, and a silent death looks exactly like "no changes happened";
- **the listener reconnects** after its connection drops. A `pg` client that loses its socket does not resubscribe itself; without this, events stop silently and the UI quietly goes back to being wrong. Simulate by terminating the backend (`pg_terminate_backend`) and asserting a later notification still arrives.

That last one is the case most likely to be skipped and most likely to matter in production.

- [ ] **Step 2: Implement, verify, commit**

Register `aclGuards` in this plugin — `fp` escapes one encapsulation level only and forgetting is silent, because Fastify does not seal `request` (plan 3 established this the hard way; `grants.test.ts` has a test that fails if the registration is removed, and this plugin wants the same). Load `listener.ts` through `await import()` inside `server.ts`'s postgres branch, since it holds a real `pg` client. Stop it on `onClose` so tests and reloads do not leak connections.

```bash
npm run typecheck && npm test
npm run build -w sulo-schema-builder-api && node api/scripts/package-desktop.mjs
# boot the binary, curl /api/v1/health, and confirm the events route 404s in sqlite mode
git add -A
git commit -m "feat(events): stream changes over SSE, gated by the same ACL as reads

One LISTEN per process fans out in-process to subscribers; an anonymous reader of
a public schema is a first-class subscriber and a private schema answers 404. The
listener reconnects, and a disconnected client is reaped."
```

---

### Task 3: Retire the polling

**Files:**
- Modify: `frontend/src/api/report.ts`, `frontend/src/api/report.test.ts` (or wherever plan 4 Task 7 put its tests)
- Create: `frontend/src/api/events.ts`, `frontend/src/api/events.test.ts`
- Test: both

**Interfaces:**
- Produces: `subscribeToSchema(id, onChange)` using `fetch` + `ReadableStream`; `report.ts` switches from an interval to an event subscription with a polling fallback.

- [ ] **Step 1: Write the failing test, then implement**

Plan 4 Task 7 put all fetching in `frontend/src/api/report.ts` **precisely so this task is a one-file swap**. Verify that held before you start: grep the components for `useQuery`/`fetch`/`apiClient` and report what you find. If data access leaked into a component, say so — that is a finding about plan 4, not a reason to spread this change further.

Required cases: an event triggers a refetch; the stream is closed on unmount (assert no handler survives); a stream that fails falls back to polling rather than going silent — **this is the important one**, because an SSE connection blocked by a corporate proxy must degrade to the behaviour plan 4 shipped, not to a page that never updates; and the `Authorization` header is present on the stream request (which is why this uses `fetch` and not `EventSource`).

- [ ] **Step 2: Verify and commit**

```bash
npm run build -w @sulo/schema-core && npm run typecheck && npm test
npm run build -w sulo-schema-builder-frontend
git add -A
git commit -m "feat(events): replace report polling with a live stream, falling back when it cannot connect"
```

---

### Task 4: The admin surface

**Files:**
- Create: `api/src/modules/admin/routes.ts`, `api/src/modules/admin/admin.test.ts`
- Modify: `api/src/routes/v1/index.ts`
- Test: `api/src/modules/admin/admin.test.ts`

**Interfaces:**
- Produces, all requiring global role `admin` (and answering **404** to everyone else):
  - `GET /admin/users` — id, subject, email, display name, role, tier, created/last seen, and the caller's own schema count. Paginated.
  - `PATCH /admin/users/:id` — `{ globalRole?, quotaTier? }`.
  - `GET /admin/usage?since=` — usage aggregated per user and kind, with cache-hit and cost totals, so an operator can see who is spending the reasoner.
  - `GET /admin/jobs` — the current `reason_jobs` state, and `POST /admin/jobs/:id/requeue` for one that is stuck.

- [ ] **Step 1: Handle the sqlite no-op guard before anything else**

`plugins/authDisabled.ts` supplies `requireRole` as a **no-op** in sqlite mode, so a role-guarded route registered there would admit anyone and then crash on `request.user.role`. Plan 3's moderation route closed this two ways and you must do the same: register these routes only when `config.storage === 'postgres'`, **and** route the role check through a helper that throws loudly if `request.user` is absent. Read `api/src/modules/acl/moderation.routes.ts` and follow it — including its 404-shaped rejection, which must be **byte-identical** to `server.ts`'s unregistered-route body, or the pair becomes an oracle telling an ordinary user that an admin surface exists at that path. Plan 3 shipped that bug and had to fix it; do not re-earn it.

- [ ] **Step 2: Write the failing test**

Required: an admin lists users; a moderator gets 404 (**not** 403 — the route is the secret); an ordinary user gets 404; anonymous gets 401; an admin changes a tier and the change takes effect on the next request (note the 60 s subject→user cache from plan 2 — assert what actually happens rather than what you hope, and if the cache means the change is not visible immediately, **say so in the report**, because that is a real operator-facing surprise); **an admin cannot demote themselves out of admin** (or can, deliberately — decide, and test whichever you choose, because an accidental self-demotion locks the last admin out with no recovery path short of psql); a usage query returns aggregates rather than raw rows; a stuck job requeues and becomes claimable.

- [ ] **Step 3: Implement, verify, commit**

Do **not** expose a user's email to anyone but an admin, and keep `owner_id` out of non-admin responses as plan 3 established. Paginate `GET /admin/users` and `GET /admin/usage` from the start — an unpaginated admin list is fine at ten users and a problem at ten thousand, and adding pagination later changes the response shape.

```bash
npm run typecheck && npm test
npm run build -w sulo-schema-builder-api && node api/scripts/package-desktop.mjs
# confirm every /admin route 404s in sqlite mode
git add -A
git commit -m "feat(admin): users, tiers, usage and stuck jobs

Admin-only, and 404 to everyone else — on this surface the route is the secret,
not the resource. Byte-identical to an unregistered path, as plan 3 established."
```

---

### Task 5: Prove it end to end

**Files:**
- Create: `frontend/e2e/events-flow.spec.ts`
- Modify: `.github/workflows/ci.yml`
- Test: `frontend/e2e/events-flow.spec.ts`

- [ ] **Step 1: Write the spec, run it, report per assertion**

Two browser contexts against the real stack: Alice edits a schema in one, and the **other** context — showing the same public schema, signed out — updates without a reload. That is the plan's whole claim and nothing else tests it. Then: an admin changes Bob's tier through the admin route and the change is visible in a subsequent request; and a schema's verdict badge transitions on its own after an edit, with no polling interval to wait for.

Add to the existing `e2e-auth` job. Report the wall-clock — this suite now boots Postgres, Keycloak, a JVM and two browser contexts, and the 30-minute budget may need revisiting. **If any assertion fails, stop and report it** rather than adjusting the test.

```bash
git add -A
git commit -m "test(events): prove a second browser updates itself, and an admin can change a tier"
```

---

## Self-Review

**Spec coverage (§8, plus §5's admin surface):**

| Requirement | Task |
| --- | --- |
| `pg_notify` per change, payload is a hint only, no data | 1 |
| Transactional — a rolled-back write announces nothing | 1 |
| One dedicated `pg` connection per process holds the `LISTEN` | 2 |
| In-process fanout to subscribers | 2 |
| `GET …/events` SSE gated by the same view-level ACL | 2 |
| Anonymous subscriber on a public schema; 404 on a private one | 2 |
| `fetch` + `ReadableStream`, never `EventSource` (no token in a URL) | 2, 3 |
| Frontend stops polling; degrades to polling if the stream fails | 3 |
| Admin: users, tier changes, usage, jobs | 4 |
| Admin routes 404 to non-admins, byte-identical to unregistered | 4 |
| Real-time collaboration later swaps the payload, not the transport | 1 (hint-only payload is what makes that true) |

**Deliberately not in this plan**, and staying on the follow-up lists: the moderation audit log and irreversible unpublish (needs a migration and a product call), the `enabled` ban path and the identity hardening items, the deferred indexes, `verbatimModuleSyntax`, and exposing `access` on `GET /:id` — though Task 4 may want that last one, so if it does, note it rather than building it.

**The three cases most likely to be skipped and most likely to bite**, called out so a reviewer can check they were not: the listener **reconnecting** after its connection drops (Task 2 — without it, events stop silently and the UI is quietly wrong); the SSE stream **degrading to polling** when a proxy blocks it (Task 3 — otherwise a corporate network sees a page that never updates); and the admin route's 404 being **byte-identical** to an unregistered path (Task 4 — plan 3 shipped this wrong once and the tests passed anyway, because they only checked status codes).
