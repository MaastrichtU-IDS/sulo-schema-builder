import json

from etl import config, validate
from etl.transforms.condition import fhir_to_omop_condition, omop_to_fhir_condition

FIXTURES = json.loads((config.ETL_ROOT / "fixtures" / "omop_condition_occurrence.json").read_text())


def test_omop_to_fhir_maps_the_matched_fields():
    resource = omop_to_fhir_condition(FIXTURES[0])

    assert resource["resourceType"] == "Condition"
    assert resource["subject"]["reference"] == "Patient/10001"
    assert resource["encounter"]["reference"] == "Encounter/500001"
    assert resource["recordedDate"] == "2023-05-01T08:00:00"
    assert resource["category"] == "encounter-diagnosis"

    codes = {c["system"]: c["code"] for c in resource["code"]["coding"]}
    assert codes["http://snomed.info/sct"] == "44054006"
    assert codes["http://hl7.org/fhir/sid/icd-10-cm"] == "E11.9"


def test_omop_to_fhir_falls_back_to_raw_source_code_without_a_vocabulary_hit():
    # fixture[1] has no condition_concept_id and no condition_source_concept_id —
    # only a bare condition_source_value. The transform must still preserve it.
    resource = omop_to_fhir_condition(FIXTURES[1])
    codes = {c["system"]: c["code"] for c in resource["code"]["coding"]}
    assert codes["http://hl7.org/fhir/sid/icd-10-cm"] == "J18.9"


def test_unmapped_fields_are_reported_not_silently_dropped():
    resource = omop_to_fhir_condition(FIXTURES[0])
    notes = " ".join(resource["_etl_notes"])
    assert "condition_type_concept_id" in notes
    assert "condition_status_concept_id" in notes


def test_round_trip_preserves_the_matched_fields():
    original = FIXTURES[0]
    resource = omop_to_fhir_condition(original)
    row_back = fhir_to_omop_condition(resource)

    assert row_back["person_id"] == original["person_id"]
    assert row_back["visit_occurrence_id"] == original["visit_occurrence_id"]
    assert row_back["condition_start_datetime"] == original["condition_start_datetime"]
    assert row_back["condition_concept_id"] == original["condition_concept_id"]
    assert row_back["condition_source_value"] == original["condition_source_value"]
    # OMOP-required, FHIR-absent field: must be filled with the configured default
    assert row_back["condition_type_concept_id"] == config.DEFAULT_CONDITION_TYPE_CONCEPT_ID


def test_lifted_rdf_conforms_to_the_real_mimic_fhir_shacl_shapes():
    resource = omop_to_fhir_condition(FIXTURES[0])
    graph = validate.lift_condition(resource)
    conforms, report = validate.validate_graph(graph)
    assert conforms, report
