# usage: from tests.fixtures.endpoint import serving_endpoint, closed_port
"""A real HTTP server answering this project's inference contract, for tests.

Real rather than doubled, on ``a_snapshot``'s reasoning in the conformance
suite: what is being proved is a request that crosses a socket and a body that
is parsed back, and a fake reader agrees with whatever the test already believes.
"""

from __future__ import annotations

import base64
import json
import socket
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from typing import Any

from PIL import Image


def mask_png(width: int, height: int, *, lit: tuple[int, int, int, int]) -> str:
    """A base64 PNG mask of that size with one lit rectangle ``(left, top, right, bottom)``."""
    image = Image.new("L", (width, height), 0)
    image.paste(255, lit)
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


class Endpoint:
    """What the server answers and what it was asked. Mutable, so a test changes
    the answer and the next request sees it."""

    def __init__(self, *, capability: str, model_ref: str) -> None:
        self.capability = capability
        self.model_ref = model_ref
        self.describe_status = 200
        self.describe_body: Any = None  # None derives {model_ref, capability}
        self.describe_location: str | None = None  # set with a 3xx status to redirect
        self.predict_status = 200
        self.predict_body: Any = None  # None derives one answer per target
        self.requests: list[dict[str, Any]] = []
        self.truncate_body = False  # sends a short body under the declared Content-Length
        self.stall_error_body = False  # sends a partial body then stalls, on a non-2xx status
        self.url = ""


def answers_for(endpoint: Endpoint, request: dict[str, Any]) -> dict[str, Any]:
    prompt = request["prompt"]
    answers: list[dict[str, Any]] = []
    for target in request["targets"]:
        if prompt["kind"] == "points":
            with Image.open(BytesIO(base64.b64decode(target["content"]))) as image:
                width, height = image.size
            answers.append(
                {
                    "asset_id": target["asset_id"],
                    "model_ref": endpoint.model_ref,
                    "segments": [
                        {
                            "score": 0.9,
                            "mask": mask_png(
                                width, height, lit=(2, 2, min(width, 10), min(height, 10))
                            ),
                        }
                    ],
                }
            )
        else:
            answers.append(
                {
                    "asset_id": target["asset_id"],
                    "model_ref": endpoint.model_ref,
                    "regions": [
                        {
                            "label": prompt["phrases"][0],
                            "confidence": 0.8,
                            "geometry": {
                                "type": "bbox",
                                "x": 1.0,
                                "y": 1.0,
                                "width": 4.0,
                                "height": 4.0,
                            },
                        }
                    ],
                }
            )
    return {"answers": answers}


class _Handler(BaseHTTPRequestHandler):
    endpoint: Endpoint

    def do_GET(self) -> None:  # the stdlib's spelling
        body = self.endpoint.describe_body
        if body is None:
            body = {"model_ref": self.endpoint.model_ref, "capability": self.endpoint.capability}
        self._send(self.endpoint.describe_status, body, location=self.endpoint.describe_location)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length))
        self.endpoint.requests.append(request)
        body = self.endpoint.predict_body
        if body is None:
            body = answers_for(self.endpoint, request)
        self._send(self.endpoint.predict_status, body)

    def _send(self, status: int, body: Any, *, location: str | None = None) -> None:
        payload = (
            body.encode("utf-8") if isinstance(body, str) else json.dumps(body).encode("utf-8")
        )
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        if location is not None:
            self.send_header("Location", location)
        self.end_headers()
        if self.endpoint.stall_error_body and status >= 400:
            self.wfile.write(payload[: len(payload) // 2])
            self.wfile.flush()
            time.sleep(2)
            return
        if self.endpoint.truncate_body:
            payload = payload[:-5]
        self.wfile.write(payload)

    def log_message(self, *_: object) -> None:
        return


@contextmanager
def serving_endpoint(
    *, capability: str = "point_suggest", model_ref: str = "fake/remote@1"
) -> Iterator[Endpoint]:
    """A contract-speaking server on a free port, torn down on exit."""
    endpoint = Endpoint(capability=capability, model_ref=model_ref)
    handler = type("Handler", (_Handler,), {"endpoint": endpoint})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    endpoint.url = f"http://127.0.0.1:{server.server_port}/predict"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield endpoint
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def closed_port() -> str:
    """A URL nothing listens on: bound, read, released."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    return f"http://127.0.0.1:{port}/predict"
