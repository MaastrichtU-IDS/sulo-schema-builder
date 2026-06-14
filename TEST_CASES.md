# Test Cases — SULO Schema Builder

Test design for the SULO Schema Builder. Layers covered: **export logic** (pure
RDF/OWL/SHACL/Mermaid generation), **form validation** (Zod), **UI component**
behaviour, and **end-to-end** flows. Status legend: ✅ implemented & passing ·
🟡 spec written, opt-in deps · ⬜ designed, not yet implemented.

## Running the tests

```bash
cd frontend
npm test                 # vitest: export logic + validation + component (54 tests, all ✅)
npm run test:watch       # watch mode

# E2E (opt-in — requires browser download + the running stack):
npm i -D @playwright/test && npx playwright install chromium
#   start QLever (docker), API (:3001), Vite (:5173), then:
npx playwright test
```

| File | Layer | Count | Status |
|---|---|---|---|
| `src/lib/ontologyExport.test.ts` | Export logic (pure) | 29 | ✅ |
| `src/lib/formSchemas.test.ts` | Validation (Zod) | 15 | ✅ |
| `src/components/PropertyFeaturesEditor.test.tsx` | UI component | 10 | ✅ |
| `e2e/schema-flow.spec.ts` | End-to-end | 3 | 🟡 |
| API endpoint tests | Integration | — | ⬜ |

---

## 1. Export logic — `generateExports`, `buildOwlExpr`, `buildMermaid`, helpers

Pure functions in `src/lib/ontologyExport.ts`, tested with hand-built schema fixtures.

| ID | Scope | Input | Expected | Status |
|---|---|---|---|---|
| EXP-01 | `extractNamedGroups` | `(?<family>[a-z]+), (?<given>[a-z]+)` | `['family','given']` | ✅ |
| EXP-02 | `extractNamedGroups` | non-capturing `(?:foo)(?<x>bar)` | `['x']` | ✅ |
| EXP-03 | `extractNamedGroups` | no groups / empty | `[]` | ✅ |
| EXP-04 | `escTtl` | `say "hi"` | `say \"hi\"` | ✅ |
| EXP-05 | `escTtl` | backslash then newline | escaped in correct order | ✅ |
| EXP-06 | `shortenIri` | base-namespace IRI | `:Local` (empty prefix) | ✅ |
| EXP-07 | `shortenIri` | xsd IRI | `xsd:string` | ✅ |
| EXP-08 | `shortenIri` | unknown namespace | `<full-iri>` fallback | ✅ |
| EXP-09 | `shortenIri` | local part starting with a digit | `<full-iri>` (invalid local name) | ✅ |
| EXP-10 | `buildOwlExpr` | empty pattern | `owl:Thing` | ✅ |
| EXP-11 | `buildOwlExpr` | `?this p ?value` | `someValuesFrom` restriction on terminal class | ✅ |
| EXP-12 | `buildOwlExpr` | chained pattern with `rdf:type` on `?o1` | intersection of type + nested restriction | ✅ |
| EXP-13 | `buildMermaid` | 2 classes | `classDiagram` + one block each | ✅ |
| EXP-14 | `buildMermaid` | object vs datatype property | `-->` vs `..>` arrows | ✅ |
| EXP-15 | `buildMermaid` | SULO-mapped subclass | `<<sulo:Process>>` stereotype + `<|--` edge | ✅ |
| EXP-16 | `generateExports` plain | SULO-mapped class | `rdfs:Class`, no `owl:` | ✅ |
| EXP-17 | `generateExports` OWL | SULO-mapped class | `owl:Ontology`, `owl:Class`, `owl:imports`, `rdfs:subClassOf sulo:Process` | ✅ |
| EXP-18 | property characteristics | `['functional','transitive']` | `a owl:ObjectProperty, owl:FunctionalProperty, owl:TransitiveProperty` | ✅ |
| EXP-19 | inverse-of | schema name vs external IRI | `owl:inverseOf :name` / `owl:inverseOf <iri>` | ✅ |
| EXP-20 | disjoint-with | schema name | `owl:propertyDisjointWith :hasPatient` | ✅ |
| EXP-21 | multi-range (OWL) | same name+domain, 2 ranges | `owl:unionOf (:Code :ObservableEntity)` | ✅ |
| EXP-22 | multi-range (SHACL) | same name, 2 ranges | `sh:or ( [sh:class :Code] [sh:class :ObservableEntity] )` | ✅ |
| EXP-23 | SHACL target | class with props | `:XShape … sh:targetClass :X` | ✅ |
| EXP-24 | SHACL datatype | datatype range | `sh:datatype xsd:float` / `xsd:string` | ✅ |
| EXP-25 | SHACL cardinality | required vs optional | `sh:minCount 1` / `sh:minCount 0` | ✅ |
| EXP-26 | external concept IRI | non-SULO `mapsToConceptIri` | class identified by `<snomed-iri>` | ✅ |

**Designed, not yet implemented:**

| ID | Scope | Input | Expected |
|---|---|---|---|
| EXP-27 ⬜ | `buildReverseOwlExpr` | object property w/ mapping | inverse-restriction chain terminating at domain class |
| EXP-28 ⬜ | round-trip | `generateExports` OWL output | parses as valid Turtle (via N3/rdflib) |
| EXP-29 ⬜ | SHACL last-property terminator | single property | block ends with `.` not `;` |
| EXP-30 ⬜ | empty schema | no classes/props | header-only Turtle, no dangling sections |

---

## 2. Form validation — Zod schemas (`src/lib/formSchemas.ts`)

| ID | Scope | Input | Expected | Status |
|---|---|---|---|---|
| VAL-01 | schema title | non-empty title | valid | ✅ |
| VAL-02 | schema title | empty | invalid | ✅ |
| VAL-03 | upper IRI | malformed URL | invalid | ✅ |
| VAL-04 | upper IRI | valid URL or `''` | valid | ✅ |
| VAL-05 | class name | `ClinicalVisit` | valid | ✅ |
| VAL-06 | class name | `Clinical Visit` (space) | invalid, "No spaces allowed" | ✅ |
| VAL-07 | class name | empty | invalid | ✅ |
| VAL-08 | class mapsTo | any string (e.g. `not-a-url`) | valid (unconstrained) | ✅ |
| VAL-09 | property | minimal valid | valid | ✅ |
| VAL-10 | property name | `has Code` (space) | invalid | ✅ |
| VAL-11 | property domain | empty `domainClassId` | invalid, "Domain class is required" | ✅ |
| VAL-12 | property type | `annotation` | invalid (enum) | ✅ |
| VAL-13 | mapping pattern | 2-triple chain | round-trips unchanged | ✅ |
| VAL-14 | characteristics | features + inverse + disjoint arrays | valid, preserved | ✅ |
| VAL-15 | mapping pattern | triple missing `object` | invalid | ✅ |

**Designed:** VAL-16 ⬜ API-side `AddPropertyBody` parity (no name-regex on the
server — confirm intentional / decide whether to mirror the frontend rule).

---

## 3. UI component — `PropertyFeaturesEditor`

Rendered with `@testing-library/react` + jsdom.

| ID | Scope | Action | Expected | Status |
|---|---|---|---|---|
| UI-01 | object property | render | all 7 characteristic checkboxes shown | ✅ |
| UI-02 | datatype property | render | only Functional; object-only features hidden | ✅ |
| UI-03 | toggle | click Functional | `onChange(['functional'])` | ✅ |
| UI-04 | datatype property | render | no "Inverse of" row | ✅ |
| UI-05 | dedup | render with duplicate `hasCode` | `hasCode` appears once in inverse dropdown | ✅ |
| UI-06 | inverse single-select | select `hasPatient` | `onInverseIriChange('hasPatient')` | ✅ |
| UI-07 | disjoint add | pick from schema dropdown | `onDisjointChange(['hasPatient'])` | ✅ |
| UI-08 | disjoint remove | click × on pill | `onDisjointChange([])` | ✅ |
| UI-09 | OWL preview | features + inverse + disjoint | preview lists all OWL axioms | ✅ |
| UI-10 | external IRI | pasted disjoint IRI | preview shows `owl:propertyDisjointWith <iri>` | ✅ |

**Designed:** UI-11 ⬜ disjoint free-text + Enter adds an external IRI pill ·
UI-12 ⬜ already-selected disjoint name is removed from the "+ from schema…" options.

---

## 4. End-to-end — `e2e/schema-flow.spec.ts` (Playwright, opt-in)

Requires the running stack (QLever + API :3001 + Vite :5173).

| ID | Flow | Steps | Expected | Status |
|---|---|---|---|---|
| E2E-01 | seed example | Load Example → navigate | URL `/ontology/<id>`; classes visible | 🟡 |
| E2E-02 | characteristic round-trip | edit property → check Functional → Save → Generate → OWL | `owl:FunctionalProperty` in export | 🟡 |
| E2E-03 | name validation | Add class "Bad Name" → submit | inline "No spaces allowed" error | 🟡 |

**Designed:** E2E-04 ⬜ create schema → add class → add object property with a
mapping pattern → SHACL export shows the shape · E2E-05 ⬜ set patient/provider
disjoint, export, confirm `owl:propertyDisjointWith` · E2E-06 ⬜ delete a class
and confirm its properties are gone.

---

## 5. API integration (designed — ⬜ not implemented)

Vitest + Fastify `inject()` (no network) against a mocked SPARQL client, or
against the live QLever on :7002.

| ID | Endpoint | Case | Expected |
|---|---|---|---|
| API-01 ⬜ | `POST /ontology-schemas` | valid body | 201 + schema with id |
| API-02 ⬜ | `POST /ontology-schemas` | empty title | 400 |
| API-03 ⬜ | `POST …/properties` | with `propertyFeatures` + `disjointPropertyIris` | persisted, returned on GET |
| API-04 ⬜ | `GET …/:id` | after create | classes + properties round-trip (incl. mappingPattern JSON) |
| API-05 ⬜ | `PATCH …/properties/:propId` | update range | 204; GET reflects change |
| API-06 ⬜ | `DELETE …/:id` | existing schema | 204; subsequent GET 404 |
| API-07 ⬜ | `GET …/upper-concepts` | unreachable IRI | `[]` (graceful) |

---

## Notes / invariants worth guarding

- **Property identity is by name.** Same-named rows on different domains collapse
  to one OWL property symbol; inverse/disjoint references and dedup all key on
  name (UI-05, EXP-19/20).
- **SULO vs external classes.** A non-SULO `mapsToConceptIri` makes the class be
  identified by that IRI in every export; SULO mappings become `rdfs:subClassOf`
  (EXP-17, EXP-26).
- **Characteristics are additive** on the base `owl:ObjectProperty`/`DatatypeProperty`
  type, comma-joined (EXP-18).
- **Absence ≠ error** in OWL output — completeness/cardinality lives only in SHACL
  (EXP-25); keep both exports in any conformance comparison.
