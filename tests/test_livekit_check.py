"""LiveKit credential check: tells a wrong key/secret apart from a network problem."""

import httpx
import pytest

from startup_voice.features.voice.transports import livekit as lk


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("LIVEKIT_URL", "wss://demo.livekit.cloud")
    monkeypatch.setenv("LIVEKIT_API_KEY", "APIkey123")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "s" * 40)
    monkeypatch.setenv("LIVEKIT_WORKER", "external")
    lk._check_cache.update(at=0.0, result=None)


def _answer(monkeypatch, status=None, raises=None):
    seen = {}

    def post(url, **kw):
        seen.update(url=url, auth=kw["headers"]["Authorization"])
        if raises:
            raise raises
        return httpx.Response(status, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", post)
    return seen


def test_valid_credentials(monkeypatch):
    seen = _answer(monkeypatch, 200)
    r = lk.check_credentials(force=True)
    assert r["valid"] is True
    assert seen["url"] == "https://demo.livekit.cloud/twirp/livekit.RoomService/ListRooms"
    assert "s" * 40 not in str(r)


def test_rejected_credentials_are_reported_and_logged(monkeypatch, caplog):
    _answer(monkeypatch, 401)
    with caplog.at_level("ERROR"):
        r = lk.check_credentials(force=True)
    assert r["valid"] is False and r["problem"] == "rejected"
    assert "LiveKit credentials problem" in caplog.text
    assert lk.LiveKitTransport().describe()["available"] is False  # Settings greys the mode out


def test_unreachable_is_not_blamed_on_the_credentials(monkeypatch):
    _answer(monkeypatch, raises=httpx.ConnectError("offline"))
    r = lk.check_credentials(force=True)
    assert r["valid"] is None and r["problem"] == "unreachable"
    assert lk.LiveKitTransport().describe()["available"] is True


def test_url_must_be_a_websocket_url(monkeypatch):
    monkeypatch.setenv("LIVEKIT_URL", "https://demo.livekit.cloud")
    r = lk.check_credentials(force=True)
    assert r["valid"] is False and r["problem"] == "url"


def test_missing_variables_are_named(monkeypatch):
    monkeypatch.setenv("LIVEKIT_API_SECRET", "")
    r = lk.check_credentials(force=True)
    assert r["problem"] == "missing" and "LIVEKIT_API_SECRET" in r["hint"]


def test_livekit_needs_a_running_worker(monkeypatch, tmp_path):
    """Credentials alone are not enough: without a worker a call would just wait and time out."""
    monkeypatch.delenv("LIVEKIT_WORKER", raising=False)
    beat = tmp_path / "alive"
    monkeypatch.setenv("LIVEKIT_HEARTBEAT_FILE", str(beat))
    _answer(monkeypatch, 200)
    t = lk.LiveKitTransport()
    assert lk.worker_state() == "missing"
    assert t.available() is False
    assert "worker" in t.describe()["reason"].lower()
    with pytest.raises(lk.TransportUnavailable):
        t.join(session_id="s", language="de")

    beat.write_text("1")  # the worker's heartbeat
    assert lk.worker_state() == "alive" and t.available() is True
    assert t.describe()["available"] is True

    import os, time
    os.utime(beat, (time.time() - 120, time.time() - 120))  # heartbeat stopped: the worker died
    assert lk.worker_state() == "missing"


def test_a_worker_elsewhere_can_be_declared(monkeypatch):
    monkeypatch.setenv("LIVEKIT_WORKER", "external")
    assert lk.worker_state() == "external"
