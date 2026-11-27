# usage: from visionset.formats.segmentation_png import SegmentationPngImporter
"""Class-index PNG masks in: one mask per class present in each picture's mask file.

Nothing about the masks is guessed. The source holds a descriptor,
:data:`DESCRIPTOR_FILENAME`, at its top, and the import is refused without one.
It states the encoding, the class each id names, which ids are background and
which are ignore, and where the pictures and masks are:

- ``"encoding": "index"`` — each pixel's grey level is its id: an 8-bit (``L``)
  or 16-bit (``I;16``) greyscale PNG.
- ``"encoding": "palette"`` — each pixel's colour is its id through the
  descriptor's ``palette``, ``{"id": [r, g, b]}``: an indexed (``P``) PNG,
  resolved through its own palette, or an ``RGB`` one.

A mask whose PNG mode is not one of those its encoding names, or that holds an
id or colour the descriptor does not declare, refuses the import by name.

Pictures live under ``<images>/<split>/`` and masks under ``<masks>/<split>/``
for each split the descriptor lists, or directly under ``<images>/`` and
``<masks>/`` when it lists none, so both ``images/`` + ``masks/`` and Pascal
VOC's ``JPEGImages/`` + ``SegmentationClass/`` read. A picture's mask has its
relative path, the suffix replaced by ``<mask_suffix>.png``.

Each class id present becomes one mask over the whole picture. Background ids
become nothing; ignore ids become nothing too and the mask holding them is a
``label`` loss, as KITTI's ``DontCare`` is. A picture with no mask file is not
imported, an ``image`` loss; a mask file with no picture, or one not the size of
its picture, is a ``label`` loss, and the picture of the second is imported
unlabelled. The split is not imported.
"""

from __future__ import annotations

import json
import sys
from array import array
from collections.abc import Sequence
from pathlib import Path, PurePosixPath
from typing import Annotated, Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from visionset.formats._reading import (
    IMAGE_SUFFIXES,
    Losses,
    files_under,
    measure,
    relative,
    to_dataset,
)
from visionset.kernel.domain import (
    GeometryType,
    ImportedClass,
    ImportedDataset,
    ImportedImage,
    ImportedLabel,
    ImportLossKind,
    require_relative_path,
    split_class_map,
)
from visionset.kernel.errors import ImportSourceUnreadable

FORMAT_NAME: Final = "segmentation-png"
DESCRIPTOR_FILENAME: Final = "segmentation.json"
DESCRIPTOR_VERSION: Final = 1
MASK_SUFFIX: Final = ".png"

#: The largest id a 16-bit PNG can hold.
MAX_CLASS_ID: Final = 65_535

#: The PNG modes each encoding reads, as Pillow names them.
MODES: Final[dict[str, frozenset[str]]] = {
    "index": frozenset({"L", "I;16"}),
    "palette": frozenset({"P", "RGB"}),
}

_LABEL: Final = "segmentation-png"

_EXAMPLE: Final = (
    '{"format": "segmentation-png", "version": 1, "encoding": "index", '
    '"classes": {"1": "road", "7": "car"}, "background": [0], "ignore": [255], '
    '"images": "images", "masks": "masks", "splits": ["train", "val"]}'
)

ClassId = Annotated[int, Field(strict=True, ge=0, le=MAX_CLASS_ID)]
Channel = Annotated[int, Field(strict=True, ge=0, le=255)]


class SegmentationDescriptor(BaseModel):
    """What :data:`DESCRIPTOR_FILENAME` states; every field but two is required.

    ``classes`` keys are ids written as JSON strings. ``palette`` is given
    exactly when ``encoding`` is ``palette``. ``mask_suffix`` defaults to none,
    and ``visionset`` is provenance the exporter writes and the import ignores.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    format: Literal["segmentation-png"]
    version: Literal[1]
    encoding: Literal["index", "palette"]
    classes: dict[Annotated[int, Field(ge=0, le=MAX_CLASS_ID)], str]
    background: tuple[ClassId, ...]
    ignore: tuple[ClassId, ...]
    images: str
    masks: str
    splits: tuple[str, ...]
    palette: (
        dict[Annotated[int, Field(ge=0, le=MAX_CLASS_ID)], tuple[Channel, Channel, Channel]] | None
    ) = None
    mask_suffix: str = ""
    visionset: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _consistent(self) -> SegmentationDescriptor:
        names = [name.strip() for name in self.classes.values()]
        if not all(names):
            raise ValueError("every class needs a name")
        if len({name.casefold() for name in names}) != len(names):
            raise ValueError("two classes share a name")
        roles = [set(self.classes), set(self.background), set(self.ignore)]
        if sum(len(role) for role in roles) != len(set().union(*roles)):
            raise ValueError("an id is named in more than one of classes, background and ignore")
        if (self.encoding == "palette") != (self.palette is not None):
            raise ValueError("a palette is given exactly when the encoding is palette")
        if self.palette is not None:
            stray = set(self.palette) - set().union(*roles)
            if stray:
                raise ValueError(
                    f"palette ids {sorted(stray)} are not classes, background or ignore"
                )
            if len(set(self.palette.values())) != len(self.palette):
                raise ValueError("two palette ids share a colour")
        for directory in (self.images, self.masks):
            require_relative_path(directory)
        if PurePosixPath(self.images) == PurePosixPath(self.masks):
            raise ValueError("images and masks are different directories")
        if len(set(self.splits)) != len(self.splits) or not all(
            split and "/" not in split and require_relative_path(split) for split in self.splits
        ):
            raise ValueError("splits are distinct single directory names")
        if "/" in self.mask_suffix or "\\" in self.mask_suffix:
            raise ValueError("mask_suffix is part of a file name")
        return self


def read_descriptor(src: Path) -> SegmentationDescriptor:
    """The source's descriptor, refused with how to write one when absent or invalid."""
    path = src / DESCRIPTOR_FILENAME
    if not path.is_file():
        raise ImportSourceUnreadable(
            f"the {_LABEL} source {src.name!r} has no {DESCRIPTOR_FILENAME} at its top. Masks "
            f"are not guessed: write one stating the encoding (index or palette, with a "
            f"palette of colours for palette), the class each id names, the background and "
            f"ignore ids and the layout, for example {_EXAMPLE}"
        )
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        return SegmentationDescriptor.model_validate(document)
    except (OSError, ValueError, RecursionError) as exc:
        reason = exc if not isinstance(exc, ValidationError) else _first_errors(exc)
        raise ImportSourceUnreadable(
            f"{DESCRIPTOR_FILENAME} is not a valid descriptor: {reason}. For example {_EXAMPLE}"
        ) from None


def _first_errors(exc: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(str(part) for part in error['loc']) or 'descriptor'}: {error['msg']}"
        for error in exc.errors()[:3]
    )


class SegmentationPngImporter:
    """Reads class-index PNG masks, as a descriptor states them, into an ``ImportedDataset``."""

    format_name = FORMAT_NAME

    def read(self, src: Path) -> ImportedDataset:
        if not src.is_dir():
            raise ImportSourceUnreadable(f"the {_LABEL} source {src.name!r} is not a directory")
        descriptor = read_descriptor(src)
        losses: Losses = Losses()
        images: list[ImportedImage] = []
        for split in descriptor.splits or ("",):
            images.extend(self._split(src, descriptor, split, losses))
        classes = (
            ImportedClass(name=name, geometries=(GeometryType.MASK,))
            for _, name in sorted(descriptor.classes.items())
        )
        return to_dataset(classes, images, losses, _LABEL)

    def _split(
        self, src: Path, descriptor: SegmentationDescriptor, split: str, losses: Losses
    ) -> list[ImportedImage]:
        image_root = _directory(src, descriptor.images, split)
        mask_root = _directory(src, descriptor.masks, split)
        masks: dict[PurePosixPath, Path] = {}
        stray = 0
        for path in files_under(src, mask_root, {MASK_SUFFIX}):
            key = _mask_key(path.relative_to(mask_root), descriptor.mask_suffix)
            if key is None:
                stray += 1
            else:
                masks[key] = path

        images: list[ImportedImage] = []
        claimed: set[PurePosixPath] = set()
        unmasked = 0
        for picture in files_under(src, image_root, IMAGE_SUFFIXES):
            key = PurePosixPath(picture.relative_to(image_root).as_posix()).with_suffix("")
            if key in claimed:
                raise ImportSourceUnreadable(
                    f"two pictures under {relative(src, image_root)!r} claim the mask "
                    f"of {str(key)!r}"
                )
            mask = masks.get(key)
            if mask is None:
                unmasked += 1
                continue
            claimed.add(key)
            images.append(self._image(src, picture, mask, descriptor, losses))

        stray += len(set(masks) - claimed)
        where = relative(src, image_root)
        if unmasked:
            losses[
                (ImportLossKind.IMAGE, where, "a picture with no mask file is not imported")
            ] += unmasked
        if stray:
            losses[
                (ImportLossKind.LABEL, relative(src, mask_root), "a mask file with no picture")
            ] += stray
        return images

    def _image(
        self,
        src: Path,
        picture: Path,
        mask: Path,
        descriptor: SegmentationDescriptor,
        losses: Losses,
    ) -> ImportedImage:
        path = PurePosixPath(relative(src, picture))
        where = relative(src, mask)
        size = measure(picture)
        values, width, height = read_class_map(mask, descriptor, where)
        if size is None:
            losses[
                (
                    ImportLossKind.LABEL,
                    where,
                    "its picture's size cannot be read, so it is not imported",
                )
            ] += 1
            return ImportedImage(path=path)
        if size != (width, height):
            losses[
                (
                    ImportLossKind.LABEL,
                    where,
                    f"it is {width} by {height} and its picture {size[0]} by {size[1]}; "
                    "its labels are not imported",
                )
            ] += 1
            return ImportedImage(path=path, width=size[0], height=size[1])
        present = set(values)
        unknown = (
            present - set(descriptor.classes) - set(descriptor.background) - set(descriptor.ignore)
        )
        if unknown:
            raise ImportSourceUnreadable(
                f"mask {where!r} holds ids {sorted(unknown)[:10]} that {DESCRIPTOR_FILENAME} does "
                "not declare as a class, background or ignore"
            )
        if present & set(descriptor.ignore):
            losses[
                (
                    ImportLossKind.LABEL,
                    "ignore",
                    "ignored pixels mark an area left unlabelled, which no geometry holds",
                )
            ] += 1
        masks = split_class_map(
            values,
            height=height,
            width=width,
            ignore={*descriptor.background, *descriptor.ignore},
        )
        return ImportedImage(
            path=path,
            width=width,
            height=height,
            labels=tuple(
                ImportedLabel(class_name=descriptor.classes[class_id].strip(), geometry=geometry)
                for class_id, geometry in masks.items()
            ),
        )


def read_class_map(
    path: Path, descriptor: SegmentationDescriptor, where: str
) -> tuple[Sequence[int], int, int]:
    """The mask's ids row-major, and its width and height, decoded as the descriptor says.

    Raises:
        ImportSourceUnreadable: the file is not a readable PNG, its mode is not
            one the encoding reads, or a colour is not in the palette.
    """
    from PIL import Image

    try:
        with Image.open(path) as image:
            image_format, mode, (width, height) = image.format, image.mode, image.size
            if image_format == "PNG" and mode in MODES[descriptor.encoding]:
                image.load()
                data = image.tobytes()
                palette = image.getpalette("RGB") if mode == "P" else None
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
        raise ImportSourceUnreadable(f"mask {where!r} is not a readable PNG: {exc}") from None
    if image_format != "PNG":
        raise ImportSourceUnreadable(f"mask {where!r} is a {image_format} file, not a PNG")
    if mode not in MODES[descriptor.encoding]:
        allowed = " or ".join(sorted(MODES[descriptor.encoding]))
        raise ImportSourceUnreadable(
            f"mask {where!r} is a {mode} PNG, and {DESCRIPTOR_FILENAME} says its encoding is "
            f"{descriptor.encoding}, which reads {allowed}"
        )
    if mode == "L":
        return data, width, height
    if mode == "I;16":
        wide = array("H")
        wide.frombytes(data)
        if sys.byteorder == "big":
            wide.byteswap()
        return wide, width, height
    assert descriptor.palette is not None
    by_colour = {bytes(colour): class_id for class_id, colour in descriptor.palette.items()}
    if palette is not None:
        colours = [bytes(palette[i : i + 3]) for i in range(0, len(palette), 3)]
        table = [by_colour.get(colour, -1) for colour in colours]
        table.extend([-1] * (256 - len(table)))
        unknown = sorted(index for index in set(data) if table[index] < 0)
        if unknown:
            shown = [
                tuple(colours[index]) if index < len(colours) else None for index in unknown[:5]
            ]
            raise ImportSourceUnreadable(
                f"mask {where!r} holds palette indexes {unknown[:10]} whose colours {shown} "
                f"are not in the {DESCRIPTOR_FILENAME} palette"
            )
        return [table[index] for index in data], width, height
    pixels = [data[i : i + 3] for i in range(0, len(data), 3)]
    missing = {pixel for pixel in set(pixels) if pixel not in by_colour}
    if missing:
        listed = sorted(tuple(pixel) for pixel in missing)[:5]
        raise ImportSourceUnreadable(
            f"mask {where!r} holds colours {listed} that are not in the "
            f"{DESCRIPTOR_FILENAME} palette"
        )
    return [by_colour[pixel] for pixel in pixels], width, height


def _directory(src: Path, directory: str, split: str) -> Path:
    path = src / directory / split if split else src / directory
    if not path.is_dir():
        shown = relative(src, path) if path.is_relative_to(src) else str(path)
        raise ImportSourceUnreadable(
            f"{DESCRIPTOR_FILENAME} names the directory {shown!r}, which the source does not hold"
        )
    return path


def _mask_key(path: Path, suffix: str) -> PurePosixPath | None:
    stem = PurePosixPath(path.as_posix()).with_suffix("")
    if not suffix:
        return stem
    if not stem.name.endswith(suffix) or stem.name == suffix:
        return None
    return stem.with_name(stem.name[: -len(suffix)])


__all__ = [
    "DESCRIPTOR_FILENAME",
    "DESCRIPTOR_VERSION",
    "FORMAT_NAME",
    "MASK_SUFFIX",
    "MAX_CLASS_ID",
    "SegmentationDescriptor",
    "SegmentationPngImporter",
    "read_class_map",
    "read_descriptor",
]
