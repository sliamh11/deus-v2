"""Static-source assertions for the `--print-identity` flag (GH #1004).

deus-cmd.sh is sourced into a running zsh, so this suite verifies the wiring
is present and correctly ordered, not the runtime branching — that is covered
by the manual smoke tests documented in the PR (same approach as
test_deus_cmd_backend_prefix.py).
"""
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def _script() -> str:
    return (ROOT / "deus-cmd.sh").read_text()


def test_print_identity_routes_into_launch_branch():
    # Bare `deus --print-identity` (and post-backend-prefix forms) must hit
    # the home|"" launch branch, not the usage fallback.
    assert 'home|""|--print-identity)' in _script()


def test_print_identity_flag_scan_present():
    script = _script()
    assert 'PRINT_IDENTITY="true"' in script
    assert '"$_arg" = "--print-identity"' in script


def test_print_identity_excluded_from_freshness_check():
    # Pure query flag: no background fetch, no stamp write, no stderr nudge.
    script = _script()
    fn = script[script.index("_deus_freshness_check() {"):]
    exclusion = fn[: fn.index("esac")]
    assert "--print-identity" in exclusion
    # `deus home --print-identity` must be excluded too: the function receives
    # all args and scans every position, not just $1.
    assert '_deus_freshness_check "$@"' in script
    arg_loop = fn[fn.index("esac") : fn.index("git -C")]
    assert '[ "$_fc_arg" = "--print-identity" ] && return 0' in arg_loop


def test_print_identity_wins_over_agents_flag():
    # Print mode must never exec the interactive agents UI.
    assert (
        'if [ "$AGENTS_MODE" = "true" ] && [ "$PRINT_IDENTITY" != "true" ]; then'
        in _script()
    )


def test_print_identity_redirects_progress_noise_to_stderr():
    # fd3 saves real stdout; fd1 goes to stderr for the assembly section.
    assert "exec 3>&1 1>&2" in _script()


def test_print_identity_skips_oauth_and_kickstart():
    script = _script()
    # The OAuth token resolution + kickstart block is guarded so print mode
    # never touches credentials or restarts the com.deus-v2 service (LIA-451).
    guard = script.index('if [ "$PRINT_IDENTITY" != "true" ]; then\n    TOKEN=$(python3')
    token = script.index("TOKEN=$(python3", guard)
    kick = script.index(
        'launchctl kickstart -k "gui/$(id -u)/com.deus-v2" 2>/dev/null', token
    )
    assert guard < token < kick


def test_print_identity_skips_onboarding_with_post_onboarding_greeting():
    # Never-onboarded external dir: no interactive `read` hang; greeting
    # matches a real post-onboarding launch.
    script = _script()
    block_start = script.index('if [ -z "$PROJECT_CONFIG" ]; then')
    block = script[block_start : script.index("MEMORY_LEVEL=$(echo", block_start)]
    guard = block.index('if [ "$PRINT_IDENTITY" = "true" ]; then')
    onboarding_call = block.index('_run_onboarding "$CURRENT_DIR"')
    # The print-mode guard short-circuits before the interactive onboarding
    # call, and its branch sets the post-onboarding greeting state.
    assert guard < onboarding_call
    assert 'JUST_ONBOARDED="true"' in block[guard:onboarding_call]


def test_print_identity_does_not_touch_project_registry():
    # Print-polls are automation, not user sessions.
    assert (
        '[ "$PRINT_IDENTITY" != "true" ] && _update_project_access "$CURRENT_DIR"'
        in _script()
    )


def test_print_identity_skips_portable_skills_setup():
    # _ensure_portable_skills mutates ~/.claude/skills — both call sites in
    # the launch branch must be gated in print mode.
    script = _script()
    assert (
        script.count('[ "$PRINT_IDENTITY" != "true" ] && _ensure_portable_skills') == 2
    )


def test_print_identity_prints_full_prompt_before_launch_at_both_sites():
    # Both launch sites (external + home) print the exact payload to the
    # saved stdout and exit BEFORE any interactive launch call
    # (`launch_agent`) runs — print mode must never trigger an interactive
    # session. Previously this also asserted ordering relative to the Rust
    # TUI's `$TUI_DEFAULT` check; that check was removed with the TUI
    # itself (LIA-389, docs/decisions/tui-archival.md) — see
    # test_deus_tui_archived_no_launch_reachable below for its replacement.
    script = _script()
    payload = "printf '%s' \"$FULL_PROMPT\" >&3"
    launch = "launch_agent"
    assert script.count(payload) == 2
    pos = 0
    for _ in range(2):
        p = script.index(payload, pos)
        l = script.index(launch, p)
        assert p < l
        pos = l + 1


def test_deus_tui_archived_no_launch_reachable():
    # The Rust TUI launcher is fully gone: no build/exec path, no
    # `$TUI_DEFAULT` gate before `launch_agent`. `deus tui` itself now
    # errors via DEUS_TUI_ARCHIVED_MSG (see test_session_type_contract.py's
    # TestCLISession for the exact-string/non-zero-exit assertions).
    script = _script()
    assert "_launch_tui_with_context" not in script
    assert "TUI_DEFAULT" not in script
    assert "tui/target/release/deus-tui" not in script


def test_print_identity_covers_vault_less_fallback_on_both_branches():
    script = _script()
    # The vault-less block has its own two launch sites; each prints the
    # bare identity to fd 3 and exits 0 before its launch_agent line.
    vaultless = script[script.index('if [ -z "$VAULT" ]; then'):]
    vaultless = vaultless[: vaultless.index('CONTEXT=""')]
    assert vaultless.count("printf '%s' \"$DEUS_IDENTITY\" >&3") == 2
    assert vaultless.count("exit 0") == 2
    # Each print precedes its launch_agent call.
    first_print = vaultless.index("printf '%s' \"$DEUS_IDENTITY\" >&3")
    first_launch = vaultless.index("launch_agent --append-system-prompt")
    assert first_print < first_launch


def test_print_identity_documented_in_usage():
    script = _script()
    usage = script[script.index("Usage: deus"):]
    assert usage.count("--print-identity") >= 2  # summary line + Flags block
