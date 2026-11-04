"""STT: Strategy providers + Router with fail-fast probe and fallback chain.

Same composition style as InterviewPipeline(llm=…): inject providers, orchestrate.
STT does NOT live inside InterviewPipeline (that is dossier turns only).
"""

from __future__ import annotations

import io
import os
import socket
from dataclasses import dataclass, field
from typing import Protocol
import httpx
from elevenlabs import ElevenLabs

_DG_MODEL = "nova-2"
_EL_MODEL = "scribe_v1"
_DEFAULT_LANG = "de"
_PROBE_TIMEOUT = float(os.getenv("STT_PROBE_TIMEOUT", "2.5"))
_STT_TIMEOUT = float(os.getenv("STT_TIMEOUT", "45"))


class SttError(RuntimeError):
    """Raised when transcription / probe fails."""


def _lang(language: str | None) -> str:
    lang = (language or os.getenv("STT_LANGUAGE", _DEFAULT_LANG)).strip() or _DEFAULT_LANG
    if "-" in lang:
        lang = lang.split("-", 1)[0].lower()
    return lang


def _dns_ok(host: str, timeout: float = _PROBE_TIMEOUT) -> None:
    try:
        socket.setdefaulttimeout(timeout)
        socket.getaddrinfo(host, 443)
    except OSError as exc:
        raise SttError(f"DNS/network unreachable for {host}: {exc}") from exc


class SttBackend(Protocol):
    name: str

    def configured(self) -> bool: ...

    def probe(self) -> None:
        """Fail fast if this backend cannot be used right now."""

    def transcribe(
        self,
        audio: bytes,
        *,
        content_type: str = "audio/webm",
        language: str | None = None,
    ) -> str: ...


@dataclass
class ElevenLabsStt:
    name: str = "elevenlabs"

    def configured(self) -> bool:
        return bool(os.getenv("ELEVENLABS_API_KEY", "").strip())

    def probe(self) -> None:
        if not self.configured():
            raise SttError("ELEVENLABS_API_KEY missing")
        _dns_ok("api.elevenlabs.io")

    def transcribe(
        self,
        audio: bytes,
        *,
        content_type: str = "audio/webm",
        language: str | None = None,
    ) -> str:
        self.probe()
        if not audio:
            raise SttError("empty audio")
        model = os.getenv("ELEVENLABS_STT_MODEL", _EL_MODEL).strip() or _EL_MODEL
        ext = "webm" if "webm" in (content_type or "") else "audio"
        buf = io.BytesIO(audio)
        buf.name = f"utterance.{ext}"
        client = ElevenLabs(api_key=os.getenv("ELEVENLABS_API_KEY", "").strip())
        try:
            result = client.speech_to_text.convert(
                model_id=model,
                file=buf,
                language_code=_lang(language),
                tag_audio_events=False,
            )
        except Exception as exc:
            raise SttError(f"ElevenLabs STT failed: {exc}") from exc
        return (getattr(result, "text", None) or "").strip()


@dataclass
class DeepgramStt:
    name: str = "deepgram"

    def configured(self) -> bool:
        return bool(os.getenv("DEEPGRAM_API_KEY", "").strip())

    def probe(self) -> None:
        if not self.configured():
            raise SttError("DEEPGRAM_API_KEY missing")
        _dns_ok("api.deepgram.com")

    def transcribe(
        self,
        audio: bytes,
        *,
        content_type: str = "audio/webm",
        language: str | None = None,
    ) -> str:
        self.probe()
        if not audio:
            raise SttError("empty audio")
        model = os.getenv("DEEPGRAM_STT_MODEL", _DG_MODEL).strip() or _DG_MODEL
        params = {
            "model": model,
            "language": _lang(language),
            "smart_format": "true",
            "punctuate": "true",
        }
        headers = {
            "Authorization": f"Token {os.getenv('DEEPGRAM_API_KEY', '').strip()}",
            "Content-Type": content_type or "application/octet-stream",
        }
        with httpx.Client(timeout=_STT_TIMEOUT) as client:
            res = client.post(
                "https://api.deepgram.com/v1/listen",
                params=params,
                headers=headers,
                content=audio,
            )
        if res.status_code >= 400:
            detail = res.text[:300] if res.text else res.reason_phrase
            raise SttError(f"Deepgram {res.status_code}: {detail}")
        data = res.json()
        try:
            alt = data["results"]["channels"][0]["alternatives"][0]
            return (alt.get("transcript") or "").strip()
        except (KeyError, IndexError, TypeError) as exc:
            raise SttError("unexpected Deepgram response") from exc


@dataclass
class SttRouter:
    """Orchestrates STT backends with preferred → fallback chain (fail-fast probe)."""

    backends: list[SttBackend] = field(default_factory=list)

    @classmethod
    def default(cls) -> SttRouter:
        return cls(backends=[ElevenLabsStt(), DeepgramStt()])

    def available_names(self) -> list[str]:
        names = [b.name for b in self.backends if b.configured()]
        names.append("browser")
        return names

    def default_name(self) -> str:
        pref = (os.getenv("STT_PROVIDER") or "").strip().lower()
        avail = self.available_names()
        if pref in avail:
            return pref
        for b in self.backends:
            if b.configured():
                return b.name
        return "browser"

    def _get(self, name: str) -> SttBackend | None:
        for b in self.backends:
            if b.name == name:
                return b
        return None

    def _chain(self, preferred: str | None) -> list[SttBackend]:
        want = (preferred or self.default_name()).strip().lower()
        ordered: list[SttBackend] = []
        first = self._get(want)
        if first and first.configured():
            ordered.append(first)
        for b in self.backends:
            if b.configured() and b not in ordered:
                ordered.append(b)
        return ordered

    def probe(self, preferred: str | None = None) -> dict:
        """Fail-fast connectivity check. Returns {ok, provider, tried, errors}."""
        want = (preferred or self.default_name()).strip().lower()
        if want == "browser":
            return {"ok": True, "provider": "browser", "tried": ["browser"], "errors": []}
        tried: list[str] = []
        errors: list[str] = []
        for b in self._chain(want):
            tried.append(b.name)
            try:
                b.probe()
                return {"ok": True, "provider": b.name, "tried": tried, "errors": errors}
            except SttError as exc:
                errors.append(f"{b.name}: {exc}")
        return {
            "ok": False,
            "provider": None,
            "tried": tried or [want],
            "errors": errors or [f"no STT backend for {want}"],
            "fallback": "browser",
        }

    def transcribe(
        self,
        audio: bytes,
        *,
        content_type: str = "audio/webm",
        language: str | None = None,
        provider: str | None = None,
        fallback: bool = True,
    ) -> tuple[str, str, list[str]]:
        """Return (text, provider_used, errors_from_failed_attempts)."""
        want = (provider or self.default_name()).strip().lower()
        if want == "browser":
            raise SttError("browser STT is client-side only")
        chain = self._chain(want) if fallback else ([self._get(want)] if self._get(want) else [])
        chain = [b for b in chain if b and b.configured()]
        errors: list[str] = []
        for b in chain:
            try:
                text = b.transcribe(audio, content_type=content_type, language=language)
                return text, b.name, errors
            except SttError as exc:
                errors.append(f"{b.name}: {exc}")
                if not fallback:
                    break
        raise SttError("; ".join(errors) or f"STT failed ({want})")


# Module-level defaults used by web (composition root can replace).
_ROUTER = SttRouter.default()


def get_router() -> SttRouter:
    return _ROUTER


def elevenlabs_configured() -> bool:
    return ElevenLabsStt().configured()


def deepgram_configured() -> bool:
    return DeepgramStt().configured()


def available_providers() -> list[str]:
    return get_router().available_names()


def default_provider() -> str:
    return get_router().default_name()


def transcribe_audio(
    audio: bytes,
    *,
    content_type: str = "audio/webm",
    language: str | None = None,
    provider: str | None = None,
    fallback: bool = True,
) -> tuple[str, str]:
    text, used, _errs = get_router().transcribe(
        audio,
        content_type=content_type,
        language=language,
        provider=provider,
        fallback=fallback,
    )
    return text, used


def probe_tts_fast() -> dict:
    """Fail-fast TTS readiness (key + DNS). Not a full synthesize."""
    key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not key:
        return {"ok": False, "provider": None, "errors": ["ELEVENLABS_API_KEY missing"]}
    try:
        _dns_ok("api.elevenlabs.io")
        return {"ok": True, "provider": "elevenlabs", "errors": []}
    except SttError as exc:
        return {"ok": False, "provider": "elevenlabs", "errors": [str(exc)]}
