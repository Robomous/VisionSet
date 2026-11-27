# usage: from visionset.formats.classification_dir import ClassificationDirExporter
"""Class-directory image classification: ``<fold>/<class>/<image>``, one label per picture.

A single-label dialect, independent of the multi-label ``classification``
format and not an alias of it: a picture's class is the directory it sits in,
so a picture has exactly one, and it is written exactly once.

**Out.** Every class declaring a classification tag gets a directory under
every fold the export writes, used or not, so a loader that numbers classes by
sorted directory name numbers them the same in each fold, and an empty class
survives as an empty directory. A class that cannot carry a tag never appears.
Each picture is written once, named by its content hash, under its fold and the
class of the tag it keeps.

**One tag per picture, never a silent choice.** The format declares
``single_tag``: a picture with several tags keeps the first by class name and
the compatibility report counts the others dropped, and a picture with no tag
is not written and is counted in ``untagged_assets``. The format is lossy, so
the export never runs without consent to that report; a picture is never
copied into a second class directory. Boxes and every other geometry are
dropped, as are attributes, confidence and provenance.

Refused by class: a name that cannot be one portable directory name (see
:func:`name_problem`), and two names equal ignoring case.
"""

from __future__ import annotations

from pathlib import Path

from visionset.formats._layout import DEFAULT_FOLD, folds_of, write_image
from visionset.formats._targets import self_target
from visionset.formats.classification_dir.reader import (
    FORMAT_NAME,
    SPLIT_NAMES,
    ClassificationDirImporter,
    case_collisions,
    name_problem,
)
from visionset.kernel.domain import (
    GeometryType,
    Manifest,
    Release,
    SplitAssignment,
    single_tag,
)
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.ports import ContentReader


class ClassificationDirExporter:
    """Writes a release as a single-label class-directory classification dataset."""

    format_name = FORMAT_NAME

    lossy = True

    single_tag = True

    supported_geometries = frozenset({GeometryType.CLASSIFICATION_TAG})

    degraded_geometries: frozenset[GeometryType] = frozenset()

    supported_modalities = frozenset({"image"})

    targets = self_target(format_name, supported_geometries)

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
        assignment: SplitAssignment | None,
    ) -> None:
        declared = {one.name for one in manifest.classes}
        vocabulary = sorted(
            one.name
            for one in manifest.classes
            if GeometryType.CLASSIFICATION_TAG in one.geometries
        )
        for name in vocabulary:
            problem = name_problem(name)
            if problem is not None:
                raise ExportSourceUnreadable(
                    f"class {name!r} {problem}, so it cannot name a class directory"
                )
        for group in case_collisions(vocabulary):
            raise ExportSourceUnreadable(
                f"classes {', '.join(repr(one) for one in group)} differ only in case, and a "
                "case-insensitive filesystem would hold their directories as one"
            )

        taggable = set(vocabulary)
        folds = folds_of(manifest, assignment)
        written = {
            folds[asset.asset_id]
            for asset in manifest.assets
            if single_tag(asset.annotations)[0] is not None
        }
        for fold in sorted(written) or [DEFAULT_FOLD]:
            for name in vocabulary:
                (dest / fold / name).mkdir(parents=True, exist_ok=True)
        for asset in manifest.assets:
            for annotation in asset.annotations:
                if annotation.label_class not in declared:
                    raise ExportSourceUnreadable(
                        f"asset {asset.asset_id} carries class {annotation.label_class!r}, "
                        f"which the release's schema does not declare"
                    )
            kept, _ = single_tag(asset.annotations)
            if kept is None:
                continue
            if kept.label_class not in taggable:
                raise ExportSourceUnreadable(
                    f"asset {asset.asset_id} carries a tag of class {kept.label_class!r}, "
                    "which the release's schema does not let carry one"
                )
            write_image(asset, dest / folds[asset.asset_id] / kept.label_class, content)


__all__ = [
    "SPLIT_NAMES",
    "ClassificationDirExporter",
    "ClassificationDirImporter",
]
