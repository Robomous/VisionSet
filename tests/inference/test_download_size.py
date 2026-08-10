"""Reading how big a download would be, without doing the download.

The number the local-connection form shows before somebody confirms.
Its whole reason to exist is that the standing decision — VisionSet
downloads nothing on its own — is only a real decision if the cost is on screen
first, so the one property worth proving is negative: **asking never fetches**.

The hub client is faked, as it is in `test_weights.py`, because a real call is a
network round trip. What is not faked is the code that decides what to count,
what to refuse, and what to remember.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from tests.fixtures.local_inference import without_the_extra

from visionset.inference import DownloadSizes, download_size, known_sizes, measure
from visionset.inference import weights as weights_module
from visionset.kernel.errors import LocalInferenceUnavailable


@dataclass(frozen=True)
class FakeSibling:
    """One row of a repository's file listing, shaped like the hub client's."""

    rfilename: str
    size: int | None


class FakeInfo:
    def __init__(self, siblings: list[FakeSibling]) -> None:
        self.siblings = siblings


class FakeHub:
    """A hub client that lists files and refuses to be used for anything else.

    ``snapshot_download`` raises rather than being absent: a missing attribute
    would fail the same test with an ``AttributeError`` that reads like a typo,
    while this one names the rule that was broken.
    """

    def __init__(self, siblings: list[FakeSibling]) -> None:
        self._siblings = siblings
        self.calls = 0
        self.asked: list[tuple[str, str | None, bool]] = []

    def model_info(self, repo_id: str, **kwargs: Any) -> FakeInfo:
        self.calls += 1
        self.asked.append((repo_id, kwargs.get("revision"), bool(kwargs.get("files_metadata"))))
        return FakeInfo(self._siblings)

    @staticmethod
    def snapshot_download(**_: object) -> str:
        raise AssertionError("reading a size must not download anything")


def hub_of(monkeypatch: pytest.MonkeyPatch, siblings: list[FakeSibling]) -> FakeHub:
    fake = FakeHub(siblings)
    monkeypatch.setattr(weights_module, "imported", lambda _name: fake)
    return fake


A_LISTING = [
    FakeSibling("config.json", 1_024),
    FakeSibling("model.safetensors", 300_000_000),
    FakeSibling("README.md", 2_048),
]


def test_measuring_a_size_downloads_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    """The property the whole surface exists for.

    A size read by fetching the files it is measuring would be a download
    somebody never agreed to, wearing the name of the control that was supposed
    to ask them. `FakeHub.snapshot_download` fails the test rather than returning,
    so this reds the moment the implementation reaches for the download path.
    """
    hub = hub_of(monkeypatch, A_LISTING)
    measured = measure("some/model", "abc123")
    assert measured.total_bytes == 300_003_072
    assert hub.calls == 1


def test_the_lookup_asks_for_file_metadata_at_the_pinned_revision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Sizes arrive only when they are asked for, and a size is per revision.

    Without ``files_metadata`` the listing comes back with every ``size`` null,
    which this code would then correctly refuse — a green suite reporting a
    refusal nobody meant.
    """
    hub = hub_of(monkeypatch, A_LISTING)
    measure("some/model", "v1.2")
    assert hub.asked == [("some/model", "v1.2", True)]


def test_every_file_counts_because_the_download_fetches_every_file(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Not the weights alone.

    ``download`` takes a snapshot with no patterns, so a repository publishing
    both serialisations of the same tensors really does cost both. A number
    counting one of them would understate what lands on the disk.
    """
    hub_of(
        monkeypatch,
        [
            FakeSibling("model.safetensors", 100),
            FakeSibling("pytorch_model.bin", 100),
            FakeSibling("tokenizer.json", 7),
        ],
    )
    measured = measure("some/model", "abc123")
    assert measured.total_bytes == 207
    assert measured.file_count == 3


def test_the_pair_is_echoed_back(monkeypatch: pytest.MonkeyPatch) -> None:
    """A form that had to remember what it asked about would hold a second copy."""
    hub_of(monkeypatch, A_LISTING)
    measured = measure("facebook/sam2-hiera-base-plus", "main")
    assert measured.model_id == "facebook/sam2-hiera-base-plus"
    assert measured.model_revision == "main"


def test_a_file_the_hub_did_not_size_is_refused_rather_than_skipped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Skipping it would answer with a number smaller than the truth.

    Which is worse than no number, because the number's only job is to inform a
    decision somebody is about to make.
    """
    hub_of(
        monkeypatch,
        [FakeSibling("config.json", 1_024), FakeSibling("model.safetensors", None)],
    )
    with pytest.raises(LocalInferenceUnavailable) as raised:
        measure("some/model", "abc123")
    assert "did not report a size for 1 of 2 files" in str(raised.value)
    assert "model.safetensors" in str(raised.value)


def test_an_empty_listing_is_refused_rather_than_reported_as_zero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ "0 B" would invite somebody to confirm a download nothing is known about."""
    hub_of(monkeypatch, [])
    with pytest.raises(LocalInferenceUnavailable) as raised:
        measure("some/model", "abc123")
    assert "listed no files" in str(raised.value)


def test_a_failed_lookup_arrives_in_the_kernels_vocabulary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``download``'s translation, one call earlier: no library exception escapes."""

    class Broken:
        @staticmethod
        def model_info(*_: object, **__: object) -> FakeInfo:
            raise ValueError("404 Client Error: Repository Not Found")

    monkeypatch.setattr(weights_module, "imported", lambda _name: Broken)
    with pytest.raises(LocalInferenceUnavailable) as raised:
        measure("some/model", "abc123")
    assert "could not read the size of some/model at abc123" in str(raised.value)
    assert "Repository Not Found" in str(raised.value)


@without_the_extra
def test_a_missing_hub_client_names_the_install_command() -> None:
    """Unstubbed: the size is read with the client that would do the fetching, so
    a machine without the extra is refused here too — with the remedy."""
    with pytest.raises(LocalInferenceUnavailable) as raised:
        measure("some/model", "abc123")
    assert 'pip install "visionset[local-inference]"' in str(raised.value)


def test_a_size_is_read_once_per_revision(monkeypatch: pytest.MonkeyPatch) -> None:
    """A pinned revision is a fixed set of files, so the answer cannot go stale.

    ``lookups`` is what separates a working cache from one that asks every time:
    both answer correctly, and only the counter tells them apart.
    """
    hub = hub_of(monkeypatch, A_LISTING)
    sizes = DownloadSizes()
    first = sizes.get("some/model", "abc123")
    second = sizes.get("some/model", "abc123")
    assert first == second
    assert sizes.lookups == 1
    assert hub.calls == 1


def test_two_revisions_of_one_model_are_two_answers(monkeypatch: pytest.MonkeyPatch) -> None:
    """The key is the pair. A cache keyed on the model id alone would report one
    revision's size under another's name."""
    hub = hub_of(monkeypatch, A_LISTING)
    sizes = DownloadSizes()
    sizes.get("some/model", "v1")
    sizes.get("some/model", "v2")
    assert sizes.lookups == 2
    assert hub.calls == 2
    assert len(sizes) == 2


def test_a_refusal_is_not_cached_as_an_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    """A revision that could not be read is asked again next time.

    Caching the failure would make one bad moment on the network permanent for
    the life of the process, with no way for anybody to retry.
    """
    hub_of(monkeypatch, [])
    sizes = DownloadSizes()
    for _ in range(2):
        with pytest.raises(LocalInferenceUnavailable):
            sizes.get("some/model", "abc123")
    assert len(sizes) == 0
    assert sizes.lookups == 0


def test_the_cache_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    """It holds a working set, not a log of everything anybody ever typed."""
    hub_of(monkeypatch, A_LISTING)
    sizes = DownloadSizes(capacity=2)
    for revision in ("v1", "v2", "v3"):
        sizes.get("some/model", revision)
    assert len(sizes) == 2


def test_the_process_wide_cache_is_one_object() -> None:
    """``known_sizes`` is a function so that importing this module does not read
    as taking a handle on shared state."""
    assert known_sizes() is known_sizes()


def test_the_module_level_entry_point_goes_through_the_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``download_size`` is what surfaces call, and it must not bypass the cache
    the surfaces are the reason for."""
    hub = hub_of(monkeypatch, A_LISTING)
    known_sizes().clear()
    try:
        download_size("some/model", "cached-once")
        download_size("some/model", "cached-once")
        assert hub.calls == 1
    finally:
        known_sizes().clear()
