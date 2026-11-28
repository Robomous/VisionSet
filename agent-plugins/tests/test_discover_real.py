"""Discovery on real virtual environments, real scripts and real processes (POSIX)."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import _support
from discover import OVERRIDE_ENV, Host, ProbeResult, Tier, discover, load_bundle, run_bounded

COMPAT = "==0.0.1b4"

# pip's own console-script header: sh re-executes the file with the named interpreter, which
# is how a script path or interpreter path containing spaces stays runnable.
SCRIPT = """#!/bin/sh
'''exec' "{python}" "$0" "$@"
' '''
import sys
print("noise on stderr", file=sys.stderr)
if sys.argv[1:] == ["--version"]:
    print("{version}")
elif sys.argv[1:] == ["mcp", "--help"]:
    print("Usage: visionset mcp")
else:
    sys.exit(2)
"""


def executable(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    path.chmod(0o755)
    return path


def gone(pid: int) -> bool:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.05)
    return False


def venv(prefix: Path, version: str) -> Path:
    subprocess.run(
        [sys.executable, "-m", "venv", "--without-pip", str(prefix)],
        check=True,
        capture_output=True,
    )
    python = prefix / "bin" / "python"
    return executable(prefix / "bin" / "visionset", SCRIPT.format(python=python, version=version))


@unittest.skipIf(os.name == "nt", "POSIX fixtures")
class RealInstallTest(unittest.TestCase):
    def setUp(self) -> None:
        self._scratch = tempfile.TemporaryDirectory()
        root = Path(self._scratch.name)
        self.home = root / "home dir"
        self.repo = root / "work space" / "repo"
        (self.repo / ".git").mkdir(parents=True)
        self.env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin"}

    def tearDown(self) -> None:
        self._scratch.cleanup()

    def host(self) -> Host:
        return Host(env=self.env, windows=False, home=str(self.home))

    def path(self, *entries: Path) -> None:
        self.env["PATH"] = os.pathsep.join([*map(str, entries), "/usr/bin", "/bin"])

    def test_a_pipx_style_user_install_beats_the_project_venv_first_in_path(self) -> None:
        venv(self.repo / ".venv", "0.0.1b4")
        tool = venv(self.home / ".local" / "share" / "pipx" / "venvs" / "visionset", "0.0.1b4")
        link = self.home / ".local" / "bin" / "visionset"
        link.parent.mkdir(parents=True)
        link.symlink_to(tool)
        self.path(self.repo / ".venv" / "bin", link.parent)

        result = discover(
            compatibility=COMPAT, host=self.host(), project=str(self.repo), project_trusted=True
        )
        assert result.selected is not None, result
        self.assertEqual(result.selected.candidate.tier, Tier.USER)
        self.assertEqual(result.selected.candidate.source, "PATH")
        self.assertEqual(result.selected.candidate.path, str(link))
        self.assertEqual(result.selected.version, "0.0.1b4")
        self.assertEqual(result.skipped, ())

    def test_the_project_venv_is_used_when_the_user_install_is_incompatible(self) -> None:
        project = venv(self.repo / ".venv", "0.0.1b4")
        venv(self.home / ".local" / "share" / "uv" / "tools" / "visionset", "0.0.1b2")
        result = discover(
            compatibility=COMPAT,
            host=self.host(),
            project=str(self.repo / "src" / "pkg"),
            project_trusted=True,
        )
        assert result.selected is not None, result
        self.assertEqual(result.selected.candidate.path, str(project))
        self.assertEqual(
            [skipped.reason for skipped in result.skipped],
            ["version 0.0.1b2 is outside ==0.0.1b4"],
        )

    def test_broken_shims_are_skipped_with_a_reason(self) -> None:
        shims = self.home / "shims"
        executable(shims / "visionset", "#!/nonexistent/interpreter\n")
        pyenv = self.home / "pyenv shims"
        executable(
            pyenv / "visionset",
            f'#!/bin/sh\necho "pyenv: visionset: command not found in {self.home}" >&2\nexit 127\n',
        )
        self.path(shims, pyenv)
        result = discover(compatibility=COMPAT, host=self.host(), project=None)
        self.assertIsNone(result.selected)
        self.assertEqual(
            [skipped.reason for skipped in result.skipped],
            [
                "could not be started: No such file or directory",
                "`--version` exited with 127: pyenv: visionset: command not found in ~",
            ],
        )

    def test_an_untrusted_checkout_script_never_runs(self) -> None:
        marker = self.repo / "ran"
        executable(self.repo / ".venv" / "bin" / "visionset", f"#!/bin/sh\ntouch '{marker}'\n")
        result = discover(compatibility=COMPAT, host=self.host(), project=str(self.repo))
        self.assertIsNone(result.selected)
        self.assertFalse(marker.exists())
        self.assertIn("has not trusted", result.skipped[0].reason)

    def test_discovery_leaves_stdout_and_stdin_alone(self) -> None:
        venv(self.repo / ".venv", "0.0.1b4")
        code = (
            f"import sys; sys.path.insert(0, {str(_support.RUNTIME)!r}); import discover; "
            f"r = discover.discover(compatibility={COMPAT!r}, project={str(self.repo)!r}, "
            "project_trusted=True); sys.exit(0 if r.selected else 3)"
        )
        result = subprocess.run(
            [sys.executable, "-I", "-S", "-c", code],
            input=b'{"jsonrpc": "2.0"}\n',
            capture_output=True,
            env=self.env,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"")


@unittest.skipIf(os.name == "nt", "POSIX fixtures")
class RunBoundedTest(unittest.TestCase):
    def setUp(self) -> None:
        self._scratch = tempfile.TemporaryDirectory()
        self.root = Path(self._scratch.name)

    def tearDown(self) -> None:
        self._scratch.cleanup()

    def run_script(
        self, body: str, *args: str, timeout: float = 5.0, cap: int = 1024
    ) -> ProbeResult:
        script = executable(self.root / "a dir" / "probe", "#!/bin/sh\n" + body)
        return run_bounded([str(script), *args], str(self.root), dict(os.environ), timeout, cap)

    def test_argv_reaches_the_program_literally(self) -> None:
        result = self.run_script('printf "%s|" "$@"\n', "a; touch x", "$(id)", "b c")
        self.assertEqual(result.stdout, b"a; touch x|$(id)|b c|")
        self.assertFalse((self.root / "x").exists())

    def test_stdin_is_not_inherited(self) -> None:
        read_end, write_end = os.pipe()
        saved = os.dup(0)
        try:
            os.dup2(read_end, 0)
            result = self.run_script("cat; echo done\n", timeout=2.0)
        finally:
            os.dup2(saved, 0)
            for fd in (saved, read_end, write_end):
                os.close(fd)
        self.assertFalse(result.timed_out)
        self.assertEqual(result.stdout, b"done\n")

    def test_a_hung_process_group_is_killed_at_the_timeout(self) -> None:
        pidfile = self.root / "child.pid"
        start = time.monotonic()
        result = self.run_script(f"sleep 30 &\necho $! > '{pidfile}'\nsleep 30\n", timeout=0.5)
        self.assertTrue(result.timed_out)
        self.assertLess(time.monotonic() - start, 5)
        self.assertTrue(gone(int(pidfile.read_text(encoding="utf-8"))))

    def test_a_descendant_holding_the_pipe_is_killed(self) -> None:
        pidfile = self.root / "child.pid"
        result = self.run_script(f"sleep 30 &\necho $! > '{pidfile}'\necho ok\n")
        self.assertEqual((result.returncode, result.stdout), (0, b"ok\n"))
        self.assertTrue(gone(int(pidfile.read_text(encoding="utf-8"))))

    def test_output_survives_a_descendant_that_escapes_the_group(self) -> None:
        pidfile = self.root / "escaped.pid"
        escape = (
            "import os, sys, time; os.setsid(); "
            f"open({str(pidfile)!r}, 'w').write(str(os.getpid())); time.sleep(30)"
        )
        start = time.monotonic()
        try:
            result = self.run_script(
                f'echo partial\n"{sys.executable}" -c "{escape}" &\nsleep 0.3\n'
            )
            self.assertLess(time.monotonic() - start, 5)
            self.assertEqual((result.returncode, result.stdout), (0, b"partial\n"))
        finally:
            if pidfile.exists():
                os.kill(int(pidfile.read_text(encoding="utf-8")), signal.SIGKILL)

    def test_output_beyond_the_cap_kills_the_process(self) -> None:
        start = time.monotonic()
        result = self.run_script("yes\n", cap=4096)
        self.assertTrue(result.overflow)
        self.assertEqual(len(result.stdout), 4096)
        self.assertLess(time.monotonic() - start, 5)

    def test_a_missing_program_is_a_start_error(self) -> None:
        result = run_bounded([str(self.root / "nope")], str(self.root), {}, 1.0, 64)
        self.assertEqual(result.error, "No such file or directory")


class RepositoryEnvironmentTest(unittest.TestCase):
    """The repository's own `visionset`, when `uv sync` has built one, passes as an override."""

    def test_the_repository_console_script_is_compatible(self) -> None:
        script = _support.REPO / ".venv" / ("Scripts" if os.name == "nt" else "bin")
        script = script / ("visionset.exe" if os.name == "nt" else "visionset")
        if not script.is_file():
            self.skipTest("no synced repository environment")
        bundle = load_bundle(_support.RUNTIME / "bundle.json")
        host = Host.current()
        env = {**host.env, OVERRIDE_ENV: str(script)}
        result = discover(
            compatibility=bundle.compatibility,
            host=Host(env=env, windows=host.windows, home=host.home),
            probe_timeout=60,
        )
        self.assertIsNone(result.failure)
        assert result.selected is not None
        self.assertEqual(result.selected.candidate.tier, Tier.OVERRIDE)


if __name__ == "__main__":
    unittest.main()
