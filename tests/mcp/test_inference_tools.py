"""Model-connection tools: an agent makes a workspace auto-label-ready.

The SDK-first claim of the Inference section (#421), at its third surface. Every
rung is reached by calling tools over the real protocol, never by reaching past
them into the SDK — the SDK appears only to read state back.

The network is stubbed where the CLI's own suite stubs it, at the same seams:
``weights_module.download`` under a real ``fetch_weights``, and the importing
module's bound ``check_integrity`` name — so the resolution, the gates and the
projections are the shipped code and only the gigabytes are not.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from tests.fixtures.local_inference import without_the_extra
from tests.mcp._flow import call, call_destructive, error, payload, workspace

from visionset.inference import weights as weights_module
from visionset.inference.integrity import IntegrityReport
from visionset.kernel.domain import DownloadSize
from visionset.kernel.errors import WeightsDamaged
from visionset.kernel.services import (
    WORKSPACE_ENV_VAR,
    InferenceConnectionService,
    WorkspaceService,
)
from visionset.mcp import inference as mcp_inference

LOCAL: dict[str, Any] = {
    "name": "local-gd",
    "connection_type": "local",
    "model_id": "some/model",
    "model_revision": "abc123",
    "device": "cpu",
    "precision": "fp32",
}

HTTP: dict[str, Any] = {
    "name": "remote",
    "connection_type": "http",
    "model_id": "some/model",
    "model_revision": "abc123",
    "endpoint_url": "https://example.invalid/predict",
}


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results."""
    monkeypatch.setenv(WORKSPACE_ENV_VAR, "")


@pytest.fixture()
def root(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    return workspace(monkeypatch, tmp_path)


@pytest.fixture()
def fetched(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[str]:
    """Record what would have been downloaded, and download nothing.

    The CLI suite's fixture, verbatim in spirit: patched at
    ``visionset.inference.weights.download``, the module global ``fetch_weights``
    calls, so the gate above it and the write below it are the shipped code.
    """
    seen: list[str] = []

    def _download(connection: Any, *, into: Path, on_bytes: Any = None) -> Path:
        seen.append(f"{connection.model_id}@{connection.model_revision}")
        return tmp_path / "snapshot"

    monkeypatch.setattr(weights_module, "download", _download)
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
    return seen


# --- create -------------------------------------------------------------------


def test_create_records_the_driver_an_agent_names(root: Path) -> None:
    """An agent reads `list_providers` and hands back a `provider_id` from it, so
    the tool surface configures a connection as completely as the form does."""
    document = payload(call("create_inference_connection", **LOCAL, provider_id="sam"))
    assert document["provider_id"] == "sam"


def test_create_answers_the_connection_document(root: Path) -> None:
    document = payload(call("create_inference_connection", **LOCAL))
    assert document["name"] == "local-gd"
    assert document["connection_type"] == "local"
    assert document["setup_state"] == "not_set_up"
    assert "download_weights" in document["allowed_actions"]


def test_an_http_connection_is_born_ready(root: Path) -> None:
    # No weights of its own, so there is nothing to set up — and no
    # `download_weights` in its actions, because the offer would be one the
    # kernel refuses.
    document = payload(call("create_inference_connection", **HTTP))
    assert document["setup_state"] == "ready"
    assert "download_weights" not in document["allowed_actions"]


def test_a_taken_name_is_a_refusal_not_a_protocol_error(root: Path) -> None:
    payload(call("create_inference_connection", **LOCAL))
    refusal = error(call("create_inference_connection", **LOCAL))
    assert "local-gd" in refusal["message"]


def test_parameters_that_do_not_match_the_kind_are_refused(root: Path) -> None:
    refusal = error(call("create_inference_connection", **{**LOCAL, "endpoint_url": "https://x"}))
    assert refusal["message"]


# --- list, which is also get --------------------------------------------------


def test_an_empty_workspace_lists_an_empty_page(root: Path) -> None:
    assert payload(call("list_inference_connections")) == {"items": [], "total": 0}


def test_the_listing_carries_the_whole_document(root: Path) -> None:
    """`get` folded into `list`: the page row is the same projection `create` answers."""
    created = payload(call("create_inference_connection", **LOCAL))
    page = payload(call("list_inference_connections"))
    assert page["total"] == 1
    (row,) = page["items"]
    assert row == created


# --- update -------------------------------------------------------------------


def test_update_renames_and_answers_the_edited_document(root: Path) -> None:
    payload(call("create_inference_connection", **LOCAL))
    edited = payload(call("update_inference_connection", connection="local-gd", name="gd"))
    assert edited["name"] == "gd"
    assert [row["name"] for row in payload(call("list_inference_connections"))["items"]] == ["gd"]


def test_update_resolves_by_id_as_well_as_by_name(root: Path) -> None:
    created = payload(call("create_inference_connection", **LOCAL))
    edited = payload(call("update_inference_connection", connection=created["id"], name="gd"))
    assert edited["id"] == created["id"]


def test_updating_an_unknown_connection_is_a_refusal(root: Path) -> None:
    refusal = error(call("update_inference_connection", connection="nothing-here", name="x"))
    assert "nothing-here" in refusal["message"]


# --- download -----------------------------------------------------------------


def test_download_fetches_and_answers_the_ready_connection(root: Path, fetched: list[str]) -> None:
    payload(call("create_inference_connection", **LOCAL))
    document = payload(call("download_connection_weights", connection="local-gd"))
    assert document["setup_state"] == "ready"
    assert fetched == ["some/model@abc123"]


def test_downloading_an_http_connection_is_a_refusal(root: Path, fetched: list[str]) -> None:
    payload(call("create_inference_connection", **HTTP))
    refusal = error(call("download_connection_weights", connection="remote"))
    assert "runs elsewhere" in refusal["message"] or "no weights" in refusal["message"]
    assert fetched == []


def test_downloading_an_unknown_connection_is_a_refusal(root: Path, fetched: list[str]) -> None:
    refusal = error(call("download_connection_weights", connection="nothing-here"))
    assert refusal["message"]
    assert fetched == []


@without_the_extra
def test_a_missing_local_runtime_refuses_with_the_install_command(root: Path) -> None:
    """Unstubbed: the `ImportError` deep inside a package becomes one envelope."""
    payload(call("create_inference_connection", **LOCAL))
    refusal = error(call("download_connection_weights", connection="local-gd"))
    assert 'pip install "visionset[local-inference]"' in refusal["message"]


# --- size, the one tool here that reads no workspace --------------------------


class _Sibling:
    def __init__(self, rfilename: str, size: int) -> None:
        self.rfilename = rfilename
        self.size = size


class _Listing:
    """A hub that lists files and fails the test if asked to fetch one."""

    siblings = [_Sibling("config.json", 24), _Sibling("model.safetensors", 1_000)]

    @classmethod
    def model_info(cls, _repo_id: str, **_: object) -> type[_Listing]:
        return cls

    @staticmethod
    def snapshot_download(**_: object) -> str:
        raise AssertionError("reading a size must not download anything")


def test_the_size_tool_reads_a_listing_and_downloads_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No workspace fixture on purpose: the tool must not open one to answer."""
    monkeypatch.setattr(weights_module, "imported", lambda _name: _Listing)
    weights_module.known_sizes().clear()
    document = payload(call("model_download_size", model_id="some/model", model_revision="abc123"))
    assert document == {
        "model_id": "some/model",
        "model_revision": "abc123",
        "total_bytes": 1_024,
        "file_count": 2,
    }


@without_the_extra
def test_a_size_without_the_runtime_refuses_with_the_install_command() -> None:
    weights_module.known_sizes().clear()
    refusal = error(call("model_download_size", model_id="some/model", model_revision="abc123"))
    assert 'pip install "visionset[local-inference]"' in refusal["message"]


# --- check integrity ----------------------------------------------------------


@pytest.fixture()
def checked(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Answer the check as intact, patched at the name this surface bound at import."""
    seen: list[str] = []

    def _check(workspace: Any, connection_id: Any, **_: Any) -> IntegrityReport:
        seen.append(str(connection_id))
        return IntegrityReport(files_checked=4, bytes_read=2048)

    monkeypatch.setattr(mcp_inference, "check_integrity", _check)
    return seen


def test_check_integrity_answers_what_the_job_result_carries(
    root: Path, fetched: list[str], checked: list[str]
) -> None:
    """One projection, two surfaces: the keys agree because both call ``counts``."""
    payload(call("create_inference_connection", **LOCAL))
    payload(call("download_connection_weights", connection="local-gd"))
    assert payload(call("check_connection_integrity", connection="local-gd")) == {
        "files_checked": 4,
        "bytes_read": 2048,
    }
    assert len(checked) == 1


def test_check_integrity_refuses_a_connection_with_nothing_to_read(root: Path) -> None:
    """Unstubbed: the gate lives inside ``check_integrity`` and reaches no network."""
    payload(call("create_inference_connection", **LOCAL))
    refusal = error(call("check_connection_integrity", connection="local-gd"))
    assert "download them first" in refusal["message"]


def test_check_integrity_reports_damage_in_the_envelope(
    root: Path, fetched: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    def _damaged(workspace: Any, connection_id: Any, **_: Any) -> IntegrityReport:
        raise WeightsDamaged("1 file does not match (model.safetensors)")

    monkeypatch.setattr(mcp_inference, "check_integrity", _damaged)
    payload(call("create_inference_connection", **LOCAL))
    payload(call("download_connection_weights", connection="local-gd"))
    refusal = error(call("check_connection_integrity", connection="local-gd"))
    assert "model.safetensors" in refusal["message"]


# --- delete, offered only on request ------------------------------------------


def _stored(root: Path) -> list[str]:
    with WorkspaceService.open(root) as service:
        return [one.name for one in InferenceConnectionService(service).list()]


def test_delete_without_confirm_changes_nothing_and_names_the_remedy(root: Path) -> None:
    payload(call("create_inference_connection", **LOCAL))
    refusal = error(call_destructive("delete_inference_connection", connection="local-gd"))
    assert refusal["retry_with"] == "confirm"
    assert "provenance" in refusal["message"]
    assert _stored(root) == ["local-gd"]


def test_delete_with_confirm_removes_the_configuration(root: Path) -> None:
    payload(call("create_inference_connection", **LOCAL))
    answered = payload(
        call_destructive("delete_inference_connection", connection="local-gd", confirm=True)
    )
    assert answered["deleted"]["name"] == "local-gd"
    assert _stored(root) == []


def test_deleting_an_unknown_connection_is_a_refusal_with_or_without_confirm(
    root: Path,
) -> None:
    for confirm in (False, True):
        refusal = error(
            call_destructive("delete_inference_connection", connection="ghost", confirm=confirm)
        )
        assert "ghost" in refusal["message"]
