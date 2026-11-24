"""The decoded-scan cache: hits, misses, its byte bound, refusals, and concurrent misses."""

from __future__ import annotations

import io
import threading
from concurrent.futures import Future
from pathlib import Path
from typing import Any, BinaryIO

import pytest
from tests.fixtures.point_clouds import SCAN, pcd_ascii, write_scans

from visionset.kernel.adapters import StdlibPointCloudProcessor
from visionset.kernel.domain import PointSample, ScanFrame
from visionset.kernel.errors import CorruptMedia
from visionset.kernel.services import (
    IngestService,
    ProjectService,
    SourceService,
    WorkspaceService,
    point_sample_cache,
)
from visionset.kernel.services.point_sample_cache import PointSampleCache

TIMEOUT_SECONDS = 30.0


def made(points: int, marker: float = 0.0) -> PointSample:
    return PointSample(total=points, stride=1, positions=bytes(12 * points), origin=(marker, 0, 0))


class Loads:
    """A loader that counts its calls and answers one fixed sample."""

    def __init__(self, sample: PointSample) -> None:
        self.sample = sample
        self.calls = 0

    def __call__(self) -> PointSample:
        self.calls += 1
        return self.sample


def test_a_repeat_request_is_answered_without_loading_again() -> None:
    cache = PointSampleCache()
    load = Loads(made(10))

    first = cache.get_or_load(("a" * 64, 1_000), load)
    second = cache.get_or_load(("a" * 64, 1_000), load)

    assert first is second is load.sample
    assert load.calls == 1
    assert (len(cache), cache.nbytes) == (1, 120)


def test_another_budget_or_other_bytes_is_a_miss() -> None:
    cache = PointSampleCache()
    load = Loads(made(10))

    cache.get_or_load(("a" * 64, 1_000), load)
    cache.get_or_load(("a" * 64, 2_000), load)
    cache.get_or_load(("b" * 64, 1_000), load)

    assert load.calls == 3
    assert len(cache) == 3


def test_the_least_recently_used_sample_goes_first_when_the_bound_is_passed() -> None:
    cache = PointSampleCache(max_bytes=300)
    for key in ("a", "b"):
        cache.get_or_load((key, 1), Loads(made(10)))
    cache.get_or_load(("a", 1), Loads(made(10)))
    cache.get_or_load(("c", 1), Loads(made(10)))

    assert ("a", 1) in cache
    assert ("b", 1) not in cache
    assert ("c", 1) in cache
    assert cache.nbytes == 240 <= 300


def test_a_sample_larger_than_the_bound_is_served_and_never_kept() -> None:
    cache = PointSampleCache(max_bytes=100)
    cache.get_or_load(("small", 1), Loads(made(5)))
    big = made(10)

    assert cache.get_or_load(("big", 1), Loads(big)) is big
    assert ("big", 1) not in cache
    assert ("small", 1) in cache
    assert cache.nbytes == 60


def test_a_refusal_is_raised_and_not_kept() -> None:
    cache = PointSampleCache()
    calls = 0

    def refuse() -> PointSample:
        nonlocal calls
        calls += 1
        raise CorruptMedia("the scan will not decode")

    for _ in range(2):
        with pytest.raises(CorruptMedia):
            cache.get_or_load(("a", 1), refuse)
    assert calls == 2
    assert len(cache) == 0
    assert cache.get_or_load(("a", 1), Loads(made(1))).count == 1


def test_a_negative_bound_is_refused() -> None:
    with pytest.raises(ValueError, match="max_bytes"):
        PointSampleCache(max_bytes=-1)


def _run(threads: list[threading.Thread]) -> None:
    for thread in threads:
        thread.join(TIMEOUT_SECONDS)
    assert not any(thread.is_alive() for thread in threads)


class Waiting:
    """Counts the callers that reached the in-flight decode's ``result()``."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.count = 0
        self.changed = threading.Condition()
        waiting = self

        class CountedFuture(Future[PointSample]):
            def result(self, timeout: float | None = None) -> PointSample:
                with waiting.changed:
                    waiting.count += 1
                    waiting.changed.notify_all()
                return super().result(timeout)

        monkeypatch.setattr(point_sample_cache, "Future", CountedFuture)

    def until(self, count: int) -> None:
        with self.changed:
            assert self.changed.wait_for(lambda: self.count >= count, TIMEOUT_SECONDS)


def _ask_all(cache: PointSampleCache, load: Any, callers: int) -> list[Any]:
    outcomes: list[Any] = []
    lock = threading.Lock()

    def ask() -> None:
        try:
            got: Any = cache.get_or_load(("a", 1), load)
        except BaseException as exc:  # noqa: BLE001 - carried to the main thread
            got = exc
        with lock:
            outcomes.append(got)

    threads = [threading.Thread(target=ask) for _ in range(callers)]
    for thread in threads:
        thread.start()
    _run(threads)
    return outcomes


def test_concurrent_misses_on_one_key_load_once_and_share_the_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    waiting = Waiting(monkeypatch)
    cache = PointSampleCache()
    calls = 0
    answer = made(4)

    def slow() -> PointSample:
        nonlocal calls
        calls += 1
        waiting.until(8)
        return answer

    outcomes = _ask_all(cache, slow, 9)

    assert calls == 1
    assert waiting.count == 8
    assert len(outcomes) == 9
    assert all(outcome is answer for outcome in outcomes)
    assert ("a", 1) in cache


def test_a_concurrent_refusal_reaches_every_waiter_from_one_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    waiting = Waiting(monkeypatch)
    cache = PointSampleCache()
    calls = 0
    refusal = CorruptMedia("the scan will not decode")

    def failing() -> PointSample:
        nonlocal calls
        calls += 1
        waiting.until(4)
        raise refusal

    outcomes = _ask_all(cache, failing, 5)

    assert calls == 1
    assert len(outcomes) == 5
    assert all(outcome is refusal for outcome in outcomes)
    assert len(cache) == 0


def test_a_decode_running_when_the_cache_is_cleared_answers_and_is_not_kept() -> None:
    cache = PointSampleCache()
    started, release = threading.Event(), threading.Event()
    answer = made(2)
    outcomes: list[Any] = []

    def slow() -> PointSample:
        started.set()
        assert release.wait(TIMEOUT_SECONDS)
        return answer

    owner = threading.Thread(target=lambda: outcomes.append(cache.get_or_load(("a", 1), slow)))
    owner.start()
    assert started.wait(TIMEOUT_SECONDS)
    cache.clear()
    release.set()
    _run([owner])

    assert outcomes == [answer]
    assert ("a", 1) not in cache
    assert (len(cache), cache.nbytes) == (0, 0)
    assert cache.get_or_load(("a", 1), Loads(answer)) is answer
    assert ("a", 1) in cache


class CountingProcessor(StdlibPointCloudProcessor):
    samples = 0

    def sample(self, content: BinaryIO, *, budget: int, name: str | None = None) -> PointSample:
        type(self).samples += 1
        return super().sample(content, budget=budget, name=name)


def test_the_service_decodes_each_scan_and_budget_once(tmp_path: Path) -> None:
    CountingProcessor.samples = 0
    with WorkspaceService.init(
        tmp_path / "ws", point_cloud_processor_factory=CountingProcessor
    ) as workspace:
        project = ProjectService(workspace).create("scans")
        source = SourceService(workspace).register_point_clouds(
            project.id, write_scans(tmp_path / "scans"), frame=ScanFrame.LIDAR_FLU
        )
        ingest = IngestService(workspace)
        assets = ingest.ingest(source.id).assets
        CountingProcessor.samples = 0

        answers = {
            asset.id: ingest.points(project.id, asset.id, max_points=1_000) for asset in assets
        }
        again = {
            asset.id: IngestService(workspace).points(project.id, asset.id, max_points=1_000)
            for asset in assets
        }
        assert CountingProcessor.samples == len(assets) == 2
        assert all(again[key] is answers[key] for key in answers)
        assert len({answer.encode() for answer in answers.values()}) == 2

        ingest.points(project.id, assets[0].id, max_points=2_000)
        assert CountingProcessor.samples == 3


def test_the_cache_is_keyed_by_content_so_new_bytes_are_decoded(tmp_path: Path) -> None:
    with WorkspaceService.init(tmp_path / "ws") as workspace:
        project = ProjectService(workspace).create("scans")
        first = tmp_path / "first"
        first.mkdir()
        (first / "scan.pcd").write_bytes(pcd_ascii())
        moved = tmp_path / "moved"
        moved.mkdir()
        (moved / "scan.pcd").write_bytes(pcd_ascii(tuple((x + 1, y, z) for x, y, z in SCAN)))
        ingest = IngestService(workspace)
        sources = SourceService(workspace)
        old = ingest.ingest(
            sources.register_point_clouds(project.id, first, frame=ScanFrame.LIDAR_FLU).id
        ).assets[0]
        new = ingest.ingest(
            sources.register_point_clouds(project.id, moved, frame=ScanFrame.LIDAR_FLU).id
        ).assets[0]

        before = ingest.points(project.id, old.id, max_points=1_000)
        after = ingest.points(project.id, new.id, max_points=1_000)

        assert old.content_hash != new.content_hash
        assert (old.content_hash, 1_000) in workspace.point_samples
        assert (new.content_hash, 1_000) in workspace.point_samples
        reference = StdlibPointCloudProcessor().sample(
            io.BytesIO(pcd_ascii(tuple((x + 1, y, z) for x, y, z in SCAN))), budget=1_000
        )
        assert after.encode() == reference.encode() != before.encode()


def test_closing_the_workspace_empties_its_cache(tmp_path: Path) -> None:
    workspace = WorkspaceService.init(tmp_path / "ws")
    workspace.point_samples.get_or_load(("a", 1), Loads(made(1)))
    workspace.close()
    assert len(workspace.point_samples) == 0
