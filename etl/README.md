# OMOP ⇄ FHIR ETL scaffold

A starter transform layer between OMOP CDM (`condition_occurrence`,
`measurement`, `observation`, `drug_exposure`) and FHIR (`Condition`,
`Observation`, `MedicationAdministration` —
MimicCondition/MimicObservationLabevents/MimicObservationChartevents
profiles), driven by the field-level crosswalk validated earlier via the SULO
Schema Builder: both the "OMOP CDM Schema" and "MIMIC-IV FHIR Demo Schema"
examples in the app are HermiT-consistent, and 20 of their property shapes are
structurally identical (see the OMOP↔MIMIC-FHIR comparison in the app/chat
history) — those 20 shapes are exactly what `mappings/*.yaml` encodes.

**Every field-level transform is declarative.** There is no per-field Python
function anywhere in this package, not even for the composite cases (a coded
value split across two OMOP columns, a value that branches into
valueQuantity/valueCodeableConcept/valueString, a unit merged onto a sibling
field, two columns folded into one FHIR Range). `transforms/ops.py` is a small,
fixed interpreter for 7 generic `op`s; `condition.py`/`observation.py` just
load a YAML file and call it. Adding or changing a mapping means editing YAML,
never writing Python.

## Scope

**Implemented:** Condition, Observation (both `measurement`- and
`observation`-table sourced), Medication (`drug_exposure` ⇄
`MedicationAdministration`), both directions (`omop_to_fhir_*` /
`fhir_to_omop_*`), a fully declarative op-interpreter, and a validator that
lifts a transformed resource into RDF and checks it against the *real* SHACL
shapes exported from the app.

`mappings/medication.yaml` started as an auto-generated draft (see
`generate-mapping.mjs`, shape-matching `DrugExposure`/`DrugProduct`/
`DoseQuantity` against the MIMIC Medication classes) and was then
hand-finished — three decisions the generator correctly could not make from
SULO shapes alone are documented at the top of that file: which of
MedicationRequest/Administration/Dispense to target (Administration —
OMOP's single-row model has no request/dispense split), an over-generalized
false match (`provider_id` sharing `hasPatient`'s shape once `Role` collapses
Patient/Provider together — dropped, not merged), and `medicationCodeableConcept`
vs `medicationReference` (OMOP has no separate product row to reference, so
the code is inlined instead). The generator also picked one of two
same-shaped date columns arbitrarily (and picked wrong); the hand-finished
version uses both via `effectivePeriod` instead of dropping either.

**Not yet done (natural next steps, not started):**
- Real FHIR resource validation (this scaffold produces "close enough" FHIR
  JSON to demonstrate the field logic — e.g. `category` is a bare string
  instead of a `CodeableConcept` array — swap in the `fhir.resources` Python
  package if you need actual FHIR-conformant output).
- Terminology (`terminology.py` is a 6-row stub — plug in a real OHDSI
  Vocabularies lookup or a FHIR `$translate` call).
- A real loader (writes to a FHIR server / OMOP Postgres) — the CLI only
  prints the transformed dicts.
- `qualifier_concept_id` (observation table) is tracked as a `drop_source` but
  not actually mapped to anything on the FHIR side yet.

## Layout

```
etl/
  config.py           schema IDs/IRIs, OMOP-required-field defaults
  terminology.py       concept_id <-> coding lookups (STUB — see docstring)
                        + LOOKUPS/REVERSE_LOOKUPS name registries ops.py dispatches through
  mappings/
    condition.yaml      field crosswalk as declarative ops + SULO-shape citation
    observation.yaml    field crosswalk as declarative ops + SULO-shape citation
    medication.yaml     field crosswalk as declarative ops; started auto-generated, hand-finished (see file header)
  transforms/
    ops.py               the ONLY engine code — interprets the 7 op kinds, forward and reverse
    condition.py         loads condition.yaml, thin id/resourceType wrapper — no transform logic
    observation.py       loads observation.yaml, thin table-context wrapper — no transform logic
    medication.py        loads medication.yaml, thin id/resourceType wrapper — no transform logic
  validate.py           lift a FHIR resource dict -> RDF -> SHACL-validate
  shapes/
    mimic-fhir.shacl.ttl   static export from the live MIMIC-FHIR schema
  fixtures/             sample OMOP rows used by the tests
  tests/                pytest — forward, reverse/round-trip, SHACL checks
  cli.py                `python -m etl.cli condition omop2fhir <file.json>`
```

## The op vocabulary

Every entry in `mappings/*.yaml` is `{op: <kind>, ...params, sulo_shape, notes}`.
`transforms/ops.py`'s `apply_forward()`/`apply_reverse()` interpret all of them,
both directions, from the same YAML:

| op | forward | reverse |
|---|---|---|
| `copy` | copy the OMOP value to a FHIR path as-is | copy back |
| `reference` | wrap as `{"reference": "<prefix><value>"}` | unwrap, strip prefix, cast to int if numeric |
| `const` | write a fixed value | no-op (nothing to pull back) |
| `drop_source` | OMOP-only field — log it as dropped | if a caller-supplied default exists for this column, write it and log a "defaulted" note |
| `drop_target` | FHIR-only field — log it as left absent | no-op |
| `coding_list` | compose N `{concept_from, code_from, default_system}` items into one `{"coding":[...]}` array, each item optionally resolved via a named `lookup` | split the coding array back across the same items using `match_system` (or a catch-all item with none) to decide which array entry belongs to which item |
| `value_branch` | try `cases` in order, first OMOP column that's non-null picks the FHIR target and shape (`quantity`/`coding`/`literal`); an optional `merge_when_quantity` folds a sibling field (e.g. unit) onto whichever case fired | check the same `cases` in order for whichever FHIR target is present, invert it back to the OMOP column named in `when` |
| `range` | fold two OMOP columns into one FHIR structure — `[{low, high}]` by default, or a plain `{start, end}` object (`as_list: false`) with unwrapped values (`wrap_value: false`) and custom key names (`low_key`/`high_key`) for something like `effectivePeriod` | split it back into the two columns, honoring the same `as_list`/`wrap_value`/`low_key`/`high_key` |

Columns spelled differently across OMOP tables (`measurement_concept_id` vs
`observation_concept_id`) use a `"{table}_concept_id"` placeholder, resolved
against the `context={"table": ...}` passed to `omop_to_fhir_observation()`/
`fhir_to_omop_observation()` — that's the whole mechanism for driving both
OMOP tables from one YAML file, no OR-lists of hardcoded names.

The only escape hatch is a **named, registered value lookup**
(`terminology.LOOKUPS = {"concept": lookup_concept}`), referenced from YAML as
`lookup: concept` — `ops.py` never imports a specific lookup function, so
swapping in a real OHDSI vocabulary lookup means adding an entry to that dict,
not touching the interpreter.

Each entry's `sulo_shape` is a real, checked claim (not a name-based guess):
both the OMOP CDM Schema and MIMIC-IV FHIR Demo Schema export as
HermiT-consistent OWL, and the cited shape appears verbatim on both sides.
Where no matching shape exists on one side, `drop_source`/`drop_target` record
that too, so gaps are visible in `resource["_etl_notes"]` instead of silently
dropped — this is what caught the `qualifier_concept_id` gap (a column that
wasn't even in the YAML, so it wasn't logged either) during a round-trip
fidelity check.

## Running it

```bash
cd sulo-schema-builder
python3 -m venv .venv && source .venv/bin/activate
pip install -r etl/requirements.txt

python -m pytest etl/tests -v

python -m etl.cli condition omop2fhir etl/fixtures/omop_condition_occurrence.json --validate
python -m etl.cli observation omop2fhir etl/fixtures/omop_measurement.json --table measurement --validate
python -m etl.cli observation omop2fhir etl/fixtures/omop_observation.json --table observation --validate
python -m etl.cli medication omop2fhir etl/fixtures/omop_drug_exposure.json --validate
```

## Regenerating `shapes/mimic-fhir.shacl.ttl`

If you edit the "MIMIC-IV FHIR Demo Schema" in the app, re-export the SHACL
shapes so `validate.py` checks against the current schema, not a stale copy:

```bash
# from a scratch dir with the schema-builder's ontologyExport.ts reachable
npx tsx export-and-check.mts <mimic-fhir-schema-id> mimic-final
cp /tmp/mimic-final.shacl.ttl sulo-schema-builder/etl/shapes/mimic-fhir.shacl.ttl
```
