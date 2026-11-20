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
  │              + REPLY_RULES (ask ASK_1 + ASK_2, never repeat last)      │
  │              + wrap-up rule + [[intake:end]] only when nothing is open  │
  │              + language suffix (DE / EN)                                │
  │ • User     : ASK_1 + ASK_2 + BACKUP  (picked in Python, skipping the    │
  │                                     fields asked last turn)             │
  │              ALREADY_ANSWERED  flat map of filled slot.field values     │
  │              Founder just said (all unextracted user turns)             │
  │ • Output   : TWO short questions (ASK_1 + ASK_2)                        │
  │              (+ optional trailing [[intake:end]])                       │
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
  │              - per turn: SLOT_GATES (all 5 aspects, no reply focus)     │
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

import difflib
import json
import random
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

# Always appended (even when reply_system_prompt is customized in interview_config.json).
# NOTE: avoid the substring "extract" here — test stubs dispatch on '"extract" in system.lower()'.
#
# !! Rules that only apply sometimes (the "last question" wording, the [[intake:end]] marker) are
# added by reply_rules() ONLY when they apply. Small models (Granite 4 3B, LFM3 1.7B) copy any
# phrase they see: with both rules always present, LFM3 wrote "Letzte kurze Frage:" every turn and
# appended "[[dossier:yes]] Then [[intake:end]]." although many fields were open.
REPLY_RULES = (
    "\n\nYOUR TASK THIS TURN (the dossier is 1 turn behind 'Founder just said'):\n"
    "1) At most one short clause reacting to 'Founder just said' — in your own words, do not "
    "repeat what the founder said.\n"
    "2) Ask ASK_1 and ASK_2 as TWO short questions, one each. If 'Founder just said' already "
    "answers one of them (even roughly, or with 0 / none / noch nicht), ask BACKUP instead.\n"
    "3) Never ask about ALREADY_ANSWERED.\n"
    "4) Write a NEW reply. Speak like a person: no lists, no field names, no technical keys, "
    "never mention other open topics, never write square brackets."
)
REPLY_LAST_RULE = (
    "\n5) ASK_2 is none: this is the last open topic. Say it is the last question before the "
    "dossier is complete ('Letzte kurze Frage:' / 'One last question:') and ask just ASK_1. "
    "If 'Founder just said' already answers ASK_1, wrap up instead (see below)."
)
# End of intake (the user chooses Continue vs Finalize in the UI — never auto-finalize).
REPLY_WRAPUP_RULE = (
    "\nWRAP UP: nothing useful is left to ask. Speak a short wrap-up (the dossier is ready — they "
    "can continue asking or finalize in the UI), then on its OWN last line write exactly "
    "[[intake:end]]. Never say the marker aloud. Do not finalize yourself."
)

# Backwards-compatible alias (old name).
REPLY_NO_REASK = REPLY_RULES


def reply_rules(n_asks: int) -> str:
    """Rules for the reply system prompt; ``n_asks`` = how many topics Python picked (0, 1 or 2)."""
    if n_asks >= 2:
        return REPLY_RULES
    if n_asks == 1:
        return REPLY_RULES + REPLY_LAST_RULE + REPLY_WRAPUP_RULE
    return REPLY_RULES + "\n5) ASK_1 is none: every field is filled." + REPLY_WRAPUP_RULE


FOLLOWUP_MODE_HINTS: dict[str, str] = {
    "balanced": "accept reasonable answers and keep moving across slots",
    "insist": "if an answer is vague, prefer a concrete probe (number, name, date) on another open field",
    "strict": "ask for concrete evidence on each open field before the dossier is considered done",
}


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


_ANY_MARK_RE = re.compile(
    r"\[\[\s*(?:dossier\s*:\s*(?P<dossier>yes|no)|intake\s*:\s*(?P<end>end))\s*\]\]",
    re.IGNORECASE,
)
# Connector debris a small model leaves between/after markers: "[[dossier:yes]] Then [[intake:end]]."
_MARK_DEBRIS_RE = re.compile(r"(?:\s*(?:→|->|=>|then|dann|und dann|und)\s*)+[.!]?\s*$", re.IGNORECASE)


# Lead-in sentences kept in a reply from a BROWSER model (Granite 3B / LFM3 1.7B / Gemma): none.
# The acknowledgement is where small models invent things ("ich habe … notiert", "ehre dich als
# Alleineinsteiger"); two questions are safe. Server models (Ollama, Scaleway) keep one lead-in.
# Set to 1 to let browser models acknowledge again.
BROWSER_REPLY_MAX_LEAD = 0


def split_reply_marks(raw: str, *, max_lead: int = 1) -> tuple[str, bool, bool]:
    """Strip every ``[[dossier:…]]`` / ``[[intake:end]]`` marker, wherever the model put it.

    Returns ``(spoken_text, needs_extract, offer_end)``.
    Missing dossier mark → needs_extract True (safe default).
    Markers are removed from the whole text (not only the tail): LFM3 1.7B wrote
    "…[[dossier:yes]] Then [[intake:end]]." and the old tail-only regex left "Then" behind.
    ``offer_end`` is only a request — see ``end_allowed``.
    """
    text = (raw or "").strip()
    offer_end = False
    needs_extract = True
    for match in _ANY_MARK_RE.finditer(text):
        if match.group("end"):
            offer_end = True
        else:
            needs_extract = match.group("dossier").lower() == "yes"
    text = _ANY_MARK_RE.sub("", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = _MARK_DEBRIS_RE.sub("", text.strip()).strip()
    cleaned = strip_field_leaks(text)
    return tidy_reply(cleaned, max_lead=max_lead) or cleaned, needs_extract, offer_end


def end_allowed(session: InterviewSession) -> bool:
    """May the reply offer "end of intake"? Only when nothing is open except what was just asked.

    The dossier is one turn behind, so the last asked fields may still look open; anything
    else open means the model's ``[[intake:end]]`` is premature and is ignored.
    """
    open_keys = set(open_field_keys(session))
    return not open_keys or open_keys <= set(session.last_asked_fields or [])


# ---------------------------------------------------------------------------
# 1) CALL #2: EXTRACT — structured facts out of free speech (must be valid JSON)
#
# Two selectable modes (InterviewConfig.extract_mode, default = "full"):
#   • "full"  (DEFAULT) : SLOT_GATES (all 5 aspects) + Transcript + Latest founder statement
#                         with EXTRACT_SYSTEM. Extract searches EACH slot independently —
#                         it does NOT follow the reply's question choice.
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
    "You are a VC analyst leading a spoken first intake call in German.\n"
    "Goal: fill all open dossier fields (Team, Produkt, Traktion, Markt, Finanzierung) in "
    "about 5 founder turns — breadth over perfection.\n"
    "Every reply:\n"
    "- At most one short acknowledging clause, then TWO short questions on two different "
    "open fields.\n"
    "- Spoken German, ≤2 sentences, no markdown, no essay or yes/no-only questions.\n"
    "- Accept nein / 0 / keine as a valid answer and move on.\n"
    "- When nothing useful is left open: short wrap-up that the dossier is ready for review "
    "(they choose Continue or Finalize in the UI). Never finalize yourself."
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
    """Per-slot extract gates: aspects to hunt in the conversation."""
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


def open_field_keys(session: InterviewSession) -> list[str]:
    """Every still-empty required field as ``"slot.field"`` (slot order)."""
    return [
        f"{slot}.{fname}"
        for slot, missing in missing_fields_by_slot(session).items()
        for fname in missing
    ]


def field_hint(key: str) -> str:
    """Plain-language topic for the reply prompt.

    !! NEVER put internal ``slot.field`` keys (``product.problem`` …) into the REPLY prompt. !!
    Small models (Granite 4 3B in the browser) read them out loud, e.g. "Wenn du möchtest,
    gib mir Infos zu: - product.problem - market.market_size …". Every reply-prompt line must
    go through this function (or ``already_answered_text``); keys are only fine for Python-side
    bookkeeping (``session.last_asked_fields``). Guarded by
    ``test_build_reply_prompt_ask_1_not_product_when_product_full`` (keys absent from the prompt)
    and, as a last line of defense, ``strip_field_leaks`` on the model's output.
    The Netlify twin is ``fieldHint`` in netlify-app/netlify/functions/api.mjs — keep both in sync.
    """
    return FIELD_QUESTION_HINTS.get(key, key.split(".", 1)[-1].replace("_", " "))


_FIELD_KEY_RE = re.compile(
    r"\b(?:team|product|traction|market|financing)\.[a-z]+(?:_[a-z]+)*\b", re.IGNORECASE
)
# Labels of OUR prompt that a small model sometimes echoes ("- ASK_1: team & background").
_PROMPT_LABEL_RE = re.compile(
    r"\b(?:ASK_[12]|BACKUP|ALREADY_ANSWERED|RE_ASK|OPEN_FIELDS_LEFT|FOLLOWUP_MODE)\b"
    r"|Founder just said",
)
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?…:])\s+")


def strip_field_leaks(text: str) -> str:
    """Cut the reply at the first sentence that reads internal field keys out loud.

    Safety net on the model OUTPUT (runs inside ``split_reply_marks``, so every path —
    streaming, browser LLM, retry — gets it). Prompt hygiene is the real fix (see
    ``field_hint``); this only catches what a small model echoes anyway.

    Everything from the first leaking sentence on is dropped — also a list intro just
    before it ("…zu den folgenden Feldern geben:") — because what follows a dumped list is
    filler about that list ("Diese Felder helfen uns…"). Dropping only the keys left
    "…geben: Diese Felder…" behind (seen with Granite 4 3B). Returns the original text if
    nothing would be left. Netlify twin: ``stripFieldLeaks`` in api.mjs.
    """
    if not text or not (_FIELD_KEY_RE.search(text) or _PROMPT_LABEL_RE.search(text)):
        return text
    sentences = _SENTENCE_SPLIT_RE.split(" ".join(text.split()))
    kept: list[str] = []
    for sent in sentences:
        if (
            _FIELD_KEY_RE.search(sent)
            or _PROMPT_LABEL_RE.search(sent)
            or sent.lstrip().startswith(("-", "*", "•", "(Note"))
        ):
            break
        kept.append(sent)
    while kept and kept[-1].rstrip().endswith(":"):
        kept.pop()  # list intro whose list we just cut
    return " ".join(kept).strip() or text


_LIST_MARK_RE = re.compile(r"(?m)^\s*(?:\d+[.)]|[-*•])\s+")


def tidy_reply(text: str, *, max_questions: int = 2, max_lead: int = 1) -> str:
    """Bring a small model's reply into the shape the prompt asked for.

    Spoken reply = at most ``max_lead`` lead-in sentence(s) + at most ``max_questions`` questions.
    Seen with LFM3 1.7B / Granite 3B: numbered lists ("1) … 2) …"), three or four questions, and
    claims AFTER the question ("ich habe das im Dossier aufgenommen"). List markers are dropped,
    everything after the last allowed question is cut, and surplus questions are dropped.
    A reply without any question (wrap-up) is only de-listed and capped at three sentences.
    Netlify twin: ``tidyReply`` in api.mjs.
    """
    flat = " ".join(_LIST_MARK_RE.sub("", text or "").split())
    if not flat:
        return ""
    sentences = [x for x in _SENTENCE_SPLIT_RE.split(flat) if x]
    first_q = next((i for i, x in enumerate(sentences) if x.rstrip().endswith("?")), None)
    if first_q is None:
        return " ".join(sentences[:3])
    lead = [x for x in sentences[:first_q] if not x.rstrip().endswith(":")][-max_lead:] if max_lead else []
    questions = [x for x in sentences[first_q:] if x.rstrip().endswith("?")][:max_questions]
    return " ".join(lead + questions)


# Deterministic German questions per field: the fallback when a small model returns no question or
# repeats one. Precise on purpose — the slot-wide catalog questions re-ask several fields at once.
FIELD_QUESTIONS_DE: dict[str, str] = {
    "team.founders_roles": "Wer gründet mit, und welche Rolle hat jede Person?",
    "team.background_expertise": "Welchen Hintergrund und welche Erfahrung bringt ihr mit?",
    "team.commitment_fulltime": "Arbeitet ihr Vollzeit am Projekt oder nebenher?",
    "product.problem": "Welches Problem löst ihr, und für wen ist es besonders schmerzhaft?",
    "product.solution": "Wie löst euer Produkt dieses Problem konkret?",
    "product.stage_status": "Wo steht das Produkt gerade: Idee, Prototyp, MVP oder live?",
    "product.usp_tech": "Was ist technisch das Besondere an eurem Produkt?",
    "traction.customers_pilots": "Gibt es schon Nutzer, Piloten oder Absichtserklärungen? Null ist auch eine Antwort.",
    "traction.metrics_revenue": "Welche Zahlen habt ihr schon, etwa Umsatz oder Nutzung? Null ist auch okay.",
    "traction.growth_signal": "Wie entwickeln sich die Nutzer, und was ist das nächste Ziel?",
    "market.target_icp": "Wer genau ist eure Zielgruppe?",
    "market.market_size": "Wie groß schätzt ihr den Markt?",
    "market.competitors_moat": "Wer sind eure Wettbewerber, und was schützt euch vor ihnen?",
    "financing.raise_amount_round": "Welche Runde plant ihr, und wie viel Kapital braucht ihr?",
    "financing.use_of_funds": "Wofür würdet ihr das Geld einsetzen?",
    "financing.runway_milestones": "Wie viele Monate reicht das Geld, und welche Meilensteine wollt ihr erreichen?",
}


def fallback_question(session: InterviewSession) -> str:
    """Two field-specific questions for the topics Python picked this turn (``last_asked_fields``).

    Used when the model's reply has no question or repeats one. English sessions get a plain
    template from the field hints instead of the German texts.
    """
    keys = (session.last_asked_fields or []) or open_field_keys(session)[:2]
    german = (session.language or "de").lower().startswith("de")
    parts = [
        FIELD_QUESTIONS_DE.get(k, "") if german else f"Could you tell me about {field_hint(k)}?"
        for k in keys[:2]
    ]
    return " ".join(x for x in parts if x)


_GERMAN_WORDS = frozenset(
    "der die das den dem des ein eine einen einem und oder ist sind war habt haben hast hat wir ihr "
    "du ich sie es was wie wer wo wann warum welche welcher welches wieviel wofür für mit von zu zum "
    "zur auf bei nach nicht noch schon auch aber wenn dass dann gibt gibt's euer eure euch dein deine "
    "dir dich uns mir mich kann könnt könnten wollt wird werden".split()
)


def looks_german(text: str) -> bool:
    """Rough check that ``text`` is German: any common German function word. Short texts pass.

    Not a topic check — LFM3 1.7B switched to English mid-conversation ("Sounds great — I've noted…").
    Function words only, so a German reply always contains at least one of them.
    """
    words = re.findall(r"[a-zäöüß']+", (text or "").lower())
    if len(words) < 4:
        return True
    return any(w in _GERMAN_WORDS for w in words)


def question_sentences(text: str) -> list[str]:
    """The question sentences of a reply (what the founder would hear as "asked again")."""
    flat = " ".join(_LIST_MARK_RE.sub("", text or "").split())
    return [x for x in _SENTENCE_SPLIT_RE.split(flat) if x.rstrip().endswith("?")]


def repeats_question(reply: str, previous: str, *, threshold: float = 0.8) -> bool:
    """True when any question of ``reply`` is (almost) a question of ``previous``.

    ``is_repeat`` compares whole messages; a different lead-in sentence hid a re-asked
    question from it (LFM3: "Gute Nachricht – … Wer sind die Gründer?" → "Wer sind die Gründer?").
    """
    old = [" ".join(q.lower().split()) for q in question_sentences(previous)]
    for q in question_sentences(reply):
        q = " ".join(q.lower().split())
        if any(difflib.SequenceMatcher(None, q, o).ratio() >= threshold for o in old):
            return True
    return False


def is_repeat(reply: str, previous: str, *, threshold: float = 0.8) -> bool:
    """True when ``reply`` is (almost) the previous assistant message again.

    Small models copy earlier assistant text from the prompt; the pipeline then swaps in
    a catalog question instead of saying the same thing twice.
    """
    a, b = " ".join((reply or "").lower().split()), " ".join((previous or "").lower().split())
    if not a or not b:
        return False
    return a == b or difflib.SequenceMatcher(None, a, b).ratio() >= threshold


def previous_assistant_message(session: InterviewSession) -> str:
    """Assistant line before the latest founder message (what the founder answered)."""
    seen_user = False
    for m in reversed(session.messages):
        if m.role == "user":
            seen_user = True
        elif m.role == "assistant" and seen_user and (m.content or "").strip():
            return m.content.strip()
    return ""


def pick_reply_fields(session: InterviewSession) -> tuple[list[str], str | None]:
    """Choose the two fields the next reply asks, plus one backup.

    Small models (e.g. Granite 3B) phrase questions well but choose badly, so Python
    picks. Fields asked in the previous reply (``session.last_asked_fields``) are skipped:
    the founder is answering them right now and the dossier does not know it yet. They
    come back only when nothing else is open.

    ASK_1 = first fresh open field (slot order = breadth). ASK_2 = random fresh field from
    a different slot when possible. BACKUP = another fresh field, in case the founder just
    answered ASK_1 or ASK_2.
    """
    open_keys = open_field_keys(session)
    recent = set(session.last_asked_fields or [])
    fresh = [k for k in open_keys if k not in recent] or open_keys
    if not fresh:
        return [], None
    first = fresh[0]
    first_slot = first.split(".", 1)[0]
    rest = [k for k in fresh if k != first]
    other_slot = [k for k in rest if k.split(".", 1)[0] != first_slot]
    second = random.choice(other_slot or rest) if rest else None
    asks = [first] + ([second] if second else [])
    backup = next((k for k in rest if k not in asks), None)
    return asks, backup


def already_answered_text(session: InterviewSession) -> str:
    """Filled fields as ``topic: value`` pairs (no internal keys), ``none`` when empty."""
    pairs = [f"{field_hint(key)}: {val}" for key, val in filled_fields_map(session).items()]
    return "; ".join(pairs) or "none"


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
        never the reply's question choice.
      - ``"delta"`` (FAST): previous assistant question + already in dossier
        + latest statement (speed comparison). Ignored when ``full_transcript``.
      - ``full_transcript=True`` (on-demand [Dossier extrahieren]): entire
        conversation + ``MISSING_FOCUS`` (open gaps, lowest coverage first).
    ``focus`` is kept for callers; extract does not bias on it.
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
    *,
    reply_system_prompt: str,
    followup_mode: str,
) -> tuple[str, str]:
    """Build (system, user) for CALL #1 (Spoken Reply).

    Python picks ASK_1 / ASK_2 / BACKUP (``pick_reply_fields``) and records them in
    ``session.last_asked_fields`` so the next turn moves on. The LLM only phrases the
    questions. It sees NOTHING of what it asked last turn — not the text, not even the topics
    (no transcript with assistant lines, no "asked last turn" line): a small model copies
    whatever it is shown (LFM3 1.7B re-asked last turn's topics from such a line). Python
    already skips those fields in ``pick_reply_fields``. The pipeline's repeat guard catches a copy anyway.
    """
    open_keys = open_field_keys(session)
    reused = [k for k in session.last_asked_fields if k in open_keys]
    re_ask = False
    if session.last_asked_turn == session.turn_index and reused:
        # Same turn rebuilt (Retry / browser prepare): keep the same questions.
        asks = reused
        backup = next((k for k in open_keys if k not in asks), None)
    else:
        re_ask = bool(open_keys) and set(open_keys) <= set(session.last_asked_fields or [])
        asks, backup = pick_reply_fields(session)
        session.last_asked_fields = list(asks)
        session.last_asked_turn = session.turn_index

    pending_turns = unextracted_user_turns(session, user_text)
    combined_user = "\n".join(pending_turns)
    mode = (followup_mode or "balanced").strip().lower()
    mode_hint = FOLLOWUP_MODE_HINTS.get(mode, FOLLOWUP_MODE_HINTS["balanced"])
    unextracted_note = (
        f"NOTE: {len(pending_turns)} founder messages below were sent while the dossier was "
        "still updating — credit ALL of them!\n"
        if len(pending_turns) > 1
        else ""
    )
    re_ask_note = (
        "RE_ASK: the only open topics are the ones you just asked about — if 'Founder just said' does "
        "not answer them, ask once more, shorter and from a different angle.\n"
        if re_ask
        else ""
    )
    # Topics only, never "slot.field" keys — see field_hint().
    ask_1 = field_hint(asks[0]) if asks else "none — every field is filled (wrap up + [[intake:end]])"
    ask_2 = field_hint(asks[1]) if len(asks) > 1 else "none"

    user = (
        f"ASK_1: {ask_1}\n"
        f"ASK_2: {ask_2}\n"
        f"BACKUP (only if Founder just said already answers ASK_1 or ASK_2): "
        f"{field_hint(backup) if backup else 'none'}\n"
        f"{re_ask_note}"
        f"OPEN_FIELDS_LEFT: {len(open_keys)}\n"
        f"FOLLOWUP_MODE: {mode} — {mode_hint}\n"
        f"ALREADY_ANSWERED (never re-ask): {already_answered_text(session)}\n"
        # !! NEVER show the previous assistant text, a transcript with assistant lines, or an "asked last
        # turn" topic list: Granite copied the text verbatim, LFM3 re-asked the listed topics.
        f"{unextracted_note}"
        f"Founder just said (NOT in dossier yet — credit this first!): {combined_user[:1200]}"
    )
    system = (
        (reply_system_prompt or "").rstrip()
        + reply_rules(len(asks))
        + reply_prompt_suffix(session.language)
    )
    return system, user
