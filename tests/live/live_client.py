"""A stand-in for the founder's browser, for LIVE tests against a real LiveKit project.

It joins a room with a token from our own /api/voice/join code, publishes a WAV file as the
microphone track in real time, and records every event the voice worker sends back with timestamps.
Needs LIVEKIT_* in .env, the worker running (uv run --extra livekit-voice startup-voice-agent dev),
and, for server-side speech-to-text, an ElevenLabs or Deepgram key. Costs a few seconds of STT/TTS.
"""

from __future__ import annotations

import asyncio
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from livekit import rtc  # noqa: E402

from startup_voice.features.voice.livekit_protocol import TOPIC_CMD, TOPIC_EVT, decode, encode  # noqa: E402
from startup_voice.features.voice.transports import get_transport  # noqa: E402


@dataclass
class Call:
    events: list[tuple[float, dict]] = field(default_factory=list)
    audio_seconds_from_agent: float = 0.0
    agent_peak: float = 0.0  # loudest sample heard from the agent, 0..1 (0 = only silence)
    agent_loud_seconds: float = 0.0  # seconds that were not silence
    t0: float = 0.0

    def of(self, kind: str) -> list[tuple[float, dict]]:
        return [(t, e) for t, e in self.events if e.get("t") == kind]


async def run_call(*, stt: str, wav: Path | None, tail_s: float = 4.0, say: str | None = None,
                   ready_timeout: float = 45.0) -> Call:
    join = get_transport("livekit").join(session_id="livetest", language="de", voice={}, stt=stt)
    call = Call()
    room = rtc.Room()

    @room.on("data_received")
    def _on_data(packet: rtc.DataPacket) -> None:
        if packet.topic == TOPIC_EVT and (msg := decode(packet.data)):
            call.events.append((time.monotonic() - call.t0, msg))

    heard: list[asyncio.Task] = []

    @room.on("track_subscribed")
    def _on_track(track: rtc.Track, *_):
        if track.kind != rtc.TrackKind.KIND_AUDIO:
            return

        async def count() -> None:
            async for ev in rtc.AudioStream(track):
                dur = ev.frame.samples_per_channel / ev.frame.sample_rate
                call.audio_seconds_from_agent += dur
                pcm = memoryview(ev.frame.data).cast("h")
                peak = (max(abs(x) for x in pcm) / 32768) if len(pcm) else 0.0
                call.agent_peak = max(call.agent_peak, peak)
                if peak > 0.02:
                    call.agent_loud_seconds += dur

        heard.append(asyncio.ensure_future(count()))

    call.t0 = time.monotonic()
    await room.connect(join["url"], join["token"])
    try:
        source = rtc.AudioSource(16000, 1)
        track = rtc.LocalAudioTrack.create_audio_track("mic", source)
        if stt == "server":  # in browser mode the mic never leaves the browser
            await room.local_participant.publish_track(
                track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
            )
        deadline = time.monotonic() + ready_timeout
        while not call.of("ready") and not call.of("error") and time.monotonic() < deadline:
            await asyncio.sleep(0.1)
        if not call.of("ready"):
            return call

        if say is not None:
            await room.local_participant.publish_data(
                encode({"t": "say", "id": 1, "text": say}), reliable=True, topic=TOPIC_CMD
            )
            end = time.monotonic() + 15
            while not call.of("speak_done") and time.monotonic() < end:
                await asyncio.sleep(0.1)
            await asyncio.sleep(1.0)  # let the last audio frames arrive

        if wav is not None and stt == "server":
            call.t0 = time.monotonic()  # audio time zero = timestamps below are seconds into the recording
            call.events = [(0.0, e) for _, e in call.events]
            with wave.open(str(wav)) as w:
                assert w.getframerate() == 16000 and w.getnchannels() == 1
                pcm = w.readframes(w.getnframes())
            step = 160 * 2  # 10 ms
            start = time.monotonic()
            for i, off in enumerate(range(0, len(pcm), step)):
                chunk = pcm[off:off + step]
                if len(chunk) < step:
                    chunk += b"\x00" * (step - len(chunk))
                await source.capture_frame(rtc.AudioFrame(chunk, 16000, 1, 160))
                lag = (start + (i + 1) * 0.01) - time.monotonic()
                if lag > 0:
                    await asyncio.sleep(lag)
            await asyncio.sleep(tail_s)
    finally:
        await room.disconnect()
        for t in heard:
            t.cancel()
    return call
