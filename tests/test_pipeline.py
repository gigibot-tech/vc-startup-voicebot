import json
from pathlib import Path

from fastapi.testclient import TestClient

from startup_voice.domain import InterviewSession
from startup_voice.features.interview.pipeline import GREETING, InterviewPipeline
from startup_voice.features.dossier.scoring import evaluate_session
from startup_voice.features.sessions.store import FileSessionStore, evaluate_artifact_file
from startup_voice.features.voice.bridge import (
    KIND_INJECT,
    build_personaplex_functions_config,
    build_personaplex_headers,
    encode_inner_monologue_inject,
)
from startup_voice.web import create_app


class StubExtractLLM:
    """Deterministic LLM stand-in — extraction is structured, not keyword snippets."""

    def complete(self, system: str, user: str, *, max_tokens: int | None = None) -> str:
        if "extract" in system.lower() or "json only" in system.lower():
            return json.dumps(
                {
                    "updates": {
                        "team": {
                            "summary": "Zwei Gründer Vollzeit",
                            "evidence": ["CEO und CTO"],
                            "fields": {
                                "founders_roles": "CEO und CTO",
                                "background_expertise": "SaaS",
                                "commitment_fulltime": "Vollzeit",
                            },
                            "missing_or_vague": [],
                        },
                        "product": {
                            "summary": "MVP live",
                            "evidence": ["MVP live"],
                            "fields": {
                                "problem_solution": "SaaS Produkt",
                                "stage_status": "MVP live",
                                "usp_tech": "",
                            },
                            "missing_or_vague": ["usp_tech"],
                        },
                        "traction": {
                            "summary": "12 Piloten, 8k MRR",
                            "evidence": ["12 Pilotkunden", "8k MRR"],
                            "fields": {
                                "customers_pilots": "12 Pilotkunden",
                                "metrics_revenue": "8k MRR",
                                "growth_signal": "",
                            },
                            "missing_or_vague": ["growth_signal"],
                        },
                        "financing": {
                            "summary": "Seed 1.5M",
                            "evidence": ["Seed 1.5M", "Runway 18 Monate"],
                            "fields": {
                                "raise_amount_round": "Seed 1.5M",
                                "use_of_funds": "Sales",
                                "runway_milestones": "18 Monate",
                            },
                            "missing_or_vague": [],
                        },
                    }
                },
                ensure_ascii=False,
            )
        if "summarize" in system.lower() or "zusammenfassung" in system.lower():
            return "Kurze Zusammenfassung der Intake-Fakten."
        return "Danke. Wie groß ist der adressierbare Markt?"


class EmptyExtractLLM:
    """LLM that never invents dossier facts — for pollution checks."""

    def complete(self, system: str, user: str, *, max_tokens: int | None = None) -> str:
        if "extract" in system.lower() or "json only" in system.lower():
            return '{"updates":{}}'
        return "Danke. Erzählen Sie bitte kurz vom Team."


class DenialAwareLLM:
    """Stub that models correct LLM behaviour for nein/0 on traction."""

    def __init__(self) -> None:
        self.replies = 0

    def complete(self, system: str, user: str, *, max_tokens: int | None = None) -> str:
        lower = user.lower()
        if "extract" in system.lower() or "json only" in system.lower():
            if "nein" in lower or lower.strip().endswith("0") or "\n0" in lower:
                return json.dumps(
                    {
                        "updates": {
                            "traction": {
                                "summary": "Keine Traktion",
                                "evidence": ["nein/0"],
                                "fields": {
                                    "customers_pilots": "keine Pilotkunden",
                                    "metrics_revenue": "0 Umsatz",
                                    "growth_signal": "kein Wachstum",
                                },
                                "missing_or_vague": [],
                            }
                        }
                    },
                    ensure_ascii=False,
                )
            return '{"updates":{}}'
        self.replies += 1
        if self.replies == 1:
            return "Verstanden, noch keine Traktion. Wer ist Ihre Zielkundschaft?"
        return "Danke. Welche Finanzierungsrunde planen Sie?"


def test_fill_and_evaluate_writes_objects_and_steps(tmp_path: Path):
    store = FileSessionStore(tmp_path)
    pipe = InterviewPipeline(StubExtractLLM(), store)
    session, greeting = pipe.start_session()
    assert "HTGF" in greeting or "Analyst" in greeting

    session = pipe.process_turn(
        session,
        "Wir sind zwei Gründer Vollzeit, CEO und CTO mit SaaS-Hintergrund. "
        "MVP live, 12 Pilotkunden, 8k MRR, Seed 1.5M für Sales und Runway 18 Monate.",
    )
    base = store.session_dir(session.id)
    assert (base / "objects" / "team.json").exists()
    assert (base / "steps" / "turn_01.json").exists()
    assert (base / "dossier.md").exists()
    assert session.objects["team"].fields["founders_roles"] == "CEO und CTO"
    assert "Seed" not in (session.objects["product"].fields.get("problem_solution") or "")
    assert session.objects["financing"].fields["raise_amount_round"] == "Seed 1.5M"

    team_eval = evaluate_artifact_file(base / "objects" / "team.json")
    assert team_eval.field_coverage >= 0.0


def test_empty_extract_does_not_fill_from_greeting(tmp_path: Path):
    store = FileSessionStore(tmp_path)
    pipe = InterviewPipeline(EmptyExtractLLM(), store)
    session, _ = pipe.start_session()
    session = pipe.process_turn(session, GREETING)
    assert all(not any(o.fields.values()) for o in session.objects.values())
    cleared = pipe.clear_dossier(session)
    assert all(not any(o.fields.values()) for o in cleared.objects.values())


def test_llm_denial_on_traction_moves_on(tmp_path: Path):
    """LLM extract must store nein/0 — reply must not re-ask the same traction question."""
    store = FileSessionStore(tmp_path)
    llm = DenialAwareLLM()
    pipe = InterviewPipeline(llm, store)
    session, _ = pipe.start_session()
    session.evaluation.next_focus_slot = "traction"
    first = pipe.process_turn(session, "nein")
    assert first.objects["traction"].fields["customers_pilots"] == "keine Pilotkunden"
    q1 = first.messages[-1].content.lower()
    assert "pilotkunden belegen" not in q1
    second = pipe.process_turn(first, "0")
    q2 = second.messages[-1].content
    assert q1 != q2.strip().lower()


def test_evaluate_session_marks_solid_when_complete():
    session = InterviewSession.create()
    for slot, state in session.objects.items():
        for key in list(state.fields):
            state.fields[key] = f"konkret 42 {key}"
        state.summary = "belastbar mit 10 Kunden und 5k MRR"
        state.evidence = ["10 Kunden", "5k MRR"]
        state.missing_or_vague = []
    result = evaluate_session(session)
    assert result.ready_for_closing is True
    assert result.status == "solid"


def test_next_focus_prefers_empty_slot_over_partial_team():
    """Breadth-first: filled-but-weak team must not block empty product."""
    session = InterviewSession.create()
    team = session.objects["team"]
    team.fields = {
        "founders_roles": "solo IT founder",
        "background_expertise": "TU Berlin absolvent",
        "commitment_fulltime": "student",
    }
    team.missing_or_vague = []
    result = evaluate_session(session)
    assert result.next_focus_slot == "product"


def test_personaplex_bridge_headers_and_inject():
    cfg = build_personaplex_functions_config(
        webhook_base="http://127.0.0.1:8140", session_id="abc123"
    )
    assert cfg["functions"][0]["name"] == "save_startup_dimension"
    headers = build_personaplex_headers(text_prompt="Hallo", functions_config=cfg)
    assert "X-Functions" in headers and "X-Text-Prompt" in headers
    frame = encode_inner_monologue_inject("Nächste Frage?")
    assert frame[0] == KIND_INJECT
    assert frame[1:].decode("utf-8") == "Nächste Frage?"


def test_api_turn_and_webhook(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    client = TestClient(create_app(llm=StubExtractLLM()))
    started = client.post("/api/sessions").json()
    sid = started["session"]["id"]
    listed = client.get("/api/sessions").json()
    assert any(item["id"] == sid for item in listed["sessions"])
    turned = client.post(f"/api/sessions/{sid}/turn", json={"text": "Team aus zwei Gründern Vollzeit."})
    assert turned.status_code == 200
    assert turned.json()["reply"]
    wh = client.post(
        f"/api/sessions/{sid}/tool-webhook",
        json={
            "slot": "traction",
            "summary": "12 Pilotkunden, 8k MRR",
            "evidence": ["12 Piloten", "8k MRR"],
            "fields": {
                "customers_pilots": "12 Piloten",
                "metrics_revenue": "8k MRR",
                "growth_signal": "MoM +15%",
            },
        },
    )
    assert wh.status_code == 200
    assert wh.json()["inject_text"]
    steps = client.get(f"/api/sessions/{sid}/steps").json()
    assert steps["steps"]
    dossier = client.get(f"/api/sessions/{sid}/dossier.md")
    assert dossier.status_code == 200
    assert "Team" in dossier.text or "team" in dossier.text.lower()
    assert "founders_roles" not in dossier.text
    pdf = client.get(f"/api/sessions/{sid}/dossier.pdf")
    assert pdf.status_code == 200
    assert pdf.headers["content-type"].startswith("application/pdf")
    assert pdf.content[:4] == b"%PDF"
    schema = client.get("/api/dossier-schema")
    assert schema.status_code == 200
    assert schema.json()["slots"][0]["fields"][0]["label"]
    cfg = client.get("/api/interview-config")
    assert cfg.status_code == 200
    assert "reply_system_prompt" in cfg.json()
    assert "team" in cfg.json()["slot_questions"]
    patched = client.put(
        "/api/interview-config",
        json={
            **cfg.json(),
            "greeting": "Test-Hallo.",
            "slot_questions": {**cfg.json()["slot_questions"], "team": "Wer seid ihr?"},
        },
    )
    assert patched.status_code == 200
    assert patched.json()["greeting"] == "Test-Hallo."
    assert patched.json()["slot_questions"]["team"] == "Wer seid ihr?"
    reset = client.post("/api/interview-config/reset")
    assert reset.status_code == 200
    assert "HTGF" in reset.json()["greeting"] or "Intake" in reset.json()["greeting"]
    deleted = client.delete(f"/api/sessions/{sid}")
    assert deleted.status_code == 200
    assert client.get(f"/api/sessions/{sid}").status_code == 404


class RecordingLLM:
    """Records the system prompt of every reply/summary call."""

    def __init__(self) -> None:
        self.systems: list[str] = []

    def complete(self, system: str, user: str, *, max_tokens: int | None = None) -> str:
        if "extract" in system.lower() or "json only" in system.lower():
            return '{"updates":{}}'
        self.systems.append(system)
        return "ok"


def test_normalize_language():
    from startup_voice.language import normalize_language

    assert normalize_language("en-US") == "en"
    assert normalize_language("EN") == "en"
    assert normalize_language("de-DE") == "de"
    assert normalize_language("") == "de"
    assert normalize_language(None) == "de"
    assert normalize_language("fr") == "de"


def test_english_session_uses_english_greeting_reply_prompt_and_summary(tmp_path: Path):
    llm = RecordingLLM()
    pipe = InterviewPipeline(llm, FileSessionStore(tmp_path))
    session, greeting = pipe.start_session(language="en-US")
    assert session.language == "en"
    assert greeting.startswith("Hello") and "HTGF" in greeting

    session = pipe.process_turn(session, "We are two founders.")
    assert "LANGUAGE OVERRIDE" in llm.systems[-1] and "English" in llm.systems[-1]

    pipe.finalize_session(session)
    assert "in English" in llm.systems[-1]


def test_german_session_keeps_configured_greeting_and_prompt(tmp_path: Path):
    llm = RecordingLLM()
    pipe = InterviewPipeline(llm, FileSessionStore(tmp_path))
    session, greeting = pipe.start_session()
    assert session.language == "de"
    assert greeting == GREETING
    session = pipe.process_turn(session, "Wir sind zwei Gründer.")
    assert "LANGUAGE OVERRIDE" not in llm.systems[-1]
    pipe.finalize_session(session)
    assert "in German" in llm.systems[-1]


def test_api_start_session_language_and_tts_language(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    client = TestClient(create_app(llm=RecordingLLM()))
    en = client.post("/api/sessions", json={"language": "en-US"}).json()
    assert en["session"]["language"] == "en" and en["reply"].startswith("Hello")
    de = client.post("/api/sessions").json()  # body optional (older clients)
    assert de["session"]["language"] == "de"
    assert client.get(f"/api/sessions/{en['session']['id']}").json()["language"] == "en"

    seen: dict = {}
    monkeypatch.setattr("startup_voice.features.voice.routes.probe_tts_fast", lambda: {"ok": True})
    monkeypatch.setattr(
        "startup_voice.features.voice.routes.synthesize_mp3",
        lambda text, **kw: seen.update(kw) or b"mp3",
    )
    r = client.post("/api/tts", json={"text": "Hello", "language": "en"})
    assert r.status_code == 200 and seen["language"] == "en"


class StreamingStubLLM(StubExtractLLM):
    def stream(self, system: str, user: str, *, max_tokens: int | None = None):
        yield from ["  Danke. ", "Wie groß ", "ist der Markt?"]


def test_stream_turn_yields_chunks_and_persists(tmp_path: Path):
    pipe = InterviewPipeline(StreamingStubLLM(), FileSessionStore(tmp_path))
    session, _ = pipe.start_session()
    chunks = list(pipe.stream_turn(session, "Wir sind zwei Gründer."))
    assert chunks == ["Danke. ", "Wie groß ", "ist der Markt?"]
    assert session.messages[-1].content == "Danke. Wie groß ist der Markt?"
    assert session.turn_index == 1


def test_api_turn_stream_sse(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    client = TestClient(create_app(llm=StreamingStubLLM()))
    sid = client.post("/api/sessions").json()["session"]["id"]
    r = client.post(f"/api/sessions/{sid}/turn/stream", json={"text": "Wir sind zwei Gründer."})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    assert r.text.count("event: delta") == 3
    assert "event: done" in r.text
    saved = client.get(f"/api/sessions/{sid}").json()
    assert saved["messages"][-1]["content"] == "Danke. Wie groß ist der Markt?"


def test_api_turn_stream_falls_back_without_stream_method(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    client = TestClient(create_app(llm=StubExtractLLM()))
    sid = client.post("/api/sessions").json()["session"]["id"]
    r = client.post(f"/api/sessions/{sid}/turn/stream", json={"text": "Hallo"})
    assert "event: delta" in r.text and "event: done" in r.text
