"""Test isolation: the app loads the developer's .env at import time (web.py: load_dotenv), so a
local LLM_PROVIDER=scaleway (or any LLM_* / SCW_* value) would leak into every test and break the
ones that build ConfigurableLLM() from the environment. Every test starts without them."""

import pytest

_LLM_ENV = (
    "LLM_PROVIDER", "LLM_MODEL", "LLM_BASE_URL", "LLM_API_KEY", "LLM_REGION", "LLM_TIMEOUT",
    "SCW_SECRET_KEY", "SCW_SECRET", "SCW_PROJECT_ID",
)


@pytest.fixture(autouse=True)
def _isolate_llm_env(monkeypatch):
    for name in _LLM_ENV:
        monkeypatch.delenv(name, raising=False)
