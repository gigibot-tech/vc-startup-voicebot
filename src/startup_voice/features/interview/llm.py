"""Configurable LLM: Ollama chat/generate + OpenAI-compatible chat.

This is the ONLY module that makes network calls to the language model.
The browser never reaches it directly; the call chain is::

    app.js sendText() -> web.py turn_stream() -> pipeline.py stream_turn()
        -> stream()                  #1 REPLY    (spoken next question — first for UX)
        -> complete(json_mode=True)  #2 EXTRACT  (facts + belege JSON after stream)
    Side paths: SCORE_BELEGE / SUMMARY via complete(); PersonaPlex tool webhook is HTTP, not LLM tools.

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


def _loads_dict(raw: str) -> dict[str, Any] | None:
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        return None


def _close_truncated_json(raw: str) -> str:
    """Best-effort close of braces/brackets/strings when the model hits max_tokens mid-JSON."""
    s = raw.rstrip()
    if not s:
        return s
    # Drop a trailing bare comma so closers can attach cleanly.
    s = re.sub(r",\s*$", "", s)
    if re.search(r":\s*$", s):
        s += '""'
    in_str = False
    escape = False
    stack: list[str] = []
    for ch in s:
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]" and stack and ch == stack[-1]:
            stack.pop()
    if in_str:
        s += '"'
        # Cut off mid-key (`"background`) → treat as empty string value.
        if re.search(r'[,{]\s*"[^"]*"$', s):
            s += ': ""'
    while stack:
        s += stack.pop()
    return s


def extract_json_block(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    if not raw:
        return None
    data = _loads_dict(raw)
    if data is not None:
        return data
    fence = re.search(r"```(?:json)?\s*(\{.*)\s*```", raw, re.S)
    if fence:
        frag = fence.group(1).strip()
        data = _loads_dict(frag) or _loads_dict(_close_truncated_json(frag))
        if data is not None:
            return data
    start = raw.find("{")
    if start < 0:
        return None
    frag = raw[start:]
    end = frag.rfind("}")
    if end > 0:
        data = _loads_dict(frag[: end + 1])
        if data is not None:
            return data
    return _loads_dict(_close_truncated_json(frag))


# Known default context windows by model family (overridable via LLM_CONTEXT_WINDOW in .env).
_MODEL_CTX_DEFAULTS: tuple[tuple[str, int], ...] = (
    ("granite4", 32768),
    ("granite3", 8192),
    ("granite", 8192),
    ("llama-3.1", 131072),
    ("llama3.1", 131072),
    ("llama3.2", 131072),
    ("llama3", 8192),
    ("mistral", 32768),
    ("qwen2.5", 32768),
    ("qwen", 32768),
    ("gemma2", 8192),
    ("gpt-4o", 128000),
    ("gpt-4", 128000),
)


def resolve_context_window(model: str) -> int:
    """Return effective context window for ``model`` (LLM_CONTEXT_WINDOW in .env wins)."""
    raw = os.getenv("LLM_CONTEXT_WINDOW", "").strip()
    if raw:
        try:
            return max(512, int(raw))
        except ValueError:
            pass
    low = (model or "").lower()
    for prefix, ctx in _MODEL_CTX_DEFAULTS:
        if prefix in low:
            return ctx
    return 8192


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
        self.last_meta: dict[str, Any] = {}

    @property
    def context_window(self) -> int:
        return resolve_context_window(self.model)

    def _record_meta(
        self,
        *,
        done_reason: str = "",
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        max_tokens: int | None = None,
        system: str = "",
        user: str = "",
        output: str = "",
    ) -> None:
        ctx = self.context_window
        est_prompt = prompt_tokens or max(1, (len(system) + len(user)) // 4)
        est_comp = completion_tokens or max(1, len(output) // 4)
        total = est_prompt + est_comp
        reason = (done_reason or "").lower()
        truncated = reason in {"length", "max_tokens"} or (
            bool(max_tokens) and completion_tokens >= int(max_tokens)
        )
        near_ctx = total >= int(ctx * 0.85)
        warning = ""
        if truncated and near_ctx:
            warning = f"Kontext-/Tokenlimit erreicht ({self.model} · ~{total}/{ctx} tok) — Antwort evtl. gekürzt"
        elif truncated:
            warning = f"Max-Token-Limit erreicht ({self.model} · {max_tokens or est_comp} tok) — Antwort evtl. gekürzt"
        elif near_ctx:
            warning = f"Kontextfenster fast voll ({self.model} · ~{total}/{ctx} tok)"
        self.last_meta = {
            "model": self.model,
            "context_window": ctx,
            "prompt_tokens": est_prompt,
            "completion_tokens": est_comp,
            "total_tokens": total,
            "done_reason": reason or "stop",
            "truncated": truncated,
            "near_context_limit": near_ctx,
            "warning": warning,
        }

    def _timeout(self) -> float:
        return float(os.getenv("LLM_TIMEOUT", "120"))

    def complete(
        self,
        system: str,
        user: str,
        *,
        max_tokens: int | None = None,
        json_mode: bool = False,
    ) -> str:
        if self.provider in {"openai", "openai_compatible", "vllm"}:
            return self._openai(system, user, max_tokens=max_tokens, json_mode=json_mode)
        return self._ollama(system, user, max_tokens=max_tokens, json_mode=json_mode)

    def _ollama(
        self, system: str, user: str, *, max_tokens: int | None, json_mode: bool = False
    ) -> str:
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
        # Constrains output to JSON — dossier extract is much more reliable this way.
        if json_mode:
            payload["format"] = "json"
        with httpx.Client(timeout=self._timeout()) as client:
            resp = client.post(f"{self.base_url}/api/chat", json=payload)
            if resp.status_code == 400 and "does not support chat" in resp.text:
                prompt = f"System:\n{system}\n\nUser:\n{user}\n\nAssistant:"
                gen: dict[str, Any] = {
                    "model": self.model,
                    "prompt": prompt,
                    "stream": False,
                    "options": options,
                }
                if json_mode:
                    gen["format"] = "json"
                resp = client.post(f"{self.base_url}/api/generate", json=gen)
                resp.raise_for_status()
                body = resp.json()
                out = str(body.get("response") or "").strip()
                self._record_meta(
                    done_reason=str(body.get("done_reason") or ""),
                    prompt_tokens=int(body.get("prompt_eval_count") or 0),
                    completion_tokens=int(body.get("eval_count") or 0),
                    max_tokens=max_tokens,
                    system=system,
                    user=user,
                    output=out,
                )
                return out
            resp.raise_for_status()
            body = resp.json()
            msg = body.get("message") or {}
            content = str(msg.get("content") or "").strip()
            out = content or str(msg.get("thinking") or "").strip()
            self._record_meta(
                done_reason=str(body.get("done_reason") or ""),
                prompt_tokens=int(body.get("prompt_eval_count") or 0),
                completion_tokens=int(body.get("eval_count") or 0),
                max_tokens=max_tokens,
                system=system,
                user=user,
                output=out,
            )
            return out

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
                    acc: list[str] = []
                    done_reason = ""
                    p_tok = 0
                    c_tok = 0
                    for line in resp.iter_lines():
                        if not line:
                            continue
                        data = json.loads(line)
                        if data.get("done"):
                            done_reason = str(data.get("done_reason") or "")
                            p_tok = int(data.get("prompt_eval_count") or 0)
                            c_tok = int(data.get("eval_count") or 0)
                        chunk = (
                            (data.get("message") or {}).get("content")
                            if field == "chat"
                            else data.get("response")
                        )
                        if chunk:
                            s_chunk = str(chunk)
                            acc.append(s_chunk)
                            yield s_chunk
                    self._record_meta(
                        done_reason=done_reason,
                        prompt_tokens=p_tok,
                        completion_tokens=c_tok,
                        max_tokens=max_tokens,
                        system=system,
                        user=user,
                        output="".join(acc),
                    )
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
                acc: list[str] = []
                finish_reason = ""
                for line in resp.iter_lines():
                    if not line.startswith("data:"):
                        continue
                    body = line[5:].strip()
                    if body == "[DONE]":
                        break
                    parsed = json.loads(body)
                    choice = (parsed.get("choices") or [{}])[0]
                    if choice.get("finish_reason"):
                        finish_reason = str(choice["finish_reason"])
                    chunk = (choice.get("delta") or {}).get("content")
                    if chunk:
                        s_chunk = str(chunk)
                        acc.append(s_chunk)
                        yield s_chunk
                self._record_meta(
                    done_reason=finish_reason,
                    max_tokens=max_tokens,
                    system=system,
                    user=user,
                    output="".join(acc),
                )
                return

    def _openai_url(self) -> str:
        url = self.base_url
        if not url.endswith("/chat/completions"):
            url = f"{url}/v1/chat/completions" if not url.endswith("/v1") else f"{url}/chat/completions"
        return url

    def _openai(
        self, system: str, user: str, *, max_tokens: int | None, json_mode: bool = False
    ) -> str:
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
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        url = self._openai_url()
        with httpx.Client(timeout=self._timeout()) as client:
            resp = client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            body = resp.json()
            choice = (body.get("choices") or [{}])[0]
            usage = body.get("usage") or {}
            out = str((choice.get("message") or {}).get("content") or "").strip()
            self._record_meta(
                done_reason=str(choice.get("finish_reason") or ""),
                prompt_tokens=int(usage.get("prompt_tokens") or 0),
                completion_tokens=int(usage.get("completion_tokens") or 0),
                max_tokens=max_tokens,
                system=system,
                user=user,
                output=out,
            )
            return out

