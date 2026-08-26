# SULO-Compliant Schema Builder

A web application that bridges domain **schema design** and formal **OWL ontology engineering**. Define classes and properties, align them interactively to the [Simplified Upper-Level Ontology (SULO)](https://w3id.org/sulo/), and generate four artefacts from a single model — **RDF/Turtle**, **OWL DL** (with SULO equivalence axioms and property restrictions), **SHACL** shapes, and a **Mermaid UML** diagram — without writing OWL by hand.

![Schema builder](docs/images/builder.png)

## Features

- **Interactive alignment** — map each class to a SULO category and each property to a SULO path, with autocomplete over the upper ontology.
- **Mapping patterns** — express a relation as a SPARQL-style triple template using the placeholders `?this` (domain) and `?value` (range); the compiler unfolds it into nested OWL restrictions.
- **Property characteristics** — declare `Functional`, `Transitive`, `Symmetric`, `Asymmetric`, `Reflexive`, `Irreflexive`, `Inverse Functional`, an `owl:inverseOf`, and `owl:propertyDisjointWith` relations per property.
- **Four exports** from one schema — RDF/Turtle, OWL + SULO, SHACL, and Mermaid UML.
- **OWL DL error detection** — the SULO alignment lets a reasoner surface modelling errors (e.g. disjointness clashes) invisible to schema validators and SHACL.

## Storage

`SCHEMA_STORAGE` picks where schemas live. There are exactly two modes:

| Mode | Used by | Store |
|---|---|---|
| `postgres` | web deployments (Docker default, multi-user) | Postgres, via `DATABASE_URL` |
| `sqlite` | packaged desktop app and local dev (the default) | embedded SQLite file at `DB_PATH` |

Both modes serve the identical REST API, so the frontend cannot tell them
apart. Packaged desktop builds are always `sqlite`, whatever the environment
says. The SQLite path is frozen — bug fixes only; new features land in the
Postgres modules (`api/src/modules/`).

In `postgres` mode the schema is created by explicit, versioned SQL migrations
in `api/migrations/`, never by the server at startup: run
`npm run migrate -w sulo-schema-builder-api` before the API (the compose stack
does this in a one-shot `migrate` service). There is no automatic data
migration between the two modes.

Schemas also move between machines/users via the in-app **Share** button — a
compressed link (URL fragment, never sent to the server) or a `.json` export
file, which doubles as a backup.

## Quick start (Docker, web deployment)

```bash
git clone https://github.com/MaastrichtU-IDS/sulo-schema-builder.git
cd sulo-schema-builder
docker compose -f docker-compose.yml up --build
```

App: **http://localhost:8080**. The stack is three services: `db` (Postgres
16), a one-shot `migrate` that applies `api/migrations/` and exits, and `api`,
which starts once the migration has succeeded.

The `-f docker-compose.yml` is not optional. Plain `docker compose up` also
loads `docker-compose.override.yml`, which is the **development** topology, not
this one: it builds the Dockerfile's `development` stage, mounts `./api/src`
and runs it under `tsx watch`, sets `NODE_ENV=development` (which relaxes CORS
to `origin: true`) and publishes an extra un-proxied port 3000. Use the bare
command while working on the code; use `-f docker-compose.yml` for anything you
would call a deployment.

No `.env` is needed — every variable has a default. Create one to override any
of the table below (`POSTGRES_PASSWORD` in particular); the `api` service picks
it up if it exists and ignores it if it does not.

| Variable | Default | Description |
|----------|---------|-------------|
| `SCHEMA_STORAGE` | `sqlite` | `postgres` or `sqlite` — see [Storage](#storage). The Docker image sets `postgres`. |
| `DATABASE_URL` | `postgres://sulo:sulo@localhost:5432/sulo` | Postgres connection string. Required in `postgres` mode, unused in `sqlite` mode. |
| `DATABASE_POOL_MAX` | `10` | Maximum Postgres connections per API process |
| `DB_PATH` | `api/data/sulo.db` | SQLite file, `sqlite` mode only |
| `BASE_NAMESPACE` | `https://w3id.org/sulo/schema/` | RDF base namespace for schema IRIs |
| `HOST` | `127.0.0.1` | Interface the API binds to. Loopback by default. **Set `HOST=0.0.0.0` for any deployment that must be reachable from another machine**; the Docker image and compose file already do. |
| `RATE_LIMIT_ENABLED` | `true` | Per-IP rate limiting. Always off in packaged desktop builds (loopback, one user). |
| `REASONER_MAX_CONCURRENT` | `1` | Simultaneous HermiT runs (each spawns a JVM) |
| `REASONER_MAX_INPUT_BYTES` | `1000000` in `postgres` mode, `5000000` in `sqlite` mode | Max size of the submitted Turtle. Shared web deployments cap lower than a single-user desktop. |
| `POSTGRES_PASSWORD` | `sulo` | Password for the compose `db` service. **Change it for anything reachable off localhost.** |

A `.env.example` in the repo root lists every variable above plus the
authentication ones documented below — copy it to `.env` and edit as needed.
Every one of these variables is passed through `docker-compose.yml`'s
`environment:` blocks as `${VAR:-default}`, so a value you set in `.env` (or
the shell) always wins over the file's own localhost-dev default — it does
not silently override what you put in `.env`.

**Deploying somewhere that isn't localhost:** editing `.env` is not enough by
itself. `docker/keycloak/realm-sulo.json`'s `redirectUris`, `webOrigins` and
`post.logout.redirect.uris` are hardcoded to `http://localhost:8080/*` and
`http://localhost:5173/*` — Keycloak rejects a login redirect to any origin
not in that list, regardless of what `AUTH_ISSUER`/`KC_HOSTNAME` say. Add your
real origin(s) to all three before importing the realm against a non-localhost
deployment.

## Authentication

Identity is delegated to [Keycloak](https://www.keycloak.org/), run as a
`keycloak` service in `docker-compose.yml`. `api/src/plugins/auth.ts` verifies
every bearer token against it — issuer, audience and signature — on all 12
schema routes in `postgres` mode; the `sqlite` (packaged desktop) mode never
loads this plugin and has no authentication at all (see [Storage](#storage)).
This section documents the identity provider and the config module the
plugin consumes.

The realm is imported from `docker/keycloak/realm-sulo.json` — configuration
as code rather than console clicking — and defines:

- **`sulo-spa`**: a public client (PKCE, `S256`) for the frontend. No client
  secret, because it can't keep one.
- **`sulo-api`**: a confidential, bearer-only client `api/src/plugins/auth.ts`
  verifies tokens against. It never initiates a login itself.
- **The `sulo-api-audience` protocol mapper**, attached to `sulo-spa`. This is
  load-bearing and easy to silently break: Keycloak access tokens carry
  `aud: ["account"]` by default, and without this mapper every real token
  Keycloak issues is invalid for `sulo-api` even though `jose`-signed tokens
  in offline tests sail through unaffected. If token verification ever starts
  failing only against a live Keycloak and never in tests, check this mapper
  first.
- **`github` and `orcid` identity providers, both `enabled: false`** with
  empty client secrets — OAuth secrets do not belong in git. Enable them with
  `docker/keycloak/configure-idps.sh`, which reads four environment variables
  and fills them in via `kcadm`:

  ```bash
  # requires KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD (set below), plus
  # GITHUB_CLIENT_ID/SECRET and/or ORCID_CLIENT_ID/SECRET in the environment —
  # a provider whose pair is unset is skipped, not disabled outright
  docker compose exec keycloak sh /opt/keycloak/bin/configure-idps.sh
  ```
- **`verifyEmail: false`.** The realm has no `smtpServer` configured and this
  stack ships no SMTP service, so a self-registered account would otherwise
  get stuck forever behind Keycloak's `VERIFY_EMAIL` required action with no
  way to complete it. **Before any real deployment, configure an `smtpServer`
  block in `realm-sulo.json` (or via the admin console) and turn
  `verifyEmail` back on together with it** — shipping registration without
  email verification on a public deployment lets anyone sign up with an
  email address they do not own.

**Creating the first account for local use, since there is no SMTP:** either
sign up through the SPA's own registration form (works out of the box —
`verifyEmail: false` means there is nothing to confirm), create a user by
hand in the Keycloak admin console (http://localhost:8088, the bootstrap
admin credentials below), or run `docker/keycloak/seed-test-user.sh` (local/CI
only, sets `emailVerified=true` explicitly and is also what the e2e suite
uses).

**The stack runs Keycloak with `start-dev` and a bootstrap admin
username/password — this is a development configuration, not a production
one.** `start-dev` serves plain HTTP and skips Keycloak's hostname/TLS
strictness checks; before any real deployment, switch to `start` with a
reverse-proxied HTTPS hostname and rotate `KEYCLOAK_ADMIN_PASSWORD` out of its
default.

Keycloak needs its own database, separate from the app's `sulo` tables. It's
created by `docker/postgres/init-keycloak.sql`, mounted into the `db`
service's `/docker-entrypoint-initdb.d/`. **Postgres only runs those scripts
the first time it initializes a data directory** — if you already had this
stack's `sulo-db` volume from before this file existed, the `keycloak`
database won't appear on its own. Either `docker compose down -v` (destroys
all data in the volume) to reinitialize, or create it by hand:

```bash
docker compose exec db psql -U sulo -d sulo -c "CREATE DATABASE keycloak OWNER sulo;"
```

Keycloak signs tokens with whatever issuer hostname the caller (the SPA,
running in the browser) actually used to reach it — not the Docker-internal
`keycloak:8080` hostname the `api` container sees on the compose network. So
`KC_HOSTNAME` on the `keycloak` service and `AUTH_ISSUER` on the `api` service
are both set to the browser-facing `http://localhost:8088` (the published
port), and a comment in `docker-compose.yml` records why that looks
"wrong" for an in-container reference. Getting this wrong surfaces as
"unexpected iss" on every request.

The address the API *fetches its signing keys from* is a separate setting,
`AUTH_JWKS_URI`, and it is not the same address as `AUTH_ISSUER` — this is the
other half of the same asymmetry. Verifying a token is a server-to-server
call from inside the network, where the browser-facing URL is wrong or
unroutable (again, `localhost:8088` inside the `api` container is that
container's own loopback). Deriving one from the other broke this stack
outright: the fetch failed and every token was rejected with a 401. So
`docker-compose.yml` sets `AUTH_JWKS_URI` to the in-network
`http://keycloak:8080/realms/sulo/protocol/openid-connect/certs`, while
`AUTH_ISSUER` stays the published `http://localhost:8088/...`. A Kubernetes
deployment needs the identical split: a public ingress hostname for
`AUTH_ISSUER`, and the in-cluster service DNS name (e.g.
`http://keycloak.sulo.svc:8080/...`) for `AUTH_JWKS_URI`. Single-host setups
can leave `AUTH_JWKS_URI` unset — it then defaults to the same derivation as
before, `${AUTH_ISSUER}/protocol/openid-connect/certs`.

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_ISSUER` | *(required in `postgres` mode)* | The realm's issuer URL as reached by the browser, e.g. `http://localhost:8088/realms/sulo`. Checked against every token's `iss` claim. |
| `AUTH_JWKS_URI` | derived from `AUTH_ISSUER` | Where *this server* fetches the signing keys, e.g. `http://keycloak:8080/realms/sulo/protocol/openid-connect/certs`. Set this explicitly whenever the server can't reach Keycloak at the browser-facing `AUTH_ISSUER` address — true of the compose stack, and of any Kubernetes deployment (in-cluster service DNS vs. a public ingress hostname). |
| `AUTH_AUDIENCE` | *(required in `postgres` mode)* | Expected token audience — `sulo-api`. |
| `AUTH_CLIENT_ID` | `sulo-spa` | Public client ID served to the SPA. |
| `AUTH_USER_CACHE_TTL_MS` | `60000` | How long a verified user's identity is cached before re-checking — also how long a role change or a Keycloak-side account disable takes to become effective. |
| `AUTH_REQUIRE_JWKS_AT_BOOT` | `true` | Whether the API refuses to start if it cannot fetch Keycloak's signing keys at boot. `true` preserves the loud, fail-fast default: an unreachable identity provider fails the boot instead of silently 401ing every request. Set to `false` on a deployment with its own readiness probe (e.g. Kubernetes, which has no equivalent of this compose file's keycloak healthcheck + `depends_on`) — otherwise a Keycloak blip during a rollout puts every replica into a restart loop that outlasts Keycloak's own recovery. When `false`, a failed pre-fetch is logged at `error` and the server starts anyway; the per-request JWKS resolution path still heals itself once Keycloak answers. |
| `AUTH_ADMIN_GROUP` | *(unset)* | A Keycloak group's bare name (e.g. `admins` — no leading slash; the realm's group-membership mapper has `full.path` set to `false`, so a top-level group's claim is just its name) whose members are treated as admin. Additive on top of the `global_role` column, never a demotion: a caller is admin if *either* Postgres says so *or* their token's `groups` claim contains this value — so a deployment that has always managed admins by hand through `PATCH /admin/users/:id` is completely unaffected by leaving this unset. This realm already ships an `admins` group and the group-membership protocol mapper it needs (`docker/keycloak/realm-sulo.json`); set this to `admins` and add a user to that group to try it. Takes effect within `AUTH_USER_CACHE_TTL_MS`, same as any other role change. |
| `KEYCLOAK_ADMIN` | `admin` | Bootstrap admin username. Development only — see above. |
| `KEYCLOAK_ADMIN_PASSWORD` | `admin` | Bootstrap admin password. **Change it for anything reachable off localhost**, and treat it as development-only regardless. |

`AUTH_ISSUER` and `AUTH_AUDIENCE` are only enforced in `postgres` mode; in
`sqlite` mode (the frozen single-user desktop path) authentication is
disabled entirely and neither variable (nor `AUTH_JWKS_URI`) is consulted.

### End-to-end auth test

Every other test in this repo signs its tokens with `jose` in-process — real
enough to check claim handling, but incapable of exercising the audience
mapper, issuer matching, PKCE or the redirect URIs, all of which only exist
because a real Keycloak enforces them.
`frontend/e2e/auth-flow.spec.ts` is the one test that does: it drives a real
browser through Keycloak's own hosted login page against the compose stack.
It is *not* part of `npm test` — it needs Docker and takes tens of seconds,
so it runs as the separate `e2e-auth` CI job (below) and is meant to be run
by hand locally when touching anything in the auth path.

Run it locally:

```bash
# Start from a clean realm import — a stale realm from earlier experiments
# can survive `docker compose down` because it lives in Keycloak's own
# Postgres-backed volume, which `--import-realm` does not refresh.
docker compose -f docker-compose.yml down -v
docker compose -f docker-compose.yml up -d --build

# Seed the deterministic test account (idempotent, local/CI only — see the
# script's own header). docker compose exec does not forward host
# environment variables into the container, hence the explicit -e flags.
docker compose exec \
  -e KEYCLOAK_ADMIN_PASSWORD=admin -e KEYCLOAK_ADMIN=admin \
  keycloak sh /opt/keycloak/bin/seed-test-user.sh

# Install Playwright's browser once per machine. --prefix (not a plain
# `cd frontend`) so the working directory — and therefore the paths below —
# stays the repo root.
npx --prefix frontend playwright install chromium

npx --prefix frontend playwright test -c frontend/playwright.config.ts frontend/e2e/auth-flow.spec.ts

docker compose -f docker-compose.yml down
```

The seeded account is `e2e@example.org` / `E2ePassw0rd!` (override with
`E2E_USER_EMAIL` / `E2E_USER_PASSWORD`, passed to both the seed script and
the spec). If ports 8080/8088/5173 are already taken by something else on
your machine, point the spec at whatever port you published the `api`
service on instead, e.g. `E2E_BASE_URL=http://localhost:5173 npx --prefix frontend playwright test ...`
— `realm-sulo.json` already permits both `:8080` and `:5173` as redirect
URIs / web origins, so no realm change is needed either way.

**What to check when login breaks against a real Keycloak** (all invisible
to the `jose`-signed unit tests):

- **Issuer mismatch ("unexpected iss")** — `AUTH_ISSUER` on `api` and
  `KC_HOSTNAME` on `keycloak` must be the exact same browser-facing URL.
  Keycloak stamps every token's `iss` with whatever hostname the browser
  used to reach it, not the in-container one.
- **Missing audience mapper** — a real access token carries `aud:
  ["account"]` by default. Without the `sulo-api-audience` protocol mapper
  on the `sulo-spa` client (in `realm-sulo.json`), every genuine token fails
  the audience check while offline tests, which mint their own claims,
  sail through unaffected.
- **Redirect URI rejected** — Keycloak's login page refuses to redirect back
  anywhere not listed in the client's `redirectUris`/`webOrigins`. Whatever
  origin the browser loads the SPA from must be in that list.
- **`check-sso` silently fails** — `AuthProvider` uses `onLoad: 'check-sso'`
  with a hidden iframe at `/silent-check-sso.html`. Third-party-cookie
  blocking (common in headless/incognito contexts) or a missing/broken
  silent-check page makes `check-sso` fail closed to `'disabled'` rather
  than error loudly — check the browser console and confirm
  `frontend/public/silent-check-sso.html` made it into the build.
- **`VERIFY_PROFILE` required action blocking a seeded user** — the realm
  requires email verification and email-as-username. A user created without
  `emailVerified`, `firstName` and `lastName` gets stuck behind Keycloak's
  own profile-completion step instead of ever reaching the app; this is
  exactly what `seed-test-user.sh` sets explicitly.

## Local development

```bash
npm install                                       # one install for the whole workspace
npm run dev -w sulo-schema-builder-api            # API on :3000 (sqlite by default)
npm run dev -w sulo-schema-builder-frontend       # Vite on :5173, proxies /api
```

To develop against Postgres instead, start one (`docker compose up -d db`),
then:

```bash
export SCHEMA_STORAGE=postgres
export DATABASE_URL=postgres://sulo:sulo@localhost:5432/sulo
npm run migrate -w sulo-schema-builder-api        # applies api/migrations/
npm run dev -w sulo-schema-builder-api
```

(Exporting `SCHEMA_STORAGE` is safe to leave in your shell: a packaged desktop
build ignores it and logs a warning rather than refusing to start.)

| Component | Stack |
|-----------|-------|
| Frontend | React 18, Vite, Tailwind CSS, React Flow |
| API | Fastify 5, TypeScript, N3.js, Postgres + Kysely (web), better-sqlite3 (desktop) |

Tests: `npm test` at the repository root runs every workspace (vitest). The
Postgres-backed API suites start a real `postgres:16-alpine` container through
Testcontainers, so Docker must be running.

## Desktop builds

Bundles for macOS (Apple Silicon), Linux x64 and Windows x64 are attached to
each [release](https://github.com/MaastrichtU-IDS/sulo-schema-builder/releases),
built by `.github/workflows/release.yml`. To build locally instead, run
`just package-mac`, `just package-linux` or `just package-win` on a machine of
that OS — the desktop bundle isn't cross-compiled.

**The bundles are unsigned**, so both platforms will warn on first launch:

| Platform | First run |
|---|---|
| macOS | Right-click the app → **Open** (double-clicking shows only "unidentified developer"). Or `xattr -d com.apple.quarantine "/Applications/SULO Schema Builder.app"`. |
| Windows | SmartScreen → **More info** → **Run anyway**. |

Publishing a release is tag-driven: push a `v*` tag whose version matches
`desktop/src-tauri/tauri.conf.json` and a draft release is created with the
bundles attached. Running the workflow manually builds the same bundles as
downloadable workflow artifacts without touching releases.

The app serves itself on loopback only, so it never asks the OS for permission
to accept incoming connections and is not reachable from the rest of your
network. If something goes wrong at startup — the reasoner toolchain is fetched
on first launch — the backend's output is written to `sulo-schema-builder.log`
in the app's data folder (`~/.sulo-schema-builder/`, `%APPDATA%\sulo-schema-builder\`
on Windows). It is rewritten each launch, so reproduce the problem and then
attach it. On Windows the app runs without a console window, which is why the
log file is the only place that output goes.

## Consistency check requirements

The **Check consistency** action runs full OWL DL reasoning (HermiT via
[ROBOT](http://robot.obolibrary.org/)), which needs a Java runtime and the ROBOT
jar. Everything else in the app works without either.

- **Java 11 or newer** — [download Temurin](https://adoptium.net/temurin/releases/?version=21).
  The desktop app looks for it in `JAVA_PATH`, `JAVA_HOME`, macOS's
  `/usr/libexec/java_home`, and then on `PATH`. Apps launched from the Finder or
  Start Menu don't inherit your shell's `PATH`, so a Java installed via Homebrew,
  SDKMAN or asdf may not be found automatically — the consistency panel has a
  field where you can point at it directly, and the path is remembered.
- **ROBOT** downloads itself on first launch (~91 MB) into the app's data folder
  and is verified against a pinned checksum. It isn't bundled, because it would
  otherwise dominate the size of every download. If the machine is offline, drop
  `robot.jar` into that folder yourself and press **Retry download**:

  | Platform | Data folder |
  |---|---|
  | macOS / Linux | `~/.sulo-schema-builder/` |
  | Windows | `%APPDATA%\sulo-schema-builder\` |

- **SULO** ships with the app as an offline fallback, and is refreshed from
  <https://w3id.org/sulo/> in the background when a newer version is published.
  The version actually used is shown under each consistency result — worth
  recording alongside any result you cite, since generated OWL declares
  `owl:imports <https://w3id.org/sulo/>` and tracks whatever is current.

The Docker image bakes in both a JRE and ROBOT, so none of the above applies
there.

## Usage

1. **Create a schema** — give it a title and an upper-ontology IRI (e.g. `https://w3id.org/sulo/`).
2. **Add classes** — set a name (the local IRI fragment, e.g. `:ClinicalVisit`), a *Maps to concept* IRI (e.g. `https://w3id.org/sulo/Process`), and an optional parent class.
3. **Add properties** — set type (object/datatype), domain, range, a *mapping pattern*, and any *property characteristics*. For example, `hasPatient` on `ClinicalVisit` unfolds to the three-hop role-bearer pattern:

   ```
   ?this  sulo:hasParticipant  ?role
   ?role  rdf:type             :SubjectOfCareRole
   ?role  sulo:isFeatureOf     ?value
   ```

4. **Generate** — open the export modal and switch between the four tabs; copy or download each artefact.

Click **Load Example** for a pre-built *Clinical Health Record Schema* (28 classes, 83 properties, 3 subclass relationships, 16 `hasCode` properties), or **Load OMOP Example** for the same domain in the OMOP CDM style.

## Exports

![OWL + SULO export](docs/images/owl-export.png)

| Tab | File | Description |
|-----|------|-------------|
| RDF Schema | `<name>.ttl` | Plain RDF/Turtle — `rdfs:Class`, `rdfs:label/comment/subClassOf`, `rdfs:domain/range` |
| OWL + SULO | `<name>_sulo.owl.ttl` | OWL DL — `owl:equivalentClass` restrictions from mapping patterns; `owl:unionOf` for union ranges; property characteristics |
| SHACL | `<name>_shacl.ttl` | One `sh:NodeShape` per class with schema-native `sh:path`; `sh:or` union ranges; `sh:minCount 1` for required |
| UML Diagram | `<name>_uml.mmd` | Mermaid `classDiagram` for [mermaid.live](https://mermaid.live) or Markdown |

## Backup & restore

```bash
# dump (stack running)
curl "http://localhost:8080/sparql?query=CONSTRUCT%20%7B%3Fs%20%3Fp%20%3Fo%7D%20WHERE%20%7B%3Fs%20%3Fp%20%3Fo%7D" \
  -H "Accept: text/turtle" > sparql/backup/$(date +%FT%H-%M-%S).ttl

# restore (mounted at /backups in qlever-init)
RESTORE_FROM=/backups/<file>.ttl docker compose up --build
```

## Citation

Celebi R, Martínez-Costa C, Schulz S, Dumontier M. *SULO-Compliant Schema Builder: a web-based tool bridging domain schemas with ontologies using SULO.*
