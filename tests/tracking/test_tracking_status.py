"""The tracking status: facts about the configuration, and never one of its values."""

from __future__ import annotations

import pytest
from tests.fixtures.mlflow_server import MLFLOW_INSTALLED, without_mlflow

from visionset.kernel.domain import TrackingAuth, TrackingServer
from visionset.tracking import tracking_status
from visionset.tracking.status import CA_BUNDLE_VARIABLE, CLIENT_CERTIFICATE_VARIABLE


@pytest.fixture(autouse=True)
def no_certificates(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (CA_BUNDLE_VARIABLE, CLIENT_CERTIFICATE_VARIABLE):
        monkeypatch.delenv(name, raising=False)


def _enable(monkeypatch: pytest.MonkeyPatch, uri: str = "http://127.0.0.1:5000") -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")
    monkeypatch.setenv("MLFLOW_TRACKING_URI", uri)


def test_tracking_is_reported_off_by_default() -> None:
    status = tracking_status()

    assert status.enabled is False
    assert (status.experiment, status.server, status.auth, status.problem) == (
        None,
        None,
        None,
        None,
    )
    assert status.client_installed is MLFLOW_INSTALLED


def test_with_tracking_off_nothing_else_is_read(monkeypatch: pytest.MonkeyPatch) -> None:
    """A URI and a token set for some other tool are not VisionSet's to report."""
    monkeypatch.setenv("MLFLOW_TRACKING_URI", "https://other-tool.example")
    monkeypatch.setenv("MLFLOW_TRACKING_TOKEN", "token")
    monkeypatch.setenv(CA_BUNDLE_VARIABLE, "/etc/ca.pem")

    status = tracking_status()

    assert (status.server, status.auth, status.ca_bundle_configured) == (None, None, False)


def test_an_unreadable_flag_reports_off_with_the_refusal(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "maybe")

    status = tracking_status()

    assert status.enabled is False
    assert status.problem is not None
    assert "VISIONSET_MLFLOW_ENABLED" in status.problem


def test_the_server_is_scheme_host_and_port_only(monkeypatch: pytest.MonkeyPatch) -> None:
    _enable(monkeypatch, "HTTPS://Tracking.Example:8443/base/path")
    monkeypatch.setenv("VISIONSET_MLFLOW_EXPERIMENT", "roads")

    status = tracking_status()

    assert status.enabled is True
    assert status.experiment == "roads"
    assert status.server == TrackingServer(scheme="https", host="tracking.example", port=8443)


def test_a_local_store_reports_its_scheme_and_no_path(monkeypatch: pytest.MonkeyPatch) -> None:
    _enable(monkeypatch, "sqlite:///home/someone/mlflow.db")

    assert tracking_status().server == TrackingServer(scheme="sqlite", host=None, port=None)


@pytest.mark.parametrize("uri", ["/home/someone/mlruns", "http://host:notaport"])
def test_an_address_with_no_scheme_or_a_bad_port_reports_no_server(
    monkeypatch: pytest.MonkeyPatch, uri: str
) -> None:
    _enable(monkeypatch, uri)

    assert tracking_status().server is None


def test_a_uri_carrying_credentials_reports_the_host_and_the_refusal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable(monkeypatch, "https://someone:hunter2@tracking.example/path")

    status = tracking_status()

    assert status.server == TrackingServer(scheme="https", host="tracking.example", port=None)
    assert status.problem is not None
    assert "carries credentials" in status.problem
    assert "hunter2" not in status.model_dump_json()
    assert "someone" not in status.model_dump_json()


def test_enabled_without_a_uri_reports_the_refusal(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VISIONSET_MLFLOW_ENABLED", "true")

    status = tracking_status()

    assert status.server is None
    assert status.problem is not None
    assert "MLFLOW_TRACKING_URI is not set" in status.problem


def test_an_over_long_experiment_reports_the_refusal_and_no_experiment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable(monkeypatch)
    monkeypatch.setenv("VISIONSET_MLFLOW_EXPERIMENT", "x" * 501)

    status = tracking_status()

    assert status.experiment is None
    assert status.problem is not None
    assert "VISIONSET_MLFLOW_EXPERIMENT" in status.problem


@without_mlflow
def test_a_missing_client_is_the_refusal_once_the_uri_is_good(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable(monkeypatch)

    status = tracking_status()

    assert status.client_installed is False
    assert status.problem is not None
    assert 'pip install "visionset[mlflow]"' in status.problem


@pytest.mark.parametrize(
    ("variables", "auth"),
    [
        ({}, TrackingAuth.NONE),
        ({"MLFLOW_TRACKING_USERNAME": "u", "MLFLOW_TRACKING_PASSWORD": "p"}, TrackingAuth.BASIC),
        ({"MLFLOW_TRACKING_USERNAME": "u"}, TrackingAuth.NONE),
        ({"MLFLOW_TRACKING_TOKEN": "t"}, TrackingAuth.TOKEN),
        (
            {
                "MLFLOW_TRACKING_USERNAME": "u",
                "MLFLOW_TRACKING_PASSWORD": "p",
                "MLFLOW_TRACKING_TOKEN": "t",
            },
            TrackingAuth.BASIC,
        ),
        ({"MLFLOW_TRACKING_TOKEN": "  "}, TrackingAuth.NONE),
        ({CLIENT_CERTIFICATE_VARIABLE: "/c.pem"}, TrackingAuth.CLIENT_CERTIFICATE),
        (
            {"MLFLOW_TRACKING_TOKEN": "t", CLIENT_CERTIFICATE_VARIABLE: "/c.pem"},
            TrackingAuth.TOKEN,
        ),
    ],
)
def test_the_auth_mode_follows_mlflows_precedence(
    monkeypatch: pytest.MonkeyPatch, variables: dict[str, str], auth: TrackingAuth
) -> None:
    _enable(monkeypatch)
    for name, value in variables.items():
        monkeypatch.setenv(name, value)

    assert tracking_status().auth is auth


def test_certificates_are_reported_as_configured_never_by_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable(monkeypatch)
    monkeypatch.setenv(CA_BUNDLE_VARIABLE, "/etc/ssl/company-ca.pem")
    monkeypatch.setenv(CLIENT_CERTIFICATE_VARIABLE, "/etc/ssl/client.pem")

    status = tracking_status()

    assert (status.ca_bundle_configured, status.client_certificate_configured) == (True, True)
    assert "/etc/ssl" not in status.model_dump_json()
