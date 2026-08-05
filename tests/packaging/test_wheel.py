"""The one artifact VisionSet ships, checked as an artifact.

Everything else in this suite tests a source checkout. What a user gets is a
wheel, and three things can be wrong with it that no source test can see: **the
compiled UI is not inside it**, **the version metadata disagrees with `VERSION`**,
and **something enormous came along for the ride**. Each of those installs
cleanly, starts cleanly, and is wrong.

The first is the one worth naming. `uv build` copies `src/visionset/_static/` as
package data *at the moment it runs*, and a fresh checkout's `_static/` holds two
placeholder files — so a wheel built before `pnpm bundle:static` contains no app
at all. It installs. `visionset server` starts. `/app/` answers a 404 naming a script
the user cannot run, because they do not have the repository. There is no error
and no traceback anywhere in that sequence.

**This directory is ``tests/packaging/`` and not ``tests/dist/``**, which is not
taste: pytest's default ``norecursedirs`` includes ``dist``, so a directory by
that name is silently never collected — no error, no warning, and a suite that
reports every other test passing. Overriding ``norecursedirs`` would have fixed
it and would also have started collecting real build output; renaming costs
nothing.

**Opt-in locally, required in CI**, a variation on the ffmpeg rule from #22. These
install into a fresh virtual environment and start a server, which is about a
minute — so they skip unless `VISIONSET_REQUIRE_WHEEL=1` says a wheel exists and
must be tested, or `VISIONSET_WHEEL` names one. CI's `wheel` job sets the first
after running `scripts/build_dist.sh`, so a build step that silently produced
nothing goes red rather than quietly shrinking the suite.
"""

from __future__ import annotations

import os
import re
import socket
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

import pytest

WHEEL_REQUIRED_ENV = "VISIONSET_REQUIRE_WHEEL"
WHEEL_ENV = "VISIONSET_WHEEL"

WHEEL_MISSING_HINT = (
    f"no wheel to test; run `bash scripts/build_dist.sh` first, or set {WHEEL_ENV} to one."
)

OPT_IN_HINT = (
    f"the wheel tests are opt-in: build one and run "
    f"`{WHEEL_REQUIRED_ENV}=1 uv run pytest tests/dist`, or set {WHEEL_ENV} to a "
    f"wheel. They install into a fresh venv and start a server, which is a minute "
    f"nobody running the unit suite asked for."
)

REPO_ROOT = Path(__file__).resolve().parents[2]

#: The ceiling a wheel may not cross, and it is a guard rather than a budget.
#:
#: The wheel is ~570 KB today, of which ~640 KB uncompressed is the app's one
#: JavaScript bundle. Two megabytes leaves room for the UI to roughly triple and
#: still fails loudly the day `node_modules/`, a fixture video or a `.venv` gets
#: swept in — which is the failure this exists for, and the one that is invisible
#: in a directory listing.
MAX_WHEEL_BYTES = 2 * 1024 * 1024

#: Nothing matching these may be inside. Each is something that has ended up in
#: somebody's wheel: a dependency tree, a test corpus, a virtualenv, a workspace.
FORBIDDEN = (
    "node_modules/",
    ".venv/",
    "workspace-data/",
    "visionset.db",
    "/tests/",
    "/e2e/",
)

#: Media suffixes. `_static/` legitimately holds none today — the app ships as
#: HTML, CSS and JavaScript — so any of these is something nobody meant to ship.
FORBIDDEN_SUFFIXES = (".mp4", ".mov", ".avi", ".jpg", ".jpeg", ".tiff", ".bmp")

#: How long the freshly installed server gets to bind a socket.
#:
#: Generous, because a cold import of fastapi, pydantic and sqlalchemy on a shared
#: CI runner is seconds rather than milliseconds, and this is the one place in the
#: suite where a wall-clock number decides a pass. It is a *ceiling*, not a
#: sleep — the loop returns the moment `/health` answers.
STARTUP_TIMEOUT_SECONDS = 60.0


def wheel_path() -> Path:
    """The wheel under test: named, or the newest in ``dist/``."""
    named = os.environ.get(WHEEL_ENV)
    if named:
        return Path(named)
    # **Opt-in even when `dist/` holds one.** A developer who built a wheel once
    # should not silently start paying a minute on every `uv run pytest`; and
    # `dist/` is git-ignored, so its contents are not a signal anybody chose.
    if os.environ.get(WHEEL_REQUIRED_ENV) != "1":
        pytest.skip(OPT_IN_HINT, allow_module_level=True)
    built = sorted((REPO_ROOT / "dist").glob("visionset-*.whl"))
    if not built:
        # The variable means "there is a wheel and you must test it", so its
        # absence here is an error rather than a skip — CI sets it, and a build
        # step that silently produced nothing must go red.
        raise RuntimeError(
            f"{WHEEL_MISSING_HINT} ({WHEEL_REQUIRED_ENV}=1 is set, so a missing "
            f"wheel is an error, not a skip.)"
        )
    return built[-1]


WHEEL = wheel_path()

VERSION = (REPO_ROOT / "VERSION").read_text(encoding="utf-8").strip()


@pytest.fixture(scope="module")
def names() -> list[str]:
    with zipfile.ZipFile(WHEEL) as archive:
        return archive.namelist()


# --- what is inside -----------------------------------------------------------


def test_the_compiled_app_travels_inside_the_wheel(names: list[str]) -> None:
    """The delivery thesis, and the failure that has no error message.

    A wheel built before `pnpm bundle:static` carries `_static/README.md` and
    `_static/.gitkeep` and nothing else. It installs, it starts, and `/app/`
    answers a 404 naming a script its user does not have.
    """
    assert "visionset/_static/index.html" in names
    assert any(name.startswith("visionset/_static/assets/") for name in names)
    assert any(name.endswith(".js") for name in names)
    assert any(name.endswith(".css") for name in names)


def test_the_bundle_was_built_for_the_ui_prefix(names: list[str]) -> None:
    """#33's trap, and it is invisible once the wheel is built.

    A bundle built with the dev base references `/assets/…`, which the SPA
    fallback answers with `index.html` at **200** — so the page loads blank
    rather than failing, and the browser console is the only place it shows.
    """
    with zipfile.ZipFile(WHEEL) as archive:
        index = archive.read("visionset/_static/index.html").decode("utf-8")

    assert "/app/assets/" in index
    assert re.search(r'src=["\']/assets/', index) is None


def test_the_package_itself_is_all_there(names: list[str]) -> None:
    for expected in (
        "visionset/__init__.py",
        "visionset/cli/main.py",
        "visionset/server/main.py",
        "visionset/mcp/main.py",
        "visionset/kernel/services/workspace_service.py",
        "visionset/formats/yolo/__init__.py",
        "visionset/formats/coco/__init__.py",
        "visionset/formats/voc/__init__.py",
    ):
        assert expected in names, expected


def test_the_entry_points_ship_so_the_command_and_the_plugins_exist(
    names: list[str],
) -> None:
    """Without this file there is no `visionset` command and no exporter at all.

    Format discovery is `importlib.metadata` over the `visionset.formats` group,
    which reads *installed* metadata — so a wheel whose entry points did not make
    it is one where `visionset format list` is empty and nothing says why.
    """
    (entry_points,) = [name for name in names if name.endswith("entry_points.txt")]
    with zipfile.ZipFile(WHEEL) as archive:
        declared = archive.read(entry_points).decode("utf-8")

    assert "visionset = visionset.cli.main:app" in declared
    assert "[visionset.formats]" in declared
    for plugin in ("dummy", "yolo", "coco", "voc"):
        assert f"{plugin} = visionset.formats." in declared


# --- what is not -------------------------------------------------------------


def test_nothing_enormous_came_along_for_the_ride(names: list[str]) -> None:
    for name in names:
        assert not any(part in name for part in FORBIDDEN), name
        assert not name.endswith(FORBIDDEN_SUFFIXES), name


def test_the_wheel_stays_under_its_ceiling() -> None:
    """A guard, not a budget. See `MAX_WHEEL_BYTES`."""
    size = WHEEL.stat().st_size
    assert size < MAX_WHEEL_BYTES, f"{WHEEL.name} is {size} bytes"


def test_no_source_maps_ship(names: list[str]) -> None:
    """They would roughly double the wheel and are useless without the sources."""
    assert not [name for name in names if name.endswith(".map")]


# --- what it says it is -------------------------------------------------------


def test_the_wheel_metadata_agrees_with_the_version_file(names: list[str]) -> None:
    """One source of truth, checked at the far end of the pipeline.

    `VERSION` is read by hatch at build time, by `__init__` at runtime through
    installed metadata, and by `pnpm version:sync` for the frontend. This is the
    place they can silently disagree: a stale `dist/` from before a version bump
    looks exactly like a fresh one.
    """
    assert WHEEL.name.startswith(f"visionset-{VERSION}-")
    (metadata,) = [name for name in names if name.endswith(".dist-info/METADATA")]
    with zipfile.ZipFile(WHEEL) as archive:
        declared = archive.read(metadata).decode("utf-8")

    assert f"Version: {VERSION}\n" in declared
    assert f"visionset-{VERSION}.dist-info/" in metadata


# --- installing it ------------------------------------------------------------


@pytest.fixture(scope="module")
def installed(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """The wheel, in a fresh virtual environment with nothing else in it.

    `--no-cache` so a previously built wheel of the same version cannot be served
    from uv's cache instead of this one — a version-stamping test that read a
    cached artifact would pass while testing the wrong bytes.
    """
    root = tmp_path_factory.mktemp("clean-venv")
    venv = root / "venv"
    subprocess.run(["uv", "venv", str(venv)], check=True, capture_output=True)
    subprocess.run(
        ["uv", "pip", "install", "--no-cache", "--python", str(venv), str(WHEEL)],
        check=True,
        capture_output=True,
    )
    return venv


def _command(venv: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    binary = venv / ("Scripts" if sys.platform == "win32" else "bin") / "visionset"
    return subprocess.run([str(binary), *arguments], capture_output=True, text=True, check=False)


def test_the_installed_command_reports_the_version_the_wheel_claims(
    installed: Path,
) -> None:
    result = _command(installed, "--version")

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == VERSION


def test_the_installed_command_finds_every_exporter(installed: Path) -> None:
    """Entry-point discovery, from the *installed* metadata rather than the source tree."""
    result = _command(installed, "format", "list")

    assert result.returncode == 0, result.stderr
    names = [line.split()[0] for line in result.stdout.splitlines()[1:]]
    assert names == ["coco", "dummy", "voc", "yolo"]


def test_the_installed_server_serves_the_real_app(installed: Path, tmp_path: Path) -> None:
    """The acceptance criterion, end to end: pip, then a browser could use it.

    Asserts the *bundle* came back rather than merely a 200 — the SPA fallback
    answers `index.html` for anything under `/app/` that looks like a browser
    request, so a status code alone proves almost nothing.
    """
    workspace = tmp_path / "ws"
    result = _command(installed, "init", str(workspace))
    assert result.returncode == 0, result.stderr

    with _serving(installed, workspace, _free_port()) as base:
        index = _get(f"{base}/app/")
        assert "/app/assets/" in index
        # `/` is a redirect to `/app/`, which urllib follows, so this proves the
        # front door works and not merely the mount.
        assert _get(base) == index
        # …and the API is still at the root, which is why the app is not.
        assert '"status"' in _get(f"{base}/health")


def _free_port() -> int:
    """A port nothing is listening on, chosen by the kernel.

    Not a constant: a hard-coded port collides with a previous run that outlived
    its test, and the failure is a **404 from somebody else's server** rather
    than a refused connection — which reads as a bug in the wheel. There is a
    race between closing this socket and the server binding it, and it is the
    right trade: the alternative is a number that is wrong on somebody's machine
    forever.
    """
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _serving(venv: Path, workspace: Path, port: int) -> _Server:
    return _Server(venv, workspace, port)


class _Server:
    """`visionset server` for the duration of a `with`, or say why it never came up."""

    def __init__(self, venv: Path, workspace: Path, port: int) -> None:
        self._venv = venv
        self._workspace = workspace
        self._port = port
        self._process: subprocess.Popen[str] | None = None

    def __enter__(self) -> str:
        try:
            return self._start()
        except BaseException:
            # **`__exit__` is not called when `__enter__` raises**, so a server
            # that came up but never answered would outlive the test and hold its
            # port — which the next run meets as a 404 from a stranger rather than
            # as a refused connection.
            self.__exit__()
            raise

    def _start(self) -> str:
        binary = self._venv / ("Scripts" if sys.platform == "win32" else "bin") / "visionset"
        self._process = subprocess.Popen(
            [
                str(binary),
                "server",
                "--workspace",
                str(self._workspace),
                "--port",
                str(self._port),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        base = f"http://127.0.0.1:{self._port}"
        # Polled against a deadline rather than a fixed number of tries: a
        # refused connection comes back instantly, so a bare loop would spend its
        # whole budget in milliseconds and report a timeout that never happened.
        deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if self._process.poll() is not None:
                output = self._process.communicate()[0]
                raise AssertionError(f"the server exited before answering:\n{output}")
            try:
                urlopen(f"{base}/health", timeout=1).read()
            except (URLError, OSError):
                time.sleep(0.1)
                continue
            return base
        raise AssertionError(f"the server never answered /health within {STARTUP_TIMEOUT_SECONDS}s")

    def __exit__(self, *_: object) -> None:
        if self._process is None:
            return
        self._process.terminate()
        try:
            self._process.wait(timeout=20)
        except subprocess.TimeoutExpired:  # pragma: no cover - a hung server
            self._process.kill()
            self._process.wait(timeout=20)


def _get(url: str) -> str:
    with urlopen(url, timeout=10) as response:
        return response.read().decode("utf-8")
