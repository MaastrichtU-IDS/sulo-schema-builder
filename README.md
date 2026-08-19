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
