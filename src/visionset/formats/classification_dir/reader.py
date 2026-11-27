# usage: from visionset.formats.classification_dir import ClassificationDirImporter
"""Class-directory classification in: ``<split>/<class>/<image>``, or ``<class>/<image>``.

The inverse of :class:`ClassificationDirExporter`. Each directory directly
under a split is a class, and each picture in it carries that class's tag and
no other. Without ``train``, ``val`` or ``test`` at the top, the top-level
directories are the classes. The split a picture sits in is not imported, as
no importer imports one; ``valid`` and ``validation`` are read as ``val``.

Every class directory is a class, sorted by name, an empty one included. A
name is kept verbatim, and refused when it is not NFC-normalized, not UTF-8,
holds a control character or surrounding whitespace, or matches another class
ignoring case. Refused as well: a directory inside a class directory, split
directories beside other directories, two directories naming one split, a
symbolic link to a directory or a file resolving outside the source, and the
same bytes filed under two classes, since a single-label tree cannot mean both.

A picture outside every class directory, and a file in a class directory that
is not a picture this import reads, are image losses. Entries whose name starts
with a dot are skipped as filesystem metadata; a skipped picture, and a skipped
directory directly under a split, are image losses. Other files outside class
directories, such as a README, are ignored.
"""

from __future__ import annotations

import hashlib
import unicodedata
from collections import defaultdict
from pathlib import Path, PurePosixPath
from typing import Final

from visionset.formats._reading import IMAGE_SUFFIXES, Losses, contained, relative, to_dataset
from visionset.kernel.domain import (
    ClassificationGeometry,
    GeometryType,
    ImportedClass,
    ImportedDataset,
    ImportedImage,
    ImportedLabel,
    ImportLossKind,
)
from visionset.kernel.errors import ImportSourceUnreadable

FORMAT_NAME: Final = "classification-dir"

#: Each split directory name read, and the fold it names.
SPLIT_NAMES: Final = {
    "train": "train",
    "val": "val",
    "valid": "val",
    "validation": "val",
    "test": "test",
}

_LABEL: Final = "class-directory"
_CHUNK: Final = 1 << 20
_OUTSIDE: Final = "a picture outside every class directory"
_HIDDEN_PICTURE: Final = "a picture whose name starts with a dot is skipped"
_HIDDEN_DIRECTORY: Final = "a directory whose name starts with a dot is skipped, with all it holds"


def name_problem(name: str) -> str | None:
    """Why ``name`` cannot be a class directory, or ``None`` when it can."""
    try:
        name.encode("utf-8")
    except UnicodeEncodeError:
        return "is not valid UTF-8"
    if not name.strip():
        return "is blank"
    if name != name.strip():
        return "has leading or trailing whitespace"
    if name in {".", ".."} or "/" in name or "\\" in name:
        return "cannot be a single directory name"
    if name.startswith("."):
        return "starts with a dot, which marks a hidden directory"
    if any(unicodedata.category(char) == "Cc" for char in name):
        return "holds a control character"
    if not unicodedata.is_normalized("NFC", name):
        return "is not NFC-normalized; rename it to its NFC form"
    return None


def case_collisions(names: list[str]) -> list[list[str]]:
    """Groups of distinct names equal ignoring case, which one filesystem may hold as one."""
    by_key: defaultdict[str, set[str]] = defaultdict(set)
    for name in names:
        by_key[name.casefold()].add(name)
    return [sorted(group) for group in by_key.values() if len(group) > 1]


class ClassificationDirImporter:
    """Reads a class-directory classification dataset into an ``ImportedDataset``."""

    format_name = FORMAT_NAME

    def read(self, src: Path) -> ImportedDataset:
        if not src.is_dir():
            raise ImportSourceUnreadable(f"the {_LABEL} source {src.name!r} is not a directory")
        root = src.resolve()
        losses: Losses = Losses()
        top: Losses = Losses()
        directories, files = _entries(src, root, src, top)
        containers = _splits(src, directories) or [src]
        if containers != [src]:
            losses.update(top)
            _count_outside(src, files, losses)

        classes: set[str] = set()
        pictures: list[tuple[PurePosixPath, str, Path]] = []
        for container in containers:
            class_dirs, stray = _entries(
                src, root, container, losses, hidden_directories=container != src
            )
            _count_outside(src, stray, losses)
            for directory in class_dirs:
                where = relative(src, directory)
                problem = name_problem(directory.name)
                if problem is not None:
                    raise ImportSourceUnreadable(f"class directory {where!r} {problem}")
                classes.add(directory.name)
                nested, inside = _entries(src, root, directory, losses)
                if nested:
                    raise ImportSourceUnreadable(
                        f"{relative(src, nested[0])!r} is a directory inside the class directory "
                        f"{where!r}; pictures sit directly under <split>/<class>/ (splits are "
                        f"{', '.join(SPLIT_NAMES)}), so move them up or import a narrower directory"
                    )
                for path in inside:
                    if path.suffix.lower() in IMAGE_SUFFIXES and path.is_file():
                        pictures.append((PurePosixPath(relative(src, path)), directory.name, path))
                    elif path.is_file():
                        reason = f"a {path.suffix.lower() or 'suffixless'} file is not a picture"
                        losses[(ImportLossKind.IMAGE, where, reason)] += 1
                    else:
                        losses[(ImportLossKind.IMAGE, where, "it is not a regular file")] += 1

        if not classes:
            raise ImportSourceUnreadable(
                f"the {_LABEL} source {src.name!r} holds no class directory"
            )
        for group in case_collisions(sorted(classes)):
            raise ImportSourceUnreadable(
                f"class directories {', '.join(repr(one) for one in group)} differ only in case, "
                "and a case-insensitive filesystem holds them as one; rename one"
            )
        _refuse_crossfiled(pictures)

        return to_dataset(
            (
                ImportedClass(name=name, geometries=(GeometryType.CLASSIFICATION_TAG,))
                for name in sorted(classes)
            ),
            (
                ImportedImage(
                    path=path,
                    labels=(ImportedLabel(class_name=name, geometry=ClassificationGeometry()),),
                )
                for path, name, _ in sorted(pictures)
            ),
            losses,
            _LABEL,
        )


def _entries(
    src: Path, root: Path, directory: Path, losses: Losses, *, hidden_directories: bool = False
) -> tuple[list[Path], list[Path]]:
    """The directories and other entries in ``directory``, sorted, dot-entries skipped.

    A skipped picture is an image loss, and so is a skipped directory where a
    class would sit when ``hidden_directories``.
    """
    directories: list[Path] = []
    others: list[Path] = []
    subject = relative(src, directory) if directory != src else "."
    for entry in sorted(directory.iterdir()):
        if entry.name.startswith("."):
            if entry.suffix.lower() in IMAGE_SUFFIXES and not entry.is_dir():
                losses[(ImportLossKind.IMAGE, subject, _HIDDEN_PICTURE)] += 1
            elif hidden_directories and entry.is_dir():
                losses[(ImportLossKind.IMAGE, subject, _HIDDEN_DIRECTORY)] += 1
            continue
        if entry.is_symlink():
            if entry.is_dir():
                raise ImportSourceUnreadable(
                    f"{relative(src, entry)!r} is a symbolic link to a directory; "
                    "linked directories are not followed"
                )
            contained(src, root, entry)
        (directories if entry.is_dir() else others).append(entry)
    return directories, others


def _splits(src: Path, directories: list[Path]) -> list[Path]:
    """The split directories at the top, or none for a flat ``<class>/<image>`` source."""
    splits = [one for one in directories if one.name in SPLIT_NAMES]
    if not splits:
        return []
    others = [one.name for one in directories if one.name not in SPLIT_NAMES]
    if others:
        raise ImportSourceUnreadable(
            f"the {_LABEL} source {src.name!r} holds split directories "
            f"({', '.join(one.name for one in splits)}) beside other directories "
            f"({', '.join(others)}); it is either <split>/<class>/<image> or <class>/<image>"
        )
    named: defaultdict[str, list[str]] = defaultdict(list)
    for one in splits:
        named[SPLIT_NAMES[one.name]].append(one.name)
    for fold, names in named.items():
        if len(names) > 1:
            raise ImportSourceUnreadable(
                f"directories {', '.join(repr(one) for one in names)} all name the {fold} "
                "split; keep one"
            )
    return splits


def _count_outside(src: Path, files: list[Path], losses: Losses) -> None:
    for path in files:
        if path.suffix.lower() in IMAGE_SUFFIXES and path.is_file():
            subject = relative(src, path.parent) if path.parent != src else "."
            losses[(ImportLossKind.IMAGE, subject, _OUTSIDE)] += 1


def _refuse_crossfiled(pictures: list[tuple[PurePosixPath, str, Path]]) -> None:
    """Refuse the same bytes under two classes: one label each is all this layout can say."""
    first: dict[str, tuple[PurePosixPath, str]] = {}
    for path, name, file in sorted(pictures):
        digest = _digest(file, str(path))
        seen = first.setdefault(digest, (path, name))
        if seen[1] != name:
            raise ImportSourceUnreadable(
                f"{str(seen[0])!r} and {str(path)!r} hold the same picture under the classes "
                f"{seen[1]!r} and {name!r}; a class-directory dataset gives a picture one class, "
                "so remove one copy or import it as a multi-label classification dataset"
            )


def _digest(path: Path, where: str) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            while chunk := handle.read(_CHUNK):
                digest.update(chunk)
    except OSError as exc:
        raise ImportSourceUnreadable(f"{where} could not be read: {exc}") from None
    return digest.hexdigest()


__all__ = ["ClassificationDirImporter"]
