# usage: from visionset.mcp import releases
"""Release tools: freeze a dataset, check it, and write it out in a format.

A release is the only truly immutable artifact VisionSet makes. Its manifest is a
pure function of content — no timestamp, no tag, no id inside the document — so
publishing an unchanged dataset twice produces byte-identical manifests that
share one blob.

**Releases are addressed by project and tag**, never by a release id an agent
would have to carry. A tag is unique per dataset and it is what a person picked;
it is also the one comparison in the system that is **case-sensitive**, opposite
to a project name, and that rule is a kernel read rather than something spelled
here.

``get_release`` folds into ``list_releases``: the listing already carries every
published field, so a second tool to fetch one row is a round trip for nothing.

Two candidates are **dropped**. ``get_release_manifest`` returns the whole frozen
document — every asset, every annotation — which for a real dataset is a token
bill an agent cannot afford and does not need, since ``verify_release`` answers
"is it intact" and ``export_release`` writes the contents where a trainer can
read them. ``get_release_assignment`` returns the train/val/test folds as three
lists of ids, which is the same information ``export_release`` puts on disk in
the form anything downstream actually consumes.

**Export is synchronous**, a stated limit rather than an oversight: launch-and-
poll needs a row to poll, a row needs a table, and a table needs a migration.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any

from pydantic import Field

from visionset import wire
from visionset.formats.registry import exporter
from visionset.kernel.domain import SplitRecipe
from visionset.kernel.services import ProjectService, ReleaseService
from visionset.mcp._errors import refused
from visionset.mcp._resolve import ProjectRef, resolve_project, resolve_release
from visionset.mcp._workspace import opened_workspace

TagRef = Annotated[str, Field(description="The release tag. Compared case-sensitively.")]
"""Module-level for the ``inspect.signature`` reason."""


def publish_release(
    project: ProjectRef,
    tag: TagRef,
    split: Annotated[
        SplitRecipe | None,
        Field(
            description=(
                "How to cut the release for training. Fractions must sum to 1.0. "
                "Omit to publish without one."
            )
        ),
    ] = None,
) -> dict[str, Any]:
    """Freeze the project's dataset as an immutable, tagged release.

    Snapshots whatever is in the dataset right now — every promoted asset and a
    *copy* of its annotations, so later edits do not reach back into a published
    release. The manifest is hashed, and that hash is what `verify_release`
    checks against later.

    `split` is stored, not applied: nothing is moved or copied per fold at
    publication. The assignment is computed deterministically from asset content
    hashes, so the same recipe over the same content always gives the same folds
    and `export_release` writes them out.

    Refuses if the dataset is empty, if the tag is blank, or if the tag is
    already used in this dataset — tags are compared case-sensitively, so `v1.0`
    and `V1.0` are two different releases.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        dataset = ProjectService(workspace).get_dataset(resolved.id)
        published = ReleaseService(workspace).publish(dataset.id, tag, split=split)
    return wire.release(published)


def list_releases(project: ProjectRef) -> dict[str, Any]:
    """List a project's releases, newest last, with everything each one publishes.

    Each row carries its `manifest_hash`, the schema version it froze, its asset
    and annotation counts and its split recipe — so this answers "what has been
    published and what is in it" without a second call per release.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        dataset = ProjectService(workspace).get_dataset(resolved.id)
        found = ReleaseService(workspace).list(dataset.id)
    return wire.page([wire.release(r) for r in found])


def verify_release(project: ProjectRef, tag: TagRef) -> dict[str, Any]:
    """Re-read and re-hash everything a release names, and report what is wrong.

    The integrity check: it re-hashes the manifest and then every asset blob the
    manifest lists, so it detects bit rot and missing files that a listing cannot.
    Expect it to take a while on a large release.

    `ok` true means the manifest is intact, every blob is present and hashes
    correctly, and the cached counts on the release row agree with the document.
    `missing` is blobs that are gone, `corrupt` is blobs present whose bytes no
    longer hash to their name, and `cache_mismatches` names a row field that
    disagrees with the manifest — which is a defect in the build that wrote it,
    not damage on disk.

    If the manifest itself fails its own hash, nothing else can be trusted, so
    `manifest_intact` is false and `checked` is 0.
    """
    with opened_workspace() as workspace:
        release = resolve_release(workspace, project, tag)
        report = ReleaseService(workspace).verify(release.id)
    return wire.release_verification(report)


def check_export(
    project: ProjectRef,
    tag: TagRef,
    format: Annotated[str, Field(description="An installed exporter's name. See `list_formats`.")],
) -> dict[str, Any]:
    """Say what a format would drop from a release, without writing anything.

    Call this before `export_release` when the answer matters. It reads the
    release's frozen manifest and judges every class in it against what the
    format declares it can write, so the numbers are exact rather than estimated.

    Every class gets a `status`, and there are three of them. `supported` is
    written as it stands. `dropped` is **not in the output at all** —
    `excluded_annotations` counts those labels and `excluded_assets` how many
    assets arrive with at least one of them missing. `degraded` is **in the
    output, reduced**: a polygon written as its axis-aligned bounding box, which
    is what `yolo` and `voc` do, counted by `degraded_annotations` and
    `degraded_assets`. Read `reason` for the sentence that says which.

    `compatible` true means this format loses nothing from this release, and
    `export_release` will run without `allow_lossy`. False means it will refuse
    until you pass it — and the same report comes back with that refusal and is
    written into the export directory as `visionset-export-report.json`, so
    calling this first is a convenience, never a requirement.

    A class with zero annotations never makes a release incompatible, whatever
    its status: a schema that declares `mask` and holds no masks loses nothing.
    Those rows are still listed, with their zeros, because "this format cannot
    write masks and you have none" is worth being able to read.

    `compatible` is not the same question as a format's `lossy` flag in
    `list_formats`. That flag covers everything a geometry list cannot see —
    attributes, confidence, provenance — and is true of the format forever;
    this is about the labels this release actually holds.
    """
    with opened_workspace() as workspace:
        release = resolve_release(workspace, project, tag)
        report = ReleaseService(workspace).check_export(release.id, exporter(format))
    return wire.export_compatibility(report)


def export_release(
    project: ProjectRef,
    tag: TagRef,
    format: Annotated[str, Field(description="An installed exporter's name. See `list_formats`.")],
    dest: Annotated[
        str,
        Field(description="An absolute directory path on this machine to write into."),
    ],
    allow_lossy: Annotated[
        bool,
        Field(
            description=(
                "Must be true to export in a format that cannot carry everything "
                "this release holds."
            )
        ),
    ] = False,
) -> dict[str, Any]:
    """Write a release to a local directory in one of the installed formats.

    Blocks until the export finishes and returns a description of what landed —
    the bytes stay on disk, which is the point: whatever trains on this reads the
    directory, not this call's answer.

    `dest` is created if it does not exist and is **not emptied first**, so
    `file_count` and `total_bytes` describe the directory afterwards, which
    equals what this run wrote only when the directory was fresh. Point separate
    exports at separate directories.

    A format that cannot express everything the release holds — one that carries
    boxes but not polygons, say — refuses until you pass `allow_lossy=true`. That
    is a different gate from `confirm`: nothing is destroyed, the release stays
    exactly as it was, and what you are consenting to is an incomplete copy. Two
    things trigger it: a format that declares itself lossy, and a format whose
    declared capabilities cannot carry a class this release actually uses. Call
    `check_export` for the exact numbers before deciding, or read the same report
    off the refusal.

    Every successful export also writes `visionset-export-report.json` into
    `dest`, saying what was and was not carried. It is the kernel's file, not the
    format's, and it is excluded from `file_count`.
    """
    destination = Path(dest)
    # An exporter writes into `dest` and creates it if missing, so a path that
    # exists as a *file* is the one shape that cannot work and would surface as a
    # bare OSError from inside a plugin rather than as a refusal.
    if destination.exists() and not destination.is_dir():
        return refused(f"dest must be a directory, and {dest} is a file")

    with opened_workspace() as workspace:
        release = resolve_release(workspace, project, tag)
        # `pick`, through `exporter()`, rather than indexing the registry: a
        # `KeyError` is outside the VisionSetError tree, so a mistyped format name
        # has to arrive as a refusal that names the installed ones.
        plugin = exporter(format)
        result = ReleaseService(workspace).export(
            release.id, plugin, destination, allow_lossy=allow_lossy
        )
    return wire.export_result(result)
