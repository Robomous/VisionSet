# formats

[`src/visionset/formats/`](../../../../src/visionset/formats/) holds the exporters. It
is the one place in the distribution built as a **plugin system**: a format is
discovered at runtime through an entry-point group, so a third-party distribution
can ship one and VisionSet finds it without knowing it exists.

## Discovery

```mermaid
flowchart LR
    Meta["installed distributions"] -->|entry-point group\nvisionset.formats| Reg["formats.registry"]
    Reg -->|name -> instance| Surface["cli / server / jobs"]
    Surface -->|Exporter instance| RS["ReleaseService.export"]
    RS -->|manifest + ContentReader| Plugin["the plugin"]
    Plugin --> Dir[("an output directory")]
```

The kernel never resolves a name. `ReleaseService.export` takes an `Exporter`
**instance**, because the `Kernel purity` contract forbids
`visionset.kernel` importing `visionset.formats` - a plugin registry is discovery,
and the kernel is the part that must not do any. So the surface holding the name
does the lookup - `registry.pick(installed, name)` for a format, which also says
whether the name was a deprecated alias, and the port's own `resolve_target` for a
target - never through a dict, so a typo answers a `VisionSetError` rather than a
`KeyError` and a traceback.

## What ships

Eleven plugins in [`pyproject.toml`](../../../../pyproject.toml)'s
`[project.entry-points."visionset.formats"]`:

| Name | Module |
| --- | --- |
| `dummy` | [`_dummy.py`](../../../../src/visionset/formats/_dummy.py) - writes nothing; the registry's own test subject |
| `ultralytics` | [`ultralytics/`](../../../../src/visionset/formats/ultralytics/) - `data.yaml` with `path` and `names` as a mapping; `yolo` is accepted as an alias for one release |
| `yolov5-yaml` | [`yolov5_yaml/`](../../../../src/visionset/formats/yolov5_yaml/) - `data.yaml` with `nc` and `names` as a list; shares [`_yolo_writer.py`](../../../../src/visionset/formats/_yolo_writer.py) with `ultralytics` |
| `coco` | [`coco/`](../../../../src/visionset/formats/coco/) |
| `voc` | [`voc/`](../../../../src/visionset/formats/voc/) |
| `classification` | [`classification/`](../../../../src/visionset/formats/classification/) - `labels.csv`, one row per (image, tag) |
| `tusimple`, `curvelanes`, `bdd100k-lane`, `culane`, `openlane-2d` | [`lanes/`](../../../../src/visionset/formats/lanes/) - five plugins over one shared core |

## What a plugin declares

The `Exporter` port ([`kernel/ports/exporter.py`](../../../../src/visionset/kernel/ports/exporter.py))
asks for three capability facts, and the split between them is the interesting
part:

- `lossy` - a blanket statement about everything a capability list cannot see:
  attributes, confidence, provenance. True or false for the format, forever.
- `supported_geometries` - what it writes **intact**.
- `degraded_geometries` - what it writes **having lost something**, such as a
  polygon arriving as its axis-aligned bounding box.

The last two are disjoint, and a geometry in neither is not written at all. Three
states rather than two, because a boolean answers "is this written?" and "is this
written intact?" with one word - and a caller consenting to lose three annotations
would receive two of them back as boxes.

Beside them sits `targets`: the models the format writes for, each a frozen
`ExportTarget` with its tasks, the geometries an export addressed to it carries, and
the pre-processing hints a recipe editor preselects. A format that is not a trainer's
declares one target named after itself, so every surface renders one control. The
registry validates the declarations at the scan - a target promising a geometry the
format never writes, or one name declared by two formats, is refused there - and the
kernel derives the catalog `GET /export-targets`, `visionset target list` and
`list_export_targets` all render. [`docs/content/releases.md`](../../releases.md#export-targets)
carries the catalog and the narrowing rule.

## The sibling group: preprocessing drivers

[`src/visionset/preprocessing/`](../../../../src/visionset/preprocessing/) is the
same mechanism one port over. `PreprocessingDriver`
([`kernel/ports/preprocessing.py`](../../../../src/visionset/kernel/ports/preprocessing.py))
is the port a pixel engine implements - `step_kinds` and `apply(step, image, *, seed,
variant)` - and `preprocessing.registry` scans the `visionset.preprocessing`
entry-point group, keeps what satisfies the port and keys it by step kind, with
`drivers()`, `pick()`, `driver_for()` and `driver()` mirroring the format registry's
shape. The two built-in drivers, `pillow-resize` and `pillow-augment`, live in
[`pillow/`](../../../../src/visionset/preprocessing/pillow/). The kernel takes driver
instances through `ReleaseService.export(..., drivers=)` and never a name, and the
purity contract forbids it importing this package for the reason it forbids
`formats`. [`docs/content/preprocessing.md`](../../preprocessing.md) covers what a
recipe is and what the drivers promise.

A plugin also gets a `ContentReader` and never a `BlobStore`: a reader can read
where the port could also `put`, and a plugin that could write into the content
store could give a release bytes nobody published.

## The gate that keeps a report honest

[`tests/formats/test_report_agreement.py`](../../../../tests/formats/test_report_agreement.py)
reads every count back out of the written artifacts and compares it against what
the compatibility report claimed. A fourth exporter registering into the group
either lands a counter there or is declared as one that writes nothing - a format
cannot be added and quietly skipped.

## Related

[`docs/content/releases.md`](../../releases.md) covers the artifact being exported.
`ReleaseService`'s own docstring covers the consent gate.
