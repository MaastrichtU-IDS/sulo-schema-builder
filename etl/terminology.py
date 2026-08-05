"""Terminology crosswalk stubs — deliberately separate from the structural
(SULO-shape) mapping in mappings/*.yaml and transforms/*.py.

The structural mapping answers "does condition_concept_id attach to Condition
the same way ICD attaches to Condition.code" (a shape question, verified once
via the SULO alignment). This module answers "which code does concept 201826
actually mean" (a content question) — it needs a real vocabulary source
(OHDSI Athena's CONCEPT table, a SNOMED/ICD/LOINC/RxNorm mapping service),
which is out of scope for this scaffold. Everything here is a stand-in you
swap for a real lookup (a DB call, an OHDSI Vocabularies loader, a $translate
FHIR terminology operation, etc.) before using this in anger.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Coding:
    system: str
    code: str
    display: str | None = None


# A handful of concept_ids used by the fixtures/tests, standing in for a real
# OHDSI CONCEPT table lookup (concept_id -> vocabulary_id/concept_code/concept_name).
_DEMO_CONCEPT_TABLE: dict[int, Coding] = {
    201826: Coding("http://snomed.info/sct", "44054006", "Type 2 diabetes mellitus"),
    45581466: Coding("http://hl7.org/fhir/sid/icd-10-cm", "E11.9", "Type 2 diabetes mellitus without complications"),
    3004501: Coding("http://loinc.org", "2345-7", "Glucose [Mass/volume] in Serum or Plasma"),
    8840: Coding(f"https://w3id.org/sulo/schema/resource/CodeSystem/mimic-units", "mg/dL", "milligram per deciliter"),
    4171373: Coding("http://snomed.info/sct", "365858006", "Finding of hemoglobin A1c level"),
    4126681: Coding("http://snomed.info/sct", "165679005", "Hemoglobin A1c above reference range"),
    19078461: Coding("http://www.nlm.nih.gov/research/umls/rxnorm", "861007", "Metformin 500 MG Oral Tablet"),
    4132161: Coding("http://snomed.info/sct", "26643006", "Oral route"),
}


def lookup_concept(concept_id: int | None) -> Coding | None:
    """Stand-in for `SELECT vocabulary_id, concept_code, concept_name FROM concept WHERE concept_id = ?`."""
    if concept_id is None:
        return None
    try:
        return _DEMO_CONCEPT_TABLE[int(concept_id)]
    except (KeyError, ValueError, TypeError):
        return Coding(
            system="https://w3id.org/sulo/schema/resource/CodeSystem/omop-concept",
            code=str(concept_id),
            display=None,
        )


def reverse_lookup_concept_id(system: str, code: str) -> int | None:
    """Stand-in for the inverse OHDSI lookup, used by the fhir -> omop direction."""
    for concept_id, coding in _DEMO_CONCEPT_TABLE.items():
        if coding.system == system and coding.code == code:
            return concept_id
    return None


# Named registry so mappings/*.yaml can reference a lookup by name (`lookup: concept`)
# and the generic op-interpreter in transforms/ops.py never has to import a
# specific lookup function — the set of available lookups is data (this dict),
# not something the interpreter's code needs to know about.
LOOKUPS = {"concept": lookup_concept}
REVERSE_LOOKUPS = {"concept": reverse_lookup_concept_id}
