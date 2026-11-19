"""Checks src/startup_voice/features/ido/journey_map.json against both codebases.

  python docs/ido-journey/validate_map.py [path/to/ido-core]

Two layers:
  * dossier side (always): every dossier slot/field is mapped exactly once, nothing unknown;
  * ido-core side (when the path exists): every venture key is in the seeded vocabulary or declared
    as new, and every lesson slug is in JOURNEY_PHASES, so the map cannot rot silently.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# The contract ships inside the package: features/ido reads it at runtime.
MAP_PATH = HERE.parent.parent / "src" / "startup_voice" / "features" / "ido" / "journey_map.json"
DEFAULT_IDO = Path("~/Desktop/GigiApps/ido-app/ido-core").expanduser()


def load_map() -> dict:
    return json.loads(MAP_PATH.read_text(encoding="utf-8"))


def dossier_fields() -> set[str]:
    from startup_voice.domain import DIMENSIONS_SPEC, SLOT_ORDER

    return {f"{slot}.{f}" for slot in SLOT_ORDER for f in DIMENSIONS_SPEC[slot].required_fields}


def check_dossier_side(m: dict) -> list[str]:
    errors: list[str] = []
    known = dossier_fields()
    mapped: dict[str, list[str]] = {}
    for entry in m["venture_map"]:
        for src in entry["sources"]:
            mapped.setdefault(src, []).append(entry["venture_key"])
    for src in sorted(mapped):
        if src not in known:
            errors.append(f"venture_map references unknown dossier field {src!r}")
    for entry in m["venture_map"]:
        if entry["mode"] == "split" and len(entry["sources"]) != 1:
            errors.append(f"{entry['venture_key']}: a split entry needs exactly one source")
    placement_only = {s for p in m["placement_inputs"].values() for s in p["from"]}
    for field in sorted(known):
        if field not in mapped and field not in placement_only:
            errors.append(f"dossier field {field} is neither mapped to a venture key nor a placement input")
    for field, keys in mapped.items():
        direct_like = [e for e in m["venture_map"] if field in e["sources"] and e["mode"] != "split"]
        if len(direct_like) > 1:
            errors.append(f"{field} feeds several venture keys without a split: {[e['venture_key'] for e in direct_like]}")
    for slug, fields in m["lesson_evidence"].items():
        for f in fields:
            if f not in known:
                errors.append(f"lesson_evidence[{slug}] references unknown dossier field {f!r}")
    return errors


def ido_venture_keys(ido: Path, sql_rel: str) -> dict[str, str]:
    sql = (ido / sql_rel).read_text(encoding="utf-8")
    block = sql[sql.index("INSERT INTO venture_field_defs"):]
    block = block[: block.index("ON CONFLICT")]
    # ('key', 'Label', order, 'kind', ...
    return {k: kind for k, kind in re.findall(r"\(\s*'([a-z_]+)'\s*,\s*'[^']*'\s*,\s*\d+\s*,\s*'(\w+)'", block)}


def ido_lesson_slugs(ido: Path, ts_rel: str) -> set[str]:
    ts = (ido / ts_rel).read_text(encoding="utf-8")
    block = ts[ts.index("export const JOURNEY_PHASES"): ts.index("const ALL_SLUGS")]
    return set(re.findall(r"'([a-z0-9-]+)'", block)) - {"name"}


def sql_origins(ido: Path, rel: str) -> list[str]:
    sql = "\n".join(re.sub(r"--.*$", "", line) for line in (ido / rel).read_text(encoding="utf-8").splitlines())
    block = re.search(r"CHECK\s*\(\s*origin\s+IN\s*\(([\s\S]*?)\)\s*\)", sql)
    return re.findall(r"'([a-z_]+)'", block.group(1)) if block else []


def check_migration(m: dict, ido: Path) -> list[str]:
    """The delivered ido-core migration must say what the contract says."""
    errors: list[str] = []
    mig = ido / m["ido_core"]["migration"]
    if not mig.exists():
        return [f"migration {m['ido_core']['migration']} does not exist in ido-core"]
    seeded = ido_venture_keys(ido, m["ido_core"]["migration"])
    for f in m["new_venture_fields"]:
        if f["key"] not in seeded:
            errors.append(f"migration does not seed new field {f['key']!r}")
        elif seeded[f["key"]] != f["kind"]:
            errors.append(f"new field {f['key']!r}: contract says {f['kind']}, migration seeds {seeded[f['key']]}")
    origins = sql_origins(ido, m["ido_core"]["migration"])
    if m["new_origin"] not in origins:
        errors.append(f"origin {m['new_origin']!r} is not allowed by the migration's CHECK")
    for old in sql_origins(ido, m["ido_core"]["previous_origin_migration"]):
        if old not in origins:
            errors.append(f"migration drops the earlier origin {old!r}")
    return errors


def ido_bridge_keys(ido: Path, rel: str) -> list[str]:
    """INTAKE_FIELD_KEYS from ido-core's bridge protocol: the keys the voice intake may write."""
    ts = (ido / rel).read_text(encoding="utf-8")
    block = re.search(r"INTAKE_FIELD_KEYS\s*=\s*\[([\s\S]*?)\]\s*as const", ts)
    return re.findall(r"'([a-z_]+)'", block.group(1)) if block else []


def check_bridge_allow_list(m: dict, ido: Path) -> list[str]:
    """ido-core's allow-list must equal the contract's venture keys, in both directions."""
    rel = m["ido_core"]["bridge_keys_ts"]
    if not (ido / rel).exists():
        return [f"ido-core bridge protocol {rel} does not exist"]
    allowed = ido_bridge_keys(ido, rel)
    if not allowed:
        return [f"could not parse INTAKE_FIELD_KEYS from {rel}; the layout changed"]
    wanted = {e["venture_key"] for e in m["venture_map"]}
    errors = [f"contract key {k!r} is missing from ido-core's INTAKE_FIELD_KEYS (it would be dropped)" for k in sorted(wanted - set(allowed))]
    errors += [f"ido-core allows {k!r} but the contract does not map it (an unvetted write path)" for k in sorted(set(allowed) - wanted)]
    return errors


def _ts_list(ts: str, name: str) -> list[str]:
    block = re.search(name + r"\s*=\s*\[([\s\S]*?)\]\s*as const", ts)
    return re.findall(r"'([a-z_]+)'", block.group(1)) if block else []


def check_notes_contract(m: dict, ido: Path) -> list[str]:
    """Note cards: the dossier areas, the contract and ido-core's allow-list and titles must agree."""
    from startup_voice.domain import SLOT_ORDER

    errors: list[str] = []
    keys = list(m["notes"]["keys"])
    if keys != list(SLOT_ORDER):
        errors.append(f"contract notes.keys {keys} != dossier areas {list(SLOT_ORDER)}")
    rel = m["notes"]["bridge_keys_ts"]
    ts = (ido / rel).read_text(encoding="utf-8")
    allowed = _ts_list(ts, "INTAKE_NOTE_KEYS")
    if not allowed:
        return errors + [f"could not parse INTAKE_NOTE_KEYS from {rel}; the layout changed"]
    if set(allowed) != set(keys):
        errors.append(f"ido-core INTAKE_NOTE_KEYS {allowed} != contract {keys}")
    notes_ts = (ido / rel.replace("protocol.ts", "notes.ts")).read_text(encoding="utf-8")
    titles = dict(re.findall(r"^\s*([a-z_]+):\s*'(Interview[^']*)'", notes_ts, flags=re.M))
    for k in keys:
        if k not in titles:
            errors.append(f"ido-core has no card title for {k!r}")
        elif not titles[k].startswith(m["notes"]["title_prefix"]):
            errors.append(f"card title for {k!r} does not start with {m['notes']['title_prefix']!r}")
    if len(set(titles.values())) != len(titles):
        errors.append("two note areas share one card title: updates would collide")
    return errors


def check_ido_side(m: dict, ido: Path) -> list[str]:
    errors: list[str] = []
    keys = ido_venture_keys(ido, m["ido_core"]["venture_defs_sql"])
    if len(keys) < 16:
        errors.append(f"parsed only {len(keys)} venture field defs from ido-core; the SQL layout changed")
    new = {f["key"]: f for f in m["new_venture_fields"]}
    for key in new:
        if key in keys:
            errors.append(f"new venture field {key!r} already exists in ido-core")
    for entry in m["venture_map"]:
        k = entry["venture_key"]
        if k not in keys and k not in new:
            errors.append(f"venture key {k!r} is neither in ido-core's vocabulary nor declared in new_venture_fields")
    for k in ("team", "traction"):
        if keys.get(k) != "record":
            errors.append(f"expected ido-core field {k!r} to be a 'record', found {keys.get(k)!r}")
    errors += check_migration(m, ido)
    errors += check_bridge_allow_list(m, ido)
    errors += check_notes_contract(m, ido)
    slugs = ido_lesson_slugs(ido, m["ido_core"]["journey_ts"])
    if len(slugs) < 20:
        errors.append(f"parsed only {len(slugs)} lesson slugs from JOURNEY_PHASES; the layout changed")
    for slug in m["lesson_evidence"]:
        if slug not in slugs:
            errors.append(f"lesson slug {slug!r} is not in JOURNEY_PHASES")
    return errors


def main(argv: list[str]) -> int:
    m = load_map()
    ido = Path(argv[1]).expanduser() if len(argv) > 1 else DEFAULT_IDO
    errors = check_dossier_side(m)
    if ido.exists():
        errors += check_ido_side(m, ido)
        scope = f"dossier + ido-core ({ido})"
    else:
        scope = "dossier only (ido-core path not found)"
    for e in errors:
        print("FAIL", e)
    print(f"{'OK' if not errors else 'FAILED'}: {scope}, {len(m['venture_map'])} venture mappings")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
