# usage: from visionset.kernel.domain import EXPORT_JOB_TYPE, export_job_payload, recipe_usage
"""The background export job's payload, and what a recipe's usage is read from.

The handler lives in ``visionset.jobs.export``, which the kernel may not import,
and the payload has a second reader: a recipe answers which exports ran it, and
the only record of that is the recipe snapshot a succeeded export job carries.
So the type and the payload's keys are named here, once, and the handler names
them back — the ``PRE_LABEL_JOB_TYPE`` arrangement.

**A recipe is matched to its exports by name.** The snapshot is a value, not a
reference: it keeps the name the recipe had when the export was asked for. A
renamed recipe therefore loses the exports it ran under its old name, and a new
recipe created under a deleted one's name inherits that one's. Only queued
exports leave a job behind; an export written straight to a directory by the
CLI or MCP leaves no row, and no usage.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Final
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from visionset.kernel.domain.job import BackgroundJob, BackgroundJobState
from visionset.kernel.domain.preprocessing import RecipeSpec
from visionset.kernel.domain.release import Release

EXPORT_JOB_TYPE: Final = "export.release"
"""The background job that writes a release through a format plugin."""

EXPORT_RELEASE_KEY: Final = "release_id"
EXPORT_FORMAT_KEY: Final = "format"
EXPORT_TARGET_KEY: Final = "target"
EXPORT_ALLOW_LOSSY_KEY: Final = "allow_lossy"
EXPORT_RECIPE_KEY: Final = "recipe"
EXPORT_RECIPE_NAME_KEY: Final = "name"
EXPORT_RECIPE_SPEC_KEY: Final = "spec"


def export_job_payload(
    release_id: UUID,
    format_name: str,
    *,
    target: str | None,
    allow_lossy: bool,
    recipe: tuple[str | None, RecipeSpec] | None = None,
) -> dict[str, JsonValue]:
    """The payload an export job carries. Built here, read here.

    ``format`` is the resolved format's own name even when the caller addressed
    a target, so the worker resolves the same plugin the request was refused or
    accepted against. ``recipe`` is a **snapshot** — the stored recipe's name
    beside the spec as it stood at the request — never a name to look up again:
    an edit or a delete between the request and the worker's run must not change
    what the worker applies.
    """
    return {
        EXPORT_RELEASE_KEY: str(release_id),
        EXPORT_FORMAT_KEY: format_name,
        EXPORT_TARGET_KEY: target,
        EXPORT_ALLOW_LOSSY_KEY: allow_lossy,
        EXPORT_RECIPE_KEY: None
        if recipe is None
        else {
            EXPORT_RECIPE_NAME_KEY: recipe[0],
            EXPORT_RECIPE_SPEC_KEY: recipe[1].model_dump(mode="json"),
        },
    }


class RecipeUsage(BaseModel):
    """How many succeeded exports ran a recipe, and the newest of them.

    ``target`` is null for an export that named a format rather than a target;
    ``format`` is always the format that wrote it.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    export_count: int = Field(ge=1)
    release_id: UUID
    release_tag: str
    target: str | None
    format: str


def recipe_usage(
    jobs: Iterable[BackgroundJob], releases: Mapping[UUID, Release]
) -> dict[str, RecipeUsage]:
    """Every recipe name a succeeded export over ``releases`` ran, keyed by name.

    ``jobs`` is read newest first — the queue's own order — so the first match
    for a name is its newest export. A job that did not succeed, is not an
    export, ran no named recipe, or names a release outside ``releases`` is
    skipped: the last is how a project's usage stays the project's own.
    """
    counts: dict[str, int] = {}
    newest: dict[str, tuple[Release, str | None, str]] = {}
    for job in jobs:
        if job.type != EXPORT_JOB_TYPE or job.state is not BackgroundJobState.SUCCEEDED:
            continue
        snapshot = job.payload.get(EXPORT_RECIPE_KEY)
        if not isinstance(snapshot, dict):
            continue
        name = snapshot.get(EXPORT_RECIPE_NAME_KEY)
        release_id = job.payload.get(EXPORT_RELEASE_KEY)
        if not isinstance(name, str) or not isinstance(release_id, str):
            continue
        release = releases.get(UUID(release_id))
        if release is None:
            continue
        counts[name] = counts.get(name, 0) + 1
        if name not in newest:
            target = job.payload.get(EXPORT_TARGET_KEY)
            newest[name] = (
                release,
                target if isinstance(target, str) else None,
                str(job.payload.get(EXPORT_FORMAT_KEY)),
            )
    return {
        name: RecipeUsage(
            export_count=counts[name],
            release_id=release.id,
            release_tag=release.tag,
            target=target,
            format=format_name,
        )
        for name, (release, target, format_name) in newest.items()
    }
