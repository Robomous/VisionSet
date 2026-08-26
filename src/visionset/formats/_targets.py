# usage: from visionset.formats._targets import self_target
"""The one-target declaration every non-YOLO exporter shares.

An exporter that is not a trainer's format still declares exactly one target,
named after itself, family ``other``, with no trainer tasks — so a surface
renders one control for every export rather than a target select beside a
format select. Spelled once here for the same reason ``_layout`` exists:
the day two spellings of the rule disagree, the catalog and the format list
stop describing the same thing.

Private to :mod:`visionset.formats`, like ``_layout``: importable, but not part
of the ``Exporter`` contract.
"""

from __future__ import annotations

from visionset.kernel.domain import (
    ExportTarget,
    GeometryType,
    PreprocessingHints,
    TargetFamily,
)


def self_target(format_name: str, geometries: frozenset[GeometryType]) -> frozenset[ExportTarget]:
    """The whole ``targets`` declaration for a format that is its own target."""
    return frozenset(
        {
            ExportTarget(
                name=format_name,
                label=format_name,
                family=TargetFamily.OTHER,
                tasks=frozenset(),
                supported_geometries=geometries,
                hints=PreprocessingHints(
                    recommended_size=None,
                    recommended_strategy=None,
                    trainer_resizes=True,
                    augmentation_common=False,
                ),
            )
        }
    )
