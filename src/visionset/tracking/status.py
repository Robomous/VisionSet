# usage: from visionset.tracking import tracking_status
"""Tracking as a reader may see it: facts about the configuration, never its values.

Built from the same checks a run meets — :func:`load_tracking_settings`,
:func:`tracking_uri` and the client lookup — so the status and the refusal cannot
disagree. Credentials are reported only as which mode is configured, and the
tracking URI only as its scheme, host and port.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Final
from urllib.parse import urlsplit

from pydantic import ValidationError

from visionset.kernel.domain import TrackingAuth, TrackingServer, TrackingStatus
from visionset.kernel.errors import TrackingUnavailable
from visionset.tracking._mlflow import (
    URI_VARIABLE,
    client_installed,
    not_installed,
    tracking_uri,
)
from visionset.tracking.settings import TrackingSettings, load_tracking_settings

USERNAME_VARIABLE: Final = "MLFLOW_TRACKING_USERNAME"
PASSWORD_VARIABLE: Final = "MLFLOW_TRACKING_PASSWORD"
TOKEN_VARIABLE: Final = "MLFLOW_TRACKING_TOKEN"
CA_BUNDLE_VARIABLE: Final = "MLFLOW_TRACKING_SERVER_CERT_PATH"
CLIENT_CERTIFICATE_VARIABLE: Final = "MLFLOW_TRACKING_CLIENT_CERT_PATH"


def _configured(name: str) -> bool:
    return bool(os.environ.get(name, "").strip())


def _refusal(check: Callable[[], object]) -> str | None:
    try:
        check()
    except TrackingUnavailable as exc:
        return str(exc)
    return None


def _enabled() -> bool:
    try:
        return TrackingSettings().mlflow_enabled
    except ValidationError:
        return False


def _server() -> TrackingServer | None:
    uri = os.environ.get(URI_VARIABLE, "").strip()
    try:
        parts = urlsplit(uri)
        port = parts.port
    except ValueError:
        return None
    if not parts.scheme:
        return None
    return TrackingServer(scheme=parts.scheme.lower(), host=parts.hostname, port=port)


def _auth() -> TrackingAuth:
    if _configured(USERNAME_VARIABLE) and _configured(PASSWORD_VARIABLE):
        return TrackingAuth.BASIC
    if _configured(TOKEN_VARIABLE):
        return TrackingAuth.TOKEN
    if _configured(CLIENT_CERTIFICATE_VARIABLE):
        return TrackingAuth.CLIENT_CERTIFICATE
    return TrackingAuth.NONE


def tracking_status() -> TrackingStatus:
    """This process's tracking configuration, with no secret in it.

    With tracking off, nothing but the flag is read — the rule a run follows —
    so a tracking URI set for some other tool is not reported.
    """
    installed = client_installed()
    settings_problem = _refusal(load_tracking_settings)
    if not _enabled():
        return TrackingStatus(
            enabled=False,
            experiment=None,
            server=None,
            auth=None,
            ca_bundle_configured=False,
            client_certificate_configured=False,
            client_installed=installed,
            problem=settings_problem,
        )
    problem = (
        settings_problem or _refusal(tracking_uri) or (None if installed else str(not_installed()))
    )
    experiment = None if settings_problem else TrackingSettings().mlflow_experiment
    return TrackingStatus(
        enabled=True,
        experiment=experiment,
        server=_server(),
        auth=_auth(),
        ca_bundle_configured=_configured(CA_BUNDLE_VARIABLE),
        client_certificate_configured=_configured(CLIENT_CERTIFICATE_VARIABLE),
        client_installed=installed,
        problem=problem,
    )
