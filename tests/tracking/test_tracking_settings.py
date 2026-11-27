"""Configuration, the no-op tracker, and what may cross a process boundary."""

from __future__ import annotations

import json
import multiprocessing
import pickle
import sys

import pytest
from tests.fixtures.mlflow_server import without_mlflow

from visionset.kernel.errors import TrackingUnavailable
from visionset.tracking import (
    NoOpTracker,
    RunStatus,
    Tracker,
    TrackingSettings,
    build_tracker,
    load_tracking_settings,
)

_SECRETS = {
    "MLFLOW_TRACKING_URI": "https://tracking.internal.example:8443/secret-path",
    "MLFLOW_TRACKING_USERNAME": "user-name-secret",
    "MLFLOW_TRACKING_PASSWORD": "password-secret",
    "MLFLOW_TRACKING_TOKEN": "token-secret",
}


def test_tracking_is_off_by_default() -> None:
    settings = load_tracking_settings()

    assert settings.mlflow_enabled is False
    assert settings.mlflow_experiment == "visionset"
    assert isinstance(build_tracker(settings), NoOpTracker)


def test_a_tracking_uri_alone_never_turns_tracking_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://127.0.0.1:5000")

    assert isinstance(build_tracker(load_tracking_settings()), NoOpTracker)


def test_the_no_op_tracker_records_nothing_and_satisfies_the_interface() -> None:
    tracker = NoOpTracker()

    assert isinstance(tracker, Tracker)
    run_id = tracker.start_run("export", tags={"k": "v"})
    assert run_id is None
    tracker.log_params(run_id, {"a": 1})
    tracker.log_metrics(run_id, {"m": 1.0}, step=2)
    tracker.set_tags(run_id, {"k": "v"})
    tracker.end_run(run_id, RunStatus.FAILED)


@pytest.mark.parametrize("value", ["maybe", "2", "enabled"])
def test_an_unparseable_enabled_flag_is_refused_by_name(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", value)

    with pytest.raises(TrackingUnavailable, match="VISIONSET_MLFLOW_ENABLED"):
        load_tracking_settings()


def test_the_refusal_names_the_flag_in_one_grammatical_sentence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "maybe")
    monkeypatch.setenv("VISIONSET_MLFLOW_EXPERIMENT", "x" * 600)

    with pytest.raises(TrackingUnavailable) as raised:
        load_tracking_settings()

    assert str(raised.value).startswith("VISIONSET_MLFLOW_ENABLED is not a valid value.")
    assert "EXPERIMENT" not in str(raised.value)


@pytest.mark.parametrize("value", ["", "   "])
def test_a_blank_enabled_flag_is_off(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", value)
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://127.0.0.1:5000")

    settings = load_tracking_settings()

    assert settings.mlflow_enabled is False
    assert isinstance(build_tracker(settings), NoOpTracker)


@pytest.mark.parametrize("experiment", ["", "  ", "x" * 600])
def test_the_experiment_is_not_checked_while_tracking_is_off(
    monkeypatch: pytest.MonkeyPatch, experiment: str
) -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_EXPERIMENT", experiment)

    assert isinstance(build_tracker(load_tracking_settings()), NoOpTracker)


def test_enabled_with_an_over_long_experiment_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")
    monkeypatch.setenv("VISIONSET_MLFLOW_EXPERIMENT", "x" * 501)

    with pytest.raises(TrackingUnavailable, match="1 to 500 characters"):
        load_tracking_settings()


@pytest.mark.parametrize(
    "uri",
    ["https://tracking.example/mlflow?token=abc123", "https://tracking.example/#abc123"],
)
def test_a_uri_carrying_a_query_or_fragment_is_refused_without_echoing_it(
    monkeypatch: pytest.MonkeyPatch, uri: str
) -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")
    monkeypatch.setenv("MLFLOW_TRACKING_URI", uri)

    with pytest.raises(TrackingUnavailable, match="MLFLOW_TRACKING_TOKEN") as raised:
        build_tracker(load_tracking_settings())

    assert "abc123" not in str(raised.value)
    assert "tracking.example" not in str(raised.value)


def test_enabled_with_an_empty_experiment_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")
    monkeypatch.setenv("VISIONSET_MLFLOW_EXPERIMENT", "  ")

    with pytest.raises(TrackingUnavailable, match="VISIONSET_MLFLOW_EXPERIMENT"):
        load_tracking_settings()


def test_enabled_without_a_tracking_uri_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")

    with pytest.raises(TrackingUnavailable, match="MLFLOW_TRACKING_URI is not set"):
        build_tracker(load_tracking_settings())


def test_a_uri_carrying_credentials_is_refused_without_echoing_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "https://alice:hunter2@tracking.example")

    with pytest.raises(TrackingUnavailable) as raised:
        build_tracker(load_tracking_settings())

    message = str(raised.value)
    assert "MLFLOW_TRACKING_PASSWORD" in message
    for leaked in ("alice", "hunter2", "tracking.example"):
        assert leaked not in message


def test_a_missing_client_is_refused_with_the_install_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://127.0.0.1:5000")
    for name in ("mlflow", "mlflow.tracking", "mlflow.entities"):
        monkeypatch.setitem(sys.modules, name, None)

    with pytest.raises(TrackingUnavailable) as raised:
        build_tracker(load_tracking_settings())

    assert 'pip install "visionset[mlflow]"' in str(raised.value)
    assert "127.0.0.1" not in str(raised.value)


@without_mlflow
def test_a_base_install_refuses_enabled_tracking_with_the_install_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "1")
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "http://127.0.0.1:5000")

    with pytest.raises(TrackingUnavailable, match=r"visionset\[mlflow\]"):
        build_tracker(load_tracking_settings())


def test_the_settings_carry_no_uri_and_no_credential(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")
    monkeypatch.setenv("VISIONSET_MLFLOW_EXPERIMENT", "datasets")
    for name, value in _SECRETS.items():
        monkeypatch.setenv(name, value)

    settings = load_tracking_settings()
    dumped = settings.model_dump(mode="json")
    rendered = [json.dumps(dumped), repr(settings), str(settings), pickle.dumps(settings).hex()]

    assert dumped == {"mlflow_enabled": True, "mlflow_experiment": "datasets"}
    for text in rendered:
        for secret in _SECRETS.values():
            assert secret not in text
            assert secret.encode().hex() not in text
    assert TrackingSettings(**dumped) == settings


def _tracker_kind(payload: dict[str, object]) -> tuple[str, bool]:
    tracker = build_tracker(TrackingSettings(**payload))
    return type(tracker).__name__, "mlflow" in sys.modules


def test_a_spawned_worker_rebuilds_its_tracker_from_the_payload() -> None:
    payload = TrackingSettings(mlflow_enabled=False).model_dump(mode="json")

    with multiprocessing.get_context("spawn").Pool(1) as pool:
        kind, imported_mlflow = pool.apply(_tracker_kind, (payload,))

    assert (kind, imported_mlflow) == ("NoOpTracker", False)
