"""LiveKit worker wire protocol + speak coordinator, with fakes (no livekit SDK, no network)."""

import asyncio

from startup_voice.features.voice.livekit_protocol import (
    SpeakCoordinator,
    SpeakStream,
    decode,
    encode,
)


class FakeHandle:
    """Stands in for livekit's SpeechHandle: interruptible, fires done callbacks."""

    def __init__(self):
        self.interrupted = False
        self.callbacks = []

    def interrupt(self):
        self.finish(interrupted=True)

    def add_done_callback(self, cb):
        self.callbacks.append(cb)

    def finish(self, *, interrupted=False):
        self.interrupted = interrupted
        for cb in list(self.callbacks):
            cb(self)


def make():
    handles, streams, events = [], [], []

    def say(stream):
        handles.append(FakeHandle())
        streams.append(stream)
        return handles[-1]

    return SpeakCoordinator(say=say, emit=events.append), handles, streams, events


async def drain(stream: SpeakStream) -> str:
    return "".join([piece async for piece in stream])


def test_encode_decode_roundtrip_keeps_umlauts():
    msg = {"t": "transcript", "text": "Wir sind zwei Gründer"}
    assert decode(encode(msg)) == msg


def test_decode_ignores_garbage():
    for bad in (b"\xff\xfe", b"not json", b"[1,2]", b'{"no_type":1}', b'{"t":5}'):
        assert decode(bad) is None


def test_stream_delivers_pieces_in_order_then_ends():
    async def go():
        s = SpeakStream()
        s.push("Hallo, ")
        s.push("wer seid ihr?")
        s.end()
        s.push("late")  # after end: dropped
        return await drain(s)

    assert asyncio.run(go()) == "Hallo, wer seid ihr?"


def test_begin_chunk_end_speaks_one_reply_and_reports_done():
    async def go():
        c, handles, streams, events = make()
        c.handle({"t": "speak_begin", "id": 1})
        c.handle({"t": "speak_chunk", "id": 1, "text": "Danke. "})
        c.handle({"t": "speak_chunk", "id": 1, "text": "Und weiter?"})
        c.handle({"t": "speak_end", "id": 1})
        text = await drain(streams[0])
        handles[0].finish()
        return text, events

    text, events = asyncio.run(go())
    assert text == "Danke. Und weiter?"
    assert events == [{"t": "speak_done", "id": 1, "interrupted": False}]


def test_say_is_a_one_shot():
    async def go():
        c, handles, streams, _ = make()
        c.handle({"t": "say", "id": 7, "text": "Hallo!"})
        return await drain(streams[0])

    assert asyncio.run(go()) == "Hallo!"


def test_cancel_interrupts_and_drops_text_that_is_still_arriving():
    async def go():
        c, handles, streams, events = make()
        c.handle({"t": "speak_begin", "id": 1})
        c.handle({"t": "speak_chunk", "id": 1, "text": "Teil eins. "})
        c.handle({"t": "speak_cancel"})
        c.handle({"t": "speak_chunk", "id": 1, "text": "kommt zu spät"})
        return await drain(streams[0]), handles[0].interrupted, events

    text, interrupted, events = asyncio.run(go())
    assert text == "Teil eins. "
    assert interrupted is True
    assert events == [{"t": "speak_done", "id": 1, "interrupted": True}]


def test_user_interrupting_the_agent_stops_further_text():
    """The worker's session interrupts the handle itself when the founder talks over the agent."""

    async def go():
        c, handles, streams, events = make()
        c.handle({"t": "speak_begin", "id": 1})
        handles[0].finish(interrupted=True)  # barge-in
        c.handle({"t": "speak_chunk", "id": 1, "text": "LLM redet weiter"})
        return await drain(streams[0]), events

    text, events = asyncio.run(go())
    assert text == ""
    assert events == [{"t": "speak_done", "id": 1, "interrupted": True}]


def test_a_new_begin_replaces_the_running_speech():
    async def go():
        c, handles, streams, events = make()
        c.handle({"t": "speak_begin", "id": 1})
        c.handle({"t": "speak_chunk", "id": 1, "text": "alt"})
        c.handle({"t": "speak_begin", "id": 2})
        c.handle({"t": "speak_chunk", "id": 1, "text": "alt2"})  # stale id
        c.handle({"t": "speak_chunk", "id": 2, "text": "neu"})
        c.handle({"t": "speak_end", "id": 2})
        return await drain(streams[0]), await drain(streams[1]), handles[0].interrupted, events

    old, new, old_interrupted, events = asyncio.run(go())
    assert (old, new) == ("alt", "neu")
    assert old_interrupted is True
    assert events[0] == {"t": "speak_done", "id": 1, "interrupted": True}


def test_say_failure_is_reported_not_raised():
    events = []

    def broken_say(_stream):
        raise RuntimeError("tts offline")

    async def go():
        c = SpeakCoordinator(say=broken_say, emit=events.append)
        c.handle({"t": "speak_begin", "id": 3})

    asyncio.run(go())
    assert events[0]["t"] == "error" and "tts offline" in events[0]["message"]
    assert events[1] == {"t": "speak_done", "id": 3, "interrupted": True}


def test_malformed_commands_are_ignored():
    async def go():
        c, handles, streams, events = make()
        for cmd in ({"t": "speak_begin"}, {"t": "speak_chunk", "id": "x"}, {"t": "dance", "id": 1}, {}):
            c.handle(cmd)
        return handles, events

    handles, events = asyncio.run(go())
    assert handles == [] and events == []
