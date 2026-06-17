# OMOP Example — SULO Consistency Issues

Status: **documentation only — no fixes applied yet.**

## Summary

The bundled **OMOP CDM Schema** example (loaded via *Load OMOP Example*, defined in
`frontend/src/pages/OntologyBuilderPage.tsx` — `OMOP_EXAMPLE_CLASSES` + `handleLoadOmopExample`)
is **logically consistent** as a bare TBox (no individual-level contradiction) and **all 22 named
classes are satisfiable**. However, under a full OWL DL reasoner (HermiT) the generated OWL is
**incoherent**: it contains **44 unsatisfiable classes**, stemming from **25 property mappings** whose
SULO alignment violates SULO's relation domains/ranges or its `∀hasPart` category restrictions
(categories **A–E** below). A separate defect, **property-name reuse** (category **F**), additionally
collapses several properties to contradictory conjunctive domains/ranges.

Each violating **object** property contributes two unsatisfiable anonymous classes (its `rdfs:domain`
*and* `rdfs:range` `owl:equivalentClass` expression); each violating **datatype** property contributes
one (domain only): `19 object × 2 + 6 datatype × 1 = 44` (categories A–E; F is counted separately).

These errors are **invisible to SHACL and to lightweight named-class reasoning** (RDFS / OWL-RL over
named classes) — no *named* class is a subclass of two disjoint categories. They surface only under the
tool's **full OWL DL consistency check (HermiT)**, because they live inside restriction bodies, property
domains/ranges, and inverse axioms.

> **Incoherence vs. inconsistency.** The bare schema is *consistent* (the unsatisfiable classes simply
> have no members). But the moment realistic data populates any broken property, the knowledge graph
> becomes outright **inconsistent** — see *From incoherence to inconsistency* below. Both states are
> invisible to SHACL.

### How this was verified

Reconstructed the exact schema the loader posts (22 classes, 90 properties), generated OWL via the
production `generateExports`, merged it with the full SULO ontology (`api/resources/sulo.ttl`) **into a
materialised file**, then ran HermiT on that file:

```
robot merge --input sulo.ttl --input omop.owl.ttl --output merged.ttl
robot explain --input merged.ttl --reasoner HermiT --mode unsatisfiability --unsatisfiable all   # → 44 classes
robot reason  --input merged.ttl --reasoner HermiT                                               # coherency/consistency verdict
```

> **Methodology caveat.** Run the reasoner against a *materialised* merged file. Chaining
> `robot merge … explain` in a single invocation is unreliable — the merged ontology/imports are not
> fully applied before `explain` runs, so it silently returns "No explanations found" for ontologies
> that are in fact inconsistent (notably datatype-driven contradictions). The same pitfall was present
> in `api/src/services/reasoner.service.ts` and has been fixed to merge-to-file first.

## Relevant SULO constraints

| SULO term | Constraint (from `sulo.ttl` 0.2.14) |
|---|---|
| `sulo:hasValue` | `rdfs:domain sulo:InformationObject` (functional datatype property) |
| `sulo:refersTo` | `rdfs:domain sulo:InformationObject` (range `owl:Thing`) |
| `sulo:hasParticipant` | `rdfs:domain sulo:Process`, `rdfs:range sulo:Object` (inverse of `isParticipantIn`, range `Process`) |
| `sulo:hasFeature` | `rdfs:domain (Object ⊔ Process)`, `rdfs:range sulo:Feature` |
| `sulo:hasPart` | per-category universals: `Object/Process/Feature/InformationObject/SpatialObject ⊑ ∀hasPart.(same)` |
| `sulo:isPartOf` | inverse of `hasPart` (so the *whole's* `∀hasPart` applies to the part) |
| `sulo:isIn`, `sulo:atTime` | unconstrained domain (`isIn` generic transitive; `atTime` domain `owl:Thing`, range `Time`) — **safe** |
| disjointness | `Object ⊥ Process`; `Feature ⊥ SpatialObject`; `Feature = Capability ⊔ InformationObject ⊔ Quality ⊔ Role` (disjoint union) |

OMOP class → SULO category alignments that matter below: Visit/Condition/Drug/Procedure/Device Occurrence → `Process`;
Measurement, Observation, Concept → `InformationObject`; Person, Provider, CareSite, Location, Specimen, DrugProduct,
Device → `SpatialObject`; PatientRole/ProviderRole/OutputRole/InstrumentRole → `Role`; MeasurementValue, DoseQuantity → `Quantity`;
**Unit → `Quality`** (see cross-cutting note C).

---

## Issues by category

### A. `sulo:refersTo` used where the subject is not an `InformationObject` (7 properties → 14 classes)

`refersTo` requires an `InformationObject` subject. These domains are `Process` or `SpatialObject`,
disjoint from `InformationObject` (via `Object ⊥ Process` / `Feature ⊥ SpatialObject`).

| Property | Domain (category) | Why unsatisfiable |
|---|---|---|
| `drug_concept_id` | DrugExposure (Process) | a Process can't `refersTo` |
| `visit_source_concept_id` | VisitOccurrence (Process) | " |
| `condition_source_concept_id` | ConditionOccurrence (Process) | " |
| `drug_source_concept_id` | DrugExposure (Process) | " |
| `procedure_source_concept_id` | ProcedureOccurrence (Process) | " |
| `device_source_concept_id` | DeviceExposure (Process) | " |
| `specimen_source_concept_id` | Specimen (SpatialObject) | a SpatialObject can't `refersTo` |

**Fix:** map these to **`sulo:hasFeature`** (subject `Object ⊔ Process`, range `Feature`; `Concept ⊑ InformationObject ⊑ Feature`).
This is exactly the pattern the *other* `*_concept_id` / `*_type_concept_id` properties already use and which reasons cleanly.
`drug_concept_id` using `refersTo` while every sibling uses `hasFeature` looks like an oversight.

### B. `sulo:hasParticipant` used where the subject is not a `Process` (6 properties → 12 classes)

`hasParticipant` requires a `Process` subject. Measurement/Observation are `InformationObject`; Specimen is `SpatialObject`.

| Property | Domain (category) | Pattern | Why unsatisfiable |
|---|---|---|---|
| `person_id` | Measurement (InformationObject) | participant→PatientRole→isFeatureOf | InfoObject is not a Process |
| `provider_id` | Measurement (InformationObject) | participant→ProviderRole | " |
| `hasMeasurementResult` | Measurement (InformationObject) | participant→OutputRole | " |
| `person_id` | Observation (InformationObject) | participant→PatientRole | " |
| `provider_id` | Observation (InformationObject) | participant→ProviderRole | " |
| `person_id` | Specimen (SpatialObject) | participant→PatientRole | SpatialObject is not a Process |

**Fix:**
- **Measurement/Observation → person/provider:** these are *information objects about* a person/event, so model with
  **`sulo:refersTo`** (subject must be `InformationObject` — satisfied here; range `owl:Thing`), i.e. the record refers to
  the Person/Provider. Alternatively attach person/provider to the underlying clinical *Process* rather than to the result record.
- **`hasMeasurementResult`** (Measurement → MeasurementValue, a `Quantity ⊑ InformationObject`): use **`sulo:hasPart`**
  (`InformationObject ⊑ ∀hasPart.InformationObject`, and `MeasurementValue ⊑ InformationObject` ✓) or `sulo:hasFeature`.
- **Specimen → person:** a specimen is physically derived from the person; **`sulo:isPartOf` Person** is coherent
  (`SpatialObject ⊑ ∀hasPart.SpatialObject`, Person is `SpatialObject`). Otherwise introduce an explicit collection `Process`.

### C. `sulo:hasPart` with a filler of the wrong category (4 properties → 8 classes)

The whole's `∀hasPart.(its-own-category)` forces the part into that category.

| Property | Whole (category) | Part (category) | Why unsatisfiable |
|---|---|---|---|
| `hasDoseQuantity` | DrugExposure (Process) | DoseQuantity (Quantity ⊑ InformationObject ⊑ Object) | Process parts must be Process; Object ⊥ Process |
| `unit_concept_id` | Measurement (InformationObject) | Unit (Quality) | InfoObject parts must be InfoObject; Quality ⊥ InformationObject |
| `unit_concept_id` | Observation (InformationObject) | Unit (Quality) | " |
| `unit_concept_id` | Specimen (SpatialObject) | Unit (Quality) | SpatialObject parts must be SpatialObject; Feature ⊥ SpatialObject |

**Fix:**
- **Re-map OMOP `Unit` from `sulo:Quality` → `sulo:Unit`** (`sulo:Unit ⊑ Quantity ⊑ InformationObject`). A unit of measure
  *is* a `sulo:Unit`, not a quality — this alignment is independently wrong. That alone fixes the Measurement/Observation
  `unit_concept_id` cases (InfoObject `hasPart` InfoObject ✓).
- Attach the unit to the **value/quantity**, not the record: e.g. `MeasurementValue hasPart Unit` (Quantity has a Unit part —
  mirrors SULO's own `Quantity ⊑ ∃hasPart.Unit`). For Specimen, attach the unit to the specimen's *quantity* value rather
  than to the specimen itself.
- **`hasDoseQuantity`:** a dose is not a temporal part of the drug-exposure process. Use **`sulo:hasFeature`**
  (`DoseQuantity ⊑ InformationObject ⊑ Feature`, subject Process ✓), or attach the dose `Quantity` to a participating
  output/product rather than to the process.

### D. `sulo:isPartOf` linking an `InformationObject` into a `Process` whole (2 properties → 4 classes)

`X isPartOf Y` ⇒ `Y hasPart X`, so the whole's `∀hasPart` applies. VisitOccurrence is a `Process`, so its parts must be Processes.

| Property | Part (category) | Whole (category) | Why unsatisfiable |
|---|---|---|---|
| `visit_occurrence_id` | Measurement (InformationObject) | VisitOccurrence (Process) | Visit's parts must be Process; Object ⊥ Process |
| `visit_occurrence_id` | Observation (InformationObject) | VisitOccurrence (Process) | " |

*(The same `visit_occurrence_id` on the Process tables — Condition/Drug/Procedure/Device — is **fine**, since those are Processes.)*

**Fix:** a measurement/observation *record* is not a temporal part of the visit *process*. Use a non-parthood association:
**`sulo:isIn`** (unconstrained, transitive — "the record occurs within the visit"), mirroring how `care_site_id`/`location_id`
already use `isIn`. Alternatively relate the result to the visit via the *process* that produced it.

### E. `sulo:hasValue` on a subject that is not an `InformationObject` (6 properties → 6 classes)

`hasValue` requires an `InformationObject` subject. These datatype properties hang the literal directly off a
`Process` or `SpatialObject` table.

| Property | Domain (category) | Why unsatisfiable |
|---|---|---|
| `stop_reason` | DrugExposure (Process) | Process can't carry `sulo:hasValue` |
| `quantity` | DrugExposure (Process) | " |
| `days_supply` | DrugExposure (Process) | " |
| `refills` | DrugExposure (Process) | " |
| `stop_reason` | ConditionOccurrence (Process) | " |
| `quantity` | Specimen (SpatialObject) | SpatialObject can't carry `sulo:hasValue` |

**Fix:** route literal data through an `InformationObject` carrier, never directly off a Process/SpatialObject. Model each
measure as a `Quantity`/`Concept`/note (an `InformationObject`) attached via `hasFeature`/`hasPart`, and put `hasValue` on that
carrier. This is the pattern the **datetime** properties already use correctly (`?this atTime ?t ; ?t a sulo:TimeInstant ; ?t hasValue ?v`)
— the `hasValue` sits on the `TimeInstant` (an `InformationObject`), not on the event, which is why those are satisfiable.

### F. Property-name reuse across tables (independent of A–E)

Many OMOP columns share a name across tables — `person_id`, `provider_id`, `visit_occurrence_id`,
`value_as_number`, `unit_concept_id`, `stop_reason`, `quantity`, `*_type_concept_id`,
`*_source_concept_id`. `generateExports` emits one property IRI per name with **one `rdfs:domain` (and,
for object properties, one `rdfs:range`) axiom per (name, domain) group**. OWL reads multiple
`rdfs:domain`/`rdfs:range` axioms on a single property as their **conjunction**, which produces defects
beyond the category mismatches above:

- **Conjunctive object-property domains.** `:person_id` ends up with domain
  `VisitOccurrence ⊓ ConditionOccurrence ⊓ … ⊓ Measurement ⊓ Specimen`. Since these span disjoint SULO
  categories (`Process` vs `InformationObject` vs `SpatialObject`), the effective domain is unsatisfiable,
  so the property is unusable on *any* table — not only the categorically-wrong ones from B/D.
- **Conflicting datatype ranges + functional `hasValue`.** `:value_as_number` is declared with range
  `xsd:float` (on Measurement) **and** `xsd:decimal` (on Observation). Because the underlying
  `sulo:hasValue` is an `owl:FunctionalProperty`, a single asserted value would have to be both a float
  and a decimal — disjoint datatypes — which makes the ontology **inconsistent** as soon as the property
  is populated (HermiT confirmed this on a synthetic `Measurement` with one `value_as_number`).

**Fix:** give each table its own property IRI (e.g. `measurement_person_id`, `observation_value_as_number`),
or have the export disambiguate reused names by domain. This is orthogonal to A–E: a property could be
categorically correct yet still broken by reuse, and vice-versa.

---

## From incoherence to inconsistency (populating the schema)

The bare TBox is *consistent* (its 44 unsatisfiable classes simply stay empty). To show what happens
with data, synthetic ABoxes were merged with `sulo.ttl` + the generated OMOP OWL and checked with HermiT
(`robot reason` on the materialised merge; "is inconsistent" vs merely "unsatisfiable" distinguishes the
two states):

| Synthetic ABox | HermiT verdict |
|---|---|
| Only coherent, uniquely-named properties (visit/measurement `*_concept_id` + `*_datetime` + `concept_id`) | **CONSISTENT** (TBox still incoherent, but no individual is forced into an empty class) |
| `drug1 :days_supply 30` (E — `hasValue` on a Process) | **INCONSISTENT** |
| `drug1 :drug_concept_id …` (A — `refersTo` on a Process) | **INCONSISTENT** |
| `meas1 :hasMeasurementResult …` (B — `hasParticipant` on an InformationObject) | **INCONSISTENT** |
| `drug1 :hasDoseQuantity …` (C — `hasPart` on a Process) | **INCONSISTENT** |
| `obs1 :visit_occurrence_id visit1` (D — `isPartOf` into a Process) | **INCONSISTENT** |
| `meas1 :value_as_number 5.4` (F — conflicting datatype ranges) | **INCONSISTENT** |
| A realistic multi-table record set | **INCONSISTENT** |

**Takeaway.** Populating any single broken property turns the incoherent-but-consistent schema into a
logically **inconsistent** knowledge graph — data that SHACL validates without complaint. The clean
subset stays consistent, confirming the issues are localised to the 25 + reuse defects, not the schema
as a whole. The contradiction each ABox triggers matches its TBox category exactly (an individual is
forced into one of the unsatisfiable domain/range classes).

---

## Cross-cutting recommendations

1. **Re-map `Unit` → `sulo:Unit`** (not `sulo:Quality`). Semantically correct and resolves two of the category-C clashes.
2. **Concept references should use `sulo:hasFeature`, uniformly.** Replace every `sulo:refersTo`-to-`Concept` mapping on a
   non-`InformationObject` table (category A) with `hasFeature`, matching the existing `*_concept_id` mappings.
3. **Only `InformationObject`s carry data.** Any `sulo:hasValue` (and any direct literal attribute) must sit on an
   `InformationObject` carrier; Processes/SpatialObjects route data through a `Quantity`/`Concept`/note feature (category E).
4. **Don't attach results by parthood to processes.** Measurement/Observation records relate to a visit/encounter via
   association (`isIn`) or via the producing process — not `isPartOf` (category D).
5. **`hasParticipant` is Process-only.** Information-object "results" (Measurement, Observation) and physical objects
   (Specimen) cannot have participants; re-express their person/provider/result links accordingly (category B).
6. **Disambiguate reused property names per table** (category F). Either mint a distinct IRI per
   (table, column) or have the export key properties by domain, so shared names like `person_id` /
   `value_as_number` don't collapse to contradictory conjunctive domains/ranges.

### Minor (not a consistency issue)

- `concept_name` maps via **`sulo:hasLabel`**, which is **not defined in SULO**. It causes no clash (an undefined property has
  no domain/range), but it should likely be `rdfs:label` or `sulo:hasValue` for a real, satisfiable, well-defined mapping.

## Appendix — properties that reason cleanly

For contrast, these patterns are already SULO-coherent and should be the template for fixes:
`*_concept_id` / `*_type_concept_id` via `hasFeature` (event→Concept); all `*_datetime` via `atTime → Time-instant → hasValue`;
`care_site_id` / `location_id` / `anatomic_site_concept_id` via `isIn`; `hasDrugProduct` / `hasDevice` via `hasParticipant`
(Process subject); `preceding_visit_occurrence_id` and the Process-table `visit_occurrence_id` via `isPartOf` (Process→Process);
and all `hasValue` datatype properties on Measurement/Observation (InformationObject subjects).
