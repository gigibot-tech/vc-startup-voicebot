"""Real intake-style turns (iDoo founder dumps) — coverage + ASK_NOW after extract.

These mirror the spoken transcripts used in manual QA: long product / journey answers
must fill Produkt and steer the next question off Produkt (no mega re-probe).
"""

from __future__ import annotations

import json
from pathlib import Path

from startup_voice.domain import DIMENSIONS_SPEC, InterviewSession
from startup_voice.features.dossier.scoring import evaluate_session, refresh_evaluation
from startup_voice.features.interview.pipeline import InterviewPipeline
from startup_voice.features.interview.prompts import (
    DEFAULT_REPLY_SYSTEM,
    build_reply_prompt,
    pick_ask_focus,
)
from startup_voice.features.sessions.store import FileSessionStore

# --- founder speech (tone of the manual QA pastes) ---------------------------------

IDOO_PRODUCT = (
    "So we are trying to solve the problem that people-- everyone has ideas, maybe not "
    "all of the time, but like many people have ideas, and, um, they usually lose them. "
    "So we want to create a place where they can save their ideas, and not only save, "
    "because an idea that is not out there is not worth anything. They can also start "
    "working on their idea based on the best practices for startup development. And we "
    "currently have a product, it's already live, and the advantage, uh, that makes it "
    "unique is that you can, as I said, not only, uh, write down your idea, you already "
    "have an idea development path that is supported by AI. And after that, you can even "
    "apply for funding. So we have a database of funding opportunities that, um, that, "
    "that can be matched to what you're currently working on, and you can already start "
    "applying, uh, to these opportunities directly from within iDoo, uh, which is not "
    "something that is commonly available out there."
)

IDOO_JOURNEY = (
    "Of course. So the problem is that founders, uh, have ideas and they don't "
    "necessarily know what is the next step to work on them. So the problem is not "
    "knowing what to do next, and we are currently helping them to know what to do next "
    "based on our idea development journey. So when they go to IDO and they type down an "
    "idea, they already have a, um, idea development journey that is generated for them. "
    "And after each step that they complete, there is a next step to be done. And the "
    "typical user j- u- user journey is, I add an idea, answer a few questions on it, "
    "and then you do each of the lessons on each of the phases. And by the end, when you "
    "complete all of the phases, then you're, in theory, ready to apply for a program. "
    "So you can go to the, um, program, uh, database. You can find a program that was "
    "matched to you. We give you a percentage of how much you have, um, uh, how much "
    "does your idea match to this program's criteria. And you can then start filling out "
    "your application form for that grant using the content of your idea that is already "
    "stored within IDO. So you don't have to keep on searching throughout your, uh, "
    "documents and everything that you have written before. We have an AI assistant that "
    "helps you to fill out that form. And then when you're done fill-filling it out, you "
    "can apply and hopefully get the funding."
)

IDOO_TEAM = (
    "We're two founders, Andrea and Shion. I'm more product and AI, Shion does growth. "
    "Both of us full-time on iDoo right now."
)

IDOO_TRACTION = (
    "We already have live users on the product — early stage, no real MRR yet, but "
    "pilots with founders saving ideas. Growth is mostly word of mouth for now."
)

IDOO_MARKET = (
    "ICP is early-stage founders and idea people who lose track of next steps. "
    "Market is large — basically anyone with a startup idea. Competitors are notes apps "
    "and generic AI chat; our moat is the guided journey plus funding match in one place."
)


def _product_full() -> dict:
    return {
        "problem_solution": "Ideas get lost; iDoo saves + develops them",
        "stage_status": "Product live",
        "usp_tech": "AI idea path + in-app funding apply",
    }


def _extract_product_payload() -> str:
    return json.dumps(
        {
            "updates": {
                "product": {
                    "summary": "iDoo live — ideas + AI path + funding",
                    "evidence": ["product already live", "AI development path", "funding match"],
                    "fields": _product_full(),
                    "confidence": {k: 0.9 for k in _product_full()},
                    "missing_or_vague": [],
                },
                "financing": {
                    "summary": "In-app funding DB + apply",
                    "evidence": ["funding opportunities matched", "apply from within iDoo"],
                    "fields": {
                        "raise_amount_round": "",
                        "use_of_funds": "Apply to matched programs from iDoo",
                        "runway_milestones": "",
                    },
                    "confidence": {"use_of_funds": 0.7},
                    "missing_or_vague": ["raise_amount_round", "runway_milestones"],
                },
            },
            "belege": {"product": 0.85, "financing": 0.45},
        },
        ensure_ascii=False,
    )


def _extract_journey_payload() -> str:
    return json.dumps(
        {
            "updates": {
                "product": {
                    "summary": "Idea journey → program apply",
                    "evidence": ["idea development journey", "AI fills grant form"],
                    "fields": {
                        "problem_solution": "Founders don't know next step; journey guides them",
                        "stage_status": "Live product with phases/lessons",
                        "usp_tech": "Generated journey + match % + AI grant form",
                    },
                    "confidence": {
                        "problem_solution": 0.92,
                        "stage_status": 0.9,
                        "usp_tech": 0.9,
                    },
                    "missing_or_vague": [],
                },
                "financing": {
                    "summary": "Program match + grant apply in-app",
                    "evidence": ["match percentage", "AI assistant fills form"],
                    "fields": {
                        "raise_amount_round": "Grant / program applications",
                        "use_of_funds": "Fill and submit grant forms from idea content",
                        "runway_milestones": "Complete phases then apply",
                    },
                    "confidence": {
                        "raise_amount_round": 0.75,
                        "use_of_funds": 0.85,
                        "runway_milestones": 0.7,
                    },
                    "missing_or_vague": [],
                },
            },
            "belege": {"product": 0.9, "financing": 0.8},
        },
        ensure_ascii=False,
    )


class IdooStubLLM:
    """Extract returns iDoo facts; reply records ASK_NOW from the user prompt."""

    def __init__(self) -> None:
        self.reply_users: list[str] = []
        self.reply_systems: list[str] = []
        self._extract_n = 0

    def complete(self, system: str, user: str, *, max_tokens: int | None = None) -> str:
        sys_l = system.lower()
        if "extract" in sys_l or "json only" in sys_l or '"updates"' in sys_l[:80].lower():
            self._extract_n += 1
            # Prefer the latest statement only (history still contains earlier dumps).
            # Marker is literally: "Latest founder statement (SOURCE OF TRUTH):\n…"
            marker = "Latest founder statement (SOURCE OF TRUTH):"
            latest = user.split(marker, 1)[-1] if marker in user else user
            low = latest.lower()
            if self._extract_n == 1:
                return _extract_product_payload()
            if self._extract_n == 2:
                return _extract_journey_payload()
            if self._extract_n == 3 or "andrea" in low or "shion" in low:
                return json.dumps(
                    {
                        "updates": {
                            "team": {
                                "summary": "Andrea + Shion full-time",
                                "evidence": ["two founders", "full-time"],
                                "fields": {
                                    "founders_roles": "Andrea product/AI, Shion growth",
                                    "background_expertise": "product/AI + growth",
                                    "commitment_fulltime": "both full-time",
                                },
                                "missing_or_vague": [],
                            }
                        },
                        "belege": {"team": 0.85},
                    },
                    ensure_ascii=False,
                )
            if self._extract_n == 4 or "mrr" in low or "word of mouth" in low:
                return json.dumps(
                    {
                        "updates": {
                            "traction": {
                                "summary": "Live users, no MRR yet",
                                "evidence": ["live users", "no real MRR"],
                                "fields": {
                                    "customers_pilots": "early live users / founder pilots",
                                    "metrics_revenue": "0 / no real MRR yet",
                                    "growth_signal": "word of mouth",
                                },
                                "missing_or_vague": [],
                            }
                        },
                        "belege": {"traction": 0.7},
                    },
                    ensure_ascii=False,
                )
            if self._extract_n == 5 or "icp" in low or "competitors" in low or "moat" in low:
                return json.dumps(
                    {
                        "updates": {
                            "market": {
                                "summary": "Early founders; notes+AI competitors",
                                "evidence": ["ICP early-stage founders", "moat journey+funding"],
                                "fields": {
                                    "target_icp": "early-stage founders / idea people",
                                    "market_size": "large — anyone with a startup idea",
                                    "competitors_moat": "notes apps + generic AI; moat=journey+funding",
                                },
                                "missing_or_vague": [],
                            }
                        },
                        "belege": {"market": 0.8},
                    },
                    ensure_ascii=False,
                )
            return '{"updates":{},"belege":{}}'
        if "belege" in sys_l and "score" in sys_l:
            return json.dumps(
                {"belege": {"team": 0.8, "product": 0.9, "traction": 0.7, "market": 0.8, "financing": 0.75}},
                ensure_ascii=False,
            )
        # Reply call
        self.reply_systems.append(system)
        self.reply_users.append(user)
        ask_line = next((ln for ln in user.splitlines() if ln.startswith("ASK_NOW")), "")
        # Must not re-probe Produkt when coverage is full — ask next gap.
        if ": product" in ask_line:
            return (
                "Produkt ist klar — iDoo live mit AI-Pfad. "
                "Wer gründet mit welchen Rollen, und arbeitet ihr Vollzeit daran?\n"
                "[[dossier:yes]]"
            )
        if ": team" in ask_line:
            return (
                "Verstanden. Wer gründet (Namen/Rollen) und seid ihr Vollzeit daran?\n"
                "[[dossier:yes]]"
            )
        if ": traction" in ask_line:
            return (
                "Danke. Habt ihr schon Nutzer oder Piloten — und Umsatz/MRR, auch 0 ist ok?\n"
                "[[dossier:yes]]"
            )
        if ": market" in ask_line:
            return (
                "Kurz zum Markt: wer ist eure ICP, und wer sind die wichtigsten Wettbewerber?\n"
                "[[dossier:yes]]"
            )
        if ": financing" in ask_line:
            return (
                "Zu Finanzierung: welche Runde/Betrag plant ihr, und wofür das Geld?\n"
                "[[dossier:yes]]"
            )
        return "Danke. Was fehlt noch im Dossier?\n[[dossier:yes]]"


def test_coverage_is_filled_over_required_fields():
    session = InterviewSession.create(language="en")
    for key, val in _product_full().items():
        session.objects["product"].fields[key] = val
    session.objects["product"].missing_or_vague = []
    session.objects["product"].belege = 0.85
    ev = evaluate_session(session)
    assert ev.slot_coverage["product"] == 1.0
    assert ev.next_focus_slot != "product"


def test_pick_ask_focus_leaves_full_product():
    cov = {"team": 0.0, "product": 1.0, "traction": 0.0, "market": 0.0, "financing": 0.0}
    ask = pick_ask_focus(prior_focus="product", coverages=cov, missing_in_focus=[])
    assert ask == "team"


def test_build_reply_prompt_ask_now_not_product_when_product_full():
    session = InterviewSession.create(language="en")
    for key, val in _product_full().items():
        session.objects["product"].fields[key] = val
    session.objects["product"].missing_or_vague = []
    session.objects["product"].belege = 0.9
    refresh_evaluation(session)
    _system, user = build_reply_prompt(
        session,
        IDOO_PRODUCT,
        "product",
        reply_system_prompt=DEFAULT_REPLY_SYSTEM,
        followup_mode="balanced",
        slot_question=DIMENSIONS_SPEC["product"].prompt_hints[0],
    )
    ask_line = next(ln for ln in user.splitlines() if ln.startswith("ASK_NOW"))
    assert ": team" in ask_line, ask_line
    assert "already_answered" in user
    assert "product.problem_solution" in user


def test_idoo_turn1_fills_product_then_turn2_leaves_product(tmp_path: Path):
    """Reply runs before extract; after Produkt is full, the *next* ASK_NOW leaves it."""
    store = FileSessionStore(tmp_path)
    llm = IdooStubLLM()
    pipe = InterviewPipeline(llm, store)
    session, _ = pipe.start_session(language="en")
    session.evaluation.next_focus_slot = "product"
    session = pipe.process_turn(session, IDOO_PRODUCT)

    prod = session.objects["product"]
    assert all((prod.fields.get(f) or "").strip() for f in DIMENSIONS_SPEC["product"].required_fields)
    assert session.evaluation.slot_coverage["product"] == 1.0
    assert llm.reply_users, "reply LLM must run (Thinking…) before extract"

    session = pipe.process_turn(session, IDOO_JOURNEY)
    ask_line = next(ln for ln in llm.reply_users[-1].splitlines() if ln.startswith("ASK_NOW"))
    assert ": product" not in ask_line, (
        f"must not re-ask Produkt once coverage is full, got {ask_line!r}"
    )
    reply = session.messages[-1].content.lower()
    assert "bereits live befindlichen produkt das problem" not in reply
    assert "wie genau löst ihr" not in reply


def test_idoo_five_turns_breadth(tmp_path: Path):
    """Five founder turns in the pasted style should leave no empty slots."""
    store = FileSessionStore(tmp_path)
    llm = IdooStubLLM()
    pipe = InterviewPipeline(llm, store)
    session, _ = pipe.start_session(language="en")
    session.evaluation.next_focus_slot = "product"

    turns = [IDOO_PRODUCT, IDOO_JOURNEY, IDOO_TEAM, IDOO_TRACTION, IDOO_MARKET]
    for text in turns:
        session = pipe.process_turn(session, text)

    cov = session.evaluation.slot_coverage
    assert cov["product"] == 1.0
    assert cov["team"] == 1.0
    assert cov["traction"] == 1.0
    assert cov["market"] == 1.0
    # financing filled from product/journey extracts
    assert cov["financing"] >= 2 / 3

    # From turn 2 on, product is already full → ASK_NOW must leave it
    for user in llm.reply_users[1:]:
        ask_line = next((ln for ln in user.splitlines() if ln.startswith("ASK_NOW")), "")
        assert ": product" not in ask_line, ask_line


def test_market_turn8_gap_queue_surfaces_financing_as_next_slot():
    """Reproduces session 13ad8598748c turn 8: market is ASK_NOW pre-extract,
    but Founder just answered market size + moat ('großer markt an universitäten…
    andere platformen haben meistens nur matching'). GAP_QUEUE must hand the
    reply LLM NEXT_SLOT=financing so it jumps instead of echoing/re-asking market.
    """
    from startup_voice.features.dossier.review import merge_slot_update
    from startup_voice.features.interview.prompts import build_gap_queue

    session = InterviewSession.create(language="de")
    for s in ("team", "product", "traction"):
        for f in DIMENSIONS_SPEC[s].required_fields:
            session.objects[s].fields[f] = "filled"
        session.objects[s].belege = 0.9
    session.objects["market"].fields["target_icp"] = "Founders with ideas"
    session.objects["market"].belege = 0.8
    session.objects["financing"].fields["use_of_funds"] = "Kampagnen"
    session.objects["financing"].belege = 0.7
    refresh_evaluation(session)
    assert session.evaluation.next_focus_slot == "market"

    q = build_gap_queue(session, primary="market")
    assert [entry["slot"] for entry in q] == ["market", "financing"]
    assert q[1]["missing_fields"] == ["raise_amount_round", "runway_milestones"]

    utterance = (
        "großer markt an universitäten in deutschland + science und startups "
        "oder andere platformen haben meistens nur matching"
    )
    sys_prompt, user_prompt = build_reply_prompt(
        session,
        utterance,
        "market",
        reply_system_prompt=DEFAULT_REPLY_SYSTEM,
        followup_mode="balanced",
        slot_question="",
    )
    assert "NEXT_SLOT if Founder just answered ASK_NOW: financing" in user_prompt
    assert "GAP_QUEUE" in user_prompt
    assert "NOT in dossier yet — credit this first!" in user_prompt
    assert "jump to NEXT_SLOT" in sys_prompt

    # Also guard the string-evidence bug seen in 13ad8598748c ("S","o","u","r"…)
    merge_slot_update(
        session.objects["market"],
        {"evidence": "großer markt an universitäten"},
        turn=8,
    )
    assert "S" not in session.objects["market"].evidence
    assert "großer markt an universitäten" in session.objects["market"].evidence


def test_turn10_belege_not_wiped_and_end_triggers_after_dossier_update(tmp_path: Path):
    """Reproduces turn 10 of 13ad8598748c:
    1) Extract emits belege=0.0 + summary='Team nicht genannt' for untouched slots.
       Prior belege/summary must survive so ready_for_closing flips True once all
       fields are filled.
    2) stream_turn yields post-extract session; SSE done must set offer_end=True
       automatically after the dossier update.
    """
    from startup_voice.features.dossier.review import apply_extract_updates
    from startup_voice.features.dossier.scoring import refresh_evaluation

    session = InterviewSession.create(language="de")
    for s in ("team", "product", "traction", "market"):
        for f in DIMENSIONS_SPEC[s].required_fields:
            session.objects[s].fields[f] = f"{s}.{f} ok"
        session.objects[s].summary = f"{s} solid summary"
        session.objects[s].belege = 0.85
    # Financing missing raise + milestones before turn 10
    session.objects["financing"].fields["use_of_funds"] = "Kampagnen"
    session.objects["financing"].belege = 0.7
    refresh_evaluation(session)
    assert session.evaluation.ready_for_closing is False

    # Turn 10 extract: fills financing, but LLM returns 0.0 belege + "nicht genannt" for team/product
    apply_extract_updates(
        session,
        {
            "team": {"summary": "Team nicht genannt", "fields": {}},
            "product": {"summary": "Produkt nicht genannt", "fields": {}},
            "financing": {
                "summary": "Seed für 3 Unis / 60 Nutzer",
                "fields": {
                    "raise_amount_round": "Seed",
                    "runway_milestones": "3 Universitäten, ~60 Benutzer",
                },
            },
        },
        {"team": 0.0, "product": 0.0, "traction": 0.8, "market": 0.8, "financing": 0.8},
        turn=10,
    )
    ev = refresh_evaluation(session)
    assert session.objects["team"].belege == 0.85
    assert session.objects["team"].summary == "team solid summary"
    assert ev.field_coverage == 1.0
    assert ev.ready_for_closing is True


def test_finalize_creates_multiple_timestamped_dossier_versions(tmp_path: Path, monkeypatch):
    """Each 'Dossier abschließen' writes a new vXX_<ts>_dossier.{md,json,pdf} without overwriting prior ones."""
    from fastapi.testclient import TestClient
    from startup_voice.web import create_app

    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    client = TestClient(create_app(llm=IdooStubLLM()))
    sid = client.post("/api/sessions", json={"language": "de"}).json()["session"]["id"]
    client.post(f"/api/sessions/{sid}/turn", json={"text": IDOO_PRODUCT})

    f1 = client.post(f"/api/sessions/{sid}/finalize").json()["session"]
    assert len(f1["dossier_versions"]) == 1
    v1 = f1["dossier_versions"][0]
    assert v1["version"] == 1 and v1["id"].startswith("v01_")

    # Continue chatting and finalize a second version
    client.post(f"/api/sessions/{sid}/turn", json={"text": IDOO_TEAM})
    f2 = client.post(f"/api/sessions/{sid}/finalize").json()["session"]
    assert len(f2["dossier_versions"]) == 2
    v2 = f2["dossier_versions"][1]
    assert v2["version"] == 2 and v2["id"].startswith("v02_")

    dossiers_dir = tmp_path / sid / "dossiers"
    assert (dossiers_dir / f"{v1['id']}_dossier.md").is_file()
    assert (dossiers_dir / f"{v1['id']}_dossier.json").is_file()
    assert (dossiers_dir / f"{v2['id']}_dossier.md").is_file()
    assert (dossiers_dir / f"{v2['id']}_dossier.json").is_file()

    # Both versions downloadable via HTTP
    r_md1 = client.get(f"/api/sessions/{sid}/dossiers/{v1['id']}.md")
    r_json2 = client.get(f"/api/sessions/{sid}/dossiers/{v2['id']}.json")
    assert r_md1.status_code == 200 and "HTGF" in r_md1.text
    assert r_json2.status_code == 200 and r_json2.json()["turn_index"] >= 2

    # Clicking 'Weiter fragen' (/continue) appends a new analyst question
    before_msgs = len(f2["messages"])
    cont = client.post(f"/api/sessions/{sid}/continue")
    assert cont.status_code == 200
    body = cont.json()
    assert body["reply"]
    assert len(body["session"]["messages"]) == before_msgs + 1
    assert body["session"]["messages"][-1]["role"] == "assistant"


def test_context_and_token_limit_warning_embedded_in_assistant_message(tmp_path: Path, monkeypatch):
    """When the LLM hits done_reason='length' or nears LLM_CONTEXT_WINDOW, the warning line
    is attached to the assistant TurnMessage (and NEVER spoken via TTS).
    """
    from startup_voice.features.interview.llm import ConfigurableLLM, resolve_context_window

    monkeypatch.setenv("LLM_MODEL", "granite4.2:8b")
    monkeypatch.setenv("LLM_CONTEXT_WINDOW", "1000")
    assert resolve_context_window("granite4.2:8b") == 1000

    llm = ConfigurableLLM(model="granite4.2:8b")
    llm._record_meta(
        done_reason="length",
        prompt_tokens=820,
        completion_tokens=120,
        max_tokens=120,
        output="Cut off mid-",
    )
    assert llm.last_meta["truncated"] is True
    assert llm.last_meta["near_context_limit"] is True
    assert "granite4.2:8b" in llm.last_meta["warning"]
    assert "1000" in llm.last_meta["warning"]

    class TruncatingStub(IdooStubLLM):
        def __init__(self) -> None:
            super().__init__()
            self.last_meta = {"warning": ""}

        def complete(self, system: str, user: str, *, max_tokens: int | None = None) -> str:
            out = super().complete(system, user, max_tokens=max_tokens)
            if "extract" not in system.lower():
                self.last_meta = {
                    "warning": "Kontext-/Tokenlimit erreicht (granite4.2:8b · ~940/1000 tok) — Antwort evtl. gekürzt"
                }
            else:
                self.last_meta = {"warning": ""}
            return out

    pipe = InterviewPipeline(TruncatingStub(), FileSessionStore(tmp_path))
    session, _ = pipe.start_session(language="de")
    session = pipe.process_turn(session, IDOO_PRODUCT)
    last_msg = session.messages[-1]
    assert last_msg.role == "assistant"
    assert "granite4.2:8b" in last_msg.warning
    assert "Kontext-/Tokenlimit" in last_msg.warning





