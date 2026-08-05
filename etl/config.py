"""Shared constants for the OMOP <-> FHIR ETL scaffold.

The property/class IRIs below were pulled from the two live, HermiT-consistent
schemas in the running SULO Schema Builder app (MIMIC-IV FHIR Demo Schema and
the fixed OMOP CDM Schema) — see validate.py for how they're used to lift a
transformed FHIR resource dict into RDF and check it against the real SHACL
shapes exported from that schema, not a hand-maintained copy.
"""

from pathlib import Path

ETL_ROOT = Path(__file__).resolve().parent

SULO = "https://w3id.org/sulo/"
XSD = "http://www.w3.org/2001/XMLSchema#"

# Base namespace the schema builder mints class/property IRIs under for a given
# schema: {SCHEMA_BASE}/{ClassName} and {SCHEMA_BASE}/{propertyName}. This is
# what the exported OWL/SHACL Turtle actually uses (not the ontology-class/
# {uuid} IRIs found in the raw REST API JSON).
MIMIC_FHIR_SCHEMA_ID = "e63b6fa5-5617-47dc-839e-3ab68d0f2894"
MIMIC_FHIR_SCHEMA_BASE = (
    f"https://w3id.org/sulo/schema/resource/ontology-schema/{MIMIC_FHIR_SCHEMA_ID}/"
)

OMOP_SCHEMA_BASE_TEMPLATE = (
    "https://w3id.org/sulo/schema/resource/ontology-schema/{schema_id}/"
)

# OMOP CDM fields this ETL cannot derive from a FHIR MimicCondition/
# MimicObservation resource (see mappings/*.yaml "unmapped_source" entries with
# isRequired=true on the OMOP side). Used only by the fhir -> omop direction.
DEFAULT_CONDITION_TYPE_CONCEPT_ID = 32020  # "EHR problem list entry"
DEFAULT_OBSERVATION_TYPE_CONCEPT_ID = 32817  # "EHR"
DEFAULT_DRUG_TYPE_CONCEPT_ID = 38000175  # "Prescription written"

SHACL_SHAPES_PATH = ETL_ROOT / "shapes" / "mimic-fhir.shacl.ttl"
