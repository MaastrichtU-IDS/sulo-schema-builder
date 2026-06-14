# SULO-Compliant Schema Builder

A web application that bridges domain **schema design** and formal **OWL ontology engineering**. Domain experts define classes and properties, align them interactively to the [Simplified Upper-Level Ontology (SULO)](https://w3id.org/sulo/), and generate four artefacts from a single schema model — **plain RDF/Turtle**, **OWL DL** with SULO-compliant equivalence axioms and property restrictions, **SHACL** node shapes, and a **Mermaid UML** diagram.

A declarative **mapping-pattern** mechanism, analogous to SPARQL triple templates, compiles domain relations into SULO relations without requiring the user to author OWL by hand. Schemas are stored as RDF in a [QLever](https://github.com/ad-freiburg/qlever) SPARQL triplestore.

> Celebi R, Martínez-Costa C, Schulz S, Dumontier M. *SULO-Compliant Schema Builder: a web-based tool bridging domain schemas with ontologies using SULO.* See [`paper.docx`](paper.docx) for the full manuscript.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Browser  →  React SPA (Vite / Tailwind)    │
└───────────────────┬─────────────────────────┘
                    │ /api/v1
┌───────────────────▼─────────────────────────┐
│  REST API  (Node.js / Fastify / TypeScript)  │
└───────────────────┬─────────────────────────┘
                    │ SPARQL UPDATE / SELECT
┌───────────────────▼─────────────────────────┐
│  QLever SPARQL triplestore                   │
└─────────────────────────────────────────────┘
```

| Component | Technology |
|-----------|-----------|
| Frontend  | React 18, Vite, Tailwind CSS, React Flow, Monaco Editor |
| API       | Fastify 5, TypeScript, N3.js |
| Triplestore | QLever (adfreiburg/qlever) |
| Reverse proxy (production) | Nginx |

---

## Prerequisites

- **Docker Desktop** ≥ 4.x (for the full stack via Docker Compose)
- **Node.js** ≥ 20 and **npm** ≥ 10 (for local development only)

---

## Quick start — Docker Compose

The easiest way to run the full stack.

```bash
git clone <repo-url> sulo-schema-builder
cd sulo-schema-builder

# Copy and edit environment variables (optional for development)
cp .env.example .env

docker compose up --build
```

The app is available at **http://localhost:8080**.

On first run QLever builds its index from the seed Turtle files in `sparql/`. This takes a few seconds. Subsequent starts reuse the persisted index.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `QLEVER_ACCESS_TOKEN` | `sulo-dev-token` | Token required by QLever for SPARQL UPDATE |
| `BASE_NAMESPACE` | `https://w3id.org/sulo/schema/` | RDF base namespace for all schema IRIs |
| `RESTORE_FROM` | *(unset)* | Path to a backup `.ttl` file inside the container to restore from |

---

## Local development

Run the API and frontend directly on your machine against the Docker QLever.

### 1. Start QLever via Docker

```bash
docker compose up qlever qlever-init
```

This exposes QLever at `http://localhost:7001` (see `docker-compose.override.yml`).

### 2. Start the API

```bash
cd api
npm install
PORT=3001 \
  QLEVER_SPARQL_URL=http://localhost:7001/sparql \
  QLEVER_UPDATE_URL=http://localhost:7001/update \
  QLEVER_ACCESS_TOKEN=sulo-dev-token \
  npm run dev
```

The API listens on `http://localhost:3001`.

### 3. Start the frontend

```bash
cd frontend
npm install
npm run dev
```

The dev server starts at **http://localhost:5173** and proxies `/api` → `localhost:3001` and `/sparql` → `localhost:7001`.

---

## Project structure

```
sulo-schema-builder/
├── api/
│   └── src/
│       ├── config.ts           # Environment-based configuration
│       ├── index.ts            # Entry point
│       ├── server.ts           # Fastify server setup
│       ├── plugins/
│       │   ├── cors.ts
│       │   ├── helmet.ts
│       │   ├── sensible.ts
│       │   └── sparqlClient.ts # QLever SPARQL client (sparql-http-client)
│       ├── routes/
│       │   ├── sparqlProxy.ts  # SPARQL SELECT proxy (read-only passthrough)
│       │   └── v1/
│       │       ├── health.ts
│       │       └── ontology.ts # All schema CRUD endpoints
│       ├── services/
│       │   └── sparql.service.ts
│       ├── rdf/
│       │   └── prefixes.ts     # Shared RDF prefix map
│       └── types/
│           └── sparql-http-client.d.ts
├── frontend/
│   └── src/
│       ├── App.tsx             # Routes
│       ├── api/
│       │   ├── client.ts       # Axios instance
│       │   └── ontology.ts     # React Query hooks
│       ├── components/layout/
│       │   ├── AppShell.tsx
│       │   └── NavBar.tsx
│       ├── pages/
│       │   └── OntologyBuilderPage.tsx   # Main page (all UI + export logic)
│       └── utils/
│           └── turtleLanguage.ts         # Monaco Turtle syntax highlighting
├── docker/
│   ├── api/Dockerfile
│   ├── nginx/                  # Nginx reverse-proxy config
│   └── qlever/
│       ├── init-index.sh       # Builds or restores the QLever index on startup
│       └── sulo.qlever         # QLever index settings
├── sparql/                     # Seed Turtle files loaded into QLever on first run
│   ├── backup/                 # Backup dumps for restore
│   ├── files/                  # Static ShEx / ontology files served by the API
│   └── queries/                # Example SPARQL queries
├── docker-compose.yml
└── docker-compose.override.yml # Dev overrides (port exposure, hot reload)
```

---

## REST API

Base path: `/api/v1`

### Ontology Schemas

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/ontology-schemas` | List all schemas |
| `POST` | `/ontology-schemas` | Create a schema |
| `GET` | `/ontology-schemas/:id` | Get a schema with all classes and properties |
| `PATCH` | `/ontology-schemas/:id` | Update schema metadata (title, description, upper ontology IRI) |
| `DELETE` | `/ontology-schemas/:id` | Delete a schema and all its classes/properties |

### Classes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/ontology-schemas/:id/classes` | Add a class |
| `PATCH` | `/ontology-schemas/:id/classes/:classId` | Update a class |
| `DELETE` | `/ontology-schemas/:id/classes/:classId` | Remove a class |
| `GET` | `/ontology-schemas/:id/upper-concepts` | Fetch classes/properties from the upper ontology for autocomplete |

### Properties

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/ontology-schemas/:id/properties` | Add a property |
| `PATCH` | `/ontology-schemas/:id/properties/:propId` | Update a property |
| `DELETE` | `/ontology-schemas/:id/properties/:propId` | Remove a property |

### System

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check — returns `{ status: "ok", version: "1.0.0" }` |
| `GET/POST` | `/sparql` | SPARQL proxy to QLever (SELECT read-only on GET, UPDATE on POST) |

---

## Usage

### Creating a schema

1. Open the app and click **Create ontology** in the sidebar.
2. Enter a **title**, optional **description**, and an **upper ontology IRI** (e.g. `https://w3id.org/sulo/`).
3. The upper ontology IRI is used to populate the *Maps to concept* autocomplete when adding classes and to generate OWL alignment triples in the export.

### Adding classes

Click **+ Add class** in the Classes panel. For each class you can set:

- **Name** — used as the local IRI fragment (e.g. `:ClinicalVisit`).
- **Label** — human-readable display name.
- **Maps to concept** — IRI of the upper-level concept this class is aligned to (e.g. `https://w3id.org/sulo/Process`). Type to search the configured upper ontology.
- **Subclass of** — optional parent class within the same schema for `rdfs:subClassOf` inheritance.

### Adding properties

Click **+ Add property** under a class. Each property has:

- **Name / Label** — local name and display label.
- **Type** — `object` (links to another class) or `datatype` (XSD literal).
- **Domain** — the class this property belongs to.
- **Range** — target class IRI (object property) or XSD datatype (datatype property).
- **Required** — whether the property is mandatory (affects SHACL `sh:minCount`).
- **Mapping pattern** — one or more `subject / predicate / object` triple templates expressing how this property "unfolds" into a SULO subgraph. Two reserved placeholders denote the original relation's endpoints: **`?this`** (the subject / domain) and **`?value`** (the object / range). For example, `hasPatient` on `ClinicalVisit` compiles to the three-hop role-bearer pattern:

  ```
  ?this  sulo:hasParticipant  ?role
  ?role  rdf:type             :SubjectOfCareRole
  ?role  sulo:isFeatureOf     ?value
  ```

  The `buildOwlExpr` compiler recurses over this pattern to emit nested `owl:someValuesFrom` restrictions; `buildReverseOwlExpr` walks it in the inverse direction to emit `owl:inverseOf` restrictions for the range.
- **Property characteristics** — OWL characteristics declared per property: `Functional`, `Inverse Functional`, `Transitive`, `Symmetric`, `Asymmetric`, `Reflexive`, `Irreflexive`; a single **inverse-of** property; and a set of **disjoint-with** properties (`owl:propertyDisjointWith`). These are emitted in the OWL + SULO export and enable a description-logic reasoner to detect further modelling errors.

### Loading the example schema

Click **Load Example** to populate a pre-built *Clinical Health Record Schema* (inspired by the SPHN schema), comprising:

- **28 classes** — 26 aligned to SULO categories (Process, Role, Quality, SpatialObject, InformationObject, Quantity) and 2 aligned to SNOMED CT URIs (`ObservableEntity` → `http://snomed.info/id/363787002`; `SCT_Procedure` → `http://snomed.info/id/71388002`).
- **83 properties** — 48 object properties linking schema classes and 35 datatype properties mapping to XSD literals.
- **3 subclass relationships** — `MeasurementProcess`, `EvaluationProcess`, and `MedicationAdministration` under `MedicalProcedure`; `ObservableEntity` and `SCT_Procedure` under `Code`.
- **16 `hasCode` properties** (one per clinical class) using the single-hop SULO pattern `?this sulo:hasFeature ?value`, demonstrating the SPHN `Code` pattern at scale.

The domain spans clinical visits, patients, care providers, care units, measurements and measurement processes, medical procedures, clinical conditions, severity, diagnostic statements, medication administration, pharmaceutical products and dose forms, evaluation processes, care plans, and devices. The `Code` class models the AIDAVA/SPHN terminology-code pattern (`hasIdentifier`, `hasCodingSystemAndVersion`, `hasName`).

A second **Load OMOP Example** button loads a parallel schema covering the same clinical domain in the OMOP CDM structural style, enabling side-by-side comparison.

### Exporting

Click **Generate** on any schema to open the export dialog. Four formats are available:

| Tab | File | Description |
|-----|------|-------------|
| **RDF Schema** | `<name>.ttl` | Plain RDF/Turtle — classes with `rdfs:label`, `rdfs:comment`, `rdfs:subClassOf`; properties with `rdfs:domain`, `rdfs:range` |
| **OWL + SULO** | `<name>_sulo.owl.ttl` | OWL ontology with SULO alignment — `owl:equivalentClass` restrictions expressing SULO mapping patterns; `owl:unionOf` for union ranges |
| **SHACL** | `<name>_shacl.ttl` | SHACL node shapes — one `sh:NodeShape` per class using schema-native predicates; `sh:or` for union ranges; `sh:minCount 1` for required properties |
| **UML Diagram** | `<name>_uml.mmd` | Mermaid `classDiagram` — paste into [mermaid.live](https://mermaid.live) or any Markdown renderer that supports Mermaid |

Use **Copy** to copy the content to the clipboard or **Download** to save the file. For the example schema, the OWL DL export generates 121 `owl:equivalentClass` axioms and 16 property-restriction blocks; the SHACL export generates 28 node shapes with 83 property constraints (2 with `sh:or` union blocks).

---

## Key design decisions

**Schema-native SHACL** — SHACL shapes use `:propertyName` as `sh:path` (the local schema predicate) rather than SULO path expressions. This keeps shapes self-contained and directly validatable against instance data serialised with the schema's own vocabulary.

**Union ranges** — when the same property name appears multiple times on the same class with different range classes (e.g. `hasCode` pointing to both `:Code` and `<http://snomed.info/id/363787002>`), the UI groups them into a union at display and export time: `owl:unionOf` in OWL and `sh:or` in SHACL.

**External class IRIs** — classes whose *Maps to concept* IRI is non-SULO (e.g. SNOMED CT URIs `http://snomed.info/id/363787002`) are referenced as `<full-IRI>` in all exports rather than as a local `:ClassName` prefix.

**QLever as triplestore** — all schema data is stored as RDF triples in QLever under the `https://w3id.org/sulo/schema/` base namespace. The API translates CRUD operations into SPARQL SELECT and SPARQL UPDATE queries.

**OWL DL error detection** — because the OWL + SULO export materialises the SULO class hierarchy, a description-logic reasoner (e.g. HermiT, Pellet, or OWL-RL) can surface modelling errors that are invisible to schema validators and SHACL. SULO declares `Capability`, `InformationObject`, `Quality`, and `Role` mutually disjoint (`owl:AllDisjointClasses`), and `Object` disjoint with `Process`. An individual or class that ends up in two disjoint categories — e.g. conflating a `DiagnosticStatement` (InformationObject) with the `Severity` (Quality) it describes, or a class subclassing both a Process- and an Object-aligned class — yields an unsatisfiable class or a reasoner clash. Switching between the SHACL and OWL + SULO tabs makes this difference concrete, which is the tool's main pedagogical use.

---

## Backing up and restoring data

### Dump the current triplestore

```bash
# While the stack is running:
curl "http://localhost:8080/sparql?query=CONSTRUCT+%7B+%3Fs+%3Fp+%3Fo+%7D+WHERE+%7B+%3Fs+%3Fp+%3Fo+%7D" \
  -H "Accept: text/turtle" > sparql/backup/$(date +%Y-%m-%dT%H-%M-%S).ttl
```

### Restore from a backup

Set the `RESTORE_FROM` environment variable to the path of the backup file inside the container and restart:

```bash
RESTORE_FROM=/backups/2026-01-01T12-00-00.ttl docker compose up --build
```

The `sparql/backup/` directory on the host is mounted at `/backups/` in the `qlever-init` container.
