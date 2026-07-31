"""Tests for the Hermes A/B model comparison rig (integrations/hermes/ab_compare.py).

Network-free: no real Hermes install, no real `hermes` binary, no real judge
backend. `subprocess.run` and `evolution.judge.make_runtime_judge` are both
monkeypatched, mirroring test_deus_memory_provider.py's monkeypatch style.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Optional

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import ab_compare  # noqa: E402
from evolution.judge import JudgeResult  # noqa: E402


def _fake_completed(stdout: str, stderr: str, returncode: int = 0) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


# ---------------------------------------------------------------------------
# run_hermes_turn: argv construction, session_id parsing, error handling
# ---------------------------------------------------------------------------


def test_run_hermes_turn_builds_expected_argv(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = {}

    def fake_run(argv, capture_output, timeout, text):
        captured["argv"] = argv
        captured["capture_output"] = capture_output
        captured["timeout"] = timeout
        captured["text"] = text
        return _fake_completed("hi there", "\nsession_id: sess-1\n")

    monkeypatch.setattr(ab_compare.subprocess, "run", fake_run)

    result = ab_compare.run_hermes_turn("hermes", "model-a", "hello", timeout_s=30)

    assert captured["argv"] == ["hermes", "-p", "model-a", "chat", "-q", "hello", "-Q"]
    assert captured["timeout"] == 30
    assert captured["capture_output"] is True
    assert result.stdout == "hi there"
    assert result.session_id == "sess-1"
    assert result.returncode == 0
    assert result.timed_out is False


def test_run_hermes_turn_appends_resume_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = {}

    def fake_run(argv, **kwargs):
        captured["argv"] = argv
        return _fake_completed("second answer", "\nsession_id: sess-1\n")

    monkeypatch.setattr(ab_compare.subprocess, "run", fake_run)

    ab_compare.run_hermes_turn("hermes", "model-a", "follow up", resume="sess-1", timeout_s=30)

    assert captured["argv"] == [
        "hermes", "-p", "model-a", "chat", "-q", "follow up", "-Q", "--resume", "sess-1",
    ]


def test_run_hermes_turn_parses_session_id_with_surrounding_text(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(argv, **kwargs):
        return _fake_completed("answer", "some warning\n\nsession_id: abc-123-def\n")

    monkeypatch.setattr(ab_compare.subprocess, "run", fake_run)

    result = ab_compare.run_hermes_turn("hermes", "model-a", "hello")

    assert result.session_id == "abc-123-def"


def test_run_hermes_turn_missing_session_id_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(argv, **kwargs):
        return _fake_completed("answer", "")

    monkeypatch.setattr(ab_compare.subprocess, "run", fake_run)

    result = ab_compare.run_hermes_turn("hermes", "model-a", "hello")

    assert result.session_id is None


def test_run_hermes_turn_timeout_does_not_raise(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(argv, **kwargs):
        raise subprocess.TimeoutExpired(cmd=argv, timeout=kwargs.get("timeout", 30))

    monkeypatch.setattr(ab_compare.subprocess, "run", fake_run)

    result = ab_compare.run_hermes_turn("hermes", "model-a", "hello", timeout_s=5)

    assert result.timed_out is True
    assert result.returncode == -1


def test_run_hermes_turn_missing_binary_does_not_raise(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(argv, **kwargs):
        raise FileNotFoundError("no such file: nonexistent-hermes")

    monkeypatch.setattr(ab_compare.subprocess, "run", fake_run)

    result = ab_compare.run_hermes_turn("nonexistent-hermes", "model-a", "hello")

    assert result.timed_out is False
    assert result.returncode == -2
    assert "no such file" in result.stderr


# ---------------------------------------------------------------------------
# run_profile_turns: multi-turn --resume chaining, per-profile failure isolation
# ---------------------------------------------------------------------------


def test_run_profile_turns_chains_resume_across_turns(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def fake_run(argv, **kwargs):
        calls.append(argv)
        if len(calls) == 1:
            return _fake_completed("first answer", "\nsession_id: sess-1\n")
        return _fake_completed("second answer", "\nsession_id: sess-1\n")

    monkeypatch.setattr(ab_compare.subprocess, "run", fake_run)

    final_answer, error, latency, context = ab_compare.run_profile_turns(
        "hermes", "model-a", ["turn one", "turn two"], timeout_s=30
    )

    assert error is None
    assert final_answer == "second answer"
    assert context == "User: turn one\nAssistant: first answer"
    assert "--resume" not in calls[0]
    assert calls[1][-2:] == ["--resume", "sess-1"]
    assert latency >= 0.0


def test_run_profile_turns_single_turn_has_no_context(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(argv, **kwargs):
        return _fake_completed("the answer", "\nsession_id: sess-1\n")

    monkeypatch.setattr(ab_compare.subprocess, "run", fake_run)

    final_answer, error, _latency, context = ab_compare.run_profile_turns(
        "hermes", "model-a", ["only turn"], timeout_s=30
    )

    assert error is None
    assert final_answer == "the answer"
    assert context is None


def test_run_profile_turns_timeout_stops_remaining_turns(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = []

    def fake_run(argv, timeout, **kwargs):
        calls.append(argv)
        raise subprocess.TimeoutExpired(cmd=argv, timeout=timeout)

    monkeypatch.setattr(ab_compare.subprocess, "run", fake_run)

    final_answer, error, _latency, context = ab_compare.run_profile_turns(
        "hermes", "model-a", ["turn one", "turn two"], timeout_s=5
    )

    assert final_answer is None
    assert context is None
    assert error is not None
    assert "timed out" in error
    assert len(calls) == 1  # second turn never attempted


def test_run_profile_turns_nonzero_exit_produces_error_not_crash(monkeypatch: pytest.MonkeyPatch) -> None:
    def fake_run(argv, **kwargs):
        return _fake_completed("", "Error: profile 'model-a' does not exist\n", returncode=1)

    monkeypatch.setattr(ab_compare.subprocess, "run", fake_run)

    final_answer, error, _latency, _context = ab_compare.run_profile_turns(
        "hermes", "model-a", ["hello"], timeout_s=30
    )

    assert final_answer is None
    assert error is not None
    assert "exited 1" in error
    assert "does not exist" in error


# ---------------------------------------------------------------------------
# compare_profiles: judge integration, per-profile error isolation
# ---------------------------------------------------------------------------


class _FakeJudge:
    def __init__(self, score_by_profile: Optional[dict] = None) -> None:
        self._score_by_profile = score_by_profile or {}
        self.calls: list[dict] = []

    def evaluate(self, *, prompt, response, context=None, tools_used=None, user_profile=None):
        self.calls.append({"prompt": prompt, "response": response, "context": context})
        score = self._score_by_profile.get(response, 0.8)
        return JudgeResult(
            score=score,
            quality=score,
            safety=1.0,
            tool_use=0.5,
            personalization=0.5,
            rationale=f"fake rationale for {response!r}",
        )


def test_compare_profiles_scores_each_profile_and_isolates_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_judge = _FakeJudge(score_by_profile={"answer-a": 0.9, "answer-b": 0.4})
    monkeypatch.setattr(ab_compare, "make_runtime_judge", lambda provider=None: fake_judge)

    def fake_run_profile_turns(hermes_bin, profile, turns, *, timeout_s):
        if profile == "broken-profile":
            return None, "hermes exited 1: profile not found", 0.1, None
        answer = "answer-a" if profile == "model-a" else "answer-b"
        return answer, None, 1.5, None

    monkeypatch.setattr(ab_compare, "run_profile_turns", fake_run_profile_turns)
    monkeypatch.setattr(ab_compare, "resolve_profile_model", lambda profile, hermes_home=None: f"{profile}-model-id")

    results = ab_compare.compare_profiles(
        ["model-a", "broken-profile", "model-b"], ["What is the capital of France?"]
    )

    assert [r.profile for r in results] == ["model-a", "broken-profile", "model-b"]

    model_a, broken, model_b = results
    assert model_a.error is None
    assert model_a.judge.score == 0.9
    assert model_a.model == "model-a-model-id"

    assert broken.error == "hermes exited 1: profile not found"
    assert broken.judge is None

    assert model_b.error is None
    assert model_b.judge.score == 0.4

    # The broken profile must never reach the judge.
    assert len(fake_judge.calls) == 2


def test_compare_profiles_passes_context_from_multi_turn_conversation(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_judge = _FakeJudge()
    monkeypatch.setattr(ab_compare, "make_runtime_judge", lambda provider=None: fake_judge)

    def fake_run_profile_turns(hermes_bin, profile, turns, *, timeout_s):
        return "final answer", None, 1.0, "User: turn one\nAssistant: first answer"

    monkeypatch.setattr(ab_compare, "run_profile_turns", fake_run_profile_turns)
    monkeypatch.setattr(ab_compare, "resolve_profile_model", lambda profile, hermes_home=None: None)

    ab_compare.compare_profiles(["model-a"], ["turn one", "turn two"])

    # The judge must be shown the LAST turn as `prompt` (it pairs with
    # `final_answer`, the response to that turn) - the earlier turn is
    # already carried via `context`, not re-passed as `prompt`.
    assert fake_judge.calls[0]["prompt"] == "turn two"
    assert fake_judge.calls[0]["response"] == "final answer"
    assert fake_judge.calls[0]["context"] == "User: turn one\nAssistant: first answer"


def test_compare_profiles_isolates_judge_evaluation_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """A judge-backend error (network blip, Ollama down) for one profile must
    not abort the run for the remaining profiles - mirrors the existing
    hermes-subprocess failure isolation in
    test_compare_profiles_scores_each_profile_and_isolates_failures."""

    class _FlakyJudge:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def evaluate(self, *, prompt, response, context=None, tools_used=None, user_profile=None):
            self.calls.append({"prompt": prompt, "response": response})
            if response == "answer-a":
                raise TimeoutError("Ollama backend timed out")
            return JudgeResult(
                score=0.7,
                quality=0.7,
                safety=1.0,
                tool_use=0.5,
                personalization=0.5,
                rationale="fine",
            )

    flaky_judge = _FlakyJudge()
    monkeypatch.setattr(ab_compare, "make_runtime_judge", lambda provider=None: flaky_judge)

    def fake_run_profile_turns(hermes_bin, profile, turns, *, timeout_s):
        answer = "answer-a" if profile == "model-a" else "answer-b"
        return answer, None, 1.5, None

    monkeypatch.setattr(ab_compare, "run_profile_turns", fake_run_profile_turns)
    monkeypatch.setattr(ab_compare, "resolve_profile_model", lambda profile, hermes_home=None: f"{profile}-model-id")

    results = ab_compare.compare_profiles(["model-a", "model-b"], ["What is the capital of France?"])

    model_a, model_b = results
    assert model_a.error == "judge evaluation failed: Ollama backend timed out"
    assert model_a.judge is None

    # model-b must still be scored - the failure did not abort the run.
    assert model_b.error is None
    assert model_b.judge is not None
    assert model_b.judge.score == 0.7
    assert len(flaky_judge.calls) == 2


# ---------------------------------------------------------------------------
# resolve_profile_model: default profile vs named profile config paths
# ---------------------------------------------------------------------------


def test_resolve_profile_model_default_profile_reads_hermes_home_directly(tmp_path: Path) -> None:
    (tmp_path / "config.yaml").write_text("model:\n  default: gemini-3.1-flash\n")

    assert ab_compare.resolve_profile_model("default", hermes_home=tmp_path) == "gemini-3.1-flash"


def test_resolve_profile_model_named_profile_reads_profiles_subdir(tmp_path: Path) -> None:
    profile_dir = tmp_path / "profiles" / "model-a"
    profile_dir.mkdir(parents=True)
    (profile_dir / "config.yaml").write_text("model:\n  model: anthropic/claude-sonnet-4.6\n")

    assert (
        ab_compare.resolve_profile_model("model-a", hermes_home=tmp_path)
        == "anthropic/claude-sonnet-4.6"
    )


def test_resolve_profile_model_string_form(tmp_path: Path) -> None:
    profile_dir = tmp_path / "profiles" / "model-a"
    profile_dir.mkdir(parents=True)
    (profile_dir / "config.yaml").write_text("model: gpt-5\n")

    assert ab_compare.resolve_profile_model("model-a", hermes_home=tmp_path) == "gpt-5"


def test_resolve_profile_model_missing_config_returns_none(tmp_path: Path) -> None:
    assert ab_compare.resolve_profile_model("nonexistent", hermes_home=tmp_path) is None


# ---------------------------------------------------------------------------
# format_report / _load_turns
# ---------------------------------------------------------------------------


def test_format_report_includes_error_row() -> None:
    results = [
        ab_compare.ProfileResult(profile="model-a", model="gpt-5", latency_s=1.23, judge=JudgeResult(
            score=0.9, quality=0.9, safety=1.0, tool_use=0.5, personalization=0.5, rationale="good",
        )),
        ab_compare.ProfileResult(profile="broken", model=None, error="hermes exited 1: not found"),
    ]

    report = ab_compare.format_report(results)

    assert "model-a" in report
    assert "0.900" in report
    assert "broken" in report
    assert "ERROR" in report
    assert "hermes exited 1: not found" in report


def test_load_turns_from_conversation_file(tmp_path: Path) -> None:
    conv_path = tmp_path / "turns.json"
    conv_path.write_text(json.dumps(["turn one", "turn two"]))

    args = ab_compare.build_arg_parser().parse_args(
        ["--profiles", "model-a", "--conversation", str(conv_path)]
    )

    assert ab_compare._load_turns(args) == ["turn one", "turn two"]


def test_load_turns_from_prompt() -> None:
    args = ab_compare.build_arg_parser().parse_args(["--profiles", "model-a", "--prompt", "hi"])

    assert ab_compare._load_turns(args) == ["hi"]


def test_load_turns_rejects_non_list_conversation(tmp_path: Path) -> None:
    conv_path = tmp_path / "turns.json"
    conv_path.write_text(json.dumps({"not": "a list"}))

    args = ab_compare.build_arg_parser().parse_args(
        ["--profiles", "model-a", "--conversation", str(conv_path)]
    )

    with pytest.raises(ValueError):
        ab_compare._load_turns(args)


def test_arg_parser_rejects_prompt_and_conversation_together() -> None:
    parser = ab_compare.build_arg_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(
            ["--profiles", "model-a", "--prompt", "hi", "--conversation", "turns.json"]
        )


def test_arg_parser_requires_profiles() -> None:
    parser = ab_compare.build_arg_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["--prompt", "hi"])


# ---------------------------------------------------------------------------
# main(): end-to-end wiring with everything monkeypatched
# ---------------------------------------------------------------------------


def test_main_writes_json_dump_and_returns_zero(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    fake_judge = _FakeJudge()
    monkeypatch.setattr(ab_compare, "make_runtime_judge", lambda provider=None: fake_judge)
    monkeypatch.setattr(
        ab_compare,
        "run_profile_turns",
        lambda hermes_bin, profile, turns, *, timeout_s: ("an answer", None, 0.5, None),
    )
    monkeypatch.setattr(ab_compare, "resolve_profile_model", lambda profile, hermes_home=None: "some-model")

    json_path = tmp_path / "out.json"
    exit_code = ab_compare.main(
        ["--profiles", "model-a,model-b", "--prompt", "hi", "--json", str(json_path)]
    )

    assert exit_code == 0
    dumped = json.loads(json_path.read_text())
    assert len(dumped) == 2
    assert dumped[0]["profile"] == "model-a"
    assert dumped[0]["judge"]["score"] == 0.8


def test_main_returns_one_when_no_judge_provider_available(monkeypatch: pytest.MonkeyPatch) -> None:
    from evolution.judge import NoProviderAvailableError

    def raise_no_provider(provider=None):
        raise NoProviderAvailableError("no backend reachable")

    monkeypatch.setattr(ab_compare, "make_runtime_judge", raise_no_provider)

    exit_code = ab_compare.main(["--profiles", "model-a", "--prompt", "hi"])

    assert exit_code == 1
