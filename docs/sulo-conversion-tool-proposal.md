# Project Proposal: SULO-Verified Schema Mapping for OMOP CDM ⇄ FHIR Conversion

**A reasoner-grounded methodology and tool for discovering, documenting, and executing cross-schema data conversions**

---

## 1. Summary

Converting between healthcare data standards (OMOP CDM, FHIR) is normally hand-crafted: an engineer
decides, by judgment and naming convention, which field on one side "means" which field on the other — a
claim that is rarely checked and fails silently, since SHACL/JSON Schema validate shape, not semantic
correctness.

This proposal uses a shared upper-level ontology (**SULO**) and an OWL DL reasoner (**HermiT**) as a
verification substrate instead. Two schemas are each mapped into SULO's upper categories and checked for
logical consistency; properties across the two are matched not by name but by **structural shape** — an
identical (domain category, relation pattern, range category) triple. Matches are visualized, rendered as
draft declarative mappings, hand-finished where ontology alone can't decide, and executed by a small
generic interpreter with no per-field code.

Demonstrated end-to-end on OMOP CDM ⇄ FHIR (MIMIC-IV-on-FHIR profiles) for **Condition, Observation, and
Medication**.

## 2. Motivation

- MIMIC-IV is independently published as both OMOP CDM and native FHIR — the same clinical facts, two
  incompatible schemas, no reasoner-checked bridge.
- A mapping claim like "OMOP's `condition_concept_id`" ↔ "`Condition.code`" is either right by luck or wrong
  silently; nothing forces it to be checked against anything but the author's reading comprehension.
- This project's own prior work hit exactly this failure: an OMOP schema that passed SHACL validation
  turned out, under a full DL reasoner, to contain **44 unsatisfiable classes** (§7) — invisible to every
  validation layer short of a DL reasoner. If a *single* schema needs reasoner verification, *cross-schema*
  correspondence needs it more.

## 3. Problem

No standard tool treats a schema's ontology alignment as a checkable artifact usable to (a) verify its own
internal consistency, and (b) derive cross-schema correspondences from that verified alignment rather than
naming similarity. Mapping errors are structurally invisible, transformation logic is usually bespoke code
with no separation between "what the ontology proved" and "what a human decided," and gaps are silently
dropped rather than surfaced.

## 4. Aim

Design, implement, and validate a methodology and tool using SULO + a DL reasoner to discover, document,
and execute verified structural correspondences between independently-designed schemas — demonstrated on
OMOP CDM ⇄ FHIR conversion for Condition, Observation, and Medication.

| # | Objective |
|---|---|
| O1 | Map each schema to SULO-aligned OWL and verify consistency via HermiT. |
| O2 | Implement shape-matching: correspondences by structural equivalence, not naming. |
| O3 | Visualize matches (matched / ambiguous / one-sided) in the Schema Builder app. |
| O4 | Auto-generate draft declarative transformation specs from the matches. |
| O5 | Implement a resource-agnostic interpreter executing specs bidirectionally, no per-field code. |
| O6 | Validate against real profiles and data via round-trip fidelity and SHACL checks. |
| O7 | Characterize, empirically, what the ontology can decide vs. what needs human judgment. |

## 5. Methodology

**Phase 1 — Ground in SULO.** Each schema's classes map to one of SULO's upper categories (`Process`,
`Object`/`SpatialObject`, `InformationObject`, `Quality`, `Role`, `Quantity`); each property is a short
triple pattern over a fixed set of SULO relations. The resulting OWL is checked with HermiT — catching
disjointness/domain-range violations inside reified relation chains that SHACL/RDFS can't see.

**Phase 2 — Match by shape, not name.** A property's shape is `(domain category, generalized relation
chain, range category-or-datatype)`, with intermediate role/carrier nodes generalized to their SULO
category. Two properties are a candidate correspondence iff their shapes are identical, bucketed as
**matched** (flagged **ambiguous** if either side has >1 candidate), **source-only**, or **target-only**.
Implemented schema-agnostically, not hardcoded to OMOP/FHIR.

**Phase 3 — Visualize.** A UI lets a user pick two schemas (optionally scoped to classes), run the
comparison, and inspect the three buckets with shape citations.

**Phase 4 — Generate a draft.** The match result renders as YAML using a fixed op vocabulary (`copy`,
`reference`, `const`, `drop_source`, `drop_target`, `coding_list`, `value_branch`, `range`). The generator
infers an operation from each property's type/range, and flags — rather than guesses — ties and missing
real path names.

**Phase 5 — Human refinement, recorded.** A reviewer resolves ties, supplies path names, and records any
override where shapes differ but a human judges the correspondence still holds — as an inline comment, not
a silent decision.

**Phase 6 — Execute generically.** A small fixed interpreter runs the finished YAML both directions; no
per-field transformation function exists anywhere — correctness is a property of the YAML alone.

**Phase 7 — Validate.** Round-trip fidelity (source→target→source, diffed field by field, each loss
explained) and SHACL conformance against the target schema's exported shapes.

## 6. Architecture

```
┌─────────────────────────┐        ┌──────────────────────────┐
│   Schema Builder (app)   │        │   ETL scaffold (etl/)    │
│  Schema A ──┐            │        │  mappings/*.yaml         │
│             ├─ SULO ──── │──HermiT│  (declarative ops,       │
│  Schema B ──┘  align     │  check │   SULO-shape citations)  │
│             │            │        │           │              │
│   shape-matching service │──draft▶│   ops.py interpreter      │
│   (compare/generate-yaml)│  YAML  │   (7 ops, both directions)│
└─────────────────────────┘        └──────────────────────────┘
```

The Schema Builder holds the ontological ground truth and produces *evidence* for a correspondence; the ETL
scaffold consumes that evidence as a declarative spec. The two communicate through YAML, not shared code.

## 7. Pilot results (completed)

- **OMOP CDM Schema** (22 classes/90 properties): HermiT found **44 unsatisfiable classes** across 25
  mis-categorized mappings plus a property-name-reuse defect. All 42 resulting fixes applied → fully
  consistent.
- **MIMIC-IV FHIR Demo Schema** (19/38): built from real MIMIC-IV-on-FHIR StructureDefinitions, consistent
  by construction.
- **Shape matching** surfaced **18 verified correspondences** (patient linkage, encounter containment,
  coded values, temporal fields, dose/unit composition) and located *why* several OMOP properties were
  unsatisfiable in the first place (e.g. `hasParticipant` used from an `InformationObject` table, where the
  relation strictly requires `Process`).
- **Declarative ETL** for Condition, Observation, Medication: fixtures, CLI, **22 passing tests**, including
  round-trip diffs quantifying exactly what survives losslessly vs. what's approximated.
- **The draft generator**, tried on a resource pair (Medication) it hadn't seen hand-finished: auto-completed
  ~⅓ of fields correctly, correctly self-flagged another ⅓ as needing a human tie-break (one of its own
  arbitrary picks was in fact wrong — the exact case the flag exists for), and correctly binned the rest as
  one-sided gaps. It also surfaced a real limitation: a correspondence needing one hop of indirection (a
  field describing the entity a target reference points to, not the record it sits on) is invisible to
  per-property shape comparison.

## 8. Contributions

1. An upper ontology + DL reasoner as a **verification substrate for cross-schema correspondence**, not
   just single-schema alignment.
2. A reusable, implemented **shape-matching algorithm**, productized in-app rather than a one-off script.
3. A **declarative, audit-trail-preserving mapping language** (7 ops) covering three clinical domains with
   no custom code, every human override recorded inline.
4. An **empirical account of automation's boundary**: structural correspondence is automatable; path
   naming, resource-type choice, and cross-entity indirection are not — shown, not asserted.

## 9. Evaluation

| Metric | Status |
|---|---|
| Consistency (HermiT unsatisfiable classes = 0) | Achieved both pilot schemas; proposed as a standing regression gate |
| Coverage (correct/correctly-flagged fields) | ~⅔ in the Medication trial; broader measurement proposed |
| Fidelity (round-trip survival, by loss reason) | Quantified per resource; proposed as a standard report going forward |
| Effort reduction (draft vs. from-scratch) | Observed qualitatively; formal measurement proposed |

## 10. Limitations

- Terminology mapping (ICD ↔ SNOMED, etc.) is out of scope — a content question, not the structural one
  this tool addresses.
- Shape-matching is per-domain-class; one-hop-indirection correspondences aren't caught automatically (§7).
- Target serialization is "close enough," not certified against a real FHIR validator.
- Only three domains piloted; full resource-catalog generalization is future work.
- **Operational risk, unrelated to the methodology**: the Schema Builder's triple store did not durably
  persist across a process restart, losing all working schemas mid-project — a host-application issue any
  deployment of this tool currently inherits.

## 11. Future work

1. More FHIR resource types (Procedure, Encounter/Visit, DeviceExposure).
2. Real terminology-service integration.
3. Interactive ambiguity resolution in the UI (currently YAML-comment-only).
4. An entity-indirection matching pass.
5. FHIR-validator-certified output.
6. Fix the storage-layer durability gap.

## 12. Work plan

| Phase | Scope | Status |
|---|---|---|
| 1–2 | SULO grounding + HermiT verification/remediation, both schemas | **Complete** |
| 3 | Shape-matching service + comparison UI | **Complete** |
| 4–6 | Draft generation, op interpreter, 3 resource mappings + tests | **Complete** |
| 7 | Round-trip fidelity + SHACL validation | **Complete** |
| Phase 2 (proposed) | §11 items | Not started |

## 13. References

- Çelebi R, Martínez-Costa C, Schulz S, Dumontier M. *SULO — a Simplified Upper-Level Ontology.* JOWO
  Episode XI, co-located with FOIS 2025, Catania, Italy.
- OHDSI. *OMOP Common Data Model*, v5.4. https://ohdsi.github.io/CommonDataModel/
- Kind Lab. *MIMIC-IV Clinical Database Demo on FHIR* / `mimic-profiles`.
  https://github.com/kind-lab/mimic-fhir, https://github.com/kind-lab/mimic-profiles
- HL7 FHIR R4 specification. https://hl7.org/fhir/R4/
- Glimm, Horrocks, Motik, Stoilos, Wang. *HermiT: An OWL 2 Reasoner.* J. Automated Reasoning, 2014.
- ONTODEV. *ROBOT.* https://robot.obolibrary.org/
