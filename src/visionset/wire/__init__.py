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
callers**, the CLI and MCP. A second hand-written spelling of the same twenty
shapes is exactly what "promoted, not copied" exists to prevent, and the two would
be free to drift with only prose holding them together. The import direction is
one-way and machine-enforced:
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
from collections.abc import Set as AbstractSet
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

# The one import here that is not the kernel's, and it is the same direction as
# everything else in this package: `visionset.inference` is a sibling below the
# surfaces, it imports nothing from here, and what it owns is the fact this
# module has no way to know — which model families this build can serve. The
# alternative is spelling that mapping a second time, which is what every other
# rule in this file exists to prevent. ``PreLabelPlan`` arrives the same way:
# the narrowing of a pinned schema to the classes a box can be written as is
# derived there, and every surface publishes it.
from visionset.inference import PreLabelPlan, capabilities_of
from visionset.kernel.domain import (
    Annotation,
    AnnotationJob,
    AnnotationJobState,
    AnnotationSchema,
    Asset,
    AssetProgress,
    Attribute,
    Batch,
    BatchState,
    BboxGeometry,
    ClassCompatibility,
    ClassCount,
    ClassificationGeometry,
    Dataset,
    DatasetStats,
    DownloadSize,
    DraftAttribute,
    DraftLabelClass,
    ExportCompatibility,
    ExportResult,
    Geometry,
    InferenceConnection,
    IngestFailure,
    IngestJob,
    IntegrityCheck,
    LabelClass,
    PolygonGeometry,
    PolylineGeometry,
    PreLabelRun,
    Project,
    Release,
    ReleaseVerification,
    SchemaChange,
    SchemaChangePreview,
    SchemaDiff,
    SchemaDraft,
    SchemaPublication,
    Source,
    SplitRecipe,
    ThumbnailBackfill,
    VideoProvenance,
    WeightDownload,
    asset_actions,
    batch_actions,
    connection_actions,
    job_actions,
)
from visionset.kernel.ports import Exporter


def _moment(when: datetime) -> str:
    """A timestamp the way pydantic writes one, because the parity gate compares."""
    return when.astimezone(UTC).isoformat().replace("+00:00", "Z")


def page(items: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """The collection envelope, identical to the REST API's.

    ``{"items": [...], "total": n}`` and never a bare array — an array cannot
    grow a field without breaking every client, which is the argument
    ``docs/content/api.md`` already makes. ``total`` is how many matched, which for a CLI
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
        # Already sorted and deduplicated by the domain, so the list is one
        # value rather than one of several spellings of it.
        "geometries": [geometry.value for geometry in value.geometries],
        "color": value.color,
        "attributes": [attribute(a) for a in value.attributes],
    }


def schema_version(value: AnnotationSchema) -> dict[str, Any]:
    """One version of a project's schema. Its own UUID is absent: nothing addresses it.

    ``description``, ``created_at`` and ``provenance`` are all null for a version
    published before they existed, and nothing backfills any of them.
    """
    return {
        "project_id": str(value.project_id),
        "version": value.version,
        "classes": [label_class(c) for c in value.classes],
        "description": value.description,
        "created_at": None if value.created_at is None else _moment(value.created_at),
        "provenance": None if value.provenance is None else value.provenance.value,
    }


def draft_attribute(value: DraftAttribute) -> dict[str, Any]:
    """One attribute of a class still being written. Every field may be unset."""
    return {
        "name": value.name,
        "kind": value.kind,
        "required": value.required,
        "options": None if value.options is None else list(value.options),
        "default": value.default,
    }


def draft_label_class(value: DraftLabelClass) -> dict[str, Any]:
    """One class still being written: a name that may be blank, shapes that may be none."""
    return {
        "name": value.name,
        "geometries": [geometry.value for geometry in value.geometries],
        "color": value.color,
        "attributes": [draft_attribute(a) for a in value.attributes],
    }


def schema_draft(value: SchemaDraft) -> dict[str, Any]:
    """The schema version a project is still writing, of one kind.

    ``revision`` is what the next write must name. ``based_on`` is the version the
    draft was seeded from, so one that is behind the active version was written
    against a contract that has since moved.
    """
    return {
        "project_id": str(value.project_id),
        "kind": value.kind.value,
        "classes": [draft_label_class(c) for c in value.classes],
        "note": value.note,
        "based_on": value.based_on,
        "revision": value.revision,
        "updated_at": _moment(value.updated_at),
    }


def schema_publication(value: SchemaPublication) -> dict[str, Any]:
    """What one publish did: the version, and the open batches that moved onto it.

    A shape of its own rather than two more keys on ``schema_version``, because
    the reads answer a different question. ``GET`` a version and the batches that
    once followed it are neither known nor wanted; only the act of publishing has
    an answer here, and a permanently-empty list on every read would be a field
    that lies about what it is for.

    ``advanced_batches`` is empty whenever nothing followed — no open batch, or a
    narrowing change, which never advances. Empty is ordinary, not an error.
    """
    return {
        "published": schema_version(value.published),
        "advanced_batches": [str(batch_id) for batch_id in value.advanced_batches],
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
    """A proposed or actual schema change, classified.

    Not surface-defined: ``SchemaService.compare`` has a route, so
    ``SchemaDiffOut`` is the REST spelling of this and the two are held to each
    other by ``tests/cli/test_json_contract.py``.

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


def schema_change_preview(value: SchemaChangePreview) -> dict[str, Any]:
    """What publishing these classes would do, and what would stop it.

    ``diff`` answers whether the change needs ``allow_destructive``; ``blockers``
    answers whether any flag would help, which is the question a caller could not
    ask before this existed and had to discover by being refused.

    ``is_refused`` is the domain ``@property`` materialized here, on
    ``schema_diff``'s terms and for the same reason: a caller deciding whether to
    offer a way forward must not re-derive the rule from ``blockers`` and get it
    subtly wrong.

    ``blockers`` reuses :func:`class_count` rather than a shape of its own — it is
    the same two numbers about the same classes, and a second spelling is how two
    reports of one thing start to disagree.
    """
    return {
        "diff": schema_diff(value.diff),
        "blockers": [class_count(c) for c in value.blockers],
        "is_refused": value.is_refused,
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
    """A registered origin. ``path`` is absent; ``name`` is the domain's resolution.

    ``Source.name`` is the stated display name when one exists, else the path's
    last component — one spelling, shared with ``SourceOut``.
    """
    return {
        "id": str(value.id),
        "project_id": str(value.project_id),
        "kind": value.kind.value,
        "name": value.name,
        "registered_at": _moment(value.registered_at),
        "video": None if value.video is None else video_provenance(value.video),
    }


def ingest_failure(value: IngestFailure) -> dict[str, Any]:
    """What became of one file the run could not simply read.

    The two counts are null on every kind but ``partial`` — the domain refuses
    any other arrangement — and are published anyway rather than omitted, so the
    shape of an entry does not depend on which kind it is.
    """
    return {
        "name": value.name,
        "kind": value.kind.value,
        "reason": value.reason,
        "frames_produced": value.frames_produced,
        "frames_expected_estimate": value.frames_expected_estimate,
    }


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
        # Null means *unknown* rather than "never" — a row written before the
        # column existed is legitimately unstamped. ``_moment`` and not ``isoformat``,
        # because the parity gate compares this against pydantic's own encoding.
        "ingested_at": None if value.ingested_at is None else _moment(value.ingested_at),
    }


def batch_asset(
    value: Asset,
    *,
    job_id: UUID | None,
    job_state: AnnotationJobState | None,
    progress: AssetProgress | None,
    batch_state: BatchState,
) -> dict[str, Any]:
    """One asset seen from inside a batch: the asset, plus where the work stands.

    Widens :func:`asset` rather than replacing it, which is what the wire model
    does by inheriting ``AssetOut`` — they are the same asset from a different
    vantage point, and a field added to one belongs to both. ``job_id``,
    ``job_state`` and ``progress`` are null together and exactly while the batch
    is a draft, because a draft has no jobs.

    ``batch_state`` and ``job_state`` are arguments and not fields: each belongs
    to the resource that publishes it, but ``allowed_actions`` cannot be answered
    without both. Dropping either has already cost: without the batch dimension a
    client's own copy of these rules produced two blockers, and without the job
    dimension a finished job's frames declare that they can still be annotated.
    """
    return {
        **asset(value),
        "job_id": None if job_id is None else str(job_id),
        "progress": None if progress is None else progress.value,
        "allowed_actions": [
            a.value for a in asset_actions(progress, batch_state=batch_state, job_state=job_state)
        ],
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
    """Six named fields and a total, not an open map — the wire model's own reason."""
    return {
        "unannotated": counts[AssetProgress.UNANNOTATED],
        "pre_labeled": counts[AssetProgress.PRE_LABELED],
        "annotated": counts[AssetProgress.ANNOTATED],
        "skipped": counts[AssetProgress.SKIPPED],
        "review_pending": counts[AssetProgress.REVIEW_PENDING],
        "accepted": counts[AssetProgress.ACCEPTED],
        "total": sum(counts.values()),
    }


def pre_label_run(value: PreLabelRun) -> dict[str, Any]:
    """A batch's most recent pre-labeling run: which job, how far, and what it found.

    Assets, on ``weight_download``'s and ``integrity_check``'s terms: the
    handler's own unit, named where its job type is known. ``stopped_early``,
    ``assets_labeled``, ``regions_discarded`` and ``regions_out_of_bounds`` are
    null until the job settles with a result — a cancelled run still carries
    them, a failed one never does.
    """
    return {
        "job_id": str(value.job_id),
        "state": value.state.value,
        "assets_processed": value.assets_processed,
        "assets_total": value.assets_total,
        "error": value.error,
        "stopped_early": value.stopped_early,
        "assets_labeled": value.assets_labeled,
        "regions_discarded": value.regions_discarded,
        "regions_out_of_bounds": value.regions_out_of_bounds,
    }


def pre_label_plan(value: PreLabelPlan) -> dict[str, Any]:
    """The prompt a pre-labeling run asks under, and every class left out of it.

    One spelling for the tool that answers the plan on its own and for the run
    that reports the plan it ran under; two would be how an agent comes to see
    ``excluded_classes`` under one and something else under the other.
    ``schema_version`` is the pin both halves were derived from — a re-pin
    changes both.
    """
    return {
        "schema_version": value.schema_version,
        "asked_classes": list(value.asked),
        "excluded_classes": [
            {"name": one.name, "reasons": [reason.value for reason in one.reasons]}
            for one in value.excluded
        ],
    }


def batch(
    value: Batch,
    counts: Mapping[AssetProgress, int],
    *,
    promoted: AbstractSet[UUID],
    pre_labeled: PreLabelRun | None = None,
) -> dict[str, Any]:
    """A batch and where its assets have got to. ``asset_ids`` is absent.

    ``promoted`` is the trunk's current membership, passed in rather than read
    here: a listing tests every batch against the same set, so one read covers
    the whole answer and ``value.asset_ids`` is already in hand. Keyword-only and
    with no default, because a default would report zero promoted for a batch
    nobody checked — a number that looks like an answer and is not one.

    ``pre_labeled`` is that batch's most recent pre-labeling run, on the same
    terms ``connection`` reads ``download`` and ``check``: a caller with no view
    of the queue passes nothing and ``pre_label_run`` is null, which is also
    what a batch never pre-labeled publishes.
    """
    return {
        "id": str(value.id),
        "project_id": str(value.project_id),
        "name": value.name,
        "state": value.state.value,
        "schema_version": value.schema_version,
        "asset_count": len(value.asset_ids),
        "progress": progress_counts(counts),
        "allowed_actions": [a.value for a in batch_actions(value.state)],
        "promoted_asset_count": sum(1 for one in value.asset_ids if one in promoted),
        "parent_batch_id": None if value.parent_batch_id is None else str(value.parent_batch_id),
        "pre_label_run": None if pre_labeled is None else pre_label_run(pre_labeled),
    }


def job(value: AnnotationJob, *, batch_id: UUID, batch_state: BatchState) -> dict[str, Any]:
    """One segment of a batch. ``task_group_id`` and the per-asset map are absent.

    ``batch_state`` is not published here — ``BatchOut`` owns it — but nothing can
    be said about what this job may do without it: both of its actions need the
    batch open. The per-asset map stays unpublished and is still *read*, because
    ``complete`` is refined by whether every asset has settled.
    """
    return {
        "id": str(value.id),
        "batch_id": str(batch_id),
        "state": value.state.value,
        "assignee": value.assignee,
        "asset_count": len(value.progress),
        "allowed_actions": [
            a.value
            for a in job_actions(
                value.state, batch_state=batch_state, progress=value.progress.values()
            )
        ],
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
        case PolygonGeometry() | PolylineGeometry():
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
        "job_id": None if value.job_id is None else str(value.job_id),
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
    """One installed exporter, with the capabilities it declares."""
    return {
        "name": value.format_name,
        "lossy": value.lossy,
        # Sorted, because a set has no order and a wire shape must: two calls to
        # one build have to agree, and a client diffing them should see nothing.
        "geometries": sorted(one.value for one in value.supported_geometries),
        # Beside them rather than merged in: a caller reading `geometries:
        # ["bbox"]` off yolo would conclude a polygon is not written, and a
        # polygon is written.
        "degraded_geometries": sorted(one.value for one in value.degraded_geometries),
        "modalities": sorted(value.supported_modalities),
    }


def class_compatibility(value: ClassCompatibility) -> dict[str, Any]:
    """One class of a release, judged against one format."""
    return {
        "label_class": value.label_class,
        "geometry": value.geometry.value,
        # `status`, not a `supported` boolean: that answers "written intact?" and
        # reads as "written at all?". Three values say which is which, and the two
        # derived booleans stay off the wire so a client cannot be handed a pair
        # that disagree.
        "status": value.status.value,
        "annotations": value.annotations,
        "assets": value.assets,
        "reason": value.reason,
    }


def export_compatibility(value: ExportCompatibility) -> dict[str, Any]:
    """What a format would drop from a release. The same document on all three
    surfaces — attached to a refusal, carried on a result, written into the
    output."""
    return {
        "release_id": str(value.release_id),
        "format": value.format_name,
        "compatible": value.compatible,
        "format_is_lossy": value.format_is_lossy,
        "excluded_annotations": value.excluded_annotations,
        "excluded_assets": value.excluded_assets,
        "degraded_annotations": value.degraded_annotations,
        "degraded_assets": value.degraded_assets,
        "classes": [class_compatibility(one) for one in value.classes],
    }


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
        "compatibility": export_compatibility(value.compatibility),
    }


# --- inference connections ----------------------------------------------------


def weight_download(value: WeightDownload) -> dict[str, Any]:
    """A connection's weight transfer: which job, how far, and how it ended.

    Bytes rather than a percentage or a formatted size, on ``download_size``'s
    terms: how to say "312 MB of 1.4 GB" is a question about a locale and a
    screen width, and a machine reading this wants the integers either way.

    ``bytes_total`` is null where the published size could not be read, which is
    a real answer rather than a failure — the transfer runs regardless and the
    bar it feeds is indeterminate for that run.
    """
    return {
        "job_id": str(value.job_id),
        "state": value.state.value,
        "bytes_done": value.bytes_done,
        "bytes_total": value.bytes_total,
        "error": value.error,
    }


def integrity_check(value: IntegrityCheck) -> dict[str, Any]:
    """A connection's snapshot re-read: which job, how far, and how it ended.

    Files rather than bytes, on ``weight_download``'s terms and for the opposite
    half of the same rule: each names the unit its handler actually counted, so a
    machine reading either knows what it has without looking up a job type.
    """
    return {
        "job_id": str(value.job_id),
        "state": value.state.value,
        "files_read": value.files_read,
        "files_total": value.files_total,
        "error": value.error,
    }


def connection(
    value: InferenceConnection,
    download: WeightDownload | None = None,
    check: IntegrityCheck | None = None,
) -> dict[str, Any]:
    """One configured place a model can be asked to predict.

    No credential key, because the entity carries no credential — where an HTTP
    connection's secret lives is still open, and a key published here would be one
    every consumer starts parsing.

    ``download`` and ``check`` are the runs this connection most recently asked
    for, and they are parameters rather than something read here for the reason
    nothing in this module reads anything: a projection takes what it publishes. A
    caller with no view of the queue passes nothing and the keys are null, which is
    also what a connection nobody has ever downloaded or checked publishes.
    """
    return {
        "id": str(value.id),
        "name": value.name,
        "connection_type": value.connection_type.value,
        "model_id": value.model_id,
        "model_revision": value.model_revision,
        "device": value.device,
        "precision": value.precision,
        "endpoint_url": value.endpoint_url,
        "setup_state": value.setup_state.value,
        # Which driver serves it, as the row records it. Null where none was
        # recorded, which resolves by the model's declared type instead — see
        # ``InferenceConnection.provider_id``.
        "provider_id": value.provider_id,
        "allowed_actions": [
            a.value
            for a in connection_actions(value.setup_state, connection_type=value.connection_type)
        ],
        # What its model answers, where its actions are what may be done *to* it.
        # Empty until something has read the model's own config — see
        # ``InferenceConnection.model_family``.
        "capabilities": [c.value for c in capabilities_of(value.model_family)],
        "download": None if download is None else weight_download(download),
        "integrity_check": None if check is None else integrity_check(check),
        "created_at": _moment(value.created_at),
        "updated_at": _moment(value.updated_at),
    }


def download_size(value: DownloadSize) -> dict[str, Any]:
    """What fetching a model's weights would cost, before anybody fetches them.

    Bytes rather than a formatted string, on ``export_result``'s terms: how to
    say "2.3 GB" is a question about a locale and a screen width, and a machine
    reading this wants the integer either way.
    """
    return {
        "model_id": value.model_id,
        "model_revision": value.model_revision,
        "total_bytes": value.total_bytes,
        "file_count": value.file_count,
    }
