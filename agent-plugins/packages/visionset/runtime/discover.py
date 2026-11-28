"""Find a `visionset` the bundle's compatibility range accepts.

Order: an explicit operator override, a user installation, a project installation, then the
plugin-owned cached runtime. The range is `compatibility` in `bundle.json`. A candidate is
only ever run, never modified.

A candidate's tier comes from where it was found, never from where a link resolves: a pipx
or uv tool link in `~/.local/bin` is a user install although it points into a virtual
environment. An invalid override is reported and nothing else is tried. No candidate inside
the checkout, whatever its tier, is run unless the host trusts the project.

This module writes nothing to stdout and reaches no network; the launcher owns both.
"""

from __future__ import annotations

import contextlib
import json
import ntpath
import os
import posixpath
import re
import select
import signal
import subprocess
import sys
import threading
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Protocol

OVERRIDE_ENV = "VISIONSET_PLUGIN_EXECUTABLE"
PROBE_TIMEOUT = 10.0
OUTPUT_CAP = 64 * 1024
REASON_TAIL = 400
BATCH_SUFFIXES = (".cmd", ".bat")
# Variables that make a Python console script load or run code other than its own.
PROBE_ENV_SCRUB = frozenset(
    {
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONSTARTUP",
        "PYTHONINSPECT",
        "PYTHONEXECUTABLE",
        "PYTHONBREAKPOINT",
        "PYTHONWARNINGS",
        "PYTHONDEBUG",
        "PYTHONVERBOSE",
        "PYTHONDEVMODE",
        "PYTHONPROFILEIMPORTTIME",
        "__PYVENV_LAUNCHER__",
    }
)


class BundleError(Exception):
    """`bundle.json` is missing, malformed or names a range this module cannot read."""


class Tier(Enum):
    OVERRIDE = "override"
    USER = "user"
    PROJECT = "project"
    CACHE = "cache"


@dataclass(frozen=True)
class Bundle:
    distribution: str
    console_script: str
    compatibility: str


@dataclass(frozen=True)
class Candidate:
    path: str
    tier: Tier
    source: str
    in_checkout: bool = False


@dataclass(frozen=True)
class Found:
    candidate: Candidate
    version: str


@dataclass(frozen=True)
class Skipped:
    candidate: Candidate
    reason: str


@dataclass(frozen=True)
class Discovery:
    """`selected is None and failure is None` means nothing usable was found."""

    selected: Found | None
    skipped: tuple[Skipped, ...]
    failure: str | None = None


@dataclass(frozen=True)
class ProbeResult:
    returncode: int | None
    stdout: bytes = b""
    stderr: bytes = b""
    timed_out: bool = False
    overflow: bool = False
    error: str | None = None


Runner = Callable[[Sequence[str], str, Mapping[str, str], float, int], ProbeResult]


class FileSystem(Protocol):
    def lexists(self, path: str) -> bool: ...
    def is_file(self, path: str) -> bool: ...
    def is_dir(self, path: str) -> bool: ...
    def is_executable(self, path: str) -> bool: ...
    def realpath(self, path: str) -> str: ...
    def listdir(self, path: str) -> list[str]: ...
    def read_head(self, path: str) -> str: ...


class OsFileSystem:
    def lexists(self, path: str) -> bool:
        return os.path.lexists(path)

    def is_file(self, path: str) -> bool:
        return os.path.isfile(path)

    def is_dir(self, path: str) -> bool:
        return os.path.isdir(path)

    def is_executable(self, path: str) -> bool:
        return os.access(path, os.X_OK)

    def realpath(self, path: str) -> str:
        return os.path.realpath(path)

    def listdir(self, path: str) -> list[str]:
        try:
            return os.listdir(path)
        except OSError:
            return []

    def read_head(self, path: str) -> str:
        try:
            with open(path, encoding="utf-8", errors="replace") as handle:
                return handle.read(4096)
        except OSError:
            return ""


@dataclass(frozen=True)
class Host:
    env: Mapping[str, str]
    windows: bool
    home: str | None
    fold_case: bool = False

    @classmethod
    def current(cls) -> Host:
        home = os.path.expanduser("~")
        return cls(
            env=dict(os.environ),
            windows=os.name == "nt",
            home=None if home == "~" else home,
            fold_case=sys.platform == "darwin",
        )

    @property
    def case_insensitive(self) -> bool:
        return self.windows or self.fold_case

    def get(self, name: str) -> str | None:
        if self.windows:
            folded = name.upper()
            value = next((v for k, v in self.env.items() if k.upper() == folded), None)
        else:
            value = self.env.get(name)
        return value or None


def load_bundle(path: Path) -> Bundle:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        bundle = Bundle(
            distribution=str(data["distribution"]),
            console_script=str(data["console_script"]),
            compatibility=str(data["compatibility"]),
        )
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise BundleError(f"cannot read {path.name}: {error}") from error
    _wanted_version(bundle.compatibility)
    return bundle


_VERSION = re.compile(r"([0-9]+(?:\.[0-9]+)*)(?:(a|b|rc)([0-9]+))?(?:\.dev([0-9]+))?")
_VersionKey = tuple[tuple[int, ...], str | None, int | None, int | None]


def _version_key(text: str) -> _VersionKey | None:
    match = _VERSION.fullmatch(text.strip().lower())
    if match is None:
        return None
    release = [int(part) for part in match.group(1).split(".")]
    while len(release) > 1 and release[-1] == 0:
        release.pop()
    pre_n, dev = match.group(3), match.group(4)
    return (
        tuple(release),
        match.group(2),
        None if pre_n is None else int(pre_n),
        None if dev is None else int(dev),
    )


def _wanted_version(compatibility: str) -> _VersionKey:
    operator, _, version = compatibility.strip().partition("==")
    key = _version_key(version)
    if operator or key is None:
        raise BundleError(f"unsupported range {compatibility!r}; expected '==VERSION'")
    return key


_CONTROL = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]")
_SECRET_NAME = re.compile(r"TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|AUTH|COOKIE", re.IGNORECASE)
_NOT_SECRET = frozenset({"0", "1", "true", "false", "yes", "no", "on", "off"})
_KEY = (
    r"[\w-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key"
    r"|credentials?)[\w-]*"
)
_VALUE = r"(?:\"[^\"]*\"|'[^']*'|[^\s,;}\]]+)"
_PATH_END = r"[^\\/\s'\":;,)\]]+"
_SECRET_SHAPES: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(
            r"-----BEGIN[A-Z ]*PRIVATE KEY-----.*?(?:-----END[A-Z ]*PRIVATE KEY-----|\Z)", re.DOTALL
        ),
        "<redacted>",
    ),
    (re.compile(r"(?i)\b((?:proxy-)?authorization[\"']?\s*[:=]\s*)[^\r\n]*"), r"\1<redacted>"),
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 <redacted>"),
    (re.compile(r"(?i)((?:\b[a-z][a-z0-9+.-]*:)?//)[^/\s]+@"), r"\1<redacted>@"),
    (re.compile(rf"(?i)([\"']?)({_KEY})\1(\s*[=:]\s*){_VALUE}"), r"\1\2\1\3<redacted>"),
    (re.compile(rf"(?i)(--?{_KEY})(\s+)(?!-){_VALUE}"), r"\1\2<redacted>"),
    (
        re.compile(
            r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{16,}"
            r"|hf_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}"
            r"|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9_-]{16,})"
        ),
        "<redacted>",
    ),
)
_ANY_HOME = (
    re.compile(rf"(?i)(?<![\w])[a-z]:[\\/]users[\\/]{_PATH_END}"),
    re.compile(rf"(?i)(?<![\w.~/\\:-])/(?:home|users)/{_PATH_END}"),
)


def redact(text: str, host: Host) -> str:
    """Make text from a candidate safe to show: no secrets, no home directory, one line."""
    text = _CONTROL.sub(" ", text)
    secrets = {
        v
        for k, v in host.env.items()
        if _SECRET_NAME.search(k) and v and v.casefold() not in _NOT_SECRET
    }
    for secret in sorted(secrets, key=len, reverse=True):
        if len(secret) >= 6:
            text = text.replace(secret, "<redacted>")
        else:
            text = re.sub(rf"(?<!\w){re.escape(secret)}(?!\w)", "<redacted>", text)
    for pattern, replacement in _SECRET_SHAPES:
        text = pattern.sub(replacement, text)
    if host.home and host.home.rstrip("/\\"):
        home = host.home.rstrip("/\\")
        flags = re.IGNORECASE if host.case_insensitive else 0
        for spelling in {home, home.replace("\\", "/")}:
            text = re.sub(re.escape(spelling) + r"(?=$|[\\/\s'\":;,)\]])", "~", text, flags=flags)
    for pattern in _ANY_HOME:
        text = pattern.sub("~", text)
    return " ".join(text.split())


def describe(skipped: Skipped, host: Host) -> str:
    candidate = skipped.candidate
    where = redact(candidate.path, host)
    return f"{candidate.tier.value} ({candidate.source}) {where}: {skipped.reason}"


def _kill(process: subprocess.Popen[bytes]) -> None:
    if os.name != "nt":
        try:
            os.killpg(process.pid, signal.SIGKILL)
            return
        except OSError:
            pass
    with contextlib.suppress(OSError):
        process.kill()


def run_bounded(
    argv: Sequence[str], cwd: str, env: Mapping[str, str], timeout: float, cap: int
) -> ProbeResult:
    """Run argv without a shell, stdin closed, output captured and capped, within timeout."""
    windows = os.name == "nt"
    flags = 0
    if windows:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0
        )
    try:
        process = subprocess.Popen(
            list(argv),
            cwd=cwd,
            env=dict(env),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            start_new_session=not windows,
            creationflags=flags,
        )
    except OSError as error:
        return ProbeResult(None, error=error.strerror or type(error).__name__)

    overflow = threading.Event()
    stop = threading.Event()
    captured = {"stdout": bytearray(), "stderr": bytearray()}

    def drain(name: str, fd: int) -> None:
        buffer = captured[name]
        size = 0
        try:
            while not stop.is_set():
                if not windows and not select.select([fd], [], [], 0.05)[0]:
                    continue
                chunk = os.read(fd, 8192)
                if not chunk:
                    return
                buffer.extend(chunk[: max(cap - size, 0)])
                size += len(chunk)
                if size > cap:
                    overflow.set()
                    _kill(process)
                    return
        except (OSError, ValueError):
            return

    streams = [stream for stream in (process.stdout, process.stderr) if stream is not None]
    readers = [
        threading.Thread(target=drain, args=(name, stream.fileno()), daemon=True)
        for name, stream in zip(("stdout", "stderr"), streams, strict=True)
    ]

    def settle(seconds: float) -> bool:
        for reader in readers:
            reader.join(seconds)
        return not any(reader.is_alive() for reader in readers)

    for reader in readers:
        reader.start()
    timed_out = False
    try:
        process.wait(timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill(process)
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(5)
    if not settle(0.5):
        # A descendant still holds a pipe open after the probe itself has exited.
        _kill(process)
        if not settle(0.5):
            stop.set()
            settle(0.2)
    if settle(0):
        for stream in streams:
            stream.close()
    return ProbeResult(
        process.returncode,
        bytes(captured["stdout"]),
        bytes(captured["stderr"]),
        timed_out=timed_out,
        overflow=overflow.is_set(),
    )


class _Search:
    def __init__(
        self,
        host: Host,
        fs: FileSystem,
        distribution: str,
        console_script: str,
        project: str | None,
        cached: Sequence[str],
    ) -> None:
        self.host = host
        self.fs = fs
        self.pm = ntpath if host.windows else posixpath
        self.distribution = distribution
        self.console_script = console_script
        self.cached = cached
        self.ancestors: list[str] = []
        self.checkout: str | None = None
        if project is not None:
            if not self.absolute(project):
                raise ValueError("project must be an absolute path")
            self.ancestors, self.checkout = self._find_checkout(self.pm.normpath(project))
        self.env_dirs = self._env_mappings()

    def key(self, path: str) -> str:
        key = str(self.pm.normcase(self.pm.normpath(path)))
        return key.casefold() if self.host.case_insensitive else key

    def absolute(self, path: str) -> bool:
        if not self.host.windows:
            return posixpath.isabs(path)
        drive, rest = ntpath.splitdrive(path)
        return bool(drive) and rest[:1] in ("\\", "/")

    def inside(self, path: str, root: str) -> bool:
        sep = "\\" if self.host.windows else "/"
        for child, parent in ((path, root), (self.fs.realpath(path), self.fs.realpath(root))):
            child_key, parent_key = self.key(child), self.key(parent)
            if child_key == parent_key or child_key.startswith(parent_key.rstrip(sep) + sep):
                return True
        return False

    def scripts(self, prefix: str) -> str:
        return str(self.pm.join(prefix, "Scripts" if self.host.windows else "bin"))

    def _find_checkout(self, project: str) -> tuple[list[str], str | None]:
        home = self.key(self.host.home) if self.host.home else None
        sep = "\\" if self.host.windows else "/"
        under_home = home is not None and self.key(project).startswith(home.rstrip(sep) + sep)
        walk: list[str] = [project]
        while self.key(walk[-1]) != home:
            parent = self.pm.dirname(walk[-1])
            if parent == walk[-1] or (under_home and self.key(parent) == home):
                break
            walk.append(parent)

        def marked(index: int, names: tuple[str, ...]) -> bool:
            directory = walk[index]
            if self.pm.dirname(directory) == directory:
                return False
            return any(self.fs.lexists(self.pm.join(directory, name)) for name in names)

        for index in range(len(walk)):
            if marked(index, (".git",)):
                while self._is_submodule(walk[index]):
                    outer = [j for j in range(index + 1, len(walk)) if marked(j, (".git",))]
                    if not outer:
                        break
                    index = outer[0]
                return walk[: index + 1], walk[index]
        for index in range(len(walk)):
            if marked(index, ("pyproject.toml", ".venv", "venv")):
                return walk[: index + 1], walk[index]
        return walk[:1], walk[0]

    def _is_submodule(self, directory: str) -> bool:
        gitlink = self.pm.join(directory, ".git")
        if not self.fs.is_file(gitlink):
            return False
        match = re.match(r"gitdir:\s*(\S.*)", self.fs.read_head(gitlink).strip())
        return bool(match and re.search(r"(^|[\\/])\.git[\\/]modules[\\/]", match.group(1)))

    def _env_mappings(self) -> list[tuple[str, str]]:
        found: list[tuple[str, str]] = []
        virtual_env = self.host.get("VIRTUAL_ENV")
        if virtual_env and self.absolute(virtual_env):
            found.append((self.scripts(virtual_env), "VIRTUAL_ENV"))
        conda = self.host.get("CONDA_PREFIX")
        if conda and self.absolute(conda) and self.host.get("CONDA_DEFAULT_ENV") != "base":
            found.append((self.scripts(conda), "CONDA_PREFIX"))
        uv_env = self.host.get("UV_PROJECT_ENVIRONMENT")
        if uv_env and not self.pm.isabs(uv_env) and self.checkout is not None:
            uv_env = self.pm.join(self.checkout, uv_env)
        if uv_env and self.absolute(uv_env):
            found.append((self.scripts(uv_env), "UV_PROJECT_ENVIRONMENT"))
        return found

    def path_dirs(self) -> list[str]:
        raw = self.host.get("PATH") or ""
        entries = []
        for entry in raw.split(self.pm.pathsep):
            entry = entry.strip().strip('"') if self.host.windows else entry
            if entry:
                entries.append(entry)
        return entries

    def is_project_dir(self, directory: str) -> bool:
        env_keys = {self.key(d) for d, _ in self.env_dirs}
        if self.key(directory) in env_keys:
            return True
        return self.checkout is not None and self.inside(directory, self.checkout)

    def _home(self, *parts: str) -> str | None:
        return self.pm.join(self.host.home, *parts) if self.host.home else None

    def _python_dirs(self, base: str | None, pattern: str, *tail: str) -> list[str]:
        if base is None:
            return []
        versions = []
        for name in self.fs.listdir(base):
            match = re.fullmatch(pattern, name, re.IGNORECASE)
            if match:
                versions.append((int(match.group(1)), name))
        return [self.pm.join(base, name, *tail) for _, name in sorted(versions, reverse=True)]

    def user_dirs(self) -> list[tuple[str | None, str]]:
        get, home = self.host.get, self._home
        local_bin = home(".local", "bin")
        data_home = get("XDG_DATA_HOME") or home(".local", "share")
        dirs: list[tuple[str | None, str]] = [(get("PIPX_BIN_DIR") or local_bin, "pipx")]
        uv_bin = get("UV_TOOL_BIN_DIR") or get("XDG_BIN_HOME")
        xdg_data = get("XDG_DATA_HOME")
        if uv_bin is None and xdg_data:
            uv_bin = self.pm.join(self.pm.dirname(self.pm.normpath(xdg_data)), "bin")
        dirs.append((uv_bin or local_bin, "uv tool"))
        user_base = get("PYTHONUSERBASE")
        if self.host.windows:
            appdata = get("APPDATA")
            base = user_base or (self.pm.join(appdata, "Python") if appdata else None)
            found = self._python_dirs(base, r"Python3(\d+)", "Scripts")
            dirs += [(d, "user scripts") for d in found]
        elif user_base:
            dirs.append((self.pm.join(user_base, "bin"), "user scripts"))
        else:
            dirs.append((local_bin, "user scripts"))
            mac = home("Library", "Python")
            dirs += [(d, "user scripts") for d in self._python_dirs(mac, r"3\.(\d+)", "bin")]

        pipx_homes: list[str | None]
        if get("PIPX_HOME"):
            pipx_homes = [get("PIPX_HOME")]
        elif self.host.windows:
            local = get("LOCALAPPDATA")
            pipx_homes = [home("pipx"), self.pm.join(local, "pipx", "pipx") if local else None]
        else:
            pipx_homes = [
                self.pm.join(data_home, "pipx") if data_home else None,
                home(".local", "pipx"),
                home("Library", "Application Support", "pipx"),
            ]
        for pipx_home in pipx_homes:
            if pipx_home:
                prefix = self.pm.join(pipx_home, "venvs", self.distribution)
                dirs.append((self.scripts(prefix), "pipx"))

        tool_dir = get("UV_TOOL_DIR")
        if tool_dir is None:
            if self.host.windows:
                appdata = get("APPDATA")
                tool_dir = self.pm.join(appdata, "uv", "data", "tools") if appdata else None
            elif data_home:
                tool_dir = self.pm.join(data_home, "uv", "tools")
        if tool_dir:
            dirs.append((self.scripts(self.pm.join(tool_dir, self.distribution)), "uv tool"))
        return dirs

    def executables(self, directory: str) -> list[str]:
        if not self.host.windows:
            return [self.pm.join(directory, self.console_script)]
        names = [self.console_script + ".exe"] + [self.console_script + s for s in BATCH_SUFFIXES]
        return [self.pm.join(directory, name) for name in names]

    def candidates(self) -> Iterator[Candidate]:
        seen: set[str] = set()

        def emit(directory: str | None, tier: Tier, source: str) -> Iterator[Candidate]:
            if not directory or not self.absolute(directory):
                return
            for path in self.executables(self.pm.normpath(directory)):
                if self.key(path) in seen:
                    break
                if not self.fs.lexists(path):
                    continue
                seen.add(self.key(path))
                in_checkout = self.checkout is not None and self.inside(path, self.checkout)
                yield Candidate(path, tier, source, in_checkout)
                break

        path_dirs = self.path_dirs()
        for directory in path_dirs:
            if not self.is_project_dir(directory):
                yield from emit(directory, Tier.USER, "PATH")
        for user_dir, source in self.user_dirs():
            yield from emit(user_dir, Tier.USER, source)
        for env_dir, source in self.env_dirs:
            yield from emit(env_dir, Tier.PROJECT, source)
        for directory in path_dirs:
            if self.is_project_dir(directory):
                yield from emit(directory, Tier.PROJECT, "PATH")
        for ancestor in self.ancestors:
            for name in (".venv", "venv"):
                yield from emit(self.scripts(self.pm.join(ancestor, name)), Tier.PROJECT, name)
        for prefix in self.cached:
            yield from emit(self.scripts(prefix), Tier.CACHE, "cache")


class _Checker:
    def __init__(
        self,
        search: _Search,
        wanted: _VersionKey,
        compatibility: str,
        project_trusted: bool,
        run: Runner,
        timeout: float,
    ) -> None:
        self.search = search
        self.host = search.host
        self.fs = search.fs
        self.wanted = wanted
        self.compatibility = compatibility
        self.project_trusted = project_trusted
        self.run = run
        self.timeout = timeout
        self.probed: dict[str, str] = {}
        self.env = {k: v for k, v in self.host.env.items() if k.upper() not in PROBE_ENV_SCRUB}
        self.env["NO_COLOR"] = "1"

    def check(self, candidate: Candidate) -> Found | Skipped:
        reason = self._refusal(candidate)
        if reason is not None:
            return Skipped(candidate, reason)
        real = self.search.key(self.fs.realpath(candidate.path))
        if real in self.probed:
            return Skipped(candidate, f"same executable as {self.probed[real]}")
        self.probed[real] = redact(candidate.path, self.host)
        version, reason = self._probe(candidate.path, ["--version"])
        if reason is None:
            version = version.strip()
            key = _version_key(version)
            if key is None:
                printed = redact(version, self.host)[:REASON_TAIL] or "nothing"
                reason = f"`--version` printed no version: {printed}"
            elif key != self.wanted:
                reason = f"version {version} is outside {self.compatibility}"
            else:
                _, reason = self._probe(candidate.path, ["mcp", "--help"])
        if reason is not None:
            return Skipped(candidate, reason)
        return Found(candidate, version)

    def _refusal(self, candidate: Candidate) -> str | None:
        path = candidate.path
        if candidate.in_checkout and not self.project_trusted:
            return "inside the project checkout, which the host has not trusted; not run"
        if not self.search.absolute(path):
            return "is not an absolute path"
        if self.host.windows and path.lower().endswith(BATCH_SUFFIXES):
            return "is a batch-file shim, which needs a shell; not run"
        if not self.fs.lexists(path):
            return "does not exist"
        if not self.fs.is_file(path):
            return "is a directory" if self.fs.is_dir(path) else "is a broken link"
        if not self.fs.is_executable(path):
            return "is not executable"
        return None

    def _probe(self, path: str, args: list[str]) -> tuple[str, str | None]:
        label = "`" + " ".join(args) + "`"
        cwd = self.search.pm.dirname(path)
        result = self.run([path, *args], cwd, self.env, self.timeout, OUTPUT_CAP)
        stdout = result.stdout.decode("utf-8", "replace")
        stderr = result.stderr.decode("utf-8", "replace")
        if result.error is not None:
            return stdout, f"could not be started: {result.error}"
        if result.timed_out:
            return stdout, f"{label} did not finish within {self.timeout:g} s"
        if result.overflow:
            return stdout, f"{label} wrote more than {OUTPUT_CAP} bytes"
        if result.returncode != 0:
            detail = redact(stderr, self.host)[-REASON_TAIL:] or "no output"
            return stdout, f"{label} exited with {result.returncode}: {detail}"
        return stdout, None


def discover(
    *,
    compatibility: str,
    console_script: str = "visionset",
    distribution: str = "visionset",
    host: Host | None = None,
    project: str | None = None,
    project_trusted: bool = False,
    cached: Sequence[str] = (),
    fs: FileSystem | None = None,
    run: Runner = run_bounded,
    probe_timeout: float = PROBE_TIMEOUT,
) -> Discovery:
    """Return the first compatible candidate in tier order, and every candidate skipped before it.

    `project` is the directory the agent works in, absolute, or None when unknown;
    `project_trusted` is the host's verdict on it. `cached` lists plugin-owned runtime
    prefixes the bootstrap has published, most preferred first.
    """
    host = host or Host.current()
    wanted = _wanted_version(compatibility)
    search = _Search(host, fs or OsFileSystem(), distribution, console_script, project, cached)
    checker = _Checker(search, wanted, compatibility, project_trusted, run, probe_timeout)

    override = host.get(OVERRIDE_ENV)
    if override is not None:
        verdict = checker.check(Candidate(override, Tier.OVERRIDE, OVERRIDE_ENV))
        if isinstance(verdict, Found):
            return Discovery(verdict, ())
        failure = f"{OVERRIDE_ENV}={redact(override, host)} cannot be used: {verdict.reason}"
        return Discovery(None, (verdict,), failure)

    skipped: list[Skipped] = []
    for candidate in search.candidates():
        verdict = checker.check(candidate)
        if isinstance(verdict, Found):
            return Discovery(verdict, tuple(skipped))
        skipped.append(verdict)
    return Discovery(None, tuple(skipped))
