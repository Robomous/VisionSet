"""Tracks over HTTP: occurrences read, tracks created, observed, restructured and deleted."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.fixtures.tracks import FRAMES, TrackWorld, track_world
from tests.server._api import api_workspace, served_app


class Rig:
    def __init__(self, client: TestClient, world: TrackWorld) -> None:
        self.client, self.world = client, world

    def job(self, index: int, tail: str = "") -> str:
        return f"/jobs/{self.world.jobs[index]}/tracks{tail}"

    def track(self, track_id: str | None = None) -> dict[str, Any]:
        response = self.client.get(f"/tracks/{track_id or self.world.track}")
        assert response.status_code == 200, response.text
        found: dict[str, Any] = response.json()
        return found


@pytest.fixture()
def rig(tmp_path: Path) -> Iterator[Rig]:
    root = tmp_path / "ws"
    secret = api_workspace(root)
    world = track_world(root, tmp_path)
    with TestClient(served_app(root), headers={"Authorization": f"Bearer {secret}"}) as client:
        yield Rig(client, world)


def _refused(response: Any, status: int, code: str) -> None:
    assert response.status_code == status, response.text
    assert response.json()["code"] == code


def _positions(track: dict[str, Any]) -> list[int]:
    return [o["position"] for o in track["observations"]]


# --- reading -----------------------------------------------------------------


def test_a_video_source_lists_its_occurrences_in_position_order(rig: Rig) -> None:
    page = rig.client.get(f"/sources/{rig.world.source}/occurrences").json()
    assert page["total"] == FRAMES
    assert [o["position"] for o in page["items"]] == list(range(FRAMES))
    assert page["items"][0] == {
        "id": rig.world.occurrences[0],
        "source_id": rig.world.source,
        "position": 0,
        "timestamp": page["items"][0]["timestamp"],
        "asset_id": rig.world.assets[0],
    }
    assert rig.client.get(f"/sources/{rig.world.stills}/occurrences").json()["total"] == 0
    _refused(rig.client.get(f"/sources/{uuid4()}/occurrences"), 404, "SOURCE_NOT_FOUND")


def test_a_track_reads_with_its_observations(rig: Rig) -> None:
    track = rig.track()
    assert track["label_class"] == "car"
    assert track["external_id"] is None
    assert [o["annotation_id"] for o in track["observations"]] == list(rig.world.observed)
    assert _positions(track) == [0, 1]
    listed = rig.client.get(f"/sources/{rig.world.source}/tracks").json()
    assert listed == {"items": [track], "total": 1}
    _refused(rig.client.get(f"/tracks/{uuid4()}"), 404, "TRACK_NOT_FOUND")
    _refused(rig.client.get(f"/sources/{uuid4()}/tracks"), 404, "SOURCE_NOT_FOUND")


def test_a_track_status_counts_the_batch_progress_of_its_observations(rig: Rig) -> None:
    status = rig.client.get(
        f"/tracks/{rig.world.track}/status", params={"batch_id": rig.world.batch}
    ).json()
    assert status["track_id"] == rig.world.track
    assert status["progress"]["annotated"] == 2
    assert status["progress"]["total"] == 2
    assert status["outside"] == 0
    assert status["settled"] is True
    assert rig.client.get(f"/tracks/{rig.world.track}/status").status_code == 422
    _refused(
        rig.client.get(f"/tracks/{rig.world.track}/status", params={"batch_id": str(uuid4())}),
        404,
        "BATCH_NOT_FOUND",
    )


# --- creating ----------------------------------------------------------------


def test_a_track_is_created_empty_and_its_external_id_is_unique(rig: Rig) -> None:
    path = f"/sources/{rig.world.source}/tracks"
    created = rig.client.post(path, json={"label_class": "van", "external_id": "t1"})
    assert created.status_code == 201, created.text
    assert created.json()["observations"] == []
    assert created.json()["external_id"] == "t1"
    _refused(
        rig.client.post(path, json={"label_class": "car", "external_id": "t1"}),
        409,
        "TRACK_EXTERNAL_ID_TAKEN",
    )


def test_a_track_is_refused_on_a_source_that_is_not_a_video(rig: Rig) -> None:
    _refused(
        rig.client.post(f"/sources/{rig.world.stills}/tracks", json={"label_class": "car"}),
        422,
        "SOURCE_NOT_SEQUENCE",
    )
    _refused(
        rig.client.post(f"/sources/{rig.world.source}/tracks", json={"label_class": "bus"}),
        422,
        "LABEL_CLASS_NOT_IN_SCHEMA",
    )
    _refused(
        rig.client.post(f"/sources/{uuid4()}/tracks", json={"label_class": "car"}),
        404,
        "SOURCE_NOT_FOUND",
    )


@pytest.mark.parametrize(
    "body", [{"label_class": ""}, {"label_class": "car", "external_id": ""}, {"label": "car"}]
)
def test_a_malformed_create_body_is_a_validation_error(rig: Rig, body: dict[str, Any]) -> None:
    _refused(
        rig.client.post(f"/sources/{rig.world.source}/tracks", json=body), 422, "VALIDATION_ERROR"
    )


# --- observing ---------------------------------------------------------------


def test_observe_and_unobserve_round_trip(rig: Rig) -> None:
    body = {"occurrence_id": rig.world.occurrences[3], "annotation_id": rig.world.spare[3]}
    observed = rig.client.post(rig.job(1, f"/{rig.world.track}/observations"), json=body)
    assert observed.status_code == 201, observed.text
    assert _positions(observed.json()) == [0, 1, 3]
    assert observed.json() == rig.track()

    _refused(
        rig.client.post(rig.job(1, f"/{rig.world.track}/observations"), json=body),
        409,
        "OCCURRENCE_ALREADY_OBSERVED",
    )

    removed = rig.client.delete(
        rig.job(1, f"/{rig.world.track}/observations/{rig.world.occurrences[3]}")
    )
    assert removed.status_code == 204, removed.text
    assert _positions(rig.track()) == [0, 1]
    _refused(
        rig.client.delete(
            rig.job(1, f"/{rig.world.track}/observations/{rig.world.occurrences[3]}")
        ),
        404,
        "OBSERVATION_NOT_FOUND",
    )


def test_an_observation_is_refused_by_class_and_by_position(rig: Rig) -> None:
    path = rig.job(0, f"/{rig.world.track}/observations")
    _refused(
        rig.client.post(
            path, json={"occurrence_id": rig.world.occurrences[2], "annotation_id": rig.world.van}
        ),
        409,
        "TRACK_CLASS_MISMATCH",
    )
    _refused(
        rig.client.post(
            path,
            json={"occurrence_id": rig.world.occurrences[1], "annotation_id": rig.world.spare[2]},
        ),
        422,
        "ANNOTATION_NOT_AT_OCCURRENCE",
    )
    _refused(
        rig.client.post(
            path, json={"occurrence_id": str(uuid4()), "annotation_id": rig.world.spare[2]}
        ),
        404,
        "FRAME_OCCURRENCE_NOT_FOUND",
    )


def test_an_observation_outside_the_job_is_a_409_keeping_its_code(rig: Rig) -> None:
    _refused(
        rig.client.post(
            rig.job(0, f"/{rig.world.track}/observations"),
            json={"occurrence_id": rig.world.occurrences[3], "annotation_id": rig.world.spare[3]},
        ),
        409,
        "ASSET_NOT_IN_JOB",
    )


def test_an_unknown_job_is_not_found(rig: Rig) -> None:
    _refused(
        rig.client.put(
            f"/jobs/{uuid4()}/tracks/{rig.world.track}/class", json={"label_class": "van"}
        ),
        404,
        "JOB_NOT_FOUND",
    )
    _refused(
        rig.client.put(rig.job(0, f"/{uuid4()}/class"), json={"label_class": "van"}),
        404,
        "TRACK_NOT_FOUND",
    )


# --- restructuring -----------------------------------------------------------


def test_a_class_change_renames_the_track(rig: Rig) -> None:
    changed = rig.client.put(rig.job(0, f"/{rig.world.track}/class"), json={"label_class": "van"})
    assert changed.status_code == 200, changed.text
    assert changed.json()["label_class"] == "van"
    assert changed.json() == rig.track()


def test_a_merge_absorbs_the_other_track(rig: Rig) -> None:
    other = rig.client.post(
        f"/sources/{rig.world.source}/tracks", json={"label_class": "car", "external_id": "x"}
    ).json()["id"]
    rig.client.post(
        rig.job(0, f"/{other}/observations"),
        json={"occurrence_id": rig.world.occurrences[2], "annotation_id": rig.world.spare[2]},
    ).raise_for_status()

    merged = rig.client.post(rig.job(0, f"/{rig.world.track}/merge"), json={"track_id": other})
    assert merged.status_code == 200, merged.text
    assert _positions(merged.json()) == [0, 1, 2]
    assert merged.json()["external_id"] == "x"
    _refused(rig.client.get(f"/tracks/{other}"), 404, "TRACK_NOT_FOUND")
    _refused(
        rig.client.post(
            rig.job(0, f"/{rig.world.track}/merge"), json={"track_id": rig.world.track}
        ),
        422,
        "TRACK_MERGE_WITH_ITSELF",
    )


def test_a_split_cuts_the_track_in_two(rig: Rig) -> None:
    split = rig.client.post(
        rig.job(0, f"/{rig.world.track}/split"), json={"occurrence_id": rig.world.occurrences[1]}
    )
    assert split.status_code == 200, split.text
    kept, created = split.json()["kept"], split.json()["created"]
    assert kept["id"] == rig.world.track
    assert _positions(kept) == [0]
    assert _positions(created) == [1]
    assert created == rig.track(created["id"])
    _refused(
        rig.client.post(
            rig.job(0, f"/{rig.world.track}/split"),
            json={"occurrence_id": rig.world.occurrences[0]},
        ),
        409,
        "TRACK_SPLIT_EMPTY",
    )


def test_a_structural_write_through_another_job_is_a_409_keeping_its_code(rig: Rig) -> None:
    for response in (
        rig.client.put(rig.job(1, f"/{rig.world.track}/class"), json={"label_class": "van"}),
        rig.client.post(
            rig.job(1, f"/{rig.world.track}/split"),
            json={"occurrence_id": rig.world.occurrences[1]},
        ),
        rig.client.delete(rig.job(1, f"/{rig.world.track}")),
        rig.client.delete(
            rig.job(1, f"/{rig.world.track}/observations/{rig.world.occurrences[0]}")
        ),
    ):
        _refused(response, 409, "ASSET_NOT_IN_JOB")


# --- deleting ----------------------------------------------------------------


def _annotation_ids(rig: Rig, position: int) -> list[str]:
    found = rig.client.get(
        f"/jobs/{rig.world.jobs[0]}/assets/{rig.world.assets[position]}/annotations"
    ).json()
    return [a["id"] for a in found["items"]]


def test_deleting_a_track_keeps_its_annotations(rig: Rig) -> None:
    assert rig.client.delete(rig.job(0, f"/{rig.world.track}")).status_code == 204
    _refused(rig.client.get(f"/tracks/{rig.world.track}"), 404, "TRACK_NOT_FOUND")
    assert _annotation_ids(rig, 0) == [rig.world.observed[0]]


def test_deleting_a_track_with_its_annotations_removes_them(rig: Rig) -> None:
    deleted = rig.client.delete(
        rig.job(0, f"/{rig.world.track}"), params={"with_annotations": "true"}
    )
    assert deleted.status_code == 204, deleted.text
    assert _annotation_ids(rig, 0) == []
    assert _annotation_ids(rig, 1) == []
