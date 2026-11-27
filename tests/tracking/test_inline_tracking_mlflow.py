"""A command and a stdio MCP server as real processes, tracked against a recording server.

What only a real process shows: the exit flush delivers a short-lived command's
run before the interpreter is gone, a tracking server that never answers delays
the exit by the bound and changes nothing else, and nothing the tracking client
does reaches stdout, which is the command's output and the MCP protocol channel.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest
from mcp.types import LATEST_PROTOCOL_VERSION
from tests.cli import _flow as cli
from tests.fixtures.media import write_images
from tests.fixtures.mlflow_server import require_mlflow, serving_mlflow, silent_server

from visionset.jobs._tracking import EXIT_FLUSH_S

_CLI = "from visionset.cli.main import app; app()"


@pytest.fixture()
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    require_mlflow()
    monkeypatch.delenv("VISIONSET_WORKSPACE", raising=False)
    made = cli.workspace(tmp_path)
    cli.published_release(made, tmp_path)
    return made


def _environment(**tracking: str) -> dict[str, str]:
    kept = {
        name: value
        for name, value in os.environ.items()
        if not name.startswith(("VISIONSET_", "MLFLOW_"))
    }
    return {**kept, **tracking}


def _tracked(uri: str) -> dict[str, str]:
    return _environment(VISIONSET_MLFLOW_ENABLED="true", MLFLOW_TRACKING_URI=uri)


def _export(root: Path, out: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    argv = ["export", "-p", "road-signs", "--release", "v1.0", "--format", "coco"]
    argv += ["--allow-lossy", "--out", str(out), "--json", "--workspace", str(root)]
    return subprocess.run(
        [sys.executable, "-c", _CLI, *argv], capture_output=True, text=True, env=env, timeout=120
    )


def _document(stdout: str) -> dict[str, Any]:
    parsed: dict[str, Any] = json.loads(stdout)
    parsed.pop("directory")
    return parsed


def test_a_commands_run_is_delivered_before_it_exits_and_its_output_is_untouched(
    root: Path, tmp_path: Path
) -> None:
    untracked = _export(root, tmp_path / "untracked", _environment())
    with serving_mlflow() as server:
        tracked = _export(root, tmp_path / "tracked", _tracked(server.url))

    assert untracked.returncode == tracked.returncode == 0, tracked.stderr
    assert _document(tracked.stdout) == _document(untracked.stdout)
    assert server.url not in tracked.stderr
    [run] = server.runs.values()
    assert run.status == "FINISHED"
    assert run.name == "export.release"
    assert run.tags["visionset.execution_source"] == "cli"
    assert run.tags["visionset.job_state"] == "succeeded"
    assert "visionset.job_id" not in run.tags
    assert run.params["export_format"] == "coco"
    assert run.params["allow_lossy"] == "True"
    assert run.metrics["output_bytes"] == float(json.loads(tracked.stdout)["total_bytes"])
    assert len(run.inputs) == 1
    assert run.updates == 1


def test_a_server_that_never_answers_delays_a_commands_exit_by_the_bound_and_no_more(
    root: Path, tmp_path: Path
) -> None:
    untracked = _export(root, tmp_path / "untracked", _environment())
    with silent_server() as uri:
        started = time.monotonic()
        tracked = _export(root, tmp_path / "tracked", _tracked(uri))
        elapsed = time.monotonic() - started

    assert tracked.returncode == 0, tracked.stderr
    assert _document(tracked.stdout) == _document(untracked.stdout)
    assert uri not in tracked.stderr
    assert elapsed < EXIT_FLUSH_S + 15


def _message(**fields: Any) -> str:
    return json.dumps({"jsonrpc": "2.0", **fields}) + "\n"


def test_a_stdio_tool_call_is_tracked_and_stdout_carries_only_protocol_messages(
    root: Path, tmp_path: Path
) -> None:
    incoming = tmp_path / "incoming-mcp"
    write_images(incoming, count=2, prefix="mcp", first_seed=100)
    with serving_mlflow() as server:
        env = {**_tracked(server.url), "VISIONSET_WORKSPACE": str(root)}
        child = subprocess.Popen(
            [sys.executable, "-m", "visionset.mcp.main"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        assert child.stdin is not None and child.stdout is not None
        child.stdin.write(
            _message(
                id=1,
                method="initialize",
                params={
                    "protocolVersion": LATEST_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "0"},
                },
            )
        )
        child.stdin.write(_message(method="notifications/initialized"))
        child.stdin.write(
            _message(
                id=2,
                method="tools/call",
                params={
                    "name": "ingest",
                    "arguments": {"project": "road-signs", "path": str(incoming)},
                },
            )
        )
        child.stdin.flush()
        lines: list[str] = []
        while True:
            line = child.stdout.readline()
            assert line, "the server closed stdout before answering"
            lines.append(line)
            if json.loads(line).get("id") == 2:
                break
        child.stdin.close()
        rest, errors = child.communicate(timeout=EXIT_FLUSH_S + 30)
        lines += rest.splitlines(keepends=True)

    messages = [json.loads(line) for line in lines if line.strip()]
    assert all(message["jsonrpc"] == "2.0" for message in messages)
    [answer] = [message for message in messages if message.get("id") == 2]
    assert "error" not in answer and not answer["result"].get("isError"), answer
    assert server.url not in errors
    [run] = server.runs.values()
    assert run.status == "FINISHED"
    assert run.name == "ingest.resume"
    assert run.tags["visionset.execution_source"] == "mcp"
    assert run.metrics["created_asset_count"] == 2.0
    assert run.metrics["processed_count"] == 2.0
