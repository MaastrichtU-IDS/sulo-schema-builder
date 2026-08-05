"""Generic declarative op-interpreter for mappings/*.yaml.

There is no per-field Python code anywhere in this package — every field-level
transform, including the composite ones (a coded value split across two OMOP
columns, a value that branches into valueQuantity/valueCodeableConcept/
valueString, a unit merged onto a sibling field, two columns folded into one
FHIR Range), is expressed as one of the seven `op`s below, interpreted the
same way regardless of resource. condition.py/observation.py just load a YAML
file and call apply_forward()/apply_reverse() — see docstrings there.

The only escape hatch is a *named, registered* value lookup
(terminology.LOOKUPS / REVERSE_LOOKUPS) — a data lookup (concept_id -> coding),
not transformation logic — referenced from YAML as `lookup: concept`, never
imported by name here.

Column names may contain a `{table}` placeholder (e.g. "{table}_concept_id"),
resolved against the `context` dict passed to apply_forward/apply_reverse —
this is how one YAML file drives both the `measurement` and `observation`
OMOP tables without an OR-list of hardcoded names for every differently-spelled
column.
"""

from __future__ import annotations

from typing import Any

from .. import terminology

Row = dict[str, Any]


# ─── path + name helpers ────────────────────────────────────────────────────

def get_path(d: dict, path: str) -> Any:
    node: Any = d
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def set_path(d: dict, path: str, value: Any) -> None:
    parts = path.split(".")
    node = d
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = value


def _resolve(name: str, context: dict) -> str:
    return name.format(**context) if isinstance(name, str) and "{" in name else name


def _names(spec, context: dict) -> list[str]:
    names = spec if isinstance(spec, list) else [spec]
    return [_resolve(n, context) for n in names]


def _first_present(row: Row, names: list[str]) -> tuple[str, Any] | None:
    for n in names:
        if row.get(n) is not None:
            return n, row[n]
    return None


# ─── forward: OMOP row -> FHIR resource dict ────────────────────────────────

def apply_forward(row: Row, ops: list[dict], context: dict | None = None) -> tuple[dict, list[str]]:
    context = context or {}
    out: dict = {}
    notes: list[str] = []

    for op in ops:
        kind = op["op"]

        if kind == "copy":
            found = _first_present(row, _names(op["source"], context))
            if found:
                set_path(out, op["target"], found[1])

        elif kind == "reference":
            found = _first_present(row, _names(op["source"], context))
            if found:
                set_path(out, op["target"], {"reference": f"{op.get('prefix', '')}{found[1]}"})

        elif kind == "const":
            set_path(out, op["target"], op["value"])

        elif kind == "drop_source":
            present = [n for n in _names(op["source"], context) if row.get(n) is not None]
            if present:
                notes.append(f"omop:{','.join(present)} dropped (no FHIR target) — {op.get('reason', '').strip()}")

        elif kind == "drop_target":
            notes.append(f"fhir:{op['target']} left unmapped — {op.get('reason', '').strip()}")

        elif kind == "coding_list":
            codings = [c for c in (_resolve_coding_item(row, item, context) for item in op["items"]) if c]
            if codings:
                set_path(out, op["target"], {"coding": codings})

        elif kind == "value_branch":
            _value_branch_forward(row, out, op, context)

        elif kind == "range":
            low, high = row.get(op["low"]), row.get(op["high"])
            if low is not None or high is not None:
                low_key, high_key = op.get("low_key", "low"), op.get("high_key", "high")
                wrap = op.get("wrap_value", True)
                entry = {}
                if low is not None:
                    entry[low_key] = {"value": low} if wrap else low
                if high is not None:
                    entry[high_key] = {"value": high} if wrap else high
                set_path(out, op["target"], [entry] if op.get("as_list", True) else entry)

        else:
            raise ValueError(f"unknown op: {kind}")

    return out, notes


def _resolve_coding_item(row: Row, item: dict, context: dict) -> dict | None:
    concept = None
    if "concept_from" in item:
        found = _first_present(row, _names(item["concept_from"], context))
        if found:
            concept = terminology.LOOKUPS[item.get("lookup", "concept")](found[1])

    code_value = row.get(item["code_from"]) if "code_from" in item else None
    if concept is None and code_value is None:
        return None

    entry = {
        "system": concept.system if concept else item.get("default_system"),
        "code": code_value if code_value is not None else (concept.code if concept else None),
    }
    if concept and concept.display:
        entry["display"] = concept.display
    return entry


def _value_branch_forward(row: Row, out: dict, op: dict, context: dict) -> None:
    for case in op["cases"]:
        if row.get(case["when"]) is None:
            continue
        value, as_ = row[case["when"]], case["as"]
        if as_ == "quantity":
            set_path(out, case["target"], {"value": float(value)})
        elif as_ == "coding":
            coding = terminology.LOOKUPS[case.get("lookup", "concept")](value)
            if coding:
                set_path(out, case["target"], {"coding": [{"system": coding.system, "code": coding.code, "display": coding.display}]})
        elif as_ == "literal":
            set_path(out, case["target"], value)
        break  # first non-null case wins

    merge = op.get("merge_when_quantity")
    if merge and "valueQuantity" in out:
        found = _first_present(row, _names(merge["source"], context))
        if found:
            coding = terminology.LOOKUPS[merge.get("lookup", "concept")](found[1])
            if coding:
                out["valueQuantity"]["unit"] = coding.display or coding.code
                out["valueQuantity"]["system"] = coding.system
                out["valueQuantity"]["code"] = coding.code


# ─── reverse: FHIR resource dict -> OMOP row ────────────────────────────────

def apply_reverse(resource: dict, ops: list[dict], context: dict | None = None, defaults: dict | None = None) -> tuple[Row, list[str]]:
    context, defaults = context or {}, defaults or {}
    out: Row = {}
    notes: list[str] = []

    for op in ops:
        kind = op["op"]

        if kind == "copy":
            value = get_path(resource, op["target"])
            if value is not None:
                out[_names(op["source"], context)[0]] = value

        elif kind == "reference":
            value = get_path(resource, op["target"])
            if value is not None:
                ref = value.get("reference", "") if isinstance(value, dict) else str(value)
                prefix = op.get("prefix", "")
                id_part = ref[len(prefix):] if ref.startswith(prefix) else ref
                out[_names(op["source"], context)[0]] = int(id_part) if id_part.isdigit() else id_part

        elif kind == "const":
            pass  # nothing to pull back — asserted only, never sourced

        elif kind == "drop_source":
            for name in _names(op["source"], context):
                if name in defaults:
                    out[name] = defaults[name]
                    notes.append(f"omop:{name} defaulted to {defaults[name]!r} (no FHIR source) — {op.get('reason', '').strip()}")

        elif kind == "drop_target":
            pass  # nothing on the FHIR side to read back

        elif kind == "coding_list":
            codings = (get_path(resource, op["target"]) or {}).get("coding", [])
            _reverse_coding_list(out, op["items"], list(codings), context)

        elif kind == "value_branch":
            _value_branch_reverse(resource, out, op, context)

        elif kind == "range":
            low_key, high_key = op.get("low_key", "low"), op.get("high_key", "high")
            wrap = op.get("wrap_value", True)
            value = get_path(resource, op["target"])
            entry = (value[0] if value else None) if op.get("as_list", True) else value
            if entry:
                if low_key in entry:
                    out[op["low"]] = entry[low_key]["value"] if wrap else entry[low_key]
                if high_key in entry:
                    out[op["high"]] = entry[high_key]["value"] if wrap else entry[high_key]

        else:
            raise ValueError(f"unknown op: {kind}")

    return out, notes


def _reverse_coding_list(out: dict, items: list[dict], remaining: list[dict], context: dict) -> None:
    for item in items:
        match_system = item.get("match_system")
        chosen = None
        if match_system:
            chosen = next((c for c in remaining if c.get("system") == match_system), None)
        else:
            chosen = remaining[0] if remaining else None  # catch-all: whatever's left
        if not chosen:
            continue
        remaining.remove(chosen)

        if "code_from" in item:
            out[item["code_from"]] = chosen.get("code")
        if "concept_from" in item:
            concept_id = terminology.REVERSE_LOOKUPS[item.get("lookup", "concept")](chosen.get("system", ""), chosen.get("code", ""))
            if concept_id:
                out[_names(item["concept_from"], context)[0]] = concept_id


def _value_branch_reverse(resource: dict, out: dict, op: dict, context: dict) -> None:
    for case in op["cases"]:
        value = get_path(resource, case["target"])
        if value is None:
            continue
        as_ = case["as"]
        if as_ == "quantity":
            out[case["when"]] = value.get("value")
        elif as_ == "coding":
            coding = (value.get("coding") or [None])[0]
            if coding:
                concept_id = terminology.REVERSE_LOOKUPS[case.get("lookup", "concept")](coding.get("system", ""), coding.get("code", ""))
                if concept_id:
                    out[case["when"]] = concept_id
        elif as_ == "literal":
            out[case["when"]] = value
        break  # mirrors the forward priority — first populated target wins

    merge = op.get("merge_when_quantity")
    if merge:
        vq = get_path(resource, "valueQuantity")
        if vq and "system" in vq and "code" in vq:
            concept_id = terminology.REVERSE_LOOKUPS[merge.get("lookup", "concept")](vq["system"], vq["code"])
            if concept_id:
                out[_names(merge["source"], context)[0]] = concept_id
