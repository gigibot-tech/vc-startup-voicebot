"""Prompt strings + user-message builders for the two per-turn LLM calls.

===============================================================================
PER-TURN LLM ARCHITECTURE (pipeline.stream_turn / process_turn / prepare+commit)
===============================================================================

Every time the founder speaks or sends a message, the pipeline runs TWO LLM
calls in strict sequence (never in parallel, so TTS starts immediately):

  ┌─────────────────────────────────────────────────────────────────────────┐
  │ CALL #1 — SPOKEN REPLY  (build_reply_prompt -> stream() / complete())   │
  ├─────────────────────────────────────────────────────────────────────────┤
  │ • UI state : "Thinking…" bubble -> streams spoken question -> TTS plays │
  │ • System   : editable reply_system_prompt                               │
  │              + REPLY_NO_REASK (credit latest statement before asking)   │
  │              + REPLY_END_GATE (optional trailing [[intake:end]])        │
  │              + language suffix (DE / EN)                                │
  │ • User     : 7 compact sections (no duplicate full-dossier JSON dump):  │
  │              1. ASK_NOW        current slot + missing fields + blueprint│
  │              2. NEXT_SLOT      fallback slot if Founder just covered #1 │
  │              3. GAP_QUEUE      ordered remaining incomplete slots       │
  │              4. already_answered flat map of filled slot.field values   │
  │              5. Recent transcript last 6 messages                       │
  │              6. Founder just said (all unextracted user turns)          │
  │              7. FORBIDDEN to repeat + followup mode instruction         │
  │ • Output   : 1–2 spoken sentences (+ optional trailing [[intake:end]])  │
  └─────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼  (mic unlocks + TTS speaks Reply #1)
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ CALL #2 — DOSSIER EXTRACT  (EXTRACT_SYSTEM + build_extract_user)        │
  ├─────────────────────────────────────────────────────────────────────────┤
  │ • UI state : topbar + Live Dossier show "Updating dossier… (best wait)" │
  │ • System   : EXTRACT_SYSTEM (strict JSON schema: updates + confidence   │
  │              + missing_or_vague + belege)                               │
  │ • User     : build_extract_user():                                      │
  │              - per turn: SLOT_GATES (all 5 aspects; NOT ASK_NOW)        │
  │              - on-demand: MISSING_FOCUS (open gaps, lowest coverage     │
  │                first) + full conversation                               │
  │              - Founder statement(s) (SOURCE OF TRUTH)                   │
  │ • Output   : JSON -> review.apply_extract_updates() -> refresh_evaluation│
  └─────────────────────────────────────────────────────────────────────────┘

Side paths (outside a normal turn):
    SCORE_BELEGE_SYSTEM   after manual conflict resolution / tool webhook
    SUMMARY_SYSTEM        on "Finalize dossier" (saves versioned dossier vXX)
    CONTINUE_QUESTION_SYSTEM on "Continue asking" button

CAUTION: test stubs dispatch on substrings "extract", "json only", "summarize" in system.
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
    "if the founder's latest statement adds NEW facts for the startup dossier "
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
    "\n\nHARD RULE — reply before dossier update (dossier is 1 turn behind 'Founder just said'):\n"
    "- Dossier fields reflect turns BEFORE 'Founder just said'.\n"
    "- Look at FOCUS_SLOTS = (ASK_NOW, NEXT_SLOT, ...) in GAP_QUEUE and judge:\n"
    "  1) Credit everything 'Founder just said' already answers (any qualitative, approximate, "
    "partial, or negative/flat answer counts as answered for that field — never demand exact "
    "numbers, dates, or both halves of a compound concept when the founder already gave a "
    "reasonable answer).\n"
    "  2) You decide whether to probe a still-unanswered detail in ASK_NOW (focus_slots[0]) "
    "OR rotate to NEXT_SLOT (focus_slots[1]):\n"
    "     • If ASK_NOW still has an unasked missing_field that 'Founder just said' did not "
    "address yet: ask a short, specific question on THAT missing field (you may also bridge "
    "into NEXT_SLOT).\n"
    "     • If 'Founder just said' already answered (even roughly, qualitatively, or with "
    "0/none/flat) the question you just asked on ASK_NOW: do NOT repeat or re-drill that "
    "question — jump to NEXT_SLOT in GAP_QUEUE!\n"
    "     • If len(FOCUS_SLOTS) == 1 (only ONE open slot left) and it still has an unasked "
    "missing_field: briefly mention to the founder that this is the LAST open question before "
    "the dossier is complete (e.g. 'Letzte kurze Frage vor dem Abschluss:' / 'One final "
    "question to complete your dossier:'), then ask that final missing field.\n"
    "     • If len(FOCUS_SLOTS) == 1 and 'Founder just said' now covers that last open field: "
    "wrap up immediately and emit [[intake:end]].\n"
    "- NEVER repeat or paraphrase your previous question from Recent transcript.\n"
    "- NEVER re-ask already_answered fields."
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
# 1) CALL #2: EXTRACT — structured facts out of free speech (must be valid JSON)
#
# Two selectable modes (InterviewConfig.extract_mode, default = "full"):
#   • "full"  (DEFAULT) : SLOT_GATES (all 5 aspects) + Transcript + Latest founder statement
#                         with EXTRACT_SYSTEM. Extract searches EACH slot independently —
#                         it is NOT interview ASK_NOW / NEXT_SLOT (those are reply-only).
#   • "delta" (FAST)    : sends only Previous assistant question + Already in dossier
#                         + Latest founder statement with EXTRACT_DELTA_SYSTEM so the
#                         LLM only emits newly changed fields (~3–4× fewer output tokens).
# On-demand [Dossier extrahieren] always uses full_transcript=True: entire conversation
# plus MISSING_FOCUS (slots/fields still open, lowest coverage first) — not all 5 equally.
# ---------------------------------------------------------------------------
EXTRACT_SYSTEM = (
    "Extract startup intake facts. Reply with ONE compact JSON object only — no markdown, no prose.\n"
    'Schema: {"updates":{"<slot>":{"summary":"≤60 chars","evidence":["≤12-word quote"],'
    '"fields":{"<field>":"≤60 chars or \"\""},'
    '"confidence":{"<field>":0.0},'
    '"missing_or_vague":["unset field"]}},'
    '"belege":{"<slot>":0.0}}\n'
    f"Slots/fields: {json.dumps({k: v.required_fields for k, v in DIMENSIONS_SPEC.items()}, ensure_ascii=False)}\n"
    "Rules:\n"
    "- SOURCE = founder statements (never treat assistant phrasing as founder facts, but DO "
    "use the assistant's question in Transcript to understand WHICH slot/field a short founder "
    "answer is addressing!). An assistant line that says a field is still missing is NOT "
    "evidence — search the founder lines anyway.\n"
    "- Compound financing fields accept ONE half: a hire or spend ('2 Personen fürs Technische') "
    "fills use_of_funds; a launch, campus, or time span ('bis Jahresende an 3 Unis', "
    "'200 bis 500 Tage') fills runway_milestones. Write that founder phrase into the field.\n"
    "- Never copy the analyst's examples (text after z.B. / e.g., such as 'Beta-Test', "
    "'5 Campus-Gruppen', 'Gehälter, Tools'). The field value must be the founder's own words.\n"
    "- SLOT GATES: independently search the founder transcript for EACH slot/aspect listed "
    "in SLOT_GATES. Do NOT follow interview question order or the current interview focus. "
    "Emit every slot whose aspect appears.\n"
    "- If the user message contains MISSING_FOCUS: hunt ONLY those open gaps, lowest coverage "
    "first. Omit already-complete slots unless a founder statement clearly corrects them.\n"
    "- BREADTH FIRST: if the statement mentions several topics, emit updates for ALL of "
    "team, product, traction, market, financing that appear — never drop product/market/… "
    "just because focus was team.\n"
    "- Map synonyms: App/PoC/Website→product; Kunden/Leute/Traction→traction; "
    "ICP/Studenten/Unis/Markt/Competitors/Plattformen/nur Matching→market "
    "(e.g. 'andere Plattformen haben nur Matching' answers competitors_moat); "
    "EXIST/Runde/Funds/Milestones→financing.\n"
    "- GENERAL FIELD-FILL RULE (ALL 15 FIELDS): Many schema fields combine two related concepts "
    "or can be answered qualitatively, approximately, negatively ('0', 'none', 'flat'), or "
    "across multiple short turns. As soon as the founder gives ANY substantive, qualitative, "
    "approximate, or negative answer that addresses a field (or either half of a compound field), "
    "WRITE IT INTO `fields.<field>` IMMEDIATELY (combining with earlier founder turns in Transcript "
    "when a topic was answered across multiple turns). NEVER write a founder fact into `summary` "
    "or `evidence` while leaving the corresponding `fields.<field>` as \"\"!\n"
    "- HONEST FILL: leave a field \"\" ONLY when the founder has not addressed that topic at all. "
    "Do NOT copy a denial ('noch nicht' / '0' / 'none') into unrelated slots that were not discussed.\n"
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

EXTRACT_DELTA_SYSTEM = (
    "Extract startup intake facts (DELTA ONLY). Reply with ONE compact JSON object only — no markdown, no prose.\n"
    'Schema: {"updates":{"<slot>":{"summary":"≤60 chars","evidence":["≤12-word quote"],'
    '"fields":{"<field>":"≤60 chars"},'
    '"confidence":{"<field>":0.0},'
    '"missing_or_vague":["unset field"]}},'
    '"belege":{"<slot>":0.0}}\n'
    f"Slots/fields: {json.dumps({k: v.required_fields for k, v in DIMENSIONS_SPEC.items()}, ensure_ascii=False)}\n"
    "Rules:\n"
    "- DELTA ONLY (FAST MODE): emit ONLY slots and fields that are NEWLY answered or "
    "updated in 'Latest founder statement'. OMIT untouched slots and OMIT untouched fields!\n"
    "- Use 'Previous assistant question' + 'Still-empty fields' to map short, qualitative, "
    "approximate, or negative ('0', 'none', 'flat') answers directly into `fields.<field>`. "
    "Never put a new fact into `summary` or `evidence` while leaving its `fields.<field>` empty!\n"
    "- Forbidden: re-emitting facts from earlier turns that are already in 'Already in dossier'.\n"
    "- confidence: for EVERY non-empty field you emit, rate 0.0–1.0.\n"
    "- belege: for EVERY slot you touch in this update, rate 0.0–1.0. Omit untouched slots.\n"
    "- Always finish with a complete, valid JSON object."
)

# Used when fields change without a full extract (proposal resolve / tool write).
SCORE_BELEGE_SYSTEM = (
    "Score startup dossier Belege quality. Reply with ONE JSON object only — no markdown.\n"
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
    "You are a VC analyst in a spoken intake call ({language}).\n"
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
    "You are a VC analyst leading a spoken first conversation in German.\n"
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
    "Hallo, ich bin Ihr Intake-Analyst. Erzählen Sie in etwa einer Minute "
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


# Per-field micro-prompts so when a slot is partially filled (e.g. only growth_signal or
# runway_milestones is left), we ONLY ask for the still-missing field(s) — never the whole
# 3-part slot blueprint that would re-ask pilots/LOIs or raise amount!
FIELD_QUESTION_HINTS: dict[str, str] = {
    "team.founders_roles": "who the founders are and their roles",
    "team.background_expertise": "founder background / domain expertise",
    "team.commitment_fulltime": "full-time vs part-time commitment (hours/week)",
    "product.problem": "the core problem the founders solve and for whom it hurts",
    "product.solution": "how the product solves that problem",
    "product.stage_status": "current product stage (idea / prototype / MVP / live)",
    "product.usp_tech": "technical USP / what makes the technology distinct",
    "traction.customers_pilots": "current users, pilots, or LOIs (0 / none is fine)",
    "traction.metrics_revenue": "revenue / MRR or usage metrics (0 / pre-revenue is fine)",
    "traction.growth_signal": "recent growth signal or near-term user target (flat / 0 is fine)",
    "market.target_icp": "target customer segment (ICP)",
    "market.market_size": "estimated market size / TAM",
    "market.competitors_moat": "main competitors and defensibility / moat",
    "financing.raise_amount_round": "planned round and target raise amount",
    "financing.use_of_funds": "what the funds will be spent on",
    "financing.runway_milestones": "expected runway (months) and key milestones for this round",
}


def recent_history(session: InterviewSession, *, last: int | None = 8) -> str:
    """Join chat turns. ``last=None`` = full conversation (on-demand extract)."""
    msgs = session.messages if last is None else session.messages[-last:]
    return "\n".join(f"{m.role}: {m.content}" for m in msgs)


def founder_statements(session: InterviewSession, extra: str = "") -> str:
    """All user/founder lines in order (on-demand extract SOURCE OF TRUTH)."""
    lines = [m.content.strip() for m in session.messages if m.role == "user" and (m.content or "").strip()]
    extra = (extra or "").strip()
    if extra and (not lines or lines[-1] != extra):
        lines.append(extra)
    return "\n".join(lines)


def build_missing_focus(session: InterviewSession) -> list[dict[str, Any]]:
    """Open slots for on-demand extract, lowest field coverage first.

    Coverage is the share of required fields already filled (same ratio as
    ``scoring.evaluate_dimension``). Complete slots are omitted.
    """
    gaps: list[tuple[float, int, dict[str, Any]]] = []
    for index, slot in enumerate(SLOT_ORDER):
        spec = DIMENSIONS_SPEC[slot]
        fields = session.objects[slot].fields or {}
        missing = [fname for fname in spec.required_fields if not (fields.get(fname) or "").strip()]
        coverage = round(
            (len(spec.required_fields) - len(missing)) / max(1, len(spec.required_fields)),
            3,
        )
        if not missing:
            continue
        gaps.append(
            (
                coverage,
                index,
                {
                    "slot": slot,
                    "label": spec.label,
                    "coverage": coverage,
                    "missing": missing,
                    "look_for": {
                        fname: FIELD_QUESTION_HINTS.get(f"{slot}.{fname}", fname)
                        for fname in missing
                    },
                },
            )
        )
    gaps.sort(key=lambda row: (row[0], row[1]))
    return [row[2] for row in gaps]


def build_slot_gates(session: InterviewSession) -> list[dict[str, Any]]:
    """Per-slot extract gates: aspects to hunt in the conversation (not ASK_NOW)."""
    gates: list[dict[str, Any]] = []
    for slot in SLOT_ORDER:
        spec = DIMENSIONS_SPEC[slot]
        fields = session.objects[slot].fields or {}
        filled = {
            fname: (fields.get(fname) or "").strip()[:80]
            for fname in spec.required_fields
            if (fields.get(fname) or "").strip()
        }
        missing = [fname for fname in spec.required_fields if fname not in filled]
        gates.append(
            {
                "slot": slot,
                "label": spec.label,
                "aspects": list(spec.prompt_hints),
                "fields": spec.required_fields,
                "filled": filled,
                "missing": missing,
                "look_for": {
                    fname: FIELD_QUESTION_HINTS.get(f"{slot}.{fname}", fname)
                    for fname in spec.required_fields
                },
            }
        )
    return gates


def pick_ask_focus_tuple(
    *,
    prior_focus: SlotId,
    coverages: dict[str, float],
    missing_in_focus: list[str],
) -> tuple[SlotId, ...]:
    """Return the ordered tuple of incomplete focus slots ``(slot_1, slot_2, ...)`` (size 1..5).

    How ``slot_coverage`` works per slot (computed in ``scoring.py``):
      - 0 / 3 required fields filled -> ``0.0``
      - 1 / 3 required fields filled -> ``0.333``
      - 2 / 3 required fields filled -> ``0.667``
      - 3 / 3 required fields filled -> ``1.0``

    Order:
      1) ``prior_focus`` stays first if it still has ``missing_in_focus``.
      2) Every other slot in ``SLOT_ORDER`` with ``slot_coverage < 1.0``.
      3) Fallback ``(prior_focus,)`` (size 1) when all slots are at ``1.0``.
    """
    ordered: list[SlotId] = []
    if missing_in_focus:
        ordered.append(prior_focus)
    for slot in SLOT_ORDER:
        if slot not in ordered and float(coverages.get(slot) or 0) < 1.0:
            ordered.append(slot)
    if not ordered:
        ordered.append(prior_focus)
    return tuple(ordered)


def pick_ask_focus(
    *,
    prior_focus: SlotId,
    coverages: dict[str, float],
    missing_in_focus: list[str],
) -> SlotId:
    """First element of ``pick_ask_focus_tuple`` (kept for callers expecting a single SlotId)."""
    return pick_ask_focus_tuple(
        prior_focus=prior_focus,
        coverages=coverages,
        missing_in_focus=missing_in_focus,
    )[0]


def build_gap_queue(
    session: InterviewSession, *, primary: SlotId | tuple[SlotId, ...]
) -> list[dict[str, Any]]:
    """Build the ordered array of incomplete slot targets for ``FOCUS_SLOTS``.

    Each entry gives the LLM everything needed to either ask a detailed follow-up on
    ``queue[0]`` OR rotate to ``queue[1]``:
      - ``slot``: slot id
      - ``label``: human label
      - ``coverage``: ``0.0 | 0.333 | 0.667 | 1.0``
      - ``missing_fields``: required fields still empty in this slot
      - ``missing_details``: human descriptions of each missing field
      - ``blueprint``: full slot question blueprint
    """
    cov = session.evaluation.slot_coverage or {}
    if isinstance(primary, tuple):
        seed = list(primary)
    else:
        seed = [primary]
    ordered: list[SlotId] = seed + [s for s in SLOT_ORDER if s not in seed]
    queue: list[dict[str, Any]] = []
    for slot in ordered:
        spec = DIMENSIONS_SPEC[slot]
        st = session.objects[slot]
        missing = [f for f in spec.required_fields if not (st.fields.get(f) or "").strip()]
        slot_cov = round(float(cov.get(slot) or 0), 3)
        if not missing and slot_cov >= 1.0:
            continue
        queue.append(
            {
                "slot": slot,
                "label": spec.label,
                "coverage": slot_cov,
                "missing_fields": missing,
                "missing_details": [FIELD_QUESTION_HINTS.get(f"{slot}.{f}", f) for f in missing],
                "blueprint": DEFAULT_SLOT_QUESTIONS.get(slot, ""),
            }
        )
    return queue


def unextracted_user_turns(session: InterviewSession, user_text: str) -> list[str]:
    """Return all user messages since the last assistant reply (in chronological order).

    Why this exists:
    1) On a normal turn, Call #1 (Reply) runs BEFORE Call #2 (Extract), so there is 1
       unextracted user message (`user_text`).
    2) If the founder spoke/sent again while the previous turn's `Updating dossier…` was
       still running (interrupting Call #2), there are 2+ consecutive user messages at the
       tail of `session.messages` whose facts have NOT been written into `session.objects` yet.
    """
    lines: list[str] = []
    for m in reversed(session.messages):
        if m.role == "assistant" and lines:
            break
        if m.role == "assistant":
            continue
        if m.role == "user" and (m.content or "").strip():
            lines.append(m.content.strip())
    lines.reverse()
    latest = user_text.strip()
    if latest and (not lines or lines[-1] != latest):
        lines.append(latest)
    return lines or ([latest] if latest else [])


def unextracted_user_text(session: InterviewSession, user_text: str) -> str:
    """Joined text of all unextracted user turns since the last assistant question."""
    return "\n".join(unextracted_user_turns(session, user_text))


def filled_fields_map(session: InterviewSession) -> dict[str, str]:
    """Flat ``{"slot.field": "value"}`` map of everything already captured in the dossier."""
    return {
        f"{s}.{fname}": (fval or "").strip()[:80]
        for s in SLOT_ORDER
        for fname, fval in (session.objects[s].fields or {}).items()
        if (fval or "").strip()
    }


def missing_fields_by_slot(session: InterviewSession) -> dict[str, list[str]]:
    """Map of ``{slot: [empty_required_fields]}`` for slots that still have open fields."""
    out: dict[str, list[str]] = {}
    for s in SLOT_ORDER:
        miss = [
            f
            for f in DIMENSIONS_SPEC[s].required_fields
            if not (session.objects[s].fields.get(f) or "").strip()
        ]
        if miss:
            out[s] = miss
    return out


def build_extract_user(
    session: InterviewSession,
    user_text: str,
    focus: SlotId,
    *,
    extract_mode: str = "full",
    full_transcript: bool = False,
) -> str:
    """Build user prompt for CALL #2 (Dossier Extract).

    Modes (selectable in Settings -> Extract scope):
      - ``"full"``  (DEFAULT): ``SLOT_GATES`` (all 5 aspects) + recent transcript
        + latest founder statement. Extract hunts EACH slot independently —
        never interview ASK_NOW / NEXT_SLOT.
      - ``"delta"`` (FAST): previous assistant question + already in dossier
        + latest statement (speed comparison). Ignored when ``full_transcript``.
      - ``full_transcript=True`` (on-demand [Dossier extrahieren]): entire
        conversation + ``MISSING_FOCUS`` (open gaps, lowest coverage first).
    ``focus`` is kept for callers; full/on-demand extract does not bias on ASK_NOW.
    """
    still_empty = missing_fields_by_slot(session)
    gates_block = (
        "SLOT_GATES (search EACH aspect independently — do not follow interview question order):\n"
        f"{json.dumps(build_slot_gates(session), ensure_ascii=False)}\n\n"
    )
    if full_transcript:
        founder = founder_statements(session, user_text)
        missing = build_missing_focus(session)
        if missing:
            focus_block = (
                "MISSING_FOCUS (search the conversation ONLY for these open gaps, "
                "lowest coverage first):\n"
                f"{json.dumps(missing, ensure_ascii=False)}\n"
                "Founder statements override any assistant summary that claims these gaps "
                "are still open. A partial founder answer still fills the field.\n\n"
            )
        else:
            focus_block = (
                "MISSING_FOCUS: none — every required field is already filled. "
                "Emit a slot only if a founder statement clearly corrects an existing value.\n\n"
            )
        return (
            focus_block
            + "ALREADY_FILLED (do not re-emit unless a founder statement clearly corrects it):\n"
            + f"{json.dumps(filled_fields_map(session), ensure_ascii=False)}\n\n"
            + f"Full conversation transcript:\n{recent_history(session, last=None)}\n\n"
            + f"Founder statements (SOURCE OF TRUTH):\n{founder}"
        )
    if extract_mode == "delta":
        combined = unextracted_user_text(session, user_text)
        assistant_msgs = [m.content for m in session.messages if m.role == "assistant"]
        prev_question = (
            assistant_msgs[-2]
            if len(assistant_msgs) >= 2
            else (assistant_msgs[-1] if assistant_msgs else "")
        )
        return (
            f"Previous assistant question (for context on short answers):\n{prev_question[:320]}\n\n"
            f"Already in dossier (do NOT re-emit unless changed by Latest founder statement):\n"
            f"{json.dumps(filled_fields_map(session), ensure_ascii=False)}\n\n"
            f"Still-empty fields to fill if addressed: {json.dumps(still_empty, ensure_ascii=False)}\n"
            f"Latest founder statement (SOURCE OF TRUTH):\n{combined}"
        )
    return (
        gates_block
        + f"Transcript (context only):\n{recent_history(session)}\n\n"
        + f"Still-empty fields to fill if addressed: {json.dumps(still_empty, ensure_ascii=False)}\n"
        + f"Latest founder statement (SOURCE OF TRUTH):\n{user_text.strip()}"
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
    focus: SlotId | tuple[SlotId, ...] | list[SlotId] | None,
    *,
    reply_system_prompt: str,
    followup_mode: str,
    slot_question: str,
) -> tuple[str, str]:
    """Build (system, user) for CALL #1 (Spoken Reply).

    Instead of Python hard-coding when to rotate slots, we compute ``focus_slots`` as an
    ordered tuple ``(slot_1, slot_2, ...)`` (can be size 1 when only 1 slot remains) and
    hand the LLM both:
      - ``ASK_NOW`` (``focus_slots[0]``: detailed missing fields if still unanswered)
      - ``NEXT_SLOT`` (``focus_slots[1]``: next rotation slot if ``Founder just said``
        already answered or said flat/0/none to ``focus_slots[0]``)
      - ``GAP_QUEUE`` (full ordered array of open slots with ``coverage``, ``missing_fields``,
        ``missing_details``, and ``blueprint``)
    so the LLM judges from ``Recent transcript`` + ``Founder just said`` whether to ask a
    detailed follow-up on ``focus_slots[0]``, rotate to ``focus_slots[1]``, or combine both.
    """
    cov = session.evaluation.slot_coverage or {}
    eval_slots = tuple(session.evaluation.next_focus_slots or ())
    if isinstance(focus, (tuple, list)) and focus:
        prior_focus: SlotId = focus[0]
    elif isinstance(focus, str) and focus:
        prior_focus = focus
    elif eval_slots:
        prior_focus = eval_slots[0]
    else:
        prior_focus = session.evaluation.next_focus_slot or "team"

    missing_in_prior = [
        f
        for f in DIMENSIONS_SPEC[prior_focus].required_fields
        if not (session.objects[prior_focus].fields.get(f) or "").strip()
    ]
    focus_slots: tuple[SlotId, ...] = pick_ask_focus_tuple(
        prior_focus=prior_focus,
        coverages=cov,
        missing_in_focus=missing_in_prior,
    )
    ask: SlotId = focus_slots[0]
    spec = DIMENSIONS_SPEC[ask]
    missing_in_ask = [
        f for f in spec.required_fields if not (session.objects[ask].fields.get(f) or "").strip()
    ]
    missing_details_ask = [FIELD_QUESTION_HINTS.get(f"{ask}.{f}", f) for f in missing_in_ask]
    slot_ask = (
        (slot_question if ask == prior_focus else DEFAULT_SLOT_QUESTIONS.get(ask, ""))
        or ", ".join(spec.prompt_hints)
    )

    gap_queue = build_gap_queue(session, primary=focus_slots)
    next_entry = gap_queue[1] if len(gap_queue) > 1 else None
    next_slot_hint = (
        f"{next_entry['slot']} ({next_entry['label']}) — "
        f"missing={next_entry['missing_fields']} ({next_entry['missing_details']}) — "
        f"blueprint: {next_entry['blueprint']}"
        if next_entry
        else "none (only 1 slot left in FOCUS_SLOTS; if Founder just covered it, wrap up + [[intake:end]])"
    )

    pending_turns = unextracted_user_turns(session, user_text)
    combined_user = "\n".join(pending_turns)
    phase = "breadth" if any(float(cov.get(s) or 0) <= 0 for s in SLOT_ORDER) else "depth"
    unextracted_note = (
        f"NOTE: {len(pending_turns)} founder messages below were sent while the dossier was still updating — credit ALL of them!\n"
        if len(pending_turns) > 1
        else ""
    )

    user = (
        f"FOCUS_SLOTS ({followup_mode}/{phase}): {list(focus_slots)}\n"
        f"ASK_NOW: {ask} ({spec.label}, coverage={float(cov.get(ask) or 0):.2f}) — "
        f"missing={missing_in_ask or 'none'} ({missing_details_ask}) — blueprint: {slot_ask}\n"
        f"NEXT_SLOT if Founder just answered ASK_NOW: {next_slot_hint}\n"
        f"GAP_QUEUE (ordered): {json.dumps(gap_queue, ensure_ascii=False)}\n"
        f"already_answered (FORBIDDEN to re-ask): {json.dumps(filled_fields_map(session), ensure_ascii=False)}\n"
        f"Recent transcript:\n{recent_history(session, last=6)}\n"
        f"{unextracted_note}"
        f"Founder just said (NOT in dossier yet — credit this first!): {combined_user[:1200]}"
    )
    system = (
        (reply_system_prompt or "").rstrip()
        + REPLY_NO_REASK
        + REPLY_END_GATE
        + reply_prompt_suffix(session.language)
    )
    return system, user
