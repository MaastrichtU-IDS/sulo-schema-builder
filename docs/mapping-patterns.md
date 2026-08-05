# Common mapping patterns

A **mapping pattern** writes a property as a triple template over `?this` (a
domain instance) and `?value` (a range instance); chain steps use `?o1`, `?o2`, …
On OWL export each pattern becomes a class restriction on the property's
**domain** — and, for object properties, a mirrored `owl:inverseOf` restriction
on the **range**, so both ends carry it. The unfolding rules:

- `?s P ?value` → `P some <range>`
- `?s P ?oN` → `P some (…?oN…)` (nested restriction)
- `?oN rdf:type C` → `C` added with `and`
- several triples off one subject → joined with `and`

Unfoldings below are shown in Manchester syntax for brevity; the exporter
(`frontend/src/lib/ontologyExport.ts`) writes the equivalent
`owl:Restriction` / `owl:someValuesFrom` Turtle. Patterns are drawn from the
**CHR** and **OMOP** examples and the
[MIE 2026 tutorial](https://github.com/MaastrichtU-IDS/sulo-tutorial). Only SULO
properties are used.

---

## 1. Direct relation

`?this P ?value` — a plain binary edge, no reification.

- **Unfolds to** `Domain and (P some Range)`
- **Examples** — CHR `hasStatus` (`hasFeature` → `:ProcessStatus`), `hasCareUnit`
  (`isIn`); OMOP `value_as_number` (`hasValue` → `xsd:float`), `unit_concept_id`
  (`hasPart` → `:Unit`)

> **Categorical vs. quantitative.** A `sulo:Quality` range (severity, grade,
> receptor status) models a *categorical* state — use `hasFeature`, declare the
> options disjoint, and never encode it as `hasValue = 0/1`. A measured
> *magnitude* uses Pattern 5 instead.

## 2. Role-mediated participation (PRO / n-ary)

```
?this hasParticipant ?o1 . ?o1 a :SubjectOfCareRole . ?o1 isFeatureOf ?value
```

Reifies "X participates in Y **as a** Z" through a `Role` node — the SULO form
of the W3C n-ary-relation pattern.

- **Unfolds to** `ClinicalVisit and (hasParticipant some (SubjectOfCareRole and (isFeatureOf some Person)))`
- **Examples** — CHR `hasPatient`, `hasPerformer`, `hasDevice`; OMOP
  `hasMeasurementResult` (via `:OutputRole`)

## 3. Reified / time-indexed value

```
?this atTime ?o1 . ?o1 a sulo:Time . ?o1 hasValue ?value
```

A value routed through its own typed carrier (a time instant, an endpoint).

- **Unfolds to** `MedicalProcedure and (atTime some (Time and (hasValue some xsd:dateTime)))`
- **Examples** — CHR `hasPerformedDate`, `hasConditionEndDate` (via `sulo:EndTime`);
  OMOP `measurement_datetime`

## 4. Reified value via an InformationObject carrier

```
?this hasFeature ?o1 . ?o1 a sulo:InformationObject . ?o1 hasValue ?value
```

A literal reached through an intermediate **`InformationObject`** carrier (a
code, an identifier, a coded value) rather than sitting directly on `?this`.
The carrier is a first-class node with its own type and identity, so it can
additionally hold a coding system, a label, etc. Same reification shape as
Pattern 3, but the carrier is a generic `InformationObject`/`Code`, not a
`sulo:Time`.

- **Unfolds to** `Domain and (hasFeature some (InformationObject and (hasValue some xsd:string)))`
- **Example** — `hasIdentifier`: a clinical entity's identifier routed through a
  `:Code`/`InformationObject` carrier that holds the string, rather than a bare
  direct `?this hasValue ?value` (Pattern 1)

## 5. Measurement quantity (`refersTo`)

A `Quantity` (an `InformationObject`) *records* a magnitude: it carries
`hasValue`, a `hasPart some Unit`, and `refersTo` the `Quality` it measures. The
quality is *attached* to its bearer (Pattern 1 with a `Quality` range). Slogan:
**"quality is attached, quantity is recorded."** Model the measurement class as
three properties:

| Property | Template |
|---|---|
| `measuresQuality` | `?this refersTo ?value` → a `sulo:Quality` |
| `hasUnit` | `?this hasPart ?value` → a `sulo:Unit` |
| `hasReading` | `?this hasValue ?value` → `xsd:int`/`xsd:float` |

- **Unfolds to** `BPMeasurement subClassOf (refersTo some SystolicBloodPressure), (hasPart some MmHgUnit), (hasValue some int)`

> **Not instantiated in CHR/OMOP.** OMOP's `:Measurement` gets closest but splits
> it across `value_as_number`, `unit_concept_id`, and `measurement_concept_id`,
> attaching the value straight to the `InformationObject` and never using
> `refersTo`.
>
> **Direction.** `refersTo` = Quantity → Quality; its inverse `isReferredToIn`
> = Quality → Quantity, if you need to traverse from the bearer to the value.
>
> **Unit alignment.** `sulo:Unit ⊑ sulo:Quantity`, and `Quality` /
> `InformationObject` are disjoint — map units to `Unit`/`Quantity`, not
> `Quality`. (CHR and OMOP currently mis-align `Unit` → `Quality`.)

**Categorical result — `hasQualitativeResult`.** When a result is categorical
(positive/negative, a grade) it is a `Quality`, reached by the *same* bridge:
`hasQualitativeResult` on `:Measurement`, `?this refersTo ?value` → a
`sulo:Quality` such as `:ReceptorStatus` (borne by the specimen via
`:Sample hasFeature :ReceptorStatus`). So the quantitative result uses
`hasValue`, the qualitative result uses `refersTo`. Contrast OMOP's
`value_as_concept_id`, which uses `hasFeature` (result as a feature *of the
info object*) rather than `refersTo` (measurement *about* a quality).

## Editor limitations

The per-property editor stops at `some`, so two tutorial constructs must be
hand-authored in the exported OWL:

1. **Constrained datatypes** — `hasValue some int[>= 140]` (no facet input).
2. **Class-level `and` / `or` defined classes** — `Tissue and (hasFeature some (TumourGrade2 or TumourGrade3))`.

Categorical qualities (Pattern 1 with a `Quality` range) are fully supported.
