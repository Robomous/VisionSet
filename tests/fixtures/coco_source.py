# usage: from tests.fixtures.coco_source import write_coco_source
"""A small COCO instances dataset on disk, for the import surfaces."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from tests.fixtures.media import write_image

SIZE = (32, 24)


def write_coco_source(root: Path, *, lossy: bool = False) -> Path:
    """Two images, a box on each and a polygon on the second.

    ``lossy`` adds an RLE mask, which the importer reports as a ``label`` loss.
    """
    for seed, name in enumerate(("a.png", "b.png")):
        write_image(root / "images" / name, size=SIZE, seed=seed)
    annotations: list[dict[str, Any]] = [
        {"image_id": 1, "category_id": 1, "bbox": [1, 2, 10, 8]},
        {"image_id": 2, "category_id": 1, "bbox": [3, 3, 6, 6]},
        {"image_id": 2, "category_id": 2, "segmentation": [[4, 4, 20, 4, 4, 18]]},
    ]
    if lossy:
        annotations.append(
            {"image_id": 1, "category_id": 1, "segmentation": {"counts": "x", "size": [24, 32]}}
        )
    document = {
        "images": [
            {"id": 1, "file_name": "a.png", "width": SIZE[0], "height": SIZE[1]},
            {"id": 2, "file_name": "b.png", "width": SIZE[0], "height": SIZE[1]},
        ],
        "annotations": [{"id": i, **row} for i, row in enumerate(annotations, 1)],
        "categories": [{"id": 1, "name": "car"}, {"id": 2, "name": "lane"}],
    }
    target = root / "annotations" / "instances_train.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(document), encoding="utf-8")
    return root
