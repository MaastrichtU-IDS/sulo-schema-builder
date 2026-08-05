"""Minimal CLI to run the scaffold end to end.

Examples
--------
    python -m etl.cli condition omop2fhir etl/fixtures/omop_condition_occurrence.json
    python -m etl.cli observation omop2fhir etl/fixtures/omop_measurement.json --table measurement
    python -m etl.cli observation omop2fhir etl/fixtures/omop_observation.json --table observation
    python -m etl.cli medication omop2fhir etl/fixtures/omop_drug_exposure.json
"""

from __future__ import annotations

import argparse
import json
import sys

from . import validate
from .transforms.condition import omop_to_fhir_condition
from .transforms.medication import omop_to_fhir_medication
from .transforms.observation import omop_to_fhir_observation


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("resource", choices=["condition", "observation", "medication"])
    parser.add_argument("direction", choices=["omop2fhir"], help="fhir2omop is available programmatically; not yet wired into the CLI")
    parser.add_argument("input_path", help="JSON file: a list of OMOP rows")
    parser.add_argument("--table", choices=["measurement", "observation"], default="measurement", help="observation only: which OMOP table the input rows are from (picks which differently-spelled columns to read, e.g. measurement_concept_id vs observation_concept_id)")
    parser.add_argument("--validate", action="store_true", help="also SHACL-validate the lifted RDF against etl/shapes/mimic-fhir.shacl.ttl")
    args = parser.parse_args()

    rows = json.loads(open(args.input_path).read())
    results = []
    for row in rows:
        if args.resource == "condition":
            resource = omop_to_fhir_condition(row)
            graph = validate.lift_condition(resource)
        elif args.resource == "medication":
            resource = omop_to_fhir_medication(row)
            graph = validate.lift_medication(resource)
        else:
            id_col = "measurement_id" if args.table == "measurement" else "observation_id"
            resource = omop_to_fhir_observation(row, row.get(id_col), table=args.table)
            graph = validate.lift_observation(resource, lab=(args.table == "measurement"))

        if args.validate:
            conforms, report = validate.validate_graph(graph)
            resource["_shacl_conforms"] = conforms
            if not conforms:
                print(report, file=sys.stderr)

        results.append(resource)

    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
