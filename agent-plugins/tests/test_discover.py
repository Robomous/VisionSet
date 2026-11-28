"""Discovery precedence, skip reasons and redaction against an in-memory filesystem."""

from __future__ import annotations

import ast
import json
import ntpath
import posixpath
import sys
import tempfile
import unittest
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from unittest import mock

import _support
from discover import (
    OUTPUT_CAP,
    OVERRIDE_ENV,
    REASON_TAIL,
    BundleError,
    Discovery,
    Host,
    ProbeResult,
    Tier,
    describe,
    discover,
    load_bundle,
    redact,
)

COMPAT = "==0.0.1b4"
HOME = "/home/u"
PROJECT = "/srv/work/repo"
OK = ProbeResult(0, b"0.0.1b4\n")


class FakeFs:
    def __init__(self, windows: bool = False, fold_case: bool = False) -> None:
        self.pm = ntpath if windows else posixpath
        self.sep = "\\" if windows else "/"
        self.fold_case = fold_case
        self.nodes: dict[str, str] = {}
        self.names: dict[str, str] = {}
        self.links: dict[str, str] = {}
        self.contents: dict[str, str] = {}

    def k(self, path: str) -> str:
        key = str(self.pm.normcase(self.pm.normpath(path)))
        return key.casefold() if self.fold_case else key

    def _add(self, path: str, kind: str) -> None:
        self.nodes[self.k(path)] = kind
        self.names[self.k(path)] = self.pm.normpath(path)
        parent = self.pm.dirname(path)
        if parent != path and self.k(parent) not in self.nodes:
            self._add(parent, "dir")

    def file(self, path: str, executable: bool = True, text: str = "") -> None:
        self._add(path, "exe" if executable else "file")
        self.contents[self.k(path)] = text

    def mkdir(self, path: str) -> None:
        self._add(path, "dir")

    def link(self, path: str, target: str) -> None:
        self.links[self.k(path)] = target
        self._add(self.pm.dirname(path), "dir")

    def realpath(self, path: str) -> str:
        current = self.pm.normpath(path)
        for _ in range(40):
            key = self.k(current)
            for link, target in self.links.items():
                if key == link or key.startswith(link + self.sep):
                    current = self.pm.normpath(target + current[len(link) :])
                    break
            else:
                return str(current)
        return str(current)

    def lexists(self, path: str) -> bool:
        parent = self.realpath(self.pm.dirname(path))
        key = self.k(self.pm.join(parent, self.pm.basename(path)))
        return key in self.nodes or key in self.links

    def _kind(self, path: str) -> str | None:
        return self.nodes.get(self.k(self.realpath(path)))

    def is_file(self, path: str) -> bool:
        return self._kind(path) in ("exe", "file")

    def is_dir(self, path: str) -> bool:
        return self._kind(path) == "dir"

    def is_executable(self, path: str) -> bool:
        return self._kind(path) == "exe"

    def read_head(self, path: str) -> str:
        return self.contents.get(self.k(self.realpath(path)), "")[:4096]

    def listdir(self, path: str) -> list[str]:
        prefix = self.k(self.realpath(path)) + self.sep
        return sorted(
            self.pm.basename(self.names[key])
            for key in self.nodes
            if key.startswith(prefix) and self.sep not in key[len(prefix) :]
        )


@dataclass
class Behaviour:
    version: ProbeResult
    mcp: ProbeResult


class FakeRunner:
    def __init__(self, fs: FakeFs) -> None:
        self.fs = fs
        self.behaviour: dict[str, Behaviour] = {}
        self.calls: list[list[str]] = []
        self.cwds: list[str] = []
        self.envs: list[dict[str, str]] = []

    def __call__(
        self, argv: Sequence[str], cwd: str, env: Mapping[str, str], timeout: float, cap: int
    ) -> ProbeResult:
        self.calls.append(list(argv))
        self.cwds.append(cwd)
        self.envs.append(dict(env))
        behaviour = self.behaviour[self.fs.k(self.fs.realpath(argv[0]))]
        return behaviour.version if list(argv[1:]) == ["--version"] else behaviour.mcp

    def probed(self) -> list[str]:
        return [call[0] for call in self.calls if call[1:] == ["--version"]]


class Scene:
    """One machine: a filesystem, the installs on it, and the environment discovery sees."""

    def __init__(self, windows: bool = False, home: str = HOME, fold_case: bool = False) -> None:
        self.windows = windows
        self.fold_case = fold_case
        self.fs = FakeFs(windows, fold_case)
        self.run = FakeRunner(self.fs)
        self.home = home
        self.env: dict[str, str] = {}

    def install(
        self,
        path: str,
        version: str | ProbeResult = "0.0.1b4",
        mcp: ProbeResult | None = None,
        executable: bool = True,
    ) -> str:
        self.fs.file(path, executable)
        result = (
            version if isinstance(version, ProbeResult) else ProbeResult(0, f"{version}\n".encode())
        )
        self.run.behaviour[self.fs.k(path)] = Behaviour(result, mcp or ProbeResult(0, b"usage"))
        return path

    def path(self, *entries: str) -> None:
        self.env["PATH"] = (";" if self.windows else ":").join(entries)

    def host(self) -> Host:
        return Host(env=self.env, windows=self.windows, home=self.home, fold_case=self.fold_case)

    def discover(self, **kwargs: object) -> Discovery:
        options: dict[str, object] = {"project": PROJECT, "project_trusted": True}
        options.update(kwargs)
        return discover(
            compatibility=COMPAT,
            host=self.host(),
            fs=self.fs,
            run=self.run,
            **options,  # type: ignore[arg-type]
        )


def chosen(result: Discovery) -> tuple[Tier, str, str]:
    assert result.selected is not None, result
    candidate = result.selected.candidate
    return candidate.tier, candidate.source, candidate.path


def reasons(result: Discovery) -> list[str]:
    return [skipped.reason for skipped in result.skipped]


class PrecedenceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.s = Scene()
        self.s.fs.mkdir(PROJECT + "/.git")

    def test_user_wins_even_with_the_project_venv_first_in_path(self) -> None:
        project = self.s.install(PROJECT + "/.venv/bin/visionset")
        user = self.s.install(HOME + "/.local/bin/visionset")
        self.s.path(PROJECT + "/.venv/bin", HOME + "/.local/bin", "/usr/bin")
        self.assertEqual(chosen(self.s.discover()), (Tier.USER, "PATH", user))
        self.assertNotIn(project, self.s.run.probed())

    def test_user_wins_over_an_active_venv_outside_the_checkout(self) -> None:
        self.s.install("/opt/envs/proj/bin/visionset")
        user = self.s.install("/usr/local/bin/visionset")
        self.s.env["VIRTUAL_ENV"] = "/opt/envs/proj"
        self.s.path("/opt/envs/proj/bin", "/usr/local/bin")
        self.assertEqual(chosen(self.s.discover()), (Tier.USER, "PATH", user))

    def test_project_wins_over_cache(self) -> None:
        project = self.s.install(PROJECT + "/.venv/bin/visionset")
        self.s.install("/data/runtime/0.0.1b4/bin/visionset")
        result = self.s.discover(cached=["/data/runtime/0.0.1b4"])
        self.assertEqual(chosen(result), (Tier.PROJECT, ".venv", project))

    def test_cache_is_used_when_nothing_else_is_compatible(self) -> None:
        self.s.install(HOME + "/.local/bin/visionset", "0.0.1b2")
        cache = self.s.install("/data/b/bin/visionset")
        result = self.s.discover(cached=["/data/missing", "/data/b"])
        self.assertEqual(chosen(result), (Tier.CACHE, "cache", cache))
        self.assertEqual(reasons(result), ["version 0.0.1b2 is outside ==0.0.1b4"])

    def test_override_wins_over_a_compatible_user_install(self) -> None:
        override = self.s.install("/opt/dev/visionset")
        self.s.install(HOME + "/.local/bin/visionset")
        self.s.path(HOME + "/.local/bin")
        self.s.env[OVERRIDE_ENV] = override
        self.assertEqual(chosen(self.s.discover()), (Tier.OVERRIDE, OVERRIDE_ENV, override))
        self.assertEqual(self.s.run.probed(), [override])

    def test_an_empty_override_is_unset(self) -> None:
        user = self.s.install(HOME + "/.local/bin/visionset")
        self.s.env[OVERRIDE_ENV] = ""
        self.assertEqual(chosen(self.s.discover()), (Tier.USER, "pipx", user))

    def test_user_path_order_comes_before_user_install_locations(self) -> None:
        self.s.install(HOME + "/.local/bin/visionset")
        first = self.s.install("/usr/local/bin/visionset")
        self.s.path("/usr/local/bin")
        self.assertEqual(chosen(self.s.discover())[2], first)

    def test_a_link_into_a_tool_venv_is_classified_where_it_was_found(self) -> None:
        venv = HOME + "/.local/share/pipx/venvs/visionset/bin/visionset"
        self.s.install(venv)
        self.s.fs.link(HOME + "/.local/bin/visionset", venv)
        self.s.fs.link(PROJECT + "/tools/visionset", venv)
        self.s.path(PROJECT + "/tools", HOME + "/.local/bin")
        result = self.s.discover()
        self.assertEqual(chosen(result), (Tier.USER, "PATH", HOME + "/.local/bin/visionset"))

    def test_tool_venvs_are_found_without_a_link_on_path(self) -> None:
        cases = {
            "pipx": (HOME + "/.local/share/pipx/venvs/visionset/bin/visionset", {}),
            "pipx home": ("/p/venvs/visionset/bin/visionset", {"PIPX_HOME": "/p"}),
            "legacy pipx": (HOME + "/.local/pipx/venvs/visionset/bin/visionset", {}),
            "uv tool": (HOME + "/.local/share/uv/tools/visionset/bin/visionset", {}),
            "uv tool dir": ("/t/visionset/bin/visionset", {"UV_TOOL_DIR": "/t"}),
            "xdg uv tool": ("/x/uv/tools/visionset/bin/visionset", {"XDG_DATA_HOME": "/x"}),
            "pip user base": ("/b/bin/visionset", {"PYTHONUSERBASE": "/b"}),
            "macos user": (HOME + "/Library/Python/3.12/bin/visionset", {}),
            "uv tool bin": ("/ub/visionset", {"UV_TOOL_BIN_DIR": "/ub"}),
            "xdg bin": ("/xb/visionset", {"XDG_BIN_HOME": "/xb"}),
            "pipx bin": ("/pb/visionset", {"PIPX_BIN_DIR": "/pb"}),
        }
        for label, (path, env) in cases.items():
            with self.subTest(label):
                scene = Scene()
                scene.install(path)
                scene.env.update(env)
                tier, _, found = chosen(scene.discover(project=None))
                self.assertEqual((tier, found), (Tier.USER, path))

    def test_newest_macos_user_python_first(self) -> None:
        self.s.install(HOME + "/Library/Python/3.11/bin/visionset", "0.0.1b2")
        newest = self.s.install(HOME + "/Library/Python/3.13/bin/visionset")
        result = self.s.discover()
        self.assertEqual((chosen(result)[2], result.skipped), (newest, ()))

    def test_project_sources_in_order(self) -> None:
        order = [
            ("VIRTUAL_ENV", "/e/venv/bin/visionset"),
            ("CONDA_PREFIX", "/e/conda/bin/visionset"),
            ("UV_PROJECT_ENVIRONMENT", PROJECT + "/.uvenv/bin/visionset"),
            ("PATH", PROJECT + "/scripts/visionset"),
            (".venv", PROJECT + "/.venv/bin/visionset"),
            ("venv", PROJECT + "/venv/bin/visionset"),
        ]
        for _, path in order:
            self.s.install(path, "0.0.1b1")
        self.s.env.update(
            VIRTUAL_ENV="/e/venv", CONDA_PREFIX="/e/conda", UV_PROJECT_ENVIRONMENT=".uvenv"
        )
        self.s.path(PROJECT + "/scripts")
        result = self.s.discover()
        self.assertIsNone(result.selected)
        self.assertEqual(
            [(s.candidate.tier, s.candidate.source, s.candidate.path) for s in result.skipped],
            [(Tier.PROJECT, source, path) for source, path in order],
        )

    def test_the_conda_base_env_is_a_user_install(self) -> None:
        base = self.s.install("/opt/conda/bin/visionset")
        self.s.install(PROJECT + "/.venv/bin/visionset")
        self.s.env.update(CONDA_PREFIX="/opt/conda", CONDA_DEFAULT_ENV="base")
        self.s.path(PROJECT + "/.venv/bin", "/opt/conda/bin")
        self.assertEqual(chosen(self.s.discover()), (Tier.USER, "PATH", base))

    def test_without_a_project_only_env_mappings_are_project_installs(self) -> None:
        self.s.install(PROJECT + "/.venv/bin/visionset")
        active = self.s.install("/e/venv/bin/visionset")
        self.s.env["VIRTUAL_ENV"] = "/e/venv"
        self.assertEqual(
            chosen(self.s.discover(project=None)), (Tier.PROJECT, "VIRTUAL_ENV", active)
        )
        self.s.env.pop("VIRTUAL_ENV")
        self.assertEqual(self.s.discover(project=None), Discovery(None, ()))

    def test_nothing_found_is_neither_selection_nor_failure(self) -> None:
        result = self.s.discover()
        self.assertEqual((result.selected, result.failure, result.skipped), (None, None, ()))

    def test_relative_path_entries_are_not_searched(self) -> None:
        self.s.install(PROJECT + "/bin/visionset")
        self.s.install("bin/visionset")
        self.s.install("visionset")
        self.s.path("", ".", "bin")
        self.assertEqual(self.s.discover(), Discovery(None, ()))
        self.assertEqual(self.s.run.calls, [])

    def test_a_project_must_be_absolute(self) -> None:
        with self.assertRaises(ValueError):
            self.s.discover(project="relative/dir")


class CheckoutTest(unittest.TestCase):
    def test_nested_roots_nearest_first_and_stop_at_the_repository(self) -> None:
        s = Scene()
        s.fs.mkdir("/srv/mono/.git")
        s.install("/srv/.venv/bin/visionset")
        outer = s.install("/srv/mono/.venv/bin/visionset", "0.0.1b1")
        inner = s.install("/srv/mono/pkg/a/.venv/bin/visionset", "0.0.1b1")
        result = s.discover(project="/srv/mono/pkg/a")
        self.assertIsNone(result.selected)
        self.assertEqual([x.candidate.path for x in result.skipped], [inner, outer])

    def test_a_worktree_git_file_marks_the_root(self) -> None:
        s = Scene()
        s.fs.file("/srv/wt/.git", executable=False, text="gitdir: /srv/main/.git/worktrees/wt\n")
        s.fs.file("/srv/wt/src/pyproject.toml", executable=False)
        s.install("/srv/.venv/bin/visionset")
        venv = s.install("/srv/wt/.venv/bin/visionset")
        self.assertEqual(chosen(s.discover(project="/srv/wt/src/pkg"))[2], venv)
        self.assertEqual(s.run.probed(), [venv])

    def test_a_worktree_inside_its_main_checkout_stops_at_the_worktree(self) -> None:
        s = Scene()
        s.fs.mkdir("/srv/main/.git")
        gitdir = "gitdir: /srv/main/.git/worktrees/wt\n"
        s.fs.file("/srv/main/wt/.git", executable=False, text=gitdir)
        s.install("/srv/main/.venv/bin/visionset")
        inner = s.install("/srv/main/wt/.venv/bin/visionset", "0.0.1b1")
        result = s.discover(project="/srv/main/wt")
        self.assertIsNone(result.selected)
        self.assertEqual([x.candidate.path for x in result.skipped], [inner])

    def test_without_git_the_nearest_marker_is_the_root(self) -> None:
        s = Scene()
        s.fs.file("/srv/p/pyproject.toml", executable=False)
        s.install("/srv/.venv/bin/visionset")
        venv = s.install("/srv/p/venv/bin/visionset")
        self.assertEqual(chosen(s.discover(project="/srv/p/sub"))[2], venv)
        self.assertEqual(s.run.probed(), [venv])

    def test_a_dotfiles_repository_in_home_does_not_make_home_a_project(self) -> None:
        s = Scene()
        s.fs.mkdir(HOME + "/.git")
        s.install(HOME + "/code/app/.venv/bin/visionset", "0.0.1b1")
        user = s.install(HOME + "/.local/bin/visionset")
        s.path(HOME + "/code/app/.venv/bin", HOME + "/.local/bin")
        result = s.discover(project=HOME + "/code/app", project_trusted=False)
        self.assertEqual(chosen(result), (Tier.USER, "PATH", user))
        self.assertEqual(s.run.probed(), [user])

    def test_a_project_at_home_is_its_own_checkout(self) -> None:
        s = Scene()
        s.install(HOME + "/.venv/bin/visionset")
        s.install(HOME + "/.local/bin/visionset")
        s.path(HOME + "/.venv/bin", HOME + "/.local/bin")
        result = s.discover(project=HOME, project_trusted=False)
        self.assertIsNone(result.selected)
        self.assertEqual(s.run.calls, [])
        self.assertEqual(chosen(s.discover(project=HOME))[0], Tier.USER)

    def test_a_checkout_that_is_home_with_a_venv_on_path_needs_trust(self) -> None:
        s = Scene(home="/srv/repo")
        s.fs.mkdir("/srv/repo/.git")
        s.install("/srv/repo/.venv/bin/visionset")
        s.path("/srv/repo/.venv/bin")
        result = s.discover(project="/srv/repo", project_trusted=False)
        self.assertIsNone(result.selected)
        self.assertIn("has not trusted", reasons(result)[0])
        self.assertEqual(s.run.calls, [])

    def test_a_marker_at_the_filesystem_root_is_ignored(self) -> None:
        s = Scene()
        s.fs.mkdir("/.git")
        s.fs.file("/pyproject.toml", executable=False)
        user = s.install("/usr/local/bin/visionset")
        s.path("/usr/local/bin")
        result = s.discover(project="/srv/work", project_trusted=False)
        self.assertEqual(chosen(result), (Tier.USER, "PATH", user))

    def test_a_submodule_reaches_the_superproject(self) -> None:
        s = Scene()
        s.fs.mkdir("/srv/super/.git")
        s.fs.file("/srv/super/sub/.git", executable=False, text="gitdir: ../.git/modules/sub\n")
        s.install("/srv/super/.venv/bin/visionset")
        s.path("/srv/super/.venv/bin")
        result = s.discover(project="/srv/super/sub/src", project_trusted=False)
        self.assertIsNone(result.selected)
        self.assertEqual(s.run.calls, [])
        s.env.pop("PATH")
        result = s.discover(project="/srv/super/sub/src")
        self.assertEqual(chosen(result)[0:2], (Tier.PROJECT, ".venv"))

    def test_case_variants_match_on_a_case_insensitive_filesystem(self) -> None:
        for fold_case, tier in ((True, None), (False, Tier.USER)):
            with self.subTest(fold_case=fold_case):
                s = Scene(home="/Users/u", fold_case=fold_case)
                s.fs.mkdir("/Users/u/Code/repo/.git")
                s.install("/Users/u/code/repo/.venv/bin/visionset")
                s.path("/Users/u/code/repo/.venv/bin")
                result = s.discover(project="/Users/u/Code/repo", project_trusted=False)
                self.assertEqual(result.selected and result.selected.candidate.tier, tier)


class TrustTest(unittest.TestCase):
    def setUp(self) -> None:
        self.s = Scene()
        self.s.fs.mkdir(PROJECT + "/.git")

    def test_an_untrusted_checkout_binary_is_never_run(self) -> None:
        venv = self.s.install(PROJECT + "/.venv/bin/visionset")
        cache = self.s.install("/data/r/bin/visionset")
        result = self.s.discover(project_trusted=False, cached=["/data/r"])
        self.assertEqual(chosen(result)[2], cache)
        self.assertNotIn(venv, self.s.run.probed())
        self.assertIn("has not trusted", reasons(result)[0])

    def test_every_project_source_inside_the_checkout_needs_trust(self) -> None:
        paths = [
            self.s.install(PROJECT + "/.venv/bin/visionset"),
            self.s.install(PROJECT + "/tools/visionset"),
            self.s.install(PROJECT + "/.uv/bin/visionset"),
        ]
        self.s.env.update(VIRTUAL_ENV=PROJECT + "/.venv", UV_PROJECT_ENVIRONMENT=".uv")
        self.s.path(PROJECT + "/tools")
        result = self.s.discover(project_trusted=False)
        self.assertIsNone(result.selected)
        self.assertEqual(sorted(x.candidate.path for x in result.skipped), sorted(paths))
        self.assertEqual(self.s.run.calls, [])

    def test_a_link_leaving_the_checkout_still_needs_trust(self) -> None:
        self.s.install("/opt/elsewhere/visionset")
        self.s.fs.link(PROJECT + "/.venv", "/opt/elsewhere-venv")
        self.s.install("/opt/elsewhere-venv/bin/visionset")
        result = self.s.discover(project_trusted=False)
        self.assertIsNone(result.selected)
        self.assertIn("has not trusted", reasons(result)[0])
        self.assertEqual(self.s.run.calls, [])

    def test_a_checkout_reached_through_a_link_needs_trust(self) -> None:
        self.s.fs.link("/srv/alias", PROJECT)
        self.s.install(PROJECT + "/.venv/bin/visionset")
        self.s.env["VIRTUAL_ENV"] = "/srv/alias/.venv"
        result = self.s.discover(project_trusted=False)
        self.assertIsNone(result.selected)
        self.assertEqual(
            [(x.candidate.source, x.reason[:28]) for x in result.skipped],
            [
                ("VIRTUAL_ENV", "inside the project checkout,"),
                (".venv", "inside the project checkout,"),
            ],
        )
        self.assertEqual(self.s.run.calls, [])

    def test_user_locations_inside_the_checkout_need_trust(self) -> None:
        for label, env in (("home", {}), ("pipx bin", {"PIPX_BIN_DIR": PROJECT + "/tools"})):
            with self.subTest(label):
                s = Scene(home=PROJECT + "/.home")
                s.fs.mkdir(PROJECT + "/.git")
                s.env.update(env)
                s.install(PROJECT + "/.home/.local/bin/visionset")
                s.install(PROJECT + "/tools/visionset")
                result = s.discover(project_trusted=False)
                self.assertIsNone(result.selected)
                self.assertTrue(result.skipped)
                self.assertTrue(all("has not trusted" in r for r in reasons(result)))
                self.assertEqual(s.run.calls, [])
                self.assertEqual(chosen(s.discover())[0], Tier.USER)

    def test_a_cache_inside_the_checkout_needs_trust(self) -> None:
        self.s.install(PROJECT + "/.cache/rt/bin/visionset")
        result = self.s.discover(project_trusted=False, cached=[PROJECT + "/.cache/rt"])
        self.assertIsNone(result.selected)
        self.assertEqual(self.s.run.calls, [])

    def test_trust_lets_the_checkout_binary_run(self) -> None:
        venv = self.s.install(PROJECT + "/.venv/bin/visionset")
        self.assertEqual(chosen(self.s.discover(project_trusted=True))[2], venv)

    def test_an_active_env_outside_the_checkout_runs_untrusted(self) -> None:
        active = self.s.install("/e/venv/bin/visionset")
        self.s.env["VIRTUAL_ENV"] = "/e/venv"
        self.assertEqual(chosen(self.s.discover(project_trusted=False))[2], active)

    def test_the_override_is_trusted_inside_an_untrusted_checkout(self) -> None:
        override = self.s.install(PROJECT + "/.venv/bin/visionset")
        self.s.env[OVERRIDE_ENV] = override
        self.assertEqual(chosen(self.s.discover(project_trusted=False))[2], override)


class OverrideTest(unittest.TestCase):
    def setUp(self) -> None:
        self.s = Scene()
        self.user = self.s.install(HOME + "/.local/bin/visionset")
        self.s.path(HOME + "/.local/bin")

    def failure(self, value: str) -> str:
        self.s.env[OVERRIDE_ENV] = value
        result = self.s.discover()
        self.assertIsNone(result.selected)
        self.assertNotIn(self.user, self.s.run.probed())
        self.assertEqual(len(result.skipped), 1)
        assert result.failure is not None
        self.assertTrue(result.failure.startswith(OVERRIDE_ENV + "="), result.failure)
        return result.failure

    def test_a_missing_override_fails_and_never_falls_through(self) -> None:
        self.assertIn("does not exist", self.failure("/opt/nowhere/visionset"))

    def test_an_incompatible_override_fails(self) -> None:
        self.s.install("/opt/old/visionset", "0.0.1b1")
        self.assertIn("outside ==0.0.1b4", self.failure("/opt/old/visionset"))

    def test_a_relative_override_fails(self) -> None:
        self.assertIn("not an absolute path", self.failure("bin/visionset"))

    def test_an_override_without_mcp_fails(self) -> None:
        self.s.install("/opt/x/visionset", mcp=ProbeResult(2, b"", b"No such command 'mcp'"))
        self.assertIn("No such command", self.failure("/opt/x/visionset"))

    def test_the_failure_hides_the_home_directory(self) -> None:
        failure = self.failure(HOME + "/missing/visionset")
        self.assertIn("=~/missing/visionset", failure)
        self.assertNotIn(HOME, failure)


class SkipReasonTest(unittest.TestCase):
    def skipped(self, path: str, scene: Scene | None = None) -> str:
        s = scene or self.s
        result = s.discover(project=None)
        self.assertIsNone(result.selected, result)
        found = [x for x in result.skipped if x.candidate.path == path]
        self.assertEqual(len(found), 1, result)
        return found[0].reason

    def setUp(self) -> None:
        self.s = Scene()
        self.target = "/usr/local/bin/visionset"
        self.s.path("/usr/local/bin")

    def test_incompatible_version(self) -> None:
        self.s.install(self.target, "0.0.2")
        self.assertEqual(self.skipped(self.target), "version 0.0.2 is outside ==0.0.1b4")

    def test_no_version_printed(self) -> None:
        self.s.install(self.target, ProbeResult(0, b"VisionSet ready\nmore"))
        self.assertIn("printed no version", self.skipped(self.target))
        self.s.install(self.target, ProbeResult(0, b""))
        self.assertIn("printed no version: nothing", self.skipped(self.target))
        self.s.install(self.target, ProbeResult(0, b"y" * 5000))
        self.assertLess(len(self.skipped(self.target)), 500)

    def test_version_output_is_redacted(self) -> None:
        self.s.install(self.target, ProbeResult(0, f"{HOME}/cfg token=abcd1234efgh".encode()))
        reason = self.skipped(self.target)
        self.assertEqual(reason, "`--version` printed no version: ~/cfg token=<redacted>")

    def test_version_output_is_redacted_before_it_is_cut(self) -> None:
        self.s.env["MY_TOKEN"] = "supersecretvalue123"
        for secret in ("ghp_" + "A" * 36, "supersecretvalue123"):
            with self.subTest(secret=secret[:4]):
                printed = "x" * (REASON_TAIL - 10) + " " + secret
                self.s.install(self.target, ProbeResult(0, printed.encode()))
                reason = self.skipped(self.target)
                self.assertNotIn(secret[:9], reason)

    def test_non_ascii_digits_are_not_a_version(self) -> None:
        for printed in ("\u0660.0.1b4", "0.0.1b\u0664", "0.\u0660.1b4"):
            with self.subTest(printed=printed):
                self.s.install(self.target, printed)
                self.assertIn("printed no version", self.skipped(self.target))

    def test_probes_run_without_interpreter_steering_variables(self) -> None:
        self.s.env.update(PYTHONPATH="/evil", PYTHONSTARTUP="/evil.py", PYTHONHOME="/x", HOME=HOME)
        self.s.env.update(PYTHONINSPECT="1", pythonbreakpoint="x.y", PATH="/usr/local/bin")
        self.s.install(self.target)
        self.s.discover(project=None)
        env = self.s.run.envs[0]
        self.assertEqual(env, {"HOME": HOME, "PATH": "/usr/local/bin", "NO_COLOR": "1"})

    def test_failed_version_probe_carries_redacted_stderr(self) -> None:
        stderr = f"Traceback\n  File {HOME}/x.py\nPermissionError: token=abcd1234efgh"
        self.s.install(self.target, ProbeResult(1, b"", stderr.encode()))
        reason = self.skipped(self.target)
        self.assertTrue(reason.startswith("`--version` exited with 1: Traceback"), reason)
        self.assertIn("~/x.py", reason)
        self.assertIn("token=<redacted>", reason)
        self.assertNotIn(HOME, reason)
        self.assertNotIn("abcd1234efgh", reason)
        self.assertNotIn("\n", reason)

    def test_a_secret_cut_by_the_tail_is_still_redacted(self) -> None:
        stderr = "a" * 5000 + " password=VALUEVALUE " + "b" * 389
        self.s.install(self.target, ProbeResult(1, b"", stderr.encode()))
        self.assertNotIn("VALUEVALUE", self.skipped(self.target))

    def test_long_stderr_keeps_its_tail(self) -> None:
        self.s.install(self.target, ProbeResult(3, b"", b"x" * 5000 + b" the end"))
        reason = self.skipped(self.target)
        self.assertTrue(reason.endswith("the end"))
        self.assertLess(len(reason), 500)

    def test_timeout(self) -> None:
        self.s.install(self.target, ProbeResult(None, timed_out=True))
        self.assertEqual(self.skipped(self.target), "`--version` did not finish within 10 s")

    def test_overflow(self) -> None:
        self.s.install(self.target, ProbeResult(None, overflow=True))
        self.assertEqual(
            self.skipped(self.target), f"`--version` wrote more than {OUTPUT_CAP} bytes"
        )

    def test_start_failure(self) -> None:
        self.s.install(self.target, ProbeResult(None, error="No such file or directory"))
        self.assertEqual(
            self.skipped(self.target), "could not be started: No such file or directory"
        )

    def test_no_mcp_capability(self) -> None:
        self.s.install(self.target, mcp=ProbeResult(2, b"", b"Error: No such command 'mcp'."))
        self.assertEqual(
            self.skipped(self.target), "`mcp --help` exited with 2: Error: No such command 'mcp'."
        )

    def test_mcp_is_probed_only_after_a_compatible_version(self) -> None:
        self.s.install(self.target, "0.0.2")
        self.skipped(self.target)
        self.assertEqual(self.s.run.calls, [[self.target, "--version"]])

    def test_not_executable(self) -> None:
        self.s.install(self.target, executable=False)
        self.assertEqual(self.skipped(self.target), "is not executable")

    def test_broken_link(self) -> None:
        self.s.fs.link(self.target, "/gone/visionset")
        self.assertEqual(self.skipped(self.target), "is a broken link")

    def test_directory(self) -> None:
        self.s.fs.mkdir(self.target)
        self.assertEqual(self.skipped(self.target), "is a directory")

    def test_same_executable_is_not_probed_twice(self) -> None:
        real = self.s.install("/opt/v/bin/visionset", "0.0.1b1")
        self.s.fs.link(self.target, real)
        self.s.path("/usr/local/bin", "/opt/v/bin")
        self.assertEqual(self.skipped(real), "same executable as /usr/local/bin/visionset")
        self.assertEqual(self.s.run.probed(), [self.target])

    def test_probes_run_from_the_executable_directory(self) -> None:
        self.s.install(self.target)
        self.s.discover()
        self.assertEqual(set(self.s.run.cwds), {"/usr/local/bin"})

    def test_describe_names_tier_source_and_hides_home(self) -> None:
        path = self.s.install(HOME + "/.local/bin/visionset", "0.0.2")
        result = self.s.discover(project=None)
        line = describe(result.skipped[0], self.s.host())
        self.assertEqual(
            line, "user (pipx) ~/.local/bin/visionset: version 0.0.2 is outside ==0.0.1b4"
        )
        self.assertIn(HOME, path)


class WindowsTest(unittest.TestCase):
    HOME = "C:\\Users\\Ana Maria"

    def setUp(self) -> None:
        self.s = Scene(windows=True, home=self.HOME)
        self.project = "D:\\Work Dir\\Repo"
        self.s.fs.mkdir(self.project + "\\.git")

    def test_user_wins_over_project_scripts_first_in_path(self) -> None:
        self.s.install(self.project + "\\.venv\\Scripts\\visionset.exe")
        user = self.s.install(self.HOME + "\\.local\\bin\\visionset.exe")
        self.s.env["Path"] = f'd:\\work dir\\repo\\.venv\\Scripts;"{self.HOME}\\.local\\bin"'
        result = self.s.discover(project=self.project)
        self.assertEqual(chosen(result), (Tier.USER, "PATH", user))

    def test_project_scripts_dir_is_found_case_insensitively(self) -> None:
        venv = self.s.install(self.project + "\\.venv\\Scripts\\visionset.exe")
        result = self.s.discover(project="d:\\WORK DIR\\repo\\src")
        self.assertEqual(chosen(result)[0:2], (Tier.PROJECT, ".venv"))
        self.assertEqual(self.s.fs.k(chosen(result)[2]), self.s.fs.k(venv))

    def test_a_batch_shim_is_never_run(self) -> None:
        shim = self.s.install("C:\\Tools\\visionset.cmd")
        self.s.env["PATH"] = "C:\\Tools"
        result = self.s.discover(project=None)
        self.assertEqual(reasons(result), ["is a batch-file shim, which needs a shell; not run"])
        self.assertNotIn(shim, self.s.run.probed())

    def test_an_exe_is_preferred_to_a_batch_shim(self) -> None:
        self.s.install("C:\\Tools\\visionset.bat")
        exe = self.s.install("C:\\Tools\\visionset.exe")
        self.s.env["PATH"] = "C:\\Tools"
        self.assertEqual(chosen(self.s.discover(project=None))[2], exe)

    def test_user_scripts_under_appdata_newest_python_first(self) -> None:
        appdata = self.HOME + "\\AppData\\Roaming"
        self.s.install(appdata + "\\Python\\Python311\\Scripts\\visionset.exe", "0.0.1b1")
        newest = self.s.install(appdata + "\\Python\\Python313\\Scripts\\visionset.exe")
        self.s.env["APPDATA"] = appdata
        result = self.s.discover(project=None)
        self.assertEqual(chosen(result), (Tier.USER, "user scripts", newest))
        self.assertEqual(result.skipped, ())

    def test_uv_tool_and_pipx_locations(self) -> None:
        cases = {
            "uv tool": "C:\\AD\\uv\\data\\tools\\visionset\\Scripts\\visionset.exe",
            "pipx": self.HOME + "\\pipx\\venvs\\visionset\\Scripts\\visionset.exe",
            "pipx local": "C:\\LA\\pipx\\pipx\\venvs\\visionset\\Scripts\\visionset.exe",
        }
        for label, path in cases.items():
            with self.subTest(label):
                scene = Scene(windows=True, home=self.HOME)
                scene.install(path)
                scene.env.update(APPDATA="C:\\AD", LOCALAPPDATA="C:\\LA")
                self.assertEqual(chosen(scene.discover(project=None))[2], path)

    def test_an_untrusted_checkout_is_not_run(self) -> None:
        self.s.install(self.project + "\\.venv\\Scripts\\visionset.exe")
        result = self.s.discover(project=self.project, project_trusted=False)
        self.assertIsNone(result.selected)
        self.assertEqual(self.s.run.calls, [])

    def test_the_override_variable_is_case_insensitive(self) -> None:
        override = self.s.install("C:\\Dev\\visionset.exe")
        self.s.env[OVERRIDE_ENV.lower()] = override
        self.assertEqual(chosen(self.s.discover(project=None))[0], Tier.OVERRIDE)

    def test_redaction_hides_home_in_any_case(self) -> None:
        text = redact("failed in c:\\users\\ana maria\\x and C:\\Users\\Ana Maria", self.s.host())
        self.assertEqual(text, "failed in ~\\x and ~")
        text = redact("C:/Users/Ana Maria/x C:\\Users\\ANAMAR~1\\y", self.s.host())
        self.assertEqual(text, "~/x ~\\y")

    def test_drive_relative_path_entries_are_not_searched(self) -> None:
        self.s.install("\\tools\\visionset.exe")
        self.s.install("C:tools\\visionset.exe")
        self.s.env["PATH"] = "\\tools;C:tools"
        self.assertEqual(self.s.discover(project=None), Discovery(None, ()))


class HostTest(unittest.TestCase):
    def test_case_folding_follows_the_platform(self) -> None:
        for platform, folded in (("darwin", True), ("linux", False)):
            with self.subTest(platform=platform), mock.patch.object(sys, "platform", platform):
                self.assertEqual(Host.current().fold_case, folded)


class RedactionTest(unittest.TestCase):
    def host(self, **env: str) -> Host:
        return Host(env=env, windows=False, home=HOME)

    def test_secret_values_from_the_environment(self) -> None:
        host = self.host(HF_TOKEN="opaque-value-42", AWS_SECRET_ACCESS_KEY="zzzzzzzzzz", A="1")
        text = redact("auth with opaque-value-42 and zzzzzzzzzz failed: 1", host)
        self.assertEqual(text, "auth with <redacted> and <redacted> failed: 1")

    def test_secret_shapes(self) -> None:
        cases = {
            "Authorization: Bearer abc.def.ghi123": "Authorization: <redacted>",
            "use Bearer abc.def.ghi123": "use Bearer <redacted>",
            "https://bob:hunter2@pypi.example/simple": "https://<redacted>@pypi.example/simple",
            "https://tok@pypi.example/simple": "https://<redacted>@pypi.example/simple",
            "api_key = 'x y z'": "api_key = <redacted>",
            "PASSWORD:hunter2": "PASSWORD:<redacted>",
            "using ghp_" + "a" * 36: "using <redacted>",
            "github_pat_" + "B" * 30: "<redacted>",
            "sk-" + "c" * 30: "<redacted>",
            "hf_" + "d" * 30: "<redacted>",
            "AKIA" + "E" * 16: "<redacted>",
            "glpat-" + "f" * 20: "<redacted>",
            "xoxb-1234567890-abc": "<redacted>",
            "npm_" + "g" * 36: "<redacted>",
            '{"token": "s3cr3tvalue"}': '{"token": <redacted>}',
            "{'password': 'hunter2xx'}": "{'password': <redacted>}",
            "--token s3cr3tvalue --other": "--token <redacted> --other",
            "Authorization: token abcdef": "Authorization: <redacted>",
            "private_key: -----BEGIN": "private_key: <redacted>",
            "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY----- ok": (
                "<redacted> ok"
            ),
            "https://u:p@ss@host/x": "https://<redacted>@host/x",
            "//tok@host/x": "//<redacted>@host/x",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(redact(raw, self.host()), expected)

    def test_home_but_not_a_sibling_sharing_its_prefix(self) -> None:
        host = Host(env={}, windows=False, home="/var/lib/svc")
        text = redact("/var/lib/svc/a /var/lib/svc '/var/lib/svc' /var/lib/svcx/b", host)
        self.assertEqual(text, "~/a ~ '~' /var/lib/svcx/b")

    def test_any_user_home_is_hidden(self) -> None:
        text = redact("/home/other/.config /Users/bob/x c:/Users/x/y /srv/home/keep", self.host())
        self.assertEqual(text, "~/.config ~/x ~/y /srv/home/keep")

    def test_short_secrets_are_redacted_by_name(self) -> None:
        host = self.host(DB_PASSWORD="12345", HF_HUB_DISABLE_TOKEN="1")
        self.assertEqual(redact("pw 12345 x123456 exit 1", host), "pw <redacted> x123456 exit 1")

    def test_control_characters_and_lines_collapse(self) -> None:
        self.assertEqual(
            redact("\x1b[31mred\x1b[0m\nnext\r\tline\x07", self.host()), "red next line"
        )


class BundleTest(unittest.TestCase):
    def test_the_rendered_bundle_loads(self) -> None:
        bundle = load_bundle(_support.RUNTIME / "bundle.json")
        rendered = json.loads((_support.RUNTIME / "bundle.json").read_text(encoding="utf-8"))
        self.assertEqual(bundle.compatibility, rendered["compatibility"])
        self.assertEqual(bundle.console_script, "visionset")

    def test_unreadable_bundles(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / "bundle.json"
            for text in (
                "{",
                "{}",
                json.dumps({"distribution": "v", "console_script": "v", "compatibility": ">=1"}),
            ):
                with self.subTest(text=text):
                    path.write_text(text, encoding="utf-8")
                    with self.assertRaises(BundleError):
                        load_bundle(path)
            with self.assertRaises(BundleError):
                load_bundle(Path(scratch) / "missing.json")

    def test_only_an_exact_range_is_read(self) -> None:
        for compatibility in (">=0.0.1", "~=0.0.1", "==", "==banana", "0.0.1b4"):
            with self.subTest(compatibility=compatibility), self.assertRaises(BundleError):
                discover(compatibility=compatibility, host=Host({}, False, HOME), fs=FakeFs())

    def test_versions_compare_after_normalisation(self) -> None:
        for printed in ("0.0.1b4", "0.0.1.0b4", "0.0.1b04", "0.0.1B4"):
            with self.subTest(printed=printed):
                s = Scene()
                s.install("/usr/bin/visionset", printed)
                s.path("/usr/bin")
                self.assertIsNotNone(s.discover(project=None).selected)
        for printed in ("0.0.1", "0.0.1b4.dev1", "0.0.1rc4", "0.1.1b4"):
            with self.subTest(printed=printed):
                s = Scene()
                s.install("/usr/bin/visionset", printed)
                s.path("/usr/bin")
                self.assertIsNone(s.discover(project=None).selected)


class NoNetworkTest(unittest.TestCase):
    def test_discovery_imports_no_network_module(self) -> None:
        tree = ast.parse((_support.RUNTIME / "discover.py").read_text(encoding="utf-8"))
        imported = {
            alias.name.split(".")[0]
            for node in ast.walk(tree)
            if isinstance(node, ast.Import | ast.ImportFrom)
            for alias in (
                node.names if isinstance(node, ast.Import) else [ast.alias(node.module or "")]
            )
        }
        network = {"socket", "ssl", "http", "urllib", "ftplib", "smtplib", "asyncio", "xmlrpc"}
        self.assertEqual(imported & network, set())


if __name__ == "__main__":
    unittest.main()
