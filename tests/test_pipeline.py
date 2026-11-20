import json
from pathlib import Path

from fastapi.testclient import TestClient

from startup_voice.domain import InterviewSession, TurnMessage
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
                                "problem": "SaaS Produkt",
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
    assert "Analyst" in greeting

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
    assert "Seed" not in (session.objects["product"].fields.get("problem") or "")
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
        state.belege = 0.8
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
    assert "Intake" in reset.json()["greeting"]
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
    assert greeting.startswith("Hello") and "intake analyst" in greeting

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


def test_carry_dossier_starts_clean_chat_with_same_fields(tmp_path: Path):
    pipe = InterviewPipeline(StubExtractLLM(), FileSessionStore(tmp_path))
    source, _ = pipe.start_session()
    source.objects["financing"].fields["raise_amount_round"] = "200k Preseed"
    source.objects["financing"].summary = "Preseed 200k"
    source.messages.append(TurnMessage(role="user", content="preseed 200k und 3 Uni-Campusse"))
    source.turn_index = 4
    source.finalized = True
    pipe._store.save(source)

    carried, greeting = pipe.carry_dossier(source)
    assert carried.id != source.id
    assert carried.turn_index == 0
    assert carried.finalized is False
    assert carried.dossier_versions == []
    assert len(carried.messages) == 1
    assert carried.messages[0].role == "assistant"
    assert "übernommen" in greeting
    assert carried.objects["financing"].fields["raise_amount_round"] == "200k Preseed"
    reloaded = pipe._store.load(source.id)
    assert reloaded.turn_index == 4
    assert any(m.role == "user" for m in reloaded.messages)
    fresh = pipe._store.load(carried.id)
    assert fresh.objects["team"].fields["founders_roles"] == ""


def test_api_carry_dossier(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    client = TestClient(create_app(llm=StubExtractLLM()))
    sid = client.post("/api/sessions").json()["session"]["id"]
    r = client.post(f"/api/sessions/{sid}/carry")
    assert r.status_code == 200
    body = r.json()
    assert body["carried_from"] == sid
    assert body["session"]["id"] != sid
    assert body["session"]["messages"][0]["role"] == "assistant"
    assert client.get(f"/api/sessions/{sid}").json()["id"] == sid


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
    from startup_voice.features.interview.pipeline import EXTRACT_PHASE, ReplyDone

    pipe = InterviewPipeline(StreamingStubLLM(), FileSessionStore(tmp_path))
    session, _ = pipe.start_session()
    items = list(pipe.stream_turn(session, "Wir sind zwei Gründer."))
    assert any(isinstance(i, ReplyDone) for i in items)
    assert EXTRACT_PHASE in items  # stub has no [[dossier:no]] → default extract
    chunks = [c for c in items if isinstance(c, str)]
    assert chunks == ["Danke. ", "Wie groß ", "ist der Markt?"]
    assert session.messages[-1].content == "Danke. Wie groß ist der Markt?"
    assert session.turn_index == 1


def test_stream_turn_always_extracts_after_reply(tmp_path: Path):
    """Dossier always follows the spoken reply — even if the model wrote [[dossier:no]]."""
    from startup_voice.features.interview.pipeline import EXTRACT_PHASE, ReplyDone

    class NoDossierStream(StubExtractLLM):
        def stream(self, system: str, user: str, *, max_tokens: int | None = None):
            yield from ["Alles klar. ", "Wer gründet mit?\n[[dossier:no]]"]

    pipe = InterviewPipeline(NoDossierStream(), FileSessionStore(tmp_path))
    session, _ = pipe.start_session()
    items = list(pipe.stream_turn(session, "ok"))
    done = next(i for i in items if isinstance(i, ReplyDone))
    assert done.needs_extract is True
    assert done.reply == "Alles klar. Wer gründet mit?"
    assert EXTRACT_PHASE in items
    # Order: reply chunks → ReplyDone → EXTRACT_PHASE
    done_i = next(i for i, x in enumerate(items) if isinstance(x, ReplyDone))
    extract_i = items.index(EXTRACT_PHASE)
    assert done_i < extract_i


def test_extract_can_run_every_turn(tmp_path: Path):
    from startup_voice.features.interview.pipeline import EXTRACT_PHASE, ReplyDone

    class AlwaysYes(StubExtractLLM):
        def stream(self, system: str, user: str, *, max_tokens: int | None = None):
            yield "Danke.\n[[dossier:yes]]"

    pipe = InterviewPipeline(AlwaysYes(), FileSessionStore(tmp_path))
    session, _ = pipe.start_session()
    first = list(pipe.stream_turn(session, "Wir sind zwei Gründer."))
    assert EXTRACT_PHASE in first
    assert next(i for i in first if isinstance(i, ReplyDone)).needs_extract is True
    second = list(pipe.stream_turn(session, "Noch mehr Fakten."))
    assert EXTRACT_PHASE in second
    assert next(i for i in second if isinstance(i, ReplyDone)).needs_extract is True


def test_api_turn_stream_sse(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    client = TestClient(create_app(llm=StreamingStubLLM()))
    sid = client.post("/api/sessions").json()["session"]["id"]
    r = client.post(f"/api/sessions/{sid}/turn/stream", json={"text": "Wir sind zwei Gründer."})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    assert r.text.count("event: delta") == 3
    assert "event: reply" in r.text
    assert "Thinking…" in r.text
    assert '"phase": "extract"' in r.text or '"phase":"extract"' in r.text
    assert "Updating dossier" in r.text
    # Thinking… before extract
    assert r.text.index("Thinking…") < r.text.index("Updating dossier")
    assert "event: done" in r.text
    saved = client.get(f"/api/sessions/{sid}").json()
    assert saved["messages"][-1]["content"] == "Danke. Wie groß ist der Markt?"


def test_api_turn_stream_falls_back_without_stream_method(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    client = TestClient(create_app(llm=StubExtractLLM()))
    sid = client.post("/api/sessions").json()["session"]["id"]
    r = client.post(f"/api/sessions/{sid}/turn/stream", json={"text": "Hallo"})
    assert "event: delta" in r.text and "event: done" in r.text


def test_prepare_client_turn_returns_prompts_without_llm(tmp_path: Path):
    """Browser path: prepare records the user line and returns reply+extract prompts."""

    class NoCallLLM(StubExtractLLM):
        def complete(self, *a, **k):
            raise AssertionError("prepare must not call the LLM")

    pipe = InterviewPipeline(NoCallLLM(), FileSessionStore(tmp_path))
    session, _ = pipe.start_session()
    payload = pipe.prepare_client_turn(session, "Wir sind zwei Gründer.")
    assert payload["reply_system"]
    assert payload["reply_user"]
    assert "extract" in payload["extract_system"].lower() or "json" in payload["extract_system"].lower()
    assert payload["extract_user"]
    assert payload["focus"] in ("team", "product", "traction", "market", "financing")
    assert session.turn_index == 1
    assert session.messages[-1].role == "user"
    assert "zwei Gründer" in session.messages[-1].content


def test_commit_client_turn_applies_extract(tmp_path: Path):
    pipe = InterviewPipeline(StubExtractLLM(), FileSessionStore(tmp_path))
    session, _ = pipe.start_session()
    pipe.prepare_client_turn(session, "Wir sind zwei Gründer Vollzeit.")
    raw_reply = "Danke. Wie groß ist der Markt?\n[[dossier:yes]]"
    raw_extract = json.dumps(
        {
            "updates": {
                "team": {
                    "summary": "Zwei Gründer Vollzeit",
                    "evidence": ["Vollzeit"],
                    "fields": {
                        "founders_roles": "CEO und CTO",
                        "background_expertise": "SaaS",
                        "commitment_fulltime": "Vollzeit",
                    },
                    "missing_or_vague": [],
                }
            },
            "belege": {"team": 0.7},
        },
        ensure_ascii=False,
    )
    session, reply, offer_end = pipe.commit_client_turn(
        session, raw_reply=raw_reply, raw_extract=raw_extract
    )
    assert reply == "Danke. Wie groß ist der Markt?"
    assert session.messages[-1].role == "assistant"
    assert session.messages[-1].content == reply
    assert "Vollzeit" in (session.objects["team"].fields.get("commitment_fulltime") or "")
    assert isinstance(offer_end, bool)


def test_api_prepare_commit_roundtrip(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    client = TestClient(create_app(llm=StubExtractLLM()))
    sid = client.post("/api/sessions").json()["session"]["id"]
    prep = client.post(
        f"/api/sessions/{sid}/turn/prepare",
        json={"text": "Wir sind zwei Gründer."},
    )
    assert prep.status_code == 200
    body = prep.json()
    assert body["reply_system"] and body["extract_user"]
    commit = client.post(
        f"/api/sessions/{sid}/turn/commit",
        json={
            "raw_reply": "Danke. Nächste Frage?\n[[dossier:yes]]",
            "raw_extract": json.dumps(
                {
                    "updates": {
                        "team": {
                            "summary": "Zwei Gründer",
                            "evidence": ["zwei"],
                            "fields": {
                                "founders_roles": "CEO und CTO",
                                "background_expertise": "",
                                "commitment_fulltime": "",
                            },
                            "missing_or_vague": ["background_expertise"],
                        }
                    }
                }
            ),
            "text": "Wir sind zwei Gründer.",
        },
    )
    assert commit.status_code == 200
    data = commit.json()
    assert data["reply"] == "Danke. Nächste Frage?"
    assert data["session"]["messages"][-1]["content"] == "Danke. Nächste Frage?"
    assert "Zwei Gründer" in (data["session"]["objects"]["team"]["summary"] or "")


def test_prepare_continue_and_commit(tmp_path: Path):
    class NoCallLLM(StubExtractLLM):
        def complete(self, *a, **k):
            raise AssertionError("prepare_continue must not call the LLM")

    pipe = InterviewPipeline(NoCallLLM(), FileSessionStore(tmp_path))
    session, _ = pipe.start_session()
    payload = pipe.prepare_continue(session)
    assert payload["reply_system"] and payload["reply_user"]
    session, question = pipe.commit_continue(
        session, "Eine konkrete Nachfrage zum Markt?\n[[dossier:no]]"
    )
    assert question == "Eine konkrete Nachfrage zum Markt?"
    assert session.messages[-1].content == question


def test_fit_ollama_options_keeps_predict_inside_context():
    from startup_voice.features.interview.llm import fit_ollama_options

    opts = fit_ollama_options(
        context_window=4096,
        system="x" * 2000,
        user="y" * 6000,
        max_tokens=2600,
    )
    est = (2000 + 6000) // 3
    assert opts["num_ctx"] == 4096
    assert opts["num_predict"] == 4096 - est - 128
    assert opts["num_predict"] < 2600


def test_build_extract_user_uses_slot_gates_not_ask_now(tmp_path: Path):
    from startup_voice.features.interview.prompts import build_extract_user, build_slot_gates

    pipe = InterviewPipeline(StubExtractLLM(), FileSessionStore(tmp_path))
    session, _ = pipe.start_session()
    session.messages.append(TurnMessage(role="user", content="Wir sind zwei Gründer Vollzeit."))
    session.messages.append(TurnMessage(role="assistant", content="Wie steht das Produkt?"))
    session.messages.append(TurnMessage(role="user", content="MVP live für Unis."))
    prompt = build_extract_user(session, "MVP live für Unis.", "team", extract_mode="full")
    assert "SLOT_GATES" in prompt
    assert "ASK_NOW:" not in prompt
    assert "NEXT_SLOT" not in prompt
    assert "Current focus slot" not in prompt
    gates = build_slot_gates(session)
    assert [g["slot"] for g in gates] == ["team", "product", "traction", "market", "financing"]
    assert "look_for" in gates[0]


def test_on_demand_extract_focuses_lowest_coverage_gaps(tmp_path: Path):
    from startup_voice.features.interview.prompts import build_extract_user, build_missing_focus

    pipe = InterviewPipeline(StubExtractLLM(), FileSessionStore(tmp_path))
    session, _ = pipe.start_session()
    session.objects["team"].fields = {
        "founders_roles": "CEO und CTO",
        "background_expertise": "SaaS",
        "commitment_fulltime": "Vollzeit",
    }
    session.objects["product"].fields = {
        "problem": "SaaS für Unis",
        "solution": "Self-Service-Plattform für Studierende",
        "stage_status": "MVP live",
        "usp_tech": "",
    }
    session.objects["financing"].fields = {
        "raise_amount_round": "Seed 1.5M",
        "use_of_funds": "Sales",
        "runway_milestones": "18 Monate",
    }
    gaps = build_missing_focus(session)
    assert [g["slot"] for g in gaps] == ["traction", "market", "product"]
    assert gaps[0]["coverage"] == 0.0
    assert gaps[-1]["coverage"] == round(3 / 4, 3)  # product has 4 fields: problem, solution, stage, usp
    assert "usp_tech" in gaps[-1]["missing"]
    prompt = build_extract_user(session, "irgendwas", "team", full_transcript=True)
    assert "MISSING_FOCUS" in prompt
    assert "SLOT_GATES" not in prompt
    assert '"slot": "team"' not in prompt
    assert '"slot": "financing"' not in prompt
    assert prompt.index('"slot": "market"') < prompt.index('"slot": "product"')


def test_on_demand_extract_scans_full_conversation(tmp_path: Path):
    class CaptureLLM(StubExtractLLM):
        def __init__(self) -> None:
            self.last_system = ""
            self.last_user = ""

        def complete(self, system: str, user: str, *, max_tokens: int | None = None) -> str:
            self.last_system = system
            self.last_user = user
            return super().complete(system, user, max_tokens=max_tokens)

    llm = CaptureLLM()
    pipe = InterviewPipeline(llm, FileSessionStore(tmp_path))
    session, _ = pipe.start_session()
    session.messages.extend(
        [
            TurnMessage(role="user", content="Wir sind zwei Gründer Vollzeit."),
            TurnMessage(role="assistant", content="Wie steht das Produkt?"),
            TurnMessage(role="user", content="MVP live, SaaS für Unis."),
        ]
    )
    pipe.refresh_dossier_extract(session)
    assert "MISSING_FOCUS" in llm.last_user
    assert "SLOT_GATES" not in llm.last_user
    assert "Full conversation transcript" in llm.last_user
    assert "ASK_NOW:" not in llm.last_user
    assert "NEXT_SLOT" not in llm.last_user
    assert "zwei Gründer" in llm.last_user
    assert "MVP live" in llm.last_user
    prep = pipe.prepare_extract_only(session)
    assert "MISSING_FOCUS" in prep["extract_user"]
    assert "Full conversation transcript" in prep["extract_user"]
    assert "zwei Gründer" in prep["extract_user"]
    assert "MVP live" in prep["extract_user"]


def test_api_extract_dossier_uses_full_conversation(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))

    class CaptureLLM(StubExtractLLM):
        last_user = ""

        def complete(self, system: str, user: str, *, max_tokens: int | None = None) -> str:
            CaptureLLM.last_user = user
            return super().complete(system, user, max_tokens=max_tokens)

    client = TestClient(create_app(llm=CaptureLLM()))
    sid = client.post("/api/sessions").json()["session"]["id"]
    client.post(f"/api/sessions/{sid}/turn", json={"text": "Wir sind zwei Gründer."})
    client.post(f"/api/sessions/{sid}/turn", json={"text": "MVP live an drei Unis."})
    r = client.post(f"/api/sessions/{sid}/extract")
    assert r.status_code == 200
    assert r.json()["session"]["id"] == sid
    assert "MISSING_FOCUS" in CaptureLLM.last_user
    assert "Full conversation transcript" in CaptureLLM.last_user
    assert "zwei Gründer" in CaptureLLM.last_user
    assert "MVP live" in CaptureLLM.last_user


def test_next_reply_does_not_wait_for_the_previous_dossier_update(tmp_path: Path):
    """The founder keeps talking while the dossier updates: reply #2 finishes while update #1 still runs,
    and the updates themselves stay in turn order."""
    import threading

    from startup_voice.features.interview.pipeline import EXTRACT_PHASE, ReplyDone

    release_first = threading.Event()
    extract_started = threading.Event()
    log: list[str] = []

    class SlowFirstExtract(StreamingStubLLM):
        def complete(self, system: str, user: str, *, max_tokens: int | None = None, **kw) -> str:
            if "json only" in system.lower() or "extract" in system.lower():
                log.append("extract-start")
                if len(log) == 1:
                    extract_started.set()
                    assert release_first.wait(10), "update #1 was never released"
                log.append("extract-end")
            return super().complete(system, user, max_tokens=max_tokens)

    pipe = InterviewPipeline(SlowFirstExtract(), FileSessionStore(tmp_path))
    session, _ = pipe.start_session()
    first = threading.Thread(target=lambda: list(pipe.stream_turn(session, "Erste Antwort.")))
    first.start()
    assert extract_started.wait(10)

    seen: list = []
    second_reply_done = threading.Event()

    def second_turn():
        for item in pipe.stream_turn(session, "Zweite Antwort."):
            seen.append(item)
            if isinstance(item, ReplyDone):
                second_reply_done.set()

    second = threading.Thread(target=second_turn)
    second.start()
    assert second_reply_done.wait(5), "reply #2 must not wait for update #1"
    assert log == ["extract-start"], "update #2 must queue behind update #1"
    release_first.set()
    first.join(10)
    second.join(10)
    assert EXTRACT_PHASE in seen
    assert log == ["extract-start", "extract-end", "extract-start", "extract-end"]
