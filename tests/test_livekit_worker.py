"""Checks that need the real LiveKit SDK (extra `livekit-voice`); skipped when it is not installed.

  * our stdlib-signed join token is accepted by LiveKit's OWN verifier (the web app itself
    does not depend on the SDK, so this is the only place the two meet);
  * the worker never calls an LLM: it forwards the transcript and stops the default reply.
"""

import asyncio
import json

import pytest

pytest.importorskip("livekit.api")
pytest.importorskip("livekit.agents")

from livekit import api  # noqa: E402
from livekit.agents import StopResponse  # noqa: E402

from startup_voice.features.voice import livekit_worker as worker  # noqa: E402
from startup_voice.features.voice.transports.livekit import mint_token  # noqa: E402


def test_official_verifier_accepts_our_token():
    token = mint_token(
        api_key="devkey", api_secret="secret-secret-secret-secret-1234", identity="founder-1",
        room="intake-abc-123", name="Founder", metadata=json.dumps({"language": "de"}),
    )
    claims = api.TokenVerifier(api_key="devkey", api_secret="secret-secret-secret-secret-1234").verify(token)

    assert claims.identity == "founder-1"
    assert claims.name == "Founder"
    assert json.loads(claims.metadata) == {"language": "de"}
    assert claims.video.room == "intake-abc-123"
    assert claims.video.room_join is True
    assert claims.video.can_publish and claims.video.can_subscribe and claims.video.can_publish_data


def test_official_verifier_rejects_a_token_signed_with_another_secret():
    token = mint_token(api_key="devkey", api_secret="one-secret-one-secret-one-secret-1", identity="i", room="r")
    with pytest.raises(Exception):
        api.TokenVerifier(api_key="devkey", api_secret="two-secret-two-secret-two-secret-2").verify(token)


class _Msg:
    def __init__(self, text):
        self.text_content = text


def test_finished_turn_is_forwarded_and_the_default_reply_is_suppressed():
    events = []
    agent = worker.VoiceIOAgent(events.append)

    with pytest.raises(StopResponse):
        asyncio.run(agent.on_user_turn_completed(None, _Msg("  Wir sind zwei Gründer  ")))

    assert events == [{"t": "transcript", "text": "Wir sind zwei Gründer"}]


def test_empty_turn_sends_nothing():
    events = []
    with pytest.raises(StopResponse):
        asyncio.run(worker.VoiceIOAgent(events.append).on_user_turn_completed(None, _Msg("   ")))
    assert events == []


def test_stt_provider_prefers_deepgram_then_elevenlabs(monkeypatch):
    for key in ("DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY", "LIVEKIT_STT"):
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(RuntimeError, match="DEEPGRAM_API_KEY or ELEVENLABS_API_KEY"):
        worker.pick_stt_provider()
    monkeypatch.setenv("ELEVENLABS_API_KEY", "x")
    assert worker.pick_stt_provider() == "elevenlabs"
    monkeypatch.setenv("DEEPGRAM_API_KEY", "y")
    assert worker.pick_stt_provider() == "deepgram"
    monkeypatch.setenv("LIVEKIT_STT", "elevenlabs")
    assert worker.pick_stt_provider() == "elevenlabs"


def test_providers_build_for_both_languages(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "fake")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "fake")
    monkeypatch.delenv("LIVEKIT_STT", raising=False)
    for lang in ("de", "en"):
        name, stt = worker.build_stt(lang)
        assert name == "deepgram" and stt is not None
        assert worker.build_tts(lang, {"stability": 5, "speed": "fast"}) is not None  # clamped / defaulted


def test_tts_needs_its_key(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="ELEVENLABS_API_KEY"):
        worker.build_tts("de", {})


def test_local_whisper_via_openai_compatible_server(monkeypatch):
    monkeypatch.setenv("LIVEKIT_STT", "local")
    monkeypatch.delenv("LIVEKIT_STT_BASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="LIVEKIT_STT_BASE_URL"):
        worker.build_stt("de")
    monkeypatch.setenv("LIVEKIT_STT_BASE_URL", "http://127.0.0.1:8000/v1")
    monkeypatch.setenv("LIVEKIT_STT_MODEL", "Systran/faster-whisper-small")
    name, stt = worker.build_stt("de")
    assert name == "local" and stt.capabilities.streaming is False
    monkeypatch.setenv("LIVEKIT_STT", "openai_compatible")  # alias
    assert worker.pick_stt_provider() == "local"


def test_provider_errors_read_as_plain_sentences():
    quota = "ElevenLabs STT error [quota_exceeded]"
    assert "Kontingent" in worker.describe_voice_error("stt", quota, "de")
    assert "quota" in worker.describe_voice_error("tts", quota, "en")
    assert "Schlüssel" in worker.describe_voice_error("tts", "401 Unauthorized", "de")
    assert "not responding" in worker.describe_voice_error("stt", "connection reset", "en")
    assert "Spracherkennung" in worker.describe_voice_error("stt", "boom", "de")
