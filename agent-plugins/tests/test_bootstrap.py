"""Bootstrap decisions against an in-memory disk and a scripted runner."""

from __future__ import annotations

import contextlib
import io
import json
import ntpath
import os
import posixpath
import sys
import tempfile
import types
import unittest
from collections.abc import Callable, Mapping, Sequence
from typing import Any
from unittest import mock

import _support  # noqa: F401  (puts the runtime on sys.path)
from bootstrap import (
    DATA_ENV,
    INSTALL_TIMEOUT,
    NO_BOOTSTRAP_ENV,
    RETRY_DELAY,
    BootstrapError,
    Bootstrapped,
    Code,
    FileLocker,
    Interpreter,
    Lease,
    cached_prefixes,
    data_root,
    layout,
    runtime_key,
)
from bootstrap import bootstrap as run_bootstrap
from discover import Bundle, Host, ProbeResult, discover

COMPAT = "==0.0.1b4"
BUNDLE = Bundle("visionset", "visionset", COMPAT)
HOME = "/home/u"
DATA = "/data/plugin"
PYTHON = "/usr/bin/python3.12"
SECRET = "s3cr3t-pass-9"
INDEX = f"https://alice:{SECRET}@pypi.example/simple"
OK = ProbeResult(0)
UNREACHABLE = ProbeResult(
    1,
    stderr=(
        f"WARNING: Retrying after connection broken by 'NewConnectionError': {INDEX}/visionset/\n"
        "ERROR: No matching distribution found for visionset==0.0.1b4\n"
    ).encode(),
)
FORBIDDEN = ("--user", "--upgrade", "-U", "--pre", "--break-system-packages", "--target")


class FakeDisk:
    def __init__(self, windows: bool = False) -> None:
        self.pm: Any = ntpath if windows else posixpath
        self.files: dict[str, str] = {}
        self.dirs: set[str] = set()
        self.exes: set[str] = set()
        self.modes: dict[str, int] = {}
        self.writes: list[str] = []
        self.replaced: list[tuple[str, str]] = []

    def k(self, path: str) -> str:
        return str(self.pm.normcase(self.pm.normpath(path)))

    def put(self, path: str, text: str = "", executable: bool = False) -> None:
        self.makedirs(self.pm.dirname(path))
        self.files[self.k(path)] = text
        if executable:
            self.exes.add(self.k(path))

    def lexists(self, path: str) -> bool:
        return self.k(path) in self.files or self.k(path) in self.dirs

    def is_file(self, path: str) -> bool:
        return self.k(path) in self.files

    def is_dir(self, path: str) -> bool:
        return self.k(path) in self.dirs

    def is_executable(self, path: str) -> bool:
        return self.k(path) in self.exes

    def realpath(self, path: str) -> str:
        return str(self.pm.normpath(path))

    def listdir(self, path: str) -> list[str]:
        prefix = self.k(path) + ("\\" if self.pm is ntpath else "/")
        names = {
            key[len(prefix) :].split(self.pm.sep)[0]
            for key in (*self.files, *self.dirs)
            if key.startswith(prefix)
        }
        return sorted(names)

    def read_head(self, path: str) -> str:
        return self.files.get(self.k(path), "")[:4096]

    def makedirs(self, path: str) -> None:
        while path and self.k(path) not in self.dirs:
            self.dirs.add(self.k(path))
            parent = self.pm.dirname(path)
            if parent == path:
                break
            path = parent

    def read_text(self, path: str) -> str | None:
        return self.files.get(self.k(path))

    def write_new(self, path: str, text: str) -> None:
        self.writes.append(self.k(path))
        self.put(path, text)

    def replace(self, source: str, target: str) -> None:
        self.replaced.append((self.k(source), self.k(target)))
        self.files[self.k(target)] = self.files.pop(self.k(source))

    def remove_tree(self, path: str) -> None:
        prefix = self.k(path)
        inside = (prefix + "\\", prefix + "/")

        def doomed(key: str) -> bool:
            return key == prefix or key.startswith(inside)

        self.files = {k: v for k, v in self.files.items() if not doomed(k)}
        self.dirs = {k for k in self.dirs if not doomed(k)}
        self.exes = {k for k in self.exes if not doomed(k)}

    def append_private(self, path: str, text: str) -> None:
        self.put(path, self.files.get(self.k(path), "") + text)
        self.modes[self.k(path)] = 0o600

    def tree(self, root: str) -> list[str]:
        prefix = self.k(root)
        return sorted(key for key in (*self.files, *self.dirs) if key.startswith(prefix))


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.t += seconds

    def now(self) -> float:
        return 1_800_000_000.0 + self.t


class FakeLease:
    def __init__(self, locker: FakeLocker) -> None:
        self.locker = locker

    def release(self) -> None:
        self.locker.released += 1


class FakeLocker:
    def __init__(self, busy: bool = False) -> None:
        self.busy = busy
        self.acquired: list[tuple[str, float]] = []
        self.released = 0
        self.on_acquire: Callable[[], None] | None = None

    def acquire(self, path: str, timeout: float) -> Lease | None:
        self.acquired.append((path, timeout))
        if self.busy:
            return None
        if self.on_acquire is not None:
            self.on_acquire()
        return FakeLease(self)


def probe_output(version: tuple[int, int, int], venv: bool = True, ensurepip: bool = True) -> str:
    return json.dumps(
        {
            "version": list(version),
            "executable": "",
            "implementation": "cpython",
            "platform": "linux-x86_64",
            "venv": venv,
            "ensurepip": ensurepip,
        }
    )


class FakeRunner:
    """Plays every process bootstrap starts: interpreters, venv, pip and the console script."""

    def __init__(self, disk: FakeDisk, windows: bool = False) -> None:
        self.disk = disk
        self.windows = windows
        self.pythons: dict[str, ProbeResult] = {}
        self.venv_result = OK
        self.pip_version = ProbeResult(0, b"pip 24.0\n")
        self.installs: list[ProbeResult] = []
        self.alive = OK
        self.version = ProbeResult(0, b"0.0.1b4\n")
        self.mcp = ProbeResult(0, b"usage")
        self.calls: list[list[str]] = []
        self.envs: list[dict[str, str]] = []
        self.timeouts: list[float] = []
        self.published_early: list[list[str]] = []

    def python(self, path: str, output: str | ProbeResult) -> None:
        self.disk.put(path, executable=True)
        if isinstance(output, str):
            data = json.loads(output)
            data["executable"] = data["executable"] or path
            output = ProbeResult(0, json.dumps(data).encode())
        self.pythons[self.disk.k(path)] = output

    def install_calls(self) -> list[list[str]]:
        return [call for call in self.calls if "install" in call]

    def __call__(
        self, argv: Sequence[str], cwd: str, env: Mapping[str, str], timeout: float, cap: int
    ) -> ProbeResult:
        argv = list(argv)
        self.calls.append(argv)
        published = any(key.endswith("ready.json") for key in self.disk.files)
        if published and "-c" not in argv:
            self.published_early.append(argv)
        self.envs.append(dict(env))
        self.timeouts.append(timeout)
        if "-c" in argv and argv[-1] != "import sys":
            return self.pythons[self.disk.k(argv[0])]
        if argv[-1] == "import sys":
            return self.alive
        if argv[-2:-1] == ["venv"]:
            if self.venv_result.returncode == 0:
                scripts = self.disk.pm.join(argv[-1], "Scripts" if self.windows else "bin")
                suffix = ".exe" if self.windows else ""
                self.disk.put(self.disk.pm.join(scripts, "python" + suffix), executable=True)
            return self.venv_result
        if argv[-2:] == ["pip", "--version"]:
            return self.pip_version
        if "install" in argv:
            result = self.installs.pop(0) if self.installs else OK
            if result.returncode == 0:
                scripts = self.disk.pm.dirname(argv[0])
                name = "visionset.exe" if self.windows else "visionset"
                self.disk.put(self.disk.pm.join(scripts, name), executable=True)
            return result
        if argv[1:] == ["--version"]:
            return self.version
        if argv[1:] == ["mcp", "--help"]:
            return self.mcp
        raise AssertionError(f"unexpected argv {argv}")


class Machine:
    def __init__(self, windows: bool = False, macos: bool = False) -> None:
        self.windows = windows
        self.disk = FakeDisk(windows)
        self.run = FakeRunner(self.disk, windows)
        self.clock = FakeClock()
        self.locker = FakeLocker()
        self.progress: list[str] = []
        self.home = "C:\\Users\\u" if windows else HOME
        self.env: dict[str, str] = {
            DATA_ENV: "C:\\data\\plugin" if windows else DATA,
            "PATH": "C:\\Windows" if windows else "/usr/bin",
            "PIP_INDEX_URL": INDEX,
            "PIP_TARGET": "/tmp/elsewhere",
            "PIP_USER": "1",
            "PIP_REQUIRE_VIRTUALENV": "0",
            "PIP_PYTHON": "/usr/bin/python3",
            "PYTHONPATH": "/evil",
            "PYTHONHOME": "/evil",
        }
        self.macos = macos

    def host(self) -> Host:
        return Host(env=self.env, windows=self.windows, home=self.home, macos=self.macos)

    def bootstrap(self, python: str | None = PYTHON, **kwargs: Any) -> Bootstrapped:
        stdout = io.StringIO()
        try:
            with contextlib.redirect_stdout(stdout):
                return run_bootstrap(
                    BUNDLE,
                    host=self.host(),
                    fs=self.disk,
                    run=self.run,
                    locker=self.locker,
                    clock=self.clock,
                    python=python,
                    plugin_root=kwargs.pop("plugin_root", None),
                    progress=self.progress.append,
                    **kwargs,
                )
        finally:
            assert stdout.getvalue() == "", stdout.getvalue()

    def failure(self, **kwargs: Any) -> BootstrapError:
        try:
            self.bootstrap(**kwargs)
        except BootstrapError as error:
            return error
        raise AssertionError("bootstrap succeeded")

    def runtimes(self) -> list[str]:
        root = self.env[DATA_ENV]
        return self.disk.listdir(self.disk.pm.join(root, "runtimes"))


def assert_safe_argv(case: unittest.TestCase, calls: list[list[str]]) -> None:
    for argv in calls:
        case.assertNotIn(posixpath.basename(argv[0]), ("sudo", "doas", "su", "runas"))
        for flag in FORBIDDEN:
            case.assertNotIn(flag, argv)
        if "install" in argv:
            case.assertEqual(argv[-1], "visionset==0.0.1b4")
            case.assertNotIn("[", argv[-1])
        case.assertFalse(any(SECRET in part for part in argv))


class BuildTest(unittest.TestCase):
    def setUp(self) -> None:
        self.m = Machine()
        self.m.run.python(PYTHON, probe_output((3, 12, 4)))

    def tearDown(self) -> None:
        assert_safe_argv(self, self.m.run.calls)

    def test_a_clean_build_publishes_after_validation(self) -> None:
        result = self.m.bootstrap()
        self.assertFalse(result.reused)
        self.assertEqual(result.version, "0.0.1b4")
        [name] = self.m.runtimes()
        self.assertRegex(name, r"^0\.0\.1b4-py312-[0-9a-f]{8}$")
        lay = layout(DATA, name, "visionset", False)
        self.assertEqual((result.prefix, result.console_script), (lay.venv, lay.console_script))
        sentinel = json.loads(self.m.disk.files[lay.ready])
        self.assertEqual(sentinel["key"], name)
        self.assertEqual(sentinel["compatibility"], COMPAT)
        self.assertEqual(json.loads(self.m.disk.files[lay.owner])["key"], name)
        self.assertNotIn(lay.ready + ".tmp", self.m.disk.files)
        self.assertNotIn(lay.ready, self.m.disk.writes)
        self.assertEqual(self.m.disk.replaced, [(lay.ready + ".tmp", lay.ready)])
        self.assertEqual(self.m.locker.acquired, [(lay.lock, 300.0)])
        self.assertEqual(self.m.locker.released, 1)
        self.assertEqual(self.m.run.published_early, [])

    def test_steps_run_in_order_with_the_exact_pip_command(self) -> None:
        self.m.bootstrap()
        [name] = self.m.runtimes()
        lay = layout(DATA, name, "visionset", False)
        steps = [call for call in self.m.run.calls if "-c" not in call]
        self.assertEqual(
            steps,
            [
                [PYTHON, "-I", "-m", "venv", lay.venv],
                [lay.python, "-I", "-m", "pip", "--version"],
                [
                    lay.python,
                    "-I",
                    "-m",
                    "pip",
                    "install",
                    "--no-input",
                    "--disable-pip-version-check",
                    "--progress-bar",
                    "off",
                    "visionset==0.0.1b4",
                ],
                [lay.console_script, "--version"],
                [lay.console_script, "mcp", "--help"],
            ],
        )

    def test_every_process_gets_a_scrubbed_environment_that_keeps_the_index(self) -> None:
        self.m.bootstrap()
        scripts = [c for c in self.m.run.calls if c[1:2] != ["--version"] and "mcp" not in c]
        self.assertEqual(len(scripts), 4)
        for call, env in zip(self.m.run.calls, self.m.run.envs, strict=True):
            if call not in scripts:
                continue
            for name in ("PIP_TARGET", "PIP_USER", "PIP_REQUIRE_VIRTUALENV", "PIP_PYTHON"):
                self.assertNotIn(name, env)
            self.assertNotIn("PYTHONPATH", env)
            self.assertNotIn("PYTHONHOME", env)
        install_env = self.m.run.envs[self.m.run.calls.index(self.m.run.install_calls()[0])]
        self.assertEqual(install_env["PIP_INDEX_URL"], INDEX)

    def test_the_install_is_bounded_by_the_overall_timeout(self) -> None:
        self.m.bootstrap(install_timeout=120.0)
        index = self.m.run.calls.index(self.m.run.install_calls()[0])
        self.assertLessEqual(self.m.run.timeouts[index], 120.0)
        self.assertGreater(self.m.run.timeouts[index], 0)

    def test_a_ready_runtime_is_reused_without_the_lock_or_pip(self) -> None:
        first = self.m.bootstrap()
        self.m.run.calls.clear()
        second = self.m.bootstrap()
        self.assertTrue(second.reused)
        self.assertEqual(second.prefix, first.prefix)
        self.assertEqual(self.m.run.install_calls(), [])
        self.assertEqual(len(self.m.locker.acquired), 1)

    def test_a_runtime_published_while_waiting_for_the_lock_is_not_rebuilt(self) -> None:
        other = Machine()
        other.disk = self.m.disk
        other.run = FakeRunner(self.m.disk)
        other.run.pythons = self.m.run.pythons

        def publish_meanwhile() -> None:
            other.bootstrap()

        self.m.locker.on_acquire = publish_meanwhile
        result = self.m.bootstrap()
        self.assertTrue(result.reused)
        self.assertEqual(len(other.run.install_calls()), 1)
        self.assertEqual(self.m.run.install_calls(), [])

    def test_a_runtime_whose_interpreter_died_is_rebuilt(self) -> None:
        self.m.bootstrap()
        self.m.run.alive = ProbeResult(None, error="No such file or directory")
        result = self.m.bootstrap()
        self.assertFalse(result.reused)
        self.assertEqual(len(self.m.run.install_calls()), 2)
        self.assertTrue(any("no longer starts" in line for line in self.m.progress))

    def test_an_incomplete_owned_directory_is_removed_and_rebuilt(self) -> None:
        self.m.bootstrap()
        [name] = self.m.runtimes()
        lay = layout(DATA, name, "visionset", False)
        del self.m.disk.files[lay.ready]
        self.m.disk.put(lay.venv + "/half-written")
        self.m.bootstrap()
        self.assertNotIn(lay.venv + "/half-written", self.m.disk.files)
        self.assertIn(lay.ready, self.m.disk.files)
        self.assertEqual(len(self.m.run.install_calls()), 2)

    def test_an_empty_directory_left_before_the_marker_is_recovered(self) -> None:
        self.m.bootstrap()
        [name] = self.m.runtimes()
        lay = layout(DATA, name, "visionset", False)
        self.m.disk.remove_tree(lay.runtime)
        self.m.disk.makedirs(lay.runtime)
        self.assertFalse(self.m.bootstrap().reused)
        self.assertIn(lay.ready, self.m.disk.files)

    def test_a_slow_interpreter_is_not_mistaken_for_a_dead_one(self) -> None:
        self.m.bootstrap()
        self.m.run.alive = ProbeResult(None, timed_out=True)
        self.assertTrue(self.m.bootstrap().reused)
        self.assertEqual(len(self.m.run.install_calls()), 1)

    def test_a_directory_without_the_owner_marker_is_never_touched(self) -> None:
        self.m.bootstrap()
        [name] = self.m.runtimes()
        lay = layout(DATA, name, "visionset", False)
        for path in (lay.ready, lay.owner):
            del self.m.disk.files[path]
        before = self.m.disk.tree(lay.runtime)
        error = self.m.failure()
        self.assertIs(error.code, Code.NOT_OWNED)
        self.assertEqual(self.m.disk.tree(lay.runtime), before)
        self.assertEqual(len(self.m.run.install_calls()), 1)

    def test_an_owner_marker_for_another_key_does_not_count(self) -> None:
        self.m.bootstrap()
        [name] = self.m.runtimes()
        lay = layout(DATA, name, "visionset", False)
        del self.m.disk.files[lay.ready]
        self.m.disk.files[lay.owner] = json.dumps({"owner": "visionset-agent-plugin", "key": "x"})
        self.assertIs(self.m.failure().code, Code.NOT_OWNED)

    def test_cached_prefixes_lists_published_runtimes_newest_first(self) -> None:
        self.m.bootstrap()
        self.m.run.python("/usr/bin/python3.13", probe_output((3, 13, 1)))
        self.m.clock.t += 60
        newer = self.m.bootstrap(python="/usr/bin/python3.13")
        listed = cached_prefixes(host=self.m.host(), fs=self.m.disk)
        self.assertEqual(len(listed), 2)
        self.assertEqual(listed[0], newer.prefix)
        [name] = [n for n in self.m.runtimes() if "py312" in n]
        del self.m.disk.files[layout(DATA, name, "visionset", False).ready]
        self.assertEqual(cached_prefixes(host=self.m.host(), fs=self.m.disk), [newer.prefix])

    def test_discovery_accepts_what_cached_prefixes_returns(self) -> None:
        result = self.m.bootstrap()
        found = discover(
            compatibility=COMPAT,
            host=Host(env={}, windows=False, home=None),
            cached=cached_prefixes(host=self.m.host(), fs=self.m.disk),
            fs=self.m.disk,
            run=self.m.run,
        )
        assert found.selected is not None, found
        self.assertEqual(found.selected.candidate.path, result.console_script)

    def test_progress_goes_to_stderr_by_default(self) -> None:
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            run_bootstrap(
                BUNDLE,
                host=self.m.host(),
                fs=self.m.disk,
                run=self.m.run,
                locker=self.m.locker,
                clock=self.m.clock,
                python=PYTHON,
                plugin_root=None,
            )
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("visionset plugin: runtime ready", stderr.getvalue())


class FailureTest(unittest.TestCase):
    def setUp(self) -> None:
        self.m = Machine()

    def tearDown(self) -> None:
        assert_safe_argv(self, self.m.run.calls)

    def assert_nothing_published(self) -> None:
        for name in self.m.runtimes():
            self.fail(f"{name} was left behind")

    def test_no_python_at_all(self) -> None:
        error = self.m.failure(python=None)
        self.assertIs(error.code, Code.NO_PYTHON)
        self.assertIn("pipx install 'visionset==0.0.1b4'", error.hint)

    def test_a_python_that_cannot_start_counts_as_missing(self) -> None:
        self.m.run.python(PYTHON, ProbeResult(None, error="Exec format error"))
        self.assertIs(self.m.failure().code, Code.NO_PYTHON)

    def test_only_old_pythons(self) -> None:
        self.m.run.python("/usr/bin/python3", probe_output((3, 10, 12)))
        self.m.run.python(PYTHON, probe_output((3, 9, 1)))
        error = self.m.failure()
        self.assertIs(error.code, Code.PYTHON_TOO_OLD)
        self.assertEqual(self.m.run.install_calls(), [])

    def test_a_new_python_without_venv_or_ensurepip(self) -> None:
        for venv, ensurepip in ((False, True), (True, False)):
            with self.subTest(venv=venv, ensurepip=ensurepip):
                self.m.run.python(PYTHON, probe_output((3, 12, 1), venv, ensurepip))
                self.m.run.python("/usr/bin/python3", probe_output((3, 8, 1)))
                error = self.m.failure()
                self.assertIs(error.code, Code.NO_VENV)
                self.assertIn("python3-venv", error.hint)

    def test_path_is_searched_newest_name_first_after_the_running_interpreter(self) -> None:
        self.m.run.python("/usr/bin/python3.11", probe_output((3, 11, 2)))
        self.m.run.python("/usr/bin/python3.13", probe_output((3, 13, 0)))
        self.m.run.python("/usr/bin/python3", probe_output((3, 13, 0)))
        self.m.run.python("/opt/old/python", probe_output((3, 10, 0)))
        self.m.bootstrap(python="/opt/old/python")
        probes = [call[0] for call in self.m.run.calls if "-c" in call and call[-1] != "import sys"]
        self.assertEqual(probes, ["/opt/old/python", "/usr/bin/python3.13"])
        self.assertTrue(self.m.runtimes()[0].startswith("0.0.1b4-py313-"))

    def test_creating_the_venv_fails(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.run.venv_result = ProbeResult(1, stderr=b"Error: ensurepip is not available")
        error = self.m.failure()
        self.assertIs(error.code, Code.NO_VENV)
        self.assertIn("ensurepip is not available", error.message)
        self.assert_nothing_published()

    def test_no_pip_in_the_new_environment(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.run.pip_version = ProbeResult(1, stderr=b"No module named pip")
        error = self.m.failure()
        self.assertIs(error.code, Code.NO_PIP)
        self.assertEqual(self.m.run.install_calls(), [])
        self.assert_nothing_published()

    def test_lock_timeout(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.locker.busy = True
        error = self.m.failure(lock_timeout=7.0)
        self.assertIs(error.code, Code.LOCK_TIMEOUT)
        self.assertEqual(self.m.locker.acquired[0][1], 7.0)
        self.assertEqual(self.m.run.install_calls(), [])

    def test_an_unreachable_index_is_retried_once_then_reported(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.run.installs = [UNREACHABLE, UNREACHABLE, OK]
        error = self.m.failure()
        self.assertIs(error.code, Code.INDEX_UNAVAILABLE)
        self.assertEqual(len(self.m.run.install_calls()), 2)
        self.assertEqual(self.m.clock.sleeps, [RETRY_DELAY])
        self.assertIn("PIP_FIND_LINKS", error.hint)
        self.assert_nothing_published()

    def test_one_transient_failure_is_absorbed(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.run.installs = [UNREACHABLE, OK]
        self.assertFalse(self.m.bootstrap().reused)
        self.assertEqual(len(self.m.run.install_calls()), 2)

    def test_a_resolution_failure_is_not_retried(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.run.installs = [
            ProbeResult(1, stderr=b"ERROR: No matching distribution found for visionset==0.0.1b4")
        ]
        error = self.m.failure()
        self.assertIs(error.code, Code.INSTALL_FAILED)
        self.assertEqual(len(self.m.run.install_calls()), 1)
        self.assertEqual(self.m.clock.sleeps, [])

    def test_a_hung_install_is_a_timeout(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.run.installs = [ProbeResult(None, timed_out=True)]
        error = self.m.failure()
        self.assertIs(error.code, Code.INSTALL_TIMEOUT)
        self.assertIn(f"{INSTALL_TIMEOUT:g} s", error.message)
        self.assert_nothing_published()

    def test_credentials_never_reach_the_error_or_the_log(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        failing = ProbeResult(
            1,
            stdout=f"Looking in indexes: {INDEX}\n".encode(),
            stderr=f"ERROR: 401 Client Error for url: {INDEX}/visionset/\n".encode(),
        )
        self.m.run.installs = [failing]
        error = self.m.failure()
        [log] = [p for p in self.m.disk.files if p.endswith(".log")]
        self.assertIn("<redacted>@pypi.example", self.m.disk.files[log])
        self.assertEqual(self.m.disk.modes[log], 0o600)
        for text in (str(error), self.m.disk.files[log], *self.m.progress):
            self.assertNotIn(SECRET, text)
            self.assertNotIn("alice", text)

    def test_credentials_never_reach_the_sentinel(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.bootstrap()
        for path, text in self.m.disk.files.items():
            if path.endswith(("ready.json", ".owner")):
                self.assertNotIn(SECRET, text)

    def test_an_installed_version_outside_the_range(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.run.version = ProbeResult(0, b"0.0.1b5\n")
        error = self.m.failure()
        self.assertIs(error.code, Code.INCOMPATIBLE_RESULT)
        self.assertIn("0.0.1b5", error.message)
        self.assert_nothing_published()

    def test_a_console_script_without_a_working_mcp(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.run.mcp = ProbeResult(2, stderr=b"No such command 'mcp'")
        self.assertIs(self.m.failure().code, Code.VALIDATION_FAILED)
        self.assert_nothing_published()

    def test_opting_out_creates_nothing(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        for value in ("1", "true", "yes"):
            with self.subTest(value=value):
                self.m.env[NO_BOOTSTRAP_ENV] = value
                error = self.m.failure()
                self.assertIs(error.code, Code.OPTED_OUT)
                self.assertIn("pipx install 'visionset==0.0.1b4'", error.hint)
                self.assertEqual(self.m.run.calls, [])
                self.assertEqual(self.m.disk.tree(DATA), [])

    def test_opting_out_with_a_false_value_does_not(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        for value in ("0", "false", "off", ""):
            with self.subTest(value=value):
                self.m.env[NO_BOOTSTRAP_ENV] = value
                self.m.bootstrap()

    def test_an_invalid_requirement_is_refused(self) -> None:
        bundles = [
            Bundle("visionset[cuda]", "visionset", COMPAT),
            Bundle("visionset", "visionset", ">=0.0.1"),
            Bundle("visionset", "visionset", "==0.0.1 --index-url http://x"),
        ]
        for bundle in bundles:
            with self.subTest(bundle=bundle), self.assertRaises(BootstrapError) as raised:
                run_bootstrap(
                    bundle, host=self.m.host(), fs=self.m.disk, run=self.m.run, plugin_root=None
                )
            self.assertIs(raised.exception.code, Code.INSTALL_FAILED)
        self.assertEqual(self.m.run.calls, [])


class DataRootTest(unittest.TestCase):
    def root(self, env: dict[str, str], **kwargs: Any) -> str:
        options: dict[str, Any] = {"windows": False, "home": HOME}
        options.update(kwargs)
        return data_root(Host(env=env, **options))

    def test_the_override_wins_then_the_client_directory(self) -> None:
        env = {DATA_ENV: "/ops/vs", "CLAUDE_PLUGIN_DATA": "/claude/data", "XDG_DATA_HOME": "/x"}
        self.assertEqual(self.root(env), "/ops/vs")
        del env[DATA_ENV]
        self.assertEqual(self.root(env), "/claude/data")
        del env["CLAUDE_PLUGIN_DATA"]
        self.assertEqual(self.root(env), "/x/visionset-agent-plugin")
        self.assertEqual(self.root({}), "/home/u/.local/share/visionset-agent-plugin")

    def test_relative_values(self) -> None:
        with self.assertRaises(BootstrapError) as raised:
            self.root({DATA_ENV: "rel/dir"})
        self.assertIs(raised.exception.code, Code.BAD_DATA_DIR)
        env = {"CLAUDE_PLUGIN_DATA": "rel", "XDG_DATA_HOME": "also-rel"}
        self.assertEqual(self.root(env), "/home/u/.local/share/visionset-agent-plugin")

    def test_macos(self) -> None:
        self.assertEqual(
            self.root({"XDG_DATA_HOME": "/x"}, home="/Users/u", macos=True),
            "/Users/u/Library/Application Support/visionset-agent-plugin",
        )

    def test_windows(self) -> None:
        env = {"LOCALAPPDATA": "C:\\Users\\u\\AppData\\Local"}
        self.assertEqual(
            self.root(env, windows=True, home="C:\\Users\\u"),
            "C:\\Users\\u\\AppData\\Local\\visionset-agent-plugin",
        )
        with self.assertRaises(BootstrapError):
            self.root({DATA_ENV: "\\no-drive"}, windows=True)

    def test_no_home_and_no_override(self) -> None:
        with self.assertRaises(BootstrapError) as raised:
            self.root({}, home=None)
        self.assertIs(raised.exception.code, Code.BAD_DATA_DIR)
        self.assertIn(DATA_ENV, raised.exception.hint)

    def test_a_data_root_inside_the_plugin_is_refused(self) -> None:
        m = Machine()
        m.run.python(PYTHON, probe_output((3, 12, 1)))
        m.env[DATA_ENV] = "/plugins/visionset/runtime/data"
        error = m.failure(plugin_root="/plugins/visionset")
        self.assertIs(error.code, Code.BAD_DATA_DIR)
        self.assertEqual(m.disk.tree("/plugins"), [])
        m.env[DATA_ENV] = "/plugins/visionset-data"
        m.bootstrap(plugin_root="/plugins/visionset")


class KeyTest(unittest.TestCase):
    def interpreter(self, executable: str = PYTHON, platform: str = "linux-x86_64") -> Interpreter:
        return Interpreter((executable,), (3, 12, 4), executable, "cpython", platform)

    def test_the_key_names_version_and_python_and_hashes_the_interpreter(self) -> None:
        key = runtime_key("0.0.1b4", self.interpreter())
        self.assertRegex(key, r"^0\.0\.1b4-py312-[0-9a-f]{8}$")
        self.assertEqual(key, runtime_key("0.0.1b4", self.interpreter()))
        self.assertNotEqual(key, runtime_key("0.0.1b4", self.interpreter("/opt/py/bin/python")))
        self.assertNotEqual(key, runtime_key("0.0.1b4", self.interpreter(platform="linux-arm")))
        self.assertNotIn("/", runtime_key("../../x", self.interpreter()))

    def test_windows_layout(self) -> None:
        lay = layout("C:\\data", "k", "visionset", True)
        self.assertEqual(lay.python, "C:\\data\\runtimes\\k\\venv\\Scripts\\python.exe")
        self.assertEqual(lay.console_script, "C:\\data\\runtimes\\k\\venv\\Scripts\\visionset.exe")
        self.assertEqual(lay.lock, "C:\\data\\locks\\k.lock")
        self.assertEqual(lay.log, "C:\\data\\logs\\k.log")

    def test_posix_layout_keeps_lock_and_log_outside_the_runtime(self) -> None:
        lay = layout("/d", "k", "visionset", False)
        self.assertEqual(lay.python, "/d/runtimes/k/venv/bin/python")
        self.assertFalse(lay.lock.startswith(lay.runtime))
        self.assertFalse(lay.log.startswith(lay.runtime))


class WindowsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.m = Machine(windows=True)
        self.m.env["PATH"] = "C:\\Windows;C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps"
        self.launcher = "C:\\Windows\\py.exe"

    def test_the_py_launcher_is_tried_newest_first_and_the_store_alias_is_refused(self) -> None:
        self.m.disk.put(self.launcher, executable=True)
        store = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe"
        self.m.run.python(store, probe_output((3, 12, 0)))
        launched: list[list[str]] = []
        original = self.m.run.__call__

        def run(argv: Sequence[str], *rest: Any) -> ProbeResult:
            if argv[0] == self.launcher and "-c" in argv:
                launched.append(list(argv[:2]))
                if argv[1] != "-3.12":
                    return ProbeResult(103, stderr=b"No suitable Python runtime found")
                return ProbeResult(0, probe_output((3, 12, 7)).encode())
            return original(argv, *rest)

        result = run_bootstrap(
            BUNDLE,
            host=self.m.host(),
            fs=self.m.disk,
            run=run,
            locker=self.m.locker,
            clock=self.m.clock,
            python=None,
            plugin_root=None,
            progress=self.m.progress.append,
        )
        self.assertEqual(
            launched, [[self.launcher, "-3.14"], [self.launcher, "-3.13"], [self.launcher, "-3.12"]]
        )
        self.assertNotIn(store, [call[0] for call in self.m.run.calls])
        self.assertTrue(result.console_script.endswith("\\venv\\Scripts\\visionset.exe"))
        venv_call = next(call for call in self.m.run.calls if "venv" in call)
        self.assertEqual(venv_call[:2], [self.launcher, "-3.12"])
        install = self.m.run.install_calls()[0]
        self.assertTrue(install[0].endswith("\\venv\\Scripts\\python.exe"))
        self.assertTrue(self.m.locker.acquired[0][0].startswith("C:\\data\\plugin\\locks\\"))

    def test_only_the_store_alias_means_no_python(self) -> None:
        store = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe"
        self.m.run.python(store, probe_output((3, 12, 0)))
        self.assertIs(self.m.failure(python=None).code, Code.NO_PYTHON)
        self.assertEqual(self.m.run.calls, [])

    def test_the_windows_lock_uses_msvcrt_byte_locking(self) -> None:
        calls: list[tuple[int, int]] = []
        refusals = {"left": 1}

        def locking(fd: int, mode: int, size: int) -> None:
            calls.append((mode, size))
            if mode == fake.LK_NBLCK and refusals["left"]:
                refusals["left"] -= 1
                raise OSError(36, "Resource deadlock avoided")

        fake = types.SimpleNamespace(LK_NBLCK=2, LK_UNLCK=0, locking=locking)
        clock = FakeClock()
        with (
            tempfile.TemporaryDirectory() as scratch,
            mock.patch.dict(sys.modules, {"msvcrt": fake}),
        ):
            lease = FileLocker(windows=True, clock=clock).acquire(
                os.path.join(scratch, "k.lock"), 5.0
            )
            assert lease is not None
            lease.release()
            refusals["left"] = 99
            self.assertIsNone(
                FileLocker(windows=True, clock=FakeClockStuck()).acquire(
                    os.path.join(scratch, "k.lock"), 1.0
                )
            )
        self.assertEqual(calls[:3], [(2, 1), (2, 1), (0, 1)])
        self.assertEqual(clock.sleeps, [0.1])


class FakeClockStuck(FakeClock):
    def sleep(self, seconds: float) -> None:
        self.t += 10


@unittest.skipIf(os.name == "nt", "flock")
class PosixLockTest(unittest.TestCase):
    def test_a_held_lock_times_out_and_a_released_one_is_taken(self) -> None:
        import fcntl

        with tempfile.TemporaryDirectory() as scratch:
            path = os.path.join(scratch, "k.lock")
            first = FileLocker(windows=False).acquire(path, 2.0)
            assert first is not None
            first.release()
            with open(path, "r+") as holder:
                fcntl.flock(holder, fcntl.LOCK_EX)
                clock = FakeClock()
                self.assertIsNone(FileLocker(windows=False, clock=clock).acquire(path, 2.0))
                self.assertGreaterEqual(clock.t - 1000.0, 2.0)
                fcntl.flock(holder, fcntl.LOCK_UN)
            lease = FileLocker(windows=False).acquire(path, 2.0)
            assert lease is not None
            self.assertIsNone(FileLocker(windows=False, clock=FakeClockStuck()).acquire(path, 0.1))
            lease.release()
            again = FileLocker(windows=False).acquire(path, 0.1)
            assert again is not None
            again.release()
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
