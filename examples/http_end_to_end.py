"""The whole cycle over HTTP, from outside the process — M3's exit criterion, leg one.

A real server on a real port, driven by a real socket with a bearer token::

    uv run python examples/http_end_to_end.py [DESTINATION]

Its two siblings walk the same ground through the CLI and over MCP. This one is
the claim the REST contract exists to support: **a third-party application can
do everything the official UI does**, holding nothing but a base URL and a
token. If any step below needed the SDK, the contract would be incomplete.

**No HTTP library.** Not ``httpx``, not ``requests``, not even ``curl`` — the
whole walk is ``urllib.request`` from the standard library, including the one
multipart upload, which is built by hand a few lines down. That is deliberate
twice over: ``httpx`` is a *development* dependency here, so an example using it
could not run from an installed wheel; and a contract that only a smart client
can drive is not really a contract. The cost is about twenty-five lines of
boundary-writing, which is a fair price for being able to say the API is
reachable from anything that speaks HTTP.

**Setup is the SDK; the walk is not.** Creating a workspace and minting a
credential are the operator's job, done once, before any client exists — so
those two lines go through ``WorkspaceService`` and ``TokenService``. Everything
after the server starts is a request. Do not "simplify" the walk by reaching
back into the SDK; the separation is the point.

The one thing this leg shows that neither sibling can: **launch-and-poll**.
Ingest over HTTP answers 202 with a job row and does the work in a background
worker, so the client polls. Over MCP the same call is synchronous, because a
stdio server has no worker to hand it to. Same capability, two honest shapes.
"""

from __future__ import annotations

import json
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from email.message import Message
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import uuid4

from PIL import Image

from visionset.kernel.services import TokenService, WorkspaceService

#: Where the example puts its workspace unless told otherwise. Under
#: ``workspace-data/``, which the repository ignores by design.
DEFAULT_DEST = Path(__file__).resolve().parent / "workspace-data" / "http-e2e"

#: Four stills, cut into two jobs, so the walk proves a batch completes when
#: *every* job does rather than when the first one does.
FRAME_COUNT = 4
FRAME_SIZE = (96, 72)
JOB_SIZE = 2

#: Loopback only. A workspace's tokens are minted by hand, so an example that
#: bound a wildcard address would put a freshly created one on the network.
HOST = "127.0.0.1"

#: How long to wait for uvicorn to come up, and for the ingest worker to finish.
#: Generous rather than tight: a slow CI runner must read as slow, not as broken.
STARTUP_TIMEOUT = 30.0
INGEST_TIMEOUT = 60.0
POLL_INTERVAL = 0.05

VISIONSET_MISSING = (
    "the `visionset` console script is not on PATH, and this example starts a server with it.\n"
    "Run it through the project environment: `uv run python examples/http_end_to_end.py`."
)


@dataclass(frozen=True)
class Summary:
    """What the run produced, for a reader and for the smoke test alike."""

    base_url: str
    project_id: str
    schema_version: int
    source_id: str
    ingest_job_id: str
    ingest_polls: int
    asset_ids: tuple[str, ...]
    batch_id: str
    job_count: int
    annotation_count: int
    promoted: int
    release_tag: str
    manifest_hash: str
    manifest_bytes: int
    verified: bool
    export_bytes: int
    content_hash_matched: bool
    unauthorized_code: str


# --- the client -----------------------------------------------------------


class Client:
    """A bearer-authenticated HTTP client, in about as little as it can be done.

    Every response goes through :meth:`request`, which asserts the status is one
    the walk expects before handing anything back. A walk that only checks its
    final state passes just as happily when a step in the middle answered 404
    and the next one happened not to need it.

    ``urlopen`` raises :class:`~urllib.error.HTTPError` on 4xx and 5xx, and that
    exception *is* a response object — headers, body and all. Catching it rather
    than letting it escape is what lets the last step below assert a 401 the same
    way every other step asserts a 200.
    """

    def __init__(self, base_url: str, token: str | None) -> None:
        self.base_url = base_url
        self.token = token

    def request(
        self,
        method: str,
        path: str,
        *expected: int,
        json_body: Any = None,
        body: bytes | None = None,
        content_type: str | None = None,
    ) -> tuple[int, Message, bytes]:
        """Status, headers and raw bytes, after checking the status.

        The headers come back as the :class:`~email.message.Message` urllib
        already built rather than as a plain dict, because **header names are
        case-insensitive** and that object honours it. Starlette writes them
        lowercased, so a client that reaches for ``headers["Location"]`` out of
        a ``dict`` gets a ``KeyError`` from a response that was perfectly
        correct.
        """
        payload = body
        if json_body is not None:
            payload = json.dumps(json_body).encode("utf-8")
            content_type = "application/json"

        request = urllib.request.Request(f"{self.base_url}{path}", data=payload, method=method)
        if content_type is not None:
            request.add_header("Content-Type", content_type)
        if self.token is not None:
            request.add_header("Authorization", f"Bearer {self.token}")

        try:
            with urllib.request.urlopen(request) as response:  # noqa: S310
                status, headers, content = response.status, response.headers, response.read()
        except urllib.error.HTTPError as refused:
            status, headers, content = refused.code, refused.headers, refused.read()

        if status not in expected:
            raise AssertionError(
                f"{method} {path} -> {status} {content.decode('utf-8', 'replace')[:400]}"
            )
        return status, headers, content

    def json(self, method: str, path: str, *expected: int, json_body: Any = None) -> Any:
        """The parsed body of a JSON response."""
        _, _, content = self.request(method, path, *expected, json_body=json_body)
        return json.loads(content) if content else None


def multipart(files: list[tuple[str, str, bytes]]) -> tuple[str, bytes]:
    """A ``multipart/form-data`` body, built by hand.

    Twenty-odd lines, and they are the reason this example needs no dependency.
    Each part is a boundary line, a ``Content-Disposition`` naming the *field*
    and the *filename*, a content type, a blank line, then the bytes; the whole
    thing ends with the boundary plus two trailing hyphens.

    ``uuid4`` in the boundary rather than a fixed string: a boundary that occurs
    inside the payload would split a part in half, and PNG bytes are arbitrary.
    """
    boundary = f"----visionset-{uuid4().hex}"
    marker = f"--{boundary}".encode()
    chunks: list[bytes] = []
    for field, filename, content in files:
        chunks.append(marker)
        chunks.append(
            f'Content-Disposition: form-data; name="{field}"; filename="{filename}"'.encode()
        )
        chunks.append(b"Content-Type: image/png")
        chunks.append(b"")
        chunks.append(content)
    chunks.append(f"--{boundary}--".encode())
    chunks.append(b"")
    return f"multipart/form-data; boundary={boundary}", b"\r\n".join(chunks)


# --- synthetic media ------------------------------------------------------


def frames(count: int) -> list[tuple[str, str, bytes]]:
    """PNG bytes, in memory and never written to disk.

    Registration over HTTP is upload-only — the client has bytes, not a path on
    the server's filesystem — so this example is the one that never touches the
    filesystem for its inputs at all. Each image gets its own pixels, so no pair
    deduplicates by accident and four uploads really are four assets.
    """
    width, height = FRAME_SIZE
    made: list[tuple[str, str, bytes]] = []
    for index in range(count):
        pixels = bytes(
            channel
            for y in range(height)
            for x in range(width)
            for channel in ((x * 3 + index * 71) % 256, (y * 5) % 256, (x + y + index * 29) % 256)
        )
        buffer = BytesIO()
        Image.frombytes("RGB", FRAME_SIZE, pixels).save(buffer, format="PNG")
        made.append(("files", f"frame-{index:03d}.png", buffer.getvalue()))
    return made


# --- the server -----------------------------------------------------------


def free_port() -> int:
    """A port nobody is listening on, as far as the kernel knows a moment ago.

    Bind to 0, read what was handed out, let it go. There is a window between
    releasing it and uvicorn claiming it; every tool that starts a server on an
    ephemeral port lives with the same one, and losing the race shows up as a
    startup failure rather than as something subtle.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((HOST, 0))
        return int(probe.getsockname()[1])


def wait_until_serving(server: subprocess.Popen[bytes], base_url: str) -> None:
    """Poll ``/health`` until the server answers, or say why it never will.

    ``/health`` is the one unauthenticated route, which is what makes it the
    readiness probe: a 200 here means the application started *and* opened its
    workspace. Checking whether the process is still alive first matters — a
    server that died at startup must report its exit code, not time out looking
    like a slow machine.
    """
    deadline = time.monotonic() + STARTUP_TIMEOUT
    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise SystemExit(f"the server exited before it was ready (code {server.returncode})")
        try:
            with urllib.request.urlopen(f"{base_url}/health", timeout=1.0) as response:  # noqa: S310
                if response.status == 200:
                    return
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(POLL_INTERVAL)
    raise SystemExit(f"the server did not answer {base_url}/health within {STARTUP_TIMEOUT:.0f}s")


# --- the cycle ------------------------------------------------------------


def main(dest: Path) -> Summary:
    """Drive an empty directory to an exported release, all of it over HTTP.

    ``dest`` must not already hold a workspace: this creates one. Everything the
    run produces lives under it — the workspace at ``ws/`` and the two files the
    client downloads at ``downloads/``.
    """
    if shutil.which("visionset") is None:
        # Asserted rather than skipped, and before anything is written: the
        # console script is this example's one requirement, and a machine
        # without it must leave no half-made workspace behind.
        raise SystemExit(VISIONSET_MISSING)

    root = dest / "ws"
    downloads = dest / "downloads"
    downloads.mkdir(parents=True, exist_ok=True)

    # The operator's two lines, and the last SDK in this file. `close()` is
    # load-bearing: it checkpoints the WAL, so the server process that opens the
    # file next finds committed state rather than a sidecar it has to recover.
    with WorkspaceService.init(root, name="http-end-to-end") as workspace:
        token = TokenService(workspace).create("http-end-to-end").secret
    _say(f"workspace at {root}, one token minted (shown once, by design)")

    port = free_port()
    base_url = f"http://{HOST}:{port}"
    server = subprocess.Popen(  # noqa: S603
        [
            "visionset", "server",
            "--host", HOST,
            "--port", str(port),
            "--workspace", str(root),
        ],
    )  # fmt: skip
    try:
        wait_until_serving(server, base_url)
        _say(f"`visionset server` is serving {base_url}")
        return _walk(Client(base_url, token), base_url, downloads)
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=10)


def _walk(client: Client, base_url: str, downloads: Path) -> Summary:
    """Ingest to an exported release, one request at a time."""
    # (1) A project, and the labeling contract its work will be judged against.
    project = client.json("POST", "/projects", 201, json_body={"name": "chest-xray"})["id"]
    # The answer is a *publication*: the version, plus every open batch that moved
    # onto it. There are none yet — the project has no batch at all — and empty is
    # the ordinary answer rather than a failure.
    published = client.json(
        "POST",
        f"/projects/{project}/schema/versions",
        201,
        json_body={
            "classes": [
                {
                    "name": "nodule",
                    "geometries": ["bbox"],
                    "attributes": [{"name": "malignant", "kind": "boolean", "required": True}],
                }
            ]
        },
    )
    schema = published["published"]
    _say(f"project {project} with schema v{schema['version']}")

    # (2) Offer it some data. Registration is upload-only: an HTTP client has
    # bytes, not a path on the server's filesystem, so the server stages what
    # arrives under a content-addressed directory and registers *that*.
    content_type, body = multipart(frames(FRAME_COUNT))
    _, _, uploaded = client.request(
        "POST",
        f"/projects/{project}/sources/images",
        201,
        body=body,
        content_type=content_type,
    )
    source = json.loads(uploaded)["id"]
    _say(f"{FRAME_COUNT} images uploaded as source {source}")

    # (3) Launch the run and poll it. 202 means the row exists and the work does
    # not, so the first poll always finds something — the shape a client must
    # implement because the work outlives the request. `Location` is where to
    # look, stated rather than assembled by the client.
    status, headers, launched = client.request(
        "POST", f"/sources/{source}/ingest-jobs", 202, json_body={"batch_name": "study-a"}
    )
    job = json.loads(launched)
    assert headers["Location"] == f"/ingest-jobs/{job['id']}", headers
    assert job["state"] == "pending", job

    finished, polls = _poll_ingest(client, job["id"])
    assert finished["processed"] == FRAME_COUNT, finished
    assert finished["failures"] == [], finished
    batch = finished["batch_id"]
    _say(f"ingest job {finished['state']} after {polls} polls: {finished['processed']} read")

    # (4) Freeze the membership, pin the schema version forever, cut it in two.
    approved = client.json(
        "POST",
        f"/batches/{batch}/approve",
        200,
        json_body={"partition": {"kind": "by_size", "size": JOB_SIZE}},
    )
    assert approved["state"] == "approved", approved
    started = client.json("POST", f"/batches/{batch}/start", 200)
    assert started["state"] == "in_annotation", started
    jobs = client.json("GET", f"/batches/{batch}/jobs", 200)
    _say(f"approved against schema v{approved['schema_version']} into {jobs['total']} jobs")

    # (5) Work each job the way an annotator client would: take the next assets,
    # submit labels, close it. Reading them back is how a client that lost its
    # connection restores the canvas, which is why the walk asserts the round trip.
    written = 0
    for entry in jobs["items"]:
        job_id = entry["id"]
        assert client.json("POST", f"/jobs/{job_id}/start", 200)["state"] == "in_progress"

        waiting = client.json("GET", f"/jobs/{job_id}/next?n=10", 200)["items"]
        first, second = waiting

        labels = client.json(
            "POST",
            f"/jobs/{job_id}/annotations",
            201,
            json_body=[
                {
                    "asset_id": first["id"],
                    "label_class": "nodule",
                    "geometry": {"type": "bbox", "x": 4.0, "y": 5.0, "width": 12.0, "height": 8.0},
                    "attributes": {"malignant": False},
                    "provenance": "human",
                }
            ],
        )
        written += len(labels["items"])
        reread = client.json("GET", f"/jobs/{job_id}/assets/{first['id']}/annotations", 200)
        assert reread["items"] == labels["items"], reread

        # The label moved the first asset on its own; the second is a decision,
        # and a skipped asset settles the job without entering the trunk.
        client.json(
            "PUT",
            f"/jobs/{job_id}/assets/{second['id']}/progress",
            200,
            json_body={"progress": "skipped"},
        )
        progress = client.json("GET", f"/jobs/{job_id}/progress", 200)
        assert (progress["annotated"], progress["skipped"]) == (1, 1), progress
        assert client.json("POST", f"/jobs/{job_id}/complete", 200)["state"] == "completed"
    _say(f"{jobs['total']} jobs worked and closed, {written} labels written")

    # (6) The batch closes once every job has, and the listing reports where each
    # asset ended up — the contract a gallery pages through.
    completed = client.json("POST", f"/batches/{batch}/complete", 200)
    assert completed["state"] == "completed", completed
    listing = client.json("GET", f"/batches/{batch}/assets?limit=2", 200)
    assert listing["total"] == FRAME_COUNT, listing
    assert len(listing["items"]) == 2, listing

    # (7) Curate. Promotion is the one gate into the trunk, and it takes what was
    # annotated or accepted — the two skipped assets stay out by design.
    promoted = client.json("POST", f"/batches/{batch}/promote", 200)["total"]
    dataset = client.json("GET", f"/projects/{project}/dataset", 200)["id"]
    stats = client.json("GET", f"/datasets/{dataset}/stats", 200)
    _say(f"{promoted} of {FRAME_COUNT} promoted; trunk holds {stats['annotation_count']} labels")

    # (8) Freeze it. The manifest is hash-pinned evidence, so what comes down the
    # wire must be exactly the bytes the release names — which is why the route
    # streams the stored blob rather than re-serializing the document. A build
    # whose JSON encoder ordered keys differently would break this line and
    # nothing else.
    release = client.json(
        "POST",
        f"/datasets/{dataset}/releases",
        201,
        json_body={"tag": "v1.0", "split": {"train": 0.5, "val": 0.25, "test": 0.25, "seed": 7}},
    )
    _, manifest_headers, manifest = client.request(
        "GET", f"/releases/{release['id']}/manifest", 200
    )
    assert sha256(manifest).hexdigest() == release["manifest_hash"], "manifest bytes moved"
    assert manifest_headers["ETag"] == f'"{release["manifest_hash"]}"'
    (downloads / "manifest.json").write_bytes(manifest)

    # Publishing again from an unchanged trunk gives the same bytes, which is
    # what makes a release reproducible rather than merely recorded.
    again = client.json("POST", f"/datasets/{dataset}/releases", 201, json_body={"tag": "v1-again"})
    assert again["manifest_hash"] == release["manifest_hash"], "an unchanged trunk moved"

    verified = client.json("GET", f"/releases/{release['id']}/verify", 200)["ok"]
    _say(f"release {release['tag']} — {len(manifest)} manifest bytes hash true, verify {verified}")

    # (9) Export it. Which formats exist is a property of the deployment, so the
    # client asks rather than assuming — and an export is *launched*,
    # the same shape as the ingest above: 202, a `Location`, poll, then take the
    # artifact. A real exporter copies every image in the release, which is not
    # something a request can hold open.
    installed = client.json("GET", "/formats", 200)
    assert "dummy" in {row["name"] for row in installed["items"]}, installed
    status, export_headers, launched_export = client.request(
        "POST", f"/releases/{release['id']}/export?format=dummy", 202
    )
    export_job = json.loads(launched_export)
    assert export_headers["Location"] == f"/background-jobs/{export_job['id']}", export_headers
    assert export_job["state"] == "queued", export_job

    settled, export_polls = _poll_job(client, export_job["id"])
    assert settled["result"]["format"] == "dummy", settled
    _, archive_headers, archive = client.request(
        "GET", f"/background-jobs/{export_job['id']}/artifact", 200
    )
    assert archive_headers["Content-Type"] == "application/zip", archive_headers
    (downloads / "release.zip").write_bytes(archive)
    _say(f"export settled after {export_polls} polls: {len(archive)} bytes of zip to {downloads}")

    # (10) And reach the pixels. A gallery renders these directly, so the media
    # type has to be right and the bytes have to be the originals — asserted by
    # hashing what came back against the hash the asset listing reported.
    asset = listing["items"][0]
    _, picture_headers, picture = client.request(
        "GET", f"/projects/{project}/assets/{asset['id']}/content", 200
    )
    content_matched = sha256(picture).hexdigest() == asset["content_hash"]
    assert picture_headers["Content-Type"] == "image/png", picture_headers
    assert "immutable" in picture_headers["Cache-Control"], picture_headers

    # (11) The walk ends on a refusal it also asserts. Every route but /health is
    # bearer-authenticated, and the refusal is one identical 401 whatever is
    # wrong with the credential — a body that distinguished missing from unknown
    # would be an oracle for which tokens exist.
    anonymous = Client(base_url, token=None)
    refused = anonymous.json("GET", f"/datasets/{dataset}/stats", 401)
    assert refused["code"] == "UNAUTHORIZED", refused
    _say(f"without a token the same request is {refused['code']}, as it should be")

    return Summary(
        base_url=base_url,
        project_id=project,
        schema_version=schema["version"],
        source_id=source,
        ingest_job_id=finished["id"],
        ingest_polls=polls,
        asset_ids=tuple(asset["id"] for asset in listing["items"]),
        batch_id=batch,
        job_count=jobs["total"],
        annotation_count=written,
        promoted=promoted,
        release_tag=release["tag"],
        manifest_hash=release["manifest_hash"],
        manifest_bytes=len(manifest),
        verified=verified,
        export_bytes=len(archive),
        content_hash_matched=content_matched,
        unauthorized_code=refused["code"],
    )


def _poll_ingest(client: Client, job_id: str) -> tuple[dict[str, Any], int]:
    """Watch a launched run until it settles, and say how many looks it took.

    The terminal states are ``completed`` and ``failed``; anything else means
    come back. A run that never settles is a broken worker, not a slow one, so
    the deadline raises rather than returning what it last saw.
    """
    deadline = time.monotonic() + INGEST_TIMEOUT
    polls = 0
    while time.monotonic() < deadline:
        polls += 1
        job = client.json("GET", f"/ingest-jobs/{job_id}", 200)
        if job["state"] in {"completed", "failed"}:
            assert job["state"] == "completed", job
            return job, polls
        time.sleep(POLL_INTERVAL)
    raise SystemExit(f"ingest job {job_id} did not settle within {INGEST_TIMEOUT:.0f}s")


def _poll_job(client: Client, job_id: str) -> tuple[dict[str, Any], int]:
    """Watch a background job until it settles, and say how many looks it took.

    The generic twin of :func:`_poll_ingest`, over ``/background-jobs``. Three
    terminal states rather than two — a job can be ``cancelled`` as well — and a
    poller that stopped on only the first two would spin forever on the third.
    """
    deadline = time.monotonic() + INGEST_TIMEOUT
    polls = 0
    while time.monotonic() < deadline:
        polls += 1
        job = client.json("GET", f"/background-jobs/{job_id}", 200)
        if job["state"] in {"succeeded", "failed", "cancelled"}:
            assert job["state"] == "succeeded", job
            return job, polls
        time.sleep(POLL_INTERVAL)
    raise SystemExit(f"background job {job_id} did not settle within {INGEST_TIMEOUT:.0f}s")


def _say(message: str) -> None:
    print(f"  · {message}")


# --- running it -----------------------------------------------------------


def _clear_previous_run(dest: Path) -> None:
    """Remove a previous run of this example, and refuse to remove anything else.

    Only ever called for :data:`DEFAULT_DEST`. A directory that holds anything
    other than what this example writes is not ours to delete, so it stops
    instead of guessing.
    """
    if not dest.exists():
        return
    if not dest.is_dir():
        raise SystemExit(f"refusing to run: {dest} exists and is not a directory")
    ours = {"ws", "downloads"}
    stray = {entry.name for entry in dest.iterdir()} - ours
    if stray:
        raise SystemExit(
            f"refusing to remove {dest}: it holds {', '.join(sorted(stray))}, "
            f"which this example did not write"
        )
    shutil.rmtree(dest)


def _run() -> None:
    if len(sys.argv) > 2:
        raise SystemExit(f"usage: {Path(sys.argv[0]).name} [DESTINATION]")
    if len(sys.argv) == 2:
        # A destination someone named is never removed automatically; if it
        # already holds a workspace, WorkspaceService says so and stops.
        dest = Path(sys.argv[1]).resolve()
    else:
        dest = DEFAULT_DEST
        _clear_previous_run(dest)

    print(f"VisionSet HTTP end-to-end · {dest}")
    summary = main(dest)
    print(
        f"\nDone. {summary.promoted} assets and {summary.annotation_count} labels released as "
        f"{summary.release_tag}, verified {summary.verified}, over {summary.base_url}.\n"
        f"Workspace left at {dest / 'ws'} — serve it again with "
        f"`visionset server --workspace {dest / 'ws'}`."
    )


if __name__ == "__main__":
    _run()
