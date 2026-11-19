"""Dossier -> ido-core delta: mapping, endpoint, embed policy. No network."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from startup_voice.domain import DimensionState, FieldProposal, InterviewSession
from startup_voice.features.ido.delta import dossier_to_venture_delta, revision
from startup_voice.web import create_app


def fresh() -> InterviewSession:
    from startup_voice.features.interview.pipeline import InterviewPipeline
    from startup_voice.features.sessions.store import FileSessionStore
    import tempfile

    pipe = InterviewPipeline(object(), FileSessionStore(Path(tempfile.mkdtemp())))
    session, _ = pipe.start_session()
    return session


def by_key(changes):
    return {c.venture_key: c for c in changes}


def test_empty_dossier_produces_nothing():
    assert dossier_to_venture_delta(fresh()) == []


def test_direct_fields_carry_the_value_as_is():
    s = fresh()
    s.objects["market"].fields["target_icp"] = "  Gründerinnen im Frühstadium "
    s.objects["market"].fields["market_size"] = "TAM 2 Mrd"
    s.objects["market"].fields["competitors_moat"] = "Notiz-Apps; unser Vorsprung ist die Journey"
    s.objects["product"].fields["problem"] = "Ideen gehen verloren"
    s.objects["product"].fields["solution"] = "Geführte Journey"
    got = by_key(dossier_to_venture_delta(s))
    assert got["segments"].value == "Gründerinnen im Frühstadium"
    assert got["market"].value == "TAM 2 Mrd"
    assert got["unfair"].value.startswith("Notiz-Apps")
    assert got["problem"].value == "Ideen gehen verloren"
    assert got["solution"].value == "Geführte Journey"


def test_composed_fields_are_labelled_lines_of_the_filled_parts_only():
    s = fresh()
    s.objects["team"].fields["founders_roles"] = "Anna (CEO), Ben (CTO)"
    s.objects["team"].fields["commitment_fulltime"] = "Beide Vollzeit"
    team = by_key(dossier_to_venture_delta(s))["team"]
    assert team.value == "Gründer & Rollen: Anna (CEO), Ben (CTO)\nZeitliche Verfügbarkeit: Beide Vollzeit"
    assert team.sources == ("team.founders_roles", "team.commitment_fulltime")


def test_financing_goes_to_the_new_funding_field_not_revenue_or_costs():
    s = fresh()
    s.objects["financing"].fields["raise_amount_round"] = "Seed 500k"
    got = by_key(dossier_to_venture_delta(s))
    assert set(got) == {"funding"}
    assert "Seed 500k" in got["funding"].value


def test_a_value_waiting_in_the_review_gate_is_not_part_of_the_delta():
    s = fresh()
    s.objects["market"].fields["market_size"] = "TAM 2 Mrd"
    s.objects["market"].pending["market_size"] = FieldProposal(old="TAM 2 Mrd", new="TAM 9 Mrd")
    assert by_key(dossier_to_venture_delta(s))["market"].value == "TAM 2 Mrd"


def test_stage_status_is_not_a_venture_field():
    s = fresh()
    s.objects["product"].fields["stage_status"] = "MVP live"
    assert dossier_to_venture_delta(s) == []


def test_revision_changes_exactly_when_the_content_changes():
    s = fresh()
    s.objects["team"].fields["founders_roles"] = "Anna"
    a = revision(dossier_to_venture_delta(s))
    assert a == revision(dossier_to_venture_delta(s))
    s.objects["team"].fields["founders_roles"] = "Anna und Ben"
    assert a != revision(dossier_to_venture_delta(s))


def test_conversations_saved_before_the_schema_split_keep_their_text():
    old = {
        "slot": "product",
        "fields": {"problem_solution": "Ideen gehen verloren; wir speichern sie", "stage_status": "Idee"},
        "pending": {"problem_solution": {"old": "a", "new": "b"}},
    }
    state = DimensionState.model_validate(old)
    assert "problem_solution" not in state.fields
    assert state.fields["problem"] == "Ideen gehen verloren; wir speichern sie"
    assert state.fields["solution"] == ""
    assert "problem" in state.pending and "problem_solution" not in state.pending


def test_upgrade_never_overwrites_a_new_problem_value():
    state = DimensionState.model_validate(
        {"slot": "product", "fields": {"problem_solution": "alt", "problem": "neu"}}
    )
    assert state.fields["problem"] == "neu"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.delenv("IDO_ORIGINS", raising=False)

    class StubLLM:
        def complete(self, *a, **k):
            return "{}"

    return TestClient(create_app(llm=StubLLM()))


def test_endpoint_returns_the_delta_and_a_revision(client):
    sid = client.post("/api/sessions").json()["session"]["id"]
    empty = client.get(f"/api/sessions/{sid}/ido-delta").json()
    assert empty["fields"] == [] and empty["session_id"] == sid
    assert client.get("/api/sessions/does-not-exist/ido-delta").status_code == 404


def test_config_lists_only_real_origins(client, monkeypatch):
    assert client.get("/api/ido/config").json() == {"origins": []}
    monkeypatch.setenv("IDO_ORIGINS", " http://localhost:3000/ ,https://idoapp.eu,*,http://localhost:3000")
    assert client.get("/api/ido/config").json() == {"origins": ["http://localhost:3000", "https://idoapp.eu"]}


def test_page_can_only_be_framed_by_itself_unless_ido_origins_are_set(client, monkeypatch):
    assert client.get("/").headers["content-security-policy"] == "frame-ancestors 'self'"
    monkeypatch.setenv("IDO_ORIGINS", "https://idoapp.eu")
    assert client.get("/").headers["content-security-policy"] == "frame-ancestors 'self' https://idoapp.eu"
    assert "content-security-policy" not in client.get("/health").headers
