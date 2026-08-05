"""OMOP drug_exposure <-> FHIR MedicationAdministration.

Every field-level transform is declared in mappings/medication.yaml and
interpreted by transforms/ops.py's generic engine — there is no per-field
Python code here, just loading the YAML once and a thin id/resourceType/
defaults wrapper around apply_forward()/apply_reverse().
"""

from __future__ import annotations

import uuid
from typing import Any

import yaml

from .. import config
from .ops import apply_forward, apply_reverse

_MAPPING = yaml.safe_load((config.ETL_ROOT / "mappings" / "medication.yaml").read_text())
_OPS = _MAPPING["ops"]


def omop_to_fhir_medication(row: dict) -> dict[str, Any]:
    """drug_exposure row -> FHIR MedicationAdministration resource dict."""
    resource, notes = apply_forward(row, _OPS)
    resource["resourceType"] = "MedicationAdministration"
    resource.setdefault("id", str(uuid.uuid5(uuid.NAMESPACE_URL, f"drug-exposure-{row.get('drug_exposure_id')}")))
    resource["_etl_notes"] = notes
    return resource


def fhir_to_omop_medication(resource: dict) -> dict[str, Any]:
    """FHIR MedicationAdministration resource dict -> drug_exposure row."""
    defaults = {"drug_type_concept_id": config.DEFAULT_DRUG_TYPE_CONCEPT_ID}
    row, notes = apply_reverse(resource, _OPS, defaults=defaults)
    row["_etl_notes"] = notes
    return row
