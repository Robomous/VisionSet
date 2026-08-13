"""The bounded LRU both caches are built on.

Small enough to test by hand, and worth testing by hand: it is the thing standing
between the suggest route and a model load per click.
"""

from __future__ import annotations

import pytest

from visionset.inference.cache import (
    DEFAULT_EMBEDDING_CAPACITY,
    DEFAULT_PROVIDER_CAPACITY,
    BoundedCache,
    KeyedLocks,
)


def test_what_goes_in_comes_out() -> None:
    cache: BoundedCache[str, int] = BoundedCache(2)
    cache.put("a", 1)
    assert cache.get("a") == 1
    assert cache.get("missing") is None


def test_the_bound_is_respected_and_the_oldest_goes_first() -> None:
    cache: BoundedCache[str, int] = BoundedCache(2)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.put("c", 3)
    assert len(cache) == 2
    assert "a" not in cache
    assert "b" in cache and "c" in cache


def test_reading_something_keeps_it_alive() -> None:
    """LRU rather than first-in-first-out, which is the whole reason for the class.

    The asset somebody is clicking on repeatedly is the one that must survive,
    and under insertion order it is the one that would be evicted first.
    """
    cache: BoundedCache[str, int] = BoundedCache(2)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.get("a")
    cache.put("c", 3)
    assert "a" in cache, "used most recently"
    assert "b" not in cache


def test_membership_does_not_count_as_a_use() -> None:
    """Otherwise a test asserting eviction would change the thing it is measuring."""
    cache: BoundedCache[str, int] = BoundedCache(2)
    cache.put("a", 1)
    cache.put("b", 2)
    assert "a" in cache
    cache.put("c", 3)
    assert "a" not in cache


def test_writing_a_key_again_refreshes_it_rather_than_growing() -> None:
    cache: BoundedCache[str, int] = BoundedCache(2)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.put("a", 9)
    cache.put("c", 3)
    assert len(cache) == 2
    assert cache.get("a") == 9
    assert "b" not in cache


def test_discarding_and_clearing() -> None:
    cache: BoundedCache[str, int] = BoundedCache(4)
    cache.put("a", 1)
    cache.discard("a")
    cache.discard("a")  # a no-op the second time rather than a KeyError
    assert len(cache) == 0
    cache.put("b", 2)
    cache.clear()
    assert len(cache) == 0


def test_a_cache_that_holds_nothing_is_refused() -> None:
    with pytest.raises(ValueError, match="not a cache"):
        BoundedCache(0)


def test_the_shipped_capacities_leave_room_for_the_co_residency_the_design_assumes() -> None:
    """Two providers is a detector and a segmenter, which is what D1 describes."""
    assert DEFAULT_PROVIDER_CAPACITY >= 2
    assert DEFAULT_EMBEDDING_CAPACITY >= 2


# --- the single-flight primitive ----------------------------------------------


def test_one_key_answers_with_one_lock() -> None:
    """The whole of single-flight: two callers asking about the same thing wait on
    the same object. A fresh lock per call would let both compute."""
    locks: KeyedLocks[str] = KeyedLocks()
    assert locks.for_key("a") is locks.for_key("a")


def test_two_keys_answer_with_different_locks() -> None:
    """Per key, so an encode of one asset never queues behind another's."""
    locks: KeyedLocks[str] = KeyedLocks()
    assert locks.for_key("a") is not locks.for_key("b")
