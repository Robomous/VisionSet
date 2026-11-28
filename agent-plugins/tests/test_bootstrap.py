"""Bootstrap decisions against an in-memory disk and a scripted runner."""

from __future__ import annotations

import contextlib
import gc
import io
import json
import ntpath
import os
import posixpath
import sys
import tempfile
import types
import unittest
import warnings
from collections.abc import Callable, Mapping, Sequence
from typing import Any
from unittest import mock

import _support  # noqa: F401  (puts the runtime on sys.path)
from bootstrap import (
    DATA_ENV,
    INSTALL_TIMEOUT,
    LOCK_TIMEOUT,
    MAX_GENERATIONS,
    NO_BOOTSTRAP_ENV,
    PIP_ENV_KEEP,
    RETRY_DELAY,
    VALIDATION_TIMEOUT,
    BootstrapError,
    Bootstrapped,
    Code,
    FileLocker,
    Interpreter,
    Lease,
    OsWritableFileSystem,
    cached_prefixes,
    data_root,
    layout,
    runtime_key,
)
from bootstrap import bootstrap as run_bootstrap
from discover import REASON_TAIL, Bundle, Host, ProbeResult, discover

COMPAT = "==0.0.1b4"
BUNDLE = Bundle("visionset", "visionset", COMPAT)
HOME = "/home/u"
DATA = "/data/plugin"
PYTHON = "/usr/bin/python3.12"
SECRET = "s3cr3t-pass-9"
PATH_TOKEN = "Zq8xTOKENp4yLm2Kd7"
QUERY_TOKEN = "Qw3rtyTOKEN99"
INDEX = f"https://alice:{SECRET}@pypi.example/{PATH_TOKEN}/simple?api_key={QUERY_TOKEN}"
LEASE_FD = 99
OK = ProbeResult(0)
UNREACHABLE = ProbeResult(
    1,
    stderr=(
        f"WARNING: Retrying after connection broken by 'NewConnectionError': {INDEX}/visionset/\n"
        "ERROR: No matching distribution found for visionset==0.0.1b4\n"
    ).encode(),
)
FORBIDDEN = ("--user", "--upgrade", "-U", "--pre", "--break-system-packages", "--target")
SECRETS = (SECRET, PATH_TOKEN, QUERY_TOKEN, "alice")
GENERATION = r"^0\.0\.1b4-py312-[0-9a-f]{8}-r{n}$"


def long_launcher(python: str) -> str:
    """pip's header for a long interpreter path without spaces: the path is not quoted."""
    quotes = "'" * 3
    return "#!/bin/sh\n" + quotes + "exec' " + python + ' "$0" "$@"\n\' ' + quotes + "\n"


def sh_launcher(python: str) -> str:
    """pip's console-script header for an interpreter path with spaces."""
    quotes = "'" * 3
    return f'#!/bin/sh\n{quotes}exec\' "{python}" "$0" "$@"\n\' {quotes}\n'


class FakeDisk:
    def __init__(self, windows: bool = False) -> None:
        self.pm: Any = ntpath if windows else posixpath
        self.files: dict[str, str] = {}
        self.dirs: set[str] = set()
        self.exes: set[str] = set()
        self.modes: dict[str, int] = {}
        self.writes: list[str] = []
        self.replaced: list[tuple[str, str]] = []
        self.unsafe: dict[str, str] = {}
        self.refuse_replace: set[str] = set()
        self.refuse_remove = False
        self.refuse_makedirs = False
        self.corrupt: set[str] = set()
        self.links: dict[str, str] = {}
        self.interrupt_after_publish = False

    def k(self, path: str) -> str:
        return str(self.pm.normcase(self.pm.normpath(path)))

    def put(self, path: str, text: str = "", executable: bool = False) -> None:
        self._mkdirs(self.pm.dirname(path))
        self.files[self.k(path)] = text
        if executable:
            self.exes.add(self.k(path))

    def _under(self, key: str, prefix: str) -> bool:
        return key == prefix or key.startswith((prefix + "\\", prefix + "/"))

    def lexists(self, path: str) -> bool:
        return self.k(path) in self.files or self.k(path) in self.dirs

    def is_file(self, path: str) -> bool:
        return self.k(path) in self.files

    def is_dir(self, path: str) -> bool:
        return self.k(path) in self.dirs

    def is_executable(self, path: str) -> bool:
        return self.k(path) in self.exes

    def realpath(self, path: str) -> str:
        key = self.k(path)
        for link, target in self.links.items():
            if self._under(key, link):
                return str(self.pm.normpath(target + key[len(link) :]))
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

    def _mkdirs(self, path: str) -> None:
        while path and self.k(path) not in self.dirs:
            self.dirs.add(self.k(path))
            parent = self.pm.dirname(path)
            if parent == path:
                break
            path = parent

    def makedirs(self, path: str) -> None:
        if self.refuse_makedirs:
            raise PermissionError(13, "Permission denied")
        self._mkdirs(path)

    def read_text(self, path: str) -> str | None:
        return self.files.get(self.k(path))

    def write_new(self, path: str, text: str) -> None:
        self.writes.append(self.k(path))
        if any(self.k(path).endswith(suffix) for suffix in self.corrupt):
            text = text[: len(text) // 2]
        self.put(path, text)

    def replace(self, source: str, target: str) -> None:
        if any(self.k(source).endswith(name) for name in self.refuse_replace):
            raise PermissionError(13, "The process cannot access the file")
        src, dst = self.k(source), self.k(target)
        self.replaced.append((src, dst))
        moved = {k: v for k, v in self.files.items() if self._under(k, src)}
        for key, value in moved.items():
            del self.files[key]
            self.files[dst + key[len(src) :]] = value
        for store in ("dirs", "exes"):
            current: set[str] = getattr(self, store)
            keep = {key for key in current if not self._under(key, src)}
            keep |= {dst + key[len(src) :] for key in current if self._under(key, src)}
            setattr(self, store, keep)
        if self.interrupt_after_publish and dst.endswith("ready.json"):
            raise KeyboardInterrupt

    def remove_tree(self, path: str) -> None:
        if self.refuse_remove:
            raise PermissionError(13, "Access is denied")
        prefix = self.k(path)
        self.files = {k: v for k, v in self.files.items() if not self._under(k, prefix)}
        self.dirs = {k for k in self.dirs if not self._under(k, prefix)}
        self.exes = {k for k in self.exes if not self._under(k, prefix)}

    def append_private(self, path: str, text: str) -> None:
        self.put(path, self.files.get(self.k(path), "") + text)
        self.modes[self.k(path)] = 0o600

    def unsafe_reason(self, path: str) -> str | None:
        return self.unsafe.get(self.k(path))

    def tree(self, root: str) -> list[str]:
        prefix = self.k(root)
        return sorted(key for key in (*self.files, *self.dirs) if self._under(key, prefix))


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

    @property
    def fd(self) -> int | None:
        return LEASE_FD

    def release(self) -> None:
        self.locker.released += 1


class FakeLocker:
    def __init__(self) -> None:
        self.busy = False
        self.broken = False
        self.held: set[str] = set()
        self.acquired: list[tuple[str, float]] = []
        self.released = 0
        self.on_acquire: Callable[[], None] | None = None

    def acquire(self, path: str, timeout: float) -> Lease | None:
        self.acquired.append((path, timeout))
        if self.broken:
            raise OSError(40, "Too many levels of symbolic links")
        if self.busy or path in self.held:
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

    def __init__(self, disk: FakeDisk, clock: FakeClock, windows: bool = False) -> None:
        self.disk = disk
        self.clock = clock
        self.windows = windows
        self.pythons: dict[str, ProbeResult] = {}
        self.venv_result = OK
        self.venv_seconds = 0.0
        self.pip_version = ProbeResult(0, b"pip 24.0\n")
        self.pip_config = ProbeResult(0, b"")
        self.installs: list[ProbeResult] = []
        self.versions: list[ProbeResult] = []
        self.bad: dict[str, ProbeResult] = {}
        self.version = ProbeResult(0, b"0.0.1b4\n")
        self.mcp = ProbeResult(0, b"usage")
        self.calls: list[list[str]] = []
        self.envs: list[dict[str, str]] = []
        self.timeouts: list[float] = []
        self.fds: list[tuple[int, ...]] = []
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
        self,
        argv: Sequence[str],
        cwd: str,
        env: Mapping[str, str],
        timeout: float,
        cap: int,
        *,
        pass_fds: Sequence[int] = (),
    ) -> ProbeResult:
        argv = list(argv)
        self.calls.append(argv)
        self.envs.append(dict(env))
        self.timeouts.append(timeout)
        self.fds.append(tuple(pass_fds))
        building = [k for k in self.disk.files if k.endswith(".owner")]
        published = [k for k in self.disk.files if k.endswith("ready.json")]
        writing = "install" in argv or "venv" in argv
        if building and len(published) >= len(building) and writing and "-c" not in argv:
            self.published_early.append(argv)
        if "-c" in argv:
            return self.pythons[self.disk.k(argv[0])]
        if argv[-2:-1] == ["venv"]:
            self.clock.t += self.venv_seconds
            if self.venv_result.returncode == 0:
                scripts = self.disk.pm.join(argv[-1], "Scripts" if self.windows else "bin")
                suffix = ".exe" if self.windows else ""
                self.disk.put(self.disk.pm.join(scripts, "python" + suffix), executable=True)
            return self.venv_result
        if argv[-2:] == ["pip", "--version"]:
            return self.pip_version
        if argv[-2:] == ["config", "list"]:
            return self.pip_config
        if "install" in argv:
            result = self.installs.pop(0) if self.installs else OK
            if result.returncode == 0 and not result.overflow:
                scripts = self.disk.pm.dirname(argv[0])
                name = "visionset.exe" if self.windows else "visionset"
                header = f"#!{argv[0]}\nimport sys\n"
                self.disk.put(self.disk.pm.join(scripts, name), header, executable=True)
            return result
        if argv[1:] == ["--version"]:
            if self.disk.k(argv[0]) in self.bad:
                return self.bad[self.disk.k(argv[0])]
            return self.versions.pop(0) if self.versions else self.version
        if argv[1:] == ["mcp", "--help"]:
            return self.mcp
        raise AssertionError(f"unexpected argv {argv}")


class Machine:
    def __init__(self, windows: bool = False, macos: bool = False) -> None:
        self.windows = windows
        self.disk = FakeDisk(windows)
        self.clock = FakeClock()
        self.run = FakeRunner(self.disk, self.clock, windows)
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

    def generation(self, name: str) -> Any:
        return layout(self.env[DATA_ENV], name, "visionset", self.windows)


def assert_safe_argv(case: unittest.TestCase, calls: list[list[str]]) -> None:
    for argv in calls:
        case.assertNotIn(posixpath.basename(argv[0]), ("sudo", "doas", "su", "runas"))
        for flag in FORBIDDEN:
            case.assertNotIn(flag, argv)
        if "install" in argv:
            case.assertEqual(argv[-1], "visionset==0.0.1b4")
            case.assertIn("--no-user", argv)
        for secret in SECRETS:
            case.assertFalse(any(secret in part for part in argv))


class BuildTest(unittest.TestCase):
    def setUp(self) -> None:
        self.m = Machine()
        self.m.run.python(PYTHON, probe_output((3, 12, 4)))

    def tearDown(self) -> None:
        assert_safe_argv(self, self.m.run.calls)

    def built(self) -> Any:
        [name] = self.m.runtimes()
        return self.m.generation(name)

    def test_a_clean_build_publishes_generation_one_after_validation(self) -> None:
        result = self.m.bootstrap()
        self.assertFalse(result.reused)
        self.assertEqual(result.version, "0.0.1b4")
        lay = self.built()
        self.assertRegex(lay.key, GENERATION.replace("{n}", "1"))
        self.assertEqual((result.prefix, result.console_script), (lay.venv, lay.console_script))
        sentinel = json.loads(self.m.disk.files[lay.ready])
        self.assertEqual(sentinel["key"], lay.key)
        self.assertEqual(sentinel["console_script"], "venv/bin/visionset")
        marker = json.loads(self.m.disk.files[lay.owner])
        self.assertEqual((marker["base"], marker["key"]), (lay.base, lay.key))
        self.assertNotIn(lay.ready, self.m.disk.writes)
        self.assertNotIn(lay.owner, self.m.disk.writes)
        self.assertEqual(
            self.m.disk.replaced,
            [(lay.owner + ".tmp", lay.owner), (lay.ready + ".tmp", lay.ready)],
        )
        self.assertEqual(self.m.locker.acquired, [(DATA + f"/locks/{lay.base}.lock", LOCK_TIMEOUT)])
        self.assertEqual(self.m.locker.released, 1)
        self.assertEqual(self.m.run.published_early, [])

    def test_steps_run_in_order_with_the_exact_pip_command(self) -> None:
        self.m.bootstrap()
        lay = self.built()
        steps = [call for call in self.m.run.calls if "-c" not in call]
        self.assertEqual(
            steps,
            [
                [PYTHON, "-I", "-m", "venv", lay.venv],
                [lay.python, "-I", "-m", "pip", "--version"],
                [lay.python, "-I", "-m", "pip", "config", "list"],
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
                    "--no-user",
                    "visionset==0.0.1b4",
                ],
                [lay.console_script, "--version"],
                [lay.console_script, "mcp", "--help"],
            ],
        )

    def test_only_allow_listed_pip_variables_reach_any_process(self) -> None:
        dropped = [
            "PIP_REQUIREMENT",
            "PIP_CONSTRAINT",
            "PIP_NO_BINARY",
            "PIP_ONLY_BINARY",
            "PIP_NO_BUILD_ISOLATION",
            "PIP_CONFIG_SETTINGS",
            "PIP_DRY_RUN",
            "PIP_PREFIX",
            "PIP_ROOT",
            "PIP_TARGET",
            "PIP_USER",
            "PIP_BREAK_SYSTEM_PACKAGES",
            "PIP_REQUIRE_VIRTUALENV",
            "PIP_EDITABLE",
            "PIP_SOME_FUTURE_OPTION",
            "PYTHONUSERBASE",
            "PYTHONSTARTUP",
        ]
        for name in [*dropped, *PIP_ENV_KEEP]:
            self.m.env.setdefault(name, "value-of-" + name)
        self.m.bootstrap()
        for env in self.m.run.envs:
            self.assertEqual({k for k in env if k.startswith("PIP_")}, set(PIP_ENV_KEEP))
            for name in dropped:
                self.assertNotIn(name, env)
            self.assertNotIn("PYTHONPATH", env)
            self.assertNotIn("PYTHONHOME", env)
        self.assertEqual(self.m.run.envs[-1]["PIP_INDEX_URL"], INDEX)
        for name in ("PIP_INDEX_URL", "PIP_FIND_LINKS", "PIP_DEFAULT_TIMEOUT", "PIP_USE_FEATURE"):
            self.assertIn(name, self.m.run.envs[-1])

    def test_every_writing_step_inherits_the_lock_and_no_probe_does(self) -> None:
        self.m.bootstrap()
        for call, fds in zip(self.m.run.calls, self.m.run.fds, strict=True):
            writes = "-m" in call and ("venv" in call or "pip" in call)
            self.assertEqual(fds, (LEASE_FD,) if writes else (), call)

    def test_venv_and_install_share_one_deadline(self) -> None:
        self.m.run.venv_seconds = 100.0
        self.m.bootstrap(install_timeout=120.0)
        index = self.m.run.calls.index(self.m.run.install_calls()[0])
        self.assertLessEqual(self.m.run.timeouts[index], 20.0)
        self.assertGreater(self.m.run.timeouts[index], 0)

    def test_a_deadline_spent_before_the_install_is_a_timeout(self) -> None:
        self.m.run.venv_seconds = 130.0
        error = self.m.failure(install_timeout=120.0)
        self.assertIs(error.code, Code.INSTALL_TIMEOUT)
        self.assertEqual(self.m.run.install_calls(), [])

    def test_a_ready_runtime_is_reused_without_the_lock_or_pip(self) -> None:
        first = self.m.bootstrap()
        self.m.run.calls.clear()
        second = self.m.bootstrap()
        self.assertTrue(second.reused)
        self.assertEqual(second.prefix, first.prefix)
        self.assertEqual(self.m.run.install_calls(), [])
        self.assertEqual(len(self.m.locker.acquired), 1)
        self.assertIn([first.console_script, "mcp", "--help"], self.m.run.calls)

    def test_a_runtime_published_while_waiting_for_the_lock_is_reused(self) -> None:
        other = Machine()
        other.disk = self.m.disk
        other.run = FakeRunner(self.m.disk, other.clock)
        other.run.pythons = self.m.run.pythons

        def publish_meanwhile() -> None:
            other.bootstrap()

        self.m.locker.on_acquire = publish_meanwhile
        result = self.m.bootstrap()
        self.assertTrue(result.reused)
        self.assertEqual(len(other.run.install_calls()), 1)
        self.assertEqual(self.m.run.install_calls(), [])

    def test_a_broken_runtime_is_superseded_by_a_new_generation_beside_it(self) -> None:
        first = self.m.bootstrap()
        old = self.built()
        before = self.m.disk.tree(old.runtime)
        newest = first
        for broken in (
            ProbeResult(1, stderr=b"ModuleNotFoundError: No module named 'visionset'"),
            ProbeResult(0, b"0.0.1b2\n"),
        ):
            with self.subTest(broken=broken):
                self.m.run.bad[self.m.disk.k(newest.console_script)] = broken
                result = self.m.bootstrap()
                newest = result
                self.assertFalse(result.reused)
                self.assertNotEqual(result.prefix, first.prefix)
                self.assertEqual(self.m.disk.tree(old.runtime), before)
                listed = cached_prefixes(host=self.m.host(), fs=self.m.disk)
                self.assertEqual(listed[0], result.prefix)
        names = self.m.runtimes()
        self.assertEqual([n[-3:] for n in names], ["-r1", "-r2", "-r3"])

    def test_a_runtime_whose_interpreter_vanished_is_superseded(self) -> None:
        self.m.bootstrap()
        old = self.built()
        del self.m.disk.files[self.m.disk.k(old.python)]
        self.assertFalse(self.m.bootstrap().reused)
        self.assertIn(old.key, self.m.runtimes())

    def test_a_transient_failure_never_supersedes_a_published_runtime(self) -> None:
        first = self.m.bootstrap()
        for flaky in (
            ProbeResult(None, error="Resource temporarily unavailable"),
            ProbeResult(None, error="Too many open files"),
            ProbeResult(None, timed_out=True),
        ):
            with self.subTest(flaky=flaky):
                self.m.run.bad[self.m.disk.k(first.console_script)] = flaky
                result = self.m.bootstrap()
                self.assertTrue(result.reused)
                self.assertEqual(result.prefix, first.prefix)
        self.assertEqual(len(self.m.run.install_calls()), 1)
        self.assertEqual(len(self.m.runtimes()), 1)

    def test_one_failed_check_that_passes_on_retry_is_not_a_broken_runtime(self) -> None:
        self.m.bootstrap()
        self.m.run.versions = [ProbeResult(1)]
        self.assertTrue(self.m.bootstrap().reused)
        self.assertEqual(len(self.m.run.install_calls()), 1)
        self.assertEqual(len(self.m.locker.acquired), 1)
        self.assertFalse(any("no longer works" in line for line in self.m.progress))

    def test_an_incomplete_owned_generation_is_moved_aside_and_removed(self) -> None:
        self.m.bootstrap()
        old = self.built()
        del self.m.disk.files[self.m.disk.k(old.ready)]
        self.m.disk.put(old.venv + "/half-written")
        result = self.m.bootstrap()
        self.assertEqual(result.prefix, old.venv)
        self.assertNotIn(self.m.disk.k(old.venv + "/half-written"), self.m.disk.files)
        self.assertIn(self.m.disk.k(old.ready), self.m.disk.files)
        self.assertEqual([n for n in self.m.runtimes() if n.startswith(".trash")], [])
        moved = [dst for src, dst in self.m.disk.replaced if src == self.m.disk.k(old.runtime)]
        self.assertEqual(len(moved), 1)
        self.assertIn("/.trash-", moved[0])

    def test_a_generation_killed_before_its_marker_is_recovered(self) -> None:
        self.m.bootstrap()
        old = self.built()
        leftovers: tuple[dict[str, str], ...] = (
            {},
            {".owner": ""},
            {".owner": "{"},
            {".owner.tmp": '{"own'},
            {"venv/bin/python": "", "venv/pyvenv.cfg": "home = /usr/bin"},
        )
        for leftover in leftovers:
            with self.subTest(leftover=leftover):
                for name in self.m.runtimes():
                    self.m.disk.remove_tree(self.m.generation(name).runtime)
                self.m.disk.makedirs(old.runtime)
                for name, text in leftover.items():
                    self.m.disk.put(old.runtime + "/" + name, text)
                self.assertEqual(self.m.bootstrap().prefix, old.venv)
                marker = json.loads(self.m.disk.files[self.m.disk.k(old.owner)])
                self.assertEqual(marker["key"], old.key)
                self.assertNotIn(self.m.disk.k(old.owner + ".tmp"), self.m.disk.files)
                self.assertIn(self.m.disk.k(old.ready), self.m.disk.files)

    def test_a_directory_this_plugin_does_not_own_is_never_touched(self) -> None:
        self.m.bootstrap()
        old = self.built()
        foreign = [
            {".owner": "", "venv/x": "data", "notes.txt": "mine"},
            {"notes.txt": "mine"},
            {".owner": json.dumps({"owner": "visionset-agent-plugin", "base": "x", "key": "y"})},
        ]
        for contents in foreign:
            with self.subTest(contents=contents):
                self.m.disk.remove_tree(old.runtime)
                for name, text in contents.items():
                    self.m.disk.put(old.runtime + "/" + name, text)
                before = self.m.disk.tree(old.runtime)
                result = self.m.bootstrap()
                self.assertEqual(self.m.disk.tree(old.runtime), before)
                self.assertNotIn(old.key, result.prefix)
                for name in self.m.runtimes():
                    if name != old.key and not name.startswith("."):
                        self.m.disk.remove_tree(self.m.generation(name).runtime)

    def test_a_directory_that_cannot_be_moved_aside_fails_and_stays_recoverable(self) -> None:
        self.m.bootstrap()
        old = self.built()
        del self.m.disk.files[self.m.disk.k(old.ready)]
        self.m.disk.refuse_replace = {old.key}
        error = self.m.failure()
        self.assertIs(error.code, Code.CLEANUP_FAILED)
        self.assertIn(self.m.disk.k(old.owner), self.m.disk.files)
        self.m.disk.refuse_replace = set()
        self.assertEqual(self.m.bootstrap().prefix, old.venv)
        self.assertIn(self.m.disk.k(old.ready), self.m.disk.files)

    def test_trash_that_cannot_be_removed_is_retried_by_a_later_setup(self) -> None:
        self.m.bootstrap()
        old = self.built()
        del self.m.disk.files[self.m.disk.k(old.ready)]
        self.m.disk.refuse_remove = True
        self.m.bootstrap()
        [trash] = [n for n in self.m.runtimes() if n.startswith(".trash-")]
        self.assertTrue(any("retries" in line for line in self.m.progress))
        self.m.disk.refuse_remove = False
        del self.m.disk.files[self.m.disk.k(old.ready)]
        self.m.bootstrap()
        self.assertNotIn(trash, self.m.runtimes())

    def test_cached_prefixes_lists_published_generations_newest_first(self) -> None:
        self.m.bootstrap()
        self.m.run.python("/usr/bin/python3.13", probe_output((3, 13, 1)))
        self.m.clock.t += 60
        newer = self.m.bootstrap(python="/usr/bin/python3.13")
        listed = cached_prefixes(host=self.m.host(), fs=self.m.disk)
        self.assertEqual(len(listed), 2)
        self.assertEqual(listed[0], newer.prefix)
        [name] = [n for n in self.m.runtimes() if "py312" in n]
        del self.m.disk.files[self.m.disk.k(self.m.generation(name).ready)]
        self.assertEqual(cached_prefixes(host=self.m.host(), fs=self.m.disk), [newer.prefix])

    def test_a_sentinel_naming_a_console_script_elsewhere_is_not_trusted(self) -> None:
        self.m.bootstrap()
        old = self.built()
        sentinel = json.loads(self.m.disk.files[self.m.disk.k(old.ready)])
        sentinel["console_script"] = "/usr/bin/evil"
        self.m.disk.files[self.m.disk.k(old.ready)] = json.dumps(sentinel)
        self.assertEqual(cached_prefixes(host=self.m.host(), fs=self.m.disk), [])
        result = self.m.bootstrap()
        self.assertFalse(result.reused)
        self.assertNotIn([("/usr/bin/evil"), "--version"], self.m.run.calls)

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

    def test_a_sentinel_that_does_not_read_back_is_not_published(self) -> None:
        self.m.disk.corrupt = {"ready.json.tmp"}
        error = self.m.failure()
        self.assertIs(error.code, Code.VALIDATION_FAILED)
        self.assertEqual(cached_prefixes(host=self.m.host(), fs=self.m.disk), [])
        self.assertEqual([n for n in self.m.runtimes() if not n.startswith(".")], [])

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

    def test_the_lock_wait_outlasts_a_whole_build(self) -> None:
        self.assertGreaterEqual(LOCK_TIMEOUT, INSTALL_TIMEOUT + 4 * VALIDATION_TIMEOUT)

    def test_a_generation_with_any_ready_file_is_never_removed(self) -> None:
        self.m.bootstrap()
        old = self.built()
        kept = [
            "not json",
            json.dumps({"schema": 99, "key": old.key}),
            json.dumps({"schema": 3, "key": old.key, "console_script": "/elsewhere/visionset"}),
        ]
        for text in kept:
            with self.subTest(text=text):
                self.m.disk.files[self.m.disk.k(old.ready)] = text
                before = self.m.disk.tree(old.runtime)
                self.m.progress.clear()
                result = self.m.bootstrap()
                self.assertFalse(result.reused)
                self.assertNotEqual(result.prefix, old.venv)
                self.assertEqual(self.m.disk.tree(old.runtime), before)
                self.assertFalse(any("incomplete" in line for line in self.m.progress))
                for name in self.m.runtimes():
                    if name != old.key:
                        self.m.disk.remove_tree(self.m.generation(name).runtime)

    def test_a_console_script_that_resolves_outside_its_generation_is_not_used(self) -> None:
        self.m.bootstrap()
        old = self.built()
        self.m.disk.links = {self.m.disk.k(old.venv + "/bin"): "/elsewhere/bin"}
        before = self.m.disk.tree(old.runtime)
        result = self.m.bootstrap()
        self.assertTrue(result.prefix.endswith("-r2/venv"))
        self.assertEqual(self.m.disk.tree(old.runtime), before)

    def test_an_interrupt_right_after_publishing_keeps_the_runtime(self) -> None:
        self.m.disk.interrupt_after_publish = True
        with self.assertRaises(KeyboardInterrupt):
            self.m.bootstrap()
        lay = self.built()
        self.assertIn(self.m.disk.k(lay.ready), self.m.disk.files)
        self.m.disk.interrupt_after_publish = False
        installs = len(self.m.run.install_calls())
        self.assertTrue(self.m.bootstrap().reused)
        self.assertEqual(len(self.m.run.install_calls()), installs)

    def test_a_generation_that_was_moved_cannot_start_and_is_superseded(self) -> None:
        self.m.bootstrap()
        old = self.built()
        script = self.m.disk.k(old.console_script)
        outside = "/usr/bin/python3.12"
        headers = [
            "#!/old/root/runtimes/x-r1/venv/bin/python\n",
            f"#!{old.venv}/bin/python-missing\n",
            f"#!{outside}\n",
            sh_launcher("/gone/plugin data/venv/bin/python"),
            "#!/bin/sh\necho no launcher\n",
            "no shebang\n",
        ]
        for header in headers:
            with self.subTest(header=header):
                self.m.disk.files[script] = header
                before = self.m.disk.tree(old.runtime)
                result = self.m.bootstrap()
                self.assertFalse(result.reused)
                self.assertEqual(self.m.disk.tree(old.runtime), before)
                for name in self.m.runtimes():
                    if name != old.key:
                        self.m.disk.remove_tree(self.m.generation(name).runtime)

    def test_the_space_safe_launcher_naming_this_generation_is_reused(self) -> None:
        self.m.bootstrap()
        old = self.built()
        for header in (sh_launcher(old.python), long_launcher(old.python)):
            with self.subTest(header=header):
                self.m.disk.files[self.m.disk.k(old.console_script)] = header
                self.assertTrue(self.m.bootstrap().reused)
        self.m.disk.files[self.m.disk.k(old.console_script)] = long_launcher("/gone/venv/bin/py")
        self.assertFalse(self.m.bootstrap().reused)

    def test_an_older_generation_that_still_works_is_reused_before_building(self) -> None:
        first = self.m.bootstrap()
        self.m.run.bad[self.m.disk.k(first.console_script)] = ProbeResult(1)
        second = self.m.bootstrap()
        self.assertNotEqual(second.prefix, first.prefix)
        del self.m.run.bad[self.m.disk.k(first.console_script)]
        self.m.run.bad[self.m.disk.k(second.console_script)] = ProbeResult(1)
        installs = len(self.m.run.install_calls())
        third = self.m.bootstrap()
        self.assertTrue(third.reused)
        self.assertEqual(third.prefix, first.prefix)
        self.assertEqual(len(self.m.run.install_calls()), installs)

    def test_a_marker_for_another_generation_of_the_same_base_is_not_ownership(self) -> None:
        self.m.bootstrap()
        old = self.built()
        self.m.disk.remove_tree(old.runtime)
        marker = {"owner": "visionset-agent-plugin", "base": old.base, "key": old.base + "-r7"}
        self.m.disk.put(old.owner, json.dumps(marker))
        self.m.disk.put(old.venv + "/bin/python")
        before = self.m.disk.tree(old.runtime)
        self.assertTrue(self.m.bootstrap().prefix.endswith("-r2/venv"))
        self.assertEqual(self.m.disk.tree(old.runtime), before)

    def test_leftovers_of_other_versions_are_cleared_only_under_their_free_lock(self) -> None:
        other = "0.0.1b3-py312-deadbeef"
        runtimes = DATA + "/runtimes/"

        def leave(name: str, ready: bool = False) -> str:
            path = runtimes + name
            marker = {"owner": "visionset-agent-plugin", "base": other, "key": name}
            self.m.disk.put(path + "/.owner", json.dumps(marker))
            self.m.disk.put(path + "/venv/bin/python")
            if ready:
                self.m.disk.put(path + "/ready.json", "{}")
            return path

        incomplete = leave(other + "-r1")
        published = leave(other + "-r2", ready=True)
        trash = leave(f".trash-{other}-0123456789ab")
        kept_trash = leave(f".trash-{other}-ba9876543210", ready=True)
        self.m.bootstrap()
        self.assertNotEqual(self.m.disk.tree(kept_trash), [])
        self.assertEqual(self.m.disk.tree(incomplete), [])
        self.assertEqual(self.m.disk.tree(trash), [])
        self.assertNotEqual(self.m.disk.tree(published), [])

        self.m.locker.held = {DATA + f"/locks/{other}.lock"}
        incomplete = leave(other + "-r3")
        for name in self.m.runtimes():
            if name.startswith("0.0.1b4"):
                self.m.disk.remove_tree(self.m.generation(name).runtime)
        self.m.bootstrap()
        self.assertNotEqual(self.m.disk.tree(incomplete), [])

    def test_generations_stop_at_the_cap_instead_of_reinstalling_forever(self) -> None:
        for number in range(1, MAX_GENERATIONS + 1):
            result = self.m.bootstrap()
            self.assertTrue(result.prefix.endswith(f"-r{number}/venv"))
            self.m.run.bad[self.m.disk.k(result.console_script)] = ProbeResult(1)
        installs = len(self.m.run.install_calls())
        error = self.m.failure()
        self.assertIs(error.code, Code.GENERATIONS_EXHAUSTED)
        self.assertIn("remove every superseded runtime", error.hint)
        self.assertEqual(len(self.m.run.install_calls()), installs)
        self.assertEqual(len(self.m.runtimes()), MAX_GENERATIONS)
        for name in self.m.runtimes()[:-1]:
            self.m.disk.remove_tree(self.m.generation(name).runtime)
        result = self.m.bootstrap()
        self.assertTrue(result.prefix.endswith(f"-r{MAX_GENERATIONS + 1}/venv"))

    def test_a_progress_sink_that_breaks_does_not_fail_setup(self) -> None:
        def broken(_: str) -> None:
            raise BrokenPipeError(32, "Broken pipe")

        result = run_bootstrap(
            BUNDLE,
            host=self.m.host(),
            fs=self.m.disk,
            run=self.m.run,
            locker=self.m.locker,
            clock=self.m.clock,
            python=PYTHON,
            plugin_root=None,
            progress=broken,
        )
        self.assertFalse(result.reused)


class FailureTest(unittest.TestCase):
    def setUp(self) -> None:
        self.m = Machine()

    def tearDown(self) -> None:
        assert_safe_argv(self, self.m.run.calls)

    def assert_nothing_published(self) -> None:
        for name in self.m.runtimes():
            self.fail(f"{name} was left behind")

    def assert_no_secret(self, *texts: str) -> None:
        for text in texts:
            for secret in SECRETS:
                self.assertNotIn(secret, text)

    def log(self) -> str:
        [log] = [p for p in self.m.disk.files if p.endswith(".log")]
        return self.m.disk.files[log]

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
        probes = [call[0] for call in self.m.run.calls if "-c" in call]
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

    def test_pip_configuration_that_moves_the_install_is_refused_before_installing(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        for line in (
            "install.target='/tmp/elsewhere'",
            "global.prefix='/opt/x'",
            "install.root='/'",
            "install.user='true'",
            "install.requirement='/tmp/extra.txt'",
            "global.dry-run='yes'",
        ):
            with self.subTest(line=line):
                self.m.run.pip_config = ProbeResult(0, (line + "\n").encode())
                error = self.m.failure()
                self.assertIs(error.code, Code.BAD_PIP_CONFIG)
                self.assertIn(line.split("=")[0], error.message)
                self.assertEqual(self.m.run.install_calls(), [])
                self.assert_nothing_published()

    def test_harmless_pip_configuration_is_honoured(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        config = "install.user='false'\nglobal.only-binary=':all:'\nglobal.timeout='30'\n"
        self.m.run.pip_config = ProbeResult(0, config.encode())
        self.assertFalse(self.m.bootstrap().reused)

    def test_index_values_from_pip_configuration_are_redacted(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        del self.m.env["PIP_INDEX_URL"]
        token = "Cf9TOKENpathSegment"
        url = f"https://mirror.example/{token}/simple"
        self.m.run.pip_config = ProbeResult(0, f"global.index-url='{url}'\n".encode())
        self.m.run.installs = [ProbeResult(1, stderr=f"ERROR: 403 for url: {url}".encode())]
        error = self.m.failure()
        for text in (str(error), self.log()):
            self.assertNotIn(token, text)

    def test_pip_configuration_values_in_either_quote_style_are_read(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.run.pip_config = ProbeResult(0, b'install.target="/tmp/out\'side"\n')
        error = self.m.failure()
        self.assertIs(error.code, Code.BAD_PIP_CONFIG)
        self.assertEqual(self.m.run.install_calls(), [])

    def test_unreadable_pip_configuration_fails_closed(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        for result in (
            ProbeResult(1, stderr=b"ERROR: bad config"),
            ProbeResult(None, timed_out=True),
            ProbeResult(None, error="Resource temporarily unavailable"),
            ProbeResult(0, b"install.target=<unparsable>\n"),
            ProbeResult(0, b"x" * 64, overflow=True),
        ):
            with self.subTest(result=result):
                self.m.run.pip_config = result
                self.assertIs(self.m.failure().code, Code.BAD_PIP_CONFIG)
                self.assertEqual(self.m.run.install_calls(), [])
                self.assert_nothing_published()

    def test_only_sections_pip_install_reads_can_refuse(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        config = "freeze.user='yes'\nlist.user='true'\ndownload.prefix='/x'\n"
        self.m.run.pip_config = ProbeResult(0, config.encode())
        self.assertFalse(self.m.bootstrap().reused)
        for line in (":env:.target='/x'", "global.user='1'"):
            with self.subTest(line=line):
                self.m.run.pip_config = ProbeResult(0, (line + "\n").encode())
                for name in self.m.runtimes():
                    self.m.disk.remove_tree(self.m.generation(name).runtime)
                self.assertIs(self.m.failure().code, Code.BAD_PIP_CONFIG)

    def test_every_mirror_of_a_multi_line_extra_index_is_redacted(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        first, second = "TOKENAAAA11", "Qx7z"
        # The short query secret comes first: only splitting the value learns it on its own.
        value = f"\\nhttp://m1.example/simple?sig={second}\\nhttp://m2.example/{first}/simple"
        self.m.run.pip_config = ProbeResult(0, f"global.extra-index-url='{value}'\n".encode())
        output = f"ERROR: 403 /{first}/simple and http://m2.example/simple?sig={second}"
        self.m.run.installs = [ProbeResult(1, stderr=output.encode())]
        error = self.m.failure()
        for text in (str(error), self.log()):
            self.assertNotIn(first, text)
            self.assertNotIn(second, text)
        self.assertIn("<redacted>", self.log())

    def test_a_pip_configuration_pip_cannot_load_is_a_configuration_error(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.run.pip_version = ProbeResult(
            2, b"Configuration file could not be loaded.\nFile contains no section headers."
        )
        self.assertIs(self.m.failure().code, Code.BAD_PIP_CONFIG)
        self.m.run.pip_version = ProbeResult(1, stderr=b"No module named pip")
        self.assertIs(self.m.failure().code, Code.NO_PIP)

    def test_lock_timeout(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.locker.busy = True
        error = self.m.failure(lock_timeout=7.0)
        self.assertIs(error.code, Code.LOCK_TIMEOUT)
        self.assertEqual(self.m.locker.acquired[0][1], 7.0)
        self.assertEqual(self.m.run.install_calls(), [])

    def test_a_lock_that_cannot_be_opened_is_a_data_directory_problem(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.locker.broken = True
        self.assertIs(self.m.failure().code, Code.BAD_DATA_DIR)

    def test_an_unreachable_index_is_retried_exactly_once_then_reported(self) -> None:
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

    def test_output_overflow_is_not_success(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.run.installs = [ProbeResult(0, b"x" * 64, overflow=True)]
        error = self.m.failure()
        self.assertIs(error.code, Code.INSTALL_FAILED)
        self.assertEqual(len(self.m.run.install_calls()), 1)
        self.assert_nothing_published()

    def test_a_hung_install_is_a_timeout(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.run.installs = [ProbeResult(None, timed_out=True)]
        error = self.m.failure()
        self.assertIs(error.code, Code.INSTALL_TIMEOUT)
        self.assertIn(f"{INSTALL_TIMEOUT:g} s", error.message)
        self.assert_nothing_published()

    def test_credentials_and_index_tokens_never_reach_the_error_or_the_log(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        failing = ProbeResult(
            1,
            stdout=f"Looking in indexes: {INDEX}\n".encode(),
            stderr=(
                f"ERROR: 401 Client Error for url: {INDEX}/visionset/\n"
                f"WARNING: connection broken: /{PATH_TOKEN}/simple/visionset/\n"
                f"ERROR: query ?api_key={QUERY_TOKEN}\n"
            ).encode(),
        )
        self.m.run.installs = [failing]
        error = self.m.failure()
        self.assertEqual(self.m.disk.modes[[p for p in self.m.disk.modes][0]], 0o600)
        self.assert_no_secret(str(error), self.log(), *self.m.progress)

    def test_proxy_credentials_never_reach_the_error_or_the_log(self) -> None:
        # Passwords with a slash, and a token in a path, escape the generic user:pass@ rule, so
        # only the learned values from the environment and pip's configuration redact them.
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.env["PIP_PROXY"] = "alice:Hu/nter22@proxy.example:3128"
        self.m.env["https_proxy"] = "http://proxy.example:3128/Tk9pathsecret"
        config = "global.proxy='carol:Pa/ss99@p2.example:1'\n"
        self.m.run.pip_config = ProbeResult(0, config.encode())
        output = (
            "ERROR: 407 Proxy Authentication Required via alice:Hu/nter22@proxy.example, "
            "http://proxy.example:3128/Tk9pathsecret and carol:Pa/ss99@p2.example:1; "
            "also dave:Pw0rdzz9@other.example"
        )
        self.m.run.installs = [ProbeResult(1, stderr=output.encode())]
        error = self.m.failure()
        for text in (str(error), self.log()):
            for secret in ("nter22", "Tk9pathsecret", "ss99", "Pw0rdzz9", "alice", "carol"):
                self.assertNotIn(secret, text)
        self.assertIn("<redacted>@other.example", self.log())

    def test_redaction_happens_before_truncation(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        tail = PATH_TOKEN + "y" * (REASON_TAIL - 6)
        self.m.run.installs = [ProbeResult(1, stderr=tail.encode())]
        error = self.m.failure()
        self.assertNotIn(PATH_TOKEN[-6:], error.message)

    def test_the_failure_message_is_redacted_even_without_a_log(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.run.installs = [ProbeResult(1, stderr=f"ERROR: bad index {INDEX}".encode())]
        with mock.patch.object(FakeDisk, "append_private", side_effect=OSError("disk full")):
            error = self.m.failure()
        self.assert_no_secret(str(error))
        self.assertIn("<redacted>", error.message)

    def test_credentials_never_reach_the_sentinel(self) -> None:
        self.m.run.python(PYTHON, probe_output((3, 12, 1)))
        self.m.bootstrap()
        for path, text in self.m.disk.files.items():
            if path.endswith(("ready.json", ".owner")):
                self.assert_no_secret(text)

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

    def machine(self) -> Machine:
        m = Machine()
        m.run.python(PYTHON, probe_output((3, 12, 1)))
        return m

    def test_a_data_root_inside_the_plugin_is_refused(self) -> None:
        m = self.machine()
        m.env[DATA_ENV] = "/plugins/visionset/runtime/data"
        error = m.failure(plugin_root="/plugins/visionset")
        self.assertIs(error.code, Code.BAD_DATA_DIR)
        self.assertEqual(m.disk.tree("/plugins"), [])
        m.env[DATA_ENV] = "/plugins/visionset-data"
        m.bootstrap(plugin_root="/plugins/visionset")

    def test_a_data_root_inside_the_project_or_its_checkout_is_refused(self) -> None:
        m = self.machine()
        m.disk.makedirs("/srv/repo/.git")
        for root in ("/srv/repo/sub/.vs", "/srv/repo/.vs"):
            with self.subTest(root=root):
                m.env[DATA_ENV] = root
                error = m.failure(project="/srv/repo/sub")
                self.assertIs(error.code, Code.BAD_DATA_DIR)
                self.assertIn("project", error.message)
                self.assertEqual(m.disk.tree(root), [])
        m.env[DATA_ENV] = "/srv/data"
        m.bootstrap(project="/srv/repo/sub")

    def test_the_default_data_directory_is_allowed_when_the_project_is_home(self) -> None:
        m = self.machine()
        del m.env[DATA_ENV]
        m.disk.makedirs(HOME + "/.git")
        for project in (HOME, HOME + "/work/repo"):
            with self.subTest(project=project):
                self.assertTrue(m.bootstrap(project=project).prefix.startswith(HOME + "/.local"))

    def test_the_client_data_directory_is_allowed_when_the_project_is_home(self) -> None:
        m = self.machine()
        del m.env[DATA_ENV]
        m.env["CLAUDE_PLUGIN_DATA"] = HOME + "/.claude/plugins/data/visionset"
        for project in (HOME, HOME + "/notes"):
            with self.subTest(project=project):
                m.bootstrap(project=project)
        m.env[DATA_ENV] = HOME + "/.vs-data"
        self.assertIs(m.failure(project=HOME).code, Code.BAD_DATA_DIR)

    def test_the_client_data_directory_is_allowed_when_the_project_contains_home(self) -> None:
        m = self.machine()
        del m.env[DATA_ENV]
        m.env["CLAUDE_PLUGIN_DATA"] = HOME + "/.claude/plugins/data/visionset"
        for project in ("/", "/home"):
            with self.subTest(project=project):
                m.bootstrap(project=project)

    def test_a_client_data_directory_inside_a_checkout_under_home_is_refused(self) -> None:
        m = self.machine()
        del m.env[DATA_ENV]
        m.disk.makedirs(HOME + "/work/repo/.git")
        m.env["CLAUDE_PLUGIN_DATA"] = HOME + "/work/repo/.data"
        self.assertIs(m.failure(project=HOME + "/work/repo/src").code, Code.BAD_DATA_DIR)

    def test_a_client_data_directory_inside_the_project_is_refused(self) -> None:
        m = self.machine()
        del m.env[DATA_ENV]
        m.env["CLAUDE_PLUGIN_DATA"] = "/srv/repo/.claude-data"
        m.disk.makedirs("/srv/repo/.git")
        self.assertIs(m.failure(project="/srv/repo").code, Code.BAD_DATA_DIR)

    def test_an_interpreter_on_path_inside_an_untrusted_checkout_never_runs(self) -> None:
        m = Machine()
        m.disk.makedirs("/srv/repo/.git")
        planted = "/srv/repo/.venv/bin/python3.12"
        m.run.python(planted, probe_output((3, 12, 1)))
        m.env["PATH"] = "/srv/repo/.venv/bin:/usr/bin"
        error = m.failure(python=None, project="/srv/repo")
        self.assertIs(error.code, Code.NO_PYTHON)
        self.assertEqual(m.run.calls, [])
        m.run.python("/usr/bin/python3.13", probe_output((3, 13, 1)))
        m.bootstrap(python=None, project="/srv/repo")
        self.assertNotIn(planted, [call[0] for call in m.run.calls])
        trusted = Machine()
        trusted.disk.makedirs("/srv/repo/.git")
        trusted.run.python(planted, probe_output((3, 12, 1)))
        trusted.env["PATH"] = m.env["PATH"]
        trusted.bootstrap(python=None, project="/srv/repo", project_trusted=True)
        self.assertEqual(trusted.run.calls[0][0], planted)

    def test_a_data_directory_others_can_write_is_refused(self) -> None:
        for directory in (DATA, DATA + "/runtimes", DATA + "/locks"):
            with self.subTest(directory=directory):
                m = self.machine()
                m.disk.unsafe[directory] = "is writable by every user"
                error = m.failure()
                self.assertIs(error.code, Code.BAD_DATA_DIR)
                self.assertIn("writable by every user", error.message)
                self.assertEqual(m.run.calls, [])

    def test_a_data_directory_that_cannot_be_created(self) -> None:
        m = self.machine()
        m.disk.refuse_makedirs = True
        error = m.failure()
        self.assertIs(error.code, Code.BAD_DATA_DIR)
        self.assertIn("Permission denied", error.message)


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
        lay = layout("C:\\data", "k-r3", "visionset", True)
        self.assertEqual(lay.python, "C:\\data\\runtimes\\k-r3\\venv\\Scripts\\python.exe")
        self.assertEqual(
            lay.console_script, "C:\\data\\runtimes\\k-r3\\venv\\Scripts\\visionset.exe"
        )
        self.assertEqual(lay.lock, "C:\\data\\locks\\k.lock")
        self.assertEqual(lay.log, "C:\\data\\logs\\k.log")

    def test_every_generation_shares_one_lock_and_log_outside_it(self) -> None:
        one = layout("/d", "k-r1", "visionset", False)
        two = layout("/d", "k-r2", "visionset", False)
        self.assertEqual(one.python, "/d/runtimes/k-r1/venv/bin/python")
        self.assertEqual((one.lock, one.log), (two.lock, two.log))
        self.assertEqual(one.lock, "/d/locks/k.lock")
        self.assertFalse(one.lock.startswith(one.runtime))


class WindowsTest(unittest.TestCase):
    STORE = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe"

    def setUp(self) -> None:
        self.m = Machine(windows=True)
        self.m.env["PATH"] = "C:\\Windows;C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps"
        self.launcher = "C:\\Windows\\py.exe"

    def boot(self, run: Any) -> Bootstrapped:
        return run_bootstrap(
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

    def test_the_py_launcher_is_tried_newest_first(self) -> None:
        self.m.disk.put(self.launcher, executable=True)
        launched: list[list[str]] = []
        original = self.m.run.__call__

        def run(argv: Sequence[str], *rest: Any, **kwargs: Any) -> ProbeResult:
            if argv[0] == self.launcher and "-c" in argv:
                launched.append(list(argv[:2]))
                if argv[1] != "-3.12":
                    return ProbeResult(103, stderr=b"No suitable Python runtime found")
                return ProbeResult(0, probe_output((3, 12, 7)).encode())
            return original(argv, *rest, **kwargs)

        result = self.boot(run)
        self.assertEqual(
            launched, [[self.launcher, "-3.14"], [self.launcher, "-3.13"], [self.launcher, "-3.12"]]
        )
        self.assertTrue(result.console_script.endswith("\\venv\\Scripts\\visionset.exe"))
        venv_call = next(call for call in self.m.run.calls if "venv" in call)
        self.assertEqual(venv_call[:2], [self.launcher, "-3.12"])
        install = self.m.run.install_calls()[0]
        self.assertTrue(install[0].endswith("\\venv\\Scripts\\python.exe"))
        self.assertTrue(self.m.locker.acquired[0][0].startswith("C:\\data\\plugin\\locks\\"))
        self.assertTrue(all(fds == () for fds in self.m.run.fds))

    def test_the_store_alias_stub_is_probed_and_refused(self) -> None:
        stub = ProbeResult(9009, stderr=b"Python was not found; run without arguments to install")
        self.m.run.python(self.STORE, stub)
        self.assertIs(self.m.failure(python=None).code, Code.NO_PYTHON)
        self.assertEqual([call[0] for call in self.m.run.calls], [self.STORE])

    def test_a_working_store_python_is_used(self) -> None:
        self.m.run.python(self.STORE, probe_output((3, 12, 0)))
        result = self.boot(self.m.run)
        self.assertFalse(result.reused)
        venv_call = next(call for call in self.m.run.calls if "venv" in call)
        self.assertEqual(venv_call[0], self.STORE)

    def test_the_windows_lock_uses_non_blocking_msvcrt_byte_locking(self) -> None:
        calls: list[tuple[int, int]] = []
        refusals = {"left": 1}

        def locking(fd: int, mode: int, size: int) -> None:
            calls.append((mode, size))
            if mode == fake.LK_NBLCK and refusals["left"]:
                refusals["left"] -= 1
                raise OSError(36, "Resource deadlock avoided")

        fake = types.SimpleNamespace(LK_NBLCK=2, LK_LOCK=1, LK_UNLCK=0, locking=locking)
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
        self.assertEqual({mode for mode, _ in calls}, {2, 0})
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

    def test_a_symlinked_lock_file_is_not_followed(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            target = os.path.join(scratch, "elsewhere")
            path = os.path.join(scratch, "k.lock")
            os.symlink(target, path)
            with self.assertRaises(OSError):
                FileLocker(windows=False).acquire(path, 0.1)
            self.assertFalse(os.path.exists(target))

    def test_a_child_that_inherits_the_lease_keeps_the_lock(self) -> None:
        import subprocess

        with tempfile.TemporaryDirectory() as scratch:
            path = os.path.join(scratch, "k.lock")
            lease = FileLocker(windows=False).acquire(path, 1.0)
            assert lease is not None and lease.fd is not None
            child = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(30)"], pass_fds=(lease.fd,)
            )
            try:
                lease.release()
                self.assertIsNone(FileLocker(windows=False).acquire(path, 0.3))
            finally:
                child.kill()
                child.wait()
            after = FileLocker(windows=False).acquire(path, 1.0)
            assert after is not None
            after.release()


class OsWritableFileSystemTest(unittest.TestCase):
    def stat(self, uid: int, gid: int, mode: int) -> os.stat_result:
        return os.stat_result((mode, 0, 0, 0, uid, gid, 0, 0, 0, 0))

    @unittest.skipIf(os.name == "nt", "POSIX ownership")
    def test_unsafe_reason_follows_ownership_and_write_bits(self) -> None:
        uid, gid = os.getuid(), os.getgid()
        cases = [
            ((uid, gid, 0o40700), None),
            ((uid, gid, 0o40770), None),
            ((uid + 1, gid, 0o40700), "is owned by another user"),
            ((uid, gid, 0o40777), "is writable by every user"),
            ((uid, gid + 1, 0o40770), "is writable by a shared group"),
            ((uid, gid + 1, 0o40750), None),
        ]
        for (owner, group, mode), expected in cases:
            with self.subTest(owner=owner, group=group, mode=oct(mode)):
                fake = self.stat(owner, group, mode)
                with mock.patch("bootstrap.os.stat", return_value=fake):
                    self.assertEqual(OsWritableFileSystem().unsafe_reason("/x"), expected)

    def test_the_owner_marker_is_removed_last(self) -> None:
        with (
            warnings.catch_warnings(record=True) as caught,
            tempfile.TemporaryDirectory() as scratch,
        ):
            warnings.simplefilter("always")
            runtime = os.path.join(scratch, "k-r1")
            os.makedirs(os.path.join(runtime, "venv", "lib"))
            for name in (".owner", "ready.json.tmp", "zz"):
                with open(os.path.join(runtime, name), "w") as handle:
                    handle.write("x")
            with (
                mock.patch("bootstrap._rmtree", side_effect=PermissionError(13, "in use")),
                self.assertRaises(OSError),
            ):
                OsWritableFileSystem().remove_tree(runtime)
            self.assertTrue(os.path.exists(os.path.join(runtime, ".owner")))
            OsWritableFileSystem().remove_tree(runtime)
            self.assertFalse(os.path.exists(runtime))
            gc.collect()
        self.assertEqual([w for w in caught if issubclass(w.category, ResourceWarning)], [])


if __name__ == "__main__":
    unittest.main()
