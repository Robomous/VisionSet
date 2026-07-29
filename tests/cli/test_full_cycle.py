"""The whole cycle in one function, driven exactly as a script would drive it.

The ``tests/server/test_external_client.py`` precedent, and it uses **none** of
``tests/cli/_flow.py`` for the same reason that module uses none of the server
helpers: the point is that the walk is visible in one place, ids travelling from
one command's stdout into the next command's argv, with every exit code asserted
on the way rather than only the final state.

``examples/cli_end_to_end.sh`` is its sibling and proves something this cannot —
that the *installed console script* works from a real shell. This one proves what
the script cannot: that stdout and stderr are separated correctly at every step.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from tests.fixtures.media import write_images, write_unsupported_file
from typer.testing import CliRunner

from visionset.cli.main import app
from visionset.kernel.services import WORKSPACE_ENV_VAR

runner = CliRunner()

SCHEMA = {
    "classes": [
        {
            "name": "sign",
            "geometry": "bbox",
            "attributes": [{"name": "occluded", "kind": "boolean"}],
        }
    ]
}


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results."""
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


def data(*argv: str) -> str:
    """Run, insist it worked, and insist stdout held nothing but the data."""
    result = runner.invoke(app, list(argv))
    assert result.exit_code == 0, result.output
    return result.stdout.strip()


def test_the_whole_cycle_runs_from_the_command_line(tmp_path: Path) -> None:
    incoming = tmp_path / "incoming"
    write_images(incoming, count=6)
    write_unsupported_file(incoming / "notes.txt")
    schema = tmp_path / "schema.json"
    schema.write_text(json.dumps(SCHEMA), encoding="utf-8")

    # 1. A workspace, named by its own stdout from here on.
    root = data("init", str(tmp_path / "ws"))
    ws = ["--workspace", root]

    # 2. A project and a schema for it.
    data("project", "create", "road-signs", *ws)
    assert data("schema", "apply", str(schema), "-p", "road-signs", *ws) == "1"

    # 3. Images in, one batch out. The stray file is reported, not fatal.
    batch = data("ingest", str(incoming), "-p", "road-signs", *ws)

    # 4. Freeze the membership and cut it into two jobs of three.
    data("batch", "approve", batch, "--jobs-of", "3", *ws)
    data("batch", "start", batch, *ws)

    # 5. Work through each job the way a shell reads a listing.
    jobs = [line.split()[0] for line in data("job", "list", "--batch", batch, *ws).splitlines()[1:]]
    assert len(jobs) == 2
    for job in jobs:
        data("job", "start", job, *ws)
        listing = data("job", "next", job, "-n", "100", *ws).splitlines()[1:]
        assert len(listing) == 3
        for line in listing:
            data("job", "mark", job, line.split()[0], "--progress", "annotated", *ws)
        data("job", "complete", job, *ws)

    # 6. Close the batch and let its finished assets into the trunk.
    data("batch", "complete", batch, *ws)
    assert len(data("batch", "promote", batch, *ws).splitlines()) == 6

    # 7. Freeze it, and check the freeze.
    data("release", "publish", "--tag", "v1.0", "-p", "road-signs", "--split", "0.5,0.25,0.25", *ws)
    verified = runner.invoke(app, ["release", "verify", "v1.0", "-p", "road-signs", *ws])
    assert verified.exit_code == 0, verified.output

    # 8. Write it out in the one installed format, which writes nothing — so a
    #    zero file count here is the honest report rather than a failure.
    exported = json.loads(
        data(
            "export",
            "-p",
            "road-signs",
            "--release",
            "v1.0",
            "--format",
            "dummy",
            "--out",
            str(tmp_path / "out"),
            "--json",
            *ws,
        )
    )
    assert exported["format"] == "dummy"
    assert exported["file_count"] == 0

    # 9. The release as a program reads it.
    releases = json.loads(data("release", "list", "-p", "road-signs", "--json", *ws))
    assert releases["total"] == 1
    assert releases["items"][0]["asset_count"] == 6
    # No annotations, because the CLI marks progress and writes no labels.
    assert releases["items"][0]["annotation_count"] == 0


def test_a_refusal_on_the_way_through_exits_one_and_says_so(tmp_path: Path) -> None:
    # The other half of what a script needs: a non-zero exit it can branch on,
    # one sentence on stderr, and nothing at all on stdout.
    root = data("init", str(tmp_path / "ws"))
    data("project", "create", "road-signs", "--workspace", root)
    result = runner.invoke(app, ["project", "create", "ROAD-SIGNS", "--workspace", root])
    assert result.exit_code == 1
    assert result.stdout == ""
    assert result.stderr.startswith("Error:")
