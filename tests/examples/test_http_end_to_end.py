"""The HTTP end-to-end example, run as a smoke test.

M3's exit criterion turned into a regression guard for one of its three legs: if
a route stops composing with the ones around it, or if `visionset server` stops
being able to start at all, this fails long before anyone runs the example by
hand. The assertions are about *outcomes* — what the release holds, whether the
manifest still hashes to itself — rather than about the printed narration, which
is free to change.

Unlike `tests/server/test_external_client.py`, which drives the same walk with
`TestClient` in-process, this one goes through a socket. That is the whole point
of the example, and it is why the two coexist: one proves the contract, the
other proves the contract is reachable.

The example is not part of the ``visionset`` package (it demonstrates the API
from outside it), so it is loaded from its path rather than imported by name.
"""

from __future__ import annotations

import importlib.util
import re
import shutil
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "http_end_to_end.py"


@pytest.fixture(scope="module")
def example() -> Iterator[ModuleType]:
    spec = importlib.util.spec_from_file_location("http_end_to_end", EXAMPLE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Registered while it executes so dataclasses can resolve the module by
    # name; removed afterwards so the test leaves sys.modules as found.
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        del sys.modules[spec.name]


@pytest.fixture(scope="module")
def summary(example: ModuleType, tmp_path_factory: pytest.TempPathFactory) -> Any:
    # Asserted, never skipped. The console script is what this example starts a
    # server with, and a suite that quietly skipped the one test proving the
    # server boots would look exactly like a passing one.
    assert shutil.which("visionset") is not None, "the visionset console script is not installed"
    return example.main(tmp_path_factory.mktemp("workspace") / "http-e2e")


def test_the_server_actually_started_and_answered(summary: Any) -> None:
    """`visionset server` bound a socket and served the API through it.

    Nothing else in the suite proves this: `tests/cli/test_server.py` patches
    `uvicorn.run` and asserts the arguments, which is right for a unit test and
    says nothing about whether the process comes up.
    """
    assert summary.base_url.startswith("http://127.0.0.1:")
    assert summary.project_id
    assert summary.schema_version == 1


def test_the_launched_ingest_was_polled_to_completion(summary: Any) -> None:
    """202 and poll is the shape a client must implement, so the walk implements it.

    At least one poll happened by construction — the run is launched, not done —
    and the job it polled is the one the `Location` header named.
    """
    assert summary.ingest_job_id
    assert summary.ingest_polls >= 1


def test_the_release_holds_what_was_annotated_and_verifies(summary: Any) -> None:
    """Two of four assets promoted, both labelled, and every blob still present."""
    assert summary.annotation_count == 2
    assert summary.promoted == 2
    assert summary.job_count == 2
    assert summary.verified is True
    assert summary.release_tag == "v1.0"


def test_the_manifest_came_down_the_wire_byte_for_byte(summary: Any) -> None:
    """The route streams the stored blob; a re-serializing one would break this.

    The example asserts `sha256(body) == manifest_hash` inline, so reaching this
    line at all is the proof. What is left to check here is that there really
    was a document rather than an empty response that hashed to something.
    """
    assert summary.manifest_bytes > 0
    assert len(summary.manifest_hash) == 64


def test_the_pixels_that_came_back_are_the_originals(summary: Any) -> None:
    """A gallery renders these directly, so the bytes have to be the ones stored."""
    assert summary.content_hash_matched is True


def test_the_same_request_without_a_token_is_refused(summary: Any) -> None:
    """Bearer authentication is end to end, not only at the edges."""
    assert summary.unauthorized_code == "UNAUTHORIZED"


def test_the_export_produced_an_archive(summary: Any) -> None:
    """`dummy` writes no files, so the zip is empty — but it is still a zip."""
    assert summary.export_bytes > 0


def test_the_recipe_export_reports_its_hash_and_wrote_a_train_variant(summary: Any) -> None:
    """A recipe named on `?recipe=` reaches the archive as a report and as files.

    The example reads both out of the downloaded zip: `preprocessing.recipe_hash`
    in `visionset-export-report.json`, and a `-aug1` label under `labels/train/`
    beside its image — the train fold's variant, which is the only fold that
    gets one.
    """
    assert re.fullmatch(r"[0-9a-f]{64}", summary.recipe_hash)
    assert re.fullmatch(r"labels/train/[0-9a-f]{64}-aug1\.txt", summary.augmented_label)
