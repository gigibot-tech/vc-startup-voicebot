"""Configurable LLM: Ollama chat/generate + OpenAI-compatible chat.

This is the ONLY module that makes network calls to the language model.
The browser never reaches it directly; the call chain is::

    app.js sendText() -> web.py turn_stream() -> pipeline.py stream_turn()
        -> ConfigurableLLM.complete()  (LLM call #1: extract facts, one JSON blob)
        -> ConfigurableLLM.stream()    (LLM call #2: the reply, chunk by chunk)

Voice (STT/TTS) is not involved here at all: this module sees text in, text out.

Two entry points, one per delivery style, each with a provider switch
(``LLM_PROVIDER``: ollama | openai | openai_compatible | vllm):

    complete()  blocking, returns the whole string   -> _ollama / _openai
    stream()    generator, yields chunks as produced -> _ollama_stream / _openai_stream

Wire formats consumed by stream():
    Ollama  : newline-delimited JSON, one object per line
              chat -> {"message": {"content": "..."}}   generate -> {"response": "..."}
    OpenAI  : Server-Sent Events, ``data: {...}`` lines, ends with ``data: [DONE]``
              text lives in choices[0].delta.content
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator
from typing import Any

import httpx


def extract_json_block(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        pass
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.S)
    if fence:
        try:
            data = json.loads(fence.group(1))
            return data if isinstance(data, dict) else None
        except json.JSONDecodeError:
            return None
    start, end = raw.find("{"), raw.rfind("}")
    if start >= 0 and end > start:
        try:
            data = json.loads(raw[start : end + 1])
            return data if isinstance(data, dict) else None
        except json.JSONDecodeError:
            return None
    return None


class ConfigurableLLM:
    def __init__(
        self,
        *,
        provider: str | None = None,
        model: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
    ) -> None:
        self.provider = (provider or os.getenv("LLM_PROVIDER", "ollama")).lower()
        self.model = model or os.getenv("LLM_MODEL", "granite4.2:8b")
        self.base_url = (base_url or os.getenv("LLM_BASE_URL", "http://127.0.0.1:11434")).rstrip("/")
        self.api_key = api_key or os.getenv("LLM_API_KEY", "")

    def _timeout(self) -> float:
        return float(os.getenv("LLM_TIMEOUT", "120"))

    def complete(self, system: str, user: str, *, max_tokens: int | None = None) -> str:
        if self.provider in {"openai", "openai_compatible", "vllm"}:
            return self._openai(system, user, max_tokens=max_tokens)
        return self._ollama(system, user, max_tokens=max_tokens)

    def _ollama(self, system: str, user: str, *, max_tokens: int | None) -> str:
        options: dict[str, Any] = {"temperature": 0.2}
        if max_tokens is not None:
            options["num_predict"] = max_tokens
        # granite4.x "thinking" often leaves content empty — disable when supported.
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": False,
            "think": False,
            "options": options,
        }
        with httpx.Client(timeout=self._timeout()) as client:
            resp = client.post(f"{self.base_url}/api/chat", json=payload)
            if resp.status_code == 400 and "does not support chat" in resp.text:
                prompt = f"System:\n{system}\n\nUser:\n{user}\n\nAssistant:"
                resp = client.post(
                    f"{self.base_url}/api/generate",
                    json={"model": self.model, "prompt": prompt, "stream": False, "options": options},
                )
                resp.raise_for_status()
                return str(resp.json().get("response") or "").strip()
            resp.raise_for_status()
            msg = resp.json().get("message") or {}
            content = str(msg.get("content") or "").strip()
            # Fallback: some thinking models still emit JSON only in `thinking`.
            return content or str(msg.get("thinking") or "").strip()

    def stream(self, system: str, user: str, *, max_tokens: int | None = None) -> Iterator[str]:
        """Yield text chunks as the model produces them (streaming twin of complete()).

        Used ONLY for the user-visible reply (pipeline.stream_turn). The extraction
        call stays on complete() because partial JSON cannot be parsed.
        Each yielded string is a raw fragment: may be a word piece, may start or
        end mid-word. The caller concatenates them.
        """
        if self.provider in {"openai", "openai_compatible", "vllm"}:
            yield from self._openai_stream(system, user, max_tokens=max_tokens)
        else:
            yield from self._ollama_stream(system, user, max_tokens=max_tokens)

    def _ollama_stream(self, system: str, user: str, *, max_tokens: int | None) -> Iterator[str]:
        options: dict[str, Any] = {"temperature": 0.2}
        if max_tokens is not None:
            options["num_predict"] = max_tokens
        chat_payload: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": True,
            "think": False,
            "options": options,
        }
        prompt = f"System:\n{system}\n\nUser:\n{user}\n\nAssistant:"
        gen_payload = {"model": self.model, "prompt": prompt, "stream": True, "options": options}
        with httpx.Client(timeout=self._timeout()) as client:
            url, payload, field = f"{self.base_url}/api/chat", chat_payload, "chat"
            for _ in range(2):
                with client.stream("POST", url, json=payload) as resp:
                    if resp.status_code == 400 and field == "chat":
                        resp.read()
                        if "does not support chat" in resp.text:
                            url, payload, field = f"{self.base_url}/api/generate", gen_payload, "generate"
                            continue
                    if resp.status_code >= 400:
                        resp.read()
                    resp.raise_for_status()
                    for line in resp.iter_lines():
                        if not line:
                            continue
                        data = json.loads(line)
                        chunk = (
                            (data.get("message") or {}).get("content")
                            if field == "chat"
                            else data.get("response")
                        )
                        if chunk:
                            yield str(chunk)
                    return

    def _openai_stream(self, system: str, user: str, *, max_tokens: int | None) -> Iterator[str]:
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.2,
            "stream": True,
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        with httpx.Client(timeout=self._timeout()) as client:
            with client.stream("POST", self._openai_url(), headers=headers, json=payload) as resp:
                if resp.status_code >= 400:
                    resp.read()
                resp.raise_for_status()
                for line in resp.iter_lines():
                    if not line.startswith("data:"):
                        continue
                    body = line[5:].strip()
                    if body == "[DONE]":
                        return
                    choice = (json.loads(body).get("choices") or [{}])[0]
                    chunk = (choice.get("delta") or {}).get("content")
                    if chunk:
                        yield str(chunk)

    def _openai_url(self) -> str:
        url = self.base_url
        if not url.endswith("/chat/completions"):
            url = f"{url}/v1/chat/completions" if not url.endswith("/v1") else f"{url}/chat/completions"
        return url

    def _openai(self, system: str, user: str, *, max_tokens: int | None) -> str:
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.2,
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        url = self._openai_url()
        with httpx.Client(timeout=self._timeout()) as client:
            resp = client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            choice = (resp.json().get("choices") or [{}])[0]
            return str((choice.get("message") or {}).get("content") or "").strip()

