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
import re
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import typer.rich_utils
from click.testing import Result
from tests.fixtures.media import write_images, write_unsupported_file
from typer.testing import CliRunner

from visionset.cli.main import app

runner = CliRunner()

SCHEMA_DOCUMENT = {
    "classes": [
        {
            "name": "sign",
            "geometries": ["bbox"],
            "color": "#ff0000",
            "attributes": [{"name": "occluded", "kind": "boolean", "default": False}],
        }
    ]
}
"""The smallest schema that is not trivial: one class, one optional attribute."""

IMAGE_COUNT = 6
"""Six stills, so ``--jobs-of 3`` cuts exactly two jobs with no remainder."""


NARROW = "40"
"""The width every invocation renders at, so no test depends on the terminal's."""

RENDERING = {"TERM": "xterm-256color", "NO_COLOR": None}
"""The environment every invocation renders in — narrow, and in colour.

Three things outside a test's control decide what a rich ``Panel`` looks like,
and each of them has already broken this suite: the **width**, which rich takes
from the process's own file descriptors and so reads as the developer's terminal
under ``pytest`` and 80 columns under an xdist worker's pipe; the **line breaks**
that width produces; and whether rich emits **SGR escapes**, which it does on CI
and did not locally, splicing ``\\x1b[31m`` between the halves of a phrase.

Only rich responds to either variable — ``cli/_output.py``'s listings and
``cli/_errors.py``'s domain errors are plain ``typer.echo``, which neither wraps
nor colours under ``CliRunner``.

**Both are pinned to the hostile setting on purpose.** Wide and uncoloured would
hide the wrap and the escapes, and hiding them is precisely what let
``bash scripts/check.sh python`` fail on messages CI reads correctly (#535).
Narrow and coloured makes every ``exit_code == 2`` assertion prove it survives
both, on every machine and under any runner — and makes a local run and a CI run
render identically.
"""


@contextmanager
def _rich_rendering() -> Iterator[None]:
    """Pin Typer's import-time Rich settings for one test invocation."""
    old_force_terminal = typer.rich_utils.FORCE_TERMINAL
    old_max_width = typer.rich_utils.MAX_WIDTH
    typer.rich_utils.FORCE_TERMINAL = True
    typer.rich_utils.MAX_WIDTH = int(NARROW)
    try:
        yield
    finally:
        typer.rich_utils.FORCE_TERMINAL = old_force_terminal
        typer.rich_utils.MAX_WIDTH = old_max_width


def run(root: Path, *argv: str) -> Result:
    """Invoke the real app against a workspace, without asserting anything."""
    with _rich_rendering():
        return runner.invoke(app, [*argv, "--workspace", str(root)], env=RENDERING, color=True)


def ok(root: Path, *argv: str) -> str:
    """Invoke, insist it worked, and hand back stdout — usually an id."""
    result = run(root, *argv)
    assert result.exit_code == 0, result.output
    return result.stdout.strip()


def payload(root: Path, *argv: str) -> dict:
    """The ``--json`` document a command printed, parsed."""
    return json.loads(ok(root, *argv, "--json"))


_BOX_DRAWING = re.compile(r"[─-╿]")
"""The Unicode block rich draws a panel's border from."""

_SGR = re.compile(r"\x1b\[[0-9;]*m")
"""The colour escapes rich writes when it believes it has a colour terminal."""


def plain(text: str) -> str:
    """``text`` with the colour stripped, so what is left is what a person reads."""
    return _SGR.sub("", text)


def usage_error(result: Result) -> str:
    """A usage error's text as one line, with the panel's wrapping undone.

    **Every ``exit_code == 2`` assertion reads its message through this, never
    raw.** A usage error is a ``typer.BadParameter``, and Typer hands those to
    ``rich_utils.rich_format_error``, which prints them inside a rich ``Panel`` —
    unlike ``cli/_errors.py``'s domain errors, which are a plain ``typer.secho``
    and cannot wrap. The panel word-wraps, so a phrase can be split across two
    lines and stop being a substring of the output while remaining perfectly
    correct on screen.

    Colour is stripped first, because rich puts an escape at every style change
    and one lands **between the halves of a wrapped phrase**: the border is
    ``\\x1b[31m│\\x1b[0m``, so rejoining without stripping splices the escapes into
    the message. See ``RENDERING`` for why colour is on rather than off.

    Which width it wraps at is not the test's to choose. Rich asks
    ``os.get_terminal_size`` about **the process's own file descriptors** — never
    the ``CliRunner``'s buffers — so under a plain ``pytest`` the panel is as wide
    as the developer's terminal, while under ``pytest -n auto`` an xdist worker
    writes to a pipe, the call raises ``OSError`` and rich falls back to 80
    columns. That is one test with two wrap points, which is how ``scripts/check.sh``
    came to fail on messages CI reads correctly (#535).

    The one limit, so it is not discovered the hard way: this rejoins **words**.
    A token rich broke in the middle — only possible for one longer than the panel
    is wide — is not put back together.
    """
    return " ".join(_BOX_DRAWING.sub(" ", plain(result.output)).split())


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
