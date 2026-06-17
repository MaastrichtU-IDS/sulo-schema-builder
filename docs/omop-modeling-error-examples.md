# Worked modelling-error examples from the OMOP schema

These extend the **Detecting modelling errors** section of `paper.md` (Examples 1–3) with further
examples drawn from the bundled **OMOP CDM Schema** example. Examples **4–8** are class-level
(TBox) errors; Examples **9–12** add synthetic data (ABox) and show the resulting inconsistency. They
follow the paper's format: a realistic mistake that arises when generating RDF for the OMOP tables, the
OWL it compiles to, and the contradiction a reasoner derives. Each is a *distinct* SULO mechanism, and
together they motivate full OWL DL reasoning over the OWL-RL subset and over SHACL.

A note on scope. The OMOP example contains **no individuals**, so every issue below is a *class
satisfiability* problem: the offending property compiles to a domain/range class that can have no
members. Detecting that before any data exists is what a DL satisfiability reasoner (HermiT, now the
tool's server-side check) does directly. Examples 4–6 reduce — once SULO's domain/range axioms fire —
to the same disjoint-category membership as paper Examples 1–3; Examples 7–8 additionally require
reasoning **inside** SULO's `owl:allValuesFrom` restriction bodies. None of these are caught by
lightweight named-class reasoning (RDFS / OWL-RL over named classes), which only inspects named-class
`subClassOf`/disjointness and ignores property domains, ranges, and restriction bodies; and none are
caught by SHACL, which validates asserted data rather than checking class satisfiability. Only the
tool's full OWL DL consistency check (HermiT) surfaces them. (These particular errors do not exercise
SULO's genuinely tableau-only constructs — disjoint-union *covering*, existential witnesses, full
`complementOf` — but SULO contains those too, and the server check covers them.)

Prefixes: `omop:` for the schema's classes/properties, `ex:` for instances, `sulo:` for SULO.

## Shared machinery

When a property carries a mapping pattern, `generateExports` does not emit a plain
`rdfs:domain`/`rdfs:range`. It mints an anonymous class for the domain (and, for object properties,
for the range) and defines it with `owl:equivalentClass`:

```turtle
omop:days_supply rdfs:domain <uuid-d> .
<uuid-d> owl:equivalentClass [ owl:intersectionOf ( omop:DrugExposure
            [ a owl:Restriction ; owl:onProperty sulo:hasValue ; owl:someValuesFrom xsd:integer ] ) ] .
```

So "is this property usable?" becomes "is `<uuid-d>` satisfiable?" — a pure **TBox class-satisfiability**
question, decided with no individuals. That is why the reasoner reports *unsatisfiable classes* (the
`<uuid>` ones) while the named OMOP classes stay satisfiable and the schema is globally *consistent*.
An object property yields two such classes (domain + reverse-range); a datatype property yields one
(domain only) — hence `19 object × 2 + 6 datatype × 1 = 44` unsatisfiable classes across 25 properties.

The taxonomy that does the work: `InformationObject ⊑ Feature ⊑ Object`, `Quantity ⊑ InformationObject`,
`Quality ⊑ Feature`, `SpatialObject ⊑ Object`. The three disjointness facts that ultimately fire:
`Object owl:disjointWith Process`; `Feature owl:disjointWith SpatialObject`; and the `Feature` disjoint
union `{Capability, InformationObject, Quality, Role}`.

Each example below is structured: **Intent → Compiles to → SULO axioms → Inference chain → What HermiT
reports → Why lighter checks miss it → Fix.**

---

## Example 4 — attaching a literal value directly to a process

A common shortcut when flattening the OMOP `DRUG_EXPOSURE` table to RDF is to hang each scalar column
straight on the drug-exposure event:

```turtle
ex:drug_exposure_42
  a omop:DrugExposure ;
  omop:days_supply "30"^^xsd:integer .
```

- **Intent.** `DRUG_EXPOSURE.days_supply`, an integer column on the event.
- **Compiles to.** Pattern `?this sulo:hasValue ?value` (datatype, range `xsd:integer`) → one domain
  class `C ≡ DrugExposure ⊓ ∃hasValue.xsd:integer`.
- **SULO axioms.** `sulo:hasValue rdfs:domain sulo:InformationObject`; `DrugExposure ⊑ sulo:Process`
  (the alignment); `InformationObject ⊑ Feature ⊑ Object`; `Object ⊥ Process`.
- **Inference chain.** For a hypothetical `x ∈ C`:
  1. `x` is a `DrugExposure`, hence a `Process`.
  2. `x` has a `hasValue` edge (the `∃hasValue.xsd:integer` conjunct).
  3. `hasValue`'s domain is `InformationObject`, so `x` is an `InformationObject` (`⊑ Object`).
  4. `x` is then both `Process` and `Object`, which are disjoint → no such `x` exists; `C` is
     unsatisfiable.
- **What HermiT reports.** An unsatisfiable domain class whose explanation cites the `hasValue` domain,
  `DrugExposure ⊑ process`, and `object DisjointWith process`.
- **Why lighter checks miss it.** SHACL has no offending individual to validate; named-class reasoning
  never inspects `hasValue`'s domain — `DrugExposure` is, by its named axioms, simply a `Process`.
- **Fix.** Route the literal through an `InformationObject` carrier, exactly as the (already-correct)
  `*_datetime` columns do:
  ```turtle
  ?this sulo:hasFeature [ a sulo:Quantity ; sulo:hasValue ?value ] .
  ```
  `hasValue` now sits on the `Quantity` (`⊑ InformationObject` ✓), and `DrugExposure sulo:hasFeature
  Quantity` is coherent (`hasFeature` domain `Object ⊔ Process`, range `Feature`; `Quantity ⊑ Feature`).

## Example 5 — a process that "refers to" a concept

Linking a clinical event to its vocabulary concept via the wrong relation:

```turtle
ex:drug_exposure_42
  a omop:DrugExposure ;
  omop:drug_concept_id <http://purl.bioontology.org/ontology/RXNORM/1191> .
```

- **Intent.** `DRUG_EXPOSURE.drug_concept_id`, the standard (RxNorm) drug concept.
- **Compiles to.** Pattern `?this sulo:refersTo ?value` (object, range `Concept`) → two classes:
  domain `Cd ≡ DrugExposure ⊓ ∃refersTo.Concept` and range `Cr ≡ Concept ⊓ ∃inverse(refersTo).DrugExposure`.
- **SULO axioms.** `sulo:refersTo rdfs:domain sulo:InformationObject` (range `owl:Thing`);
  `DrugExposure ⊑ Process`; `Object ⊥ Process`.
- **Inference chain.** Domain: `x ∈ Cd` → `x refersTo` something ⇒ `x` is an `InformationObject`
  (`⊑ Object`); but `x ⊑ DrugExposure ⊑ Process` ⇒ `Process ∧ Object` ⇒ ⊥. Range: `Cr` requires the
  existence of a `DrugExposure` that `refersTo` the concept, and that `DrugExposure` would itself have
  to be an `InformationObject` — the same contradiction — so `Cr` is unsatisfiable too.
- **What HermiT reports.** Explanation cites `refers to Domain information object`, `<table> SubClassOf
  process`, `object DisjointWith process`.
- **Why lighter checks miss it.** As in Example 4, only `refersTo`'s domain creates the clash, and
  named-class reasoning ignores property domains.
- **Fix.** Use `sulo:hasFeature` — exactly what every *other* `*_concept_id`/`*_type_concept_id` column
  already does. `DrugExposure hasFeature Concept`: domain `Object ⊔ Process` (Process ✓), range `Feature`
  (`Concept ⊑ InformationObject ⊑ Feature` ✓). `drug_concept_id` is the lone sibling using `refersTo` —
  almost certainly an oversight. Conceptually it isolates *referent* (the process in reality) from
  *representation* (a statement about it): only the latter may `refersTo`.

## Example 6 — conflating a result with the process that produced it

OMOP records a `MEASUREMENT` as a result row, aligned to `sulo:InformationObject`. Giving that result a
patient via the participant pattern:

```turtle
ex:measurement_7
  a omop:Measurement ;
  omop:person_id ex:patient_3 .
```

- **Intent.** `MEASUREMENT.person_id`, the patient the measurement is about.
- **Compiles to.** Role pattern `?this hasParticipant [ a omop:PatientRole ; sulo:isFeatureOf ?value ]`
  (object, range `Person`) → domain `Cd ≡ Measurement ⊓ ∃hasParticipant.(PatientRole ⊓ ∃isFeatureOf.Person)`
  plus the reverse-range class.
- **SULO axioms.** `sulo:hasParticipant rdfs:domain sulo:Process` (and `owl:inverseOf isParticipantIn`,
  whose `rdfs:range` is `Process`); `Measurement ⊑ InformationObject ⊑ Feature ⊑ Object`; `Object ⊥ Process`.
- **Inference chain.** `x ∈ Cd` → `x hasParticipant …` ⇒ `x` is a `Process` (domain of `hasParticipant`);
  but `x ⊑ Measurement ⊑ Object` ⇒ `Process ∧ Object` ⇒ ⊥. (HermiT actually routes this through the
  inverse: `hasParticipant InverseOf isParticipantIn`, `isParticipantIn Range process` — same conclusion.)
- **What HermiT reports.** Unsatisfiable class citing `is participant in Range process`, `Measurement
  SubClassOf information object`, `information object ⊑ feature ⊑ object`, `object DisjointWith process`.
- **The conceptual error.** It conflates the **measuring process** (which legitimately has the patient as
  a participant) with the **measurement result** (an information object that merely records it). The same
  mistake recurs in `hasMeasurementResult` on Measurement (via `OutputRole`) and `person_id` on
  Observation/Specimen.
- **Fix.** Either attach the patient to the underlying clinical **Process**, or say the result
  **`refersTo`** the patient (`Measurement refersTo Person` is coherent — `refersTo` domain
  `InformationObject` ✓, range `owl:Thing` ✓). For `hasMeasurementResult` specifically, use `sulo:hasPart`:
  `Measurement` and `MeasurementValue` are both `InformationObject`s, satisfying `InformationObject ⊑
  ∀hasPart.InformationObject`.

## Example 7 — a part drawn from the wrong category

Modelling a drug dose as a structural part of the drug-exposure event:

```turtle
ex:drug_exposure_42
  a omop:DrugExposure ;
  sulo:hasPart ex:dose_5 .
ex:dose_5 a omop:DoseQuantity .
```

- **Intent.** Represent the dose (`hasDoseQuantity`) as part of the exposure.
- **Compiles to.** Pattern `?this sulo:hasPart ?value` (object, range `DoseQuantity`) → domain
  `Cd ≡ DrugExposure ⊓ ∃hasPart.DoseQuantity` (+ the reverse-range class).
- **SULO axioms.** `sulo:Process ⊑ ∀sulo:hasPart.Process` (an `owl:allValuesFrom` restriction — "every
  part of a process is a process"); `DrugExposure ⊑ Process`; `DoseQuantity ⊑ Quantity ⊑ InformationObject
  ⊑ Object`; `Object ⊥ Process`.
- **Inference chain.** `x ∈ Cd`:
  1. `x ⊑ DrugExposure ⊑ Process`, so `x ⊑ ∀hasPart.Process`.
  2. `x` has a `hasPart` witness `d` (the `∃hasPart.DoseQuantity` conjunct), a `DoseQuantity`.
  3. The universal restriction propagates the type onto the filler: `d` must be a `Process`.
  4. But `d ⊑ DoseQuantity ⊑ … ⊑ Object`, so `d` is `Process ∧ Object` ⇒ ⊥; `Cd` is unsatisfiable.
- **What HermiT reports.** `Drug Exposure SubClassOf process` → `process SubClassOf has part only process`;
  `Dose Quantity SubClassOf quantity` → `quantity SubClassOf information object`; `feature SubClassOf
  object`; `object DisjointWith process`.
- **Why lighter checks miss it.** Step 3 requires reasoning *inside* the `owl:allValuesFrom` restriction
  body — not just named-class subsumption. SHACL and named-class reasoning both miss it; the server
  DL check finds it.
- **Fix.** A dose is a quantitative **feature**, not a temporal part of the process:
  `DrugExposure hasFeature DoseQuantity` (`DoseQuantity ⊑ Feature` ✓, and `hasFeature` carries no
  per-category `∀` constraint), or attach the dose `Quantity` to a participating drug product.

## Example 8 — treating an information record as a temporal part of a process

Linking an `OBSERVATION` row to the visit it was recorded in via parthood:

```turtle
ex:observation_9
  a omop:Observation ;
  sulo:isPartOf ex:visit_2 .
ex:visit_2 a omop:VisitOccurrence .
```

- **Intent.** `OBSERVATION.visit_occurrence_id`, the visit the observation belongs to. Observation is
  aligned to `sulo:InformationObject`.
- **Compiles to.** Pattern `?this sulo:isPartOf ?value` (object, range `VisitOccurrence`) → domain
  `Cd ≡ Observation ⊓ ∃isPartOf.VisitOccurrence` and reverse-range `Cr ≡ VisitOccurrence ⊓
  ∃hasPart.Observation` (since `hasPart owl:inverseOf isPartOf`).
- **SULO axioms.** `hasPart owl:inverseOf isPartOf`; `VisitOccurrence ⊑ Process ⊑ ∀hasPart.Process`;
  `Observation ⊑ InformationObject ⊑ Object`; `Object ⊥ Process`.
- **Inference chain.** Clearest via `Cr`: a member is a `VisitOccurrence` (`⊑ Process ⊑ ∀hasPart.Process`)
  that `hasPart` an `Observation`; the universal forces that part to be a `Process`; but `Observation ⊑
  Object` ⇒ `Process ∧ Object` ⇒ ⊥. The domain class `Cd` fails for the inverse-direction reason
  (`isPartOf` a visit means the visit `hasPart` it).
- **What HermiT reports.** Unsatisfiable class citing `Process SubClassOf has part only process`,
  `Observation ⊑ information object ⊑ object`, `object DisjointWith process`.
- **Contrast.** The *same* `visit_occurrence_id` column on the **Process** tables
  (Condition/Drug/Procedure/Device Occurrence) is **fine** — both ends are Processes, so `Process hasPart
  Process` satisfies `∀hasPart.Process`. Only the InformationObject-typed tables (Measurement, Observation)
  clash. This is the part-of analogue of the paper's Example 3 use–mention confusion: an observation
  *record* is not a temporal part of the encounter it documents.
- **Fix.** Use the unconstrained `sulo:isIn` (transitive, no domain/range restriction) —
  `Observation isIn VisitOccurrence` — exactly as `care_site_id`/`location_id` already do; or attribute
  the record to the clinical process occurring within the visit.

---

## Why these matter for the tool

The detection layers, weakest to strongest on these errors:

- **SHACL** validates asserted data against shapes; with no offending individuals it reports nothing.
- **Lightweight named-class reasoning** (RDFS / OWL-RL over named classes) flags a named class that is a
  `subClassOf` two disjoint categories — paper Examples 1–3 — but ignores property domains/ranges and
  restriction bodies, so it misses all of Examples 4–8.
- **An OWL-RL rule engine** would derive the contradictions of Examples 4–8 *if the schema were
  instantiated*, via property-domain/range and `allValuesFrom` rules plus disjointness.
- **The tool's full OWL DL check (HermiT)** detects them at the **schema level, before any data exists**,
  by finding that each offending property's domain/range class is *unsatisfiable* — i.e. the property
  can never be populated without contradiction. This is the value the OMOP example demonstrates: the
  schema is globally *consistent*, yet 25 property mappings are quietly incoherent against SULO, and only
  the class-satisfiability check surfaces them.

### The throughline

Examples 4, 5, 6 reduce — once SULO's **property-domain/range** axioms fire — to a `Process`/`Object`
(or `Feature`/`SpatialObject`, or cross-`Feature`-subcategory) disjointness, the same shape as paper
Examples 1–3. Examples 7 and 8 add one step: propagation through a `∀hasPart` **restriction body**. All
five are class-satisfiability problems with zero individuals, so only the server DL check surfaces them
at design time. Examples 9–12 below show what happens once data is added.

---

## Examples with data (ABox)

Examples 4–8 are *class-satisfiability* problems: the offending property's domain/range class is
unsatisfiable, but with no individuals the schema as a whole is still *consistent*. The examples here
add a small synthetic ABox and run a HermiT consistency check (verdicts confirmed with `robot reason`
on a materialised SULO + OMOP-OWL + ABox merge). The lesson: **one ordinary-looking triple flips the
incoherent-but-consistent schema into an outright inconsistent graph** — and SHACL validates every one
of these datasets without complaint.

**Example 9 — one innocuous triple makes the whole graph inconsistent.** A single drug-exposure row with
a `days_supply` value:

```turtle
ex:drug_exposure_42
  a omop:DrugExposure ;
  omop:days_supply "30"^^xsd:integer .
```

- **Compiles against.** `omop:days_supply rdfs:domain (DrugExposure ⊓ ∃hasValue.xsd:integer)` — the
  unsatisfiable class from Example 4.
- **Inference chain.** The `rdfs:domain` axiom types `ex:drug_exposure_42` into that class. Membership
  forces it to be a `DrugExposure` (`⊑ Process`) **and** to carry a `sulo:hasValue` (`⇒ InformationObject
  ⊑ Object`). `Object ⊥ Process`, so the individual belongs to `owl:Nothing` — the **ontology is
  inconsistent** (it has no model at all, not merely an empty class).
- **What HermiT reports.** `Thing SubClassOf Nothing`, citing `has value Domain information object`,
  `DrugExposure SubClassOf process`, and `object DisjointWith process`, with `ex:drug_exposure_42` as the
  offending individual.
- **Contrast.** SHACL sees a `DrugExposure` with an integer `days_supply` and reports a valid graph.

**Example 10 — property-name reuse forces one value to be two datatypes.** A single measurement result:

```turtle
ex:measurement_7
  a omop:Measurement ;
  omop:value_as_number "5.4"^^xsd:float .
```

- **The defect.** `value_as_number` is reused across tables: declared with range `xsd:float` on
  `Measurement` and `xsd:decimal` on `Observation`. The generated OWL puts **both** `rdfs:range` axioms on
  the single property IRI, so its effective range is `xsd:float ⊓ xsd:decimal`, and both domain classes
  (`Measurement ⊓ ∃hasValue.float`, `Observation ⊓ ∃hasValue.decimal`) attach to it.
- **Inference chain.** `sulo:hasValue` is an `owl:FunctionalProperty`, so `ex:measurement_7` has exactly
  one value. Through the reused property, that one value must be simultaneously an `xsd:float` and an
  `xsd:decimal` — disjoint datatypes — so no model exists: **inconsistent**.
- **What HermiT reports.** `Thing SubClassOf Nothing`, citing both `value_as_number Domain …` axioms,
  `Functional: has value`, and `value_as_number Range: decimal` against the asserted `5.4f`.
- **Why this is distinct.** Unlike 4–9 this is *not* a SULO category clash; it is the property-name-reuse
  defect (category F in the consistency-issues catalogue). A property can be categorically correct yet
  still broken by reuse.

**Example 11 — a realistic record set, all at once.** Assembling a normal-looking slice of an OMOP export:

```turtle
ex:visit_2   a omop:VisitOccurrence ; omop:person_id ex:patient_3 ; omop:visit_concept_id ex:c_amb .
ex:drug_42   a omop:DrugExposure   ; omop:days_supply "30"^^xsd:integer ; omop:drug_concept_id ex:rx_1191 .
ex:patient_3 a omop:Person . ex:c_amb a omop:Concept . ex:rx_1191 a omop:Concept .
```

This dataset is **inconsistent** — it contains several independent contradictions at once (`days_supply`
and `drug_concept_id` on a Process per Examples 9/5, plus `person_id` which is unusable everywhere because
its reused domains intersect to an empty class per Example 10's mechanism). A reasoner needs only one to
declare the graph unsatisfiable; ROBOT/HermiT reports `Thing SubClassOf Nothing`. The practical point for
a data-generation pipeline: emitting RDF from OMOP through these mappings yields a graph no OWL reasoner
will accept, even though every triple looks individually reasonable and SHACL passes it.

**Example 12 — the coherent subset reasons cleanly (the contrast).** Restricting to the
uniquely-named, category-correct properties:

```turtle
ex:visit_2 a omop:VisitOccurrence ;
  omop:visit_concept_id ex:c_amb ;
  omop:visit_start_datetime "2021-06-15T10:00:00"^^xsd:dateTime .
ex:meas_7 a omop:Measurement ;
  omop:measurement_concept_id ex:c_gluc ;
  omop:measurement_datetime "2021-06-15T10:15:00"^^xsd:dateTime .
ex:c_amb a omop:Concept ; omop:concept_id "9201"^^xsd:integer .
ex:c_gluc a omop:Concept ; omop:concept_id "3004501"^^xsd:integer .
```

HermiT finds this graph **consistent** (the schema's unsatisfiable classes simply stay empty), and it
*entails* the expected SULO supertypes — e.g. `ex:visit_2 a sulo:Process` and `ex:meas_7 a
sulo:InformationObject` — by subsumption through the alignments. This confirms the inconsistencies above
are localised to the broken mappings, not the schema as a whole: the same SULO discipline that rejects
the bad data validates the good data and enriches it with inferred upper-level types.
