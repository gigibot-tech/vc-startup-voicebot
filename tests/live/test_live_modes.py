"""LIVE checks of the hands-free call against a real LiveKit project + a running worker.

Skipped unless RUN_LIVE_VOICE=1 (they join a real room and spend a few seconds of STT/TTS):

    uv run --extra livekit-voice startup-voice-agent dev        # terminal 1
    RUN_LIVE_VOICE=1 uv run --extra livekit-voice pytest tests/live -v   # terminal 2

What each test proves (and which provider has to be alive for it):
  * worker VAD sees speech in a real recording ........... any STT key (or none: VAD is local)
  * a finished turn arrives as ONE `transcript` event ..... server STT (Deepgram/ElevenLabs/local)
  * the transcript really says what was spoken ............ server STT
  * the worker speaks a reply and reports speak_done ...... ElevenLabs TTS credits
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

pytest.importorskip("livekit.rtc")
if os.getenv("RUN_LIVE_VOICE") != "1":
    pytest.skip("set RUN_LIVE_VOICE=1 to run against a live worker", allow_module_level=True)

from live_client import run_call  # noqa: E402

WAV = Path(__file__).resolve().parents[1] / "fixtures" / "speech_de_two_turns.wav"


def _call(**kw):
    return asyncio.run(run_call(**kw))


def test_worker_vad_detects_speech_in_server_mode():
    call = _call(stt="server", wav=WAV)
    if call.of("error") and not call.of("ready"):
        pytest.skip(f"worker did not start: {call.of('error')[0][1]}")
    states = [e["state"] for _, e in call.of("user_state")]
    assert "speaking" in states, f"VAD never fired: {call.events}"


def test_each_spoken_turn_becomes_one_transcript_with_the_right_words():
    call = _call(stt="server", wav=WAV, tail_s=6.0)
    errs = [e for _, e in call.of("error") if e.get("scope") == "stt"]
    if errs:
        pytest.skip(f"server STT unavailable: {errs[0]['message']}")
    turns = [e["text"].lower() for _, e in call.of("transcript")]
    assert len(turns) == 2, f"expected 2 turns (pause inside a turn must not split it): {turns}; events={call.events}"
    assert "gründer" in turns[0] or "gruender" in turns[0]
    assert "sprachen" in turns[1]


def test_worker_speaks_a_reply_and_says_when_it_is_done():
    call = _call(stt="browser", wav=None, say="Hallo, wer seid ihr?")
    errs = [e for _, e in call.of("error") if e.get("scope") == "tts"]
    if errs:
        pytest.skip(f"TTS unavailable: {errs[0]['message']}")
    done = [e for _, e in call.of("speak_done")]
    assert done and done[0]["interrupted"] is False, f"no clean speak_done: {call.events}"
    assert call.agent_loud_seconds > 0.5, "speak_done came but no audio was heard (silent TTS)"
