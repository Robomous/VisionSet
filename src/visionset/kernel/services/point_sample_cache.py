"""Thinned scans kept in memory, so a viewer's repeat request does not decode again.

Keyed by the scan's content hash and the point budget. Content addressing is what
makes it safe: an asset's bytes are named by their hash, so different bytes are a
different key and an entry can never describe bytes it was not decoded from.

Bounded by the bytes the samples hold, least recently used first out. A sample
larger than the whole bound is served and never kept. Concurrent misses on one
key decode once: the others wait for that decode and share its answer or its
refusal; a refusal is not kept. A decode still running when the cache is cleared
answers its callers and is not kept. :meth:`PointSampleCache.decoding` bounds how
many scans are decoded at once across every key.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Callable
from concurrent.futures import Future
from typing import Final

from visionset.kernel.domain import PointSample

#: About a dozen samples at the default budget, with intensity and colour.
DEFAULT_POINT_SAMPLE_CACHE_BYTES: Final = 128 << 20

#: How many scans may be decoded at once, whatever their budgets: a decode holds
#: the scan's columns, which the byte bound above does not count.
DEFAULT_CONCURRENT_DECODES: Final = 2

PointSampleKey = tuple[str, int]


class PointSampleCache:
    """A least-recently-used map from ``(content_hash, budget)`` to a ``PointSample``."""

    def __init__(
        self,
        max_bytes: int = DEFAULT_POINT_SAMPLE_CACHE_BYTES,
        *,
        concurrent_decodes: int = DEFAULT_CONCURRENT_DECODES,
    ) -> None:
        if max_bytes < 0:
            raise ValueError(f"max_bytes must not be negative, got {max_bytes}")
        if concurrent_decodes < 1:
            raise ValueError(f"concurrent_decodes must be at least 1, got {concurrent_decodes}")
        self._max_bytes = max_bytes
        self._decodes = threading.BoundedSemaphore(concurrent_decodes)
        self._entries: OrderedDict[PointSampleKey, PointSample] = OrderedDict()
        self._loading: dict[PointSampleKey, Future[PointSample]] = {}
        self._bytes = 0
        self._generation = 0
        self._lock = threading.Lock()

    @property
    def nbytes(self) -> int:
        with self._lock:
            return self._bytes

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)

    def __contains__(self, key: object) -> bool:
        with self._lock:
            return key in self._entries

    def get_or_load(self, key: PointSampleKey, load: Callable[[], PointSample]) -> PointSample:
        """The sample under ``key``, calling ``load`` only when no one has it or is making it."""
        with self._lock:
            cached = self._entries.get(key)
            if cached is not None:
                self._entries.move_to_end(key)
                return cached
            pending = self._loading.get(key)
            if pending is None:
                owner: Future[PointSample] = Future()
                self._loading[key] = owner
                generation = self._generation
        if pending is not None:
            return pending.result()

        try:
            sample = load()
        except BaseException as exc:
            with self._lock:
                del self._loading[key]
            owner.set_exception(exc)
            raise
        with self._lock:
            del self._loading[key]
            if generation == self._generation:
                self._keep(key, sample)
        owner.set_result(sample)
        return sample

    def decoding(self) -> threading.BoundedSemaphore:
        """Held around a scan's decode, so at most ``concurrent_decodes`` run at once.

        Taken inside a ``load`` and never around a nested ``get_or_load``: a load
        that waits on another key's load while holding a slot could starve it.
        """
        return self._decodes

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._bytes = 0
            self._generation += 1

    def _keep(self, key: PointSampleKey, sample: PointSample) -> None:
        size = sample.nbytes
        if size > self._max_bytes:
            return
        self._entries[key] = sample
        self._bytes += size
        while self._bytes > self._max_bytes:
            _, evicted = self._entries.popitem(last=False)
            self._bytes -= evicted.nbytes
