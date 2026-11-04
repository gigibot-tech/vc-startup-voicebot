"""Editable interview config: system prompt + Fragenkatalog (persisted on disk)."""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, Field

from startup_voice.domain import SLOT_ORDER, SlotId
from startup_voice.features.interview.prompts import (
    DEFAULT_GREETING,
    DEFAULT_REPLY_SYSTEM,
    DEFAULT_SLOT_QUESTIONS,
)

class InterviewConfig(BaseModel):
    """UI-editable interview brain (not TTS tonality — that stays in prefs)."""

    reply_system_prompt: str = DEFAULT_REPLY_SYSTEM
    greeting: str = DEFAULT_GREETING
    slot_questions: dict[str, str] = Field(
        default_factory=lambda: dict(DEFAULT_SLOT_QUESTIONS)
    )

    def question_for(self, slot: SlotId) -> str:
        q = (self.slot_questions.get(slot) or "").strip()
        return q or DEFAULT_SLOT_QUESTIONS[slot]

    def normalized(self) -> InterviewConfig:
        questions = {s: DEFAULT_SLOT_QUESTIONS[s] for s in SLOT_ORDER}
        for slot in SLOT_ORDER:
            raw = (self.slot_questions.get(slot) or "").strip()
            if raw:
                questions[slot] = raw
        return InterviewConfig(
            reply_system_prompt=(self.reply_system_prompt or "").strip() or DEFAULT_REPLY_SYSTEM,
            greeting=(self.greeting or "").strip() or DEFAULT_GREETING,
            slot_questions=questions,
        )


class InterviewConfigStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._cache: InterviewConfig | None = None

    def load(self) -> InterviewConfig:
        if self._cache is not None:
            return self._cache
        if self.path.is_file():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                self._cache = InterviewConfig.model_validate(data).normalized()
                return self._cache
            except Exception:
                pass
        self._cache = InterviewConfig().normalized()
        return self._cache

    def save(self, config: InterviewConfig) -> InterviewConfig:
        normalized = config.normalized()
        self.path.write_text(
            normalized.model_dump_json(indent=2),
            encoding="utf-8",
        )
        self._cache = normalized
        return normalized

    def reset(self) -> InterviewConfig:
        if self.path.exists():
            self.path.unlink()
        self._cache = None
        return self.load()
