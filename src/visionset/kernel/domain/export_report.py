# usage: from visionset.kernel.domain import ExportResult, ExportPreprocessing
"""What one run of an exporter left on disk, and what pre-processing did to it.

Its own module rather than a tail of ``release.py`` because the report names a
:class:`RecipeSpec`, and the recipe module already reads the manifest's
canonical encoder from ``release.py`` — the two would import each other. This
module sits above both.
"""

from __future__ import annotations

from pathlib import Path
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from visionset.kernel.domain.preprocessing import RecipeSpec
from visionset.kernel.domain.release import ExportCompatibility


class ExportFileMapping(BaseModel):
    """One image the export wrote, traced to the manifest asset it came from.

    ``file`` is the path the exporter chose, relative to the export directory.
    ``source_content_hash`` is the manifest asset's hash — the blob the bytes
    were derived from — and ``exported_sha256`` is the digest of what was
    written, which differs from the source for every resized or augmented
    file. ``variant`` 0 is the base image; augmented variants count from 1.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    file: str
    source_content_hash: str
    exported_sha256: str
    variant: int = Field(ge=0)


class ExportPreprocessing(BaseModel):
    """The recipe an export applied, snapshotted by value, and what it produced.

    ``spec`` is the recipe as it stood at export time and ``recipe_hash`` names
    that value, so editing or deleting the stored recipe afterwards changes
    nothing here. ``recipe_name`` is informational: which stored recipe the
    caller pointed at, or ``None`` for a spec handed over directly.
    ``pillow_version`` says which codecs produced the bytes, because byte
    stability is promised within one environment only.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    recipe_name: str | None
    spec: RecipeSpec
    recipe_hash: str
    pillow_version: str
    mapping: tuple[ExportFileMapping, ...] = ()


class ExportResult(BaseModel):
    """What one run of an exporter left on disk.

    Small on purpose. The exporter writes a directory and returns nothing, so
    without this a caller has no answer at all — and a caller that reaches an
    export through something other than HTTP (the CLI, an MCP tool) needs one,
    because it never sees the bytes. The REST route hands back the files
    themselves and uses these numbers only to describe what it is sending.

    ``file_count`` and ``total_bytes`` are counted by walking ``directory``
    after the plugin returns rather than reported by the plugin itself: an
    exporter that miscounts its own output would then be trusted about it, and
    the whole point of the number is to be checkable. It also means a plugin
    that writes nothing — ``DummyExporter`` does exactly that — reports zero
    rather than lying.

    The four source/augmented counts separate what the release held from what
    a recipe added. ``source_file_count`` and ``augmented_file_count`` count
    the *images* the plugin read through the content reader and wrote — base
    images and augmented variants — so labels and descriptors stay in
    ``file_count`` alone; ``file_count`` is the total of everything written.
    The annotation pair counts the labels handed to the plugin the same way.

    Not frozen for the usual immutability argument but for the same one every
    report here uses: this describes a moment that has already passed.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    release_id: UUID
    format_name: str
    target: str | None = None
    #: What the format would drop, worked out before anything was written.
    #:
    #: Carried on the result as well as written into ``directory`` because a
    #: caller that never sees the bytes — the CLI, an MCP tool, an SDK user —
    #: would otherwise have to open the file to learn what it consented to.
    compatibility: ExportCompatibility
    #: Where the files were written. Absolute, and the caller's own choice —
    #: the kernel never picks a location.
    directory: Path
    file_count: int = Field(default=0, ge=0)
    total_bytes: int = Field(default=0, ge=0)
    source_file_count: int = Field(default=0, ge=0)
    augmented_file_count: int = Field(default=0, ge=0)
    source_annotation_count: int = Field(default=0, ge=0)
    augmented_annotation_count: int = Field(default=0, ge=0)
    #: The recipe applied, or ``None`` for an export that applied no transform.
    preprocessing: ExportPreprocessing | None = None
