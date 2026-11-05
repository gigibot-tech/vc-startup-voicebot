"""Prompt strings + reply user-message builder for the interview LLM.

Per turn (pipeline.stream_turn / process_turn) — reply first, dossier always after:

    1. reply system     stream() / complete()           next spoken question (ASK_NOW)
       may end with [[dossier:yes|no]] / [[intake:end]] (stripped before TTS)
    2. EXTRACT_SYSTEM   complete(..., json_mode=True)   facts + belege → dossier (always)

Side paths (not part of the turn):
    SCORE_BELEGE_SYSTEM   after proposal resolve / tool write
    SUMMARY_SYSTEM        on „Dossier abschließen“

CAUTION: test stubs match on the words "extract", "json only", "summarize" in system.
"""

from __future__ import annotations

import json
import re
from typing import Any

from startup_voice.domain import DIMENSIONS_SPEC, SLOT_ORDER, InterviewSession, SlotId
from startup_voice.language import reply_prompt_suffix

# Trailing gates from the reply LLM (never spoken).
_DOSSIER_MARK_RE = re.compile(
    r"(?:\r?\n)?\s*\[\[\s*dossier\s*:\s*(yes|no)\s*\]\]\s*$",
    re.IGNORECASE,
)
_END_MARK_RE = re.compile(
    r"(?:\r?\n)?\s*\[\[\s*intake\s*:\s*end\s*\]\]\s*$",
    re.IGNORECASE,
)

# Appended to every reply system so custom prompts still emit the gate.
REPLY_DOSSIER_GATE = (
    "\n\nAfter the spoken reply, on its OWN last line write exactly [[dossier:yes]] "
    "if the founder's latest statement adds NEW facts for the HTGF dossier "
    "(team/product/traction/market/financing), else [[dossier:no]]. "
    "Say yes whenever there is new substance — dossier updates continue across the whole "
    "conversation. Never say that marker aloud."
)

# Offer end-of-intake (user chooses Continue vs Finalize in the UI — never auto-finalize).
REPLY_END_GATE = (
    "\n\nEND OF INTAKE (optional trailing marker):\n"
    "- When ready_for_closing is true, OR further questions would only rehash "
    "already_answered / empty-by-absence gaps with no useful probe left: speak a short "
    "wrap-up in the session language (e.g. dossier is ready — they can continue asking "
    "or finalize in the UI), then on its OWN last line write exactly [[intake:end]].\n"
    "- Do NOT finalize yourself. Do NOT keep drilling filled answers.\n"
    "- If ASK_NOW still has a real empty gap, ask 1–2 short questions and omit "
    "[[intake:end]].\n"
    "- Never say the marker aloud. Order of trailing lines if both apply: "
    "[[dossier:yes|no]] then [[intake:end]]."
)

# Always appended (even when reply_system_prompt is customized in interview_config.json).
# NOTE: avoid the substring "extract" here — test stubs dispatch on '"extract" in system.lower()'.
REPLY_NO_REASK = (
    "\n\nHARD RULE — reply before dossier update (dossier is 1 turn behind the latest statement):\n"
    "- Dossier fields reflect turns BEFORE 'Founder just said'. The founder's latest "
    "statement has NOT been merged into the dossier yet.\n"
    "- STEP 1: mentally credit whatever 'Founder just said' already answers "
    "(even qualitative answers like 'großer Markt an Unis', 'andere haben nur Matching', "
    "'2 Gründer nebenbei', 'kein Umsatz').\n"
    "- STEP 2: pick from GAP_QUEUE the first slot/field that is STILL unanswered after "
    "crediting STEP 1. If ASK_NOW was just answered in 'Founder just said', jump to "
    "NEXT_SLOT in GAP_QUEUE immediately.\n"
    "- NEVER echo/paraphrase 'Founder just said' and then re-ask the same slot for "
    "stricter numbers (no 'Sie sagen X — wie viele genau pro Jahr und welcher Moat?').\n"
    "- NEVER re-ask already_answered or a slot with coverage 1.0.\n"
    "- Low Belege or qualitative market/moat answers are NOT a reason to re-ask the same "
    "question when another slot in GAP_QUEUE is still incomplete."
)


def split_reply_dossier_mark(raw: str) -> tuple[str, bool]:
    """Strip ``[[dossier:yes|no]]``; return (spoken_text, needs_extract). Default: extract."""
    text = (raw or "").strip()
    match = _DOSSIER_MARK_RE.search(text)
    if not match:
        return text, True
    needs = match.group(1).lower() == "yes"
    return text[: match.start()].strip(), needs


def split_reply_intake_end(raw: str) -> tuple[str, bool]:
    """Strip ``[[intake:end]]``; return (spoken_text, offer_end)."""
    text = (raw or "").strip()
    match = _END_MARK_RE.search(text)
    if not match:
        return text, False
    return text[: match.start()].strip(), True


def split_reply_marks(raw: str) -> tuple[str, bool, bool]:
    """Strip trailing ``[[dossier:…]]`` / ``[[intake:end]]`` in any order.

    Returns ``(spoken_text, needs_extract, offer_end)``.
    Missing dossier mark → needs_extract True (safe default).
    """
    text = (raw or "").strip()
    offer_end = False
    needs_extract = True
    dossier_found = False
    for _ in range(6):
        m_end = _END_MARK_RE.search(text)
        m_dos = _DOSSIER_MARK_RE.search(text)
        if not m_end and not m_dos:
            break
        end_at = m_end.end() if m_end else -1
        dos_at = m_dos.end() if m_dos else -1
        if m_end and end_at >= dos_at:
            offer_end = True
            text = text[: m_end.start()].strip()
        elif m_dos:
            needs_extract = m_dos.group(1).lower() == "yes"
            dossier_found = True
            text = text[: m_dos.start()].strip()
    if not dossier_found:
        needs_extract = True
    return text, needs_extract, offer_end

# ---------------------------------------------------------------------------
# 1) EXTRACT - structured facts out of free speech (output must be parseable JSON)
# ---------------------------------------------------------------------------
EXTRACT_SYSTEM = (
    "Extract HTGF intake facts. Reply with ONE compact JSON object only — no markdown, no prose.\n"
    'Schema: {"updates":{"<slot>":{"summary":"≤60 chars","evidence":["≤12-word quote"],'
    '"fields":{"<field>":"≤60 chars or \"\""},'
    '"confidence":{"<field>":0.0},'
    '"missing_or_vague":["unset field"]}},'
    '"belege":{"<slot>":0.0}}\n'
    f"Slots/fields: {json.dumps({k: v.required_fields for k, v in DIMENSIONS_SPEC.items()}, ensure_ascii=False)}\n"
    "Rules:\n"
    "- SOURCE = latest founder statement only (ignore assistant text).\n"
    "- BREADTH FIRST: if the statement mentions several topics, emit updates for ALL of "
    "team, product, traction, market, financing that appear — never drop product/market/… "
    "just because focus was team.\n"
    "- Map synonyms: App/PoC/Website→product; Kunden/Leute/Traction→traction; "
    "ICP/Studenten/Unis/Markt/Competitors/Plattformen/nur Matching→market "
    "(e.g. 'andere Plattformen haben nur Matching' answers competitors_moat); "
    "EXIST/Runde/Funds/Milestones→financing.\n"
    "- HONEST FILL ONLY: write a field ONLY if the statement clearly answers THAT field. "
    "Empty string \"\" = null/unknown and is OK — prefer empty over guessing.\n"
    "- Explicit denial counts ONLY for the field the founder actually addressed "
    "(e.g. said 'noch keine Kunden' → traction customers; do NOT copy 'noch nicht' into "
    "team/product/market/financing). Never invent blanket 'noch nicht' / keine / 0 across "
    "unrelated fields.\n"
    "- Forbidden: same placeholder in multiple fields; filling to look complete; guessing.\n"
    "- Split facts across slots: team≠product≠traction≠market≠financing.\n"
    "- Unmentioned fields: \"\" + name in missing_or_vague. Omit untouched slots entirely.\n"
    "- confidence: for EVERY non-empty field you emit, rate 0.0–1.0 how sure you are the "
    "value is correct and complete from the statement (clear fact → high; guess/vague → low).\n"
    "- belege: for EVERY slot that has any content after this update (incl. prior facts in "
    "the transcript context), rate 0.0–1.0 how concrete and analyst-readable the evidence is "
    "(names, roles, numbers, stage, clear nein/0 → high; vague marketing prose → low). "
    "Empty/untouched slots: omit or 0. Do NOT use keyword lists — judge readability of facts.\n"
    "- Always finish with a complete, valid JSON object (no trailing cut-off)."
)

# Used when fields change without a full extract (proposal resolve / tool write).
SCORE_BELEGE_SYSTEM = (
    "Score HTGF dossier Belege quality. Reply with ONE JSON object only — no markdown.\n"
    'Schema: {"belege":{"team":0.0,"product":0.0,"traction":0.0,"market":0.0,"financing":0.0}}\n'
    "For each slot, rate 0.0–1.0 how concrete and analyst-readable the filled fields/"
    "summary/evidence are (names, numbers, clear denials → high; empty or vague → low/0). "
    "Judge substance and readability — not keyword presence."
)

SUMMARY_SYSTEM = (
    "Summarize the startup intake in {language} for SPOKEN delivery in 4–6 concise "
    "sentences (strengths, open gaps, concrete next steps). Plain spoken prose only — "
    "no markdown, no bullet lists, Always finish the last sentence cleanly."
)

CONTINUE_QUESTION_SYSTEM = (
    "You are an HTGF VC analyst in a spoken intake call ({language}).\n"
    "The founder clicked 'Continue asking' to go one level deeper.\n"
    "- If any dossier field is still empty, ask 1–2 short spoken questions to fill it.\n"
    "- If all fields are already filled, ask ONE sharp, concrete VC follow-up question "
    "on the weakest or most qualitative slot (e.g. exact Seed ticket & runway months, "
    "pilot-to-paid conversion at universities, concrete unit economics, or defensibility).\n"
    "- Never repeat your last question. Plain spoken {language}, ≤2 sentences, no markdown."
)

# ---------------------------------------------------------------------------
# 2) REPLY / GREETING / QUESTIONS - editable defaults (see config.InterviewConfig)
# ---------------------------------------------------------------------------
DEFAULT_REPLY_SYSTEM = (
    "You are an HTGF-style VC analyst leading a spoken first conversation in German.\n"
    "Pace: with substantive answers, cover all five slots (Team, Produkt, Traktion, Markt, "
    "Finanzierung) in about 5 founder turns — breadth over perfectionism.\n"
    "Interview strategy is BREADTH THEN DEPTH:\n"
    "1) BREADTH: ask the NEXT empty dimension (ASK_NOW). Never re-drill a slot that is "
    "already filled or that the founder just covered while other slots are empty.\n"
    "2) DEPTH: only when phase=depth AND that slot still has empty fields — short probes "
    "on those empties only.\n"
    "Rules:\n"
    "- Acknowledge ≤1 short clause, then 1–2 SHORT questions aimed at empty fields/slots "
    "(two questions OK when they hit two different empty gaps, e.g. Team + Traktion).\n"
    "- Spoken German, ≤2 sentences total, no markdown, no essay questions.\n"
    "- NEVER yes/no-only. Accept nein/0/keine and move on.\n"
    "- Never repeat your previous question.\n"
    "- Forbidden: re-asking already_answered; mega compound re-probes of Produkt when "
    "Produkt is filled / just covered.\n"
    "- If ready_for_closing is true OR no useful empty gap remains: short wrap-up that the "
    "dossier is ready for their review — they choose Continue or Finalize in the UI "
    "(then [[intake:end]]); do not pretend to finalize yourself."
)

DEFAULT_GREETING = (
    "Hallo, ich bin Ihr HTGF-Intake-Analyst. Erzählen Sie in etwa einer Minute "
    "von Team, Produktstand, Traktion, Markt und Finanzierungsbedarf — ich hake gezielt nach."
)

DEFAULT_SLOT_QUESTIONS: dict[SlotId, str] = {
    "team": (
        "Wer gründet (Namen/Rollen), welcher Background, und arbeitet ihr Vollzeit daran?"
    ),
    "product": (
        "Welches Problem löst ihr wofür, wo steht das Produkt (Idee/Prototyp/MVP/live), "
        "und was ist der technische USP?"
    ),
    "traction": (
        "Gibt es schon Kunden, Piloten oder LOIs — und welche Zahlen zu Umsatz/MRR "
        "sowie Wachstum könnt ihr nennen (auch 0/keine ist ok)?"
    ),
    "market": (
        "Wer ist die Zielkundschaft (ICP), wie groß schätzt ihr den Markt, "
        "und wer sind die wichtigsten Wettbewerber bzw. euer Moat?"
    ),
    "financing": (
        "Welche Runde und welchen Betrag plant ihr, wofür das Geld, "
        "und wie lange reicht die Runway / welche Meilensteine?"
    ),
}


def recent_history(session: InterviewSession, *, last: int = 8) -> str:
    return "\n".join(f"{m.role}: {m.content}" for m in session.messages[-last:])


def pick_ask_focus(
    *,
    prior_focus: SlotId,
    coverages: dict[str, float],
    missing_in_focus: list[str],
) -> SlotId:
    """Steer reply to the next incomplete dossier slot (coverage SSOT — no keyword lists)."""
    def incomplete(slot: SlotId) -> bool:
        return float(coverages.get(slot) or 0) < 1.0

    if missing_in_focus:
        return prior_focus
    for slot in SLOT_ORDER:
        if incomplete(slot):
            return slot
    return prior_focus


def build_gap_queue(
    session: InterviewSession, *, primary: SlotId
) -> list[dict[str, Any]]:
    """Ordered candidate slots with their still-empty fields (primary first, then rest).

    Why: Reply runs BEFORE extract, so ``primary`` in ``session`` does not yet include
    what the founder just said. Giving the LLM the full ordered queue lets it skip
    ``primary`` to ``queue[1]`` whenever the latest statement already covered ``primary``.
    """
    cov = session.evaluation.slot_coverage or {}
    ordered: list[SlotId] = [primary] + [s for s in SLOT_ORDER if s != primary]
    queue: list[dict[str, Any]] = []
    for slot in ordered:
        spec = DIMENSIONS_SPEC[slot]
        st = session.objects[slot]
        missing = [f for f in spec.required_fields if not (st.fields.get(f) or "").strip()]
        if not missing and float(cov.get(slot) or 0) >= 1.0:
            continue
        queue.append(
            {
                "slot": slot,
                "label": spec.label,
                "missing_fields": missing,
                "blueprint": DEFAULT_SLOT_QUESTIONS.get(slot, ""),
            }
        )
    return queue


def build_extract_user(session: InterviewSession, user_text: str, focus: SlotId) -> str:
    return (
        f"Transcript (context only):\n{recent_history(session)}\n\n"
        f"Current focus slot: {focus}\n"
        f"Latest founder statement (SOURCE OF TRUTH):\n{user_text.strip()}"
    )


def build_score_belege_user(session: InterviewSession, slots: list[SlotId]) -> str:
    payload: dict[str, Any] = {}
    for slot in slots:
        st = session.objects[slot]
        payload[slot] = {
            "fields": st.fields,
            "summary": st.summary,
            "evidence": st.evidence[:6],
        }
    return json.dumps(payload, ensure_ascii=False)


def build_reply_prompt(
    session: InterviewSession,
    user_text: str,
    focus: SlotId | None,
    *,
    reply_system_prompt: str,
    followup_mode: str,
    slot_question: str,
) -> tuple[str, str]:
    """Preprocess for reply LLM — returns (system, user). Prefer post-extract dossier state."""
    prior = focus or "team"
    cov = session.evaluation.slot_coverage or {}
    specs = session.evaluation.slot_specificity or {}
    prior_spec = DIMENSIONS_SPEC[prior]
    prior_state = session.objects[prior]
    missing_prior = [
        f for f in prior_spec.required_fields if not (prior_state.fields.get(f) or "").strip()
    ]
    ask = pick_ask_focus(
        prior_focus=prior,
        coverages=cov,
        missing_in_focus=missing_prior,
    )
    # Prefer evaluation's next focus when prior slot is complete.
    if not missing_prior and session.evaluation.next_focus_slot:
        ask = session.evaluation.next_focus_slot
    spec = DIMENSIONS_SPEC[ask]
    prev = next(
        (m.content for m in reversed(session.messages) if m.role == "assistant"),
        "",
    )
    empty_slots = [s for s in SLOT_ORDER if float(cov.get(s) or 0) <= 0]
    incomplete_slots = [s for s in SLOT_ORDER if float(cov.get(s) or 0) < 1.0]
    phase = "breadth" if empty_slots else "depth"
    ask_state = session.objects[ask]
    missing_in_ask = [
        f for f in spec.required_fields if not (ask_state.fields.get(f) or "").strip()
    ]
    weak_slots = [s for s in SLOT_ORDER if session.objects[s].status != "solid"]
    vague_ask = [
        f
        for f in spec.required_fields
        if f in (ask_state.missing_or_vague or [])
        and not (ask_state.fields.get(f) or "").strip()
    ]
    already_answered: dict[str, str] = {}
    for s in SLOT_ORDER:
        for fname, fval in (session.objects[s].fields or {}).items():
            text = (fval or "").strip()
            if text:
                already_answered[f"{s}.{fname}"] = text[:80]
    dossier = {
        s: {
            "fields": session.objects[s].fields,
            "summary": session.objects[s].summary,
            "status": session.objects[s].status,
            "coverage": cov.get(s, 0),
            "specificity": specs.get(s, 0),
        }
        for s in SLOT_ORDER
    }
    slot_ask = (
        (slot_question if ask == prior else DEFAULT_SLOT_QUESTIONS.get(ask, ""))
        or ", ".join(spec.prompt_hints)
    )
    gap_queue = build_gap_queue(session, primary=ask)
    next_slot_entry = gap_queue[1] if len(gap_queue) > 1 else None
    next_slot_hint = (
        f"{next_slot_entry['slot']} ({next_slot_entry['label']}) — "
        f"missing={next_slot_entry['missing_fields']} — "
        f"blueprint: {next_slot_entry['blueprint']}"
        if next_slot_entry
        else "none (if ASK_NOW is now covered, offer wrap-up + [[intake:end]])"
    )
    if followup_mode == "strict":
        followup = (
            "FOLLOWUP=strict: Probe ONLY empty/missing fields in GAP_QUEUE "
            f"(ASK_NOW missing={missing_in_ask or 'none'}). Never re-ask already_answered "
            "or what 'Founder just said' just covered."
        )
    elif followup_mode == "insist":
        followup = (
            "FOLLOWUP=insist: Dig only into EMPTY gaps in GAP_QUEUE "
            f"(ASK_NOW missing={missing_in_ask or 'none'}, incomplete={incomplete_slots or 'none'}). "
            "If 'Founder just said' answered ASK_NOW, move to NEXT_SLOT."
        )
    else:
        followup = (
            "FOLLOWUP=balanced: "
            + (
                "BREADTH: if 'Founder just said' already covers ASK_NOW, jump straight "
                "to NEXT_SLOT; never re-ask filled or just-stated facts; "
                "1–2 short questions OK across remaining gaps."
                if phase == "breadth"
                else "DEPTH: first credit what 'Founder just said' answered; "
                "if ASK_NOW is now covered, ask NEXT_SLOT instead — do not re-drill "
                "market/product/team for sharper numbers when another slot is still open."
            )
        )
    user = (
        f"phase: {phase}.\n"
        f"followup_mode: {followup_mode}.\n"
        f"ASK_NOW (pre-extract): {ask} ({spec.label}) — missing before this turn: "
        f"{missing_in_ask or 'none'}.\n"
        f"NEXT_SLOT if Founder just answered ASK_NOW: {next_slot_hint}\n"
        f"GAP_QUEUE (ordered): {json.dumps(gap_queue, ensure_ascii=False)}\n"
        f"empty_slots: {empty_slots or 'none'}.\n"
        f"empty_or_incomplete: {incomplete_slots or 'none'}.\n"
        f"Still-empty gaps in ASK_NOW: {vague_ask or 'none'}.\n"
        f"already_answered (FORBIDDEN to re-ask): "
        f"{json.dumps(already_answered, ensure_ascii=False)}\n"
        f"Non-solid slots: {weak_slots or 'none'}.\n"
        f"ASK_NOW Belege: {float(specs.get(ask) or 0):.2f}.\n"
        f"ready_for_closing: {bool(session.evaluation.ready_for_closing)}.\n"
        "If ready_for_closing or all GAP_QUEUE items are now answered by 'Founder just said': "
        "wrap up + [[intake:end]].\n"
        f"ASK_NOW blueprint (ONLY for aspects not just answered): {slot_ask}\n"
        f"Founder just said (NOT in dossier yet — credit this first!): {user_text[:900]}\n"
        f"Dossier so far (from PRIOR turns): {json.dumps(dossier, ensure_ascii=False)}\n"
        f"Do NOT repeat: {prev[:240]}\n"
        f"{followup}"
    )
    system = (
        (reply_system_prompt or "").rstrip()
        + REPLY_NO_REASK
        + REPLY_DOSSIER_GATE
        + REPLY_END_GATE
        + reply_prompt_suffix(session.language)
    )
    return system, user
