"""OpenAI-compatible provider (Scaleway / IONOS / STACKIT / OVH / Mistral): wire format, offline.

A fake HTTP server stands in for the cloud endpoint, so no key and no network are needed.
"""

import json

import httpx
import pytest

from startup_voice.features.interview.llm import ConfigurableLLM, resolve_context_window

SCALEWAY = "https://api.scaleway.ai/v1"
MODEL = "mistral-small-3.2-24b-instruct-2506"


@pytest.fixture
def seen(monkeypatch):
    """Route every httpx.Client the LLM creates to a fake server; record the requests."""
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        body = json.loads(request.content)
        if body.get("stream"):
            sse = "".join(
                f"data: {json.dumps({'choices': [{'delta': {'content': part}}]})}\n\n"
                for part in ("Hallo, ", "wer seid ihr?")
            )
            sse += 'data: {"choices": [{"delta": {}, "finish_reason": "stop"}]}\n\ndata: [DONE]\n\n'
            return httpx.Response(200, content=sse.encode(), headers={"content-type": "text/event-stream"})
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": '{"ok": true}'}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 4},
            },
        )

    real_client = httpx.Client

    def fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", fake_client)
    return requests


def _llm(base_url: str = SCALEWAY) -> ConfigurableLLM:
    return ConfigurableLLM(
        provider="openai_compatible", model=MODEL, base_url=base_url, api_key="scw-secret"
    )


def test_url_is_built_for_v1_base_and_bare_host():
    assert _llm(SCALEWAY)._openai_url() == f"{SCALEWAY}/chat/completions"
    assert _llm(SCALEWAY + "/")._openai_url() == f"{SCALEWAY}/chat/completions"
    assert _llm("https://host.example")._openai_url() == "https://host.example/v1/chat/completions"


def test_complete_sends_bearer_key_model_and_json_mode(seen):
    out = _llm().complete("sys", "usr", max_tokens=64, json_mode=True)

    assert out == '{"ok": true}'
    (req,) = seen
    assert str(req.url) == f"{SCALEWAY}/chat/completions"
    assert req.headers["authorization"] == "Bearer scw-secret"
    body = json.loads(req.content)
    assert body["model"] == MODEL
    assert body["response_format"] == {"type": "json_object"}
    assert body["max_tokens"] == 64
    assert [m["role"] for m in body["messages"]] == ["system", "user"]


def test_plain_complete_does_not_force_json(seen):
    _llm().complete("sys", "usr")
    assert "response_format" not in json.loads(seen[0].content)


def test_stream_yields_chunks_in_order(seen):
    llm = _llm()
    assert "".join(llm.stream("sys", "usr", max_tokens=200)) == "Hallo, wer seid ihr?"
    assert json.loads(seen[0].content)["stream"] is True
    assert llm.last_meta["done_reason"] == "stop"


def test_mistral_small_gets_a_large_context_window(monkeypatch):
    monkeypatch.delenv("LLM_CONTEXT_WINDOW", raising=False)
    assert resolve_context_window(MODEL) == 131072
