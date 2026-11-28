from __future__ import annotations

import shutil
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path

import _support


class SetupAgentsTest(unittest.TestCase):
    """End-user skills ship in the bundle; `setup_agents.sh` links maintainer skills only."""

    def test_bundle_skills_are_never_linked_for_maintainers(self) -> None:
        bash = shutil.which("bash")
        if bash is None:
            self.skipTest("bash is not available")
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            (root / "scripts").mkdir()
            shutil.copy2(_support.REPO / "scripts" / "setup_agents.sh", root / "scripts")
            (root / "AGENTS.md").write_text("# agents\n", encoding="utf-8")
            maintainer = root / ".agents" / "skills" / "maintainer-skill"
            maintainer.mkdir(parents=True)
            (maintainer / "SKILL.md").write_text("---\nname: maintainer-skill\n---\n")
            bundled = root / "agent-plugins" / "packages" / "visionset" / "skills" / "user-skill"
            bundled.mkdir(parents=True)
            (bundled / "SKILL.md").write_text("---\nname: user-skill\n---\n")

            result = subprocess.run(
                [bash, str(root / "scripts" / "setup_agents.sh")],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            for tool in (".claude", ".cursor"):
                with self.subTest(tool=tool):
                    linked = sorted(path.name for path in (root / tool / "skills").iterdir())
                    self.assertEqual(linked, ["maintainer-skill"])


class DistributionTest(unittest.TestCase):
    def setUp(self) -> None:
        text = (_support.REPO / "pyproject.toml").read_text(encoding="utf-8")
        self.targets = tomllib.loads(text)["tool"]["hatch"]["build"]["targets"]

    def test_the_wheel_packages_only_the_distribution(self) -> None:
        self.assertEqual(self.targets["wheel"]["packages"], ["src/visionset"])

    def test_the_sdist_leaves_the_plugin_tree_out(self) -> None:
        self.assertIn("/agent-plugins", self.targets["sdist"]["exclude"])


if __name__ == "__main__":
    unittest.main()
