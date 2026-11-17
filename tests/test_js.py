"""Runs the browser-module unit tests (tests/js/*.test.mjs) with node, when node is installed."""

import shutil
import subprocess
from pathlib import Path

import pytest

JS_DIR = Path(__file__).parent / "js"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_browser_modules_pass_node_tests():
    files = sorted(str(p) for p in JS_DIR.glob("*.test.mjs"))
    assert files, "no JS tests found"
    run = subprocess.run(["node", "--test", *files], capture_output=True, text=True, timeout=120)
    assert run.returncode == 0, run.stdout[-3000:] + run.stderr[-2000:]
