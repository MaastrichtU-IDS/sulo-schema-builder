"""Lift a transformed FHIR resource dict into RDF using the *real* MIMIC-FHIR
schema's own class/property IRIs, then SHACL-validate it against the shapes
exported straight from the running app (etl/shapes/mimic-fhir.shacl.ttl —
regenerate with `node ../export-and-check.mts <schema-id> mimic-final` after
any schema change, see README).

This intentionally validates SHACL only, not the full OWL-DL/HermiT
consistency check — the SHACL shapes use the schema's own simple named
properties (:hasCode, :hasPatient, ...) directly as sh:path, so lifting only
needs flat triples, not the reified role/time-instant chains the OWL export
expands those properties into.
"""

from __future__ import annotations

import uuid

from pyshacl import validate as shacl_validate
from rdflib import RDF, XSD, BNode, Graph, Literal, Namespace, URIRef

from . import config

SCHEMA = Namespace(config.MIMIC_FHIR_SCHEMA_BASE)


def _node(value: str) -> URIRef:
    return URIRef(f"urn:etl:{value}")


def _add_code(g: Graph, subj: URIRef, resource: dict) -> None:
    """Populate a :Code node (:hasIdentifier and :hasCodingSystemAndVersion are
    both sh:minCount 1 on :CodeShape) from the first FHIR coding entry."""
    codings = (resource.get("code") or {}).get("coding") or []
    if not codings:
        return
    first = codings[0]
    code_node = BNode()
    g.add((subj, SCHEMA.hasCode, code_node))
    g.add((code_node, RDF.type, SCHEMA.Code))
    g.add((code_node, SCHEMA.hasIdentifier, Literal(first.get("code", ""))))
    g.add((code_node, SCHEMA.hasCodingSystemAndVersion, Literal(first.get("system", ""))))
    if first.get("display"):
        g.add((code_node, SCHEMA.hasName, Literal(first["display"])))


def lift_condition(resource: dict) -> Graph:
    g = Graph()
    subj = _node(resource.get("id", str(uuid.uuid4())))
    g.add((subj, RDF.type, SCHEMA.Condition))
    _add_code(g, subj, resource)

    encounter_ref = (resource.get("encounter") or {}).get("reference")
    if encounter_ref:
        enc_node = _node(encounter_ref)
        g.add((subj, SCHEMA.hasEncounter, enc_node))
        g.add((enc_node, RDF.type, SCHEMA.Encounter))

    patient_ref = (resource.get("subject") or {}).get("reference")
    if patient_ref:
        pat_node = _node(patient_ref)
        g.add((subj, SCHEMA.hasPatient, pat_node))
        g.add((pat_node, RDF.type, SCHEMA.Patient))

    if resource.get("recordedDate"):
        g.add((subj, SCHEMA.hasRecordedDate, Literal(resource["recordedDate"], datatype=XSD.dateTime)))

    seq_num = _find_extension_value(resource, "seq-num")
    if seq_num is not None:
        g.add((subj, SCHEMA.hasSeqNum, Literal(seq_num, datatype=XSD.integer)))

    return g


def lift_observation(resource: dict, lab: bool = True) -> Graph:
    g = Graph()
    subj = _node(resource.get("id", str(uuid.uuid4())))
    g.add((subj, RDF.type, SCHEMA.LabObservation if lab else SCHEMA.VitalSignObservation))
    _add_code(g, subj, resource)

    encounter_ref = (resource.get("encounter") or {}).get("reference")
    if encounter_ref:
        enc_node = _node(encounter_ref)
        g.add((subj, SCHEMA.hasEncounter, enc_node))
        g.add((enc_node, RDF.type, SCHEMA.Encounter))

    patient_ref = (resource.get("subject") or {}).get("reference")
    if patient_ref:
        pat_node = _node(patient_ref)
        g.add((subj, SCHEMA.hasPatient, pat_node))
        g.add((pat_node, RDF.type, SCHEMA.Patient))

    if resource.get("effectiveDateTime"):
        g.add((subj, SCHEMA.hasEffectiveDate, Literal(resource["effectiveDateTime"], datatype=XSD.dateTime)))

    vq = resource.get("valueQuantity")
    if vq and "value" in vq:
        g.add((subj, SCHEMA.hasQuantityValue, Literal(float(vq["value"]), datatype=XSD.float)))
    if vq and "code" in vq:
        g.add((subj, SCHEMA.hasUnit, URIRef(f"{config.SULO}Unit")))

    if resource.get("status"):
        status_node = BNode()
        g.add((subj, SCHEMA.hasStatus, status_node))
        g.add((status_node, RDF.type, SCHEMA.Status))

    if lab and resource.get("specimen", {}).get("reference"):
        spec_node = _node(resource["specimen"]["reference"])
        g.add((subj, SCHEMA.hasSpecimen, spec_node))
        g.add((spec_node, RDF.type, SCHEMA.Specimen))

    if lab and resource.get("interpretation"):
        interp_node = BNode()
        g.add((subj, SCHEMA.hasInterpretation, interp_node))
        g.add((interp_node, RDF.type, SCHEMA.ResultInterpretation))

    if lab and resource.get("referenceRange"):
        # MIMIC's hasReferenceRange is a single display string (Pattern 4); compress the
        # structured FHIR Range into one for SHACL purposes.
        r = resource["referenceRange"][0]
        low, high = r.get("low", {}).get("value"), r.get("high", {}).get("value")
        g.add((subj, SCHEMA.hasReferenceRange, Literal(f"{low}-{high}")))

    return g


def lift_medication(resource: dict) -> Graph:
    """Lift a MedicationAdministration resource as :MedicationEvent (the
    shared parent that actually carries hasPatient/hasEncounter/hasMedication/
    hasRoute/hasStatus/hasEventDate in the SHACL export).

    Note: SHACL's sh:targetClass matches by exact rdf:type with no rdfs:
    subClassOf inference (we call shacl_validate with inference="none"), so
    typing this individual as :MedicationAdministration would only pull in
    :MedicationAdministrationShape's own property (hasRequest, optional) —
    none of the shared properties would be checked at all. Typing it as
    :MedicationEvent instead is what actually exercises those constraints;
    this is a known limitation of the schema's SHACL export (each class's
    shape reflects only its own directly-defined properties, not inherited
    ones), not something this ETL scaffold can fix.
    """
    g = Graph()
    subj = _node(resource.get("id", str(uuid.uuid4())))
    g.add((subj, RDF.type, SCHEMA.MedicationEvent))

    patient_ref = (resource.get("subject") or {}).get("reference")
    if patient_ref:
        pat_node = _node(patient_ref)
        g.add((subj, SCHEMA.hasPatient, pat_node))
        g.add((pat_node, RDF.type, SCHEMA.Patient))

    context_ref = (resource.get("context") or {}).get("reference")
    if context_ref:
        enc_node = _node(context_ref)
        g.add((subj, SCHEMA.hasEncounter, enc_node))
        g.add((enc_node, RDF.type, SCHEMA.Encounter))

    if resource.get("medicationCodeableConcept"):
        med_node = BNode()
        g.add((subj, SCHEMA.hasMedication, med_node))
        g.add((med_node, RDF.type, SCHEMA.Medication))

    if (resource.get("dosage") or {}).get("route"):
        route_node = BNode()
        g.add((subj, SCHEMA.hasRoute, route_node))
        g.add((route_node, RDF.type, SCHEMA.Route))

    period = resource.get("effectivePeriod") or {}
    if period.get("start"):
        g.add((subj, SCHEMA.hasEventDate, Literal(period["start"], datatype=XSD.dateTime)))

    if resource.get("status"):
        status_node = BNode()
        g.add((subj, SCHEMA.hasStatus, status_node))
        g.add((status_node, RDF.type, SCHEMA.Status))

    return g


def _find_extension_value(resource: dict, url_suffix: str):
    for ext in resource.get("extension", []):
        if ext.get("url", "").endswith(url_suffix):
            for key, value in ext.items():
                if key.startswith("value"):
                    return value
    return None


def validate_graph(g: Graph) -> tuple[bool, str]:
    shapes = Graph().parse(config.SHACL_SHAPES_PATH, format="turtle")
    conforms, _report_graph, report_text = shacl_validate(
        g, shacl_graph=shapes, ont_graph=None, inference="none", advanced=True
    )
    return conforms, report_text
