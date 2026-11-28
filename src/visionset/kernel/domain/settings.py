# usage: from visionset.kernel.domain import WorkspaceSettings
"""What a process is configured with, as every surface publishes it.

The shape only. The kernel reads no environment variable, so these are built
below the surfaces and outside the kernel (``visionset.jobs.settings``), and the
three surfaces serialize the same object. Nothing here holds a secret: tracking
is described by booleans and enumerations, and the tracking server by its
scheme, host and port alone.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict


class TrackingAuth(StrEnum):
    """Which authentication the MLflow client would send, in MLflow's own precedence."""

    NONE = "none"
    BASIC = "basic"
    TOKEN = "token"
    CLIENT_CERTIFICATE = "client_certificate"


class TrackingServer(BaseModel):
    """Where tracking points: never the URI's userinfo, path, query or fragment."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    scheme: str
    host: str | None
    port: int | None


class TrackingStatus(BaseModel):
    """Whether tracking is on, and what it would need to run.

    With tracking off nothing but the flag is read, so ``experiment``, ``server``
    and ``auth`` are ``None`` and both certificate flags are false. ``problem``
    is the refusal a run would meet, worded as its remedy.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    enabled: bool
    experiment: str | None
    server: TrackingServer | None
    auth: TrackingAuth | None
    ca_bundle_configured: bool
    client_certificate_configured: bool
    client_installed: bool
    problem: str | None


class ExecutorVariable(BaseModel):
    """One executor knob: the variable that sets it, its value here, and its default."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    value: int | float | None
    default: int | float


class ExecutorStatus(BaseModel):
    """How the job executor is tuned. Values are ``None`` when ``problem`` is set."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    variables: tuple[ExecutorVariable, ...]
    problem: str | None


class WorkspaceSettings(BaseModel):
    """The read-only settings of the process answering, from the environment it started with."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    version: str
    tracking: TrackingStatus
    executor: ExecutorStatus
