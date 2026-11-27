"""The track tools: an agent reads occurrences, builds a track and restructures it."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from tests.fixtures.tracks import FRAMES, TrackWorld, repeat_clip, track_world
from tests.mcp._flow import call, error, payload, workspace


@pytest.fixture()
def world(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> TrackWorld:
    return track_world(workspace(monkeypatch, tmp_path), tmp_path)


def _positions(track: dict[str, Any]) -> list[int]:
    return [o["position"] for o in track["observations"]]


def test_occurrences_tracks_and_status_are_read(world: TrackWorld) -> None:
    occurrences = payload(call("list_frame_occurrences", source_id=world.source))
    assert [o["id"] for o in occurrences["items"]] == list(world.occurrences)
    assert occurrences["total"] == FRAMES

    (track,) = payload(call("list_tracks", source_id=world.source))["items"]
    assert track["id"] == world.track
    assert _positions(track) == [0, 1]

    status = payload(call("get_track_status", track_id=world.track, batch_id=world.batch))
    assert status["settled"] is True
    assert status["progress"]["annotated"] == 2


def test_an_asset_s_occurrences_name_every_source_it_sits_in(
    world: TrackWorld, tmp_path: Path
) -> None:
    second = repeat_clip(tmp_path / "ws", [0])
    found = payload(call("list_asset_occurrences", asset_id=world.assets[0]))
    assert [(o["source_id"], o["position"]) for o in found["items"]] == [
        (world.source, 0),
        (second, 0),
    ]
    assert error(call("list_asset_occurrences", asset_id=str(uuid4())))["code"] == (
        "ASSET_NOT_FOUND"
    )


def test_an_agent_builds_and_restructures_a_track(world: TrackWorld) -> None:
    job = world.jobs[0]
    created = payload(call("create_track", source_id=world.source, label_class="car"))
    assert created["observations"] == []
    observed = payload(
        call(
            "observe_track",
            job_id=job,
            track_id=created["id"],
            occurrence_id=world.occurrences[2],
            annotation_id=world.spare[2],
        )
    )
    assert _positions(observed) == [2]

    merged = payload(
        call("merge_tracks", job_id=job, track_id=world.track, absorbed_track_id=created["id"])
    )
    assert _positions(merged) == [0, 1, 2]

    renamed = payload(call("set_track_class", job_id=job, track_id=world.track, label_class="van"))
    assert renamed["label_class"] == "van"

    split = payload(
        call("split_track", job_id=job, track_id=world.track, occurrence_id=world.occurrences[1])
    )
    assert _positions(split["kept"]) == [0]
    assert _positions(split["created"]) == [1, 2]

    removed = payload(
        call(
            "unobserve_track", job_id=job, track_id=world.track, occurrence_id=world.occurrences[0]
        )
    )
    assert removed["observations"] == []


def test_delete_keeps_or_removes_the_annotations(world: TrackWorld) -> None:
    other = payload(call("create_track", source_id=world.source, label_class="car"))["id"]
    assert payload(call("delete_track", job_id=world.jobs[0], track_id=other)) == {
        "track_id": other,
        "annotations_deleted": 0,
    }
    deleted = payload(
        call("delete_track", job_id=world.jobs[0], track_id=world.track, with_annotations=True)
    )
    assert deleted == {"track_id": world.track, "annotations_deleted": 2}


def test_refusals_arrive_in_the_envelope(world: TrackWorld) -> None:
    assert error(call("delete_track", job_id=world.jobs[1], track_id=world.track))["code"] == (
        "ASSET_NOT_IN_JOB"
    )
    assert error(call("create_track", source_id=world.stills, label_class="car"))["code"] == (
        "SOURCE_NOT_SEQUENCE"
    )
    refused = error(
        call(
            "observe_track",
            job_id=world.jobs[0],
            track_id=world.track,
            occurrence_id=world.occurrences[2],
            annotation_id=world.van,
        )
    )
    assert refused["code"] == "TRACK_CLASS_MISMATCH"
    assert error(call("list_tracks", source_id="not-a-uuid"))["code"] == "VALIDATION_ERROR"


def test_an_agent_starts_a_track_in_one_write_or_leaves_nothing(world: TrackWorld) -> None:
    started = payload(
        call(
            "start_track",
            job_id=world.jobs[0],
            occurrence_id=world.occurrences[2],
            annotation_id=world.van,
        )
    )
    assert started["label_class"] == "van"
    assert _positions(started) == [2]
    listed = payload(call("list_tracks", source_id=world.source))["total"]
    refused = error(
        call(
            "start_track",
            job_id=world.jobs[0],
            occurrence_id=world.occurrences[3],
            annotation_id=world.spare[3],
        )
    )
    assert refused["code"] == "ASSET_NOT_IN_JOB"
    assert payload(call("list_tracks", source_id=world.source))["total"] == listed
