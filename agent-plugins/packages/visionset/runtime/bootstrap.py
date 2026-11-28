"""Create the plugin-owned runtime when discovery finds nothing compatible.

A private virtual environment under the plugin's data directory, built from a local
Python 3.11 or newer and populated by its own `python -m pip` with a distribution inside the
compatibility range. No existing environment is changed, no GPU extra is installed, nothing
runs with elevated privileges, and a created environment is never moved.

Layout under the data root:

    runtimes/<version>-py<MAJ><MIN>-<tag>/   .owner, venv/, then ready.json once validated
    locks/<key>.lock                         the cross-process lock, outside the runtime
    logs/<key>.log                           redacted output of every step, mode 0600

A runtime directory without `ready.json` is incomplete. Under the lock an incomplete
directory carrying this plugin's `.owner` marker is removed and rebuilt; one without the
marker is never touched. This module writes nothing to stdout.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib
import json
import ntpath
import os
import posixpath
import re
import shutil
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any, Protocol

from discover import (
    OUTPUT_CAP,
    PROBE_ENV_SCRUB,
    PROBE_TIMEOUT,
    REASON_TAIL,
    Bundle,
    FileSystem,
    Found,
    Host,
    OsFileSystem,
    ProbeResult,
    Runner,
    check_executable,
    redact,
    run_bounded,
)

NO_BOOTSTRAP_ENV = "VISIONSET_PLUGIN_NO_BOOTSTRAP"
DATA_ENV = "VISIONSET_PLUGIN_DATA"
CLAUDE_DATA_ENV = "CLAUDE_PLUGIN_DATA"
APP_DIR = "visionset-agent-plugin"
MIN_PYTHON = (3, 11)
NEWEST_MINOR = 14
LOCK_TIMEOUT = 300.0
LOCK_POLL = 0.1
INSTALL_TIMEOUT = 900.0
VALIDATION_TIMEOUT = 60.0
RETRY_DELAY = 5.0
PIP_OUTPUT_CAP = 8 * 1024 * 1024
OWNER = "visionset-agent-plugin"
SENTINEL_SCHEMA = 1
# Variables that change which interpreter pip serves or where it installs. Index, mirror,
# certificate and find-links settings pass through, as do pip.conf and netrc.
PIP_ENV_SCRUB = PROBE_ENV_SCRUB | {
    "PIP_TARGET",
    "PIP_USER",
    "PIP_PREFIX",
    "PIP_ROOT",
    "PIP_PYTHON",
    "PIP_REQUIRE_VIRTUALENV",
    "PIP_BREAK_SYSTEM_PACKAGES",
    "PIP_UPGRADE",
    "PIP_UPGRADE_STRATEGY",
    "PIP_PRE",
    "PIP_EDITABLE",
    "PIP_SRC",
    "PIP_FORCE_REINSTALL",
    "PIP_IGNORE_INSTALLED",
    "PIP_NO_DEPS",
    "PYTHONUSERBASE",
}
_DISTRIBUTION = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?")
_PINNED = re.compile(r"==[0-9][0-9A-Za-z.]*")
_NETWORK = re.compile(
    r"NewConnectionError|ConnectTimeoutError|ReadTimeoutError|Max retries exceeded"
    r"|Temporary failure in name resolution|Name or service not known|nodename nor servname"
    r"|getaddrinfo failed|Network is unreachable|Connection refused|Connection reset"
    r"|ProxyError|Could not fetch URL",
    re.IGNORECASE,
)
_PROBE = (
    "import importlib.util as u, json, os, sys, sysconfig; "
    "print(json.dumps({'version': list(sys.version_info[:3]), "
    "'executable': os.path.realpath(sys.executable), "
    "'implementation': sys.implementation.name, 'platform': sysconfig.get_platform(), "
    "'venv': u.find_spec('venv') is not None, 'ensurepip': u.find_spec('ensurepip') is not None}))"
)


class Code(Enum):
    OPTED_OUT = "OPTED_OUT"
    BAD_DATA_DIR = "BAD_DATA_DIR"
    NO_PYTHON = "NO_PYTHON"
    PYTHON_TOO_OLD = "PYTHON_TOO_OLD"
    NO_VENV = "NO_VENV"
    NO_PIP = "NO_PIP"
    LOCK_TIMEOUT = "LOCK_TIMEOUT"
    NOT_OWNED = "NOT_OWNED"
    INDEX_UNAVAILABLE = "INDEX_UNAVAILABLE"
    INSTALL_FAILED = "INSTALL_FAILED"
    INSTALL_TIMEOUT = "INSTALL_TIMEOUT"
    VALIDATION_FAILED = "VALIDATION_FAILED"
    INCOMPATIBLE_RESULT = "INCOMPATIBLE_RESULT"


class BootstrapError(Exception):
    """A runtime could not be provided. `code` is stable; the message is already redacted."""

    def __init__(self, code: Code, message: str, hint: str = "", log: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.log = log

    def __str__(self) -> str:
        parts = [f"{self.code.value}: {self.message}"]
        if self.hint:
            parts.append(self.hint)
        if self.log:
            parts.append(f"log: {self.log}")
        return "; ".join(parts)


@dataclass(frozen=True)
class Bootstrapped:
    prefix: str
    console_script: str
    version: str
    reused: bool


@dataclass(frozen=True)
class Interpreter:
    argv: tuple[str, ...]
    version: tuple[int, int, int]
    executable: str
    implementation: str
    platform: str


@dataclass(frozen=True)
class Layout:
    root: str
    key: str
    runtime: str
    venv: str
    owner: str
    ready: str
    lock: str
    log: str
    python: str
    console_script: str


class Clock(Protocol):
    def monotonic(self) -> float: ...
    def sleep(self, seconds: float) -> None: ...
    def now(self) -> float: ...


class SystemClock:
    def monotonic(self) -> float:
        return time.monotonic()

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)

    def now(self) -> float:
        return time.time()


class Lease(Protocol):
    def release(self) -> None: ...


class Locker(Protocol):
    def acquire(self, path: str, timeout: float) -> Lease | None: ...


class _FileLease:
    def __init__(self, fd: int, windows: bool) -> None:
        self.fd = fd
        self.windows = windows

    def release(self) -> None:
        try:
            if self.windows:
                msvcrt: Any = importlib.import_module("msvcrt")
                os.lseek(self.fd, 0, os.SEEK_SET)
                with contextlib.suppress(OSError):
                    msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.fd, fcntl.LOCK_UN)
        finally:
            os.close(self.fd)


class FileLocker:
    """An exclusive advisory lock the operating system drops when its holder dies."""

    def __init__(self, windows: bool | None = None, clock: Clock | None = None) -> None:
        self.windows = os.name == "nt" if windows is None else windows
        self.clock = clock or SystemClock()

    def _try(self, fd: int) -> bool:
        try:
            if self.windows:
                msvcrt: Any = importlib.import_module("msvcrt")
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return False
        return True

    def acquire(self, path: str, timeout: float) -> Lease | None:
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            deadline = self.clock.monotonic() + timeout
            while not self._try(fd):
                if self.clock.monotonic() >= deadline:
                    os.close(fd)
                    return None
                self.clock.sleep(LOCK_POLL)
        except BaseException:
            os.close(fd)
            raise
        return _FileLease(fd, self.windows)


class WritableFileSystem(FileSystem, Protocol):
    def makedirs(self, path: str) -> None: ...
    def read_text(self, path: str) -> str | None: ...
    def write_new(self, path: str, text: str) -> None: ...
    def replace(self, source: str, target: str) -> None: ...
    def remove_tree(self, path: str) -> None: ...
    def append_private(self, path: str, text: str) -> None: ...


class OsWritableFileSystem(OsFileSystem):
    def makedirs(self, path: str) -> None:
        os.makedirs(path, mode=0o700, exist_ok=True)

    def read_text(self, path: str) -> str | None:
        try:
            with open(path, encoding="utf-8") as handle:
                return handle.read(64 * 1024)
        except (OSError, UnicodeDecodeError):
            return None

    def write_new(self, path: str, text: str) -> None:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())

    def replace(self, source: str, target: str) -> None:
        os.replace(source, target)

    def remove_tree(self, path: str) -> None:
        shutil.rmtree(path)

    def append_private(self, path: str, text: str) -> None:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as handle:
            if os.name != "nt":
                os.fchmod(handle.fileno(), 0o600)
            handle.write(text)


def _pm(host: Host) -> Any:
    return ntpath if host.windows else posixpath


def _absolute(path: str, host: Host) -> bool:
    if not host.windows:
        return posixpath.isabs(path)
    drive, rest = ntpath.splitdrive(path)
    return bool(drive) and rest[:1] in ("\\", "/")


def data_root(host: Host) -> str:
    """`VISIONSET_PLUGIN_DATA`, else `CLAUDE_PLUGIN_DATA`, else the user's data directory."""
    pm = _pm(host)
    override = host.get(DATA_ENV)
    if override is not None:
        if not _absolute(override, host):
            raise BootstrapError(Code.BAD_DATA_DIR, f"{DATA_ENV} must be an absolute path")
        return str(pm.normpath(override))
    given = host.get(CLAUDE_DATA_ENV)
    if given is not None and _absolute(given, host):
        return str(pm.normpath(given))
    base: str | None
    if host.windows:
        base = host.get("LOCALAPPDATA")
    elif host.macos:
        base = pm.join(host.home, "Library", "Application Support") if host.home else None
    else:
        xdg = host.get("XDG_DATA_HOME")
        if xdg is not None and _absolute(xdg, host):
            base = xdg
        else:
            base = pm.join(host.home, ".local", "share") if host.home else None
    if base is None or not _absolute(base, host):
        raise BootstrapError(
            Code.BAD_DATA_DIR,
            "no user data directory could be determined",
            hint=f"set {DATA_ENV} to an absolute path",
        )
    return str(pm.join(pm.normpath(base), APP_DIR))


def runtime_key(version: str, interpreter: Interpreter) -> str:
    identity = "\0".join((interpreter.executable, interpreter.implementation, interpreter.platform))
    tag = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:8]
    major, minor, _ = interpreter.version
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", version)
    return f"{safe}-py{major}{minor}-{tag}"


def layout(root: str, key: str, console_script: str, windows: bool) -> Layout:
    pm = ntpath if windows else posixpath
    runtime = pm.join(root, "runtimes", key)
    venv = pm.join(runtime, "venv")
    scripts = pm.join(venv, "Scripts" if windows else "bin")
    suffix = ".exe" if windows else ""
    return Layout(
        root=root,
        key=key,
        runtime=runtime,
        venv=venv,
        owner=pm.join(runtime, ".owner"),
        ready=pm.join(runtime, "ready.json"),
        lock=pm.join(root, "locks", key + ".lock"),
        log=pm.join(root, "logs", key + ".log"),
        python=pm.join(scripts, "python" + suffix),
        console_script=pm.join(scripts, console_script + suffix),
    )


def _parse_ready(text: str | None, key: str) -> dict[str, Any] | None:
    if text is None:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("schema") != SENTINEL_SCHEMA:
        return None
    if data.get("key") != key:
        return None
    fields = ("version", "compatibility", "created", "python")
    if not all(isinstance(data.get(name), str) for name in fields):
        return None
    return data


def _owned(text: str | None, key: str) -> bool:
    if text is None:
        return False
    try:
        data = json.loads(text)
    except ValueError:
        return False
    return isinstance(data, dict) and data.get("owner") == OWNER and data.get("key") == key


def cached_prefixes(*, host: Host | None = None, fs: WritableFileSystem | None = None) -> list[str]:
    """Published runtime prefixes, newest first, for `discover(cached=...)`."""
    host = host or Host.current()
    fs = fs or OsWritableFileSystem()
    pm = _pm(host)
    try:
        runtimes = pm.join(data_root(host), "runtimes")
    except BootstrapError:
        return []
    found: list[tuple[str, str]] = []
    for name in fs.listdir(runtimes):
        sentinel = _parse_ready(fs.read_text(pm.join(runtimes, name, "ready.json")), name)
        if sentinel is not None:
            found.append((sentinel["created"], str(pm.join(runtimes, name, "venv"))))
    return [prefix for _, prefix in sorted(found, reverse=True)]


def _stderr(message: str) -> None:
    stream = sys.stderr
    if stream is not None:
        stream.write(f"visionset plugin: {message}\n")
        stream.flush()


def _opted_out(value: str | None) -> bool:
    return value is not None and value.strip().casefold() not in ("0", "false", "no", "off", "")


class _Job:
    def __init__(
        self,
        bundle: Bundle,
        host: Host,
        fs: WritableFileSystem,
        run: Runner,
        clock: Clock,
        progress: Callable[[str], None],
        install_timeout: float,
    ) -> None:
        self.bundle = bundle
        self.host = host
        self.fs = fs
        self.run = run
        self.clock = clock
        self.progress = progress
        self.install_timeout = install_timeout
        self.pm = _pm(host)
        self.env = {k: v for k, v in host.env.items() if k.upper() not in PIP_ENV_SCRUB}
        self.env["NO_COLOR"] = "1"
        self.requirement = f"{bundle.distribution}{bundle.compatibility.strip()}"
        self.manual = f"install it yourself: pipx install '{self.requirement}'"
        self.log: str | None = None

    def shown(self, text: str) -> str:
        return redact(text, self.host)

    def fail(self, code: Code, message: str, hint: str = "") -> BootstrapError:
        log = self.shown(self.log) if self.log else None
        return BootstrapError(code, self.shown(message), hint or self.manual, log)

    # Interpreter selection

    def which(self, name: str) -> str | None:
        names = [name + ".exe"] if self.host.windows else [name]
        for directory in (self.host.get("PATH") or "").split(self.pm.pathsep):
            directory = directory.strip().strip('"') if self.host.windows else directory
            if not directory or not _absolute(directory, self.host):
                continue
            for candidate in names:
                path = str(self.pm.join(directory, candidate))
                if self.fs.is_file(path) and self.fs.is_executable(path):
                    return path
        return None

    def candidates(self, current: str | None) -> list[tuple[str, ...]]:
        found: list[tuple[str, ...]] = [(current,)] if current else []
        minors = range(NEWEST_MINOR, MIN_PYTHON[1] - 1, -1)
        names = [f"python3.{minor}" for minor in minors] + ["python3", "python"]
        if self.host.windows:
            launcher = self.which("py")
            if launcher:
                found += [(launcher, f"-3.{minor}") for minor in minors]
            names = ["python"]
        for name in names:
            path = self.which(name)
            if path:
                found.append((path,))
        return found

    def probe_python(self, argv: tuple[str, ...]) -> Interpreter | str:
        if self.host.windows and "\\windowsapps\\" in argv[0].casefold().replace("/", "\\"):
            return "broken"
        cwd = str(self.pm.dirname(argv[0]))
        result = self.run([*argv, "-I", "-c", _PROBE], cwd, self.env, PROBE_TIMEOUT, OUTPUT_CAP)
        if result.error is not None or result.timed_out or result.returncode != 0:
            return "broken"
        try:
            data = json.loads(result.stdout.decode("utf-8", "replace"))
            version = tuple(int(part) for part in data["version"])[:3]
            interpreter = Interpreter(
                argv=argv,
                version=(version[0], version[1], version[2]),
                executable=str(data["executable"]),
                implementation=str(data["implementation"]),
                platform=str(data["platform"]),
            )
            has_venv = bool(data["venv"]) and bool(data["ensurepip"])
        except (ValueError, KeyError, TypeError, IndexError):
            return "broken"
        if interpreter.version[:2] < MIN_PYTHON:
            return "old"
        if not has_venv:
            return "novenv"
        return interpreter

    def select_python(self, current: str | None) -> Interpreter:
        verdicts: list[str] = []
        for argv in self.candidates(current):
            verdict = self.probe_python(argv)
            if isinstance(verdict, Interpreter):
                return verdict
            verdicts.append(verdict)
        floor = ".".join(map(str, MIN_PYTHON))
        if "novenv" in verdicts:
            raise self.fail(
                Code.NO_VENV,
                f"Python {floor}+ was found but its venv or ensurepip module is missing",
                hint=f"install your distribution's venv package (python3-venv); or {self.manual}",
            )
        if "old" in verdicts:
            raise self.fail(
                Code.PYTHON_TOO_OLD,
                f"every Python found is older than {floor}",
                hint=f"install Python {floor} or newer; or {self.manual}",
            )
        raise self.fail(
            Code.NO_PYTHON,
            f"no Python {floor} or newer was found on PATH",
            hint=f"install Python {floor} or newer; or {self.manual}",
        )

    # Steps

    def step(self, argv: Sequence[str], cwd: str, timeout: float, cap: int) -> ProbeResult:
        result = self.run(argv, cwd, self.env, timeout, cap)
        if self.log is not None:
            lines = [f"$ {self.shown(' '.join(argv))}"]
            for stream in (result.stdout, result.stderr):
                text = stream.decode("utf-8", "replace")
                lines += [self.shown(line) for line in text.splitlines() if line.strip()]
            status = result.error or ("timed out" if result.timed_out else result.returncode)
            lines.append(f"# exit: {status}")
            with contextlib.suppress(OSError):
                self.fs.append_private(self.log, "\n".join(lines) + "\n")
        return result

    def tail(self, result: ProbeResult) -> str:
        if result.error is not None:
            return f"could not be started: {result.error}"
        text = (result.stdout + b"\n" + result.stderr).decode("utf-8", "replace")
        return self.shown(text)[-REASON_TAIL:] or "no output"

    def timed_out(self) -> BootstrapError:
        return self.fail(
            Code.INSTALL_TIMEOUT, f"setup did not finish within {self.install_timeout:g} s"
        )

    def remaining(self, deadline: float) -> float:
        left = deadline - self.clock.monotonic()
        if left <= 0:
            raise self.timed_out()
        return left

    def reuse(self, lay: Layout) -> Bootstrapped | None:
        sentinel = _parse_ready(self.fs.read_text(lay.ready), lay.key)
        if sentinel is None or not self.fs.is_file(lay.console_script):
            return None
        alive = self.run(
            [lay.python, "-I", "-c", "import sys"], lay.runtime, self.env, PROBE_TIMEOUT, OUTPUT_CAP
        )
        dead = alive.error is not None or (not alive.timed_out and alive.returncode != 0)
        if dead:
            self.progress("the cached runtime's interpreter no longer starts; rebuilding it")
            return None
        return Bootstrapped(lay.venv, lay.console_script, sentinel["version"], reused=True)

    def clear_incomplete(self, lay: Layout) -> None:
        if not self.fs.lexists(lay.runtime):
            return
        # An empty directory is what a setup killed between mkdir and the marker leaves.
        empty = self.fs.is_dir(lay.runtime) and not self.fs.listdir(lay.runtime)
        if not empty and not _owned(self.fs.read_text(lay.owner), lay.key):
            raise self.fail(
                Code.NOT_OWNED,
                f"{lay.runtime} exists but was not created by this plugin, so it is left alone",
                hint=f"remove it yourself, or set {DATA_ENV} to another directory",
            )
        self.progress("removing an incomplete runtime left by an interrupted setup")
        self.fs.remove_tree(lay.runtime)

    def build(self, lay: Layout, interpreter: Interpreter) -> Bootstrapped:
        deadline = self.clock.monotonic() + self.install_timeout
        shown_version = ".".join(map(str, interpreter.version))
        self.progress(
            f"creating a private runtime for {self.requirement} with Python {shown_version} "
            f"in {self.shown(lay.runtime)}"
        )
        self.fs.makedirs(lay.runtime)
        self.fs.write_new(lay.owner, json.dumps({"owner": OWNER, "key": lay.key}) + "\n")
        try:
            found = self._populate(lay, interpreter, deadline)
            self._publish(lay, interpreter, found)
        except BaseException:
            with contextlib.suppress(OSError):
                self.fs.remove_tree(lay.runtime)
            raise
        self.progress("runtime ready")
        return Bootstrapped(lay.venv, lay.console_script, found.version, reused=False)

    def install_argv(self, lay: Layout) -> list[str]:
        return [
            lay.python,
            "-I",
            "-m",
            "pip",
            "install",
            "--no-input",
            "--disable-pip-version-check",
            "--progress-bar",
            "off",
            self.requirement,
        ]

    def _populate(self, lay: Layout, interpreter: Interpreter, deadline: float) -> Found:
        create = [*interpreter.argv, "-I", "-m", "venv", lay.venv]
        result = self.step(create, lay.runtime, self.remaining(deadline), OUTPUT_CAP)
        if result.timed_out:
            raise self.timed_out()
        if result.error is not None or result.returncode != 0:
            raise self.fail(
                Code.NO_VENV,
                f"creating the virtual environment failed: {self.tail(result)}",
                hint=f"install your distribution's venv package (python3-venv); or {self.manual}",
            )
        pip_version = [lay.python, "-I", "-m", "pip", "--version"]
        result = self.step(pip_version, lay.runtime, PROBE_TIMEOUT, OUTPUT_CAP)
        if result.error is not None or result.timed_out or result.returncode != 0:
            raise self.fail(
                Code.NO_PIP, f"the new environment has no working pip: {self.tail(result)}"
            )
        self.progress(f"installing {self.requirement}")
        argv = self.install_argv(lay)
        for attempt in (1, 2):
            result = self.step(argv, lay.runtime, self.remaining(deadline), PIP_OUTPUT_CAP)
            if result.timed_out:
                raise self.timed_out()
            if result.error is None and result.returncode == 0 and not result.overflow:
                break
            output = (result.stdout + result.stderr).decode("utf-8", "replace")
            if result.error is None and _NETWORK.search(output):
                if attempt == 1:
                    self.progress("the package index did not answer; retrying once")
                    self.clock.sleep(RETRY_DELAY)
                    continue
                raise self.fail(
                    Code.INDEX_UNAVAILABLE,
                    f"the package index could not be reached: {self.tail(result)}",
                    hint=(
                        "check the network or your pip index configuration, or point "
                        f"PIP_FIND_LINKS at a directory of wheels; or {self.manual}"
                    ),
                )
            detail = f"pip could not install {self.requirement}: {self.tail(result)}"
            raise self.fail(Code.INSTALL_FAILED, detail)
        verdict = check_executable(
            lay.console_script,
            compatibility=self.bundle.compatibility,
            host=self.host,
            fs=self.fs,
            run=self.run,
            probe_timeout=VALIDATION_TIMEOUT,
        )
        if isinstance(verdict, Found):
            return verdict
        if verdict.reason.startswith("version "):
            raise self.fail(Code.INCOMPATIBLE_RESULT, f"the installed {verdict.reason}")
        raise self.fail(Code.VALIDATION_FAILED, f"the installed command {verdict.reason}")

    def _publish(self, lay: Layout, interpreter: Interpreter, found: Found) -> None:
        digest = hashlib.sha256("\0".join(self.install_argv(lay)[1:]).encode("utf-8"))
        created = datetime.fromtimestamp(self.clock.now(), UTC)
        sentinel = {
            "schema": SENTINEL_SCHEMA,
            "key": lay.key,
            "distribution": self.bundle.distribution,
            "version": found.version,
            "compatibility": self.bundle.compatibility,
            "python": interpreter.executable,
            "pip_args_digest": digest.hexdigest(),
            "created": created.strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        }
        staged = lay.ready + ".tmp"
        self.fs.write_new(staged, json.dumps(sentinel, indent=2, sort_keys=True) + "\n")
        if _parse_ready(self.fs.read_text(staged), lay.key) is None:
            raise self.fail(Code.VALIDATION_FAILED, "the readiness file did not read back")
        self.fs.replace(staged, lay.ready)


def _inside(path: str, root: str, host: Host, fs: FileSystem) -> bool:
    pm = _pm(host)
    sep = "\\" if host.windows else "/"

    def key(value: str) -> str:
        normal = str(pm.normcase(pm.normpath(fs.realpath(value))))
        return normal.casefold() if host.case_insensitive else normal

    child, parent = key(path), key(root)
    return child == parent or child.startswith(parent.rstrip(sep) + sep)


def bootstrap(
    bundle: Bundle,
    *,
    host: Host | None = None,
    fs: WritableFileSystem | None = None,
    run: Runner = run_bounded,
    locker: Locker | None = None,
    clock: Clock | None = None,
    python: str | None = sys.executable,
    plugin_root: str | None = str(Path(__file__).resolve().parent.parent),
    lock_timeout: float = LOCK_TIMEOUT,
    install_timeout: float = INSTALL_TIMEOUT,
    progress: Callable[[str], None] = _stderr,
) -> Bootstrapped:
    """Return the plugin-owned runtime for the bundle's range, building it if needed.

    `python` is the interpreter tried first, normally the one running this module. Raises
    `BootstrapError`; never writes to stdout.
    """
    host = host or Host.current()
    fs = fs or OsWritableFileSystem()
    clock = clock or SystemClock()
    locker = locker or FileLocker(host.windows, clock)
    pinned = _PINNED.fullmatch(bundle.compatibility.strip())
    if not _DISTRIBUTION.fullmatch(bundle.distribution) or not pinned:
        raise BootstrapError(Code.INSTALL_FAILED, "the bundle names an invalid requirement")
    job = _Job(bundle, host, fs, run, clock, progress, install_timeout)
    if _opted_out(host.get(NO_BOOTSTRAP_ENV)):
        raise job.fail(Code.OPTED_OUT, f"{NO_BOOTSTRAP_ENV} is set, so no runtime is created")
    root = data_root(host)
    if plugin_root is not None and _inside(root, plugin_root, host, fs):
        raise job.fail(
            Code.BAD_DATA_DIR,
            "the data directory lies inside the installed plugin",
            hint=f"set {DATA_ENV} to a directory outside it",
        )
    for directory in ("runtimes", "locks", "logs"):
        fs.makedirs(str(job.pm.join(root, directory)))
    interpreter = job.select_python(python)
    version = bundle.compatibility.strip().removeprefix("==").strip()
    lay = layout(root, runtime_key(version, interpreter), bundle.console_script, host.windows)
    job.log = lay.log

    ready = job.reuse(lay)
    if ready is not None:
        return ready
    lease = locker.acquire(lay.lock, lock_timeout)
    if lease is None:
        raise job.fail(
            Code.LOCK_TIMEOUT,
            f"another setup of this runtime is still running after {lock_timeout:g} s",
            hint="wait for it to finish and try again",
        )
    try:
        ready = job.reuse(lay)
        if ready is not None:
            return ready
        job.clear_incomplete(lay)
        return job.build(lay, interpreter)
    finally:
        lease.release()
