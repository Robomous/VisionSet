# usage: from visionset.cli.tracks import track_app
"""``visionset track`` — one object followed through the frames of a sequence source.

``occurrences`` (of a source, or of an asset across sources), ``list``, ``show``,
``status`` and ``create`` read or start tracks; every other command names the job
acting with ``--job``, because a track write passes the same gates an annotation
write does and the job's write scope must hold every observation the operation
touches.

Ids only, as ``job``'s commands take them: tracks, occurrences and annotations
have no names, and each id comes off a previous command's stdout.
"""

from __future__ import annotations

from typing import Annotated, Final
from uuid import UUID

import typer

from visionset import wire
from visionset.cli._output import JsonOption, document, note, table
from visionset.cli._workspace import WorkspaceOption, opened_workspace
from visionset.kernel.domain import AssetProgress, TrackDetail
from visionset.kernel.services import SourceService, TrackService

track_app = typer.Typer(
    help="Follow one object through the frames of a video or image sequence.", no_args_is_help=True
)

TrackArgument = Annotated[UUID, typer.Argument(help="The track, by id.")]
SourceOption = Annotated[
    UUID,
    typer.Option(
        "--source", help="The video, image-sequence or point-cloud-sequence source, by id."
    ),
]
JobOption = Annotated[UUID, typer.Option("--job", help="The annotation job acting, by id.")]
OccurrenceOption = Annotated[
    UUID, typer.Option("--occurrence", help="The frame occurrence, by id.")
]
ClassOption = Annotated[str, typer.Option("--class", help="The label class.")]

_OCCURRENCE_COLUMNS: Final = ("ID", "POSITION", "TIMESTAMP", "ASSET")
_ASSET_OCCURRENCE_COLUMNS: Final = ("ID", "SOURCE", "POSITION", "TIMESTAMP")
_TRACK_COLUMNS: Final = ("ID", "CLASS", "EXTERNAL_ID", "OBSERVATIONS", "FIRST", "LAST")
_OBSERVATION_COLUMNS: Final = ("POSITION", "TIMESTAMP", "OCCURRENCE", "ASSET", "ANNOTATION")
_STATUS_COLUMNS: Final = tuple(state.value.upper() for state in AssetProgress) + (
    "TOTAL",
    "OUTSIDE",
    "SETTLED",
)
_NONE: Final = "-"


def _track_row(detail: TrackDetail) -> tuple[str, ...]:
    frames = detail.observations
    return (
        str(detail.track.id),
        detail.track.label_class,
        detail.track.external_id or _NONE,
        str(len(frames)),
        str(frames[0].position) if frames else _NONE,
        str(frames[-1].position) if frames else _NONE,
    )


def _seconds(timestamp: float | None) -> str:
    return _NONE if timestamp is None else f"{timestamp:g}"


def _print_track(detail: TrackDetail, *, json_out: bool) -> None:
    if json_out:
        document(wire.track(detail))
        return
    table(_TRACK_COLUMNS, [_track_row(detail)])
    if detail.observations:
        typer.echo()
        table(
            _OBSERVATION_COLUMNS,
            [
                (
                    str(f.position),
                    _seconds(f.timestamp),
                    str(f.occurrence_id),
                    str(f.asset_id),
                    str(f.annotation_id),
                )
                for f in detail.observations
            ],
        )


@track_app.command("occurrences")
def track_occurrences(
    source: Annotated[
        UUID | None,
        typer.Option(
            "--source",
            help="The video, image-sequence or point-cloud-sequence source, by id. Or --asset.",
        ),
    ] = None,
    asset: Annotated[
        UUID | None,
        typer.Option("--asset", help="The asset, by id, across every source. Or --source."),
    ] = None,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """List a source's frame occurrences in position order, or an asset's in every source."""
    if (source is None) == (asset is None):
        raise typer.BadParameter("Give exactly one of --source and --asset.")
    with opened_workspace(workspace) as service:
        sources = SourceService(service)
        if source is not None:
            found = sources.occurrences(source)
        elif asset is not None:
            found = sources.asset_occurrences(asset)
    if json_out:
        document(wire.page([wire.frame_occurrence(o) for o in found]))
        return
    if source is not None:
        table(
            _OCCURRENCE_COLUMNS,
            [(str(o.id), str(o.position), _seconds(o.timestamp), str(o.asset_id)) for o in found],
        )
        return
    table(
        _ASSET_OCCURRENCE_COLUMNS,
        [(str(o.id), str(o.source_id), str(o.position), _seconds(o.timestamp)) for o in found],
    )


@track_app.command("list")
def track_list(
    source: SourceOption, json_out: JsonOption = False, workspace: WorkspaceOption = None
) -> None:
    """List a source's tracks, in creation order."""
    with opened_workspace(workspace) as service:
        found = TrackService(service).list(source)
    if json_out:
        document(wire.page([wire.track(t) for t in found]))
        return
    table(_TRACK_COLUMNS, [_track_row(t) for t in found])


@track_app.command("show")
def track_show(
    track: TrackArgument, json_out: JsonOption = False, workspace: WorkspaceOption = None
) -> None:
    """Print a track and its observations, in position order."""
    with opened_workspace(workspace) as service:
        found = TrackService(service).get(track)
    _print_track(found, json_out=json_out)


@track_app.command("status")
def track_status(
    track: TrackArgument,
    batch: Annotated[UUID, typer.Option("--batch", help="The batch whose work to count.")],
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Count a track's observations by the progress their assets hold in a batch.

    OUTSIDE counts observations on assets the batch does not hold. SETTLED is
    yes when the track has an observation, the batch holds every one, and each
    sits on a settled asset.
    """
    with opened_workspace(workspace) as service:
        found = TrackService(service).status(track, batch)
    if json_out:
        document(wire.track_status(found))
        return
    counts = wire.progress_counts(found.progress)
    table(
        _STATUS_COLUMNS,
        [
            (
                *(str(found.progress[state]) for state in AssetProgress),
                str(counts["total"]),
                str(found.outside),
                "yes" if found.settled else "no",
            )
        ],
    )


@track_app.command("create")
def track_create(
    source: SourceOption,
    label_class: ClassOption,
    external_id: Annotated[
        str | None,
        typer.Option("--external-id", help="An identity the track keeps, unique in the source."),
    ] = None,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Start an empty track on a sequence source, of a class the active schema declares."""
    with opened_workspace(workspace) as service:
        created = TrackService(service).create(source, label_class, external_id=external_id)
    if json_out:
        document(wire.track(created))
        return
    typer.echo(str(created.track.id))


@track_app.command("observe")
def track_observe(
    track: TrackArgument,
    job: JobOption,
    occurrence: OccurrenceOption,
    annotation: Annotated[
        UUID, typer.Option("--annotation", help="The annotation drawn at the occurrence, by id.")
    ],
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Record that the track is seen at an occurrence, as an annotation drawn there.

    The annotation must sit on the occurrence's asset, carry the track's class
    and geometry type, and be a 2D label on an image or a cuboid_3d on a scan,
    and the job must carry that asset at a writable progress.
    """
    with opened_workspace(workspace) as service:
        found = TrackService(service).observe(job, track, occurrence, annotation)
    _print_track(found, json_out=json_out)


@track_app.command("start")
def track_start(
    job: JobOption,
    occurrence: OccurrenceOption,
    annotation: Annotated[
        UUID, typer.Option("--annotation", help="The annotation drawn at the occurrence, by id.")
    ],
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Start a track of the annotation's class on the occurrence's source, observing it there.

    One write: a refused observation leaves no track behind. Every rule of
    creating a track and of observing holds.
    """
    with opened_workspace(workspace) as service:
        found = TrackService(service).start(job, occurrence, annotation)
    _print_track(found, json_out=json_out)


@track_app.command("unobserve")
def track_unobserve(
    track: TrackArgument,
    job: JobOption,
    occurrence: OccurrenceOption,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Remove the track's observation at an occurrence. The annotation stays."""
    with opened_workspace(workspace) as service:
        found = TrackService(service).unobserve(job, track, occurrence)
    _print_track(found, json_out=json_out)


@track_app.command("set-class")
def track_set_class(
    track: TrackArgument,
    job: JobOption,
    label_class: ClassOption,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Give the track and every annotation it observes a new class, in one transaction."""
    with opened_workspace(workspace) as service:
        found = TrackService(service).change_class(job, track, label_class)
    _print_track(found, json_out=json_out)


@track_app.command("merge")
def track_merge(
    track: TrackArgument,
    absorbed: Annotated[UUID, typer.Argument(help="The track to absorb and delete, by id.")],
    job: JobOption,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Move every observation of ABSORBED onto TRACK, and delete ABSORBED.

    The tracks share a source, a class and a geometry type and observe disjoint
    occurrences.
    TRACK keeps its external id, and takes ABSORBED's when it has none.
    """
    with opened_workspace(workspace) as service:
        found = TrackService(service).merge(job, track, absorbed)
    _print_track(found, json_out=json_out)


@track_app.command("split")
def track_split(
    track: TrackArgument,
    job: JobOption,
    occurrence: OccurrenceOption,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Cut the track at an occurrence: it and every later observation move to a new track."""
    with opened_workspace(workspace) as service:
        kept, created = TrackService(service).split(job, track, occurrence)
    if json_out:
        document(wire.track_split(kept, created))
        return
    table(_TRACK_COLUMNS, [_track_row(kept), _track_row(created)])


@track_app.command("delete")
def track_delete(
    track: TrackArgument,
    job: JobOption,
    with_annotations: Annotated[
        bool,
        typer.Option("--with-annotations", help="Also delete every annotation it observes."),
    ] = False,
    json_out: JsonOption = False,
    workspace: WorkspaceOption = None,
) -> None:
    """Delete the track. Its annotations stay unless --with-annotations is given."""
    with opened_workspace(workspace) as service:
        tracks = TrackService(service)
        if with_annotations:
            removed = tracks.delete_with_annotations(job, track)
        else:
            tracks.delete(job, track)
            removed = 0
    if json_out:
        document(wire.track_deletion(track, removed))
        return
    note(f"Deleted track {track} and {removed} annotation(s).")
