"""Bootstrap with real interpreters, real virtual environments, real pip and real processes.

No install here reaches a network: pip installs from a local wheel directory with `--no-index`
through its own environment variables, which is also how an air-gapped user would do it.
"""

from __future__ import annotations

import base64
import contextlib
import csv
import hashlib
import io
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from collections.abc import Mapping, Sequence
from pathlib import Path

import _support
from bootstrap import (
    DATA_ENV,
    BootstrapError,
    Bootstrapped,
    Code,
    SystemClock,
    cached_prefixes,
)
from bootstrap import bootstrap as run_bootstrap
from discover import Bundle, Host, ProbeResult, Tier, discover, load_bundle, run_bounded

STUB = """import sys


def main():
    args = sys.argv[1:]
    if args == ["--version"]:
        print("{version}")
    elif args == ["mcp", "--help"]:
        print("Usage: visionset mcp")
    else:
        sys.exit(2)
"""

CHILD = """import json, os, sys, time
sys.path.insert(0, {runtime!r})
import bootstrap, discover

counter, marker, mode, go = sys.argv[1:5]
while not os.path.exists(go):
    time.sleep(0.01)


def run(argv, cwd, env, timeout, cap):
    if "install" in argv:
        with open(counter, "a") as handle:
            handle.write("install\\n")
    result = discover.run_bounded(argv, cwd, env, timeout, cap)
    if "install" in argv and mode == "hang":
        open(marker, "w").close()
        time.sleep(300)
    return result


bundle = discover.Bundle("visionset", "visionset", {compat!r})
try:
    done = bootstrap.bootstrap(bundle, run=run, plugin_root=None)
except bootstrap.BootstrapError as error:
    sys.stderr.write(str(error))
    sys.exit(3)
sys.stderr.write("RESULT " + json.dumps({{"prefix": done.prefix, "reused": done.reused}}))
"""


def _record_hash(data: bytes) -> str:
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=")
    return "sha256=" + digest.decode()


def write_wheel(path: Path, files: Mapping[str, bytes], dist_info: str) -> Path:
    rows = [[name, _record_hash(data), str(len(data))] for name, data in files.items()]
    rows.append([f"{dist_info}/RECORD", "", ""])
    record = io.StringIO()
    csv.writer(record, lineterminator="\n").writerows(rows)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
        archive.writestr(f"{dist_info}/RECORD", record.getvalue())
    return path


def stub_wheel(directory: Path, version: str) -> Path:
    dist_info = f"visionset-{version}.dist-info"
    files = {
        "vsfixture.py": STUB.format(version=version).encode(),
        f"{dist_info}/METADATA": (
            f"Metadata-Version: 2.1\nName: visionset\nVersion: {version}\n"
        ).encode(),
        f"{dist_info}/WHEEL": (
            b"Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
        ),
        f"{dist_info}/entry_points.txt": b"[console_scripts]\nvisionset = vsfixture:main\n",
    }
    directory.mkdir(parents=True, exist_ok=True)
    return write_wheel(directory / f"visionset-{version}-py3-none-any.whl", files, dist_info)


def snapshot(root: Path) -> list[tuple[str, int, int]]:
    return sorted(
        (str(path.relative_to(root)), path.lstat().st_size, path.lstat().st_mtime_ns)
        for path in root.rglob("*")
    )


class CountingRunner:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def __call__(
        self, argv: Sequence[str], cwd: str, env: Mapping[str, str], timeout: float, cap: int
    ) -> ProbeResult:
        self.calls.append(list(argv))
        return run_bounded(argv, cwd, env, timeout, cap)

    def installs(self) -> int:
        return sum("install" in call for call in self.calls)


class NoWaitClock(SystemClock):
    def __init__(self) -> None:
        self.sleeps: list[float] = []

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)


class Workspace:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.home = root / "home"
        self.home.mkdir()
        self.data = root / "plugin data"
        self.wheels = root / "wheels"
        self.env: dict[str, str] = {
            "HOME": str(self.home),
            "PATH": "/usr/bin:/bin",
            DATA_ENV: str(self.data),
            "PIP_NO_INDEX": "1",
            "PIP_FIND_LINKS": str(self.wheels),
        }

    def host(self) -> Host:
        return Host(env=self.env, windows=False, home=str(self.home))

    def bootstrap(
        self, compat: str = "==0.0.1b4", python: str = sys.executable, **kwargs: object
    ) -> tuple[Bootstrapped, CountingRunner]:
        runner = CountingRunner()
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            result = run_bootstrap(
                Bundle("visionset", "visionset", compat),
                host=self.host(),
                run=runner,
                python=python,
                plugin_root=None,
                progress=lambda _: None,
                **kwargs,  # type: ignore[arg-type]
            )
        assert stdout.getvalue() == ""
        return result, runner


@unittest.skipIf(os.name == "nt", "POSIX processes and paths")
class RealBootstrapTest(unittest.TestCase):
    _scratch: tempfile.TemporaryDirectory[str]
    ws: Workspace
    first: Bootstrapped
    first_installs: int

    @classmethod
    def setUpClass(cls) -> None:
        cls._scratch = tempfile.TemporaryDirectory()
        cls.ws = Workspace(Path(cls._scratch.name))
        stub_wheel(cls.ws.wheels, "0.0.1b4")
        stub_wheel(cls.ws.wheels, "0.0.1b5")
        cls.first, runner = cls.ws.bootstrap()
        cls.first_installs = runner.installs()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._scratch.cleanup()

    def test_a_clean_install_publishes_a_working_runtime(self) -> None:
        self.assertFalse(self.first.reused)
        self.assertEqual(self.first_installs, 1)
        prefix = Path(self.first.prefix)
        runtime = prefix.parent
        sentinel = json.loads((runtime / "ready.json").read_text(encoding="utf-8"))
        self.assertEqual((sentinel["version"], sentinel["key"]), ("0.0.1b4", runtime.name))
        self.assertTrue((runtime / ".owner").is_file())
        log = self.ws.data / "logs" / f"{runtime.name}.log"
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        self.assertIn("pip install --no-input", log.read_text(encoding="utf-8"))
        printed = subprocess.run(
            [self.first.console_script, "--version"], capture_output=True, check=True
        )
        self.assertEqual(printed.stdout, b"0.0.1b4\n")

    def test_discovery_selects_the_published_runtime_from_the_cache(self) -> None:
        found = discover(
            compatibility="==0.0.1b4",
            host=self.ws.host(),
            cached=cached_prefixes(host=self.ws.host()),
        )
        assert found.selected is not None, found
        self.assertEqual(found.selected.candidate.tier, Tier.CACHE)
        self.assertEqual(found.selected.candidate.path, self.first.console_script)

    def test_a_ready_runtime_is_reused_with_no_index_at_all(self) -> None:
        saved = dict(self.ws.env)
        try:
            for name in ("PIP_NO_INDEX", "PIP_FIND_LINKS"):
                del self.ws.env[name]
            self.ws.env["PIP_INDEX_URL"] = "http://127.0.0.1:9/simple"
            again, runner = self.ws.bootstrap()
        finally:
            self.ws.env = saved
        self.assertTrue(again.reused)
        self.assertEqual(again.prefix, self.first.prefix)
        self.assertEqual(runner.installs(), 0)

    def test_a_second_version_is_built_beside_the_first_without_touching_it(self) -> None:
        runtime = Path(self.first.prefix).parent
        before = snapshot(runtime)
        second, runner = self.ws.bootstrap("==0.0.1b5")
        self.assertEqual(runner.installs(), 1)
        self.assertNotEqual(Path(second.prefix).parent, runtime)
        self.assertEqual(snapshot(runtime), before)
        self.assertIn(self.first.prefix, cached_prefixes(host=self.ws.host()))
        printed = subprocess.run([second.console_script, "--version"], capture_output=True)
        self.assertEqual(printed.stdout, b"0.0.1b5\n")


@unittest.skipIf(os.name == "nt", "POSIX processes and paths")
class RealProcessTest(unittest.TestCase):
    def setUp(self) -> None:
        self._scratch = tempfile.TemporaryDirectory()
        self.ws = Workspace(Path(self._scratch.name))
        stub_wheel(self.ws.wheels, "0.0.1b4")
        self.child = self.ws.root / "child.py"
        self.child.write_text(
            CHILD.format(runtime=str(_support.RUNTIME), compat="==0.0.1b4"), encoding="utf-8"
        )
        self.counter = self.ws.root / "installs"
        self.marker = self.ws.root / "installed"
        self.go = self.ws.root / "go"

    def tearDown(self) -> None:
        self._scratch.cleanup()

    def start(self, mode: str = "normal") -> subprocess.Popen[bytes]:
        argv = [sys.executable, "-I", "-S", str(self.child)]
        argv += [str(self.counter), str(self.marker), mode, str(self.go)]
        return subprocess.Popen(
            argv,
            env=self.ws.env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )

    def finish(self, process: subprocess.Popen[bytes]) -> dict[str, object]:
        stdout, stderr = process.communicate(timeout=240)
        self.assertEqual(stdout, b"")
        self.assertEqual(process.returncode, 0, stderr.decode())
        match = re.search(rb"RESULT (\{.*\})", stderr)
        assert match is not None, stderr
        result: dict[str, object] = json.loads(match.group(1))
        return result

    def installs(self) -> int:
        if not self.counter.exists():
            return 0
        return len(self.counter.read_text(encoding="utf-8").splitlines())

    def test_two_simultaneous_starts_install_once(self) -> None:
        first, second = self.start(), self.start()
        self.go.touch()
        results = [self.finish(first), self.finish(second)]
        self.assertEqual(self.installs(), 1)
        self.assertEqual(results[0]["prefix"], results[1]["prefix"])
        self.assertEqual(sorted(bool(r["reused"]) for r in results), [False, True])

    def test_a_setup_killed_mid_install_is_recovered(self) -> None:
        self.go.touch()
        doomed = self.start("hang")
        deadline = time.monotonic() + 240
        while not self.marker.exists():
            self.assertIsNone(doomed.poll())
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.05)
        os.killpg(doomed.pid, signal.SIGKILL)
        doomed.communicate(timeout=30)
        [runtime] = (self.ws.data / "runtimes").iterdir()
        self.assertTrue((runtime / ".owner").is_file())
        self.assertTrue((runtime / "venv" / "bin" / "visionset").is_file())
        self.assertFalse((runtime / "ready.json").exists())
        self.assertEqual(cached_prefixes(host=self.ws.host()), [])

        result = self.finish(self.start())
        self.assertFalse(result["reused"])
        self.assertEqual(self.installs(), 2)
        self.assertTrue((runtime / "ready.json").is_file())
        self.assertEqual(cached_prefixes(host=self.ws.host()), [str(runtime / "venv")])

    def test_an_unreachable_index_fails_clearly_after_one_retry(self) -> None:
        for name in ("PIP_NO_INDEX", "PIP_FIND_LINKS"):
            del self.ws.env[name]
        self.ws.env.update(
            {"PIP_INDEX_URL": "http://127.0.0.1:9/simple", "PIP_RETRIES": "1", "PIP_TIMEOUT": "2"}
        )
        clock = NoWaitClock()
        with self.assertRaises(BootstrapError) as raised:
            self.ws.bootstrap(clock=clock)
        self.assertIs(raised.exception.code, Code.INDEX_UNAVAILABLE)
        self.assertEqual(len(clock.sleeps), 1)
        self.assertEqual(list((self.ws.data / "runtimes").iterdir()), [])


def _normal(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def repack_installed(site_packages: Path, names: set[str], out: Path) -> None:
    """Rebuild wheels from installed distributions so pip can install them with no index."""
    out.mkdir(parents=True, exist_ok=True)
    for dist_info in site_packages.glob("*.dist-info"):
        meta = (dist_info / "METADATA").read_text(encoding="utf-8", errors="replace")
        name = re.search(r"^Name: (.+)$", meta, re.MULTILINE)
        version = re.search(r"^Version: (.+)$", meta, re.MULTILINE)
        wheel = dist_info / "WHEEL"
        record = dist_info / "RECORD"
        if not (name and version and wheel.is_file() and record.is_file()):
            continue
        if _normal(name.group(1)) not in names:
            continue
        tags = re.findall(r"^Tag: (\S+)$", wheel.read_text(encoding="utf-8"), re.MULTILINE)
        if not tags:
            continue
        parts = zip(*(tag.split("-") for tag in tags), strict=True)
        tag = "-".join(".".join(dict.fromkeys(part)) for part in parts)
        files: dict[str, bytes] = {}
        for row in csv.reader(record.read_text(encoding="utf-8").splitlines()):
            relative = row[0] if row else ""
            skip = relative.startswith(("..", "/")) or "__pycache__" in relative
            if not relative or skip or relative.endswith(("/RECORD", "/INSTALLER", "/REQUESTED")):
                continue
            source = site_packages / relative
            if source.is_file():
                files[relative] = source.read_bytes()
        stem = re.sub(r"[-_.]+", "_", name.group(1))
        target = out / f"{stem}-{version.group(1)}-{tag}.whl"
        write_wheel(target, files, dist_info.name)


@unittest.skipIf(os.name == "nt", "POSIX processes and paths")
class RepositoryWheelTest(unittest.TestCase):
    """The real distribution, built from this checkout, installed with every dependency offline."""

    def test_a_clean_install_of_the_repository_wheel(self) -> None:
        uv = shutil.which("uv")
        python = _support.REPO / ".venv" / "bin" / "python"
        if uv is None or not python.is_file():
            self.skipTest("needs uv and a synced repository environment")
        site = next((_support.REPO / ".venv" / "lib").glob("python3*/site-packages"), None)
        if site is None:
            self.skipTest("no site-packages in the repository environment")
        bundle = load_bundle(_support.RUNTIME / "bundle.json")
        with tempfile.TemporaryDirectory() as scratch:
            ws = Workspace(Path(scratch))
            env = {k: v for k, v in os.environ.items() if k != "VIRTUAL_ENV"}
            build = [uv, "build", "--wheel", "--out-dir", str(ws.wheels), str(_support.REPO)]
            subprocess.run(build, env=env, capture_output=True, check=True, timeout=300)
            exported = subprocess.run(
                [uv, "export", "--frozen", "--no-dev", "--no-hashes", "--no-emit-project"],
                env=env,
                cwd=_support.REPO,
                capture_output=True,
                text=True,
                check=True,
                timeout=120,
            ).stdout
            names = {
                _normal(match.group(1))
                for match in re.finditer(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==", exported, re.M)
            }
            repack_installed(site, names, ws.wheels)
            result, runner = ws.bootstrap(
                bundle.compatibility, python=str(python), install_timeout=600
            )
            self.assertEqual(runner.installs(), 1)
            self.assertEqual(result.version, bundle.compatibility.removeprefix("=="))
            found = discover(
                compatibility=bundle.compatibility,
                host=ws.host(),
                cached=cached_prefixes(host=ws.host()),
                probe_timeout=60,
            )
            assert found.selected is not None, found
            self.assertEqual(found.selected.candidate.path, result.console_script)


if __name__ == "__main__":
    unittest.main()
