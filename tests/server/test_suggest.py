"""The suggest route: what it refuses, in what order, and what a suggestion looks like.

The model is a stand-in — running a real segmenter is neither a unit test nor a
thing CI should do — but everything else on the path is shipped code: the route,
the orchestration, the narrowing to what the class admits, and the error
translation.

The connection refusals deliberately send no asset at all. That is not a
shortcut: the orchestration resolves the connection *before* it looks the asset
up, precisely so somebody part-way through setting a connection up is told about
the connection rather than about an asset that was never the problem. These tests
are what holds that order in place. The bounds refusals are the one group that
needs a real asset, because a size is what they are asked against.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.fixtures.endpoint import serving_endpoint
from tests.fixtures.media import write_image
from tests.server._api import api_client
from tests.server._jobs import InlineDispatcher

from visionset.inference import suggestions as suggestions_module
from visionset.inference import weights as weights_module
from visionset.kernel.domain import (
    AssetSegmentation,
    DownloadSize,
    SegmentedMask,
)
from visionset.kernel.errors import InferenceOutOfMemory
from visionset.server.routes import inference as inference_routes

ASSET_WIDTH = 32
ASSET_HEIGHT = 24
"""What ``write_image`` makes, and therefore the frame every mask here lives in."""


@pytest.fixture(autouse=True)
def downloadable(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Let a connection genuinely reach ``ready`` without a network or the extra.

    The two seams ``test_inference`` already uses: the route's install check, and
    the one function that would touch the network. Everything between them —
    the gate, the ordering, the write that records the connection ready — is the
    shipped code, so a connection that says it is ready here got there the way a
    real one does. Without this the helper below would quietly leave every
    connection ``not_set_up`` and the happy-path tests would be passing on a
    stub that hid a 409.
    """
    monkeypatch.setattr(inference_routes, "require_local_inference", lambda: None)
    monkeypatch.setattr(weights_module, "download", lambda connection, *, into, on_bytes=None: into)
    # The third seam, and the same rule: reading a published size is a hub
    # request, so leaving it real would reach the network on a machine carrying
    # the extra and quietly not on one without it.
    monkeypatch.setattr(
        weights_module,
        "download_size",
        lambda model_id, model_revision: DownloadSize(
            model_id=model_id,
            model_revision=model_revision,
            total_bytes=4_000_000_000,
            file_count=2,
        ),
    )


@pytest.fixture()
def runner() -> InlineDispatcher:
    return InlineDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: InlineDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made


@pytest.fixture()
def project(client: TestClient) -> str:
    made = client.post("/projects", json={"name": "suggesting"})
    return str(made.json()["id"])


def a_connection(
    client: TestClient,
    *,
    kind: str = "local",
    ready: bool = True,
    endpoint_url: str | None = None,
) -> str:
    body: dict[str, Any] = (
        {
            "name": f"c-{uuid4().hex[:6]}",
            "connection_type": "local",
            "model_id": "some/segmenter",
            "model_revision": "abc123",
            "device": "cpu",
            "precision": "fp32",
        }
        if kind == "local"
        else {
            "name": f"c-{uuid4().hex[:6]}",
            "connection_type": "http",
            "model_id": "some/model",
            "model_revision": "v1",
            "endpoint_url": endpoint_url or "https://example.invalid/predict",
        }
    )
    made = client.post("/inference/connections", json=body).json()
    if kind == "local" and ready:
        queued = client.post(f"/inference/connections/{made['id']}/download")
        assert queued.status_code == 202, queued.text
        assert (
            client.get(f"/inference/connections/{made['id']}").json()["setup_state"] == "ready"
        ), "the helper must leave a connection genuinely ready, not merely asked"
    return str(made["id"])


def an_asset(
    client: TestClient,
    runner: InlineDispatcher,
    project: str,
    tmp_path: Path,
    *,
    size: tuple[int, int] = (ASSET_WIDTH, ASSET_HEIGHT),
) -> str:
    write_image(tmp_path / "one.png", size=size)
    with (tmp_path / "one.png").open("rb") as handle:
        source = client.post(
            f"/projects/{project}/sources/images",
            files=[("files", ("one.png", handle, "image/png"))],
        ).json()
    client.post(f"/sources/{source['id']}/ingest-jobs", json={})
    runner.wait()
    return str(client.get(f"/projects/{project}/assets").json()["items"][0]["id"])


def ask(
    client: TestClient,
    *,
    project: str,
    asset: str,
    connection: str,
    allowed: list[str] | None = None,
    positive: list[dict[str, float]] | None = None,
    negative: list[dict[str, float]] | None = None,
    **parameters: Any,
) -> Any:
    return client.post(
        "/inference/suggest",
        json={
            "project_id": project,
            "asset_id": asset,
            "connection_id": connection,
            # Inside the fixture asset, which ``write_image`` makes 32 by 24 —
            # a default off the picture would make every happy path here a
            # bounds refusal rather than the answer it is asserting on.
            "positive": [{"x": 16.0, "y": 12.0}] if positive is None else positive,
            "negative": negative or [],
            "allowed_geometries": ["polygon"] if allowed is None else allowed,
            **parameters,
        },
    )


def block(x0: int, y0: int, x1: int, y1: int) -> list[list[bool]]:
    """A solid rectangle of lit pixels in the fixture asset's own frame."""
    return [
        [x0 <= x <= x1 and y0 <= y <= y1 for x in range(ASSET_WIDTH)] for y in range(ASSET_HEIGHT)
    ]


#: Big enough that the half-pixel tolerance floor is not what decides the vertex
#: count. On the ordinary fixture asset every `detail` step lands on the floor
#: and answers 20 vertices, which reports a working control and a dead one
#: identically.
ROOMY = (200, 200)


def disc(radius: int = 70, frame: tuple[int, int] = ROOMY) -> list[list[bool]]:
    """A filled circle — a shape whose vertex count actually moves with `detail`."""
    width, height = frame
    cx, cy = width // 2, height // 2
    return [
        [(x - cx) ** 2 + (y - cy) ** 2 <= radius * radius for x in range(width)]
        for y in range(height)
    ]


def two_blocks() -> list[list[bool]]:
    """Two separated rectangles, so ``fragments`` has something to tell apart."""
    grid = block(2, 3, 8, 9)
    for y in range(14, 21):
        for x in range(18, 25):
            grid[y][x] = True
    return grid


def scripted(
    monkeypatch: pytest.MonkeyPatch, mask: list[list[bool]], score: float = 0.82
) -> list[Any]:
    """Install a segmenter that answers with exactly that mask.

    A mask rather than a shape, because that is where the port stops now: every
    choice about which pieces become geometry, how their gaps are closed and how
    many vertices survive is made by shipped code on this side of it, which is
    what these tests are exercising.
    """
    asked: list[Any] = []

    class Segmenter:
        model_ref = "some/segmenter@abc123"

        def segment(self, request: Any) -> Any:
            asked.append(request)
            yield AssetSegmentation(
                asset_id=request.targets[0].asset_id,
                model_ref=self.model_ref,
                segments=(SegmentedMask(mask=mask, score=score),),
            )

    class Pool:
        def get(self, connection: Any, *, workspace_root: Path) -> Any:
            return Segmenter()

    monkeypatch.setattr(suggestions_module, "resident", Pool)
    return asked


@pytest.fixture()
def answering(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    """A segmenter that answers from a script, installed where the route resolves one."""
    return scripted(monkeypatch, block(2, 3, 12, 9))


# --- refusals, and their order ------------------------------------------------


def test_an_unknown_connection_is_not_found(client: TestClient, project: str) -> None:
    answer = ask(client, project=project, asset=str(uuid4()), connection=str(uuid4()))
    assert answer.status_code == 404
    assert answer.json()["code"] == "INFERENCE_CONNECTION_NOT_FOUND"


def test_a_connection_without_weights_is_refused_with_what_to_do(
    client: TestClient, project: str
) -> None:
    """409 rather than 500: the caller changes something and resubmits."""
    connection = a_connection(client, ready=False)
    answer = ask(client, project=project, asset=str(uuid4()), connection=connection)
    assert answer.status_code == 409
    assert answer.json()["code"] == "INFERENCE_CONNECTION_NOT_SET_UP"
    assert "download_weights" in answer.json()["message"]


def test_an_http_connection_nobody_asked_is_told_to_test_its_endpoint(
    client: TestClient, project: str
) -> None:
    """409 rather than 500: a state change — asking the endpoint — makes the identical
    request succeed."""
    connection = a_connection(client, kind="http")
    answer = ask(client, project=project, asset=str(uuid4()), connection=connection)
    assert answer.status_code == 409
    assert answer.json()["code"] == "INFERENCE_CONNECTION_NOT_SET_UP"
    assert "test_endpoint" in answer.json()["message"]


def test_the_connection_is_resolved_before_the_asset(client: TestClient, project: str) -> None:
    """A connection problem and a nonexistent asset together answer about the connection.

    The order the orchestration documents, pinned: somebody part-way through
    setting a connection up should not be told their asset is missing instead.
    """
    connection = a_connection(client, ready=False)
    answer = ask(client, project=project, asset=str(uuid4()), connection=connection)
    assert answer.json()["code"] == "INFERENCE_CONNECTION_NOT_SET_UP"


def test_an_unknown_asset_is_not_found_once_the_connection_is_fine(
    client: TestClient, project: str, answering: list[Any]
) -> None:
    connection = a_connection(client)
    answer = ask(client, project=project, asset=str(uuid4()), connection=connection)
    assert answer.status_code == 404
    assert answer.json()["code"] == "ASSET_NOT_FOUND"


def test_a_gesture_with_no_positive_point_is_unprocessable(
    client: TestClient, project: str
) -> None:
    """Negatives refine an answer; they cannot be the whole of a question."""
    answer = ask(client, project=project, asset=str(uuid4()), connection=str(uuid4()), positive=[])
    assert answer.status_code == 422


def test_a_request_naming_no_geometry_kinds_is_unprocessable(
    client: TestClient, project: str
) -> None:
    answer = ask(client, project=project, asset=str(uuid4()), connection=str(uuid4()), allowed=[])
    assert answer.status_code == 422


def test_an_unknown_field_on_the_request_is_unprocessable(client: TestClient, project: str) -> None:
    """`SuggestRequest` forbids unknown fields, as every other request model does.

    A gesture is the one call a client is most likely to grow a field on — a
    threshold, a hint, a mode — and accepting one this build does not implement
    would answer 200 having ignored it.
    """
    answer = client.post(
        "/inference/suggest",
        json={
            "project_id": project,
            "asset_id": str(uuid4()),
            "connection_id": str(uuid4()),
            "positive": [{"x": 32.0, "y": 32.0}],
            "negative": [],
            "allowed_geometries": ["polygon"],
            "threshold": 0.5,
        },
    )
    assert answer.status_code == 422, answer.text


def test_an_unknown_field_on_a_point_is_unprocessable(client: TestClient, project: str) -> None:
    """`SuggestPoint` too: it is nested, and the rule is about the shape not the route."""
    answer = ask(
        client,
        project=project,
        asset=str(uuid4()),
        connection=str(uuid4()),
        positive=[{"x": 32.0, "y": 32.0, "z": 1.0}],
    )
    assert answer.status_code == 422, answer.text


# --- a point that is not on the asset -----------------------------------------
#
# The fixture asset is 32 by 24. These are the refusals the browser's own hit
# test cannot cover, because no browser is involved: a script composing
# coordinates reaches the same route.


def test_a_point_past_the_edge_is_refused_rather_than_answered(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    answer = ask(
        client,
        project=project,
        asset=asset,
        connection=connection,
        positive=[{"x": 900.0, "y": 700.0}],
    )

    assert answer.status_code == 422, answer.text
    assert answer.json()["code"] == "PROMPT_POINT_OUT_OF_BOUNDS"
    assert not answering, "the provider must never be asked about a place that is not there"


def test_the_refusal_reaches_a_scripted_caller_as_prose(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """The whole error body, as anything that is not a canvas receives it.

    A caller with no picture in front of it debugs from this sentence alone, so
    it has to carry both halves: the coordinate that was sent, and the size that
    would have accepted one.
    """
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    body = ask(
        client,
        project=project,
        asset=asset,
        connection=connection,
        positive=[{"x": 900.0, "y": 700.0}],
    ).json()

    assert body["code"] == "PROMPT_POINT_OUT_OF_BOUNDS"
    assert "900" in body["message"] and "700" in body["message"]
    assert "32" in body["message"] and "24" in body["message"]
    assert body["detail"] is None


def test_a_negative_point_off_the_asset_refuses_the_gesture(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """Checked like a positive, and it takes the whole request with it."""
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    answer = ask(
        client,
        project=project,
        asset=asset,
        connection=connection,
        positive=[{"x": 16.0, "y": 12.0}],
        negative=[{"x": -4.0, "y": 12.0}],
    )

    assert answer.json()["code"] == "PROMPT_POINT_OUT_OF_BOUNDS"
    assert not answering, "one bad point is not dropped so the rest can be answered"


def test_the_far_edge_of_the_asset_is_still_on_it(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """The inclusive boundary, over the wire, in the direction that can silently break.

    This is the half that agrees with the editor's hit test. If the server ever
    became exclusive, a press the editor allows on the last row of pixels would
    start answering 422 and the two would disagree about the same click.
    """
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    answer = ask(
        client,
        project=project,
        asset=asset,
        connection=connection,
        positive=[{"x": 32.0, "y": 24.0}],
    )

    assert answer.status_code == 200, answer.text
    assert answer.json()["regions"] != []
    assert answering[0].prompt.positive == ((32.0, 24.0),)


def test_an_unknown_asset_is_still_named_before_its_bounds_are(
    client: TestClient, project: str, answering: list[Any]
) -> None:
    """A missing asset has no size, so the 404 comes first and says so.

    The refusal order the orchestration documents, extended one step: telling a
    caller its coordinates are out of bounds on an asset that does not exist
    would be an answer about the wrong problem.
    """
    connection = a_connection(client)

    answer = ask(
        client,
        project=project,
        asset=str(uuid4()),
        connection=connection,
        positive=[{"x": 900.0, "y": 700.0}],
    )

    assert answer.status_code == 404
    assert answer.json()["code"] == "ASSET_NOT_FOUND"


# --- the answer ---------------------------------------------------------------


def test_a_click_comes_back_as_a_polygon_with_its_confidence_and_model(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    body = ask(client, project=project, asset=asset, connection=connection).json()

    assert body["model_ref"] == "some/segmenter@abc123"
    assert body["confidence"] == pytest.approx(0.82)
    (region,) = body["regions"]
    assert region["geometry"]["type"] == "polygon"
    assert region["geometry"]["points"] == [[2.0, 3.0], [12.0, 3.0], [12.0, 9.0], [2.0, 9.0]]


def test_a_tested_http_connection_suggests_through_its_endpoint(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path
) -> None:
    """The one place the whole path — route, resolution, remote runner, mask
    pipeline — is proven over a real HTTP round trip rather than a scripted pool."""
    with serving_endpoint(capability="point_suggest") as endpoint:
        connection = a_connection(client, kind="http", endpoint_url=endpoint.url)
        tested = client.post(f"/inference/connections/{connection}/test-endpoint")
        assert tested.status_code == 200, tested.text
        asset = an_asset(client, runner, project, tmp_path)

        # Inside the fixture endpoint's lit rectangle, (2, 2) to (10, 10).
        answer = ask(
            client,
            project=project,
            asset=asset,
            connection=connection,
            positive=[{"x": 5.0, "y": 5.0}],
        )
        assert answer.status_code == 200, answer.text
        body = answer.json()

    assert body["model_ref"] == "fake/remote@1"
    (region,) = body["regions"]
    assert region["geometry"]["type"] == "polygon"


def test_a_box_only_class_is_offered_the_outlines_extent(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """D3's fallback over HTTP, and the test the PR body names for the geometry mutation.

    Stop respecting ``allowed_geometries`` — return the polygon regardless — and
    this goes red while every other assertion in the file stays green, because a
    polygon is a perfectly valid answer to every *other* question asked here.
    """
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    body = ask(client, project=project, asset=asset, connection=connection, allowed=["bbox"]).json()

    (region,) = body["regions"]
    assert region["geometry"] == {
        "type": "bbox",
        "x": 2.0,
        "y": 3.0,
        "width": 11.0,
        "height": 7.0,
    }
    assert region["contour"] == [], "a box is an extent, not something reduced from a contour"


def test_a_tag_only_class_is_offered_nothing_rather_than_a_shape_it_cannot_hold(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """D3's third case. Not an error — the gesture simply has nothing to propose."""
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    body = ask(
        client,
        project=project,
        asset=asset,
        connection=connection,
        allowed=["classification_tag"],
    ).json()

    assert body["regions"] == []
    assert body["model_ref"] == "some/segmenter@abc123", "still says who was asked"


def test_negative_points_travel_to_the_provider(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    ask(
        client,
        project=project,
        asset=asset,
        connection=connection,
        positive=[{"x": 1.0, "y": 2.0}],
        negative=[{"x": 3.0, "y": 4.0}],
    )

    prompt = answering[0].prompt
    assert prompt.positive == ((1.0, 2.0),)
    assert prompt.negative == ((3.0, 4.0),)


def test_the_provider_is_handed_bytes_rather_than_a_path(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """The port's dual test, observed end to end: a hosted provider shares no filesystem."""
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    ask(client, project=project, asset=asset, connection=connection)

    (target,) = answering[0].targets
    assert isinstance(target.content, bytes) and target.content[:4] == b"\x89PNG"
    assert target.media_type == "image/png"


def test_nothing_is_written_by_asking(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """A suggestion is a proposal. Accepting it is a separate, ordinary annotation write."""
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)
    before = client.get(f"/projects/{project}/assets/{asset}").json()

    ask(client, project=project, asset=asset, connection=connection)

    assert client.get(f"/projects/{project}/assets/{asset}").json() == before


# --- the parameters, and what the answer declares about them -------------------


def test_a_request_that_sends_no_parameters_gets_the_defaults_back(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """Every parameter is optional, and the answer says what it was actually given.

    A client that sent nothing still has to be able to render the controls at
    their current positions, which is what makes ``applied`` worth carrying
    rather than leaving the caller to remember what it omitted.
    """
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    body = ask(client, project=project, asset=asset, connection=connection).json()

    assert body["applied"] == {"detail": "balanced"}


def test_the_answer_echoes_the_parameters_it_was_given(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    body = ask(
        client,
        project=project,
        asset=asset,
        connection=connection,
        detail="fine",
    ).json()

    assert body["applied"] == {"detail": "fine"}


def test_a_polygon_class_is_told_the_one_parameter_applies(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    body = ask(client, project=project, asset=asset, connection=connection).json()

    assert body["parameters"] == ["detail"]


def test_a_box_class_is_told_nothing_applies(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """What the editor renders on a box class, and the whole of why it renders it.

    A client works none of this out: an empty list is what tells it to render no
    adjustments at all. Remove `detail` from the polygon row of
    `PARAMETER_APPLIES_TO` and the assertion above goes red; declare it for a box
    and this one does.
    """
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    body = ask(client, project=project, asset=asset, connection=connection, allowed=["bbox"]).json()

    assert body["parameters"] == []


def test_an_answer_with_nothing_in_it_still_carries_its_controls(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """The way back out of an empty result.

    A caller that adjusted its way into nothing must not lose the controls that
    would undo the adjustment, so `parameters` is read from what was asked for
    rather than from what came back.
    """
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    body = ask(client, project=project, asset=asset, connection=connection).json()
    empty = ask(
        client,
        project=project,
        asset=asset,
        connection=connection,
        allowed=["classification_tag"],
    ).json()

    assert body["parameters"] != []
    assert empty["regions"] == []
    assert empty["parameters"] == [], "a tag class has no shape to adjust in the first place"


def test_a_polygon_carries_the_contour_it_was_reduced_from(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """What lets the editor re-run `detail` locally instead of asking again."""
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    (region,) = ask(client, project=project, asset=asset, connection=connection).json()["regions"]

    assert len(region["contour"]) >= len(region["geometry"]["points"])
    assert region["contour"][0] == [2.0, 3.0], "the traced boundary, in the asset's own pixels"


def test_a_coarser_setting_comes_back_with_no_more_vertices(
    client: TestClient,
    runner: InlineDispatcher,
    project: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`detail` reaching the shape at all, over HTTP.

    A disc rather than the rectangle the other tests use: a rectangle is four
    corners at every setting, so it would report a working control and a dead one
    identically.
    """
    scripted(monkeypatch, disc())
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path, size=ROOMY)

    counts = [
        len(
            ask(client, project=project, asset=asset, connection=connection, detail=step).json()[
                "regions"
            ][0]["geometry"]["points"]
        )
        for step in ("coarse", "balanced", "fine")
    ]
    assert counts[0] < counts[1] < counts[2], counts


def test_a_split_mask_is_one_polygon_and_one_union_box(
    client: TestClient,
    runner: InlineDispatcher,
    project: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Decision 4 over HTTP: a click asks about one object, however it arrived.

    A polygon class gets the piece under the click; a box class gets one box over
    both, because a mask in two pieces is nearly always one object seen around an
    occlusion.
    """
    scripted(monkeypatch, two_blocks())
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    outlined = ask(client, project=project, asset=asset, connection=connection).json()
    boxed = ask(
        client, project=project, asset=asset, connection=connection, allowed=["bbox"]
    ).json()

    assert len(outlined["regions"]) == 1
    assert len(boxed["regions"]) == 1
    box = boxed["regions"][0]["geometry"]
    outline = outlined["regions"][0]["geometry"]["points"]
    assert box["width"] > max(x for x, _ in outline) - min(x for x, _ in outline), (
        "the box spans both pieces, so it is wider than the piece the outline traced"
    )


def test_a_setting_the_request_no_longer_takes_is_refused(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """`extra="forbid"`, doing the work of the deprecation nobody has to write.

    A client still sending the two settings that came out (#557) is told plainly
    rather than having them silently ignored.
    """
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    assert (
        ask(client, project=project, asset=asset, connection=connection, fill_holes=0.5).status_code
        == 422
    )
    assert (
        ask(
            client, project=project, asset=asset, connection=connection, fragments="all"
        ).status_code
        == 422
    )


def test_a_detail_step_the_vocabulary_does_not_have_is_refused(
    client: TestClient, runner: InlineDispatcher, project: str, tmp_path: Path, answering: list[Any]
) -> None:
    """A closed vocabulary, refused by the schema rather than silently defaulted."""
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)

    answer = ask(client, project=project, asset=asset, connection=connection, detail="sharpest")

    assert answer.status_code == 422


# --- when the machine cannot carry it ----------------------------------------


def starving(monkeypatch: pytest.MonkeyPatch, failure: Exception) -> None:
    """Install a segmenter that dies of ``failure`` when it is asked.

    Built against ``PointSegmenter.segment`` rather than from memory, and the
    positive path of the same double is what every other test in this file
    exercises — so a fake that raises on entry cannot make an absence assertion
    here pass vacuously.
    """

    class Starved:
        model_ref = "facebook/sam3@3c879f3"

        def segment(self, request: Any) -> Any:
            raise failure

    class Pool:
        def get(self, connection: Any, *, workspace_root: Path) -> Any:
            return Starved()

    monkeypatch.setattr(suggestions_module, "resident", Pool)


def test_a_device_that_ran_out_of_memory_is_answered_with_what_to_do(
    client: TestClient,
    runner: InlineDispatcher,
    project: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The whole point of the refusal: a sentence somebody can act on.

    A person who meets this can pick a smaller model, move the connection to the
    CPU, or free the device — and none of those is reachable from an opaque 500
    naming an incident id.
    """
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)
    starving(
        monkeypatch,
        InferenceOutOfMemory(
            "running facebook/sam3@3c879f3 on cuda ran out of memory. Choose a smaller "
            "model, set this connection's device to 'cpu', or free cuda and try again."
        ),
    )

    answer = ask(client, project=project, asset=asset, connection=connection)
    body = answer.json()

    assert answer.status_code == 500
    assert body["code"] == "INFERENCE_OUT_OF_MEMORY"
    assert "smaller model" in body["message"]
    assert "cuda" in body["message"]
    # `expose_message` chooses which message is published; it never suppresses
    # `detail`, so a 5xx stays tracked in the log under the same id. What the
    # refusal must not do is make somebody read that id instead of the remedy.
    assert "incident" not in body["message"].casefold()
    assert "Traceback" not in body["message"]
    assert body["detail"]["incident_id"], "a 5xx stays traceable in the log"


def test_a_failure_that_is_not_an_allocation_failure_is_not_dressed_up_as_one(
    client: TestClient,
    runner: InlineDispatcher,
    project: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The other half of the contract, and the reason the rule is narrow.

    A defect reaches the boundary as itself and is answered as an internal error
    with an incident id — which ``tests/server/test_errors.py`` proves is what
    the boundary does with one. What is proved here is that nothing on the way
    quietly renamed it "out of memory".
    """
    connection = a_connection(client)
    asset = an_asset(client, runner, project, tmp_path)
    starving(monkeypatch, RuntimeError("expected scalar type Half but found Float"))

    with pytest.raises(RuntimeError, match="scalar type"):
        ask(client, project=project, asset=asset, connection=connection)
