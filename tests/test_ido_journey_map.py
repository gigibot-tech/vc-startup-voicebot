"""The dossier -> ido-core Journey contract (src/startup_voice/features/ido/journey_map.json).

The dossier-side checks always run. The ido-core checks run when that repo is on this machine.
Every check is also proven to FAIL on a deliberately broken map, so a green run means something.
"""

import copy
import importlib.util
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent.parent / "docs" / "ido-journey"
spec = importlib.util.spec_from_file_location("validate_map", HERE / "validate_map.py")
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)

IDO = vm.DEFAULT_IDO
needs_ido = pytest.mark.skipif(not IDO.exists(), reason="ido-core is not on this machine")


@pytest.fixture
def m():
    return copy.deepcopy(vm.load_map())


def test_contract_is_consistent_on_the_dossier_side(m):
    assert vm.check_dossier_side(m) == []


def test_every_dossier_field_is_accounted_for(m):
    mapped = {s for e in m["venture_map"] for s in e["sources"]}
    placement = {s for p in m["placement_inputs"].values() for s in p["from"]}
    assert vm.dossier_fields() <= mapped | placement


def test_unmapped_dossier_field_is_caught(m):
    m["venture_map"] = [e for e in m["venture_map"] if e["venture_key"] != "segments"]
    assert any("market.target_icp" in e for e in vm.check_dossier_side(m))


def test_unknown_dossier_field_is_caught(m):
    m["venture_map"][0]["sources"].append("team.shoe_size")
    assert any("team.shoe_size" in e for e in vm.check_dossier_side(m))


def test_one_field_feeding_two_keys_without_a_split_is_caught(m):
    m["venture_map"].append({"venture_key": "metrics", "mode": "direct", "sources": ["team.founders_roles"]})
    assert any("team.founders_roles" in e and "several" in e for e in vm.check_dossier_side(m))


@needs_ido
def test_contract_matches_ido_core():
    assert vm.check_ido_side(vm.load_map(), IDO) == []


@needs_ido
def test_ido_core_parsers_see_the_whole_vocabulary():
    keys = vm.ido_venture_keys(IDO, vm.load_map()["ido_core"]["venture_defs_sql"])
    assert {"team", "traction", "market", "segments", "problem", "solution", "uvp", "unfair"} <= set(keys)
    assert len(keys) == 16
    slugs = vm.ido_lesson_slugs(IDO, vm.load_map()["ido_core"]["journey_ts"])
    assert {"defining-the-problem", "funding-readiness-check", "what-is-an-mvp-"} <= slugs


@needs_ido
def test_invented_venture_key_is_caught(m):
    m["venture_map"][0]["venture_key"] = "teem"
    assert any("'teem'" in e for e in vm.check_ido_side(m, IDO))


@needs_ido
def test_new_field_that_already_exists_is_caught(m):
    m["new_venture_fields"].append({"key": "market", "kind": "hypothesis", "label": "x", "description": "x"})
    assert any("already exists" in e for e in vm.check_ido_side(m, IDO))


@needs_ido
def test_unknown_lesson_slug_is_caught(m):
    m["lesson_evidence"]["nonexistent-lesson"] = ["team.founders_roles"]
    assert any("nonexistent-lesson" in e for e in vm.check_ido_side(m, IDO))


@needs_ido
def test_contract_kind_must_match_what_the_migration_seeds(m):
    m["new_venture_fields"][0]["kind"] = "record"
    assert any("funding" in e and "migration seeds hypothesis" in e for e in vm.check_migration(m, IDO))


@needs_ido
def test_origin_the_migration_does_not_allow_is_caught(m):
    m["new_origin"] = "carrier_pigeon"
    assert any("carrier_pigeon" in e for e in vm.check_migration(m, IDO))


@needs_ido
def test_missing_migration_is_caught(m):
    m["ido_core"]["migration"] = "supabase/migrations/does_not_exist.sql"
    assert any("does not exist" in e for e in vm.check_migration(m, IDO))


@needs_ido
def test_delivered_migration_keeps_every_earlier_origin():
    m = vm.load_map()
    assert "journey_lesson" in vm.sql_origins(IDO, m["ido_core"]["migration"])


@needs_ido
def test_ido_core_allow_list_matches_the_contract_exactly():
    assert vm.check_bridge_allow_list(vm.load_map(), IDO) == []


@needs_ido
def test_a_contract_key_missing_from_the_ido_allow_list_is_caught(m):
    m["venture_map"].append({"venture_key": "metrics", "mode": "direct", "sources": ["traction.growth_signal"]})
    assert any("'metrics'" in e and "missing from ido-core" in e for e in vm.check_bridge_allow_list(m, IDO))


@needs_ido
def test_an_ido_allow_list_key_the_contract_does_not_map_is_caught(m):
    m["venture_map"] = [e for e in m["venture_map"] if e["venture_key"] != "funding"]
    assert any("'funding'" in e and "unvetted" in e for e in vm.check_bridge_allow_list(m, IDO))


@needs_ido
def test_note_cards_agree_across_dossier_contract_and_ido_core():
    assert vm.check_notes_contract(vm.load_map(), IDO) == []


@needs_ido
def test_a_contract_card_area_ido_core_does_not_allow_is_caught(m):
    m["notes"]["keys"] = ["team", "product", "traction", "market", "financing", "funding"]
    assert any("INTAKE_NOTE_KEYS" in e or "dossier areas" in e for e in vm.check_notes_contract(m, IDO))


@needs_ido
def test_a_wrong_title_prefix_is_caught(m):
    m["notes"]["title_prefix"] = "Gespräch · "
    assert any("does not start with" in e for e in vm.check_notes_contract(m, IDO))
