"""``visionset track``: occurrences read, tracks created, observed, restructured, deleted."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from tests.cli._flow import ok, payload, project, run, workspace
from tests.fixtures.tracks import FRAMES, TrackWorld, track_world
from tests.formats.test_cvat import TRACKS, _video_source

from visionset.kernel.domain import ImportLossKind

_EVERY_CONSENT = [arg for kind in ImportLossKind for arg in ("--consent-lossy", kind.value)]


@pytest.fixture()
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.delenv("VISIONSET_WORKSPACE", raising=False)
    return workspace(tmp_path)


@pytest.fixture()
def world(root: Path, tmp_path: Path) -> TrackWorld:
    return track_world(root, tmp_path)


def _refusal(root: Path, *argv: str) -> dict[str, Any]:
    result = run(root, *argv, "--json")
    assert result.exit_code == 1, result.output
    error: dict[str, Any] = json.loads(result.stdout)["error"]
    return error


def _positions(track: dict[str, Any]) -> list[int]:
    return [o["position"] for o in track["observations"]]


def test_occurrences_and_tracks_are_listed(root: Path, world: TrackWorld) -> None:
    occurrences = payload(root, "track", "occurrences", "--source", world.source)
    assert [o["id"] for o in occurrences["items"]] == list(world.occurrences)
    assert occurrences["total"] == FRAMES

    listed = payload(root, "track", "list", "--source", world.source)
    shown = payload(root, "track", "show", world.track)
    assert listed == {"items": [shown], "total": 1}
    assert _positions(shown) == [0, 1]

    text = ok(root, "track", "show", world.track)
    assert world.track in text
    assert world.observed[1] in text


def test_status_counts_the_batch_progress(root: Path, world: TrackWorld) -> None:
    status = payload(root, "track", "status", world.track, "--batch", world.batch)
    assert status["progress"]["annotated"] == 2
    assert status["outside"] == 0
    assert status["settled"] is True
    assert "yes" in ok(root, "track", "status", world.track, "--batch", world.batch)


def test_create_prints_the_id_and_refuses_a_taken_external_id(
    root: Path, world: TrackWorld
) -> None:
    created = ok(
        root, "track", "create", "--source", world.source, "--class", "van", "--external-id", "t1"
    )
    assert payload(root, "track", "show", created)["external_id"] == "t1"
    refused = _refusal(
        root, "track", "create", "--source", world.source, "--class", "car", "--external-id", "t1"
    )
    assert refused["code"] == "TRACK_EXTERNAL_ID_TAKEN"
    refused = _refusal(root, "track", "create", "--source", world.stills, "--class", "car")
    assert refused["code"] == "SOURCE_NOT_SEQUENCE"


def test_a_blank_class_or_external_id_is_refused_not_crashed(root: Path, world: TrackWorld) -> None:
    refused = _refusal(root, "track", "create", "--source", world.source, "--class", "")
    assert refused["code"] == "INVALID_NAME"
    refused = _refusal(
        root, "track", "create", "--source", world.source, "--class", "car", "--external-id", ""
    )
    assert refused["code"] == "INVALID_NAME"
    refused = _refusal(
        root, "track", "set-class", world.track, "--job", world.jobs[0], "--class", ""
    )
    assert refused["code"] == "INVALID_NAME"


def test_observe_and_unobserve(root: Path, world: TrackWorld) -> None:
    job = world.jobs[1]
    observed = payload(
        root,
        "track",
        "observe",
        world.track,
        "--job",
        job,
        "--occurrence",
        world.occurrences[3],
        "--annotation",
        world.spare[3],
    )
    assert _positions(observed) == [0, 1, 3]
    removed = payload(
        root, "track", "unobserve", world.track, "--job", job, "--occurrence", world.occurrences[3]
    )
    assert _positions(removed) == [0, 1]
    refused = _refusal(
        root, "track", "unobserve", world.track, "--job", job, "--occurrence", world.occurrences[3]
    )
    assert refused["code"] == "OBSERVATION_NOT_FOUND"


def test_set_class_merge_and_split(root: Path, world: TrackWorld) -> None:
    job = world.jobs[0]
    renamed = payload(root, "track", "set-class", world.track, "--job", job, "--class", "van")
    assert renamed["label_class"] == "van"
    payload(root, "track", "set-class", world.track, "--job", job, "--class", "car")

    other = ok(root, "track", "create", "--source", world.source, "--class", "car")
    ok(
        root,
        "track",
        "observe",
        other,
        "--job",
        job,
        "--occurrence",
        world.occurrences[2],
        "--annotation",
        world.spare[2],
    )
    merged = payload(root, "track", "merge", world.track, other, "--job", job)
    assert _positions(merged) == [0, 1, 2]

    split = payload(
        root, "track", "split", world.track, "--job", job, "--occurrence", world.occurrences[2]
    )
    assert _positions(split["kept"]) == [0, 1]
    assert _positions(split["created"]) == [2]
    assert split["created"]["label_class"] == "car"


def test_a_write_through_a_job_not_holding_the_track_is_refused(
    root: Path, world: TrackWorld
) -> None:
    refused = _refusal(root, "track", "delete", world.track, "--job", world.jobs[1])
    assert refused["code"] == "ASSET_NOT_IN_JOB"


def test_delete_reports_what_it_removed(root: Path, world: TrackWorld) -> None:
    deleted = payload(root, "track", "delete", world.track, "--job", world.jobs[0])
    assert deleted == {"track_id": world.track, "annotations_deleted": 0}
    assert _refusal(root, "track", "show", world.track)["code"] == "TRACK_NOT_FOUND"


def test_delete_with_annotations_counts_them(root: Path, world: TrackWorld) -> None:
    deleted = payload(
        root, "track", "delete", world.track, "--job", world.jobs[0], "--with-annotations"
    )
    assert deleted == {"track_id": world.track, "annotations_deleted": 2}


def test_an_unknown_track_exits_one(root: Path, world: TrackWorld) -> None:
    result = run(root, "track", "show", str(uuid4()))
    assert result.exit_code == 1
    assert "no track" in result.output


def test_unknown_timing_reads_as_a_dash_and_as_null(root: Path, tmp_path: Path) -> None:
    src = _video_source(tmp_path / "task", TRACKS)
    name = project(root, "cvat")
    imported = payload(root, "import", "cvat-video", str(src), "--project", name, *_EVERY_CONSENT)
    (source,) = imported["source_ids"]

    listed = payload(root, "track", "occurrences", "--source", source)
    assert {o["timestamp"] for o in listed["items"]} == {None}
    shown = payload(root, "track", "list", "--source", source)
    assert {o["timestamp"] for t in shown["items"] for o in t["observations"]} == {None}

    rows = ok(root, "track", "occurrences", "--source", source).splitlines()[1:]
    assert rows
    assert all(row.split()[2] == "-" for row in rows)


def test_start_creates_and_observes_in_one_write_or_leaves_nothing(
    root: Path, world: TrackWorld
) -> None:
    started = payload(
        root,
        "track",
        "start",
        "--job",
        world.jobs[0],
        "--occurrence",
        world.occurrences[2],
        "--annotation",
        world.van,
    )
    assert started["label_class"] == "van"
    assert _positions(started) == [2]
    listed = payload(root, "track", "list", "--source", world.source)["total"]
    refused = _refusal(
        root,
        "track",
        "start",
        "--job",
        world.jobs[0],
        "--occurrence",
        world.occurrences[3],
        "--annotation",
        world.spare[3],
    )
    assert refused["code"] == "ASSET_NOT_IN_JOB"
    assert payload(root, "track", "list", "--source", world.source)["total"] == listed
