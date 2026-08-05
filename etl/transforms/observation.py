"""OMOP measurement/observation <-> FHIR Observation (Lab/VitalSign profiles).

Every field-level transform is declared in mappings/observation.yaml and
interpreted by transforms/ops.py's generic engine — there is no per-field
Python code here, just loading the YAML once and a thin wrapper that supplies
the `table` context (which of the two differently-spelled OMOP tables a call
is for) plus id/resourceType/defaults plumbing.
"""

from __future__ import annotations

import uuid
from typing import Any, Literal

import yaml

from .. import config
from .ops import apply_forward, apply_reverse

_MAPPING = yaml.safe_load((config.ETL_ROOT / "mappings" / "observation.yaml").read_text())
_OPS = _MAPPING["ops"]

Table = Literal["measurement", "observation"]


def omop_to_fhir_observation(row: dict, source_id: int | str, table: Table = "measurement") -> dict[str, Any]:
    """measurement or observation row -> FHIR Observation resource dict.

    `table` picks which of the differently-spelled OMOP columns
    (measurement_concept_id vs observation_concept_id, etc.) to read — a real
    pipeline would know this from which query produced `row`, so it's an
    explicit parameter rather than sniffed from which columns are non-null
    (sniffing breaks silently on a row whose concept_id happens to be null).
    """
    resource, notes = apply_forward(row, _OPS, context={"table": table})
    resource["resourceType"] = "Observation"
    resource["status"] = "final"
    resource.setdefault("id", str(uuid.uuid5(uuid.NAMESPACE_URL, f"observation-{source_id}")))
    resource["_etl_notes"] = notes
    return resource


def fhir_to_omop_observation(resource: dict, table: Table = "measurement") -> dict[str, Any]:
    """FHIR Observation resource dict -> a measurement or observation row.

    `table` picks which OMOP table this resource is being written back to —
    it only affects the *_concept_id/*_datetime/*_type_concept_id column names
    that genuinely differ between the two tables; a real pipeline would infer
    it from resource.meta.profile or category, kept explicit here for clarity.
    """
    defaults = {f"{table}_type_concept_id": config.DEFAULT_OBSERVATION_TYPE_CONCEPT_ID}
    row, notes = apply_reverse(resource, _OPS, context={"table": table}, defaults=defaults)
    row["_etl_notes"] = notes
    return row
