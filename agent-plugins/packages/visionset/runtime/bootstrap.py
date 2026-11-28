"""Create the plugin-owned runtime when discovery finds nothing compatible.

A private virtual environment under the plugin's data directory, built from a local
Python 3.11 or newer and populated by its own `python -m pip` with a distribution inside the
compatibility range. No existing environment is changed, no GPU extra is installed, nothing
runs with elevated privileges, and a created environment is never moved.

Layout under the data root, where `<base>` is `<version>-py<MAJ><MIN>-<tag>`:

    runtimes/<base>-r<n>/       one generation: .owner, venv/, then ready.json once validated
    runtimes/.trash-<base>-*    an owned generation moved aside before removal
    locks/<base>.lock           the cross-process lock, outside every generation
    logs/<base>.log             redacted output of every step, mode 0600

A generation without `ready.json` is incomplete. Under the lock an incomplete generation this
plugin owns is moved aside and removed; anything it does not own is left alone. A published
generation is never removed or rebuilt in place: a broken one is superseded by a new
generation beside it. The lock file descriptor is inherited by every process that writes into
a generation, so on POSIX an orphaned pip keeps the lock until it exits. This module writes
nothing to stdout.
"""

from __future__ import annotations

import contextlib
import dataclasses
import functools
import hashlib
import importlib
import json
import ntpath
import os
import posixpath
import re
import shutil
import stat
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

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
    _version_key,
    _wanted_version,
    check_executable,
    checkout_of,
    redact,
    run_bounded,
)

NO_BOOTSTRAP_ENV = "VISIONSET_PLUGIN_NO_BOOTSTRAP"
DATA_ENV = "VISIONSET_PLUGIN_DATA"
CLAUDE_DATA_ENV = "CLAUDE_PLUGIN_DATA"
APP_DIR = "visionset-agent-plugin"
MIN_PYTHON = (3, 11)
NEWEST_MINOR = 14
INSTALL_TIMEOUT = 900.0
VALIDATION_TIMEOUT = 60.0
# A waiter outlasts a whole build: the install deadline plus every probe around it.
LOCK_TIMEOUT = 1500.0
LOCK_POLL = 0.1
RETRY_DELAY = 5.0
PIP_OUTPUT_CAP = 8 * 1024 * 1024
OWNER = "visionset-agent-plugin"
SENTINEL_SCHEMA = 2
OWNER_ENTRIES = frozenset({".owner", ".owner.tmp"})
# The only pip variables passed through: where packages come from and how to reach it. Every
# other PIP_* variable, which could add packages or move the install, is dropped.
PIP_ENV_KEEP = frozenset(
    {
        "PIP_INDEX_URL",
        "PIP_EXTRA_INDEX_URL",
        "PIP_FIND_LINKS",
        "PIP_NO_INDEX",
        "PIP_TRUSTED_HOST",
        "PIP_CERT",
        "PIP_CLIENT_CERT",
        "PIP_PROXY",
        "PIP_RETRIES",
        "PIP_TIMEOUT",
        "PIP_CONFIG_FILE",
        "PIP_KEYRING_PROVIDER",
        "PIP_CACHE_DIR",
        "PIP_NO_CACHE_DIR",
    }
)
INDEX_ENV = ("PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "PIP_FIND_LINKS")
_INDEX_KEYS = frozenset({"index-url", "extra-index-url", "find-links"})
# pip configuration that would install somewhere else or install something else.
_CONFIG_LOCATION_KEYS = frozenset({"target", "prefix", "root", "requirement", "editable", "src"})
_CONFIG_LOCATION_KEYS |= {"python"}
_CONFIG_SWITCH_KEYS = frozenset({"user", "dry-run"})
_FALSE = frozenset({"0", "false", "no", "off", ""})
_COMMON_SEGMENTS = frozenset({"simple", "pypi", "index", "packages", "api", "repository", "wheels"})
_DISTRIBUTION = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?")
_PINNED = re.compile(r"==[0-9][0-9A-Za-z.]*")
_CONFIG_LINE = re.compile(r"^([\w:.-]+)\.([\w-]+)='(.*)'$")
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
    BAD_PIP_CONFIG = "BAD_PIP_CONFIG"
    NO_PYTHON = "NO_PYTHON"
    PYTHON_TOO_OLD = "PYTHON_TOO_OLD"
    NO_VENV = "NO_VENV"
    NO_PIP = "NO_PIP"
    LOCK_TIMEOUT = "LOCK_TIMEOUT"
    CLEANUP_FAILED = "CLEANUP_FAILED"
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
    base: str
    key: str
    runtime: str
    venv: str
    owner: str
    ready: str
    lock: str
    log: str
    python: str
    console_script: str


class InstallRunner(Protocol):
    def __call__(
        self,
        argv: Sequence[str],
        cwd: str,
        env: Mapping[str, str],
        timeout: float,
        cap: int,
        *,
        pass_fds: Sequence[int] = (),
    ) -> ProbeResult: ...


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
    @property
    def fd(self) -> int | None: ...
    def release(self) -> None: ...


class Locker(Protocol):
    def acquire(self, path: str, timeout: float) -> Lease | None: ...


class _FileLease:
    def __init__(self, fd: int, windows: bool) -> None:
        self._fd = fd
        self.windows = windows

    @property
    def fd(self) -> int | None:
        return self._fd

    def release(self) -> None:
        try:
            if self.windows:
                msvcrt: Any = importlib.import_module("msvcrt")
                os.lseek(self._fd, 0, os.SEEK_SET)
                with contextlib.suppress(OSError):
                    msvcrt.locking(self._fd, msvcrt.LK_UNLCK, 1)
        finally:
            # On POSIX only the descriptor is closed: an unlock would also free the lock
            # for a child that inherited it and is still writing.
            os.close(self._fd)


class FileLocker:
    """An exclusive advisory lock released when every process holding its descriptor exits."""

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
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags, 0o600)
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
    def unsafe_reason(self, path: str) -> str | None: ...


_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


class OsWritableFileSystem(OsFileSystem):
    def makedirs(self, path: str) -> None:
        os.makedirs(path, mode=0o700, exist_ok=True)

    def read_text(self, path: str) -> str | None:
        try:
            fd = os.open(path, os.O_RDONLY | _NOFOLLOW)
            with os.fdopen(fd, encoding="utf-8") as handle:
                return handle.read(64 * 1024)
        except (OSError, UnicodeDecodeError):
            return None

    def write_new(self, path: str, text: str) -> None:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | _NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())

    def replace(self, source: str, target: str) -> None:
        os.replace(source, target)

    def remove_tree(self, path: str) -> None:
        """Remove everything under path, then its `.owner`, then path itself."""
        for entry in os.scandir(path):
            if entry.name == ".owner":
                continue
            if entry.is_dir(follow_symlinks=False):
                _rmtree(entry.path)
            else:
                _unlink(entry.path)
        with contextlib.suppress(FileNotFoundError):
            _unlink(os.path.join(path, ".owner"))
        os.rmdir(path)

    def append_private(self, path: str, text: str) -> None:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | _NOFOLLOW, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as handle:
            if os.name != "nt":
                os.fchmod(handle.fileno(), 0o600)
            handle.write(text)

    def unsafe_reason(self, path: str) -> str | None:
        if os.name == "nt":
            return None
        info = os.stat(path)
        if info.st_uid != os.getuid():
            return "is owned by another user"
        if info.st_mode & stat.S_IWOTH:
            return "is writable by every user"
        if info.st_mode & stat.S_IWGRP and info.st_gid != os.getgid():
            return "is writable by a shared group"
        return None


def _unlink(path: str) -> None:
    try:
        os.unlink(path)
    except PermissionError:
        os.chmod(path, stat.S_IWRITE | stat.S_IREAD)
        os.unlink(path)


def _rmtree(path: str) -> None:
    try:
        shutil.rmtree(path)
        return
    except OSError:
        pass
    # Read-only entries (Windows attributes, or a directory without write permission).
    for directory, dirs, files in os.walk(path):
        for name in (*dirs, *files):
            target = os.path.join(directory, name)
            if not os.path.islink(target):
                with contextlib.suppress(OSError):
                    os.chmod(target, stat.S_IRWXU)
    with contextlib.suppress(OSError):
        os.chmod(path, stat.S_IRWXU)
    shutil.rmtree(path)


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
    """The base key; each generation of it is `<base>-r<n>`."""
    identity = "\0".join((interpreter.executable, interpreter.implementation, interpreter.platform))
    tag = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:8]
    major, minor, _ = interpreter.version
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", version)
    return f"{safe}-py{major}{minor}-{tag}"


_GENERATION = re.compile(r"(.+)-r([1-9][0-9]*)")


def layout(root: str, key: str, console_script: str, windows: bool) -> Layout:
    pm = ntpath if windows else posixpath
    match = _GENERATION.fullmatch(key)
    base = match.group(1) if match else key
    runtime = pm.join(root, "runtimes", key)
    venv = pm.join(runtime, "venv")
    scripts = pm.join(venv, "Scripts" if windows else "bin")
    suffix = ".exe" if windows else ""
    return Layout(
        root=root,
        base=base,
        key=key,
        runtime=runtime,
        venv=venv,
        owner=pm.join(runtime, ".owner"),
        ready=pm.join(runtime, "ready.json"),
        lock=pm.join(root, "locks", base + ".lock"),
        log=pm.join(root, "logs", base + ".log"),
        python=pm.join(scripts, "python" + suffix),
        console_script=pm.join(scripts, console_script + suffix),
    )


def _parse_ready(text: str | None, lay: Layout) -> dict[str, Any] | None:
    if text is None:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("schema") != SENTINEL_SCHEMA:
        return None
    if data.get("key") != lay.key or data.get("console_script") != lay.console_script:
        return None
    fields = ("version", "compatibility", "created", "python")
    if not all(isinstance(data.get(name), str) for name in fields):
        return None
    return data


def _marker(text: str | None) -> dict[str, Any] | None:
    if text is None:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("owner") != OWNER:
        return None
    return data


def cached_prefixes(
    *,
    host: Host | None = None,
    fs: WritableFileSystem | None = None,
    console_script: str = "visionset",
) -> list[str]:
    """Published runtime prefixes for `discover(cached=...)`, newest generation first."""
    host = host or Host.current()
    fs = fs or OsWritableFileSystem()
    pm = _pm(host)
    try:
        root = data_root(host)
    except BootstrapError:
        return []
    found: list[tuple[str, int, str]] = []
    for name in fs.listdir(pm.join(root, "runtimes")):
        match = _GENERATION.fullmatch(name)
        if match is None:
            continue
        lay = layout(root, name, console_script, host.windows)
        sentinel = _parse_ready(fs.read_text(lay.ready), lay)
        if sentinel is not None:
            found.append((sentinel["created"], int(match.group(2)), lay.venv))
    return [prefix for _, _, prefix in sorted(found, reverse=True)]


def _stderr(message: str) -> None:
    stream = sys.stderr
    if stream is not None:
        stream.write(f"visionset plugin: {message}\n")
        stream.flush()


def _opted_out(value: str | None) -> bool:
    return value is not None and value.strip().casefold() not in _FALSE


def _index_tokens(value: str) -> list[str]:
    tokens: list[str] = []
    for item in value.split():
        tokens.append(item)
        try:
            parts = urlsplit(item)
        except ValueError:
            continue
        if not parts.netloc:
            continue
        if "@" in parts.netloc:
            tokens.append(parts.netloc.rsplit("@", 1)[0])
        if parts.path.strip("/") and parts.path.strip("/") not in _COMMON_SEGMENTS:
            tokens.append(parts.path)
        tokens += [
            segment
            for segment in parts.path.split("/")
            if len(segment) >= 6 and segment.casefold() not in _COMMON_SEGMENTS
        ]
        tokens += [part for part in (parts.query, parts.fragment) if part]
    return tokens


def _lease_fds(lease: Lease) -> Sequence[int]:
    return () if lease.fd is None else (lease.fd,)


class _Job:
    def __init__(
        self,
        bundle: Bundle,
        host: Host,
        fs: WritableFileSystem,
        run: InstallRunner,
        clock: Clock,
        progress: Callable[[str], None],
        install_timeout: float,
    ) -> None:
        self.bundle = bundle
        self.host = host
        self.fs = fs
        self.run = run
        self.clock = clock
        self.progress_sink = progress
        self.install_timeout = install_timeout
        self.pm = _pm(host)
        self.env = {
            k: v
            for k, v in host.env.items()
            if k.upper() not in PROBE_ENV_SCRUB
            and (not k.upper().startswith("PIP_") or k.upper() in PIP_ENV_KEEP)
            and k.upper() != "PYTHONUSERBASE"
        }
        self.env["NO_COLOR"] = "1"
        self.sensitive: set[str] = set()
        for name in INDEX_ENV:
            value = host.get(name)
            if value:
                self.sensitive.update(_index_tokens(value))
        self.requirement = f"{bundle.distribution}{bundle.compatibility.strip()}"
        self.wanted = _wanted_version(bundle.compatibility)
        self.manual = f"install it yourself: pipx install '{self.requirement}'"
        self.log: str | None = None
        self.keep_fds: Sequence[int] = ()

    def shown(self, text: str) -> str:
        for token in sorted(self.sensitive, key=len, reverse=True):
            if len(token) >= 4:
                text = text.replace(token, "<redacted>")
        return redact(text, self.host)

    def progress(self, message: str) -> None:
        self.progress_sink(self.shown(message))

    def fail(self, code: Code, message: str, hint: str = "") -> BootstrapError:
        log = self.shown(self.log) if self.log else None
        return BootstrapError(code, self.shown(message), hint or self.manual, log)

    def disk(self, action: str, path: str, call: Callable[[], Any]) -> Any:
        try:
            return call()
        except OSError as error:
            reason = error.strerror or type(error).__name__
            raise self.fail(Code.BAD_DATA_DIR, f"cannot {action} {path}: {reason}") from None

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
        # A Microsoft Store alias that installs nothing fails here like any broken interpreter.
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

    def record(self, argv: Sequence[str], result: ProbeResult) -> None:
        if self.log is None:
            return
        lines = [f"$ {self.shown(' '.join(argv))}"]
        for stream in (result.stdout, result.stderr):
            text = stream.decode("utf-8", "replace")
            lines += [self.shown(line) for line in text.splitlines() if line.strip()]
        status = result.error or ("timed out" if result.timed_out else result.returncode)
        lines.append(f"# exit: {status}")
        with contextlib.suppress(OSError):
            self.fs.append_private(self.log, "\n".join(lines) + "\n")

    def step(
        self, argv: Sequence[str], cwd: str, timeout: float, cap: int, log: bool = True
    ) -> ProbeResult:
        result = self.run(argv, cwd, self.env, timeout, cap, pass_fds=self.keep_fds)
        if log:
            self.record(argv, result)
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

    # Generations

    def runtimes(self, root: str) -> str:
        return str(self.pm.join(root, "runtimes"))

    def generations(self, root: str, base: str) -> list[tuple[int, Layout]]:
        found = []
        for name in self.fs.listdir(self.runtimes(root)):
            match = _GENERATION.fullmatch(name)
            if match and match.group(1) == base:
                lay = layout(root, name, self.bundle.console_script, self.host.windows)
                found.append((int(match.group(2)), lay))
        return sorted(found, key=lambda item: item[0], reverse=True)

    def owned(self, path: str, base: str, key: str | None) -> bool:
        marker = _marker(self.fs.read_text(str(self.pm.join(path, ".owner"))))
        if marker is not None:
            return marker.get("base") == base and (key is None or marker.get("key") == key)
        # A generation killed before its marker was in place holds nothing else.
        return set(self.fs.listdir(path)) <= OWNER_ENTRIES and self.fs.is_dir(path)

    def verify(self, lay: Layout) -> str:
        """`ok`, `dead` when the runtime fails twice the same way, or `transient`."""
        outcome = "dead"
        for _ in (1, 2):
            outcome = self._probe_runtime(lay)
            if outcome != "dead":
                return outcome
        return outcome

    def _probe_runtime(self, lay: Layout) -> str:
        cwd = str(self.pm.dirname(lay.console_script))
        for args in (["--version"], ["mcp", "--help"]):
            if not (self.fs.is_file(lay.python) and self.fs.is_file(lay.console_script)):
                return "dead"
            result = self.run(
                [lay.console_script, *args], cwd, self.env, VALIDATION_TIMEOUT, OUTPUT_CAP
            )
            if result.error is not None or result.timed_out or result.overflow:
                gone = not (self.fs.is_file(lay.python) and self.fs.is_file(lay.console_script))
                return "dead" if gone else "transient"
            if result.returncode != 0:
                return "dead"
            if args == ["--version"]:
                version = result.stdout.decode("utf-8", "replace").strip()
                if _version_key(version) != self.wanted:
                    return "dead"
        return "ok"

    def reuse(self, root: str, base: str) -> Bootstrapped | None:
        for _, lay in self.generations(root, base):
            sentinel = _parse_ready(self.fs.read_text(lay.ready), lay)
            if sentinel is None:
                continue
            outcome = self.verify(lay)
            if outcome == "dead":
                self.progress(f"the cached runtime {lay.key} no longer works; building a new one")
                return None
            if outcome == "transient":
                self.progress(f"the cached runtime {lay.key} did not answer; using it anyway")
            return Bootstrapped(lay.venv, lay.console_script, sentinel["version"], reused=True)
        return None

    def discard(self, path: str, base: str) -> None:
        trash = str(self.pm.join(self.pm.dirname(path), f".trash-{base}-{os.urandom(6).hex()}"))
        try:
            self.fs.replace(path, trash)
        except OSError as error:
            reason = error.strerror or type(error).__name__
            raise self.fail(
                Code.CLEANUP_FAILED,
                f"cannot move the incomplete runtime {path} aside: {reason}",
                hint="close any program using it and try again, or remove it yourself",
            ) from None
        self.remove_trash(trash)

    def remove_trash(self, trash: str) -> None:
        try:
            self.fs.remove_tree(trash)
        except OSError:
            self.progress(f"could not remove {trash} yet; a later setup retries")

    def tidy(self, root: str, base: str) -> int:
        """Remove owned incomplete generations and trash; return the next generation number."""
        runtimes = self.runtimes(root)
        for name in self.fs.listdir(runtimes):
            if name.startswith(f".trash-{base}-"):
                path = str(self.pm.join(runtimes, name))
                if self.owned(path, base, None):
                    self.remove_trash(path)
        highest = 0
        for number, lay in self.generations(root, base):
            highest = max(highest, number)
            if _parse_ready(self.fs.read_text(lay.ready), lay) is not None:
                continue
            if self.owned(lay.runtime, base, lay.key):
                self.progress(f"removing the incomplete runtime {lay.key}")
                self.discard(lay.runtime, base)
        return highest + 1

    def build(self, root: str, base: str, number: int, interpreter: Interpreter) -> Bootstrapped:
        lay = layout(root, f"{base}-r{number}", self.bundle.console_script, self.host.windows)
        deadline = self.clock.monotonic() + self.install_timeout
        shown_version = ".".join(map(str, interpreter.version))
        self.progress(
            f"creating a private runtime for {self.requirement} with Python {shown_version} "
            f"in {lay.runtime}"
        )
        marker = json.dumps({"owner": OWNER, "base": base, "key": lay.key}) + "\n"
        self.disk("create", lay.runtime, lambda: self.fs.makedirs(lay.runtime))
        try:
            self.disk("write", lay.owner, lambda: self.fs.write_new(lay.owner + ".tmp", marker))
            self.disk("write", lay.owner, lambda: self.fs.replace(lay.owner + ".tmp", lay.owner))
            found = self._populate(lay, interpreter, deadline)
            self._publish(lay, interpreter, found)
        except BaseException:
            with contextlib.suppress(BootstrapError, OSError):
                self.discard(lay.runtime, base)
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
            "--no-user",
            self.requirement,
        ]

    def check_pip_config(self, lay: Layout) -> None:
        argv = [lay.python, "-I", "-m", "pip", "config", "list"]
        result = self.step(argv, lay.runtime, PROBE_TIMEOUT, OUTPUT_CAP, log=False)
        settings: list[tuple[str, str, str]] = []
        if result.error is None and not result.timed_out and result.returncode == 0:
            for line in result.stdout.decode("utf-8", "replace").splitlines():
                match = _CONFIG_LINE.match(line.strip())
                if match:
                    settings.append((match.group(1), match.group(2), match.group(3)))
        for _, key, value in settings:
            if key in _INDEX_KEYS and value:
                self.sensitive.update(_index_tokens(value))
        self.record(argv, result)
        for section, key, value in settings:
            location = key in _CONFIG_LOCATION_KEYS and value.strip()
            switch = key in _CONFIG_SWITCH_KEYS and value.strip().casefold() not in _FALSE
            if location or switch:
                raise self.fail(
                    Code.BAD_PIP_CONFIG,
                    f"pip is configured with {section}.{key}, which would install outside "
                    "the private runtime or add to it",
                    hint="remove that setting from pip.conf or PIP_CONFIG_FILE for this "
                    f"setup; or {self.manual}",
                )

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
        self.check_pip_config(lay)
        self.progress(f"installing {self.requirement}")
        argv = self.install_argv(lay)
        for attempt in (1, 2):
            result = self.step(argv, lay.runtime, self.remaining(deadline), PIP_OUTPUT_CAP)
            if result.timed_out:
                raise self.timed_out()
            if result.error is None and result.returncode == 0 and not result.overflow:
                break
            output = (result.stdout + result.stderr).decode("utf-8", "replace")
            if result.error is None and not result.overflow and _NETWORK.search(output):
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
            host=dataclasses.replace(self.host, env=self.env),
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
            "console_script": lay.console_script,
            "python": interpreter.executable,
            "pip_args_digest": digest.hexdigest(),
            "created": created.strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        }
        staged = lay.ready + ".tmp"
        text = json.dumps(sentinel, indent=2, sort_keys=True) + "\n"
        self.disk("write", staged, lambda: self.fs.write_new(staged, text))
        if _parse_ready(self.fs.read_text(staged), lay) is None:
            raise self.fail(Code.VALIDATION_FAILED, "the readiness file did not read back")
        self.disk("publish", lay.ready, lambda: self.fs.replace(staged, lay.ready))


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
    run: InstallRunner = run_bounded,
    locker: Locker | None = None,
    clock: Clock | None = None,
    python: str | None = sys.executable,
    project: str | None = None,
    plugin_root: str | None = str(Path(__file__).resolve().parent.parent),
    lock_timeout: float = LOCK_TIMEOUT,
    install_timeout: float = INSTALL_TIMEOUT,
    progress: Callable[[str], None] = _stderr,
) -> Bootstrapped:
    """Return the plugin-owned runtime for the bundle's range, building it if needed.

    `python` is the interpreter tried first, normally the one running this module. `project`
    is the absolute directory the agent works in, when known. Raises `BootstrapError`; never
    writes to stdout.
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
    outside = f"set {DATA_ENV} to a directory outside it"
    if plugin_root is not None and _inside(root, plugin_root, host, fs):
        raise job.fail(Code.BAD_DATA_DIR, "the data directory lies inside the plugin", outside)
    if project is not None and _absolute(project, host):
        for where in {project, checkout_of(project, host, fs)}:
            if _inside(root, where, host, fs):
                raise job.fail(
                    Code.BAD_DATA_DIR, "the data directory lies inside the project", outside
                )
    for directory in (root, *(str(job.pm.join(root, d)) for d in ("runtimes", "locks", "logs"))):
        job.disk("create", directory, functools.partial(fs.makedirs, directory))
        reason = job.disk("inspect", directory, functools.partial(fs.unsafe_reason, directory))
        if reason is not None:
            raise job.fail(
                Code.BAD_DATA_DIR,
                f"the data directory {directory} {reason}",
                hint=f"fix its ownership or permissions, or set {DATA_ENV}",
            )
    interpreter = job.select_python(python)
    version = bundle.compatibility.strip().removeprefix("==").strip()
    base = runtime_key(version, interpreter)
    lay = layout(root, base, bundle.console_script, host.windows)
    job.log = lay.log

    ready = job.reuse(root, base)
    if ready is not None:
        return ready
    lease = job.disk("lock", lay.lock, lambda: locker.acquire(lay.lock, lock_timeout))
    if lease is None:
        raise job.fail(
            Code.LOCK_TIMEOUT,
            f"another setup of this runtime is still running after {lock_timeout:g} s",
            hint="wait for it to finish (or stop a leftover pip process) and try again",
        )
    try:
        ready = job.reuse(root, base)
        if ready is not None:
            return ready
        job.keep_fds = () if host.windows else _lease_fds(lease)
        number = job.tidy(root, base)
        return job.build(root, base, number, interpreter)
    finally:
        lease.release()
