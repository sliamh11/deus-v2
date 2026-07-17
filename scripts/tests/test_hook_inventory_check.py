"""
Tests for scripts/hook_inventory_check.py -- the LIA-414 hook-inventory
completeness check.

Covers the unit-level extraction helpers (identity derivation from a
settings.json `command` string, table-row parsing) with synthetic fixtures,
plus one integration test that runs the real check against this repo's own
`.claude/settings.json` and `docs/exec-plans/active/EP-001-hook-inventory-
extraction.md` -- proving the shipped artifact is not already drifted, and
that a deliberately broken copy of either input DOES fail the check (so the
test itself isn't vacuously green).
"""
import json
import sys
from pathlib import Path

import pytest

_SCRIPTS_DIR = str(Path(__file__).resolve().parent.parent)
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import hook_inventory_check as hic

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


# ── _derive_identity ────────────────────────────────────────────────────────

class TestDeriveIdentity:
    def test_warden_shim_behavior(self):
        cmd = (
            'bash -c \'"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/warden-shim.sh" '
            "session-init'"
        )
        assert hic._derive_identity(cmd) == "session-init"

    def test_warden_shim_behavior_with_hyphens(self):
        cmd = (
            'bash -c \'"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/warden-shim.sh" '
            "code-review-gate'"
        )
        assert hic._derive_identity(cmd) == "code-review-gate"

    def test_direct_shell_script(self):
        cmd = 'bash -c \'"${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/tdd-test-lock.sh"\''
        assert hic._derive_identity(cmd) == "tdd-test-lock.sh"

    def test_direct_python_script(self):
        cmd = (
            "bash -c 'python3 \"${CLAUDE_PROJECT_DIR:-.}/scripts/"
            "linear_pending_hook.py\"'"
        )
        assert hic._derive_identity(cmd) == "linear_pending_hook.py"

    def test_unparseable_command_raises(self):
        with pytest.raises(ValueError):
            hic._derive_identity("bash -c 'echo hello'")


# ── extract_live_dispatches ─────────────────────────────────────────────────

class TestExtractLiveDispatches:
    def test_counts_and_matcher_for_synthetic_settings(self, tmp_path):
        settings = {
            "hooks": {
                "SessionStart": [
                    {
                        "hooks": [
                            {
                                "type": "command",
                                "command": (
                                    'bash -c \'"${CLAUDE_PROJECT_DIR:-.}/'
                                    '.claude/hooks/warden-shim.sh" session-init\''
                                ),
                            }
                        ]
                    }
                ],
                "PreToolUse": [
                    {
                        "matcher": "Bash",
                        "hooks": [
                            {
                                "type": "command",
                                "command": (
                                    'bash -c \'"${CLAUDE_PROJECT_DIR:-.}/'
                                    '.claude/hooks/warden-shim.sh" code-review-gate\''
                                ),
                            }
                        ],
                    },
                    {
                        "matcher": "Grep|Glob",
                        "hooks": [
                            {
                                "type": "command",
                                "command": (
                                    'bash -c \'"${CLAUDE_PROJECT_DIR:-.}/'
                                    '.claude/hooks/warden-shim.sh" codegraph-first-gate\''
                                ),
                            }
                        ],
                    },
                ],
            }
        }
        path = tmp_path / "settings.json"
        path.write_text(json.dumps(settings))
        dispatches = hic.extract_live_dispatches(path)
        keys = sorted(d.key() for d in dispatches)
        assert keys == sorted(
            [
                ("SessionStart", "", "session-init"),
                ("PreToolUse", "Bash", "code-review-gate"),
                ("PreToolUse", "Grep|Glob", "codegraph-first-gate"),
            ]
        )


# ── extract_artifact_dispatches ─────────────────────────────────────────────

class TestExtractArtifactDispatches:
    def test_parses_table_with_escaped_pipe_matcher(self, tmp_path):
        artifact = tmp_path / "EP-fake.md"
        artifact.write_text(
            "# Fake EP\n\n"
            "## Dispatch inventory\n\n"
            "| # | Event | Matcher | Hook / Behavior | Target | Disposition | Reference |\n"
            "|---|-------|---------|------------------|--------|--------------|-----------|\n"
            "| 1 | SessionStart | — | `session-init` | slot | port-later | none |\n"
            "| 2 | PreToolUse | `Grep\\|Glob` | `codegraph-first-gate` | slot | drop-with-reason | reason |\n"
            "| 3 | Stop | `\"\"` | `nonumb-gate.sh` | slot | drop-with-reason | reason |\n"
        )
        dispatches = hic.extract_artifact_dispatches(artifact)
        keys = sorted(d.key() for d in dispatches)
        assert keys == sorted(
            [
                ("SessionStart", "", "session-init"),
                ("PreToolUse", "Grep|Glob", "codegraph-first-gate"),
                ("Stop", "", "nonumb-gate.sh"),
            ]
        )

    def test_ignores_unrelated_tables(self, tmp_path):
        artifact = tmp_path / "EP-fake.md"
        artifact.write_text(
            "| Approach | Tradeoff | Why rejected |\n"
            "|----------|----------|--------------|\n"
            "| A | B | C |\n"
        )
        assert hic.extract_artifact_dispatches(artifact) == []


# ── main / integration ──────────────────────────────────────────────────────

class TestMainIntegration:
    def test_real_repo_artifact_matches_real_repo_settings(self):
        """The shipped artifact must not already be drifted from the live
        settings.json at commit time -- this is the non-vacuous "does the
        real check actually pass today" proof."""
        exit_code = hic.main(
            [
                "--settings",
                str(PROJECT_ROOT / ".claude" / "settings.json"),
                "--artifact",
                str(
                    PROJECT_ROOT
                    / "docs"
                    / "exec-plans"
                    / "active"
                    / "EP-001-hook-inventory-extraction.md"
                ),
            ]
        )
        assert exit_code == 0

    def test_detects_a_removed_row_as_drift(self, tmp_path):
        """Deleting one row from a copy of the real artifact must make the
        check fail -- proves the comparison is live, not vacuously green."""
        real_artifact = (
            PROJECT_ROOT
            / "docs"
            / "exec-plans"
            / "active"
            / "EP-001-hook-inventory-extraction.md"
        )
        lines = real_artifact.read_text(encoding="utf-8").splitlines(keepends=True)
        mutated = [ln for ln in lines if "nonumb-gate.sh" not in ln]
        assert len(mutated) < len(lines), "fixture assumption broke: no matching row found"

        broken = tmp_path / "EP-broken.md"
        broken.write_text("".join(mutated), encoding="utf-8")

        exit_code = hic.main(
            [
                "--settings",
                str(PROJECT_ROOT / ".claude" / "settings.json"),
                "--artifact",
                str(broken),
            ]
        )
        assert exit_code == 1

    def test_missing_settings_file_is_an_error(self, tmp_path):
        exit_code = hic.main(
            [
                "--settings",
                str(tmp_path / "does-not-exist.json"),
                "--artifact",
                str(
                    PROJECT_ROOT
                    / "docs"
                    / "exec-plans"
                    / "active"
                    / "EP-001-hook-inventory-extraction.md"
                ),
            ]
        )
        assert exit_code == 2
