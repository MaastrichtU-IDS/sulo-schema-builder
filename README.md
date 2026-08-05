# SULO-Compliant Schema Builder

A web application that bridges domain **schema design** and formal **OWL ontology engineering**. Define classes and properties, align them interactively to the [Simplified Upper-Level Ontology (SULO)](https://w3id.org/sulo/), and generate four artefacts from a single model — **RDF/Turtle**, **OWL DL** (with SULO equivalence axioms and property restrictions), **SHACL** shapes, and a **Mermaid UML** diagram — without writing OWL by hand.

![Schema builder](docs/images/builder.png)

## Features

- **Interactive alignment** — map each class to a SULO category and each property to a SULO path, with autocomplete over the upper ontology.
- **Mapping patterns** — express a relation as a SPARQL-style triple template using the placeholders `?this` (domain) and `?value` (range); the compiler unfolds it into nested OWL restrictions.
- **Property characteristics** — declare `Functional`, `Transitive`, `Symmetric`, `Asymmetric`, `Reflexive`, `Irreflexive`, `Inverse Functional`, an `owl:inverseOf`, and `owl:propertyDisjointWith` relations per property.
- **Four exports** from one schema — RDF/Turtle, OWL + SULO, SHACL, and Mermaid UML.
- **OWL DL error detection** — the SULO alignment lets a reasoner surface modelling errors (e.g. disjointness clashes) invisible to schema validators and SHACL.

## Quick start (Docker)

```bash
git clone https://github.com/MaastrichtU-IDS/sulo-schema-builder.git
cd sulo-schema-builder
cp .env.example .env      # optional
docker compose up --build
```

App: **http://localhost:8080**. On first run QLever builds its index from the seed Turtle in `sparql/` (a few seconds; reused afterwards).

| Variable | Default | Description |
|----------|---------|-------------|
| `QLEVER_ACCESS_TOKEN` | `sulo-dev-token` | Token for QLever SPARQL UPDATE |
| `BASE_NAMESPACE` | `https://w3id.org/sulo/schema/` | RDF base namespace for schema IRIs |
| `RESTORE_FROM` | _(unset)_ | Path to a backup `.ttl` inside the container to restore from |

## Local development

Run QLever in Docker, then the API and frontend on the host:

```bash
docker compose up qlever qlever-init        # QLever on :7001

cd api      && npm install && npm run dev    # API on :3001
cd frontend && npm install && npm run dev    # Vite on :5173
```

| Component | Stack |
|-----------|-------|
| Frontend | React 18, Vite, Tailwind CSS, React Flow |
| API | Fastify 5, TypeScript, N3.js |
| Triplestore | QLever (SPARQL 1.1 — any compliant store works) |

Tests: `cd frontend && npm test` (vitest — export logic, validation, components).

## Usage

1. **Create a schema** — give it a title and an upper-ontology IRI (e.g. `https://w3id.org/sulo/`).
2. **Add classes** — set a name (the local IRI fragment, e.g. `:ClinicalVisit`), a *Maps to concept* IRI (e.g. `https://w3id.org/sulo/Process`), and an optional parent class.
3. **Add properties** — set type (object/datatype), domain, range, a *mapping pattern*, and any *property characteristics*. For example, `hasPatient` on `ClinicalVisit` unfolds to the three-hop role-bearer pattern:

   ```
   ?this  sulo:hasParticipant  ?role
   ?role  rdf:type             :SubjectOfCareRole
   ?role  sulo:isFeatureOf     ?value
   ```

   See [docs/mapping-patterns.md](docs/mapping-patterns.md) for a catalog of
   common patterns (direct relation, role-mediated participation, reified
   values, and measurement quantities), each with its triple template and the
   OWL it unfolds to.

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
