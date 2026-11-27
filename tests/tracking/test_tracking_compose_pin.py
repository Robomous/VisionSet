"""The Compose MLflow server stays at the client version the lockfile resolves."""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "docker" / "compose.yaml"
LOCK = ROOT / "uv.lock"

_IMAGE = re.compile(r"^\s*image:\s*ghcr\.io/mlflow/mlflow:v?(\S+)\s*$", re.MULTILINE)


def test_the_compose_mlflow_image_matches_the_locked_client() -> None:
    pinned = _IMAGE.findall(COMPOSE.read_text(encoding="utf-8"))
    locked = [
        package["version"]
        for package in tomllib.loads(LOCK.read_text(encoding="utf-8"))["package"]
        if package["name"] == "mlflow-skinny"
    ]

    assert len(pinned) == 1, f"expected one ghcr.io/mlflow/mlflow image in {COMPOSE}"
    assert len(locked) == 1, f"expected one mlflow-skinny package in {LOCK}"
    assert pinned[0] == locked[0], (
        f"docker/compose.yaml runs ghcr.io/mlflow/mlflow:v{pinned[0]} but uv.lock resolves "
        f"mlflow-skinny {locked[0]}. Set the image tag to v{locked[0]} (or move the lock "
        "through scripts/cooldown.sh), then run tests/tracking/test_tracking_real_server.py "
        "against the new server."
    )
