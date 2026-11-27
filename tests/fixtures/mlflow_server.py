# usage: from tests.fixtures.mlflow_server import require_mlflow, serving_mlflow, silent_server
"""A recording MLflow REST server, and which half of the tracking matrix this is.

The server answers the handful of tracking endpoints the adapter calls and keeps
every request it saw, so a test can assert exactly what left the process — the
real MLflow client on one side and a real socket in between.

``VISIONSET_REQUIRE_MLFLOW=1`` turns a missing client into an error rather than a
skip, the rule ``VISIONSET_REQUIRE_LOCAL_INFERENCE`` states for its extra.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import socket
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Final
from urllib.parse import parse_qs, urlsplit

import pytest

MLFLOW_INSTALLED: Final[bool] = importlib.util.find_spec("mlflow") is not None

without_mlflow: Final = pytest.mark.skipif(MLFLOW_INSTALLED, reason="mlflow is installed here")


def require_mlflow() -> None:
    if MLFLOW_INSTALLED:
        return
    message = "the MLflow client is not installed here: `uv sync --extra mlflow`"
    if os.environ.get("VISIONSET_REQUIRE_MLFLOW") == "1":
        pytest.fail(message)
    pytest.skip(message)


@dataclass
class Seen:
    method: str
    path: str
    headers: dict[str, str]
    body: dict[str, Any] | None


@dataclass
class Run:
    """One run as the server holds it: what was sent to it, and how it ended."""

    run_id: str
    name: str
    status: str = "RUNNING"
    tags: dict[str, str] = field(default_factory=dict)
    params: dict[str, str] = field(default_factory=dict)
    metrics: dict[str, float] = field(default_factory=dict)
    updates: int = 0

    def info(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "run_uuid": self.run_id,
            "run_name": self.name,
            "experiment_id": "7",
            "status": self.status,
            "start_time": 1,
            "lifecycle_stage": "active",
        }

    def body(self) -> dict[str, Any]:
        return {
            "info": self.info(),
            "data": {
                "tags": [{"key": k, "value": v} for k, v in self.tags.items()],
                "params": [{"key": k, "value": v} for k, v in self.params.items()],
                "metrics": [
                    {"key": k, "value": v, "timestamp": 1, "step": 0}
                    for k, v in self.metrics.items()
                ],
            },
        }


@dataclass
class MlflowServer:
    """Run ids are ``run-1``, ``run-2``, … in creation order."""

    url: str = ""
    requests: list[Seen] = field(default_factory=list)
    experiment_exists: bool = False
    runs: dict[str, Run] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)


_CLAUSE = re.compile(
    r"tags\.`(?P<key>[^`]+)` = '(?P<value>[^']*)'|attributes\.status = '(?P<status>\w+)'"
)


def _matches(run: Run, filter_string: str) -> bool:
    for clause in filter_string.split(" and "):
        found = _CLAUSE.fullmatch(clause.strip())
        if found is None:
            raise ValueError(f"unsupported filter clause: {clause!r}")
        if found["status"] is not None:
            if run.status != found["status"]:
                return False
        elif run.tags.get(found["key"]) != found["value"]:
            return False
    return True


class _Handler(BaseHTTPRequestHandler):
    server_state: MlflowServer

    def log_message(self, *args: object) -> None:
        return None

    def _reply(self, status: int, body: dict[str, Any]) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        self.server_state.requests.append(Seen("GET", self.path, dict(self.headers), None))
        if self.path.startswith("/api/2.0/mlflow/experiments/get-by-name"):
            if self.server_state.experiment_exists:
                return self._reply(200, {"experiment": {"experiment_id": "7", "name": "visionset"}})
            return self._reply(404, {"error_code": "RESOURCE_DOES_NOT_EXIST", "message": "no"})
        if self.path.startswith("/api/2.0/mlflow/runs/get"):
            run_id = parse_qs(urlsplit(self.path).query).get("run_id", [""])[0]
            with self.server_state.lock:
                run = self.server_state.runs.get(run_id)
                if run is None:
                    return self._reply(
                        404, {"error_code": "RESOURCE_DOES_NOT_EXIST", "message": "no"}
                    )
                return self._reply(200, {"run": run.body()})
        self._reply(404, {"error_code": "ENDPOINT_NOT_FOUND", "message": self.path})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        self.server_state.requests.append(Seen("POST", self.path, dict(self.headers), body))
        if self.path.endswith("/experiments/create"):
            self.server_state.experiment_exists = True
            return self._reply(200, {"experiment_id": "7"})
        state = self.server_state
        with state.lock:
            if self.path.endswith("/runs/create"):
                run_id = f"run-{len(state.runs) + 1}"
                created = Run(run_id, body.get("run_name", ""))
                created.tags.update({tag["key"]: tag["value"] for tag in body.get("tags", [])})
                state.runs[run_id] = created
                return self._reply(200, {"run": created.body()})
            run = state.runs.get(body.get("run_id") or body.get("run_uuid") or "")
            if self.path.endswith("/runs/update") and run is not None:
                run.status = body.get("status", run.status)
                run.updates += 1
                return self._reply(200, {"run_info": run.info()})
            if self.path.endswith("/runs/log-batch") and run is not None:
                run.params.update({p["key"]: p["value"] for p in body.get("params", [])})
                run.metrics.update({m["key"]: m["value"] for m in body.get("metrics", [])})
                run.tags.update({t["key"]: t["value"] for t in body.get("tags", [])})
                return self._reply(200, {})
            if self.path.endswith("/runs/search"):
                found = [
                    one.body()
                    for one in state.runs.values()
                    if _matches(one, body.get("filter", ""))
                ]
                return self._reply(200, {"runs": found})
        self._reply(404, {"error_code": "ENDPOINT_NOT_FOUND", "message": self.path})


@contextmanager
def serving_mlflow() -> Iterator[MlflowServer]:
    state = MlflowServer()
    handler = type("Handler", (_Handler,), {"server_state": state})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    state.url = f"http://127.0.0.1:{server.server_port}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@contextmanager
def silent_server() -> Iterator[str]:
    """Accepts connections and never answers, so only a timeout ends a request."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    held: list[socket.socket] = []
    stop = threading.Event()

    def accept() -> None:
        listener.settimeout(0.1)
        while not stop.is_set():
            try:
                connection, _ = listener.accept()
            except OSError:
                continue
            held.append(connection)

    thread = threading.Thread(target=accept, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{listener.getsockname()[1]}"
    finally:
        stop.set()
        thread.join()
        for connection in held:
            connection.close()
        listener.close()


def closed_port() -> str:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    return f"http://127.0.0.1:{port}"
