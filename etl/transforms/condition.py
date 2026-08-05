"""OMOP condition_occurrence <-> FHIR Condition (MimicCondition profile).

Every field-level transform is declared in mappings/condition.yaml and
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

_MAPPING = yaml.safe_load((config.ETL_ROOT / "mappings" / "condition.yaml").read_text())
_OPS = _MAPPING["ops"]


def omop_to_fhir_condition(row: dict) -> dict[str, Any]:
    """condition_occurrence row -> FHIR Condition resource dict."""
    resource, notes = apply_forward(row, _OPS)
    resource["resourceType"] = "Condition"
    resource.setdefault("id", str(uuid.uuid5(uuid.NAMESPACE_URL, f"condition-occurrence-{row.get('condition_occurrence_id')}")))
    resource["_etl_notes"] = notes
    return resource


def fhir_to_omop_condition(resource: dict) -> dict[str, Any]:
    """FHIR Condition resource dict -> condition_occurrence row."""
    defaults = {"condition_type_concept_id": config.DEFAULT_CONDITION_TYPE_CONCEPT_ID}
    row, notes = apply_reverse(resource, _OPS, defaults=defaults)
    row["_etl_notes"] = notes
    return row
