"""What the two narrowing refusals publish, and what the preview publishes first.

The pair is the point. `DESTRUCTIVE_SCHEMA_CHANGE` is retryable with a flag and
`SCHEMA_CHANGE_WOULD_ORPHAN` is retryable with nothing at all, they share a
status, and before this the only thing telling them apart was `code` — with the
*actionable* half of each buried in a sentence whose own field description says
the wording is not part of the contract.

So every test here asserts structure rather than prose, and the last of them
asserts the structure a client gets **before** the attempt is the structure it
gets from the refusal, because one shape serving both is the whole design.
"""

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from tests.server._api import api_client
from tests.server._flow import a_box, asset_ids, batch_from_ingest
from tests.server._jobs import InlineDispatcher


@pytest.fixture()
def runner() -> InlineDispatcher:
    return InlineDispatcher()


@pytest.fixture()
def client(tmp_path: Path, runner: InlineDispatcher) -> Iterator[TestClient]:
    with api_client(tmp_path / "ws", dispatcher=runner) as made:
        yield made


def a_class(name: str = "sign", **overrides: Any) -> dict[str, Any]:
    return {"name": name, "geometries": ["bbox"], **overrides}


#: `sign` exactly as the fixture declares it, attribute included. Re-sending it
#: unchanged is what makes a proposal narrow *only* `lane` — dropping the
#: attribute would make `sign` destructive too, which is correct and is not the
#: thing these tests are measuring.
SIGN = a_class("sign", attributes=[{"name": "occluded", "kind": "boolean", "required": True}])


def post_version(client: TestClient, project: str, *classes: dict[str, Any], **query: Any) -> Any:
    return client.post(
        f"/projects/{project}/schema/versions", json={"classes": list(classes)}, params=query
    )


def preview(client: TestClient, project: str, *classes: dict[str, Any]) -> Any:
    return client.post(f"/projects/{project}/schema/preview", json={"classes": list(classes)})


@pytest.fixture()
def project(client: TestClient) -> str:
    """A project on version 1, declaring `sign` and `lane`. Nothing labeled yet."""
    project_id: str = client.post("/projects", json={"name": "road-signs"}).json()["id"]
    response = post_version(client, project_id, SIGN, a_class("lane"))
    assert response.status_code == 201, response.text
    return project_id


@pytest.fixture()
def labeled(client: TestClient, runner: InlineDispatcher, tmp_path: Path, project: str) -> str:
    """The same project, with three `sign` labels drawn across two assets.

    Real annotations through the real routes rather than rows planted underneath,
    because the counts are what these tests are about and a planted row would let
    a broken walk agree with a broken fixture.

    **Three over two, deliberately.** Every number this fixture feeds — frames,
    annotations, and a frame's own blocking classes — has to differ from the
    others, or a report that returned the wrong one of them agrees with every
    assertion. The first asset carries two boxes for exactly that reason.
    """
    batch_id = batch_from_ingest(client, runner, tmp_path, project, images=2)
    client.post(f"/batches/{batch_id}/approve")
    client.post(f"/batches/{batch_id}/start")
    job_id: str = client.get(f"/batches/{batch_id}/jobs").json()["items"][0]["id"]
    client.post(f"/jobs/{job_id}/start")
    first, second = asset_ids(client, batch_id)
    response = client.post(
        f"/jobs/{job_id}/annotations",
        json=[
            a_box(first),
            a_box(
                first, geometry={"type": "bbox", "x": 5.0, "y": 6.0, "width": 7.0, "height": 8.0}
            ),
            a_box(second),
        ],
    )
    assert response.status_code == 201, response.text
    return project


# --- the refusals carry their report ------------------------------------------


def test_a_narrowing_refusal_names_the_classes_it_would_remove(
    client: TestClient, project: str
) -> None:
    """The blast radius, as data. A confirmation dialog cannot count a sentence."""
    response = post_version(client, project, SIGN)

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "DESTRUCTIVE_SCHEMA_CHANGE"
    assert body["detail"] == {"classes": ["lane"]}


def test_an_orphan_refusal_carries_a_count_per_class(client: TestClient, labeled: str) -> None:
    """Both numbers, because "12 labels" and "12 labels across 2 images" differ."""
    response = post_version(client, labeled, a_class("lane"), allow_destructive=True)

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == "SCHEMA_CHANGE_WOULD_ORPHAN"
    assert body["detail"] == {"blockers": [{"label_class": "sign", "annotations": 3, "assets": 2}]}


def test_the_orphan_refusal_does_not_put_the_project_id_in_its_sentence(
    client: TestClient, labeled: str
) -> None:
    """It was there, and a UUID in prose is unreadable at a terminal and in a dialog.

    The caller already holds the id — it is in the URL it just called — so the
    message spends its length on what is wrong instead.
    """
    response = post_version(client, labeled, a_class("lane"), allow_destructive=True)

    assert labeled not in response.json()["message"]


@pytest.mark.parametrize("allow_destructive", [True, False])
def test_the_flag_never_gets_a_labeled_class_removed(
    client: TestClient, labeled: str, allow_destructive: bool
) -> None:
    """Pinning the audit's Q2 finding as a contract rather than an observation.

    With the flag the refusal is the orphan one; without it, the flag refusal
    fires first. Neither publishes anything — which is the half worth asserting,
    because a client that read only the status would see 409 twice and could not
    tell that one of them has no way forward.
    """
    response = post_version(client, labeled, a_class("lane"), allow_destructive=allow_destructive)

    assert response.status_code == 409
    expected = "SCHEMA_CHANGE_WOULD_ORPHAN" if allow_destructive else "DESTRUCTIVE_SCHEMA_CHANGE"
    assert response.json()["code"] == expected
    assert client.get(f"/projects/{labeled}/schema").json()["version"] == 1


# --- the preview says it first ------------------------------------------------


def test_a_preview_writes_nothing(client: TestClient, project: str) -> None:
    response = preview(client, project, SIGN)

    assert response.status_code == 200
    assert client.get(f"/projects/{project}/schema").json()["version"] == 1
    assert client.get(f"/projects/{project}/schema/versions").json()["total"] == 1


def test_a_preview_separates_needs_a_flag_from_no_flag_will_help(
    client: TestClient, project: str
) -> None:
    """Destructive and publishable — the case `is_destructive` alone cannot name."""
    body = preview(client, project, SIGN).json()

    assert body["diff"]["is_destructive"] is True
    assert body["diff"]["destructive_classes"] == ["lane"]
    assert body["is_refused"] is False
    assert body["blockers"] == []


def test_a_preview_of_an_additive_change_is_refused_by_nothing(
    client: TestClient, labeled: str
) -> None:
    body = preview(client, labeled, SIGN, a_class("lane"), a_class("pole")).json()

    assert body["diff"]["is_destructive"] is False
    assert body["is_refused"] is False
    assert body["blockers"] == []


def test_a_preview_and_the_refusal_report_the_same_blockers(
    client: TestClient, labeled: str
) -> None:
    """The contract this whole change exists for.

    A client renders the warning and the refusal with one piece of code, so the
    two must not be able to disagree about the same project. Asserted as equality
    of the structures rather than of two hand-written literals: a shape that
    drifted on one side and not the other fails here and nowhere else.
    """
    previewed = preview(client, labeled, a_class("lane")).json()
    refused = post_version(client, labeled, a_class("lane"), allow_destructive=True).json()

    assert previewed["is_refused"] is True
    assert refused["code"] == "SCHEMA_CHANGE_WOULD_ORPHAN"
    assert previewed["blockers"] == refused["detail"]["blockers"]


def test_a_preview_of_an_unknown_project_is_404(client: TestClient) -> None:
    response = preview(client, "0f4f0f8e-0000-4000-8000-000000000000", a_class("sign"))

    assert response.status_code == 404
    assert response.json()["code"] == "PROJECT_NOT_FOUND"


# --- the listing behind the counts --------------------------------------------


def blocking_assets(
    client: TestClient, project: str, *classes: dict[str, Any], **query: Any
) -> Any:
    return client.post(
        f"/projects/{project}/schema/blocking-assets",
        json={"classes": list(classes)},
        params=query,
    )


def test_the_listing_and_the_preview_count_the_same_frames(
    client: TestClient, labeled: str
) -> None:
    """One walk, two questions — the listing cannot outgrow the count.

    The annotation totals are compared across every class, which is exact; the
    frame count is compared against the one blocking class this fixture has,
    because summing `assets` over classes would count a frame blocking under two
    of them twice and the listing deliberately carries it once.
    """
    previewed = preview(client, labeled, a_class("lane")).json()
    listed = blocking_assets(client, labeled, a_class("lane")).json()

    assert [count["label_class"] for count in previewed["blockers"]] == ["sign"]
    assert listed["total"] == previewed["blockers"][0]["assets"]
    assert sum(item["annotations"] for item in listed["items"]) == sum(
        count["annotations"] for count in previewed["blockers"]
    )


def test_a_blocking_frame_names_the_batches_holding_it(client: TestClient, labeled: str) -> None:
    """Keyed by asset rather than by position: the listing promises no order."""
    batch_id = client.get(f"/projects/{labeled}/batches").json()["items"][0]["id"]
    doubled, single = asset_ids(client, batch_id)
    listed = blocking_assets(client, labeled, a_class("lane")).json()

    by_asset = {item["asset"]["id"]: item for item in listed["items"]}
    assert by_asset[doubled]["batch_ids"] == [batch_id]
    assert by_asset[doubled]["label_classes"] == ["sign"]
    # `annotations` is what the change would orphan *on this frame* — not how
    # many blocking classes it carries, and not how many frames are in the way.
    # Two here and one there is what tells those three numbers apart.
    assert by_asset[doubled]["annotations"] == 2
    assert by_asset[single]["annotations"] == 1


def test_a_blocking_frame_does_not_publish_its_path(client: TestClient, labeled: str) -> None:
    """`AssetOut` withholds `uri`, and a listing is how that has leaked before.

    The whole item, not only its `asset`: a `uri` hung on `BlockingAssetOut`
    itself would be the same leak one level up.
    """
    listed = blocking_assets(client, labeled, a_class("lane")).json()

    assert "uri" not in str(listed["items"][0])


def test_an_additive_change_blocks_on_nothing(client: TestClient, labeled: str) -> None:
    listed = blocking_assets(client, labeled, SIGN, a_class("lane"), a_class("pole")).json()

    assert listed == {"items": [], "total": 0}


def test_the_listing_windows_without_moving_its_total(client: TestClient, labeled: str) -> None:
    """`total` is what matched, never the page."""
    listed = blocking_assets(client, labeled, a_class("lane"), limit=1, offset=0).json()

    assert len(listed["items"]) == 1
    assert listed["total"] == 2


def test_a_listing_for_an_unknown_project_is_404(client: TestClient) -> None:
    response = blocking_assets(client, "0f4f0f8e-0000-4000-8000-000000000000", a_class("sign"))

    assert response.status_code == 404
    assert response.json()["code"] == "PROJECT_NOT_FOUND"
