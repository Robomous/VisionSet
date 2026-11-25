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
from typing import Annotated

from pydantic import Field, StrictBool

from visionset import wire
from visionset.formats import registry
from visionset.kernel.domain import ExportTarget, SplitRecipe
from visionset.kernel.ports import Exporter, resolve_target
from visionset.kernel.services import (
    PreprocessingRecipeService,
    ProjectService,
    ReleaseService,
)
from visionset.mcp._errors import Refusal, refused
from visionset.mcp._resolve import ProjectRef
from visionset.mcp._workspace import opened_workspace
from visionset.preprocessing import registry as preprocessing_registry
from visionset.wire import shapes

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
) -> shapes.Release:
    """Freeze the project's dataset as an immutable, tagged release.

    Snapshots whatever is in the dataset right now — every promoted asset and a
    *copy* of its annotations, so later edits do not reach back into a published
    release. The manifest is hashed, and that hash is what `verify_release`
    checks against later.

    `split` is stored, not applied: nothing is moved or copied per fold at
    publication. The assignment is computed deterministically from asset content
    hashes, so the same recipe over the same content always gives the same folds
    and `export_release` writes them out. With `group_by: "group_label"`, every
    asset sharing an import's group label (a nuScenes scene) lands in one fold;
    the fractions then count groups, so fold sizes are approximate, and an asset
    with no label is still cut on its own.

    Refuses if the dataset is empty, if the tag is blank, or if the tag is
    already used in this dataset — tags are compared case-sensitively, so `v1.0`
    and `V1.0` are two different releases.
    """
    with opened_workspace() as workspace:
        resolved = ProjectService(workspace).resolve(project)
        dataset = ProjectService(workspace).get_dataset(resolved.id)
        published = ReleaseService(workspace).publish(dataset.id, tag, split=split)
    return wire.release(published)


def list_releases(project: ProjectRef) -> shapes.Page[shapes.Release]:
    """List a project's releases, newest last, with everything each one publishes.

    Each row carries its `manifest_hash`, the schema version it froze, its asset
    and annotation counts and its split recipe — so this answers "what has been
    published and what is in it" without a second call per release.
    """
    with opened_workspace() as workspace:
        resolved = ProjectService(workspace).resolve(project)
        dataset = ProjectService(workspace).get_dataset(resolved.id)
        found = ReleaseService(workspace).list(dataset.id)
    return wire.page([wire.release(r) for r in found])


def verify_release(project: ProjectRef, tag: TagRef) -> shapes.ReleaseVerification:
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
        release = ReleaseService(workspace).resolve(project, tag)
        report = ReleaseService(workspace).verify(release.id)
    return wire.release_verification(report)


TargetRef = Annotated[
    str | None,
    Field(
        description=(
            "The model the release will train, resolved to the format that writes for it. "
            "See `list_export_targets`. Give this or `format`, never both."
        )
    ),
]
"""Module-level for the ``inspect.signature`` reason."""

FormatRef = Annotated[
    str | None,
    Field(
        description=(
            "An installed exporter's name. See `list_formats`. Give this or `target`, never both."
        )
    ),
]
"""Module-level for the ``inspect.signature`` reason."""


def _addressed(target: str | None, format: str | None) -> tuple[Exporter, ExportTarget | None]:
    """The plugin one of the two names, and the target when it was a target.

    Through `pick` and `resolve_target` rather than by indexing the registry: a
    `KeyError` is outside the VisionSetError tree, so a mistyped name has to
    arrive as a refusal that names the installed ones.

    Raises:
        ExportFormatNotFound: `format` names nothing installed.
        ExportTargetNotFound: `target` names nothing any installed format declares.
        ExportTargetConflict: two installed formats declare `target`.
    """
    installed = registry.exporters()
    if target is not None:
        return resolve_target(installed, target)
    assert format is not None
    return registry.pick(installed, format)[0], None


RecipeRef = Annotated[
    str | None,
    Field(
        description=(
            "A pre-processing recipe of the project, by name. See "
            "`list_preprocessing_recipes`. Omit to apply no transform."
        )
    ),
]
"""Module-level for the ``inspect.signature`` reason."""


def check_export(
    project: ProjectRef,
    tag: TagRef,
    target: TargetRef = None,
    format: FormatRef = None,
    recipe: RecipeRef = None,
) -> shapes.ExportCompatibility | Refusal:
    """Say what a target or a format would drop from a release, without writing anything.

    Call this before `export_release` when the answer matters. It reads the release's
    frozen manifest, so the numbers are exact. Exactly one of `target` and `format`;
    a target narrows its format to the geometries its trainer has a task for.

    Each class gets a `status`: `supported`, `dropped` (absent from the output,
    counted by `excluded_annotations`) or `degraded` (written reduced, e.g. a polygon
    as its bounding box, counted by `degraded_annotations`). `compatible` true means
    nothing is lost and `export_release` needs no `allow_lossy`. `recipe` also checks
    what the export would refuse for that pre-processing recipe.

    Details: visionset://export
    """
    if (target is None) == (format is None):
        return refused("give exactly one of target and format")
    with opened_workspace() as workspace:
        release = ReleaseService(workspace).resolve(project, tag)
        plugin, addressed = _addressed(target, format)
        spec = (
            None
            if recipe is None
            else PreprocessingRecipeService(workspace).for_release(release.id, recipe).spec
        )
        report = ReleaseService(workspace).check_export(
            release.id, plugin, target=addressed, recipe=spec
        )
    return wire.export_compatibility(report)


def export_release(
    project: ProjectRef,
    tag: TagRef,
    dest: Annotated[
        str,
        Field(description="An absolute directory path on this machine to write into."),
    ],
    target: TargetRef = None,
    format: FormatRef = None,
    allow_lossy: Annotated[
        StrictBool,
        Field(
            description=(
                "Must be true to export in a format that cannot carry everything "
                "this release holds."
            )
        ),
    ] = False,
    allow_non_empty: Annotated[
        StrictBool,
        Field(
            description=(
                "Must be true to write into a directory that already holds files; "
                "they are kept and counted with this export's."
            )
        ),
    ] = False,
    recipe: RecipeRef = None,
) -> shapes.ExportResult | Refusal:
    """Write a release to a local directory, for a target or in one of the installed formats.

    Blocks until the export finishes and returns what landed; the bytes stay on disk.
    Exactly one of `target` (the model the release will train; `list_export_targets`)
    and `format`. `dest` must be an absolute path outside the workspace, missing or an
    empty directory, else `EXPORT_DESTINATION_REFUSED`; a non-empty one is refused
    with `EXPORT_DESTINATION_NOT_EMPTY` unless `allow_non_empty=true`.

    Every image is checked against its content hash first; a missing or altered one
    refuses with `EXPORT_SOURCE_UNREADABLE` (`verify_release` says which). A format
    that cannot carry everything the release holds refuses until `allow_lossy=true`;
    call `check_export` for the numbers. `recipe` applies a pre-processing recipe
    (`list_preprocessing_recipes`) and writes augmented variants for the train fold;
    an export that writes scans (`kitti`) refuses any recipe with
    `EXPORT_SOURCE_UNREADABLE`. A report is written to `dest` as `visionset-export-report.json`.

    Details: visionset://export
    """
    if (target is None) == (format is None):
        return refused("give exactly one of target and format")

    with opened_workspace() as workspace:
        release = ReleaseService(workspace).resolve(project, tag)
        plugin, addressed = _addressed(target, format)
        spec = (
            None
            if recipe is None
            else PreprocessingRecipeService(workspace).for_release(release.id, recipe).spec
        )
        result = ReleaseService(workspace).export(
            release.id,
            plugin,
            Path(dest),
            allow_lossy=allow_lossy,
            allow_non_empty=allow_non_empty,
            target=addressed,
            recipe=spec,
            recipe_name=recipe,
            drivers=None if spec is None else preprocessing_registry.drivers(),
        )
    return wire.export_result(result)
