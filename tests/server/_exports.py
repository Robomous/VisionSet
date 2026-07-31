"""Exporters a test can tell apart from the one that ships.

`DummyExporter` writes nothing and declares itself lossless, which is the right
plugin to ship and the wrong one to test against: an export that silently did
nothing and an export that worked produce the same empty archive, and the lossy
refusal has no way to fire at all.

So the two interesting shapes live here — one that writes files, one that
declares itself lossy — and they reach the app through `dependency_overrides` on
`get_exporters`, the seam that dependency exists for. Nothing is registered into
the real entry-point group; `tests/formats/test_registry.py` is what covers the
discovery path, and this covers what happens after.

Plain classes in a private module, the `_probe.py` / `_runner.py` precedent, and
still no `conftest.py` anywhere.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import FastAPI

from visionset.kernel.domain import GeometryType, Manifest, Release
from visionset.kernel.ports import ContentReader, Exporter
from visionset.server.dependencies import get_exporters


class WritingExporter:
    """Writes two files, so an archive of its output has something in it.

    The nested one is deliberate: `ReleaseService.export` counts with `rglob`,
    and an exporter laying its output out in subdirectories is the ordinary case
    for a real format rather than an exotic one.
    """

    format_name = "writing"
    lossy = False

    #: #65's capability declaration. Everything, so this double's *subject* stays
    #: what it was — the file it writes, or the flag it sets — rather than a
    #: geometry report nobody wrote this test for.
    supported_geometries = frozenset(GeometryType)
    supported_modalities = frozenset({"image"})

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        (dest / "manifest.json").write_text(json.dumps({"tag": release.tag}))
        (dest / "images").mkdir()
        (dest / "images" / "listing.txt").write_text(
            "\n".join(asset.content_hash for asset in manifest.assets)
        )


class LossyExporter:
    """Declares itself lossy and writes one file, so consent can be tested both ways."""

    format_name = "lossy"
    lossy = True

    #: #65's capability declaration. Everything, so this double's *subject* stays
    #: what it was — the file it writes, or the flag it sets — rather than a
    #: geometry report nobody wrote this test for.
    supported_geometries = frozenset(GeometryType)
    supported_modalities = frozenset({"image"})

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        (dest / "boxes-only.txt").write_text(str(len(manifest.assets)))


def with_exporters(app: FastAPI, *plugins: Exporter) -> None:
    """Serve exactly these formats, replacing whatever is installed.

    Replaces rather than adds, so a test asserting on `GET /formats` sees a set
    it chose. `DummyExporter` is still covered — by the registry tests, and by
    the ones here that deliberately do not override.
    """
    app.dependency_overrides[get_exporters] = lambda: {
        plugin.format_name: plugin for plugin in plugins
    }


class BoxesOnlyExporter:
    """Lossless by its own declaration, and able to write only boxes.

    The pair #65 exists for: nothing about the *format* asks for consent, so a
    refusal against this one is entirely about what the release holds.
    """

    format_name = "boxes-only"
    lossy = False

    supported_geometries = frozenset({GeometryType.BBOX})
    supported_modalities = frozenset({"image"})

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        (dest / "boxes.txt").write_text(str(len(manifest.assets)))


class PolygonsOnlyExporter:
    """Lossless, and able to write only polygons — so a bbox release excludes everything."""

    format_name = "polygons-only"
    lossy = False

    supported_geometries = frozenset({GeometryType.POLYGON})
    supported_modalities = frozenset({"image"})

    def export(
        self,
        release: Release,
        manifest: Manifest,
        dest: Path,
        *,
        content: ContentReader,
    ) -> None:
        (dest / "polygons.txt").write_text(str(len(manifest.assets)))
