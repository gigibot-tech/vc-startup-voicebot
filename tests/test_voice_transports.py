"""Voice modes: transports, LiveKit token, /health + /api/voice/* routes. No network, no livekit."""

import base64
import hashlib
import hmac
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from startup_voice.features.voice.transports import (
    TransportUnavailable,
    available_modes,
    default_mode,
    describe_all,
    get_transport,
)
from startup_voice.features.voice.transports.livekit import mint_token
from startup_voice.web import create_app

LK_ENV = {
    "LIVEKIT_URL": "wss://demo.livekit.cloud",
    "LIVEKIT_API_KEY": "APIkey123",
    "LIVEKIT_API_SECRET": "s3cret-value",
}


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in (*LK_ENV, "VOICE_MODE"):
        monkeypatch.delenv(key, raising=False)


def _configure_livekit(monkeypatch):
    for key, value in LK_ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("LIVEKIT_WORKER", "external")  # a worker is "there" (see test_livekit_worker_presence)


def _jwt_parts(token: str):
    head, body, sig = token.split(".")
    pad = lambda s: s + "=" * (-len(s) % 4)  # noqa: E731
    return (
        json.loads(base64.urlsafe_b64decode(pad(head))),
        json.loads(base64.urlsafe_b64decode(pad(body))),
        base64.urlsafe_b64decode(pad(sig)),
        f"{head}.{body}",
    )


class StubLLM:
    def complete(self, system, user, *, max_tokens=None, json_mode=False):
        return "{}"


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    return TestClient(create_app(llm=StubLLM()))


# ---------- token -------------------------------------------------------------------------


def test_token_is_a_valid_hs256_jwt_with_a_room_grant():
    token = mint_token(
        api_key="APIkey123", api_secret="s3cret", identity="founder-1", room="intake-x",
        name="Founder", metadata='{"language":"de"}', now=1_700_000_000,
    )
    header, claims, sig, signing_input = _jwt_parts(token)

    assert header == {"alg": "HS256", "typ": "JWT"}
    assert claims["iss"] == "APIkey123"
    assert claims["sub"] == "founder-1"
    assert claims["nbf"] == 1_700_000_000
    assert claims["exp"] == 1_700_000_000 + 3600
    assert claims["metadata"] == '{"language":"de"}'
    assert claims["video"] == {
        "room": "intake-x", "roomJoin": True,
        "canPublish": True, "canSubscribe": True, "canPublishData": True,
    }
    expected = hmac.new(b"s3cret", signing_input.encode(), hashlib.sha256).digest()
    assert hmac.compare_digest(sig, expected)


def test_token_signature_depends_on_the_secret():
    a = mint_token(api_key="k", api_secret="one", identity="i", room="r", now=1)
    b = mint_token(api_key="k", api_secret="two", identity="i", room="r", now=1)
    assert a.split(".")[2] != b.split(".")[2]


# ---------- registry ----------------------------------------------------------------------


def test_classic_is_always_available_and_the_default():
    assert available_modes() == ["classic"]
    assert default_mode() == "classic"
    assert get_transport("classic").join(session_id="s", language="de") == {"mode": "classic"}


def test_livekit_needs_all_three_settings(monkeypatch):
    assert "livekit" not in available_modes()
    monkeypatch.setenv("LIVEKIT_URL", "wss://x")
    info = {d["name"]: d for d in describe_all()}["livekit"]
    assert info["available"] is False
    assert "LIVEKIT_API_KEY" in info["reason"] and "LIVEKIT_API_SECRET" in info["reason"]
    with pytest.raises(TransportUnavailable):
        get_transport("livekit").join(session_id="s", language="de")


def test_voice_mode_env_picks_the_default_only_when_usable(monkeypatch):
    monkeypatch.setenv("VOICE_MODE", "livekit")
    assert default_mode() == "classic"  # not configured: a bad .env never breaks the page
    _configure_livekit(monkeypatch)
    assert default_mode() == "livekit"
    monkeypatch.setenv("VOICE_MODE", "nonsense")
    assert default_mode() == "classic"


def test_unknown_mode_is_rejected():
    with pytest.raises(TransportUnavailable):
        get_transport("telepathy")


def test_livekit_join_gives_a_fresh_room_and_carries_session_and_language(monkeypatch):
    _configure_livekit(monkeypatch)
    t = get_transport("livekit")
    a = t.join(session_id="abc123", language="de-DE", voice={"speed": 1.1})
    b = t.join(session_id="abc123", language="en-US")

    assert a["url"] == "wss://demo.livekit.cloud"
    assert a["room"].startswith("intake-abc123-") and a["room"] != b["room"]
    _, claims, _, _ = _jwt_parts(a["token"])
    assert claims["video"]["room"] == a["room"]
    assert claims["sub"] == a["identity"]
    meta = json.loads(claims["metadata"])
    assert meta == {"session_id": "abc123", "language": "de", "voice": {"speed": 1.1}, "stt": "server"}
    assert json.loads(_jwt_parts(b["token"])[1]["metadata"])["language"] == "en"


# ---------- HTTP --------------------------------------------------------------------------


def test_health_lists_voice_modes(client, monkeypatch):
    h = client.get("/health").json()
    assert h["voice_modes"] == ["classic"] and h["voice_mode"] == "classic"

    _configure_livekit(monkeypatch)
    h = client.get("/health").json()
    assert h["voice_modes"] == ["classic", "livekit"]


def test_transports_route_explains_what_is_missing(client):
    body = client.get("/api/voice/transports").json()
    by_name = {t["name"]: t for t in body["transports"]}
    assert body["default"] == "classic"
    assert by_name["classic"]["available"] is True
    assert by_name["livekit"]["available"] is False and "LIVEKIT_URL" in by_name["livekit"]["reason"]


def test_join_route_503_when_livekit_is_not_configured(client):
    sid = client.post("/api/sessions").json()["session"]["id"]
    r = client.post("/api/voice/join", json={"mode": "livekit", "session_id": sid})
    assert r.status_code == 503
    assert "LIVEKIT_URL" in r.json()["detail"]


def test_join_route_returns_a_token_and_never_the_secret(client, monkeypatch):
    _configure_livekit(monkeypatch)
    sid = client.post("/api/sessions").json()["session"]["id"]
    r = client.post(
        "/api/voice/join",
        json={"mode": "livekit", "session_id": sid, "language": "en-US", "voice": {"stability": 0.5}},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["mode"] == "livekit" and body["url"] == "wss://demo.livekit.cloud"
    assert LK_ENV["LIVEKIT_API_SECRET"] not in r.text


def test_join_route_404_for_an_unknown_session(client):
    r = client.post("/api/voice/join", json={"mode": "classic", "session_id": "does-not-exist"})
    assert r.status_code == 404


def test_join_route_classic_needs_nothing(client):
    sid = client.post("/api/sessions").json()["session"]["id"]
    r = client.post("/api/voice/join", json={"mode": "classic", "session_id": sid})
    assert r.status_code == 200 and r.json() == {"mode": "classic"}


def test_join_can_ask_for_browser_side_speech_recognition(monkeypatch):
    _configure_livekit(monkeypatch)
    t = get_transport("livekit")
    meta = lambda j: json.loads(_jwt_parts(j["token"])[1]["metadata"])  # noqa: E731
    assert meta(t.join(session_id="s", language="de", stt="browser"))["stt"] == "browser"
    assert meta(t.join(session_id="s", language="de", stt="nonsense"))["stt"] == "server"


def test_join_route_passes_stt_through(client, monkeypatch):
    _configure_livekit(monkeypatch)
    sid = client.post("/api/sessions").json()["session"]["id"]
    body = client.post("/api/voice/join", json={"mode": "livekit", "session_id": sid, "stt": "browser"}).json()
    assert json.loads(_jwt_parts(body["token"])[1]["metadata"])["stt"] == "browser"


def test_health_reports_where_the_llm_runs(monkeypatch):
    """Header privacy chips: LOCAL / ISO country / unknown, never the URL itself."""
    from startup_voice.features.voice.routes import _llm_region

    cases = [
        ({"LLM_PROVIDER": "scaleway"}, "FR"),
        ({"LLM_PROVIDER": "ollama"}, "LOCAL"),
        ({"LLM_PROVIDER": "openai_compatible", "LLM_BASE_URL": "http://127.0.0.1:8000/v1"}, "LOCAL"),
        ({"LLM_PROVIDER": "openai_compatible", "LLM_BASE_URL": "https://host.example/v1", "LLM_REGION": "de"}, "DE"),
        ({"LLM_PROVIDER": "openai_compatible", "LLM_BASE_URL": "https://host.example/v1"}, ""),
    ]
    for env, expected in cases:
        for name in ("LLM_PROVIDER", "LLM_BASE_URL", "LLM_REGION"):
            monkeypatch.delenv(name, raising=False)
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        assert _llm_region() == expected, env
