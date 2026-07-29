# usage: from tests.cli._flow import ok, run, workspace
"""Walking the CLI up to a given rung, by invoking the CLI.

Plain functions, the way ``tests/server/_flow.py`` and ``tests/fixtures/media.py``
are plain functions — there is no ``conftest.py`` anywhere in this repository and
this is not the module that starts one.

**Every rung is reached by running commands, never by calling the SDK.** A helper
that reached for ``BatchService`` to build "an approved batch" would test the
later command against a state no user can produce; building it with
``visionset batch approve`` means the ladder is itself under test on the way up.
The one exception is reading state *back* for an assertion, which a test does
through the kernel — output is what is being checked, so it cannot also be the
evidence.
"""

from __future__ import annotations

import json
from pathlib import Path

from click.testing import Result
from tests.fixtures.media import write_images, write_unsupported_file
from typer.testing import CliRunner

from visionset.cli.main import app

runner = CliRunner()

SCHEMA_DOCUMENT = {
    "classes": [
        {
            "name": "sign",
            "geometry": "bbox",
            "color": "#ff0000",
            "attributes": [{"name": "occluded", "kind": "boolean", "default": False}],
        }
    ]
}
"""The smallest schema that is not trivial: one class, one optional attribute."""

IMAGE_COUNT = 6
"""Six stills, so ``--jobs-of 3`` cuts exactly two jobs with no remainder."""


def run(root: Path, *argv: str) -> Result:
    """Invoke the real app against a workspace, without asserting anything."""
    return runner.invoke(app, [*argv, "--workspace", str(root)])


def ok(root: Path, *argv: str) -> str:
    """Invoke, insist it worked, and hand back stdout — usually an id."""
    result = run(root, *argv)
    assert result.exit_code == 0, result.output
    return result.stdout.strip()


def payload(root: Path, *argv: str) -> dict:
    """The ``--json`` document a command printed, parsed."""
    return json.loads(ok(root, *argv, "--json"))


def workspace(tmp_path: Path) -> Path:
    """A workspace created the way a person creates one."""
    root = tmp_path / "ws"
    result = runner.invoke(app, ["init", str(root)])
    assert result.exit_code == 0, result.output
    return root


def project(root: Path, name: str = "road-signs") -> str:
    """A project, named."""
    ok(root, "project", "create", name)
    return name


def schema_file(tmp_path: Path) -> Path:
    """``SCHEMA_DOCUMENT`` on disk, ready for ``schema apply``."""
    path = tmp_path / "schema.json"
    path.write_text(json.dumps(SCHEMA_DOCUMENT), encoding="utf-8")
    return path


def stills(tmp_path: Path, *, count: int = IMAGE_COUNT, stray: bool = False) -> Path:
    """A folder of distinct images, optionally with one file that is not an image."""
    directory = tmp_path / "incoming"
    write_images(directory, count=count)
    if stray:
        write_unsupported_file(directory / "notes.txt")
    return directory


def schemad_project(root: Path, tmp_path: Path, name: str = "road-signs") -> str:
    """A project with schema version 1 applied."""
    project(root, name)
    ok(root, "schema", "apply", str(schema_file(tmp_path)), "--project", name)
    return name


def ingested_batch(root: Path, tmp_path: Path, *, stray: bool = False) -> tuple[str, str]:
    """A project with a schema and one draft batch full of stills."""
    name = schemad_project(root, tmp_path)
    batch = ok(
        root,
        "ingest",
        str(stills(tmp_path, stray=stray)),
        "--project",
        name,
        "--batch-name",
        "stills",
    )
    return name, batch


def started_batch(root: Path, tmp_path: Path, *, jobs_of: int | None = None) -> tuple[str, str]:
    """The same, approved and opened for annotation."""
    name, batch = ingested_batch(root, tmp_path)
    approve = ["batch", "approve", batch]
    if jobs_of is not None:
        approve += ["--jobs-of", str(jobs_of)]
    ok(root, *approve)
    ok(root, "batch", "start", batch)
    return name, batch


def jobs_of(root: Path, batch: str) -> list[str]:
    """The ids in a batch's job listing, the way a shell reads them."""
    return [line.split()[0] for line in ok(root, "job", "list", "--batch", batch).splitlines()[1:]]


def completed_batch(
    root: Path, tmp_path: Path, *, jobs_of_size: int | None = None
) -> tuple[str, str]:
    """Every asset marked ``annotated``, every job closed, the batch closed."""
    name, batch = started_batch(root, tmp_path, jobs_of=jobs_of_size)
    for job in jobs_of(root, batch):
        ok(root, "job", "start", job)
        listing = ok(root, "job", "next", job, "-n", "100").splitlines()[1:]
        for line in listing:
            ok(root, "job", "mark", job, line.split()[0], "--progress", "annotated")
        ok(root, "job", "complete", job)
    ok(root, "batch", "complete", batch)
    return name, batch


def promoted_project(root: Path, tmp_path: Path) -> str:
    """A dataset with something in it, which is what publishing needs."""
    name, batch = completed_batch(root, tmp_path)
    ok(root, "batch", "promote", batch)
    return name


def published_release(root: Path, tmp_path: Path, tag: str = "v1.0") -> str:
    """A published release, and the project it belongs to."""
    name = promoted_project(root, tmp_path)
    ok(root, "release", "publish", "--tag", tag, "--project", name)
    return name
