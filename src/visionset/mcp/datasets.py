# usage: from visionset.mcp import datasets
"""Dataset tools: what is in the trunk.

One tool. The dataset is 1:1 with its project and is reached through it here,
rather than by a ``dataset_id`` an agent would have to fetch and carry — which is
also why ``get_dataset`` and ``get_project_dataset`` fold into ``get_project``.

Three parity candidates are **dropped** rather than folded, because no agent
calls them. ``list_dataset_assets`` walks the trunk, and the annotation loop
iterates *batches*; ``list_dataset_changes`` is an audit record a person reads
when they want to know who removed something; ``remove_dataset_asset`` is
curation, which is a judgement about what a dataset should contain rather than a
step in producing one. ``promote_batch``, the write that fills the trunk, lives
in ``batches`` because ``DatasetService.promote`` takes a *batch* id.
"""

from __future__ import annotations

from typing import Any

from visionset import wire
from visionset.kernel.services import DatasetService, ProjectService
from visionset.mcp._resolve import ProjectRef, resolve_project
from visionset.mcp._workspace import opened_workspace


def dataset_stats(project: ProjectRef) -> dict[str, Any]:
    """Count what is in a project's dataset, class by class.

    The "is this dataset ready to train on" question. `classes` gives both totals
    per class and they answer different things: a thousand labels over a thousand
    images and the same thousand over ten are the same `annotations` and a very
    different dataset. A class the schema declares but nobody has used does not
    appear at all.

    Derived on every call from current membership, so it moves as batches are
    promoted. A release freezes its own counts at publication and those never
    move. `asset_count` minus `annotated_asset_count` is how many promoted assets
    carry no labels.
    """
    with opened_workspace() as workspace:
        resolved = resolve_project(workspace, project)
        dataset = ProjectService(workspace).get_dataset(resolved.id)
        stats = DatasetService(workspace).stats(dataset.id)
    return wire.dataset_stats(stats)
