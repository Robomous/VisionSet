"""Every legacy recipe still hashes, draws, moves labels and writes pixels as before #1238.

The expected values were captured on the checkout before the augmentation
registry existed; see :mod:`tests.fixtures.augmentation_goldens`. Each recipe is
compared field by field so a failure names what moved.
"""

from __future__ import annotations

import json

from tests.fixtures.augmentation_goldens import GOLDENS, compute


def test_legacy_recipes_keep_their_goldens() -> None:
    expected = json.loads(GOLDENS.read_text(encoding="utf-8"))
    actual = compute()

    assert actual.keys() == expected.keys()
    for field in expected.keys() - {"recipes"}:
        assert actual[field] == expected[field], field
    assert actual["recipes"].keys() == expected["recipes"].keys()
    for name, recipe in expected["recipes"].items():
        assert actual["recipes"][name].keys() == recipe.keys(), name
        for field, value in recipe.items():
            assert actual["recipes"][name][field] == value, f"{name}: {field}"
