"""The cool-down wrapper produces a lockfile `uv sync --locked` accepts.

A gate on `scripts/cooldown.sh`, living beside the other script gates but written
in Python rather than in Node: the property under test is what **real uv** does
with a lockfile, and the `frontend` CI job that runs `tests/scripts/*.test.mjs`
deliberately installs no Python tooling. The `python` job has uv by construction,
which is the same job that runs the `uv sync --locked` this gate protects.

Every case here drives real uv against a project with **no dependencies**. That is
what makes the gate hermetic — uv reaches no index, so `--offline` holds and the
suite neither needs the network nor is affected by what happens to be published —
while still exercising the actual lockfile writer rather than a description of it.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
COOLDOWN = REPO / "scripts" / "cooldown.sh"

# uv writes the recorded cutoff as its own line in the lockfile's `[options]`
# table. Anchored, because the same timestamp shape appears in every package's
# `upload-time` and a loose search would find those instead.
RECORDED_CUTOFF = re.compile(r'^exclude-newer = "(.+)"$', re.MULTILINE)

pytestmark = pytest.mark.skipif(shutil.which("uv") is None, reason="uv is not on PATH")


@pytest.fixture
def project(tmp_path: Path) -> Path:
    """A uv project with no dependencies, so every resolution is offline."""
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "cooldown-gate"\nversion = "0.1.0"\n'
        'requires-python = ">=3.12"\ndependencies = []\n'
    )
    return tmp_path


def _run(*command: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(list(command), cwd=cwd, capture_output=True, text=True, check=False)


def _lock_with_cutoff(project: Path, cutoff: str) -> None:
    """Resolve the way the *unfixed* wrapper did — uv straight, cutoff exported."""
    subprocess.run(
        ["uv", "lock", "--offline"],
        cwd=project,
        capture_output=True,
        check=True,
        env={k: v for k, v in os.environ.items() if k != "UV_EXCLUDE_NEWER"}
        | {"UV_EXCLUDE_NEWER": cutoff},
    )


def test_an_unwrapped_lock_records_no_cutoff(project: Path) -> None:
    """The shape the wrapper has to reproduce, and the baseline `--locked` wants."""
    done = _run("uv", "lock", "--offline", cwd=project)
    assert done.returncode == 0, done.stderr
    assert RECORDED_CUTOFF.search((project / "uv.lock").read_text()) is None


def test_a_cutoff_passed_to_uv_directly_lands_in_the_lockfile(project: Path) -> None:
    """The positive path: uv really does persist what the wrapper sets.

    Without this case, every "no cutoff in the lockfile" assertion below would
    also pass on a uv that had stopped recording one at all — the wrapper would
    be scrubbing nothing, and the gate could not tell that from scrubbing well.
    """
    _lock_with_cutoff(project, "2026-01-02T03:04:05Z")

    recorded = RECORDED_CUTOFF.search((project / "uv.lock").read_text())
    assert recorded is not None, "uv no longer records the cutoff; the wrapper's scrub is moot"
    assert recorded.group(1) == "2026-01-02T03:04:05Z"


def test_a_recorded_cutoff_is_what_locked_refuses(project: Path) -> None:
    """The failure the wrapper exists to prevent, reproduced end to end."""
    _lock_with_cutoff(project, "2026-01-02T03:04:05Z")

    done = _run("uv", "sync", "--locked", "--offline", cwd=project)
    assert done.returncode != 0, "a lock carrying a cutoff was accepted; the bug is gone"
    assert "--locked" in done.stderr


def test_the_wrapper_leaves_no_cutoff_in_the_lockfile(project: Path) -> None:
    done = _run("bash", str(COOLDOWN), "uv", "lock", "--offline", cwd=project)
    assert done.returncode == 0, done.stderr

    lock = (project / "uv.lock").read_text()
    assert RECORDED_CUTOFF.search(lock) is None, f"the cutoff survived into the lockfile:\n{lock}"
    # The table goes too when the cutoff was all it held, so a wrapped lock is
    # shaped exactly like an unwrapped one rather than merely being accepted.
    assert "[options]" not in lock


def test_the_wrapper_still_applies_the_cutoff_while_resolving(project: Path) -> None:
    """The scrub removes the record, never the rule.

    Paired with the case above and load-bearing for it: a wrapper that had simply
    stopped exporting `UV_EXCLUDE_NEWER` would also leave a clean lockfile, and
    would have silently deleted the cool-down to do it.
    """
    done = _run("bash", str(COOLDOWN), "sh", "-c", 'printf %s "$UV_EXCLUDE_NEWER"', cwd=project)
    assert done.returncode == 0, done.stderr
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", done.stdout), done.stdout
    assert f"refusing anything published after {done.stdout}" in done.stderr


def test_a_wrapped_lock_is_one_that_locked_accepts(project: Path) -> None:
    """The issue's actual claim, and the reason the other cases are worth having."""
    done = _run("bash", str(COOLDOWN), "uv", "lock", "--offline", cwd=project)
    assert done.returncode == 0, done.stderr

    done = _run("uv", "sync", "--locked", "--offline", cwd=project)
    assert done.returncode == 0, done.stderr


def test_the_wrapper_reports_the_wrapped_command_s_exit_status(project: Path) -> None:
    """Scrubbing after the command means the status is carried by hand, not `exec`."""
    done = _run("bash", str(COOLDOWN), "sh", "-c", "exit 42", cwd=project)
    assert done.returncode == 42


def test_the_scrub_leaves_a_lockfile_this_run_did_not_write(project: Path) -> None:
    """The walk up the directory tree matches on the exact cutoff, and nothing else."""
    _lock_with_cutoff(project, "2019-01-02T03:04:05Z")
    before = (project / "uv.lock").read_text()

    done = _run("bash", str(COOLDOWN), "true", cwd=project)
    assert done.returncode == 0, done.stderr
    assert (project / "uv.lock").read_text() == before


# --------------------------------------------------------------------------
# The audit
# --------------------------------------------------------------------------
#
# uv records `upload-time` on every artifact it locks, so a lockfile already
# carries the only fact the cool-down cares about and the audit reaches no index.
# The fixtures below use 1999 for "long settled" and 2099 for "published after
# any cutoff a test could run under", which is what keeps these cases from
# depending on the day they run.

def _entry(name: str, version: str, upload_time: str | None) -> str:
    """One `[[package]]` table. No `upload-time` means a path dependency."""
    body = (
        f'[[package]]\nname = "{name}"\nversion = "{version}"\n'
        'source = { registry = "https://pypi.org/simple" }\n'
    )
    if upload_time is not None:
        body += (
            f'sdist = {{ url = "https://e/{name}-{version}.tar.gz", '
            f'hash = "sha256:cc", size = 1, upload-time = "{upload_time}" }}\n'
        )
    return body


def _lock(*entries: str) -> str:
    """A whole lockfile. Takes entries, never another lockfile — passing one in
    would silently produce a file with two headers."""
    return 'version = 1\nrequires-python = ">=3.12"\n\n' + "\n".join(entries)


SETTLED = _entry("settled", "1.0.0", "1999-01-01T00:00:00.000Z")
YOUNG = _entry("young", "1.0.0", "2099-01-01T00:00:00.000Z")
ROOTED = '[[package]]\nname = "rooted"\nversion = "0.1.0"\nsource = { editable = "." }\n'
BASELINE_LOCK = _lock(SETTLED, YOUNG, ROOTED)


def _audit(tmp_path: Path, baseline: str, candidate: str) -> subprocess.CompletedProcess[str]:
    (tmp_path / "baseline.lock").write_text(baseline)
    (tmp_path / "candidate.lock").write_text(candidate)
    return _run(
        "bash",
        str(COOLDOWN),
        "--audit",
        str(tmp_path / "baseline.lock"),
        str(tmp_path / "candidate.lock"),
        cwd=tmp_path,
    )


def test_a_candidate_that_moved_nothing_passes(tmp_path: Path) -> None:
    done = _audit(tmp_path, BASELINE_LOCK, BASELINE_LOCK)
    assert done.returncode == 0, done.stderr
    assert done.stdout == ""


def test_a_package_that_did_not_move_is_never_judged(tmp_path: Path) -> None:
    """`young` postdates every cutoff and is left alone, so it is not the audit's
    business: it entered under an older cutoff, and re-litigating a version the
    lockfile already holds is the install-time behaviour the cool-down refuses."""
    candidate = _lock(
        SETTLED, YOUNG, ROOTED, _entry("arrived", "1.0.0", "1999-06-01T00:00:00.000Z")
    )
    done = _audit(tmp_path, BASELINE_LOCK, candidate)
    assert done.returncode == 0, done.stderr
    assert done.stdout == ""


def test_a_package_the_resolution_added_too_recently_is_reported(tmp_path: Path) -> None:
    candidate = _lock(
        SETTLED, YOUNG, ROOTED, _entry("arrived", "2.0.0", "2099-06-01T00:00:00.000Z")
    )
    done = _audit(tmp_path, BASELINE_LOCK, candidate)
    assert done.returncode == 3, done.stdout
    assert done.stdout.strip() == "arrived==2.0.0"


def test_a_package_the_resolution_upgraded_too_recently_is_reported(tmp_path: Path) -> None:
    candidate = _lock(
        _entry("settled", "2.0.0", "2099-01-01T00:00:00.000Z"), YOUNG, ROOTED
    )
    done = _audit(tmp_path, BASELINE_LOCK, candidate)
    assert done.returncode == 3, done.stdout
    assert done.stdout.strip() == "settled==2.0.0"


def test_a_package_with_no_upload_time_passes(tmp_path: Path) -> None:
    """A path dependency or the workspace root itself: no publication, nothing to
    be patient about. This is the whole special-case list, not an example of it."""
    moved_root = '[[package]]\nname = "rooted"\nversion = "0.2.0"\nsource = { editable = "." }\n'
    candidate = _lock(SETTLED, YOUNG, moved_root)
    done = _audit(tmp_path, BASELINE_LOCK, candidate)
    assert done.returncode == 0, done.stdout
    assert done.stdout == ""


def test_the_audit_wants_exactly_two_lockfiles(tmp_path: Path) -> None:
    done = _run("bash", str(COOLDOWN), "--audit", cwd=tmp_path)
    assert done.returncode == 2
    assert "--audit" in done.stderr


def test_the_help_prints_the_whole_header_and_stops_at_the_code(tmp_path: Path) -> None:
    """The help is the file's own comment block, delimited by where the code
    starts rather than by a line number that goes stale the next time the header
    grows."""
    done = _run("bash", str(COOLDOWN), "--help", cwd=tmp_path)
    assert done.returncode == 0, done.stderr
    assert "cooldown.sh uv add httpx" in done.stdout
    assert "cooldown.sh --audit" in done.stdout
    assert "Overriding it" in done.stdout, "the help stops before the end of the header"
    assert "set -euo pipefail" not in done.stdout, "the help ran into the code"


# --------------------------------------------------------------------------
# The narrowed `uv add`
# --------------------------------------------------------------------------
#
# Driven against a stub `uv` rather than the real one. What is under test is the
# sequencing — what each pass is handed and what is on disk between them — and a
# real add would need an index, a network, and a package whose release history
# happened to straddle today's cutoff. The audit these cases end at is covered
# against fixtures above, and real uv is covered on the broad path below.

STUB_UV = """#!/usr/bin/env bash
# Records the call, then installs the lockfile this pass is supposed to produce.
n=$(cat "$STUB_STATE/count" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$STUB_STATE/count"
{
  echo "pass $n argv: $*"
  echo "pass $n exclude_newer: ${UV_EXCLUDE_NEWER-unset}"
  echo "pass $n no_sync: ${UV_NO_SYNC-unset}"
} >> "$STUB_STATE/calls.txt"
if [ -f "$STUB_STATE/pass$n.lock" ]; then
  cp "$STUB_STATE/pass$n.lock" "$PWD/uv.lock"
fi
printf 'touched-by-pass-%s\\n' "$n" >> "$PWD/pyproject.toml"
exit "$(cat "$STUB_STATE/exit$n" 2>/dev/null || echo 0)"
"""


@pytest.fixture
def stubbed(tmp_path: Path) -> tuple[Path, Path, dict[str, str]]:
    """A project, a stub `uv` ahead of the real one on PATH, and the env for both."""
    project = tmp_path / "project"
    project.mkdir()
    (project / "pyproject.toml").write_text(
        '[project]\nname = "cooldown-gate"\nversion = "0.1.0"\n'
        'requires-python = ">=3.12"\ndependencies = []\n'
    )
    (project / "uv.lock").write_text(BASELINE_LOCK)

    state = tmp_path / "state"
    state.mkdir()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "uv").write_text(STUB_UV)
    (bin_dir / "uv").chmod(0o755)

    env = dict(os.environ)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    env["STUB_STATE"] = str(state)
    return project, state, env


def _wrapped(project: Path, env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(COOLDOWN), *args],
        cwd=project,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def _calls(state: Path) -> str:
    return (state / "calls.txt").read_text()


def _baseline_plus(*extra: str) -> str:
    """The baseline lockfile with more packages in it."""
    return _lock(SETTLED, YOUNG, ROOTED, *extra)


ARRIVED = _entry("arrived", "1.0.0", "1999-06-01T00:00:00.000Z")


def _both_passes_land(state: Path, lock: str) -> None:
    (state / "pass1.lock").write_text(lock)
    (state / "pass2.lock").write_text(lock)


def test_a_wrapped_add_resolves_twice(stubbed) -> None:
    project, state, env = stubbed
    _both_passes_land(state, _baseline_plus(ARRIVED))

    done = _wrapped(project, env, "uv", "add", "arrived")
    assert done.returncode == 0, done.stderr
    assert (state / "count").read_text().strip() == "2"


def test_the_first_pass_carries_the_cutoff_and_syncs_nothing(stubbed) -> None:
    """It is thrown away, so installing anything from it would be waste at best."""
    project, state, env = stubbed
    _both_passes_land(state, _baseline_plus(ARRIVED))

    _wrapped(project, env, "uv", "add", "arrived")
    calls = _calls(state)
    assert re.search(r"pass 1 exclude_newer: \d{4}-\d{2}-\d{2}T", calls), calls
    assert "pass 1 no_sync: 1" in calls, calls


def test_the_second_pass_runs_with_no_cutoff_at_all(stubbed) -> None:
    """The whole point: without a cutoff uv keeps every pin the lockfile holds."""
    project, state, env = stubbed
    _both_passes_land(state, _baseline_plus(ARRIVED))

    _wrapped(project, env, "uv", "add", "arrived")
    assert "pass 2 exclude_newer: unset" in _calls(state), _calls(state)


def test_the_second_pass_pins_the_versions_the_first_one_vetted(stubbed) -> None:
    project, state, env = stubbed
    _both_passes_land(state, _baseline_plus(ARRIVED))

    _wrapped(project, env, "uv", "add", "arrived")
    assert "pass 2 argv: add arrived -P arrived==1.0.0" in _calls(state), _calls(state)


def test_a_package_the_lockfile_already_held_is_not_pinned(stubbed) -> None:
    """Pinning it would be the bug: the second pass keeps it by doing nothing."""
    project, state, env = stubbed
    _both_passes_land(state, BASELINE_LOCK)

    _wrapped(project, env, "uv", "add", "settled")
    assert "pass 2 argv: add settled\n" in _calls(state), _calls(state)


def test_the_first_pass_is_undone_before_the_second_one_runs(stubbed) -> None:
    """The stub appends a line to pyproject.toml on every call. Two calls, one
    line left, is the restore doing its job."""
    project, state, env = stubbed
    _both_passes_land(state, _baseline_plus(ARRIVED))

    _wrapped(project, env, "uv", "add", "arrived")
    manifest = (project / "pyproject.toml").read_text()
    assert manifest.count("touched-by-pass-") == 1, manifest
    assert "touched-by-pass-2" in manifest, manifest


def test_an_add_that_needs_a_version_the_cutoff_refuses_changes_nothing(stubbed) -> None:
    """The second pass had no cool-down of its own, so its result is checked
    rather than trusted."""
    project, state, env = stubbed
    before_lock = (project / "uv.lock").read_text()
    before_manifest = (project / "pyproject.toml").read_text()
    (state / "pass1.lock").write_text(_baseline_plus(ARRIVED))
    # The resolver could not honour the pin and took a release published yesterday.
    (state / "pass2.lock").write_text(
        _baseline_plus(_entry("arrived", "9.0.0", "2099-06-01T00:00:00.000Z"))
    )

    done = _wrapped(project, env, "uv", "add", "arrived")
    assert done.returncode == 3, done.stderr
    assert "arrived==9.0.0" in done.stderr
    assert (project / "uv.lock").read_text() == before_lock
    assert (project / "pyproject.toml").read_text() == before_manifest


def test_a_first_pass_that_cannot_resolve_changes_nothing(stubbed) -> None:
    project, state, env = stubbed
    before_lock = (project / "uv.lock").read_text()
    before_manifest = (project / "pyproject.toml").read_text()
    (state / "exit1").write_text("1")

    done = _wrapped(project, env, "uv", "add", "impossible")
    assert done.returncode == 1, done.stderr
    assert (state / "count").read_text().strip() == "1", "the second pass ran anyway"
    assert (project / "uv.lock").read_text() == before_lock
    assert (project / "pyproject.toml").read_text() == before_manifest


def test_a_second_pass_that_fails_changes_nothing(stubbed) -> None:
    """The pins narrow the resolution, so they can also make it impossible. When
    they do, the failure is uv's and the lockfile is nobody's business but its own."""
    project, state, env = stubbed
    before_lock = (project / "uv.lock").read_text()
    before_manifest = (project / "pyproject.toml").read_text()
    (state / "pass1.lock").write_text(_baseline_plus(ARRIVED))
    (state / "exit2").write_text("2")

    done = _wrapped(project, env, "uv", "add", "arrived")
    assert done.returncode == 2, done.stderr
    assert (state / "count").read_text().strip() == "2"
    assert (project / "uv.lock").read_text() == before_lock
    assert (project / "pyproject.toml").read_text() == before_manifest


def test_a_project_with_no_lockfile_resolves_once(stubbed) -> None:
    """There are no pins to protect, so a second pass would buy nothing."""
    project, state, env = stubbed
    (project / "uv.lock").unlink()

    done = _wrapped(project, env, "uv", "add", "arrived")
    assert done.returncode == 0, done.stderr
    assert (state / "count").read_text().strip() == "1"
    assert re.search(r"pass 1 exclude_newer: \d{4}", _calls(state)), _calls(state)


def test_only_uv_add_is_narrowed(stubbed) -> None:
    """Everything else keeps the whole-set behaviour, which is the safe direction
    to be wrong in: it applies the cool-down to more rather than to less."""
    project, state, env = stubbed
    (state / "pass1.lock").write_text(BASELINE_LOCK)

    for command in (["uv", "lock"], ["uv", "sync"], ["uv", "--directory", ".", "add", "x"]):
        (state / "count").unlink(missing_ok=True)
        (state / "calls.txt").unlink(missing_ok=True)
        done = _wrapped(project, env, *command)
        assert done.returncode == 0, done.stderr
        assert (state / "count").read_text().strip() == "1", f"{command} was narrowed"
        assert re.search(r"pass 1 exclude_newer: \d{4}", _calls(state)), command
