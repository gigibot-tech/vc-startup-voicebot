"""Speech-to-text defaults: the browser is the default, a cloud provider is opt-in and gated."""

from startup_voice.features.voice import stt


def _router(monkeypatch, *, eleven=True, deepgram=False, pref=""):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k" if eleven else "")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "k" if deepgram else "")
    monkeypatch.setenv("STT_PROVIDER", pref)
    monkeypatch.setattr(stt, "_ELEVENLABS_UNAVAILABLE_REASON", "")
    return stt.SttRouter.default()


def test_default_is_the_browser_even_when_a_cloud_key_exists(monkeypatch):
    r = _router(monkeypatch, eleven=True, deepgram=True)
    assert r.default_name() == "browser"
    assert "elevenlabs" in r.available_names()  # still selectable in Settings


def test_a_cloud_provider_is_default_only_when_asked_for(monkeypatch):
    assert _router(monkeypatch, pref="elevenlabs").default_name() == "elevenlabs"
    assert _router(monkeypatch, eleven=False, pref="elevenlabs").default_name() == "browser"


def test_an_upload_without_provider_still_uses_a_configured_cloud_backend(monkeypatch):
    r = _router(monkeypatch, eleven=False, deepgram=True)
    assert r.server_default() == "deepgram"


def test_elevenlabs_without_credits_is_not_offered(monkeypatch):
    r = _router(monkeypatch)
    monkeypatch.setattr(stt, "_credits_checked_at", 0.0)

    class Res:
        status_code = 200
        def json(self):
            return {"character_count": 10000, "character_limit": 10000}

    monkeypatch.setattr(stt.httpx, "get", lambda *a, **k: Res())
    stt.refresh_elevenlabs_credits(0)
    assert "elevenlabs" not in r.available_names()
    assert stt.probe_tts_fast()["ok"] is False  # the voice is gated too

    class Back(Res):
        def json(self):
            return {"character_count": 10, "character_limit": 10000}

    monkeypatch.setattr(stt.httpx, "get", lambda *a, **k: Back())
    stt.refresh_elevenlabs_credits(0)
    assert "elevenlabs" in r.available_names()  # credits are back: the gate lifts


def test_a_key_without_permission_to_read_credits_changes_nothing(monkeypatch):
    r = _router(monkeypatch)

    class Res:
        status_code = 401

    monkeypatch.setattr(stt.httpx, "get", lambda *a, **k: Res())
    stt.refresh_elevenlabs_credits(0)
    assert "elevenlabs" in r.available_names()
