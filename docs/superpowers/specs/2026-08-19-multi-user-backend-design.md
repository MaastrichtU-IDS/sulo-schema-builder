# Multi-user backend: accounts, ACL/RBAC, quotas, cached reasoning

Date: 2026-08-19
Branch: `feat/multi-user-backend` (based on `a19fcf4`)
Status: approved design, pending implementation plan

## 1. Purpose

The prototype backend has no notion of a user. It runs in one of two modes: a
single-user SQLite database (desktop app, local dev) or a stateless server whose
visitors keep every schema in their own browser (IndexedDB). Neither supports the
thing the project now needs — people with accounts, schemas they own, schemas
they publish, and a reasoner that no single visitor can monopolise.

This design replaces the web deployment with a multi-user server: Postgres-backed
schemas, Keycloak-delegated identity, per-schema access control on top of global
roles, tier-based usage limits with a fair reasoning queue, and consistency
reports that are computed automatically on save, cached by content hash, and
visible to anonymous readers of public schemas.

Browser (IndexedDB) storage is removed. The desktop SQLite path is frozen, not
extended.

## 2. Decisions

| Question | Decision |
| --- | --- |
| Identity | Local accounts plus ORCID and GitHub sign-in, delegated to a Keycloak container (approach B) |
| Datastore | Postgres, with `LISTEN`/`NOTIFY` as the change-publish primitive for future collaboration |
| Sharing model | Per-schema ACL (`viewer`/`editor`/`owner`) plus global roles (`user`/`moderator`/`admin`); no teams in v1 |
| Usage limits | Per-tier quotas plus a per-user fair queue in front of the reasoner |
| Browser storage | Deleted |
| Desktop build | Frozen on the current SQLite code; no auth, no new features |
| Anonymous access | Read public schemas and their cached reports; no writes, no reasoning, no upper-ontology proxy |
| OWL generation | Server-side, from database rows, via a shared `@sulo/schema-core` package |
| Reasoning trigger | Debounced per schema (5 s idle, 30 s max wait), content-hash deduplicated |

Rejected alternatives, with reasons, so they are not relitigated:

- **Own credential code (approach A).** Fully viable, but password reset, email
  verification, brute-force lockout and OAuth state handling are ~600–900 lines of
  security-sensitive code that Keycloak already ships and audits.
- **Ory Kratos.** Lighter than Keycloak, no JVM, but every self-service flow
  (register, login, verify, reset, settings) becomes SPA UI work. Keycloak's
  hosted pages keep the frontend nearly unchanged, which was a project constraint.
- **Bolting auth onto today's route files.** `routes/v1/ontology.ts` is already
  433 lines of inline SQL across 12 handlers; weaving ACL and quota checks through
  it duplicates the logic per handler.
- **SQLite with an app-level event bus.** Single-writer, no horizontal scaling,
  and change-publish would be homegrown.
- **Client-submitted Turtle for reasoning.** A modified client could submit
  Turtle that does not match the stored schema, making a published "consistent"
  badge untrustworthy.

## 3. Data model

Postgres, accessed through Kysely (typed SQL, no ORM). Versioned SQL migrations
live in `api/migrations/` and run as an explicit step (`npm run migrate`, invoked
by an init container in the cluster) — never implicitly on server boot.

```sql
-- Keycloak owns credentials. This is a mirror row, JIT-provisioned on the
-- first authenticated request and refreshed when claims change.
users (
  id            uuid primary key default gen_random_uuid(),
  subject       text unique not null,          -- Keycloak `sub`
  email         text,
  display_name  text,
  orcid         text,                          -- brokered ORCID claim, when present
  global_role   text not null default 'user'   check (global_role in ('user','moderator','admin')),
  quota_tier    text not null default 'free'   check (quota_tier in ('free','verified','staff')),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);

schemas (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references users(id) on delete cascade,
  title              text not null,
  description        text,
  upper_ontology_iri text,
  base_uri           text,                      -- normalised to end in '/' or '#' on write
  visibility         text not null default 'private'
                     check (visibility in ('private','unlisted','public')),
  content_hash       text,                      -- sha256 of generated OWL; null before first generate
  latest_report_key  text references reasoning_reports(cache_key) on delete set null,
  reason_state       text not null default 'stale'
                     check (reason_state in ('stale','queued','running','fresh','failed')),
  created_at         timestamptz not null default now(),
  modified_at        timestamptz not null default now()
);
create index on schemas (owner_id);
create index on schemas (visibility) where visibility = 'public';

classes (
  id                   uuid primary key default gen_random_uuid(),
  schema_id            uuid not null references schemas(id) on delete cascade,
  name                 text not null,
  label                text,
  description          text,
  maps_to_concept_iri  text,
  super_class_id       uuid references classes(id) on delete set null
);
create index on classes (schema_id);

properties (
  id                     uuid primary key default gen_random_uuid(),
  schema_id              uuid not null references schemas(id) on delete cascade,
  name                   text not null,
  label                  text,
  description            text,
  property_type          text not null default 'datatype'
                         check (property_type in ('object','datatype')),
  domain_class_id        uuid references classes(id) on delete set null,
  range_class_iri        text,
  mapping_pattern        jsonb,
  regex_pattern          text,
  regex_variable         text,
  is_required            boolean not null default false,
  property_features      jsonb,
  inverse_property_iri   text,
  disjoint_property_iris jsonb
);
create index on properties (schema_id);

schema_grants (
  schema_id  uuid references schemas(id) on delete cascade,
  grantee_id uuid references users(id)   on delete cascade,
  role       text not null check (role in ('viewer','editor','owner')),
  granted_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (schema_id, grantee_id)
);

-- Content-addressed report cache, shared across schemas and users.
reasoning_reports (
  cache_key   text primary key,   -- sha256(canonical_owl || sulo_hash || robot_version)
  report      jsonb not null,     -- ConsistencyReport
  reasoner    text not null,      -- 'HermiT'
  sulo_hash   text not null,
  duration_ms integer,
  created_at  timestamptz not null default now()
);

-- Durable queue: survives restarts, safe across replicas, one pending job per schema.
reason_jobs (
  id           bigserial primary key,
  schema_id    uuid not null references schemas(id) on delete cascade,
  requested_by uuid references users(id) on delete set null,
  cache_key    text not null,
  state        text not null check (state in ('queued','running','done','failed')),
  attempts     integer not null default 0,
  enqueued_at  timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  error        text
);
create unique index on reason_jobs (schema_id) where state in ('queued','running');

usage_events (
  id         bigserial primary key,
  user_id    uuid references users(id) on delete set null,
  kind       text not null,        -- 'reason_run' | 'upper_concepts_fetch'
  schema_id  uuid,
  cost_ms    integer,
  cache_hit  boolean not null default false,
  created_at timestamptz not null default now()
);
create index on usage_events (user_id, created_at desc);
```

Two properties of this model matter later:

- The report cache key includes the SULO hash and the ROBOT version. A SULO
  update invalidates cached reports instead of silently serving a verdict
  computed against a different upper ontology.
- `schemas.content_hash` and `reasoning_reports.cache_key` are distinct on
  purpose. `content_hash` is the hash of the generated OWL alone, so a mutation
  that produces byte-identical OWL (renaming a label back, re-saving an unchanged
  form) is detected as a no-op and skips the pipeline entirely. `cache_key` adds
  the SULO hash and ROBOT version, so identical OWL reasoned under a newer SULO
  is a cache miss.
- There is no `sessions` table. Keycloak holds sessions; the API is stateless per
  request.

Adding teams later means a nullable `group_id` on `schema_grants` with an XOR
check against `grantee_id`. The access resolver takes the extra branch; nothing
else changes.

## 4. Authentication

`api/src/plugins/auth.ts`:

- Verifies the bearer JWT with `jose` against a cached remote JWKS. Checks
  issuer, audience, and `exp`/`nbf` with a small clock skew allowance.
- Sets `request.user = { id, subject, role, tier }`, or `null` for anonymous.
- JIT-upserts the `users` row, memoised in an in-process LRU (60 s TTL) so it is
  not a database round-trip per request.
- Exposes `fastify.authRequired` and `fastify.requireRole('moderator'|'admin')`
  as preHandlers.
- Registered only when `SCHEMA_STORAGE=postgres`, leaving the frozen desktop path
  untouched.

Keycloak configuration:

- Realm `sulo`; public client `sulo-spa` using authorization code + PKCE.
- Identity providers: `github` (built-in social) and `orcid` (generic OIDC,
  issuer `https://orcid.org`, scope `openid`).
- Registration enabled, email verification required, brute-force detection on.
- The realm is exported to `docker/keycloak/realm-sulo.json` and imported on
  container start, so local dev and the cluster share identical configuration
  with no console clicking.

Frontend: `keycloak-js`, access token held in memory, refresh via rotation, an
axios interceptor that attaches the bearer and retries once on 401. Login,
registration and password reset stay on Keycloak's hosted pages — the reason this
approach was chosen over writing credential code.

Tests never require a running Keycloak: a `jose`-generated keypair signs tokens
and `AUTH_JWKS_JSON` / `AUTH_ISSUER` override the config. No dev-bypass header
exists in production code paths.

## 5. Authorization

One resolver, one enforcement point.

```ts
type Level = 'none' | 'view' | 'edit' | 'own';
resolveAccess(user: RequestUser | null, schema: SchemaRow, grant: GrantRow | null): Level
```

Highest match wins:

| Condition | Level |
| --- | --- |
| `user.global_role === 'admin'` | `own` |
| `schema.owner_id === user.id` | `own` |
| grant role `owner` / `editor` / `viewer` | `own` / `edit` / `view` |
| `user.global_role === 'moderator'` | `view` (plus the unpublish route) |
| `visibility in ('public','unlisted')` | `view`, including anonymous |
| otherwise | `none` |

- `none` on a private schema answers **404, not 403**, so schema IDs do not leak
  existence.
- A single preHandler loads the schema row LEFT JOINed to the requester's grant
  in one query, computes the level, and asserts the route's required minimum.
  Handlers contain no permission logic.
- Child routes (classes, properties, grants) resolve the parent schema:
  mutations require `edit`, grant management requires `own`.
- `GET /ontology-schemas?scope=mine|shared|public`. `unlisted` schemas are
  excluded from `public` listings but reachable by ID — a list-query concern, not
  an access-check concern.
- Report reads inherit the schema's view level: anonymous users can read cached
  reports on public schemas and can never trigger a run.
- Ownership transfer is an explicit route requiring `own`, not a PATCH field.
  `own` is a floor, not the whole rule: transfer additionally requires *actual*
  ownership — `schema.owner_id === user.id`, or the admin role — and this is
  load-bearing rather than defensive. A transfer leaves the previous owner an
  `owner` grant so that handing a schema over is not a lockout, and an `owner`
  grant resolves to `own`; if transfer were merely `own`-level, that previous
  owner could transfer the schema straight back, and "not a lockout" and "the
  old owner cannot transfer again" would be jointly unsatisfiable. The
  comparison lives in the acl module (`mayTransferOwnership`) next to
  `mayChangeVisibility`, not in the route.
- `GET /ontology-schemas/:id/upper-concepts` and the standalone
  `GET /upper-concepts?iri=…` proxy both require authentication and count against
  the caller's `upperFetchPerHour` quota. The per-schema form additionally
  requires `view`. Anonymous callers get 401: making the server dereference an
  arbitrary remote IRI is a privilege, even behind `safeFetch`.
- Moderators get `POST /admin/schemas/:id/unpublish` (forces `visibility` to
  `private`) for abuse handling.

## 6. Quotas and fair scheduling

Tiers live in code (`modules/quota/tiers.ts`), overridable by environment. They
change with deploys, not at runtime.

```ts
free:     { runsPerHour: 20,   maxConcurrent: 1, maxInputBytes: 1_000_000, timeoutMs: 60_000,  maxSchemas: 20,  upperFetchPerHour: 30 }
verified: { runsPerHour: 100,  maxConcurrent: 2, maxInputBytes: 3_000_000, timeoutMs: 120_000, maxSchemas: 200, upperFetchPerHour: 120 }
staff:    { runsPerHour: 1000, maxConcurrent: 4, maxInputBytes: 5_000_000, timeoutMs: 300_000, maxSchemas: 2000, upperFetchPerHour: 600 }
```

- **Cache hits do not consume quota** (`cache_hit = true`, `cost_ms = 0`). With
  reasoning triggered on save, most triggers re-hash unchanged content or content
  someone else already reasoned; charging for those would exhaust a tier in
  minutes of ordinary editing.
- `checkAndReserve(user, kind)` is one index-backed window count over
  `usage_events`. On denial an automatic run leaves `reason_state = 'stale'` and
  the response carries `quotaExceeded` plus `retryAfter`, so the UI can show
  "checks paused until 14:20" instead of an error per save.
- `maxInputBytes` now caps the **server-generated** OWL, not a client upload
  (client-supplied Turtle is gone — section 7). A schema whose generated OWL
  exceeds the tier limit is not enqueued: `reason_state` becomes `failed` with
  error `owl_too_large`, and the report endpoint reports that state so the UI can
  say why rather than showing a permanent "queued".
- `maxSchemas` is enforced at schema creation (`POST /ontology-schemas`), which
  returns 409 `quota_exceeded` when the owner is at the limit. Schemas shared with
  a user through a grant do not count against the grantee's limit, only the
  owner's.
- Global ceilings remain: `REASONER_MAX_CONCURRENT` JVM slots (default 2 on the
  server), one in-flight run per schema (enforced by the partial unique index),
  and a per-tier wall-clock timeout.
- Anonymous traffic is not quota-tracked (there is no user row to charge), so the
  existing per-IP `@fastify/rate-limit` stays registered and covers the routes
  anonymous users can reach: public schema reads, public report reads, and SSE
  subscriptions. Anonymous requests can never reach the reasoner or the
  upper-ontology proxy, so per-IP limits protect bandwidth, not CPU.
- **Fair scheduling replaces the in-process FIFO.** `reason_jobs` is the queue.
  N worker loops claim work with `FOR UPDATE SKIP LOCKED`, ordering by
  (requester's in-flight count ascending, `enqueued_at` ascending) and skipping
  users already at their tier's `maxConcurrent`. One user with 30 dirty schemas
  cannot starve everyone else, and the scheme is safe across replicas. The old
  `maxQueue` overflow rejection disappears — depth is bounded per user by quota.
  On-demand refreshes still return 429 when the requester is over tier limits.

## 7. Automatic reasoning pipeline

1. Every mutation, in the same transaction: bump `modified_at`, set
   `reason_state = 'stale'`, `pg_notify('schema:<id>', …)`.
2. A debouncer (`modules/reasoning/debounce.ts`) keeps an in-memory
   `schemaId → timer` map: 5 s idle (`REASON_DEBOUNCE_MS`) with a 30 s maximum
   wait, so a continuously edited schema still gets checked. On fire it generates
   OWL from the database rows via `@sulo/schema-core` and computes
   `cache_key = sha256(turtle ‖ sulo_hash ‖ robot_version)`. Generator output is
   deterministic because the repository orders classes and properties by name.
3. If `cache_key` exists in `reasoning_reports`: set `latest_report_key`,
   `reason_state = 'fresh'`, log a cache-hit usage event, notify. No JVM runs.
4. Otherwise `INSERT INTO reason_jobs … ON CONFLICT DO NOTHING`, set
   `reason_state = 'queued'`. A worker claims it, marks `running`, runs
   ROBOT/HermiT, stores the report, and sets `fresh` — or `failed` with the
   error — then notifies.
5. A recovery sweep every 60 s requeues schemas left `stale` for more than two
   minutes (a debounce timer lost to a restart, or one held by another replica)
   and jobs `running` past `timeout × 2` (crashed worker). `attempts` reaching 3
   marks the job `failed`.

API surface:

- `GET /ontology-schemas/:id/report` → `{ state, report?, cacheKey, computedAt, stale }`,
  at view level; anonymous on public schemas.
- `POST /ontology-schemas/:id/report/refresh` → explicit run at edit level,
  quota-checked, placed at the front of that user's own bucket.

`POST /reason` with client-supplied Turtle is **not registered** in postgres
mode. The server reasons only over schemas it stores, which removes the surface
where an anonymous visitor makes the host spawn a JVM over a megabyte of
arbitrary Turtle. The route survives in the frozen desktop path, where the
reasoner is the local user's own machine.

## 8. Change publication

- Channels: `pg_notify('schema:<id>', payload)` where the payload is a hint only
  — `{ kind: 'mutated' | 'report', at }`. Clients refetch through the normal
  ACL-checked endpoints, so no data reaches a channel whose subscribers were not
  authorised for it, and payloads stay far under the 8 kB NOTIFY limit.
- One dedicated `pg` connection per API process holds the `LISTEN`; an
  in-process emitter fans out to subscribers.
- Transport: `GET /ontology-schemas/:id/events` as SSE, gated by the same view
  level resolver. The frontend consumes it with `fetch` + `ReadableStream`, not
  `EventSource`: `EventSource` cannot set an `Authorization` header, and putting
  a token in the query string writes credentials into access logs.
- Frontend cost is one hook calling `queryClient.invalidateQueries`.
- Real-time collaboration later replaces the hint payload with CRDT operations
  without changing transport, authentication or authorization.

## 9. Code layout

```
packages/schema-core/          # extracted from frontend/src/lib: ontologyExport, schemaTransfer, shared types
api/src/
  config/{server,db,auth,reasoner,quota}.ts    # replaces the single 122-line frozen object
  db/{pool,migrate,types}.ts                   # Kysely instance and generated types
  plugins/{pg,auth,acl,rateLimit,cors,helmet,sensible,staticFiles}.ts
  modules/
    users/     {routes,service,repo}.ts
    schemas/   {routes,service,repo,mappers}.ts # replaces the 433-line ontology.ts
    acl/       {resolve,guards,routes}.ts
    reasoning/ {routes,service,repo,debounce,worker,cache}.ts
    quota/     {service,tiers}.ts
    events/    {listener,sse}.ts
    admin/     routes.ts                        # user roles/tiers, usage, jobs, unpublish
  legacy/sqlite/                                # today's code, registered only when SCHEMA_STORAGE=sqlite
```

- npm workspaces at the repository root; the frontend imports
  `@sulo/schema-core` instead of `./lib/ontologyExport`.
- `SCHEMA_STORAGE` becomes `postgres | sqlite`. The `browser` value is deleted,
  along with `frontend/src/api/localStore.ts`, its tests, and the `app-config`
  storage fork. `frontend/src/api/backend.ts` collapses to REST-only.
- The following stay as-is and are deliberately preserved: `rdf/safeFetch.ts`
  (SSRF guard), the upper-ontology proxy and its cache, `services/robot.service.ts`,
  `services/sulo.service.ts`, the ROBOT output parsers, and
  `lib/schemaTransfer.ts` (JSON import/export).

Out of scope but flagged: `frontend/src/pages/OntologyBuilderPage.tsx` is 4065
lines. The auth, ACL and SSE additions it needs are small hooks, but it should be
split before the next feature lands in it.

## 10. Delivery order

Each stage leaves the application runnable; no long-lived broken trunk.

0. Remove browser/IndexedDB storage.
1. npm workspaces plus the `@sulo/schema-core` extraction.
2. Postgres, migrations, Kysely, and the `schemas` module at feature parity —
   still no auth.
3. Keycloak container, realm export, auth plugin, frontend login.
4. ACL: ownership, visibility, grants, the resolver and its guards.
5. Quotas, the durable `reason_jobs` queue, and the fair scheduler.
6. Automatic reasoning with the content-hash cache and report endpoints.
7. SSE change publication.
8. Admin routes.

## 11. Test strategy

- Testcontainers Postgres for repository and ACL tests — real SQL, real
  constraints, real partial indexes.
- The access resolver as a pure table test: user × schema × grant × visibility →
  expected level, including the anonymous and moderator rows.
- Auth tests with `jose`-signed tokens against an injected JWKS.
- The reasoning worker against a fake runner (no JVM); the existing ROBOT
  output-parsing tests keep the real path covered.
- Quota tests driving `usage_events` directly to assert window boundaries and
  that cache hits are free.
- Playwright end-to-end for login plus private/unlisted/public visibility,
  against a Keycloak container in CI.
- No data migration: nothing exists in production Postgres, and users on browser
  storage move their work into an account through the existing `schemaTransfer`
  JSON export/import.
