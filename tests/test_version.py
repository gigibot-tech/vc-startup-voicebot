"""App version: <day>.<month>.<commit count>, shown in the UI header."""

from __future__ import annotations

import re

from fastapi.testclient import TestClient

from startup_voice import version
from startup_voice.web import create_app


class _NoLLM:
    def complete(self, system, user, *, max_tokens=None, json_mode=False):
        return ""


def test_app_version_env_override(monkeypatch):
    monkeypatch.setenv("APP_VERSION", "1.2.3")
    version.app_version.cache_clear()
    assert version.app_version() == "1.2.3"
    version.app_version.cache_clear()


def test_app_version_from_git_has_day_month_count():
    version.app_version.cache_clear()
    v = version.app_version()
    assert re.fullmatch(r"\d{2}\.\d{2}\.\d+\+?", v) or v == version.__version__, v


def test_index_html_shows_version(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_VERSION", "19.11.99")
    version.app_version.cache_clear()
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    html = TestClient(create_app(llm=_NoLLM())).get("/").text
    assert "v19.11.99" in html
    assert "__APP_VERSION__" not in html
    version.app_version.cache_clear()
