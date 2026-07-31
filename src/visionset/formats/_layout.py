# usage: from visionset.formats._layout import folds_of, write_image
"""What every image-laying-out format does the same way.

Promoted out of the YOLO exporter when COCO arrived and needed all of it —
"promoted, not copied", the rule the kernel already follows for a gate two
services share. The alternative is two spellings of "which fold is this asset
in", and the day they disagree an export's split stops matching
``GET /releases/{id}/assignment`` with nothing to notice it.

Private to :mod:`visionset.formats`. A third-party distribution registering its
own plugin is welcome to import this — it is ordinary Python — but nothing here
is part of the ``Exporter`` contract, and the port is what a plugin is judged
against.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Final
from uuid import UUID

from visionset.kernel.domain import Manifest, ManifestAsset, Release, assign_split
from visionset.kernel.errors import ExportSourceUnreadable
from visionset.kernel.ports import ContentReader

#: Where the pictures go, under ``dest`` and then under the fold's name.
#:
#: Shared because both formats lay images out the same way, and because YOLO's
#: label lookup is a *string substitution* of ``/images/`` for ``/labels/`` on the
#: resolved image path — so this name is load-bearing there and merely
#: conventional here.
IMAGES_DIRNAME: Final = "images"

#: The fold every asset lands in when a release was published without a recipe.
#:
#: One undivided set, named ``train`` because that is the fold every downstream
#: tool assumes exists; three empty folds would be a split nobody asked for.
DEFAULT_FOLD: Final = "train"

#: The folds a recipe can produce, in the order a reader expects them.
FOLDS: Final = ("train", "val", "test")

#: What the first bytes of a file say it is, and the suffix to give it.
#:
#: Sniffed rather than taken from ``ManifestAsset.uri``, because a ``uri`` is not
#: a filename: a frame cut out of a clip is recorded as
#: ``/clips/drive.mp4#frame=12``, whose suffix would name the container it came
#: out of. Three signatures, and anything else is refused by name rather than
#: written under a guessed extension — a trainer that cannot decode an image it
#: was handed fails much later and much less clearly.
_SIGNATURES: Final[tuple[tuple[bytes, str], ...]] = (
    (b"\xff\xd8\xff", ".jpg"),
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"RIFF", ".webp"),
)

_SIGNATURE_BYTES: Final = max(len(signature) for signature, _ in _SIGNATURES)


def folds_of(release: Release, manifest: Manifest) -> dict[UUID, str]:
    """Which fold each asset belongs to, keyed by asset id.

    Computed from the release's own recipe and its own frozen asset set, which is
    the same call ``ReleaseService.assignment`` makes — a plugin does not need the
    service, because ``assign_split`` is a pure function of a recipe and a
    sequence of manifest assets. An export is therefore reproducible from the
    release alone, on any machine, forever, and it agrees with what the API
    reports for the same release because it is the same function.
    """
    if release.split is None:
        return {asset.asset_id: DEFAULT_FOLD for asset in manifest.assets}
    assignment = assign_split(release.split, manifest.assets)
    return {
        asset_id: fold
        for fold, members in zip(
            FOLDS, (assignment.train, assignment.val, assignment.test), strict=True
        )
        for asset_id in members
    }


def image_name(asset: ManifestAsset, suffix: str) -> str:
    """What one asset's picture is called on disk.

    The content hash, and the argument is what it replaces. Using the original
    filename means a de-duplicating suffix when two sources hold ``img001.jpg``,
    which makes the mapping depend on iteration order and lets one picture land
    twice under two names. A hash is stable across machines and runs and cannot
    collide. The cost is that the names are not human-readable, which a directory
    destined for a trainer does not need.
    """
    return f"{asset.content_hash}{suffix}"


def write_image(asset: ManifestAsset, into: Path, content: ContentReader) -> str:
    """Copy one asset's bytes into ``into``, and answer what it was called.

    Streamed with ``shutil.copyfileobj`` rather than read whole: a release is
    every image somebody is about to train on, and holding one 4K frame in memory
    at a time is a choice where holding none is available.

    Nothing is swallowed. ``content`` raises :class:`ExportSourceUnreadable` for a
    blob that is gone, and undecodable bytes are refused here by name — an export
    that quietly skipped an image would write a training set silently short of it
    while its labels claimed otherwise.
    """
    into.mkdir(parents=True, exist_ok=True)
    with content(asset.content_hash) as stream:
        head = stream.read(_SIGNATURE_BYTES)
        name = image_name(asset, _suffix_for(head, asset))
        with (into / name).open("wb") as handle:
            handle.write(head)
            shutil.copyfileobj(stream, handle)
    return name


def dimensions_of(asset: ManifestAsset) -> tuple[int, int]:
    """The recorded pixel size, or refuse by name.

    Never a fallback. A previous generation of this tool answered ``(1, 1)`` when
    it could not parse a size, which does not fail — it turns a normalization into
    the identity and writes a width in pixels where a fraction was promised, and
    the dataset loads, trains, and is wrong.
    """
    if asset.width is None or asset.height is None:
        raise ExportSourceUnreadable(
            f"asset {asset.asset_id} has no recorded pixel size, so its annotations "
            f"cannot be written in a format that needs one"
        )
    return asset.width, asset.height


def _suffix_for(head: bytes, asset: ManifestAsset) -> str:
    for signature, suffix in _SIGNATURES:
        if head.startswith(signature):
            return suffix
    raise ExportSourceUnreadable(
        f"asset {asset.asset_id} ({asset.content_hash}) is not a JPEG, PNG or WebP, "
        f"so it cannot be written into an image dataset"
    )
