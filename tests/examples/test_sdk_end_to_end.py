"""The end-to-end example, run as a smoke test.

This is the milestone's exit criterion turned into a regression guard: if any
service stops composing with the ones around it, this fails long before anyone
runs the example by hand. The assertions are deliberately about *outcomes* — how
many assets reached the trunk, whether the release verifies, what the bus saw —
rather than about the printed narration, which is free to change.

The example is not part of the ``visionset`` package (it demonstrates the SDK
from outside it), so it is loaded from its path rather than imported by name.
"""

from __future__ import annotations

import importlib.util
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "sdk_end_to_end.py"


@pytest.fixture(scope="module")
def example() -> Iterator[ModuleType]:
    spec = importlib.util.spec_from_file_location("sdk_end_to_end", EXAMPLE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Registered while it executes so dataclasses and pydantic can resolve the
    # module by name; removed afterwards so the test leaves sys.modules as found.
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
        yield module
    finally:
        del sys.modules[spec.name]


@pytest.fixture(scope="module")
def summary(example: ModuleType, tmp_path_factory: pytest.TempPathFactory) -> Any:
    return example.main(tmp_path_factory.mktemp("workspace") / "sdk-e2e")


def test_the_example_leaves_a_release_that_verifies(summary: Any) -> None:
    """Every blob the manifest names is present, unaltered, and correctly counted."""
    verification = summary.verification
    assert verification.ok
    assert verification.manifest_intact
    assert verification.checked == summary.release.asset_count
    assert verification.missing == ()
    assert verification.corrupt == ()
    assert verification.cache_mismatches == ()


def test_a_skipped_asset_never_reaches_the_trunk(summary: Any) -> None:
    """'skipped' settles the job but is not promotable — the two sets differ by one."""
    assert len(summary.asset_ids) == 6
    assert len(summary.promoted_asset_ids) == 5
    assert summary.skipped_asset_id in summary.asset_ids
    assert summary.skipped_asset_id not in summary.promoted_asset_ids
    assert set(summary.promoted_asset_ids) == set(summary.asset_ids) - {summary.skipped_asset_id}


def test_the_release_carries_every_label_written(summary: Any) -> None:
    """Three labels on each of the five promoted assets, copied into the manifest."""
    assert summary.annotation_count == 15
    assert summary.release.annotation_count == 15
    assert summary.manifest.annotation_count == 15
    assert summary.release.schema_version == summary.schema_version
    assert {asset.asset_id for asset in summary.manifest.assets} == set(summary.promoted_asset_ids)


def test_republishing_an_unchanged_trunk_reproduces_the_manifest(summary: Any) -> None:
    """The byte-for-byte property: same content, same document, one shared blob."""
    assert summary.reissue.id != summary.release.id
    assert summary.reissue.tag != summary.release.tag
    assert summary.reissue.manifest_hash == summary.release.manifest_hash


def test_the_split_partitions_the_frozen_asset_set_exactly(summary: Any) -> None:
    """Disjoint folds whose union is the manifest — no asset lost to arithmetic."""
    assignment = summary.assignment
    folds = (assignment.train, assignment.val, assignment.test)
    assert [len(fold) for fold in folds] == [3, 1, 1]
    assert sum(len(fold) for fold in folds) == summary.release.asset_count
    combined = [asset_id for fold in folds for asset_id in fold]
    assert len(set(combined)) == len(combined)
    assert set(combined) == {asset.asset_id for asset in summary.manifest.assets}


def test_the_folds_are_the_same_frames_every_run(
    example: ModuleType, summary: Any, tmp_path: Path
) -> None:
    """The split keys on content hash, so a second workspace cuts the same frames.

    Asset ids are fresh UUIDs in the second run — which is exactly why this
    compares content hashes and not ids, and why the manifest hashes differ.
    """
    other = example.main(tmp_path / "again")
    assert other.release.manifest_hash != summary.release.manifest_hash

    def folds_by_content(result: Any) -> list[set[str]]:
        content = {asset.asset_id: asset.content_hash for asset in result.manifest.assets}
        return [
            {content[asset_id] for asset_id in fold}
            for fold in (
                result.assignment.train,
                result.assignment.val,
                result.assignment.test,
            )
        ]

    assert folds_by_content(other) == folds_by_content(summary)


def test_every_service_that_should_announce_itself_did(summary: Any) -> None:
    """Emission follows the commit, so a completed run has the whole story on the bus."""
    events = summary.events
    assert events.count("batch_approved") == 1
    assert events.count("batch_completed") == 1
    assert events.count("release_published") == 2  # the publish and the reissue
    # One per call rather than one per box: five annotated assets, five calls.
    assert events.count("annotations_written") == 5
    # Declared but emitted by nobody until M2 wires ingest (#20).
    assert "ingest_completed" not in events
    assert events.index("batch_approved") < events.index("batch_completed")
    assert events.index("batch_completed") < events.index("release_published")
