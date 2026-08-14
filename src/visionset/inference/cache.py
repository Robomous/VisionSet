# usage: from visionset.inference.cache import BoundedCache
"""A least-recently-used cache, bounded by count, and the two capacities that use it.

**Why anything is cached at all.** A point-prompted segmenter splits its work in
two: an encode that reads the whole image and costs most of the time, and a
decode from a click that costs almost none. The design budget for the perceived
cost of a click is =<300 ms, and that is only reachable if the first click on an
asset pays the encode and the ones after it do not. So the embedding is kept, and
this is what keeps it.

**Bounded by count rather than by bytes, and small.** A byte budget would need to
know the size of a tensor living on a device this module must not import, and
would then be guessing at how much of that device somebody else's model is
holding. A count is honest about being a policy rather than a measurement, and
the arithmetic behind each default below is written down so the next person can
redo it rather than re-derive it.

**In-process, so it dies with the process, and that is correct.** A suggestion is
not a fact about the workspace — nothing here is persisted, invalidated or
shared between workers — it is a saved intermediate that a restart is free to
recompute. Anything durable would be infrastructure this slice deliberately does
not add.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Final

DEFAULT_EMBEDDING_CAPACITY: Final = 8
"""How many assets' image embeddings to keep.

For a hiera-base-plus-shaped encoder at 1024x1024 the feature maps come to
roughly 8 MB in half precision, so eight of them is on the order of 64 MB of
whatever device the model is on — comfortably inside the margin D1 says
base-plus leaves on a 16 GB profile, and enough that moving back and forth
between a handful of assets stays warm. Somebody labelling one asset at a time
never reaches the bound at all.
"""

DEFAULT_PROVIDER_CAPACITY: Final = 2
"""How many loaded models to keep resident.

Two, because that is the co-residency D1 describes: a segmenter answering clicks
and a detector answering words, both live, without a third quietly arriving to
push one out. Weights are gigabytes — this is the bound that matters — and the
alternative to keeping them is re-reading them per click, which is the same
latency failure the embedding cache exists to prevent, one level up.
"""


class BoundedCache[K, V]:
    """Bounded, least-recently-used, and safe to share between threads.

    **It did not used to be, and the assumption behind that was wrong.** This
    was written as "deliberately not thread safe" on the reasoning that a worker
    process runs one task at a time and a server handler is serialised by the
    device it talks to. Neither holds: the suggest route is a plain ``def``, so
    FastAPI runs concurrent requests in parallel threadpool threads, and two of
    them reaching one cache is the ordinary case rather than an exotic one.

    The lock here protects the container's own integrity — two threads calling
    ``move_to_end`` for *different* keys are still mutating one linked list — and
    nothing more. It is never held across a computation, so it cannot serialise
    two encodes; stopping the same value from being computed twice is a separate
    problem with a separate answer, :class:`KeyedLocks` at the caller.

    ``get`` counts as a use, which is what makes this LRU rather than
    first-in-first-out: the asset somebody is clicking on repeatedly is the one
    that must survive, and it is the one that would be evicted first under
    insertion order.
    """

    def __init__(self, capacity: int) -> None:
        if capacity < 1:
            raise ValueError(f"a cache holding {capacity} things is not a cache")
        self._capacity = capacity
        self._held: OrderedDict[K, V] = OrderedDict()
        self._lock = threading.Lock()

    @property
    def capacity(self) -> int:
        """The most this will ever hold. Fixed for the life of the cache."""
        return self._capacity

    def get(self, key: K) -> V | None:
        """What is held under that key, or ``None`` — and a hit is a use."""
        with self._lock:
            if key not in self._held:
                return None
            self._held.move_to_end(key)
            return self._held[key]

    def put(self, key: K, value: V) -> V:
        """Hold that, evicting the least recently used if the bound is reached.

        Returns the value, so a caller can write ``return cache.put(k, compute())``
        rather than putting and then reading back.
        """
        with self._lock:
            if key in self._held:
                self._held.move_to_end(key)
            self._held[key] = value
            while len(self._held) > self._capacity:
                self._held.popitem(last=False)
        return value

    def discard(self, key: K) -> None:
        """Forget that key if it is held. A no-op if it is not."""
        with self._lock:
            self._held.pop(key, None)

    def clear(self) -> None:
        """Forget everything."""
        with self._lock:
            self._held.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._held)

    def __contains__(self, key: object) -> bool:
        """Membership **without** counting as a use, for tests that assert eviction."""
        with self._lock:
            return key in self._held


class KeyedLocks[K]:
    """One lock per key, so that a value is computed once and only once.

    **What a bounded cache alone cannot do.** A cache tells a caller whether a
    value is *there*; it has nothing to say about a value that is on its way. Two
    threads asking for the same un-cached thing both see nothing and both compute
    it, which is how one image came to be encoded twice and one model came to be
    loaded four times in a single process. The remedy is to make the second
    thread wait for the first rather than duplicate it, and a lock held across
    the computation is what waiting means.

    **Per key, because a global lock would be a different bug.** Holding one lock
    across every encode would make a click on one asset wait for an unrelated
    click on another — turning a duplicated-work problem into a queueing problem
    and costing exactly the latency the cache exists to save. Two keys never
    contend here; only two callers wanting the same key do.

    The map grows with distinct keys seen in a process and is never pruned. That
    is one ``threading.Lock`` — tens of bytes — per asset anybody has ever
    suggested on, against the 16 MB the same asset's embedding occupies while it
    is cached, so the bound that matters is already elsewhere.
    """

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._locks: dict[K, threading.Lock] = {}

    def for_key(self, key: K) -> threading.Lock:
        """The lock for that key, made on first ask.

        The guard is held only for the lookup, never for the work the returned
        lock goes on to protect.
        """
        with self._guard:
            return self._locks.setdefault(key, threading.Lock())
