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
import socket
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Final

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
class MlflowServer:
    url: str = ""
    requests: list[Seen] = field(default_factory=list)
    experiment_exists: bool = False


_INFO = {
    "run_id": "run-1",
    "run_uuid": "run-1",
    "experiment_id": "7",
    "status": "RUNNING",
    "start_time": 1,
    "lifecycle_stage": "active",
}


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
            return self._reply(200, {"run": {"info": _INFO, "data": {}}})
        self._reply(404, {"error_code": "ENDPOINT_NOT_FOUND", "message": self.path})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        self.server_state.requests.append(Seen("POST", self.path, dict(self.headers), body))
        if self.path.endswith("/experiments/create"):
            self.server_state.experiment_exists = True
            return self._reply(200, {"experiment_id": "7"})
        if self.path.endswith("/runs/create"):
            return self._reply(200, {"run": {"info": _INFO, "data": {}}})
        if self.path.endswith("/runs/update"):
            return self._reply(200, {"run_info": {**_INFO, "status": body.get("status")}})
        if self.path.endswith("/runs/log-batch"):
            return self._reply(200, {})
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
