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

Schemas live in an embedded SQLite database behind the REST API. Desktop
builds and local dev always use this mode. Schemas move between
machines/users via the in-app **Share** button — a compressed link (URL
fragment, never sent to the server) or a `.json` export file, which doubles
as a backup.

## Quick start (Docker, web deployment)

```bash
git clone https://github.com/MaastrichtU-IDS/sulo-schema-builder.git
cd sulo-schema-builder
docker compose up --build
```

App: **http://localhost:8080**.

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_NAMESPACE` | `https://w3id.org/sulo/schema/` | RDF base namespace for schema IRIs |
| `HOST` | `127.0.0.1` | Interface the API binds to. Loopback by default. **Set `HOST=0.0.0.0` for any deployment that must be reachable from another machine**; the Docker image and compose file already do. |
| `REASONER_MAX_CONCURRENT` | `1` | Simultaneous HermiT runs (each spawns a JVM) |
| `REASONER_MAX_INPUT_BYTES` | `5000000` | Max size of the submitted Turtle |

## Local development

```bash
cd api      && npm install && npm run dev    # API on :3000
cd frontend && npm install && npm run dev    # Vite on :5173, proxies /api
```

| Component | Stack |
|-----------|-------|
| Frontend | React 18, Vite, Tailwind CSS, React Flow |
| API | Fastify 5, TypeScript, N3.js, better-sqlite3 |

Tests: `npm test` in `frontend/` and in `api/` (vitest).

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
