"""Deployment-topology regression test for the Hermes symlink deployment (LIA-500).

`deus_memory_provider/` is deployed as a standalone symlinked directory
(``ln -s <repo>/integrations/hermes/deus_memory_provider $HERMES_HOME/plugins/deus``,
see ../README.md's Setup section) and runs inside Hermes's own Python
process. Since LIA-500 extracted the MCP-client plumbing into the top-level
sibling package ``deus_memory_client``, this test proves the module's own
``sys.path.insert(0, str(_REPO_ROOT))`` line actually reaches it when loaded
through that exact symlink topology, from a process whose ``sys.path``
otherwise has no knowledge of the real repo root - not just from a normal,
already-on-sys.path checkout (which every other test in this suite runs
from and would not catch a regression here).

Spawns a real subprocess (not just monkeypatched sys.path in-process) because
the failure mode this guards against - Hermes's own process not having the
repo root anywhere on its sys.path - can only be reproduced by actually
starting a fresh interpreter with a clean sys.path, not by mutating
sys.path within this already-imported test process.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
_PROVIDER_DIR = _REPO_ROOT / "integrations" / "hermes" / "deus_memory_provider"
_STUB_ABC = _REPO_ROOT / "integrations" / "hermes" / "_stub_memory_provider_abc.py"
_VENV_PYTHON = _REPO_ROOT / ".venv" / "bin" / "python3"

_SMOKE_SCRIPT = """
import sys
real_repo_root = {repo_root!r}
# The only way deus_memory_client should resolve is via
# deus_memory_provider's own sys.path.insert(_REPO_ROOT) line - strip the
# real repo root itself (exact match only; the venv's own site-packages
# path also happens to contain the repo-root string and must stay).
sys.path = [p for p in sys.path if p != real_repo_root]
sys.path.insert(0, ".")
assert real_repo_root not in sys.path, "test setup bug: repo root leaked in"

from _stub_memory_provider_abc import install
install()

import deus as deus_memory_provider  # matches the actual documented symlink name

assert deus_memory_provider.mcp_client is not None
assert deus_memory_provider.DeusMemoryProvider().is_available() is True
print("SMOKE_TEST_OK")
"""


def test_deus_memory_client_reachable_through_hermes_symlink_topology() -> None:
    if not _VENV_PYTHON.is_file():
        import pytest

        pytest.skip("repo .venv not present - cannot exercise the real interpreter")

    with tempfile.TemporaryDirectory() as tmp:
        plugins_dir = Path(tmp) / "plugins"
        plugins_dir.mkdir()
        (plugins_dir / "deus").symlink_to(_PROVIDER_DIR)
        (plugins_dir / "_stub_memory_provider_abc.py").symlink_to(_STUB_ABC)

        result = subprocess.run(
            [str(_VENV_PYTHON), "-c", _SMOKE_SCRIPT.format(repo_root=str(_REPO_ROOT))],
            cwd=plugins_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )

    assert result.returncode == 0, (
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    assert "SMOKE_TEST_OK" in result.stdout
