import json

from etl import config, validate
from etl.transforms.observation import fhir_to_omop_observation, omop_to_fhir_observation

MEASUREMENTS = json.loads((config.ETL_ROOT / "fixtures" / "omop_measurement.json").read_text())
OBSERVATIONS = json.loads((config.ETL_ROOT / "fixtures" / "omop_observation.json").read_text())


def test_measurement_with_numeric_value_and_unit():
    row = MEASUREMENTS[0]  # glucose, 142.0 mg/dL, range 70-100
    resource = omop_to_fhir_observation(row, row["measurement_id"])

    assert resource["subject"]["reference"] == "Patient/10001"
    assert resource["encounter"]["reference"] == "Encounter/500001"
    assert resource["code"]["coding"][0]["system"] == "http://loinc.org"
    assert resource["effectiveDateTime"] == "2023-05-01T09:15:00"
    assert resource["valueQuantity"]["value"] == 142.0
    assert resource["valueQuantity"]["unit"] == "milligram per deciliter"
    assert resource["referenceRange"][0]["low"]["value"] == 70.0
    assert resource["referenceRange"][0]["high"]["value"] == 100.0


def test_measurement_with_coded_value_and_no_numeric_result():
    row = MEASUREMENTS[1]  # HbA1c finding, coded result, no numeric value/unit/range
    resource = omop_to_fhir_observation(row, row["measurement_id"])

    assert "valueQuantity" not in resource
    assert resource["valueCodeableConcept"]["coding"][0]["code"] == "165679005"
    assert "referenceRange" not in resource


def test_observation_table_row_with_string_value():
    row = OBSERVATIONS[0]
    resource = omop_to_fhir_observation(row, row["observation_id"], table="observation")

    assert resource["subject"]["reference"] == "Patient/10002"
    assert resource["valueString"] == "Patient reports occasional shortness of breath on exertion."
    assert "valueQuantity" not in resource


def test_unmapped_fields_reported():
    resource = omop_to_fhir_observation(MEASUREMENTS[0], MEASUREMENTS[0]["measurement_id"])
    notes = " ".join(resource["_etl_notes"])
    assert "measurement_type_concept_id" in notes or "observation_type_concept_id" in notes


def test_round_trip_numeric_measurement():
    original = MEASUREMENTS[0]
    resource = omop_to_fhir_observation(original, original["measurement_id"])
    row_back = fhir_to_omop_observation(resource, table="measurement")

    assert row_back["person_id"] == original["person_id"]
    assert row_back["visit_occurrence_id"] == original["visit_occurrence_id"]
    assert row_back["measurement_datetime"] == original["measurement_datetime"]
    assert row_back["value_as_number"] == original["value_as_number"]
    assert row_back["measurement_concept_id"] == original["measurement_concept_id"]
    assert row_back["measurement_type_concept_id"] == config.DEFAULT_OBSERVATION_TYPE_CONCEPT_ID


def test_reverse_is_table_isolated():
    """A resource written back to `measurement` must not also grow an
    observation_type_concept_id column (and vice versa) — regression test for
    a real bug where the defaults dict carried both keys unconditionally."""
    resource = omop_to_fhir_observation(MEASUREMENTS[0], MEASUREMENTS[0]["measurement_id"])

    as_measurement = fhir_to_omop_observation(resource, table="measurement")
    assert "measurement_type_concept_id" in as_measurement
    assert "observation_type_concept_id" not in as_measurement

    as_observation = fhir_to_omop_observation(resource, table="observation")
    assert "observation_type_concept_id" in as_observation
    assert "measurement_type_concept_id" not in as_observation


def test_round_trip_coded_measurement():
    original = MEASUREMENTS[1]  # HbA1c finding, coded result
    resource = omop_to_fhir_observation(original, original["measurement_id"])
    row_back = fhir_to_omop_observation(resource, table="measurement")

    assert row_back["person_id"] == original["person_id"]
    assert row_back["measurement_concept_id"] == original["measurement_concept_id"]
    assert row_back["value_as_concept_id"] == original["value_as_concept_id"]
    assert "value_as_number" not in row_back


def test_round_trip_free_text_observation():
    original = OBSERVATIONS[0]
    resource = omop_to_fhir_observation(original, original["observation_id"], table="observation")
    row_back = fhir_to_omop_observation(resource, table="observation")

    assert row_back["person_id"] == original["person_id"]
    assert row_back["visit_occurrence_id"] == original["visit_occurrence_id"]
    assert row_back["observation_datetime"] == original["observation_datetime"]
    assert row_back["value_as_string"] == original["value_as_string"]
    assert row_back["observation_type_concept_id"] == config.DEFAULT_OBSERVATION_TYPE_CONCEPT_ID
    assert "measurement_type_concept_id" not in row_back


def test_qualifier_concept_id_is_now_tracked_not_silently_absent():
    row = dict(OBSERVATIONS[0], qualifier_concept_id=4172703)
    resource = omop_to_fhir_observation(row, row["observation_id"], table="observation")
    notes = " ".join(resource["_etl_notes"])
    assert "qualifier_concept_id" in notes


def test_lifted_lab_observation_conforms_to_shacl():
    resource = omop_to_fhir_observation(MEASUREMENTS[0], MEASUREMENTS[0]["measurement_id"])
    graph = validate.lift_observation(resource, lab=True)
    conforms, report = validate.validate_graph(graph)
    assert conforms, report
