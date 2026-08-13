"""What concurrent suggests do to the embedding cache and the provider pool.

The suite's second threaded file, and it follows the first one's rules
(`tests/kernel/test_concurrency.py`): everything sequences on a `threading`
primitive rather than on sleeps, every thread is joined with a timeout and then
asserted dead, and nothing asserts on wall-clock — a concurrency test that hangs
is a concurrency test nobody runs, and one that measures duration fails for
reasons nobody chose.

The arrangement under test is the one FastAPI actually builds. `suggest_region`
is a plain ``def``, so concurrent requests run in parallel threadpool threads
against one process-wide pool and one embedding cache per provider. Both were
written for a single caller, and the cost of that showed up in production as two
clicks encoding the same image twice and one process loading the model four
times.

**Overlap is asserted through a barrier, never through timing.** A barrier that
releases proves two encodes were genuinely in flight at once; a barrier that
times out proves they were not. Neither reading depends on how fast the machine
is.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from tests.inference.stubs import StubModel, StubProcessor, StubTorch, disc

from visionset.inference import providers as providers_module
from visionset.inference import sam_provider
from visionset.inference.providers import ProviderPool
from visionset.inference.sam_provider import LocalSamProvider
from visionset.kernel.domain import (
    ConnectionType,
    InferenceConnection,
    PointPrompt,
    PredictionRequest,
    PredictionTarget,
)
from visionset.kernel.services import InferenceConnectionService, WorkspaceService

#: Every wait in this file. Long enough that a loaded runner does not trip it,
#: short enough that a genuine deadlock fails the suite instead of stalling it.
TIMEOUT_SECONDS = 30.0

#: How long a barrier that is *expected* to break waits before giving up. Only
#: ever paid on the fixed code path, where exactly one thread arrives at a
#: barrier sized for several — which is the whole point of the assertion.
LONE_ARRIVAL_SECONDS = 0.5

PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06"
    b"\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00"
    b"\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


class GatedModel(StubModel):
    """A model whose encode parks at a barrier, so overlap is observable.

    Holding every arriving thread inside the encode is what makes the
    unfixed behaviour deterministic: no thread can finish and populate the
    cache while another is still deciding whether to encode, so a suite that
    sees one encode saw single-flight rather than a lucky schedule.
    """

    def __init__(self, masks: Any, scores: Any, barrier: threading.Barrier) -> None:
        super().__init__(masks, scores)
        self._barrier = barrier
        self.lone_arrivals = 0

    def get_image_embeddings(self, pixel_values: Any) -> str:
        try:
            self._barrier.wait(timeout=LONE_ARRIVAL_SECONDS)
        except threading.BrokenBarrierError:
            # Nobody else came. Under single-flight that is the expected shape.
            self.lone_arrivals += 1
        return super().get_image_embeddings(pixel_values)


def gated(monkeypatch: pytest.MonkeyPatch, parties: int) -> tuple[LocalSamProvider, GatedModel]:
    """A provider whose encode is observable, with everything else as shipped."""
    processor = StubProcessor([disc(20)], [0.9])
    model = GatedModel([disc(20)], [0.9], threading.Barrier(parties))
    provider = LocalSamProvider(
        "some/segmenter",
        "abc123",
        device="cpu",
        precision=None,
        cache_dir=Path("/nowhere"),
        connection_name="local",
    )
    monkeypatch.setattr(provider, "_ready", lambda: (processor, model, "cpu", False))
    monkeypatch.setattr(sam_provider, "imported", lambda _: StubTorch())
    return provider, model


def click(provider: LocalSamProvider, asset: UUID) -> None:
    request = PredictionRequest(
        targets=(PredictionTarget(asset_id=asset, content=PNG, media_type="image/png"),),
        prompt=PointPrompt(positive=((10.0, 12.0),)),
    )
    list(provider.segment(request))


def run_together(work: list[Any]) -> list[BaseException]:
    """Start every callable at once, join them all, and hand back what raised.

    A failure inside a thread is returned rather than printed and lost, which is
    the first file's rule: a thread that died quietly makes an assertion about
    counts pass for the wrong reason.
    """
    failures: list[BaseException] = []
    ready = threading.Barrier(len(work))

    def guarded(task: Any) -> None:
        try:
            ready.wait(timeout=TIMEOUT_SECONDS)
            task()
        except BaseException as error:  # noqa: BLE001 — re-raised by the caller
            failures.append(error)

    threads = [threading.Thread(target=guarded, args=(task,)) for task in work]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=TIMEOUT_SECONDS)
        assert not thread.is_alive(), "a thread outlived the timeout"
    return failures


# --- the embedding cache ------------------------------------------------------


def test_concurrent_clicks_on_one_asset_encode_it_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The stampede, which cost a production process four model loads and a stack.

    Every thread is held inside the encode until the barrier releases or breaks,
    so an implementation without single-flight cannot avoid encoding four times.
    """
    provider, model = gated(monkeypatch, parties=4)
    asset = uuid4()

    failures = run_together([lambda: click(provider, asset)] * 4)

    assert failures == []
    assert provider.encodes == 1, "four clicks on one asset, one encode"
    assert model.encodes == 1


def test_every_concurrent_click_still_gets_an_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Single-flight means the others wait for the encode, never that they are dropped."""
    provider, _ = gated(monkeypatch, parties=4)
    asset = uuid4()
    answers: list[int] = []

    def ask() -> None:
        request = PredictionRequest(
            targets=(PredictionTarget(asset_id=asset, content=PNG, media_type="image/png"),),
            prompt=PointPrompt(positive=((10.0, 12.0),)),
        )
        answers.append(len(list(provider.segment(request))[0].segments))

    failures = run_together([ask] * 4)

    assert failures == []
    assert answers == [1, 1, 1, 1]


def test_two_assets_encode_at_the_same_time(monkeypatch: pytest.MonkeyPatch) -> None:
    """Per-key, not global: one asset's encode must not block another's.

    The barrier is sized for both threads and is *not* expected to break. If the
    two encodes were serialised behind one lock the second would never arrive,
    the first would time out, and `lone_arrivals` would record it.
    """
    provider, model = gated(monkeypatch, parties=2)

    failures = run_together([lambda: click(provider, uuid4()) for _ in range(2)])

    assert failures == []
    assert provider.encodes == 2, "two different assets, two encodes"
    assert model.lone_arrivals == 0, "they overlapped rather than serialising"


# --- the provider pool --------------------------------------------------------


@pytest.fixture()
def connection(tmp_path: Path) -> Any:
    workspace = WorkspaceService.init(tmp_path / "ws", name="concurrency")
    try:
        connections = InferenceConnectionService(workspace)
        made = connections.create(
            "seg",
            connection_type=ConnectionType.LOCAL,
            model_id="some/segmenter",
            model_revision="abc123",
            device="cpu",
            precision="fp32",
        )
        yield connections.record_weights_ready(made.id)
    finally:
        workspace.close()


class GatedBuilder:
    """A stand-in for `provider_for` that parks, so overlapping builds are visible."""

    def __init__(self, parties: int) -> None:
        self._barrier = threading.Barrier(parties)
        self.lone_arrivals = 0

    def __call__(self, connection: InferenceConnection, *, workspace_root: Path) -> object:
        try:
            self._barrier.wait(timeout=LONE_ARRIVAL_SECONDS)
        except threading.BrokenBarrierError:
            self.lone_arrivals += 1
        return object()


def test_concurrent_first_clicks_build_one_provider(
    connection: InferenceConnection, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Four concurrent first clicks loaded the model four times in production."""
    builder = GatedBuilder(parties=4)
    monkeypatch.setattr(providers_module, "provider_for", builder)
    pool = ProviderPool()

    failures = run_together(
        [lambda: pool.get(connection, workspace_root=tmp_path) for _ in range(4)]
    )

    assert failures == []
    assert pool.builds == 1, "one connection, one provider"
    assert len(pool) == 1


def test_concurrent_callers_all_receive_the_same_provider(
    connection: InferenceConnection, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(providers_module, "provider_for", GatedBuilder(parties=4))
    pool = ProviderPool()
    seen: list[object] = []

    failures = run_together(
        [lambda: seen.append(pool.get(connection, workspace_root=tmp_path)) for _ in range(4)]
    )

    assert failures == []
    assert len(seen) == 4
    assert len({id(one) for one in seen}) == 1, "one provider, handed to everybody"
