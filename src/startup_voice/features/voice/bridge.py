"""LiveKit + PersonaPlex HF tool-calling bridge (X-Functions + 0x05 inject)."""

from __future__ import annotations

import base64
import json
from typing import Any

from startup_voice.domain import DIMENSIONS_SPEC, SLOT_ORDER, SlotId

KIND_INJECT = 0x05


def build_personaplex_functions_config(
    *,
    webhook_base: str,
    session_id: str,
    allowed_hosts: list[str] | None = None,
) -> dict[str, Any]:
    """Declarative tool schema for abhinavpgagi/personaplex-tool-calling."""
    host = webhook_base.rstrip("/")
    return {
        "prompt": (
            "Decide whether to call a function to store startup intake facts "
            "from the live founder conversation."
        ),
        "filler": "Einen Moment, ich halte das fest.",
        "allowed_hosts": allowed_hosts or ["127.0.0.1", "localhost"],
        "functions": [
            {
                "name": "save_startup_dimension",
                "description": "Store one intake dimension (team/product/traction/market/financing).",
                "endpoint": f"{host}/api/sessions/{session_id}/tool-webhook",
                "method": "POST",
                "param_location": "json",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "slot": {
                            "type": "string",
                            "enum": list(SLOT_ORDER),
                            "description": "Which intake object to update",
                        },
                        "summary": {"type": "string"},
                        "evidence": {"type": "array", "items": {"type": "string"}},
                        "fields": {
                            "type": "object",
                            "additionalProperties": {"type": "string"},
                            "description": "Map of required field name to value",
                        },
                    },
                    "required": ["slot"],
                },
            },
            {
                "name": "finalize_startup_dossier",
                "description": "Close the intake and write the dossier when all slots are solid.",
                "endpoint": f"{host}/api/sessions/{session_id}/finalize",
                "method": "POST",
                "param_location": "json",
                "parameters": {"type": "object", "properties": {}},
            },
        ],
    }


def build_personaplex_headers(
    *,
    text_prompt: str,
    functions_config: dict[str, Any],
    api_key: str | None = None,
) -> dict[str, str]:
    headers = {
        "X-Text-Prompt": base64.b64encode(text_prompt.encode("utf-8")).decode("ascii"),
        "X-Functions": base64.b64encode(
            json.dumps(functions_config, ensure_ascii=False).encode("utf-8")
        ).decode("ascii"),
    }
    if api_key:
        headers["Authorization"] = f"Api-Key {api_key}"
    return headers


def encode_inner_monologue_inject(text: str) -> bytes:
    """PersonaPlex KIND_INJECT (0x05) — teacher-force next question into voice."""
    return bytes([KIND_INJECT]) + text.encode("utf-8")


def personaplex_system_prompt() -> str:
    slots = "; ".join(f"{s}: {DIMENSIONS_SPEC[s].label}" for s in SLOT_ORDER)
    return (
        "You are an HTGF first-conversation analyst. Collect solid facts for: "
        f"{slots}. Ask one precise follow-up at a time. Use tools to save facts."
    )


def livekit_tool_schemas() -> list[dict[str, Any]]:
    """OpenAI-style tool schemas for LiveKit @function_tool adapters."""
    field_desc = {
        s: DIMENSIONS_SPEC[s].required_fields for s in SLOT_ORDER
    }
    return [
        {
            "type": "function",
            "function": {
                "name": "save_startup_dimension",
                "description": f"Save intake fields. Slots/fields: {field_desc}",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "slot": {"type": "string", "enum": list(SLOT_ORDER)},
                        "summary": {"type": "string"},
                        "evidence": {"type": "array", "items": {"type": "string"}},
                        "fields": {"type": "object", "additionalProperties": {"type": "string"}},
                    },
                    "required": ["slot"],
                },
            },
        }
    ]


def parse_tool_webhook_body(body: dict[str, Any]) -> tuple[SlotId, dict[str, str], str, list[str]]:
    slot = body.get("slot") or body.get("dimension")
    if slot not in SLOT_ORDER:
        raise ValueError(f"Invalid slot: {slot!r}")
    fields = {str(k): str(v) for k, v in (body.get("fields") or {}).items() if v}
    summary = str(body.get("summary") or "")
    evidence = [str(x) for x in (body.get("evidence") or []) if str(x).strip()]
    return slot, fields, summary, evidence  # type: ignore[return-value]
