"""Dossier -> note cards for ido-core's notetaking board."""

import pytest
from fastapi.testclient import TestClient

from startup_voice.domain import SLOT_ORDER
from startup_voice.features.ido.delta import dossier_to_venture_delta, revision
from startup_voice.features.ido.notes import dossier_to_notes
from startup_voice.web import create_app


def fresh():
    import tempfile
    from pathlib import Path

    from startup_voice.features.interview.pipeline import InterviewPipeline
    from startup_voice.features.sessions.store import FileSessionStore

    session, _ = InterviewPipeline(object(), FileSessionStore(Path(tempfile.mkdtemp()))).start_session()
    return session


def by_key(cards):
    return {c.key: c for c in cards}


def test_empty_dossier_makes_no_cards():
    assert dossier_to_notes(fresh()) == []


def test_one_card_per_area_with_content_in_dossier_order():
    s = fresh()
    s.objects["market"].fields["target_icp"] = "Gründerinnen"
    s.objects["team"].fields["founders_roles"] = "Anna (CEO), Ben (CTO)"
    s.objects["financing"].fields["raise_amount_round"] = "Seed 500k"
    assert [c.key for c in dossier_to_notes(s)] == ["team", "market", "financing"]
    assert [c.key for c in dossier_to_notes(s)] == [k for k in SLOT_ORDER if k in {"team", "market", "financing"}]


def test_card_body_is_labelled_lines_of_the_filled_fields_only():
    s = fresh()
    s.objects["team"].fields["founders_roles"] = " Anna (CEO), Ben (CTO) "
    s.objects["team"].fields["commitment_fulltime"] = "Beide Vollzeit"
    card = by_key(dossier_to_notes(s))["team"]
    assert card.body == "Gründer & Rollen: Anna (CEO), Ben (CTO)\nZeitliche Verfügbarkeit: Beide Vollzeit"


def test_cards_never_carry_conversation_evidence_or_scores():
    s = fresh()
    s.objects["market"].fields["target_icp"] = "Gründerinnen"
    s.objects["market"].evidence = ["Zitat: 'wir verkaufen an alle'"]
    s.objects["market"].summary = "ZUSAMMENFASSUNG-GEHEIM"
    s.objects["market"].belege = 0.9
    body = by_key(dossier_to_notes(s))["market"].body
    assert "Zitat" not in body and "GEHEIM" not in body and "0.9" not in body


def test_card_keys_are_exactly_the_dossier_areas():
    s = fresh()
    for slot in SLOT_ORDER:
        for f in s.objects[slot].fields:
            s.objects[slot].fields[f] = "x"
    assert [c.key for c in dossier_to_notes(s)] == list(SLOT_ORDER)


def test_a_note_change_alone_changes_the_revision():
    s = fresh()
    s.objects["market"].fields["target_icp"] = "A"
    changes = dossier_to_venture_delta(s)
    a = revision(changes, dossier_to_notes(s))
    assert a != revision(changes)  # cards are part of the fingerprint
    s.objects["product"].fields["stage_status"] = "MVP"  # affects ONLY a card (not a venture field)
    assert revision(dossier_to_venture_delta(s), dossier_to_notes(s)) != a


def test_endpoint_returns_cards(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))

    class StubLLM:
        def complete(self, *a, **k):
            return "{}"

    client = TestClient(create_app(llm=StubLLM()))
    sid = client.post("/api/sessions").json()["session"]["id"]
    body = client.get(f"/api/sessions/{sid}/ido-delta").json()
    assert body["notes"] == [] and body["fields"] == []


def test_contract_lists_the_same_areas_as_the_dossier():
    from startup_voice.features.ido.delta import load_map

    assert tuple(load_map()["notes"]["keys"]) == SLOT_ORDER
