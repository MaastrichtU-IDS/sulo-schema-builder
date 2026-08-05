import json

from etl import config, validate
from etl.transforms.medication import fhir_to_omop_medication, omop_to_fhir_medication

FIXTURES = json.loads((config.ETL_ROOT / "fixtures" / "omop_drug_exposure.json").read_text())


def test_omop_to_fhir_maps_the_matched_fields():
    resource = omop_to_fhir_medication(FIXTURES[0])

    assert resource["resourceType"] == "MedicationAdministration"
    assert resource["subject"]["reference"] == "Patient/10001"
    assert resource["context"]["reference"] == "Encounter/500001"
    assert resource["medicationCodeableConcept"]["coding"][0]["system"] == "http://www.nlm.nih.gov/research/umls/rxnorm"
    assert resource["effectivePeriod"]["start"] == "2023-05-02T08:00:00"
    assert resource["effectivePeriod"]["end"] == "2023-05-02T08:05:00"
    assert resource["dosage"]["route"]["coding"][0]["code"] == "26643006"
    assert resource["status"] == "completed"


def test_effective_period_uses_both_start_and_end_not_just_one():
    # the auto-generated draft arbitrarily picked end_datetime for a single
    # hasEventDate field and dropped start_datetime; the hand-finished mapping
    # uses both via effectivePeriod instead of losing one.
    resource = omop_to_fhir_medication(FIXTURES[0])
    original = FIXTURES[0]
    assert resource["effectivePeriod"]["start"] == original["drug_exposure_start_datetime"]
    assert resource["effectivePeriod"]["end"] == original["drug_exposure_end_datetime"]


def test_missing_drug_and_route_leave_no_stray_fields():
    resource = omop_to_fhir_medication(FIXTURES[1])
    assert "medicationCodeableConcept" not in resource
    assert "dosage" not in resource
    assert "end" not in resource.get("effectivePeriod", {})


def test_provider_id_is_dropped_not_falsely_merged_into_patient():
    # regression check for the false match the generator made (provider_id
    # sharing hasPatient's generalized Role shape) — provider_id must not leak
    # into subject, and must be logged as dropped.
    resource = omop_to_fhir_medication(FIXTURES[0])
    assert resource["subject"]["reference"] == "Patient/10001"  # not 20001 (provider_id)
    notes = " ".join(resource["_etl_notes"])
    assert "provider_id" in notes


def test_unmapped_fields_reported():
    resource = omop_to_fhir_medication(FIXTURES[0])
    notes = " ".join(resource["_etl_notes"])
    assert "drug_type_concept_id" in notes


def test_round_trip_preserves_the_matched_fields():
    original = FIXTURES[0]
    resource = omop_to_fhir_medication(original)
    row_back = fhir_to_omop_medication(resource)

    assert row_back["person_id"] == original["person_id"]
    assert row_back["visit_occurrence_id"] == original["visit_occurrence_id"]
    assert row_back["drug_exposure_start_datetime"] == original["drug_exposure_start_datetime"]
    assert row_back["drug_exposure_end_datetime"] == original["drug_exposure_end_datetime"]
    assert row_back["drug_concept_id"] == original["drug_concept_id"]
    assert "provider_id" not in row_back  # dropped, never round-trips
    assert row_back["drug_type_concept_id"] == config.DEFAULT_DRUG_TYPE_CONCEPT_ID


def test_lifted_rdf_conforms_to_the_real_mimic_fhir_shacl_shapes():
    resource = omop_to_fhir_medication(FIXTURES[0])
    graph = validate.lift_medication(resource)
    conforms, report = validate.validate_graph(graph)
    assert conforms, report
