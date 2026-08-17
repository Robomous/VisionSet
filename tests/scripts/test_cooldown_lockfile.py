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
