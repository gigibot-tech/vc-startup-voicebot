"""Review gate: LLM suggestions that would overwrite a filled field become proposals."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from startup_voice.domain import InterviewSession
from startup_voice.features.dossier.review import Decision, apply_decisions, propose_field_update
from startup_voice.features.dossier.scoring import evaluate_session
from startup_voice.web import create_app
from test_pipeline import StubExtractLLM


def _team():
    return InterviewSession.create().objects["team"]


def test_empty_field_is_written_directly():
    team = _team()
    assert propose_field_update(team, "founders_roles", "CEO und CTO", source="chat", turn=1) == "set"
    assert team.fields["founders_roles"] == "CEO und CTO" and not team.pending


def test_same_value_is_ignored_and_clears_stale_proposal():
    team = _team()
    propose_field_update(team, "founders_roles", "CEO und CTO", source="chat", turn=1)
    propose_field_update(team, "founders_roles", "CEO, CTO und CPO", source="chat", turn=2)
    assert "founders_roles" in team.pending
    assert propose_field_update(team, "founders_roles", " ceo  UND cto ", source="chat", turn=3) == "same"
    assert not team.pending


def test_conflict_becomes_pending_and_does_not_touch_score_input():
    team = _team()
    propose_field_update(team, "founders_roles", "CEO und CTO", source="chat", turn=1)
    assert propose_field_update(team, "founders_roles", "Drei Gründer", source="pdf:d1", turn=2,
                                quote="drei Gründer", page=3) == "pending"
    assert team.fields["founders_roles"] == "CEO und CTO"
    p = team.pending["founders_roles"]
    assert (p.old, p.new, p.source, p.page) == ("CEO und CTO", "Drei Gründer", "pdf:d1", 3)


def test_second_proposal_keeps_first_old_value():
    team = _team()
    propose_field_update(team, "founders_roles", "A", source="chat", turn=1)
    propose_field_update(team, "founders_roles", "B", source="chat", turn=2)
    propose_field_update(team, "founders_roles", "C", source="chat", turn=3)
    p = team.pending["founders_roles"]
    assert (p.old, p.new) == ("A", "C")


def test_unreviewed_source_overwrites_silently(monkeypatch):
    monkeypatch.setattr("startup_voice.features.dossier.review.REVIEW_SOURCES", ("pdf",))
    team = _team()
    propose_field_update(team, "founders_roles", "A", source="chat", turn=1)
    assert propose_field_update(team, "founders_roles", "B", source="chat", turn=2) == "set"
    assert team.fields["founders_roles"] == "B" and not team.pending


def _session_with_proposal() -> InterviewSession:
    s = InterviewSession.create()
    propose_field_update(s.objects["team"], "founders_roles", "A", source="chat", turn=1)
    propose_field_update(s.objects["team"], "founders_roles", "B", source="chat", turn=2)
    return s


@pytest.mark.parametrize(
    ("choice", "text", "expected"),
    [("old", "", "A"), ("new", "", "B"), ("manual", "  Mein Text ", "Mein Text")],
)
def test_apply_decisions(choice, text, expected):
    s = _session_with_proposal()
    apply_decisions(s, [Decision("team", "founders_roles", choice, text)])
    assert s.objects["team"].fields["founders_roles"] == expected
    assert not s.objects["team"].pending


def test_manual_must_not_be_empty_and_nothing_is_applied():
    s = _session_with_proposal()
    with pytest.raises(ValueError):
        apply_decisions(s, [Decision("team", "founders_roles", "manual", "   ")])
    assert "founders_roles" in s.objects["team"].pending
    with pytest.raises(ValueError):
        apply_decisions(s, [Decision("team", "nope", "new")])


def test_pending_does_not_change_score():
    s = _session_with_proposal()
    before = evaluate_session(s).slot_coverage["team"]
    s.objects["team"].pending.clear()
    assert evaluate_session(s).slot_coverage["team"] == before


def test_chat_conflict_and_resolve_endpoint(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    client = TestClient(create_app(llm=StubExtractLLM()))
    sid = client.post("/api/sessions").json()["session"]["id"]
    client.post(f"/api/sessions/{sid}/turn", json={"text": "Wir sind zwei Gründer."})
    # PersonaPlex webhook disagrees with what the chat extraction stored -> proposal
    client.post(f"/api/sessions/{sid}/tool-webhook", json={
        "slot": "team", "fields": {"founders_roles": "CEO, CTO und CPO"}, "summary": "drei",
    })
    team = client.get(f"/api/sessions/{sid}").json()["objects"]["team"]
    assert team["fields"]["founders_roles"] == "CEO und CTO"
    assert team["pending"]["founders_roles"]["new"] == "CEO, CTO und CPO"

    bad = client.post(f"/api/sessions/{sid}/dossier/resolve", json={"decisions": [
        {"slot": "team", "field": "founders_roles", "choice": "manual", "manual_text": " "}]})
    assert bad.status_code == 400

    ok = client.post(f"/api/sessions/{sid}/dossier/resolve", json={"decisions": [
        {"slot": "team", "field": "founders_roles", "choice": "new"}]})
    assert ok.status_code == 200
    team = ok.json()["session"]["objects"]["team"]
    assert team["fields"]["founders_roles"] == "CEO, CTO und CPO" and not team["pending"]
    saved = client.get(f"/api/sessions/{sid}").json()["objects"]["team"]
    assert saved["fields"]["founders_roles"] == "CEO, CTO und CPO"
