# usage: uv run pytest tests/inference/test_http_provider.py
"""The http driver against a real endpoint: what it sends, what it reads back,
and the one sentence every failure becomes."""

from __future__ import annotations

import base64
import time
from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest
from tests.fixtures.endpoint import closed_port, mask_png, serving_endpoint
from tests.fixtures.media import write_image

from visionset.inference import http_provider
from visionset.inference.http_provider import (
    HTTP_PROVIDER_ID,
    MAX_RESPONSE_BYTES,
    HttpProvider,
    RemoteDetector,
    RemoteSegmenter,
    ask_endpoint,
    describe,
)
from visionset.kernel.domain import (
    BboxGeometry,
    ConnectionType,
    InferenceConnection,
    PointPrompt,
    PredictionRequest,
    PredictionTarget,
    TextPrompt,
)
from visionset.kernel.errors import (
    InferenceConnectionNotTestable,
    InferenceEndpointUnavailable,
    UnsupportedPrompt,
)
from visionset.kernel.ports import ModelProvider, PointSegmenter, Provider, WeightsSource
from visionset.kernel.services import InferenceConnectionService, WorkspaceService


@pytest.fixture()
def workspace(tmp_path: Path) -> Iterator[WorkspaceService]:
    made = WorkspaceService.init(tmp_path / "ws", name="http")
    try:
        yield made
    finally:
        made.close()


def hosted(url: str, **overrides: object) -> InferenceConnection:
    fields: dict[str, object] = {
        "name": "hosted",
        "connection_type": ConnectionType.HTTP,
        "model_id": "acme/model",
        "model_revision": "v1",
        "endpoint_url": url,
    }
    return InferenceConnection(**(fields | overrides))  # type: ignore[arg-type]


def a_request(
    tmp_path: Path,
    prompt: PointPrompt | TextPrompt,
    *,
    targets: int = 1,
    minimum_confidence: float = 0.0,
) -> PredictionRequest:
    content = write_image(tmp_path / "t.png", size=(20, 16)).read_bytes()
    return PredictionRequest(
        targets=tuple(
            PredictionTarget(asset_id=uuid4(), content=content, media_type="image/png")
            for _ in range(targets)
        ),
        prompt=prompt,
        minimum_confidence=minimum_confidence,
    )


POINTS = PointPrompt(positive=((3.0, 3.0),))
WORDS = TextPrompt(phrases=("cat",))


# --- what the driver declares --------------------------------------------------


def test_the_driver_serves_both_capabilities_and_fetches_nothing() -> None:
    driver = HttpProvider()
    assert isinstance(driver, Provider)
    assert not isinstance(driver, WeightsSource)
    assert set(driver.families) == {"point_suggest", "text_detect"}
    assert driver.curated == ()


def test_build_picks_the_port_the_family_implies(tmp_path: Path) -> None:
    driver = HttpProvider()
    connection = hosted("http://127.0.0.1:9/predict")
    assert isinstance(
        driver.build(connection, family="point_suggest", workspace_root=tmp_path), PointSegmenter
    )
    assert isinstance(
        driver.build(connection, family="text_detect", workspace_root=tmp_path), ModelProvider
    )


# --- describe ---------------------------------------------------------------


def test_describe_reads_the_endpoint_declaration() -> None:
    with serving_endpoint(capability="text_detect", model_ref="acme/detector@9") as endpoint:
        answer = describe(hosted(endpoint.url))
    assert (answer.model_ref, answer.capability) == ("acme/detector@9", "text_detect")


@pytest.mark.parametrize(
    ("tweak", "said"),
    [
        ({"describe_status": 500}, "answered 500"),
        ({"describe_body": "not json"}, "not JSON"),
        ({"describe_body": {"capability": "point_suggest"}}, "model_ref"),
        ({"describe_body": {"model_ref": "x", "capability": ""}}, "capability"),
    ],
    ids=["a 500", "not json", "no model_ref", "blank capability"],
)
def test_a_describe_outside_the_contract_names_the_endpoint_and_the_failure(
    tweak: dict[str, object], said: str
) -> None:
    with serving_endpoint() as endpoint:
        for field, value in tweak.items():
            setattr(endpoint, field, value)
        with pytest.raises(InferenceEndpointUnavailable) as refused:
            describe(hosted(endpoint.url))
    assert endpoint.url in str(refused.value)
    assert said in str(refused.value)


def test_an_endpoint_nothing_listens_on_is_unreachable_not_a_traceback() -> None:
    url = closed_port()
    with pytest.raises(InferenceEndpointUnavailable, match="could not be reached") as refused:
        describe(hosted(url))
    assert url in str(refused.value)


def test_an_unparseable_ipv6_url_is_unreachable_not_a_traceback() -> None:
    url = "http://[::1"
    with pytest.raises(InferenceEndpointUnavailable, match="could not be reached") as refused:
        describe(hosted(url))
    assert url in str(refused.value)


def test_a_stalled_error_body_times_out_rather_than_hanging(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(http_provider, "DESCRIBE_TIMEOUT", 0.5)
    with serving_endpoint() as endpoint:
        endpoint.describe_status = 500
        endpoint.stall_error_body = True
        started = time.monotonic()
        with pytest.raises(InferenceEndpointUnavailable, match="answered 500") as refused:
            describe(hosted(endpoint.url))
        elapsed = time.monotonic() - started
    assert endpoint.url in str(refused.value)
    assert elapsed < 1.5


def test_a_response_over_the_ceiling_is_refused_not_buffered_whole() -> None:
    with serving_endpoint() as endpoint:
        endpoint.describe_body = "x" * (MAX_RESPONSE_BYTES + 10)
        with pytest.raises(InferenceEndpointUnavailable, match="more than") as refused:
            describe(hosted(endpoint.url))
    assert endpoint.url in str(refused.value)


def test_only_http_and_https_are_ever_opened() -> None:
    with pytest.raises(InferenceEndpointUnavailable, match="http or https"):
        describe(hosted("file:///etc/hosts"))


def test_a_redirect_to_a_foreign_scheme_is_refused_not_followed() -> None:
    """A followed redirect would try to open the ftp URL and fail there
    instead — "answered 302" is only true of the refusal, before anything
    followed it."""
    with serving_endpoint() as endpoint:
        endpoint.describe_status = 302
        endpoint.describe_location = "ftp://127.0.0.1/x"
        with pytest.raises(InferenceEndpointUnavailable, match="answered 302") as refused:
            describe(hosted(endpoint.url))
    assert endpoint.url in str(refused.value)


def test_a_body_shorter_than_its_declared_length_is_one_sentence_not_a_traceback() -> None:
    with serving_endpoint() as endpoint:
        endpoint.truncate_body = True
        with pytest.raises(InferenceEndpointUnavailable) as refused:
            describe(hosted(endpoint.url))
    assert endpoint.url in str(refused.value)


# --- predict ----------------------------------------------------------------


def test_a_text_prompt_comes_back_as_regions_in_the_domain_vocabulary(tmp_path: Path) -> None:
    with serving_endpoint(capability="text_detect") as endpoint:
        runner = RemoteDetector(hosted(endpoint.url))
        request = a_request(tmp_path, WORDS)
        (answer,) = list(runner.predict(request))
        sent = endpoint.requests[0]
    assert answer.asset_id == request.targets[0].asset_id
    assert answer.model_ref == "fake/remote@1"
    assert answer.regions[0].label == "cat"
    assert isinstance(answer.regions[0].geometry, BboxGeometry)
    assert sent["prompt"] == {"kind": "text", "phrases": ["cat"]}
    assert sent["minimum_confidence"] == 0.0
    assert base64.b64decode(sent["targets"][0]["content"]) == request.targets[0].content
    assert sent["targets"][0]["media_type"] == "image/png"


def test_a_below_threshold_region_is_dropped_and_an_at_or_above_one_kept(tmp_path: Path) -> None:
    """The fixture answers one region at confidence 0.8: a threshold above it
    drops it, and a threshold at or below it keeps it."""
    with serving_endpoint(capability="text_detect") as endpoint:
        runner = RemoteDetector(hosted(endpoint.url))
        (dropped,) = list(runner.predict(a_request(tmp_path, WORDS, minimum_confidence=0.85)))
        (kept,) = list(runner.predict(a_request(tmp_path, WORDS, minimum_confidence=0.8)))
    assert dropped.regions == ()
    assert len(kept.regions) == 1


def test_a_point_prompt_comes_back_as_a_mask_of_zeros_and_ones(tmp_path: Path) -> None:
    with serving_endpoint() as endpoint:
        runner = RemoteSegmenter(hosted(endpoint.url))
        request = a_request(tmp_path, POINTS)
        (answer,) = list(runner.segment(request))
    (segment,) = answer.segments
    rows = segment.mask
    assert len(rows) == 16 and all(len(row) == 20 for row in rows)
    assert segment.score == 0.9
    # The fixture lights (2,2)-(10,10): a lit pixel is exactly 1, a dark one 0.
    assert rows[3][3] == 1 and rows[0][0] == 0
    assert rows[3].index(True) == 2, "the pipeline scans with index(True), so lit must be 1"


def test_a_below_threshold_segment_is_dropped_and_an_at_or_above_one_kept(tmp_path: Path) -> None:
    """The fixture answers one segment at score 0.9: a threshold above it drops
    it, and a threshold at or below it keeps it."""
    with serving_endpoint() as endpoint:
        runner = RemoteSegmenter(hosted(endpoint.url))
        (dropped,) = list(runner.segment(a_request(tmp_path, POINTS, minimum_confidence=0.95)))
        (kept,) = list(runner.segment(a_request(tmp_path, POINTS, minimum_confidence=0.9)))
    assert dropped.segments == ()
    assert len(kept.segments) == 1


def test_answers_are_yielded_in_target_order_whatever_order_they_arrived(tmp_path: Path) -> None:
    with serving_endpoint(capability="text_detect") as endpoint:
        runner = RemoteDetector(hosted(endpoint.url))
        request = a_request(tmp_path, WORDS, targets=3)
        ids = [str(target.asset_id) for target in request.targets]
        endpoint.predict_body = {
            "answers": [
                {"asset_id": asset_id, "model_ref": "r", "regions": []}
                for asset_id in reversed(ids)
            ]
        }
        answers = list(runner.predict(request))
    assert [str(answer.asset_id) for answer in answers] == ids


@pytest.mark.parametrize(
    ("body", "said"),
    [
        ({"answers": []}, "0 of 2"),
        (
            {
                "answers": [
                    {
                        "asset_id": "00000000-0000-0000-0000-000000000000",
                        "model_ref": "r",
                        "regions": [],
                    }
                ]
                * 2
            },
            "targets it was not asked about",
        ),
        ({"nope": []}, "answers"),
        ({"answers": [{"asset_id": "x"}]}, "cannot read"),
    ],
    ids=["too few", "wrong ids", "no answers key", "unreadable answer"],
)
def test_an_answer_outside_the_contract_is_one_sentence_naming_the_endpoint(
    tmp_path: Path, body: dict[str, object], said: str
) -> None:
    with serving_endpoint(capability="text_detect") as endpoint:
        endpoint.predict_body = body
        runner = RemoteDetector(hosted(endpoint.url))
        with pytest.raises(InferenceEndpointUnavailable) as refused:
            list(runner.predict(a_request(tmp_path, WORDS, targets=2)))
    assert endpoint.url in str(refused.value)
    assert said in str(refused.value)


def test_a_mask_of_the_wrong_size_is_refused(tmp_path: Path) -> None:
    with serving_endpoint() as endpoint:
        runner = RemoteSegmenter(hosted(endpoint.url))
        request = a_request(tmp_path, POINTS)
        endpoint.predict_body = {
            "answers": [
                {
                    "asset_id": str(request.targets[0].asset_id),
                    "model_ref": "r",
                    "segments": [{"score": 0.5, "mask": mask_png(5, 5, lit=(0, 0, 2, 2))}],
                }
            ]
        }
        with pytest.raises(InferenceEndpointUnavailable, match="20 by 16"):
            list(runner.segment(request))


def test_a_mask_that_is_not_base64_is_refused(tmp_path: Path) -> None:
    with serving_endpoint() as endpoint:
        runner = RemoteSegmenter(hosted(endpoint.url))
        request = a_request(tmp_path, POINTS)
        endpoint.predict_body = {
            "answers": [
                {
                    "asset_id": str(request.targets[0].asset_id),
                    "model_ref": "r",
                    "segments": [{"score": 0.5, "mask": "not base64"}],
                }
            ]
        }
        with pytest.raises(InferenceEndpointUnavailable, match="cannot decode"):
            list(runner.segment(request))


def test_the_wrong_prompt_kind_is_refused_here_and_never_sent(tmp_path: Path) -> None:
    with serving_endpoint() as endpoint:
        segmenter = RemoteSegmenter(hosted(endpoint.url))
        detector = RemoteDetector(hosted(endpoint.url))
        with pytest.raises(UnsupportedPrompt, match="point prompts"):
            list(segmenter.segment(a_request(tmp_path, WORDS)))
        with pytest.raises(UnsupportedPrompt, match="text prompts"):
            list(detector.predict(a_request(tmp_path, POINTS)))
        assert endpoint.requests == []


def test_a_runner_says_what_is_configured_until_an_answer_says_what_ran() -> None:
    runner = RemoteSegmenter(hosted("http://127.0.0.1:9/predict"))
    assert runner.model_ref == "acme/model@v1"


# --- the credential: read from the environment, sent as a bearer token -----------


def test_the_credential_travels_as_a_bearer_token_on_both_verbs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ACME_TOKEN", "s3cret")
    with serving_endpoint() as endpoint:
        connection = hosted(endpoint.url, credential_env="ACME_TOKEN")
        describe(connection)
        list(RemoteSegmenter(connection).segment(a_request(tmp_path, POINTS)))
        assert endpoint.authorizations == ["Bearer s3cret", "Bearer s3cret"]


def test_a_connection_naming_no_variable_sends_no_authorization() -> None:
    with serving_endpoint() as endpoint:
        describe(hosted(endpoint.url))
        assert endpoint.authorizations == [None]


@pytest.mark.parametrize("value", [None, ""], ids=["unset", "empty"])
def test_a_variable_nobody_set_is_refused_before_any_request_is_made(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, value: str | None
) -> None:
    """The remedy is in the environment, not at the endpoint, and the message
    says which variable — a request sent without the credential would be
    refused by the other end with a status that names nothing."""
    if value is None:
        monkeypatch.delenv("ACME_TOKEN", raising=False)
    else:
        monkeypatch.setenv("ACME_TOKEN", value)
    with serving_endpoint() as endpoint:
        connection = hosted(endpoint.url, credential_env="ACME_TOKEN")
        with pytest.raises(InferenceEndpointUnavailable, match="ACME_TOKEN"):
            describe(connection)
        with pytest.raises(InferenceEndpointUnavailable, match="ACME_TOKEN"):
            list(RemoteDetector(connection).predict(a_request(tmp_path, WORDS)))
        assert endpoint.authorizations == []


# --- test_endpoint: asking and recording -----------------------------------------


def test_asking_records_the_capability_and_the_driver(workspace: WorkspaceService) -> None:
    connections = InferenceConnectionService(workspace)
    with serving_endpoint(capability="point_suggest") as endpoint:
        made = connections.create(
            "hosted",
            connection_type=ConnectionType.HTTP,
            model_id="acme/model",
            model_revision="v1",
            endpoint_url=endpoint.url,
        )
        answered = ask_endpoint(workspace, made.id)
    assert (answered.model_family, answered.provider_id) == ("point_suggest", HTTP_PROVIDER_ID)


def test_asking_keeps_a_driver_the_row_already_named(workspace: WorkspaceService) -> None:
    connections = InferenceConnectionService(workspace)
    with serving_endpoint(capability="text_detect") as endpoint:
        made = connections.create(
            "hosted",
            connection_type=ConnectionType.HTTP,
            model_id="acme/model",
            model_revision="v1",
            endpoint_url=endpoint.url,
            provider_id="acme-hosted",
        )
        answered = ask_endpoint(workspace, made.id)
    assert (answered.model_family, answered.provider_id) == ("text_detect", "acme-hosted")


def test_a_capability_this_build_does_not_know_is_refused_and_nothing_is_recorded(
    workspace: WorkspaceService,
) -> None:
    connections = InferenceConnectionService(workspace)
    with serving_endpoint(capability="telepathy") as endpoint:
        made = connections.create(
            "hosted",
            connection_type=ConnectionType.HTTP,
            model_id="acme/model",
            model_revision="v1",
            endpoint_url=endpoint.url,
        )
        with pytest.raises(InferenceEndpointUnavailable, match="telepathy"):
            ask_endpoint(workspace, made.id)
    again = connections.get(made.id)
    assert (again.model_family, again.provider_id) == (None, None)


def test_a_local_connection_has_no_endpoint_to_ask(workspace: WorkspaceService) -> None:
    connections = InferenceConnectionService(workspace)
    made = connections.create(
        "local",
        connection_type=ConnectionType.LOCAL,
        model_id="acme/model",
        model_revision="v1",
        device="cpu",
        precision="fp32",
    )
    with pytest.raises(InferenceConnectionNotTestable):
        ask_endpoint(workspace, made.id)
