"""``visionset inference`` — configuring where a model runs, from a terminal.

The SDK-first claim for this slice: a workspace can be made ready for
auto-labeling without a browser. Every rung here is reached by running commands,
never by calling the SDK — the SDK appears only to read state back.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from click.testing import Result
from tests.cli._flow import ok, payload, run, runner, workspace
from tests.fixtures.local_inference import without_the_extra

from visionset.cli import inference as cli_inference
from visionset.cli.main import app
from visionset.inference import weights as weights_module
from visionset.inference.integrity import IntegrityReport
from visionset.kernel.errors import WeightsDamaged
from visionset.kernel.services import (
    WORKSPACE_ENV_VAR,
    InferenceConnectionService,
    WorkspaceService,
)

LOCAL = (
    "inference",
    "create",
    "local-gd",
    "--type",
    "local",
    "--model",
    "some/model",
    "--revision",
    "abc123",
    "--device",
    "cpu",
    "--precision",
    "fp32",
)

HTTP = (
    "inference",
    "create",
    "remote",
    "--type",
    "http",
    "--model",
    "some/model",
    "--revision",
    "abc123",
    "--endpoint",
    "https://example.invalid/predict",
)


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer with ``VISIONSET_WORKSPACE`` exported gets CI's results."""
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    return workspace(tmp_path)


def _stored(root: Path) -> list[str]:
    with WorkspaceService.open(root) as service:
        return [one.name for one in InferenceConnectionService(service).list()]


# --- create -------------------------------------------------------------------


def test_create_writes_the_connection(root: Path) -> None:
    ok(root, *LOCAL)
    assert _stored(root) == ["local-gd"]


def test_the_new_id_is_the_only_thing_on_stdout(root: Path) -> None:
    result = run(root, *LOCAL)
    assert result.stdout.strip().count("\n") == 0
    assert "Created local connection" in result.stderr


def test_parameters_that_do_not_match_the_kind_exit_one(root: Path) -> None:
    result = run(
        root, "inference", "create", "x", "--type", "local", "--model", "m", "--revision", "r"
    )
    assert result.exit_code == 1, result.output
    assert result.stdout == ""
    assert "Error:" in result.stderr


def test_a_blank_name_exits_one(root: Path) -> None:
    result = run(
        root,
        "inference",
        "create",
        "   ",
        "--type",
        "http",
        "--model",
        "m",
        "--revision",
        "r",
        "--endpoint",
        "https://example.invalid",
    )
    assert result.exit_code == 1, result.output
    assert "Error:" in result.stderr


def test_a_taken_name_exits_one(root: Path) -> None:
    """Case-insensitively, which is the half a naive uniqueness check misses."""
    ok(root, *LOCAL)
    result = run(
        root,
        "inference",
        "create",
        "LOCAL-GD",
        "--type",
        "http",
        "--model",
        "m",
        "--revision",
        "r",
        "--endpoint",
        "https://example.invalid",
    )
    assert result.exit_code == 1, result.output
    assert "already exists" in result.stderr


# --- list ---------------------------------------------------------------------


def test_list_leads_with_the_id(root: Path) -> None:
    created = ok(root, *LOCAL)
    rows = ok(root, "inference", "list").splitlines()
    assert rows[0].split() == ["ID", "NAME", "TYPE", "MODEL", "SETUP"]
    assert rows[1].split()[0] == created


def test_an_empty_listing_still_prints_its_header(root: Path) -> None:
    result = run(root, "inference", "list")
    assert result.stdout.splitlines() == ["ID  NAME  TYPE  MODEL  SETUP"]
    assert "No inference connections" in result.stderr


def test_list_json_is_the_envelope(root: Path) -> None:
    ok(root, *LOCAL)
    ok(root, *HTTP)
    document = payload(root, "inference", "list")
    assert set(document) == {"items", "total"}
    assert document["total"] == 2
    assert [one["name"] for one in document["items"]] == ["local-gd", "remote"]


def test_json_puts_nothing_on_stdout_but_the_document(root: Path) -> None:
    result = run(root, *LOCAL, "--json")
    json.loads(result.stdout)
    assert result.stderr == ""


# --- show ---------------------------------------------------------------------


def test_show_resolves_by_name_or_by_id(root: Path) -> None:
    created = ok(root, *LOCAL)
    assert payload(root, "inference", "show", "local-gd")["id"] == created
    assert payload(root, "inference", "show", created)["name"] == "local-gd"


def test_show_declares_what_this_slice_can_perform(root: Path) -> None:
    """The declaration reaches the terminal, identical to the REST answer."""
    ok(root, *LOCAL)
    assert payload(root, "inference", "show", "local-gd")["allowed_actions"] == [
        "download_weights",
        "update",
        "delete",
    ]
    ok(root, *HTTP)
    assert payload(root, "inference", "show", "remote")["allowed_actions"] == [
        "update",
        "delete",
    ]


def test_an_unknown_connection_exits_one(root: Path) -> None:
    result = run(root, "inference", "show", "nothing-here")
    assert result.exit_code == 1, result.output
    assert "Error:" in result.stderr


# --- update -------------------------------------------------------------------


def test_update_changes_only_what_is_named(root: Path) -> None:
    ok(root, *LOCAL, "--json")
    ok(root, "inference", "update", "local-gd", "--revision", "deadbeef")
    shown = payload(root, "inference", "show", "local-gd")
    assert shown["model_revision"] == "deadbeef"
    assert shown["device"] == "cpu"
    assert shown["model_id"] == "some/model"


def test_an_edit_the_kind_refuses_exits_one(root: Path) -> None:
    ok(root, *LOCAL)
    result = run(root, "inference", "update", "local-gd", "--endpoint", "https://example.invalid")
    assert result.exit_code == 1, result.output
    assert "Error:" in result.stderr


# --- delete -------------------------------------------------------------------


def test_delete_removes_it(root: Path) -> None:
    ok(root, *LOCAL)
    ok(root, "inference", "delete", "local-gd", "--yes")
    assert _stored(root) == []


def test_delete_says_what_survives(root: Path) -> None:
    """The blast radius is stated where somebody is about to act on it."""
    ok(root, *LOCAL)
    result = run(root, "inference", "delete", "local-gd", "--yes")
    assert "Deleted connection" in result.stderr


def test_declining_the_prompt_keeps_the_connection(root: Path) -> None:
    ok(root, *LOCAL)
    result = run(root, "inference", "delete", "local-gd")
    assert result.exit_code != 0
    assert _stored(root) == ["local-gd"]


# --- download -----------------------------------------------------------------


@pytest.fixture()
def fetched(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[str]:
    """Record what would have been downloaded, and download nothing.

    Patched at ``visionset.inference.weights.download``, the module global
    ``fetch_weights`` calls, so the gate above it and the write below it are the
    shipped code. The command itself is invoked for real.
    """
    seen: list[str] = []

    def _download(connection: Any, *, into: Path) -> Path:
        seen.append(f"{connection.model_id}@{connection.model_revision}")
        return tmp_path / "snapshot"

    monkeypatch.setattr(weights_module, "download", _download)
    return seen


def test_download_fetches_and_marks_the_connection_ready(root: Path, fetched: list[str]) -> None:
    """The whole command, end to end, through the argv a person types."""
    ok(root, *LOCAL)
    assert ok(root, "inference", "download", "local-gd")
    assert fetched == ["some/model@abc123"]
    assert payload(root, "inference", "show", "local-gd")["setup_state"] == "ready"


def test_download_says_what_it_is_doing_on_stderr(root: Path, fetched: list[str]) -> None:
    """`ingest`'s pattern: it blocks, so it narrates rather than going quiet.

    stdout carries the id alone, which is the one-datum rule every command here
    keeps — so `$(visionset inference download ...)` is a connection id and not a
    paragraph.
    """
    ok(root, *LOCAL)
    result = run(root, "inference", "download", "local-gd")
    assert result.exit_code == 0, result.output
    assert "fetching some/model at abc123" in result.stderr
    assert "is ready" in result.stderr
    assert result.stdout.strip().count("\n") == 0


def test_download_resolves_by_name_or_by_id(root: Path, fetched: list[str]) -> None:
    created = ok(root, *LOCAL)
    assert ok(root, "inference", "download", created).strip() == created


def test_download_prints_the_connection_as_json(root: Path, fetched: list[str]) -> None:
    """The same document `show` prints, so a script reads one shape."""
    ok(root, *LOCAL)
    document = payload(root, "inference", "download", "local-gd")
    assert document["setup_state"] == "ready"
    assert document["allowed_actions"] == [
        "download_weights",
        "check_integrity",
        "update",
        "delete",
    ]


def test_downloading_twice_verifies_rather_than_refusing(root: Path, fetched: list[str]) -> None:
    """The second run checks the cache it already filled, and says so.

    The command that fetches is the command that checks, because the work is the
    same work: a snapshot already on disk is found rather than transferred
    again, and only what is missing moves.
    """
    ok(root, *LOCAL)
    ok(root, "inference", "download", "local-gd")

    result = run(root, "inference", "download", "local-gd")
    assert result.exit_code == 0, result.output
    assert "is ready" in result.stderr
    assert fetched == ["some/model@abc123", "some/model@abc123"]


def test_downloading_an_http_connection_exits_one(root: Path, fetched: list[str]) -> None:
    ok(root, *HTTP)
    result = run(root, "inference", "download", "remote")
    assert result.exit_code == 1, result.output
    assert "runs elsewhere" in result.stderr or "no weights" in result.stderr
    assert fetched == []


def test_downloading_an_unknown_connection_exits_one(root: Path, fetched: list[str]) -> None:
    result = run(root, "inference", "download", "nothing-here")
    assert result.exit_code == 1, result.output
    assert "Error:" in result.stderr


@without_the_extra
def test_a_missing_local_runtime_exits_one_with_the_install_command(root: Path) -> None:
    """Unstubbed. A sentence naming what to run, never a traceback.

    The kernel-vocabulary translation working end to end: an `ImportError` deep
    inside a package becomes one line at a terminal and exit 1, because
    `opened_workspace` renders a `VisionSetError` and `_extra.imported` made it
    one.
    """
    ok(root, *LOCAL)
    result = run(root, "inference", "download", "local-gd")
    assert result.exit_code == 1, result.output
    assert 'pip install "visionset[local-inference]"' in result.stderr
    assert "Traceback" not in result.stderr


# --- ``size``, the one command here that opens no workspace --------------------


def sized(*argv: str) -> Result:
    """Invoke ``size`` without ``--workspace``.

    ``_flow.run`` appends the flag to everything, and this command genuinely does
    not take one: it asks about a published model, not about a configured row.
    That is the assertion as much as the helper — a ``size`` that had grown a
    workspace option would fail here rather than quietly acquiring a dependency
    on state it does not read.
    """
    return runner.invoke(app, list(argv))


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


def test_the_size_command_reads_a_listing_and_downloads_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The number to look at before running ``download``.

    ``snapshot_download`` raises, so this reds if the command ever answers by
    fetching the files it is measuring.
    """
    monkeypatch.setattr(weights_module, "imported", lambda _name: _Listing)
    weights_module.known_sizes().clear()
    result = sized("inference", "size", "some/model", "--revision", "abc123")
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == "1024"
    assert "2 files" in result.stderr


def test_the_size_command_needs_no_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The moment the number is wanted is usually the moment before anything exists.

    With no workspace flag and no environment variable, a command that opened one
    would refuse here — which is exactly what a first-time setup would hit.
    """
    monkeypatch.setattr(weights_module, "imported", lambda _name: _Listing)
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)
    monkeypatch.chdir(tmp_path)
    weights_module.known_sizes().clear()
    result = sized("inference", "size", "some/model", "--revision", "abc123")
    assert result.exit_code == 0, result.output


def test_the_size_command_prints_the_document_on_json(monkeypatch: pytest.MonkeyPatch) -> None:
    """Bytes as an integer: how to say "2.3 GB" is a question about a screen."""
    monkeypatch.setattr(weights_module, "imported", lambda _name: _Listing)
    weights_module.known_sizes().clear()
    result = sized("inference", "size", "some/model", "--revision", "abc123", "--json")
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout) == {
        "model_id": "some/model",
        "model_revision": "abc123",
        "total_bytes": 1_024,
        "file_count": 2,
    }


@without_the_extra
def test_a_size_without_the_runtime_exits_one_with_the_install_command() -> None:
    """``size`` opens no workspace, so it carries ``domain_errors`` itself.

    Without it a missing extra would reach a terminal as a traceback rather than
    as the one line naming what to install — the translation every other command
    in this file inherits from ``opened_workspace``.
    """
    weights_module.known_sizes().clear()
    result = sized("inference", "size", "some/model", "--revision", "abc123")
    assert result.exit_code == 1, result.output
    assert 'pip install "visionset[local-inference]"' in result.stderr
    assert "Traceback" not in result.stderr


# --- checking that what is on disk is undamaged -------------------------------


@pytest.fixture()
def checked(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Answer the check as intact, and record the connection it was asked about.

    Patched at ``visionset.cli.inference.check_integrity`` — the name the command
    bound at import — so the resolution, the gate and the output are the shipped
    code and only the reading of gigabytes is not.
    """
    seen: list[str] = []

    def _check(workspace: Any, connection_id: Any, **_: Any) -> IntegrityReport:
        seen.append(str(connection_id))
        return IntegrityReport(files_checked=4, bytes_read=2048)

    monkeypatch.setattr(cli_inference, "check_integrity", _check)
    return seen


def test_check_integrity_prints_what_it_read(
    root: Path, fetched: list[str], checked: list[str]
) -> None:
    """The file count on stdout, the sentence on stderr — ``size``'s shape."""
    ok(root, *LOCAL)
    ok(root, "inference", "download", "local-gd")
    assert ok(root, "inference", "check-integrity", "local-gd").strip() == "4"
    assert len(checked) == 1


def test_check_integrity_json_is_what_the_job_result_carries(
    root: Path, fetched: list[str], checked: list[str]
) -> None:
    """One projection, two surfaces. The keys agree because both call ``counts``."""
    ok(root, *LOCAL)
    ok(root, "inference", "download", "local-gd")
    document = payload(root, "inference", "check-integrity", "local-gd")
    assert document == {"files_checked": 4, "bytes_read": 2048}


def test_check_integrity_refuses_a_connection_with_nothing_to_read(root: Path) -> None:
    """A sentence and exit 1, never a traceback — and it names the remedy.

    **Unstubbed**, deliberately, unlike the three above. The gate lives *inside*
    ``check_integrity``, so a test that replaced the function would be asserting
    against its own stub — and this refusal reaches no network to be worth
    faking: it is answered from the row before the hub is asked anything.
    """
    ok(root, *LOCAL)
    result = run(root, "inference", "check-integrity", "local-gd")
    assert result.exit_code == 1, result.output
    assert "download them first" in result.stderr


def test_check_integrity_reports_damage_as_a_sentence(
    root: Path, fetched: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The verdict reaches a terminal as prose, with the files named in it."""

    def _damaged(workspace: Any, connection_id: Any, **_: Any) -> IntegrityReport:
        raise WeightsDamaged("1 file does not match (model.safetensors)")

    monkeypatch.setattr(cli_inference, "check_integrity", _damaged)
    ok(root, *LOCAL)
    ok(root, "inference", "download", "local-gd")
    result = run(root, "inference", "check-integrity", "local-gd")
    assert result.exit_code == 1, result.output
    assert "model.safetensors" in result.stderr
