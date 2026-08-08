# usage: from visionset.inference.cache import BoundedCache
"""A least-recently-used cache, bounded by count, and the two capacities that use it.

**Why anything is cached at all.** A point-prompted segmenter splits its work in
two: an encode that reads the whole image and costs most of the time, and a
decode from a click that costs almost none. D5 on #424 budgets =<300 ms for the
perceived cost of a click, and that number is only reachable if the first click
on an asset pays the encode and the ones after it do not. So the embedding is
kept, and this is what keeps it.

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
    """Bounded, least-recently-used, and deliberately not thread safe.

    Not thread safe for the same reason ``LocalTransformersProvider`` is not: a
    worker process runs one task at a time, and a server handler holding a
    model is already serialised by the device it is talking to. A lock here
    would buy nothing and would suggest a concurrency this design does not
    have.

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

    @property
    def capacity(self) -> int:
        """The most this will ever hold. Fixed for the life of the cache."""
        return self._capacity

    def get(self, key: K) -> V | None:
        """What is held under that key, or ``None`` — and a hit is a use."""
        if key not in self._held:
            return None
        self._held.move_to_end(key)
        return self._held[key]

    def put(self, key: K, value: V) -> V:
        """Hold that, evicting the least recently used if the bound is reached.

        Returns the value, so a caller can write ``return cache.put(k, compute())``
        rather than putting and then reading back.
        """
        if key in self._held:
            self._held.move_to_end(key)
        self._held[key] = value
        while len(self._held) > self._capacity:
            self._held.popitem(last=False)
        return value

    def discard(self, key: K) -> None:
        """Forget that key if it is held. A no-op if it is not."""
        self._held.pop(key, None)

    def clear(self) -> None:
        """Forget everything."""
        self._held.clear()

    def __len__(self) -> int:
        return len(self._held)

    def __contains__(self, key: object) -> bool:
        """Membership **without** counting as a use, for tests that assert eviction."""
        return key in self._held
