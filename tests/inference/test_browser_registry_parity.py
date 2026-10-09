"""Drift guard between the browser model registry and the backend curated catalog.

A browser model is matched to a backend entry by name only. The backend runs the
original checkpoint and the browser an ONNX export, so their provenance refs
differ by design (docs/content/architecture/decisions/
where-a-model-runs-is-not-where-it-came-from.md). Every browser id must be either
matched to a curated backend (model_id, revision) or deferred with a reason.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from visionset.inference.registry import registered

REPO_ROOT = Path(__file__).resolve().parents[2]
REGISTRY = REPO_ROOT / "frontend/app/src/data/browserInference/fixtures/registry-v1.json"

MATCHED: dict[str, tuple[str, str]] = {
    "sam2.1-hiera-tiny": (
        "facebook/sam2.1-hiera-tiny",
        "de431c4043854a71d8101e17995dfe596bf101a5",
    ),
    "slimsam-77-uniform": (
        "Zigeng/SlimSAM-uniform-77",
        "79c09c1ce6b4ae51f00634ed171d9b8e888f6911",
    ),
}

DEFERRED: dict[str, str] = {
    "mobile-sam": "no transformers-loadable checkpoint: TinyViT encoder, raw .pt",
    "efficientvit-sam-l0": (
        "no transformers model type; the HF repo is 7.6 GB and download has no file filter"
    ),
    "efficient-sam-ti": (
        "no transformers config; needs an ONNX provider reading models.robomous.ai"
    ),
}


def browser_ids() -> set[str]:
    return {model["id"] for model in json.loads(REGISTRY.read_text())["models"]}


def curated_pairs() -> set[tuple[str, str]]:
    return {
        (entry.model_id, entry.model_revision)
        for provider in registered().providers.values()
        for entry in provider.curated
    }


def test_every_browser_model_is_matched_or_deferred() -> None:
    undecided = sorted(browser_ids() - MATCHED.keys() - DEFERRED.keys())
    assert not undecided, (
        f"new browser model(s) {undecided} are in the registry but in neither MATCHED nor "
        "DEFERRED: serve them from a backend provider and add to MATCHED, or add to DEFERRED "
        "with a reason"
    )


def test_no_id_is_both_matched_and_deferred() -> None:
    both = sorted(MATCHED.keys() & DEFERRED.keys())
    assert not both, f"{both} appear in both MATCHED and DEFERRED; an id is one or the other"


def test_tables_name_only_registry_ids() -> None:
    stale = sorted((MATCHED.keys() | DEFERRED.keys()) - browser_ids())
    assert not stale, f"{stale} are in MATCHED/DEFERRED but no longer in the browser registry"


@pytest.mark.parametrize("browser_id", sorted(MATCHED))
def test_matched_pair_is_curated(browser_id: str) -> None:
    pair = MATCHED[browser_id]
    assert pair in curated_pairs(), (
        f"{browser_id!r} is matched to {pair} but no provider curates that "
        "(model_id, revision); update MATCHED or the curated catalog"
    )


@pytest.mark.parametrize("browser_id", sorted(DEFERRED))
def test_deferred_reason_is_given(browser_id: str) -> None:
    assert DEFERRED[browser_id].strip(), f"{browser_id!r} is deferred without a reason"
