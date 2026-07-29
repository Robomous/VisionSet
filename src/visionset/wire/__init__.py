# usage: from visionset import wire
"""What a surface publishes as JSON: one hand-written projection per resource.

**A field reaches a caller because somebody wrote it here.** That is
``tokens.py``'s rule — its listing names three columns one at a time rather than
dumping the model — promoted to the shape a program parses. The alternative,
``model_dump()`` on a domain model, would publish whatever the domain happens to
hold today and silently republish whatever it holds tomorrow. Three fields make
the point, and each is already absent from the wire model the server publishes:

- ``Asset.uri`` and ``Source.path`` are absolute paths on this machine. A caller
  reading them learns the layout of somebody's disk and nothing it can use.
- ``Batch.asset_ids`` is a batch's whole roll call, which for fifty thousand
  frames must not travel on every read of its name.

**This module is its own package rather than ``cli/_json.py`` because it has two
callers.** It arrived with the CLI (#34) and #35 gave MCP the same need; a second
hand-written spelling of the same twenty shapes is exactly what "promoted, not
copied" exists to prevent, and the two would have been free to drift with only
prose holding them together. The import direction is one-way and machine-enforced:
the surfaces import ``visionset.wire``, and the kernel-purity contract forbids
``visionset.kernel`` importing it, alongside the three delivery packages. The
server keeps its own pydantic models because ``openapi.json`` is generated from
them, which a dict cannot do.

**These shapes deliberately agree, key for key, with the REST API's wire models.**
Not by importing them — import-linter's independence contract keeps the surfaces
siblings — but by ``tests/cli/test_json_contract.py``, which imports both and
asserts each pair has the same keys *and* that the projection round-trips through
the wire model. A test may do what neither package may. What that buys is one
shape for one concept, so a caller moves between ``curl | jq``,
``visionset --json | jq`` and an MCP tool result without relearning the field
names — and there are still **two** spellings to keep in step, not three.

Three things here have no wire partner, because no route publishes them: an
export report (the API returns the archive itself, not a description of it), a
thumbnail backfill, and a schema diff. They are gated only for encoding, at the
bottom of the parity test.

Leaf encoding is explicit everywhere: UUIDs as strings, enums as ``.value``,
paths as strings, and timestamps in **pydantic's** format — microseconds, ``Z``
— which is why :func:`_moment` is not ``_output.moment``. That one is for a
column and stops at seconds; sharing it would break the parity gate in the one
way key-set comparison cannot see.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import PurePath
from typing import Any
from uuid import UUID

from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    AnnotationSchema,
    Asset,
    AssetProgress,
    Attribute,
    Batch,
    BboxGeometry,
    ClassCount,
    ClassificationGeometry,
    Dataset,
    DatasetStats,
    ExportResult,
    Geometry,
    IngestFailure,
    IngestJob,
    LabelClass,
    PolygonGeometry,
    Project,
    Release,
    ReleaseVerification,
    SchemaChange,
    SchemaDiff,
    Source,
    SplitRecipe,
    ThumbnailBackfill,
    VideoProvenance,
)
from visionset.kernel.ports import Exporter


def _moment(when: datetime) -> str:
    """A timestamp the way pydantic writes one, because the parity gate compares."""
    return when.astimezone(UTC).isoformat().replace("+00:00", "Z")


def page(items: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """The collection envelope, identical to the REST API's.

    ``{"items": [...], "total": n}`` and never a bare array — an array cannot
    grow a field without breaking every client, which is the argument
    ``docs/api.md`` already makes. ``total`` is how many matched, which for a CLI
    that does not page is always ``len(items)``; it is here so that the day a
    listing grows ``--limit``, the shape does not move.
    """
    return {"items": list(items), "total": len(items)}


# --- projects and schemas ----------------------------------------------------


def project(value: Project) -> dict[str, Any]:
    """A project. ``workspace_id`` is absent: a command speaks for one workspace."""
    return {"id": str(value.id), "name": value.name, "description": value.description}


def dataset(value: Dataset) -> dict[str, Any]:
    """A project's one dataset."""
    return {
        "id": str(value.id),
        "project_id": str(value.project_id),
        "name": value.name,
        "description": value.description,
    }


def attribute(value: Attribute) -> dict[str, Any]:
    """One attribute of a label class. Also the *input* shape ``schema apply`` reads."""
    return {
        "name": value.name,
        "kind": value.kind,
        "required": value.required,
        "options": None if value.options is None else list(value.options),
        "default": value.default,
    }


def label_class(value: LabelClass) -> dict[str, Any]:
    """One class of a schema version. Also the *input* shape ``schema apply`` reads."""
    return {
        "name": value.name,
        "geometry": value.geometry.value,
        "color": value.color,
        "attributes": [attribute(a) for a in value.attributes],
    }


def schema_version(value: AnnotationSchema) -> dict[str, Any]:
    """One version of a project's schema. Its own UUID is absent: nothing addresses it."""
    return {
        "project_id": str(value.project_id),
        "version": value.version,
        "classes": [label_class(c) for c in value.classes],
    }


def schema_change(value: SchemaChange) -> dict[str, Any]:
    """One difference between two schema versions, and which kind it is."""
    return {
        "kind": value.kind.value,
        "label_class": value.label_class,
        "attribute": value.attribute,
        "detail": value.detail,
    }


def schema_diff(value: SchemaDiff) -> dict[str, Any]:
    """A proposed or actual schema change, classified. **Surface-defined**: no route reaches this.

    ``is_destructive`` and ``destructive_classes`` are domain ``@property``
    values materialized here, the way ``ReleaseVerification.ok`` is: a caller
    deciding whether it needs ``allow_destructive`` must not have to re-derive
    the answer from the ``changes`` list and get it subtly wrong.
    """
    return {
        "is_destructive": value.is_destructive,
        "destructive_classes": sorted(value.destructive_classes),
        "changes": [schema_change(c) for c in value.changes],
    }


# --- sources, ingest and assets ----------------------------------------------


def video_provenance(value: VideoProvenance) -> dict[str, Any]:
    """What a clip turned out to be, flattened the way the wire flattens it."""
    return {
        "width": value.metadata.width,
        "height": value.metadata.height,
        "fps": value.metadata.fps,
        "duration_seconds": value.metadata.duration_seconds,
        "codec": value.metadata.codec,
        "extraction_fps": value.extraction_fps,
    }


def source(value: Source) -> dict[str, Any]:
    """A registered origin. ``path`` is absent; ``name`` is its last component."""
    return {
        "id": str(value.id),
        "project_id": str(value.project_id),
        "kind": value.kind.value,
        "name": PurePath(value.path).name,
        "registered_at": _moment(value.registered_at),
        "video": None if value.video is None else video_provenance(value.video),
    }


def ingest_failure(value: IngestFailure) -> dict[str, Any]:
    """One file a run could not use, and why."""
    return {"name": value.name, "kind": value.kind.value, "reason": value.reason}


def ingest_job(value: IngestJob) -> dict[str, Any]:
    """One run of one source, counters and per-item report included."""
    return {
        "id": str(value.id),
        "source_id": str(value.source_id),
        "state": value.state.value,
        "error": value.error,
        "batch_id": None if value.batch_id is None else str(value.batch_id),
        "batch_name": value.batch_name,
        "processed": value.processed,
        "total": value.total,
        "failures": [ingest_failure(f) for f in value.failures],
    }


def asset(value: Asset) -> dict[str, Any]:
    """One image. ``uri`` is absent: it is a path on this machine."""
    return {
        "id": str(value.id),
        "project_id": str(value.project_id),
        "modality": value.modality,
        "content_hash": value.content_hash,
        "width": value.width,
        "height": value.height,
        "format": None if value.format is None else value.format.value,
        "source_id": None if value.source_id is None else str(value.source_id),
        "frame_index": value.frame_index,
        "frame_timestamp": value.frame_timestamp,
        "thumbnail_hash": value.thumbnail_hash,
    }


def batch_asset(
    value: Asset, *, job_id: UUID | None, progress: AssetProgress | None
) -> dict[str, Any]:
    """One asset seen from inside a batch: the asset, plus where the work stands.

    Widens :func:`asset` rather than replacing it, which is what the wire model
    does by inheriting ``AssetOut`` — they are the same asset from a different
    vantage point, and a field added to one belongs to both. Both extra fields
    are null exactly while the batch is a draft, because a draft has no jobs.
    """
    return {
        **asset(value),
        "job_id": None if job_id is None else str(job_id),
        "progress": None if progress is None else progress.value,
    }


def thumbnail_backfill(value: ThumbnailBackfill) -> dict[str, Any]:
    """A preview pass over a project. **Surface-defined**: no route reaches this."""
    return {
        "project_id": str(value.project_id),
        "examined": value.examined,
        "filled": [str(i) for i in value.filled],
        "missing": [str(i) for i in value.missing],
        "unreadable": [ingest_failure(f) for f in value.unreadable],
    }


# --- batches and jobs --------------------------------------------------------


def progress_counts(counts: Mapping[AssetProgress, int]) -> dict[str, Any]:
    """Five named fields and a total, not an open map — the wire model's own reason."""
    return {
        "unannotated": counts[AssetProgress.UNANNOTATED],
        "annotated": counts[AssetProgress.ANNOTATED],
        "skipped": counts[AssetProgress.SKIPPED],
        "review_pending": counts[AssetProgress.REVIEW_PENDING],
        "accepted": counts[AssetProgress.ACCEPTED],
        "total": sum(counts.values()),
    }


def batch(value: Batch, counts: Mapping[AssetProgress, int]) -> dict[str, Any]:
    """A batch and where its assets have got to. ``asset_ids`` is absent."""
    return {
        "id": str(value.id),
        "project_id": str(value.project_id),
        "name": value.name,
        "state": value.state.value,
        "schema_version": value.schema_version,
        "asset_count": len(value.asset_ids),
        "progress": progress_counts(counts),
    }


def job(value: AnnotationJob, *, batch_id: UUID) -> dict[str, Any]:
    """One segment of a batch. ``task_group_id`` and the per-asset map are absent."""
    return {
        "id": str(value.id),
        "batch_id": str(batch_id),
        "state": value.state.value,
        "asset_count": len(value.progress),
    }


def asset_progress(asset_id: UUID, progress: AssetProgress) -> dict[str, Any]:
    """Where one asset of a job has got to."""
    return {"asset_id": str(asset_id), "progress": progress.value}


# --- annotations -------------------------------------------------------------


def geometry(value: Geometry) -> dict[str, Any]:
    """One shape, tagged by ``type``. Coordinates are the asset's own pixels.

    Never normalized, at any surface — the domain's rule, and the one thing a
    caller reading a scaled-down preview has to know. ``match`` on the concrete
    class rather than on ``value.type``, so a variant added to the union without
    a projection is a mypy error here instead of a ``KeyError`` at a caller.
    """
    match value:
        case BboxGeometry():
            return {
                "type": value.type.value,
                "x": value.x,
                "y": value.y,
                "width": value.width,
                "height": value.height,
            }
        case PolygonGeometry():
            return {"type": value.type.value, "points": [list(p) for p in value.points]}
        case ClassificationGeometry():
            return {"type": value.type.value}


def annotation(value: Annotation) -> dict[str, Any]:
    """One label on one asset. ``schema_version`` is published on the way out only.

    A caller never sets it — the service stamps the batch's pinned version over
    whatever it was handed — but reading it back is how a caller knows which
    contract the label was judged against.
    """
    return {
        "id": str(value.id),
        "asset_id": str(value.asset_id),
        "label_class": value.label_class,
        "schema_version": value.schema_version,
        "geometry": geometry(value.geometry),
        "attributes": dict(value.attributes),
        "provenance": value.provenance,
        "model_ref": value.model_ref,
        "confidence": value.confidence,
    }


# --- datasets ----------------------------------------------------------------


def class_count(value: ClassCount) -> dict[str, Any]:
    """How much of one class a dataset holds — both totals, deliberately.

    A thousand labels over a thousand images and the same thousand over ten are
    the same ``annotations`` and a very different dataset.
    """
    return {
        "label_class": value.label_class,
        "annotations": value.annotations,
        "assets": value.assets,
    }


def dataset_stats(value: DatasetStats) -> dict[str, Any]:
    """What is in the trunk right now. Derived per call; a release freezes its own.

    ``classes`` rather than the domain's ``per_class``, matching the wire model:
    a class the schema declares but nobody used is **absent**, so this is what
    was counted and not what could be.
    """
    return {
        "dataset_id": str(value.dataset_id),
        "asset_count": value.asset_count,
        "annotated_asset_count": value.annotated_asset_count,
        "annotation_count": value.annotation_count,
        "classes": [class_count(c) for c in value.per_class],
    }


# --- releases, exports and formats -------------------------------------------


def split_recipe(value: SplitRecipe) -> dict[str, Any]:
    """How a release is cut for training."""
    return {"train": value.train, "val": value.val, "test": value.test, "seed": value.seed}


def release(value: Release) -> dict[str, Any]:
    """A published snapshot of a dataset."""
    return {
        "id": str(value.id),
        "dataset_id": str(value.dataset_id),
        "tag": value.tag,
        "manifest_hash": value.manifest_hash,
        "schema_version": value.schema_version,
        "asset_count": value.asset_count,
        "annotation_count": value.annotation_count,
        "split": None if value.split is None else split_recipe(value.split),
        "created_at": _moment(value.created_at),
        "visionset_version": value.visionset_version,
    }


def release_verification(value: ReleaseVerification) -> dict[str, Any]:
    """The result of re-hashing everything a release names. ``ok`` is derived."""
    return {
        "release_id": str(value.release_id),
        "manifest_hash": value.manifest_hash,
        "manifest_intact": value.manifest_intact,
        "ok": value.ok,
        "checked": value.checked,
        "missing": list(value.missing),
        "corrupt": list(value.corrupt),
        "cache_mismatches": list(value.cache_mismatches),
    }


def export_format(value: Exporter) -> dict[str, Any]:
    """One installed exporter."""
    return {"name": value.format_name, "lossy": value.lossy}


def export_result(value: ExportResult) -> dict[str, Any]:
    """What an export left on disk. **Surface-defined**: the API returns the archive.

    ``directory`` is here where ``Asset.uri`` is not, and the difference is who
    chose it: this is the path the caller typed on ``--out``, so echoing it tells
    them nothing they did not already say.
    """
    return {
        "release_id": str(value.release_id),
        "format": value.format_name,
        "directory": str(value.directory),
        "file_count": value.file_count,
        "total_bytes": value.total_bytes,
    }
