"""The whole cycle over MCP stdio, from a real client — M3's exit criterion, leg three.

An agent's transport, driven by a script::

    uv run python examples/mcp_end_to_end.py [DESTINATION]

Its two siblings walk the same ground through the CLI and over HTTP. This one
spawns `visionset mcp` as a subprocess and speaks JSON-RPC down its pipe, which
is exactly what Claude Code or any other MCP client does when it reads a server
out of its configuration. Nothing is mocked and nothing is in-memory: the
`tests/mcp/` suite drives the protocol over a paired stream inside one process,
which proves the tools, and this proves the *transport* — that stdout really is
the wire, that the banner really is on stderr, and that the workspace really
does travel from the command line into the child through the environment.

**No development dependency.** The `mcp` package is a runtime dependency of
VisionSet, so its client half is already here; the async bridge is
`asyncio.run`, from the standard library, rather than the `anyio.run` the tests
use — `anyio` is a dev dependency and an example must run from an installed
wheel.

**One session for the whole walk**, unlike `tests/mcp/_flow.py`, which opens a
fresh one per call. This is the real client shape, and the server is built for
it: it opens and closes the workspace inside every tool call, so holding a
session open holds no SQLite handle and locks nobody out.

The one thing this leg shows that neither sibling can: **an agent's coordinates
are not in the frame it measured them in.** `get_asset_image` sends a preview
capped at 256 pixels on its long edge, while annotation geometry is always in
the asset's own pixels. A 640x480 asset therefore previews 2.5x smaller, and a
box submitted unscaled is individually plausible and uniformly wrong — nothing
downstream can detect it, because every number is in range and every shape is
well formed. So the walk below does the multiplication for real, and asserts
that it had to.
"""

from __future__ import annotations

import asyncio
import base64
import io
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Reached through their defining submodules rather than through the `mcp`
# package root, which would work equally well and sort into the wrong block:
# `src = ["src", "tests", "scripts"]` plus a `tests/mcp/` directory makes ruff
# read a bare `mcp` as first-party, so the four names would split across two
# import groups. These paths are also simply more precise.
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.types import CallToolResult
from PIL import Image

from visionset.kernel.services import WorkspaceService

#: Where the example puts its workspace unless told otherwise. Under
#: ``workspace-data/``, which the repository ignores by design.
DEFAULT_DEST = Path(__file__).resolve().parent / "workspace-data" / "mcp-e2e"

#: Four stills, cut into two jobs, so the walk proves a batch completes when
#: *every* job does rather than when the first one does.
FRAME_COUNT = 4
JOB_SIZE = 2

#: Deliberately larger than the 256-pixel preview cap, and by a ratio that is
#: not 1. At 640x480 the preview comes back 256x192 and ``scale`` is 2.5, so the
#: multiplication below is load-bearing rather than decorative. Shrink this to
#: 256 or less and the example would still pass while proving nothing.
FRAME_SIZE = (640, 480)

PROJECT = "road-signs"
TAG = "v1.0"

VISIONSET_MISSING = (
    "the `visionset` console script is not on PATH, and this example spawns an MCP server "
    "with it.\nRun it through the project environment: "
    "`uv run python examples/mcp_end_to_end.py`."
)


@dataclass(frozen=True)
class Summary:
    """What the run produced, for a reader and for the smoke test alike."""

    project_id: str
    tool_count: int
    schema_version: int
    batch_id: str
    asset_ids: tuple[str, ...]
    job_count: int
    native_size: tuple[int, int]
    preview_size: tuple[int, int]
    scale: float
    annotation_count: int
    promoted: int
    stats_classes: tuple[str, ...]
    release_tag: str
    verified: bool
    formats: tuple[str, ...]
    export_directory: str
    republish_retry_with: Any


# --- reading a tool result ------------------------------------------------


def ok(result: CallToolResult) -> dict[str, Any]:
    """The structured payload, after asserting the call actually succeeded.

    There are **two** failure shapes over MCP, deliberately. A malformed
    *request* comes back with ``isError`` set, carrying the validator's field
    path. A domain refusal — a duplicate tag, an unknown project — comes back as
    an ordinary *result* whose payload is an error envelope, because the call
    was well formed and the answer is no. Checking only ``isError`` would let
    every refusal in the walk pass silently, so this checks both.
    """
    assert not result.is_error, result.content
    assert result.structured_content is not None, result.content
    assert "error" not in result.structured_content, result.structured_content
    return result.structured_content


def refusal(result: CallToolResult) -> dict[str, Any]:
    """The error envelope of a domain refusal — a result, not a protocol error."""
    assert not result.is_error, result.content
    assert result.structured_content is not None, result.content
    envelope = result.structured_content.get("error")
    assert envelope is not None, result.structured_content
    assert isinstance(envelope, dict)
    return envelope


def preview_of(result: CallToolResult) -> Image.Image:
    """The image block of a ``get_asset_image`` result, decoded.

    The pixels arrive as a base64 image content block beside the structured
    payload — the block is what an agent *sees*, the payload is the frame its
    coordinates have to live in. Opening it here is how the walk proves the two
    are describing the same picture at different sizes.
    """
    block = next(item for item in result.content if item.type == "image")
    return Image.open(io.BytesIO(base64.b64decode(block.data)))


# --- synthetic media ------------------------------------------------------


def write_frames(directory: Path, count: int) -> Path:
    """Stills on disk, because MCP's ``ingest`` takes a path.

    The HTTP sibling uploads bytes; this one hands over a directory. That is not
    an inconsistency — the staging area on the server exists precisely because
    HTTP has no paths, and an agent running beside the workspace does. Each
    image gets its own pixels, so no pair deduplicates by accident.
    """
    directory.mkdir(parents=True, exist_ok=True)
    width, height = FRAME_SIZE
    for index in range(count):
        image = Image.new("RGB", FRAME_SIZE, ((index * 60) % 256, 90, 170))
        # A block in a different place per frame, so the four are distinct and a
        # dedup would show up as a missing asset rather than as nothing at all.
        for y in range(index * 20, index * 20 + 40):
            for x in range(index * 30, index * 30 + 60):
                image.putpixel((x % width, y % height), (250, 40, 40))
        image.save(directory / f"frame-{index:03d}.png", format="PNG")
    return directory


# --- the cycle ------------------------------------------------------------


def main(dest: Path) -> Summary:
    """Drive an empty directory to an exported release, all of it over MCP stdio.

    ``dest`` must not already hold a workspace: this creates one. Everything the
    run produces lives under it — the workspace at ``ws/``, the inputs at
    ``incoming/`` and the export at ``export/``.
    """
    if shutil.which("visionset") is None:
        # Asserted rather than skipped, and before anything is written: the
        # console script is this example's one requirement, and a machine
        # without it must leave no half-made workspace behind.
        raise SystemExit(VISIONSET_MISSING)

    root = dest / "ws"
    # The one SDK call in this file, and it is the operator's, not the agent's:
    # `visionset mcp` opens the workspace before it starts the server and
    # refuses a directory that is not one, so somebody has to create it first.
    # Creating a workspace is deliberately not an MCP tool — it is the sandbox
    # boundary, and an agent does not get to move it.
    WorkspaceService.init(root, name="mcp-end-to-end").close()
    incoming = write_frames(dest / "incoming", FRAME_COUNT)
    _say(f"workspace at {root}, {FRAME_COUNT} frames at {FRAME_SIZE[0]}x{FRAME_SIZE[1]} to read")

    return asyncio.run(_walk(root, incoming, dest / "export"))


async def _walk(root: Path, incoming: Path, export: Path) -> Summary:
    """Connect to `visionset mcp` over a pipe and take the cycle end to end."""
    # The command a user puts in an MCP client's configuration, spawned exactly
    # as that client would spawn it. `--workspace` is how the root travels: the
    # command resolves it, opens it once to run any migration, states it in
    # VISIONSET_WORKSPACE and hands that environment to the server it starts.
    # No tool takes a workspace parameter, because a path is not something an
    # agent can be expected to know.
    server = StdioServerParameters(command="visionset", args=["mcp", "--workspace", str(root)])

    async with stdio_client(server) as (read, write), ClientSession(read, write) as session:
        await session.initialize()

        listed = await session.list_tools()
        _say(f"connected over stdio: {len(listed.tools)} tools offered")

        async def tool(name: str, /, **arguments: Any) -> CallToolResult:
            return await session.call_tool(name, arguments)

        # (1) Discover an empty workspace and make somewhere to work.
        assert ok(await tool("list_projects")) == {"items": [], "total": 0}
        created = ok(await tool("create_project", name=PROJECT, description="signage survey"))
        project_id = created["project"]["id"]
        _say(f"project {PROJECT!r} ({project_id})")

        # (2) Declare the contract before any work is judged against it. The
        # domain models go straight into the tool signature, so these two dicts
        # are validated by the kernel's own rules and refused in its own words.
        schema = ok(
            await tool(
                "create_schema_version",
                project=PROJECT,
                classes=[
                    {"name": "sign", "geometry": "bbox"},
                    {"name": "empty-road", "geometry": "classification_tag"},
                ],
            )
        )
        assert ok(await tool("get_schema", project=PROJECT))["active_version"] == schema["version"]

        # (3) Read the folder in. **One call, and it returns when the work is
        # done** — the opposite of the HTTP leg's 202-and-poll, and not an
        # oversight: a stdio server has no background worker, so a job row an
        # agent had to poll would block for exactly as long as doing the work.
        # The remedy for an interrupted run is to call `ingest` again, which is
        # free: registration is idempotent and identity is content.
        run = ok(await tool("ingest", project=PROJECT, path=str(incoming)))
        assert (run["created"], run["deduplicated"], run["failed"]) == (FRAME_COUNT, 0, 0), run
        batch_id = run["batch_id"]
        _say(f"ingest returned synchronously: {run['created']} assets in batch {batch_id}")

        # (4) Freeze it, pin the schema, cut it in two, and open it for work.
        approved = ok(await tool("approve_batch", batch_id=batch_id, jobs_of=JOB_SIZE))
        started = ok(await tool("start_batch", batch_id=batch_id))
        assert started["state"] == "in_annotation", started
        _say(
            f"approved against schema v{approved['schema_version']} "
            f"into {len(approved['jobs'])} jobs"
        )

        # (5) Work each job: look, then label. This is the part that makes it an
        # annotator rather than an operator, and the part with the trap.
        asset_ids: list[str] = []
        written = 0
        native = preview = (0, 0)
        scale = 0.0
        for job in started["jobs"]:
            job_id = job["id"]
            # Nothing marks the job as being worked on: there is no tool for it
            # (#109). It is `pending` until the first write, which starts it and
            # says so — so this walk never spends a call on ceremony.
            assert ok(await tool("get_job", job_id=job_id))["state"] == "pending"
            pending = ok(await tool("next_pending_assets", job_id=job_id, count=10))

            for index, asset in enumerate(pending["items"]):
                asset_ids.append(asset["id"])
                seen = await tool("get_asset_image", project=PROJECT, asset_id=asset["id"])
                frame = ok(seen)
                with preview_of(seen) as opened:
                    # The pixels that arrived really are the size the payload
                    # says they are. Without this the scale below could be
                    # asserted against a number nobody sent.
                    assert opened.size == (frame["image_width"], frame["image_height"]), opened.size
                    preview = opened.size

                native = (frame["width"], frame["height"])
                scale = frame["scale"]
                assert native == FRAME_SIZE, native
                assert scale > 1, "the preview was not smaller — this example proves nothing now"

                if index == 0:
                    # Measured on what was seen; submitted in what the asset is.
                    measured = {"x": 10.0, "y": 12.0, "width": 40.0, "height": 30.0}
                    scaled = {edge: value * scale for edge, value in measured.items()}
                    labels = ok(
                        await tool(
                            "add_annotations",
                            job_id=job_id,
                            annotations=[
                                {
                                    "asset_id": asset["id"],
                                    "label_class": "sign",
                                    "geometry": {"type": "bbox", **scaled},
                                    "provenance": "model",
                                    "model_ref": "mcp-end-to-end@1",
                                    "confidence": 0.82,
                                }
                            ],
                        )
                    )
                    # The write took the job to `in_progress` and reported it, so
                    # the move is a fact the agent is told rather than one it has
                    # to go and read back.
                    assert labels["job_started"] is True, labels
                    assert ok(await tool("get_job", job_id=job_id))["state"] == "in_progress"
                    written += len(labels["items"])
                    box = labels["items"][0]["geometry"]
                    assert box["x"] + box["width"] <= frame["width"], box
                else:
                    ok(
                        await tool(
                            "set_asset_progress",
                            job_id=job_id,
                            asset_id=asset["id"],
                            progress="skipped",
                        )
                    )

            assert ok(await tool("next_pending_assets", job_id=job_id, count=10))["total"] == 0
            assert ok(await tool("complete_job", job_id=job_id))["state"] == "completed"

        _say(
            f"an agent saw {preview[0]}x{preview[1]} and labelled in {native[0]}x{native[1]}: "
            f"every box multiplied by {scale}"
        )

        # (6) Close the batch and move the finished work into the trunk. The
        # skipped assets stay behind, which is what a skip is for.
        assert ok(await tool("complete_batch", batch_id=batch_id))["state"] == "completed"
        promoted = ok(await tool("promote_batch", batch_id=batch_id))["total"]
        stats = ok(await tool("dataset_stats", project=PROJECT))
        # A class the schema declares but nobody used is absent, not zero —
        # which classes exist is the schema's answer, read from the schema.
        classes = tuple(row["label_class"] for row in stats["classes"])
        assert "empty-road" not in classes, classes
        _say(f"{promoted} assets promoted, {stats['annotation_count']} labels, classes {classes}")

        # (7) Freeze, check, and write it where something can train on it. The
        # export takes a local `dest` rather than returning an archive: an agent
        # runs beside the filesystem, and a base64 zip is a token bill nobody
        # wants to pay.
        release = ok(
            await tool(
                "publish_release",
                project=PROJECT,
                tag=TAG,
                split={"train": 0.5, "val": 0.25, "test": 0.25, "seed": 7},
            )
        )
        assert ok(await tool("list_releases", project=PROJECT))["total"] == 1
        verified = ok(await tool("verify_release", project=PROJECT, tag=TAG))["ok"]
        formats = tuple(row["name"] for row in ok(await tool("list_formats"))["items"])
        exported = ok(
            await tool("export_release", project=PROJECT, tag=TAG, format="dummy", dest=str(export))
        )
        assert Path(exported["directory"]).is_dir(), exported
        _say(f"release {TAG} verified {verified}, exported to {exported['directory']}")

        # (8) And the walk ends on a refusal it also asserts. A release is
        # immutable, so the tag cannot be reused — and the envelope carries
        # `retry_with` rather than a code, because "which flag would make this
        # work?" is the only question a code was ever needed for. Here the
        # answer is null: nothing makes it work, and a client that retried in a
        # loop would loop forever.
        reused = refusal(await tool("publish_release", project=PROJECT, tag=TAG))
        assert set(reused) == {"message", "retry_with", "hint", "index"}, reused
        assert reused["retry_with"] is None, reused
        _say(f"reusing the tag is refused with retry_with={reused['retry_with']}, as it should be")

        return Summary(
            project_id=project_id,
            tool_count=len(listed.tools),
            schema_version=schema["version"],
            batch_id=batch_id,
            asset_ids=tuple(asset_ids),
            job_count=len(approved["jobs"]),
            native_size=native,
            preview_size=preview,
            scale=scale,
            annotation_count=written,
            promoted=promoted,
            stats_classes=classes,
            release_tag=release["tag"],
            verified=verified,
            formats=formats,
            export_directory=exported["directory"],
            republish_retry_with=reused["retry_with"],
        )


def _say(message: str) -> None:
    print(f"  · {message}")


# --- running it -----------------------------------------------------------


def _clear_previous_run(dest: Path) -> None:
    """Remove a previous run of this example, and refuse to remove anything else.

    Only ever called for :data:`DEFAULT_DEST`. A directory that holds anything
    other than what this example writes is not ours to delete, so it stops
    instead of guessing.
    """
    if not dest.exists():
        return
    if not dest.is_dir():
        raise SystemExit(f"refusing to run: {dest} exists and is not a directory")
    ours = {"ws", "incoming", "export"}
    stray = {entry.name for entry in dest.iterdir()} - ours
    if stray:
        raise SystemExit(
            f"refusing to remove {dest}: it holds {', '.join(sorted(stray))}, "
            f"which this example did not write"
        )
    shutil.rmtree(dest)


def _run() -> None:
    if len(sys.argv) > 2:
        raise SystemExit(f"usage: {Path(sys.argv[0]).name} [DESTINATION]")
    if len(sys.argv) == 2:
        # A destination someone named is never removed automatically; if it
        # already holds a workspace, WorkspaceService says so and stops.
        dest = Path(sys.argv[1]).resolve()
    else:
        dest = DEFAULT_DEST
        _clear_previous_run(dest)

    print(f"VisionSet MCP end-to-end · {dest}")
    summary = main(dest)
    print(
        f"\nDone. {summary.promoted} assets and {summary.annotation_count} labels released as "
        f"{summary.release_tag}, verified {summary.verified}, over "
        f"{summary.tool_count} tools on stdio.\n"
        f"Workspace left at {dest / 'ws'} — reach it again with "
        f"`visionset mcp --workspace {dest / 'ws'}`."
    )


if __name__ == "__main__":
    _run()
