"""Conversation language: the single place that knows which languages exist and what they change.

Session.language is the source of truth (stored on the session at start). Anything that
speaks or prompts in a language reads it from here instead of branching on strings.
"""

from __future__ import annotations

DEFAULT_LANGUAGE = "de"
SUPPORTED_LANGUAGES: tuple[str, ...] = ("de", "en")

# What the reply LLM is told. The configurable system prompt stays German-centric by default,
# so for other languages we append an override instead of rewriting the user's prompt.
_REPLY_OVERRIDE = {
    "de": "",
    "en": (
        "\nLANGUAGE OVERRIDE: the founder speaks English. Conduct the whole conversation in "
        "English (spoken style, ≤2 sentences). Ignore any instruction above to use German, "
        "except the button name „Dossier abschließen“ which stays as written."
    ),
}

_SUMMARY_LANGUAGE_NAME = {"de": "German", "en": "English"}

_GREETING = {
    "de": None,  # None = use the configurable greeting from InterviewConfig
    "en": (
        "Hello, I am your HTGF intake analyst. Tell me in about a minute about your team, "
        "product status, traction, market and funding needs — I will ask targeted follow-ups."
    ),
}


def normalize_language(value: str | None) -> str:
    """'en-US' / 'EN' / '' / unknown -> a supported two-letter code (default 'de')."""
    code = (value or "").strip().lower().split("-", 1)[0]
    return code if code in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE


def reply_prompt_suffix(language: str) -> str:
    return _REPLY_OVERRIDE[normalize_language(language)]


def summary_language_name(language: str) -> str:
    return _SUMMARY_LANGUAGE_NAME[normalize_language(language)]


def builtin_greeting(language: str) -> str | None:
    """Fixed greeting for a language, or None if the editable (German) greeting applies."""
    return _GREETING[normalize_language(language)]
