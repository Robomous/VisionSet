"""An unknown connection, by name or by id, is refused identically at every call site."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

import pytest
from tests.cli._flow import jobs_of, run, started_batch, workspace

from visionset.kernel.services import WORKSPACE_ENV_VAR

NAME = "nothing-here"


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


@pytest.fixture()
def root(tmp_path: Path) -> Path:
    return workspace(tmp_path)


def _invocations(root: Path, tmp_path: Path) -> dict[str, tuple[str, ...]]:
    """Each command with ``{ref}`` where the connection goes."""
    project, batch = started_batch(root, tmp_path)
    job = jobs_of(root, batch)[0]
    return {
        "show": ("inference", "show", "{ref}"),
        "update": ("inference", "update", "{ref}", "--revision", "abc"),
        "download": ("inference", "download", "{ref}"),
        "check-integrity": ("inference", "check-integrity", "{ref}"),
        "test-endpoint": ("inference", "test-endpoint", "{ref}"),
        "delete": ("inference", "delete", "{ref}"),
        "batch pre-label": ("batch", "pre-label", batch, "{ref}"),
        "job pre-label": ("job", "pre-label", job, "{ref}"),
        "project pre-label": ("project", "pre-label", project, "{ref}"),
    }


COMMANDS = [
    "show",
    "update",
    "download",
    "check-integrity",
    "test-endpoint",
    "delete",
    "batch pre-label",
    "job pre-label",
    "project pre-label",
]


def _refusal(root: Path, args: tuple[str, ...], ref: str, *, as_json: bool) -> tuple[int, str, str]:
    argv = tuple(ref if part == "{ref}" else part for part in args)
    result = run(root, *argv, *(("--json",) if as_json and args[1] != "delete" else ()))
    return result.exit_code, result.stdout.replace(ref, "REF"), result.stderr.replace(ref, "REF")


MESSAGES = {
    "name": "no inference connection named 'REF' in workspace 'ws'",
    "id": "no inference connection REF in workspace 'ws'",
}


@pytest.mark.parametrize("command", COMMANDS)
@pytest.mark.parametrize("as_json", [False, True])
@pytest.mark.parametrize("kind", ["name", "id"])
def test_an_unknown_connection_is_refused_the_same_way_at_every_call_site(
    root: Path, tmp_path: Path, command: str, as_json: bool, kind: str
) -> None:
    args = _invocations(root, tmp_path)[command]
    ref = NAME if kind == "name" else str(uuid4())

    exit_code, stdout, stderr = _refusal(root, args, ref, as_json=as_json)

    assert exit_code == 1
    assert f"Error: {MESSAGES[kind]}" in stderr
    if as_json and command != "delete":
        assert json.loads(stdout) == {
            "error": {
                "code": "INFERENCE_CONNECTION_NOT_FOUND",
                "message": MESSAGES[kind],
                "detail": None,
            }
        }
    else:
        assert stdout == ""


def test_deleting_an_unknown_connection_never_asks(root: Path) -> None:
    for ref in (NAME, str(uuid4())):
        result = run(root, "inference", "delete", ref)
        assert result.exit_code == 1, result.output
        assert "Delete connection" not in result.stdout + result.stderr


def test_batch_pre_label_names_the_connection_before_the_batch(root: Path) -> None:
    for ref in (NAME, str(uuid4())):
        result = run(root, "batch", "pre-label", str(uuid4()), ref, "--json")
        assert result.exit_code == 1, result.output
        assert json.loads(result.stdout)["error"]["code"] == "INFERENCE_CONNECTION_NOT_FOUND"
