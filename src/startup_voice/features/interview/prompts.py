"""Every prompt the interview sends to the LLM, in one readable place.

THE THREE LLM CALLS OF A TURN  (who uses what)
==============================================

    prompt constant        used by                    call type        purpose
    ---------------------  -------------------------  ---------------  ---------------------------
    EXTRACT_SYSTEM         pipeline._fill_objects     complete()       turn the founder's answer into
                                                                       JSON facts for the dossier slots
    DEFAULT_REPLY_SYSTEM   config.InterviewConfig     complete() or    the agent's next question
      (editable in the UI) -> pipeline._reply_prompt  stream()         (streamed to the browser)
    SUMMARY_SYSTEM         pipeline._summarize        complete()       spoken wrap-up on "Dossier
                                                                       abschliessen" (finalize)

Also here: DEFAULT_GREETING and DEFAULT_SLOT_QUESTIONS, the editable defaults behind the
"System-Prompt" and "Fragenkatalog" panels. The language-specific additions (English override,
English greeting) live in startup_voice/language.py.

CAUTION: the test stubs in tests/test_pipeline.py decide what to return by looking for the
words "extract", "json only" and "summarize" inside the system prompt. Keep those words.
"""

from __future__ import annotations

import json

from startup_voice.domain import DIMENSIONS_SPEC, SlotId

# ---------------------------------------------------------------------------
# 1) EXTRACT - structured facts out of free speech (output must be parseable JSON)
# ---------------------------------------------------------------------------
EXTRACT_SYSTEM = (
    "Extract HTGF intake facts. Reply with ONE compact JSON object only — no markdown, no prose.\n"
    'Schema: {"updates":{"<slot>":{"summary":"≤80 chars","evidence":["short quote"],'
    '"fields":{"<field>":"≤80 chars or \"\""},"missing_or_vague":["unset field"]}}}\n'
    f"Slots/fields: {json.dumps({k: v.required_fields for k, v in DIMENSIONS_SPEC.items()}, ensure_ascii=False)}\n"
    "Rules:\n"
    "- SOURCE = latest founder statement only (ignore assistant text).\n"
    "- BREADTH FIRST: if the statement mentions several topics, emit updates for ALL of "
    "team, product, traction, market, financing that appear — never drop product/market/… "
    "just because focus was team.\n"
    "- Map synonyms: App/PoC/Website→product; Kunden/Leute/Traction→traction; "
    "ICP/Studenten/Markt/Competitors→market; EXIST/Runde/Funds/Milestones→financing.\n"
    "- For each covered slot fill as many of the three fields as the text allows "
    "(short facts, not the whole paragraph).\n"
    "- Explicit negatives/zeros COUNT: keine/0/noch nicht → write concrete denials "
    "into the relevant fields (do NOT leave them empty).\n"
    "- Split facts across slots: team≠product≠traction≠market≠financing.\n"
    "- Only truly unknown fields: \"\" + name in missing_or_vague. Omit untouched slots."
)

SUMMARY_SYSTEM = (
    "Summarize the startup intake in {language} for spoken delivery: strengths, gaps, "
    "and next steps. No markdown."
)

# ---------------------------------------------------------------------------
# 2) REPLY / GREETING / QUESTIONS - editable defaults (see config.InterviewConfig)
# ---------------------------------------------------------------------------
DEFAULT_REPLY_SYSTEM = (
    "You are an HTGF-style VC analyst leading a spoken first conversation in German.\n"
    "Interview strategy is BREADTH THEN DEPTH:\n"
    "1) BREADTH: if phase=breadth, ask about the focus dimension so we get ANY solid "
    "write-up for that whole slot — never re-drill a slot that already has fields while "
    "other slots are still empty.\n"
    "2) DEPTH: only when phase=depth, ask sharper follow-ups on weak/vague aspects.\n"
    "Rules:\n"
    "- Acknowledge ≤1 short sentence, then ONE compound question for the focus slot.\n"
    "- NEVER yes/no-only. Prefer spoken German, ≤2 sentences, no markdown.\n"
    "- Accept nein/0/keine and move on.\n"
    "- Never repeat your previous question.\n"
    "- If ready_for_closing is true: confirm coverage and point to „Dossier abschließen“."
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
