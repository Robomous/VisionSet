"""Every legacy recipe still hashes, draws, moves labels and writes pixels as before #1238.

The expected values were captured on the checkout before the augmentation
registry existed; see :mod:`tests.fixtures.augmentation_goldens`. Each recipe is
compared field by field so a failure names what moved.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from tests.fixtures.augmentation_goldens import GOLDENS, compute

EXPECTED: dict[str, Any] = json.loads(GOLDENS.read_text(encoding="utf-8"))
ACTUAL: dict[str, Any] = compute()


def test_the_goldens_cover_the_same_recipes_and_source() -> None:
    assert sorted(ACTUAL["recipes"]) == sorted(EXPECTED["recipes"])
    assert ACTUAL["source_image"] == EXPECTED["source_image"]
    assert ACTUAL["showcase"] == EXPECTED["showcase"]


@pytest.mark.parametrize(
    "field",
    ["document", "canonical", "hash", "wire", "draws", "geometry", "geometry_showcase", "pixels"],
)
@pytest.mark.parametrize("name", sorted(EXPECTED["recipes"]))
def test_a_legacy_recipe_is_unchanged(name: str, field: str) -> None:
    assert ACTUAL["recipes"][name][field] == EXPECTED["recipes"][name][field]
