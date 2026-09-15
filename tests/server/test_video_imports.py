"""Importing a clip the server never sees: open a session, stream frames, commit or abort.

`test_sources.py`'s shape — a two-line fixture over `_api.py`, assertions at the
wire (status and `code`), and a closing guard sweep. What the service does with a
session is `tests/kernel/test_video_import_service.py`; nothing here restates it.
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.fixtures.media import write_image
from tests.server._api import api_client
from tests.server._openapi import operations

from visionset.server.main import app
from visionset.server.routes.video_imports import FRAMES_PER_REQUEST

FRAME_SIZE = (32, 24)

#: A four-second clip, which at the default rate of one frame a second is four
#: grid points — small enough that a test can fill a whole session.
METADATA = {
    "width": FRAME_SIZE[0],
    "height": FRAME_SIZE[1],
    "fps": 10.0,
    "duration_seconds": 4.0,
    "codec": "h264",
}
EXPECTED = 4


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws") as made:
        yield made


@pytest.fixture()
def project(client: TestClient) -> str:
    response = client.post("/projects", json={"name": "road-signs"})
    assert response.status_code == 201, response.text
    project_id: str = response.json()["id"]
    return project_id


def start(client: TestClient, project: str, **body: Any) -> Any:
    return client.post(
        f"/projects/{project}/video-imports",
        json={"display_name": "drive.mp4", "metadata": METADATA, **body},
    )


@pytest.fixture()
def session(client: TestClient, project: str) -> str:
    response = start(client, project)
    assert response.status_code == 201, response.text
    import_id: str = response.json()["id"]
    return import_id


def png(tmp_path: Path, *, seed: int, size: tuple[int, int] = FRAME_SIZE) -> bytes:
    path = tmp_path / "made" / f"{seed}-{size[0]}x{size[1]}.png"
    return write_image(path, size=size, seed=seed).read_bytes()


def described(ordinal: int, **over: Any) -> dict[str, Any]:
    return {
        "ordinal": ordinal,
        "requested_timestamp": float(ordinal),
        "source_timestamp": None,
        "width": FRAME_SIZE[0],
        "height": FRAME_SIZE[1],
        **over,
    }


def post_frames(
    client: TestClient,
    import_id: str,
    parts: Sequence[bytes],
    descriptors: Sequence[dict[str, Any]] | str,
) -> Any:
    payload = descriptors if isinstance(descriptors, str) else json.dumps(list(descriptors))
    return client.post(
        f"/video-imports/{import_id}/frames",
        files=[
            ("files", (f"frame-{index}.png", part, "image/png")) for index, part in enumerate(parts)
        ],
        data={"descriptors": payload},
    )


def approved_batch(client: TestClient, project: str, tmp_path: Path) -> str:
    """A batch past `draft`: frames imported into it, a schema published, then approved."""
    import_id = start(client, project, batch_name="already cut").json()["id"]
    send(client, import_id, tmp_path, *range(EXPECTED))
    batch_id: str = client.post(f"/video-imports/{import_id}/commit").json()["id"]
    client.post(
        f"/projects/{project}/schema/versions",
        json={"classes": [{"name": "thing", "geometries": ["bbox"]}]},
    )
    assert client.post(f"/batches/{batch_id}/approve").status_code == 200
    return batch_id


def send(client: TestClient, import_id: str, tmp_path: Path, *ordinals: int) -> Any:
    """Materialize and post one frame per ordinal, each with its own bytes."""
    return post_frames(
        client,
        import_id,
        [png(tmp_path, seed=ordinal) for ordinal in ordinals],
        [described(ordinal) for ordinal in ordinals],
    )


# --- no video ever crosses the wire ------------------------------------------


def test_starting_an_import_takes_metadata_and_refuses_a_file(
    client: TestClient, project: str
) -> None:
    """The whole point of the session: the clip stays on the machine that has it."""
    response = client.post(
        f"/projects/{project}/video-imports",
        files={"file": ("drive.mp4", b"\x00\x00\x00 ftypisom", "video/mp4")},
    )

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_no_operation_in_the_contract_accepts_video_bytes() -> None:
    spec = app.openapi()

    accepting = [
        f"{method.upper()} {path} ({media})"
        for path, method, operation in operations(spec)
        for media in (operation.get("requestBody") or {}).get("content", {})
        if media.startswith("video/")
    ]

    assert accepting == []
    assert [path for path in spec["paths"] if path.endswith("/sources/video")] == []


# --- opening a session -------------------------------------------------------


def test_starting_an_import_opens_it_and_counts_the_frames_to_come(
    client: TestClient, project: str
) -> None:
    response = start(client, project)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["project_id"] == project
    assert body["state"] == "open"
    # The server's own count over the declared selection, never the client's.
    assert body["expected_frame_count"] == EXPECTED
    assert body["received_frame_count"] == 0
    assert body["batch_id"] is None


def test_an_import_registers_a_video_source_of_its_own(client: TestClient, project: str) -> None:
    first = start(client, project).json()
    second = start(client, project).json()

    assert first["source_id"] != second["source_id"]
    source = client.get(f"/sources/{first['source_id']}")
    assert source.status_code == 200
    assert source.json()["kind"] == "video"
    assert source.json()["video"]["extraction_fps"] == 1.0


def test_a_declared_cut_is_echoed_canonically_on_the_source(
    client: TestClient, project: str
) -> None:
    body = start(
        client,
        project,
        extraction_fps=2,
        ranges=[
            {"start_seconds": 1.2, "end_seconds": 1.8},
            {"start_seconds": 0.2, "end_seconds": 1.5},
        ],
        scale_percent=50,
    ).json()

    source = client.get(f"/sources/{body['source_id']}").json()
    assert source["video"]["ranges"] == [{"start_seconds": 0.2, "end_seconds": 1.8}]
    assert source["video"]["scale_percent"] == 50


def test_a_selection_that_holds_no_frame_is_422_rather_than_an_empty_batch(
    client: TestClient, project: str
) -> None:
    """Narrower than one interval at the rate: the kernel's bare ValueError never 500s."""
    response = start(client, project, ranges=[{"start_seconds": 0.5, "end_seconds": 0.6}])

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_a_blank_name_is_the_kernels_own_422(client: TestClient, project: str) -> None:
    response = start(client, project, display_name="   ")

    assert response.status_code == 422
    assert response.json()["code"] == "INVALID_NAME"


def test_naming_a_batch_twice_over_is_a_422(client: TestClient, project: str) -> None:
    """A body that names a batch and asks for a new one says two different things."""
    response = start(client, project, batch_id=str(uuid4()), batch_name="drive")

    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_an_unknown_target_batch_is_404_before_a_frame_is_decoded(
    client: TestClient, project: str
) -> None:
    response = start(client, project, batch_id=str(uuid4()))

    assert response.status_code == 404
    assert response.json()["code"] == "BATCH_NOT_FOUND"


def test_a_target_batch_past_draft_is_409_before_a_frame_is_decoded(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    response = start(client, project, batch_id=approved_batch(client, project, tmp_path))

    assert response.status_code == 409
    assert response.json()["code"] == "BATCH_NOT_EDITABLE"


def test_starting_an_import_in_an_unknown_project_is_404(client: TestClient) -> None:
    response = start(client, str(uuid4()))

    assert response.status_code == 404
    assert response.json()["code"] == "PROJECT_NOT_FOUND"


# --- reading -----------------------------------------------------------------


def test_reading_an_import_answers_its_progress(
    client: TestClient, session: str, tmp_path: Path
) -> None:
    send(client, session, tmp_path, 0, 1)

    response = client.get(f"/video-imports/{session}")

    assert response.status_code == 200
    assert response.json()["received_frame_count"] == 2
    assert response.json()["expected_frame_count"] == EXPECTED


def test_reading_an_unknown_import_is_404(client: TestClient) -> None:
    response = client.get(f"/video-imports/{uuid4()}")

    assert response.status_code == 404
    assert response.json()["code"] == "VIDEO_IMPORT_NOT_FOUND"


# --- staging frames ----------------------------------------------------------


def test_appending_frames_advances_the_session(
    client: TestClient, session: str, tmp_path: Path
) -> None:
    response = send(client, session, tmp_path, 0, 1, 2)

    assert response.status_code == 200, response.text
    assert response.json()["received_frame_count"] == 3
    assert response.json()["state"] == "open"


def test_nothing_staged_is_an_asset_of_the_project(
    client: TestClient, project: str, session: str, tmp_path: Path
) -> None:
    """The invariant the session exists for, asserted where a client would see it."""
    send(client, session, tmp_path, 0, 1)

    assert client.get(f"/projects/{project}/assets").json()["total"] == 0
    assert client.get(f"/projects/{project}/batches").json()["total"] == 0


def test_resending_the_same_frame_is_a_retry_rather_than_progress(
    client: TestClient, session: str, tmp_path: Path
) -> None:
    send(client, session, tmp_path, 0, 1)

    again = send(client, session, tmp_path, 1)

    assert again.status_code == 200, again.text
    assert again.json()["received_frame_count"] == 2


def test_the_same_ordinal_with_different_bytes_is_a_conflict(
    client: TestClient, session: str, tmp_path: Path
) -> None:
    send(client, session, tmp_path, 0)

    response = post_frames(client, session, [png(tmp_path, seed=99)], [described(0)])

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "FRAME_CONTENT_CONFLICT"


def test_an_ordinal_past_the_expected_count_is_refused(
    client: TestClient, session: str, tmp_path: Path
) -> None:
    response = send(client, session, tmp_path, EXPECTED)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "FRAME_ORDINAL_OUT_OF_RANGE"


def test_a_part_in_another_image_format_is_refused(
    client: TestClient, session: str, tmp_path: Path
) -> None:
    """PNG is the format of a frame, checked rather than asked for politely."""
    jpeg = write_image(tmp_path / "made" / "frame.jpg", size=FRAME_SIZE, seed=0).read_bytes()

    response = post_frames(client, session, [jpeg], [described(0)])

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "UNSUPPORTED_MEDIA"


def test_a_part_that_is_not_an_image_at_all_is_refused(client: TestClient, session: str) -> None:
    response = post_frames(client, session, [b"not an image at all"], [described(0)])

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "UNSUPPORTED_MEDIA"


def test_a_descriptor_that_disagrees_with_its_bytes_is_refused(
    client: TestClient, session: str, tmp_path: Path
) -> None:
    """A declaration checked against the decode: the two grids have drifted apart."""
    response = post_frames(
        client, session, [png(tmp_path, seed=0)], [described(0, width=FRAME_SIZE[0] * 2)]
    )

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "UNSUPPORTED_MEDIA"


def test_appending_to_an_unknown_import_is_404(client: TestClient, tmp_path: Path) -> None:
    response = send(client, str(uuid4()), tmp_path, 0)

    assert response.status_code == 404
    assert response.json()["code"] == "VIDEO_IMPORT_NOT_FOUND"


# --- the chunk is bounded ----------------------------------------------------


def test_more_parts_than_the_cap_are_refused(
    client: TestClient, session: str, tmp_path: Path
) -> None:
    """A whole extraction in one request is what this route exists not to accept."""
    over = FRAMES_PER_REQUEST + 1
    frame = png(tmp_path, seed=0)

    response = post_frames(
        client, session, [frame] * over, [described(index) for index in range(over)]
    )

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "VALIDATION_ERROR"
    assert str(FRAMES_PER_REQUEST) in response.text


def test_fewer_descriptors_than_parts_is_refused(
    client: TestClient, session: str, tmp_path: Path
) -> None:
    response = post_frames(
        client, session, [png(tmp_path, seed=0), png(tmp_path, seed=1)], [described(0)]
    )

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize(
    "bad",
    ["not json", '[{"ordinal": -1}]', '[{"ordinal": 0}]', '{"ordinal": 0}'],
    ids=["not-json", "negative-ordinal", "missing-fields", "not-an-array"],
)
def test_a_malformed_descriptor_array_is_refused(
    client: TestClient, session: str, tmp_path: Path, bad: str
) -> None:
    response = post_frames(client, session, [png(tmp_path, seed=0)], bad)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "VALIDATION_ERROR"


# --- committing --------------------------------------------------------------


def test_committing_an_incomplete_import_is_refused(
    client: TestClient, session: str, tmp_path: Path
) -> None:
    send(client, session, tmp_path, 0, 1)

    response = client.post(f"/video-imports/{session}/commit")

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "VIDEO_IMPORT_INCOMPLETE"


def test_committing_a_complete_import_answers_the_batch_it_made(
    client: TestClient, project: str, session: str, tmp_path: Path
) -> None:
    send(client, session, tmp_path, *range(EXPECTED))

    response = client.post(f"/video-imports/{session}/commit")

    assert response.status_code == 200, response.text
    batch = response.json()
    assert batch["project_id"] == project
    assert batch["state"] == "draft"
    assert batch["asset_count"] == EXPECTED
    assert batch["name"] == "drive.mp4"
    assert client.get(f"/batches/{batch['id']}/assets").json()["total"] == EXPECTED
    closed = client.get(f"/video-imports/{session}").json()
    assert closed["state"] == "committed"
    assert closed["batch_id"] == batch["id"]


def test_committing_names_the_batch_the_import_asked_for(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    import_id = start(client, project, batch_name="drive, morning").json()["id"]
    send(client, import_id, tmp_path, *range(EXPECTED))

    batch = client.post(f"/video-imports/{import_id}/commit").json()

    assert batch["name"] == "drive, morning"


def test_committing_adds_to_the_draft_the_import_named(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    """The capability the old server-side video path had: join a batch already there."""
    first = start(client, project, batch_name="drive, morning").json()["id"]
    send(client, first, tmp_path, *range(EXPECTED))
    existing = client.post(f"/video-imports/{first}/commit").json()

    second = start(client, project, batch_id=existing["id"]).json()["id"]
    post_frames(
        client,
        second,
        [png(tmp_path, seed=100 + ordinal) for ordinal in range(EXPECTED)],
        [described(ordinal) for ordinal in range(EXPECTED)],
    )
    batch = client.post(f"/video-imports/{second}/commit").json()

    assert batch["id"] == existing["id"]
    assert batch["name"] == "drive, morning"
    assert batch["asset_count"] == existing["asset_count"] + EXPECTED


def test_committing_into_a_deleted_target_batch_is_404(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    """The contract this route publishes, which used to be false.

    `target_batch_id` carried `ON DELETE SET NULL`, so a deleted target read back
    as "nobody named one" and the commit invented a batch of its own — the one
    outcome nobody asked for, in place of the refusal documented here.
    """
    first = start(client, project, batch_name="drive, morning").json()["id"]
    send(client, first, tmp_path, *range(EXPECTED))
    existing = client.post(f"/video-imports/{first}/commit").json()["id"]

    second = start(client, project, batch_id=existing).json()["id"]
    post_frames(
        client,
        second,
        [png(tmp_path, seed=200 + ordinal) for ordinal in range(EXPECTED)],
        [described(ordinal) for ordinal in range(EXPECTED)],
    )
    assert client.delete(f"/batches/{existing}?confirm=true").status_code == 204

    response = client.post(f"/video-imports/{second}/commit")

    assert response.status_code == 404, response.text
    assert response.json()["code"] == "BATCH_NOT_FOUND"
    assert client.get(f"/projects/{project}/batches").json()["total"] == 0


def test_a_clip_range_that_does_not_start_at_zero_is_importable(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    """An ordinal is an extraction-grid index, not a position within the selection.

    The UI lets a range be dragged anywhere in the clip, and every such session
    was refused frame by frame — a 422 partway through a long decode.
    """
    import_id = start(
        client,
        project,
        ranges=[{"start_seconds": 2.0, "end_seconds": 4.0}],
    ).json()["id"]
    assert client.get(f"/video-imports/{import_id}").json()["expected_frame_count"] == 2

    response = post_frames(
        client,
        import_id,
        [png(tmp_path, seed=ordinal) for ordinal in (2, 3)],
        [described(ordinal) for ordinal in (2, 3)],
    )

    assert response.status_code == 200, response.text
    assert response.json()["received_frame_count"] == 2
    assert client.post(f"/video-imports/{import_id}/commit").status_code == 200


def test_an_ordinal_the_selection_does_not_hold_is_refused(
    client: TestClient, project: str, tmp_path: Path
) -> None:
    """`0` is inside the count and outside a selection that starts at two seconds."""
    import_id = start(client, project, ranges=[{"start_seconds": 2.0, "end_seconds": 4.0}]).json()[
        "id"
    ]

    response = post_frames(client, import_id, [png(tmp_path, seed=0)], [described(0)])

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "FRAME_ORDINAL_OUT_OF_RANGE"


def test_a_video_source_cannot_be_asked_for_an_ingest_run(client: TestClient, project: str) -> None:
    """It answered `202` and then died on a bare `FileNotFoundError`, which is a 500.

    The batch it named came from the source's locator, which is the opaque
    `video-import:<uuid>` no wire model publishes.
    """
    import_id = start(client, project).json()["id"]
    source_id = client.get(f"/video-imports/{import_id}").json()["source_id"]

    response = client.post(f"/sources/{source_id}/ingest-jobs")

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "UNSUPPORTED_MEDIA"
    assert "video-import:" not in response.text
    assert client.get(f"/sources/{source_id}/ingest-jobs").json()["total"] == 0


def test_the_source_publishes_how_its_frames_were_decomposed(
    client: TestClient, project: str
) -> None:
    """A record no client can read is a record that cannot make anything legible."""
    import_id = start(client, project, materializer="mediabunny/1.56.1").json()["id"]
    source_id = client.get(f"/video-imports/{import_id}").json()["source_id"]

    video = client.get(f"/sources/{source_id}").json()["video"]

    assert video["materializer"] == "mediabunny/1.56.1"
    assert video["policy_version"] == 1


def test_committing_twice_answers_the_same_batch(
    client: TestClient, project: str, session: str, tmp_path: Path
) -> None:
    """A client that retried a timed-out request must not get a second batch."""
    send(client, session, tmp_path, *range(EXPECTED))

    first = client.post(f"/video-imports/{session}/commit").json()
    second = client.post(f"/video-imports/{session}/commit")

    assert second.status_code == 200, second.text
    assert second.json()["id"] == first["id"]
    assert client.get(f"/projects/{project}/batches").json()["total"] == 1


def test_appending_to_a_committed_import_is_refused(
    client: TestClient, session: str, tmp_path: Path
) -> None:
    send(client, session, tmp_path, *range(EXPECTED))
    client.post(f"/video-imports/{session}/commit")

    response = send(client, session, tmp_path, 0)

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "VIDEO_IMPORT_NOT_OPEN"


def test_committing_an_unknown_import_is_404(client: TestClient) -> None:
    response = client.post(f"/video-imports/{uuid4()}/commit")

    assert response.status_code == 404
    assert response.json()["code"] == "VIDEO_IMPORT_NOT_FOUND"


# --- aborting ----------------------------------------------------------------


def test_aborting_leaves_the_project_exactly_as_it_was(
    client: TestClient, project: str, session: str, tmp_path: Path
) -> None:
    send(client, session, tmp_path, 0, 1)

    response = client.delete(f"/video-imports/{session}")

    assert response.status_code == 204, response.text
    assert client.get(f"/video-imports/{session}").json()["state"] == "aborted"
    assert client.get(f"/projects/{project}/assets").json()["total"] == 0
    assert client.get(f"/projects/{project}/batches").json()["total"] == 0


def test_aborting_twice_is_the_same_answer(client: TestClient, session: str) -> None:
    assert client.delete(f"/video-imports/{session}").status_code == 204
    assert client.delete(f"/video-imports/{session}").status_code == 204


def test_aborting_a_committed_import_is_refused(
    client: TestClient, session: str, tmp_path: Path
) -> None:
    send(client, session, tmp_path, *range(EXPECTED))
    client.post(f"/video-imports/{session}/commit")

    response = client.delete(f"/video-imports/{session}")

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "VIDEO_IMPORT_NOT_OPEN"


def test_aborting_an_unknown_import_is_404(client: TestClient) -> None:
    response = client.delete(f"/video-imports/{uuid4()}")

    assert response.status_code == 404
    assert response.json()["code"] == "VIDEO_IMPORT_NOT_FOUND"


# --- the guard ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/projects/{project}/video-imports"),
        ("GET", "/video-imports/00000000-0000-0000-0000-000000000000"),
        ("POST", "/video-imports/00000000-0000-0000-0000-000000000000/frames"),
        ("POST", "/video-imports/00000000-0000-0000-0000-000000000000/commit"),
        ("DELETE", "/video-imports/00000000-0000-0000-0000-000000000000"),
    ],
)
def test_every_video_import_route_refuses_a_request_with_no_token(
    client: TestClient, project: str, method: str, path: str
) -> None:
    response = client.request(method, path.format(project=project), headers={"Authorization": ""})

    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHORIZED"
