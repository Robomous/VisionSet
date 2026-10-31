"""A refusal under ``--json`` is data: the code and detail REST answers with, on stdout."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from uuid import UUID

import pytest
from tests.cli._flow import (
    plain,
    published_release,
    run,
    schemad_project,
    started_batch,
    stills,
    workspace,
)

from visionset.kernel import SchemaChangeWouldOrphan
from visionset.kernel.domain import Annotation, BboxGeometry, GeometryType, LabelClass
from visionset.kernel.services import (
    WORKSPACE_ENV_VAR,
    AnnotationService,
    BatchService,
    JobService,
    ProjectService,
    SchemaService,
    WorkspaceService,
)
from visionset.server.errors import error_response


@pytest.fixture(autouse=True)
def _no_ambient_workspace(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(WORKSPACE_ENV_VAR, raising=False)


def _orphaning_project(root: Path, tmp_path: Path) -> str:
    name, batch = started_batch(root, tmp_path)
    with WorkspaceService.open(root) as service:
        (job,) = BatchService(service).jobs(UUID(batch))
        JobService(service).start(job.id)
        asset = next(iter(BatchService(service).get(UUID(batch)).asset_ids))
        AnnotationService(service).add(
            job.id,
            [
                Annotation(
                    asset_id=asset,
                    label_class="sign",
                    schema_version=1,
                    geometry=BboxGeometry(x=1, y=2, width=30, height=40),
                    provenance="human",
                )
            ],
        )
    return name


def _lane_only(tmp_path: Path) -> Path:
    path = tmp_path / "lane.json"
    path.write_text(
        json.dumps({"classes": [{"name": "lane", "geometries": ["polyline"]}]}), encoding="utf-8"
    )
    return path


def _rest_body(root: Path, name: str) -> dict:
    """What the REST renderer answers for the same refusal, raised by the same call."""
    with WorkspaceService.open(root) as service:
        project = ProjectService(service).get_by_name(name)
        with pytest.raises(SchemaChangeWouldOrphan) as caught:
            SchemaService(service).create_version(
                project.id,
                (LabelClass(name="lane", geometries=(GeometryType.POLYLINE,)),),
                allow_destructive=True,
            )
    return json.loads(error_response(caught.value).body)


def test_a_json_refusal_carries_the_code_and_detail_rest_answers(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = _orphaning_project(root, tmp_path)

    result = run(
        root,
        "schema",
        "apply",
        str(_lane_only(tmp_path)),
        "-p",
        name,
        "--allow-destructive",
        "--json",
    )

    assert result.exit_code == 1, result.output
    assert "Error:" in result.stderr
    refusal = json.loads(result.stdout)["error"]
    assert set(refusal) == {"code", "message", "detail"}
    assert refusal["code"] == "SCHEMA_CHANGE_WOULD_ORPHAN"
    assert refusal["detail"] == {
        "blockers": [{"label_class": "sign", "annotations": 1, "assets": 1}]
    }
    rest = _rest_body(root, name)
    assert (refusal["code"], refusal["detail"]) == (rest["code"], rest["detail"])


def test_a_refusal_without_detail_says_null(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    result = run(root, "schema", "list", "-p", "nope", "--json")
    assert result.exit_code == 1, result.output
    refusal = json.loads(result.stdout)["error"]
    assert refusal["code"] == "PROJECT_NOT_FOUND"
    assert refusal["detail"] is None
    assert refusal["message"] in result.stderr


def test_without_json_a_refusal_leaves_stdout_empty(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = _orphaning_project(root, tmp_path)

    result = run(
        root, "schema", "apply", str(_lane_only(tmp_path)), "-p", name, "--allow-destructive"
    )

    assert result.exit_code == 1, result.output
    assert result.stdout == ""
    assert "Error:" in result.stderr
    assert "There is no flag for this one." in result.stderr


def test_one_invocations_json_flag_does_not_leak_into_the_next(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    assert run(root, "schema", "list", "-p", "nope", "--json").stdout != ""
    # A command with no `--json` of its own, so nothing re-sets the flag for it.
    after = run(root, "schema", "draft", "clear", "-p", "nope")
    assert after.exit_code == 1
    assert after.stdout == ""


def test_a_usage_error_under_json_does_not_make_the_next_refusal_json(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    usage = run(root, "batch", "promote", "--json", "not-a-uuid")
    assert usage.exit_code == 2
    after = run(root, "schema", "draft", "clear", "-p", "nope")
    assert after.exit_code == 1
    assert after.stdout == ""


_DENIED = r"Permission denied(: [^/]+)?"
"""Which call trips first is the platform's business; that no directory leaks is ours."""


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads any directory")
def test_an_unreadable_directory_is_one_sentence_and_no_traceback(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = schemad_project(root, tmp_path)
    locked = stills(tmp_path)
    # Listable but not searchable: past Click's `readable=True`, failing in the kernel.
    locked.chmod(0o444)
    try:
        plain_run = run(root, "ingest", str(locked), "-p", name)
        json_run = run(root, "ingest", str(locked), "-p", name, "--json")
    finally:
        locked.chmod(0o755)

    assert plain_run.exit_code == 1
    assert plain_run.stdout == ""
    last_line = plain(plain_run.stderr).splitlines()[-1]
    assert re.fullmatch(rf"Error: {_DENIED}", last_line)
    assert "Traceback" not in plain_run.output
    assert json_run.exit_code == 1
    refusal = json.loads(json_run.stdout)["error"]
    assert refusal["code"] == "INTERNAL_ERROR"
    assert re.fullmatch(_DENIED, refusal["message"])
    assert str(tmp_path) not in refusal["message"]
    assert refusal["detail"] is None


@pytest.mark.skipif(os.geteuid() == 0, reason="root writes anywhere")
def test_an_uncreatable_destination_is_one_sentence_and_honours_json(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    name = published_release(root, tmp_path)
    sealed = tmp_path / "sealed"
    sealed.mkdir(mode=0o555)
    out = str(sealed / "out")
    try:
        result = run(
            root,
            "export",
            "-p",
            name,
            "--release",
            "v1.0",
            "--format",
            "dummy",
            "--out",
            out,
            "--json",
        )
    finally:
        sealed.chmod(0o755)

    assert result.exit_code == 1
    refusal = json.loads(result.stdout)["error"]
    assert refusal["code"] == "EXPORT_DESTINATION_REFUSED"
    assert refusal["message"] == f"cannot create the export directory {out}: Permission denied"
    assert "Traceback" not in result.output


def test_visionset_debug_adds_the_traceback_on_stderr_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import visionset.cli.projects as projects

    def crash(*_: object, **__: object) -> None:
        raise RuntimeError("boom")

    root = workspace(tmp_path)
    monkeypatch.setattr(projects, "opened_workspace", crash)
    quiet = run(root, "project", "list", "--json")
    monkeypatch.setenv("VISIONSET_DEBUG", "1")
    loud = run(root, "project", "list", "--json")

    for result in (quiet, loud):
        assert result.exit_code == 1
        assert json.loads(result.stdout)["error"]["message"] == (
            "An unexpected RuntimeError stopped the operation."
        )
    assert "Traceback" not in quiet.stderr
    assert "Traceback" in loud.stderr
    assert "RuntimeError: boom" in loud.stderr
