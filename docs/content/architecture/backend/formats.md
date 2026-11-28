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

Forty-five plugins in [`pyproject.toml`](../../../../pyproject.toml)'s
`[project.entry-points."visionset.formats"]`: the twenty-four exporters below and twenty-one importers,
`ultralytics-import`, `yolov5-yaml-import`, `darknet-import`, `yolo-obb-import`, `dota-import`,
`coco-import`, `coco-panoptic-import`, `segmentation-png-import`, `voc-import`, `labelme-import`,
`createml-import`, `open-images-import`, `tfrecord-import`,
`classification-import`, `classification-dir-import`, `openlane-2d-import`, `kitti-import`, `mot-import`, `cvat-images-import`,
`cvat-video-import` and `nuscenes-import` (see [Importers](#importers)).

| Name | Module |
| --- | --- |
| `ultralytics` | [`ultralytics/`](../../../../src/visionset/formats/ultralytics/) - `data.yaml` with `path` and `names` as a mapping; `yolo` is accepted as an alias for one release |
| `yolov5-yaml` | [`yolov5_yaml/`](../../../../src/visionset/formats/yolov5_yaml/) - `data.yaml` with `nc` and `names` as a list; shares [`_yolo_writer.py`](../../../../src/visionset/formats/_yolo_writer.py) with `ultralytics` |
| `darknet` | [`darknet/`](../../../../src/visionset/formats/darknet/) - `obj.data`, `obj.names` and `train.txt`/`valid.txt` image lists; shares [`_yolo_writer.py`](../../../../src/visionset/formats/_yolo_writer.py) with `ultralytics` |
| `yolo-obb` | [`yolo_obb/`](../../../../src/visionset/formats/yolo_obb/) - Ultralytics OBB rows, four normalized corners per rotated box, under the `ultralytics` layout and `data.yaml`; shares [`_yolo_writer.py`](../../../../src/visionset/formats/_yolo_writer.py) and the corner rules in [`_obb.py`](../../../../src/visionset/formats/_obb.py) |
| `dota` | [`dota/`](../../../../src/visionset/formats/dota/) - `<fold>/images` and `<fold>/labelTxt`, four pixel corners, a category and `difficult` per rotated box; shares [`_obb.py`](../../../../src/visionset/formats/_obb.py) with `yolo-obb` |
| `coco` | [`coco/`](../../../../src/visionset/formats/coco/) - boxes, polygons and masks as compressed RLE |
| `coco-panoptic` | [`coco_panoptic/`](../../../../src/visionset/formats/coco_panoptic/) - `panoptic_<fold>.json` and one RGB segment PNG per picture; masks whole, polygons rasterized, overlaps refused |
| `segmentation-png` | [`segmentation_png/`](../../../../src/visionset/formats/segmentation_png/) - one class-index PNG per picture and the `segmentation.json` descriptor its importer requires; masks whole, polygons rasterized |
| `voc` | [`voc/`](../../../../src/visionset/formats/voc/) |
| `labelme` | [`labelme/`](../../../../src/visionset/formats/labelme/) - one LabelMe JSON document beside each picture, rectangles and polygons in pixels |
| `createml` | [`createml/`](../../../../src/visionset/formats/createml/) - one Apple Create ML object-detection JSON array beside the pictures of each folder, boxes as centre and size in pixels |
| `open-images` | [`open_images/`](../../../../src/visionset/formats/open_images/) - one Open Images `<split>-annotations-bbox.csv` of normalized corners per split, the pictures under `<split>/` and a `class-descriptions-boxable.csv` |
| `tfrecord` | [`tfrecord/`](../../../../src/visionset/formats/tfrecord/) - TensorFlow Object Detection `tf.train.Example` records, one `<split>.tfrecord` per split holding each picture's bytes and its normalized boxes, beside a `label_map.pbtxt`; framing and protobuf by hand in [`_wire.py`](../../../../src/visionset/formats/tfrecord/_wire.py) |
| `classification` | [`classification/`](../../../../src/visionset/formats/classification/) - `labels.csv`, one row per (image, tag) |
| `classification-dir` | [`classification_dir/`](../../../../src/visionset/formats/classification_dir/) - `<fold>/<class>/<picture>`, each picture once under one class; declares `single_tag`, so extra tags are reported dropped and untagged assets counted in `untagged_assets` |
| `tusimple`, `curvelanes`, `bdd100k-lane`, `culane`, `openlane-2d` | [`lanes/`](../../../../src/visionset/formats/lanes/) - five plugins over one shared core |
| `mot` | [`mot/writer.py`](../../../../src/visionset/formats/mot/writer.py) - one MOTChallenge sequence per source a released track observes; declares `tracked_only`, so an untracked box is reported dropped |
| `cvat-images`, `cvat-video` | [`cvat/`](../../../../src/visionset/formats/cvat/) - CVAT XML 1.1 as two named dialects over a shared [`_document.py`](../../../../src/visionset/formats/cvat/_document.py), shapes per picture and tracks per task; `cvat-video` declares `tracked_only` |
| `kitti` | [`kitti/writer.py`](../../../../src/visionset/formats/kitti/writer.py) - scans only: a `.bin` from the stored PCD ([`kitti/pcd.py`](../../../../src/visionset/formats/kitti/pcd.py)) and each `cuboid_3d` in a canonical calibration |

## Importers

The same group carries importers, which satisfy the other port,
[`Importer`](../../../../src/visionset/kernel/ports/importer.py): `read(src)` returns an
`ImportedDataset` - classes, images by relative path, their labels, and a report of everything it
could not represent - and touches no workspace. An importer whose pictures live inside its files
also satisfies the optional
[`OpensPictures`](../../../../src/visionset/kernel/ports/importer.py): `ImportService` calls
`open(src, path)` for an image path that names no file, and an `OSError` from it is an `image`
loss - see the [amendment](../decisions/an-import-is-a-labeled-batch.md). A class may carry attribute definitions (the
schema's own `Attribute`) and a label attribute values as the source spells them; an importer
reads a value as its definition's kind where it can and otherwise passes it on, because whether a
value is kept is `ImportService`'s judgement against the schema the label lands under, not the
importer's. A dataset of point-cloud scans holds `scans`
instead, each a relative path, a `ScanLayout` naming the float32 fields of its headerless records,
and labels in the one `ScanFrame` the dataset declares; `ImportService` stores each as a binary PCD
of the same bytes under a point-cloud source declaring that frame. `registry.importers()` filters the scan by that
port, and `registry.pick_importer(installed, name)` resolves a name with the same aliases,
refusing with `ImportFormatNotFound`. `ImportService` takes the instance, as `ReleaseService.export`
takes an exporter. The built-ins are twenty-one, twenty of them answering to their exporter's `format_name`:
[`ultralytics-import`](../../../../src/visionset/formats/ultralytics/reader.py),
[`yolov5-yaml-import`](../../../../src/visionset/formats/yolov5_yaml/reader.py),
[`darknet-import`](../../../../src/visionset/formats/darknet/reader.py) and
[`yolo-obb-import`](../../../../src/visionset/formats/yolo_obb/reader.py), which share
[`_yolo_reader.py`](../../../../src/visionset/formats/_yolo_reader.py) and
[`_reading.py`](../../../../src/visionset/formats/_reading.py);
[`dota-import`](../../../../src/visionset/formats/dota/reader.py), which with `yolo-obb-import`
reads corners through [`_obb.py`](../../../../src/visionset/formats/_obb.py);
[`coco-import`](../../../../src/visionset/formats/coco/reader.py),
[`coco-panoptic-import`](../../../../src/visionset/formats/coco_panoptic/reader.py), which
refuses a segment map that contradicts its `segments_info`,
[`segmentation-png-import`](../../../../src/visionset/formats/segmentation_png/reader.py), which
reads masks only as its descriptor states them,
[`voc-import`](../../../../src/visionset/formats/voc/reader.py),
[`labelme-import`](../../../../src/visionset/formats/labelme/reader.py), which resolves each
`imagePath` inside the source and bounds and decodes embedded `imageData` before trusting it,
[`createml-import`](../../../../src/visionset/formats/createml/reader.py), which resolves each
`image` inside the source the same way and measures the picture, because the file records no size,
[`open-images-import`](../../../../src/visionset/formats/open_images/reader.py), which maps each
`LabelName` through the class descriptions file and measures each picture an `ImageID` names,
[`tfrecord-import`](../../../../src/visionset/formats/tfrecord/reader.py), the one that implements
`OpensPictures`, reading each picture out of its record rather than from a file,
[`classification-import`](../../../../src/visionset/formats/classification/reader.py),
[`classification-dir-import`](../../../../src/visionset/formats/classification_dir/reader.py), which
refuses a picture filed under two classes, nested directories and class names that collide ignoring
case, and
[`openlane-2d-import`](../../../../src/visionset/formats/lanes/reader.py), which with
[`mot-import`](../../../../src/visionset/formats/mot/reader.py) and
[`cvat-video-import`](../../../../src/visionset/formats/cvat/video.py) is one of the three that
order images into sequences and name tracks;
[`cvat-images-import`](../../../../src/visionset/formats/cvat/images.py);
[`kitti-import`](../../../../src/visionset/formats/kitti/reader.py), which converts KITTI's
camera-frame boxes into the lidar frame in
[`kitti/frames.py`](../../../../src/visionset/formats/kitti/frames.py), where the exporter's
forward conversion is its inverse; and one with no exporter,
[`nuscenes-import`](../../../../src/visionset/formats/nuscenes/reader.py), which moves nuScenes'
global boxes into the LIDAR_TOP frame through each keyframe's poses in
[`nuscenes/poses.py`](../../../../src/visionset/formats/nuscenes/poses.py). The `yolo` alias
resolves to `ultralytics` for importers too. What an import does with the dataset is
[import.md](../../import.md).

## What a plugin declares

The `Exporter` port ([`kernel/ports/exporter.py`](../../../../src/visionset/kernel/ports/exporter.py))
asks for three capability facts, and the split between them is the interesting
part:

- `lossy` - a blanket statement about everything a capability list cannot see:
  attributes, confidence, provenance, and a polyline's per-vertex `visibility`
  where the format has no slot for it (every lane format but `openlane-2d`).
  True or false for the format, forever.
- `supported_geometries` - what it writes **intact**.
- `degraded_geometries` - what it writes **having lost something**, such as a
  polygon or a rotated box (`obb`) arriving as its axis-aligned bounding box. A
  format writes a rotated box's enclosing box only when it declares `obb` here;
  `_yolo_writer.detect_rows` drops one unless its dialect asks for
  `degraded_detect_rows`, so the `ultralytics` dialect, which does not declare
  it, writes none.

No current exporter writes `keypoints`: none declares it supported or degraded, so every export
reports each keypoints annotation as dropped through the same compatibility and loss report and
needs lossy consent. Pose adapters, such as COCO keypoints and YOLO pose, are separate work.

Three exporters write a `mask`: `coco`, `coco-panoptic` and `segmentation-png` declare it
supported, and `coco-panoptic` and `segmentation-png` declare `polygon` degraded because they
rasterize one into their pixel maps. Every other export reports each mask annotation as dropped
through the same compatibility and loss report. A class map holds one class per pixel, so
`segmentation-png` writes several masks of one class as their union and gives a contested pixel
the lower id; the export report cannot see that per picture, so the descriptor it writes lists
those pictures under `visionset.overlaps`. A panoptic map holds one segment per pixel and keeps
each mask apart, so `coco-panoptic` refuses an asset where two masks claim one pixel instead,
naming both annotations.

The last two are disjoint, and a geometry in neither is not written at all. An optional
`tracked_only` says the format writes a label only as an observation of a released track, as `mot`
and `cvat-video` do, so the report counts every other label dropped; the frames they write are
every occurrence the manifest's `sources` hold of that track's source, not only the observed ones.
A video source is not listed in `sources`, and a manifest older than version 9 lists none, so for
those only the observed frames are written. An optional `single_tag` says the format writes one
classification tag per asset, as `classification-dir` does: the report counts every tag beside the
one kept (the first by class name) dropped, and an asset with no tag in `untagged_assets`. Three
states rather than two, because a boolean answers "is this written?" and "is this
written intact?" with one word - and a caller consenting to lose three annotations
would receive two of them back as boxes.

Beside them sits `targets`: the models the format writes for, each a frozen
`ExportTarget` with its tasks, the geometries an export addressed to it carries, and
the pre-processing hints a recipe editor preselects. A format that is not a trainer's
declares one target named after itself, so every surface renders one control. The
registry validates the declarations at the scan, and three rules are enforced there
rather than at export time: an exporter declares at least one target, because a
format with none is installed yet unreachable through the one control a surface
renders; each target's geometries stay within the union of the exporter's
`supported_geometries` and `degraded_geometries`, so the catalog never promises a
file the format does not write; and a target name is declared by exactly one
installed format, so resolving it is never a guess. The first two refuse with
`InvalidExportTarget` and the third with `ExportTargetConflict`, and the
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
`formats`. [`preprocessing-drivers.md`](preprocessing-drivers.md) is the guide to
writing one - the port, the entry-point group, the dependency rule and the admission
tests - and [`docs/content/preprocessing.md`](../../preprocessing.md) covers what a
recipe is and what the drivers promise.

A plugin also gets a `ContentReader` and never a `BlobStore`: a reader can read
where the port could also `put`, and a plugin that could write into the content
store could give a release bytes nobody published.

It also gets the release's split `assignment`, cut once by the kernel over the whole
frozen manifest, and places assets by it through `folds_of`; it never cuts its own,
because the manifest it is handed can hold fewer assets than the release froze.
`supported_modalities` is optional on the port and read through
`supported_modalities_of`, so a plugin written before scans existed is still
discovered and writes images.

## The gate that keeps a report honest

[`tests/formats/test_report_agreement.py`](../../../../tests/formats/test_report_agreement.py)
reads every count back out of the written artifacts and compares it against what
the compatibility report claimed. A fourth exporter registering into the group
either lands a counter there or is declared as one that writes nothing - a format
cannot be added and quietly skipped.

## Verification matrix

A plugin's declarations say what it is built to carry, and discovery says only that it is
installed. Neither says whether anything has checked it. That is recorded separately, in
[`verification.json`](../../../../src/visionset/formats/verification.json), a versioned
descriptor that ships in the wheel beside the plugins. It has one entry per built-in format,
with the format's task and dialects, and for each direction the format has, the capability the
entry claims and the tests that back it. [`formats/matrix.py`](../../../../src/visionset/formats/matrix.py)
joins it with the installed plugins, one row per plugin and direction, and
`visionset format matrix`, `GET /formats/matrix` and the `format_matrix` MCP tool all render
that join. The kernel never reads it.

A row carries separate facts rather than one "supported" flag:

- **Implemented** - a plugin is installed for that direction. A row exists only for an installed
  plugin, and `availability` says whether the format has both directions or is
  **export-only** or **import-only**.
- **Geometries** - for an exporter, the plugin's own `supported_geometries` and
  `degraded_geometries`. An importer declares no capability, so its geometries are what the
  descriptor records it reading. **Unsupported** is every other geometry an annotation can hold.
- **Lossy** - the exporter's own `lossy` flag, which is what the export consent gate reads. An
  importer has none: it reports what it drops per run, in the import plan's losses.
- **Status** - `validated` when at least one recorded test runs in CI, `implemented` when the
  descriptor covers the plugin but no test it cites runs in CI, and `no recorded evidence` for a
  plugin the descriptor does not cover. A third-party plugin is always the last, even when it
  registers under a built-in's name: evidence is attached only to plugins implemented inside
  `visionset.formats`.

Each piece of evidence names one test and its kind:

- **fixture** - a test writes a constructed release, or reads a constructed source, and asserts
  the exact content.
- **schema** - the output is validated against a published formal schema. No built-in format
  has one yet, and the tests refuse a descriptor that claims it.
- **round trip** - VisionSet's own importer reads back what its exporter wrote, and the result is
  compared with what went in. It shows the two halves agree with each other, not that a third
  tool agrees with either.
- **independent reader** - code that is not VisionSet's plugin reads the same files and agrees.
  Either an external library such as `pycocotools` or `ultralytics`, kept in an optional
  dependency group and run by CI's `format smoke` job, or a test-local parser written from the
  published layout.

`validated` is therefore never a claim of full compatibility with a tool or a benchmark. It says
which tests pass, and the evidence column says what kind they are. Evidence marked opt-in runs
only on a machine that supplies real data or tools (the KITTI and nuScenes samples), and does
not count. [`tests/formats/test_format_matrix.py`](../../../../tests/formats/test_format_matrix.py)
fails when an installed built-in has no entry, an entry names no installed plugin, an entry's
capability disagrees with what the plugin declares, or a citation names a test that does not
exist. A new built-in format lands with its entry.

The table is generated by `scripts/export_format_matrix.py` and held current by a drift gate:

<!-- format-matrix:begin — generated by scripts/export_format_matrix.py; do not edit -->
| Format | Direction | Task and dialect | Geometries | Degraded | Lossy | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `bdd100k-lane` | export | lane detection: BDD100K lane labels: one JSON per picture, each lane an open poly2d with its own category | polyline | — | yes | validated | fixture |
| `classification` | export | image classification: labels.csv, one row per (image, tag), beside the pictures under their folds | classification_tag | — | yes | validated | fixture; round trip |
| `classification` | import | image classification: labels.csv, one row per (image, tag), beside the pictures under their folds | classification_tag | — | — | validated | fixture; round trip |
| `classification-dir` | export | image classification: class directories, &lt;split>/&lt;class>/&lt;image> with splits train, val (or valid, validation) and test, or a flat &lt;class>/&lt;image>; one label per picture | classification_tag | — | yes | validated | fixture; round trip |
| `classification-dir` | import | image classification: class directories, &lt;split>/&lt;class>/&lt;image> with splits train, val (or valid, validation) and test, or a flat &lt;class>/&lt;image>; one label per picture | classification_tag | — | — | validated | fixture; round trip |
| `coco` | export | object detection, instance segmentation, keypoint detection: COCO instances JSON, one instances file per fold (instances_train.json and so on); segmentation as polygons or as compressed RLE masks; keypoints: a category's keypoints names and 1-based skeleton, rows of (x, y, v) triplets with num_keypoints, in the instances file beside the other classes; person_keypoints_*.json is read when no instances file is present | bbox, keypoints, mask, polygon | — | no | validated | fixture; round trip; independent reader (pycocotools, `coco` group) |
| `coco` | import | object detection, instance segmentation, keypoint detection: COCO instances JSON, one instances file per fold (instances_train.json and so on); segmentation as polygons or as compressed RLE masks; keypoints: a category's keypoints names and 1-based skeleton, rows of (x, y, v) triplets with num_keypoints, in the instances file beside the other classes; person_keypoints_*.json is read when no instances file is present | bbox, keypoints, mask, polygon | — | — | validated | fixture; round trip; independent reader (pycocotools, `coco` group) |
| `coco-panoptic` | export | panoptic segmentation: COCO panoptic: panoptic_&lt;split>.json with segments_info per picture, and an RGB segment PNG per picture (id = R + 256 * G + 65536 * B) | mask | polygon | yes | validated | fixture; round trip |
| `coco-panoptic` | import | panoptic segmentation: COCO panoptic: panoptic_&lt;split>.json with segments_info per picture, and an RGB segment PNG per picture (id = R + 256 * G + 65536 * B) | mask | — | — | validated | fixture; round trip |
| `createml` | export | object detection: Apple Create ML object detection: one annotations.json array of image and centre-based pixel boxes | bbox | — | yes | validated | fixture; round trip |
| `createml` | import | object detection: Apple Create ML object detection: one annotations.json array of image and centre-based pixel boxes | bbox | — | — | validated | fixture; round trip |
| `culane` | export | lane detection: CULane: one .lines.txt of integer x y pairs per picture, and a lane mask beside it | polyline | — | yes | validated | fixture |
| `curvelanes` | export | lane detection: CurveLanes: one JSON per picture, each lane a list of x/y points | polyline | — | yes | validated | fixture |
| `cvat-images` | export | detection, segmentation, polylines, tagging: CVAT for images 1.1 XML, shapes per picture | bbox, classification_tag, obb, polygon, polyline | — | yes | validated | independent reader (test-local ElementTree reading of CVAT for images 1.1); round trip |
| `cvat-images` | import | detection, segmentation, polylines, tagging: CVAT for images 1.1 XML, shapes per picture | bbox, classification_tag, obb, polygon, polyline | — | — | validated | fixture; round trip |
| `cvat-video` | export | tracking: detection, segmentation and polylines over a sequence: CVAT for video 1.1 XML, tracks of per-frame shapes over one task's frames | bbox, obb, polygon, polyline | — | yes | validated | independent reader (test-local ElementTree reading of CVAT for video 1.1); round trip |
| `cvat-video` | import | tracking: detection, segmentation and polylines over a sequence: CVAT for video 1.1 XML, tracks of per-frame shapes over one task's frames | bbox, classification_tag, obb, polygon, polyline | — | — | validated | fixture; round trip |
| `darknet` | export | object detection: Darknet obj.data, obj.names and train.txt/valid.txt image lists over YOLO class cx cy w h rows | bbox | obb, polygon | yes | validated | fixture; round trip |
| `darknet` | import | object detection: Darknet obj.data, obj.names and train.txt/valid.txt image lists over YOLO class cx cy w h rows | bbox, polygon | — | — | validated | fixture; round trip |
| `dota` | export | oriented object detection: DOTA labelTxt: x1 y1 x2 y2 x3 y3 x4 y4 category difficult per rotated box, in pixels | obb | — | yes | validated | fixture; round trip |
| `dota` | import | oriented object detection: DOTA labelTxt: x1 y1 x2 y2 x3 y3 x4 y4 category difficult per rotated box, in pixels | obb | — | — | validated | fixture; round trip |
| `kitti` | export | 3D object detection on lidar scans: KITTI object: velodyne .bin scans, label_2 fifteen-column rows and calib files, per split | cuboid_3d | — | yes | validated | fixture; round trip; opt-in: round trip |
| `kitti` | import | 3D object detection on lidar scans: KITTI object: velodyne .bin scans, label_2 fifteen-column rows and calib files, per split | cuboid_3d | — | — | validated | fixture; independent reader (test-local projection written from the KITTI devkit conventions); round trip; opt-in: fixture |
| `labelme` | export | object detection, instance segmentation: LabelMe JSON: one document per picture beside it, rectangle and polygon shapes in pixels | bbox, polygon | — | yes | validated | fixture; round trip |
| `labelme` | import | object detection, instance segmentation: LabelMe JSON: one document per picture beside it, rectangle and polygon shapes in pixels | bbox, polygon | — | — | validated | fixture; round trip |
| `mot` | export | multi-object tracking: MOTChallenge (MOT16/17/20): seqinfo.ini, img1 frames and gt/gt.txt per sequence | bbox | — | yes | validated | fixture; independent reader (test-local configparser and csv reading of the MOTChallenge layout); round trip |
| `mot` | import | multi-object tracking: MOTChallenge (MOT16/17/20): seqinfo.ini, img1 frames and gt/gt.txt per sequence | bbox | — | — | validated | fixture; round trip |
| `nuscenes` | import | 3D object detection and tracking on lidar scans: nuScenes version folder of tables beside samples/LIDAR_TOP keyframes | cuboid_3d | — | — | validated | fixture; opt-in: fixture |
| `open-images` | export | object detection: Open Images V4-V7 boxes: &lt;split>-annotations-bbox.csv of normalized XMin/XMax/YMin/YMax rows beside class-descriptions-boxable.csv | bbox | — | yes | validated | fixture; independent reader (test-local csv and Pillow reading of the published Open Images columns); round trip |
| `open-images` | import | object detection: Open Images V4-V7 boxes: &lt;split>-annotations-bbox.csv of normalized XMin/XMax/YMin/YMax rows beside class-descriptions-boxable.csv | bbox | — | — | validated | fixture; round trip |
| `openlane-2d` | export | lane detection, with per-vertex visibility and lane tracks: OpenLane 2D: one JSON per frame with lane_lines carrying uv, category, visibility and track id | polyline | — | yes | validated | fixture; round trip |
| `openlane-2d` | import | lane detection, with per-vertex visibility and lane tracks: OpenLane 2D: one JSON per frame with lane_lines carrying uv, category, visibility and track id | polyline | — | — | validated | fixture; round trip |
| `segmentation-png` | export | semantic segmentation: class-index PNG per picture (8-bit, or 16-bit past 255 ids) with a segmentation.json descriptor; import also reads palette masks and the VOC layout with a mask suffix, as the descriptor states | mask | polygon | yes | validated | fixture; round trip; independent reader (test-local PNG decoder over zlib and the PNG filters, no Pillow) |
| `segmentation-png` | import | semantic segmentation: class-index PNG per picture (8-bit, or 16-bit past 255 ids) with a segmentation.json descriptor; import also reads palette masks and the VOC layout with a mask suffix, as the descriptor states | mask | — | — | validated | fixture; round trip |
| `tfrecord` | export | object detection: TensorFlow Object Detection API tf.train.Example records: &lt;split>.tfrecord of image/encoded and normalized image/object/bbox/* boxes beside a label_map.pbtxt | bbox | — | yes | validated | fixture; independent reader (test-local TFRecord framing, CRC32C and protobuf wire parser over the Object Detection feature names); round trip |
| `tfrecord` | import | object detection: TensorFlow Object Detection API tf.train.Example records: &lt;split>.tfrecord of image/encoded and normalized image/object/bbox/* boxes beside a label_map.pbtxt | bbox | — | — | validated | fixture; round trip |
| `tusimple` | export | lane detection: TuSimple: one JSON record per picture, lanes sampled at shared h_samples rows | — | polyline | yes | validated | fixture |
| `ultralytics` (alias `yolo`) | export | object detection, instance segmentation, image classification, pose estimation: detect: data.yaml with path and indexed names, class cx cy w h rows; segment: the same layout with normalized polygon rows; classify: a class-directory tree per fold; pose: the same layout with kpt_shape [N, 3] and class cx cy w h then x y v per keypoint rows | bbox, classification_tag, keypoints, polygon | — | yes | validated | fixture; round trip; independent reader (ultralytics, `yolo` group) |
| `ultralytics` (alias `yolo`) | import | object detection, instance segmentation, image classification, pose estimation: detect: data.yaml with path and indexed names, class cx cy w h rows; segment: the same layout with normalized polygon rows; classify: a class-directory tree per fold; pose: the same layout with kpt_shape [N, 3] and class cx cy w h then x y v per keypoint rows | bbox, classification_tag, keypoints, polygon | — | — | validated | fixture; round trip |
| `voc` | export | object detection: Pascal VOC: one XML per picture, 1-based inclusive boxes, an ImageSets listing per fold | bbox | obb, polygon | yes | validated | fixture; round trip |
| `voc` | import | object detection: Pascal VOC: one XML per picture, 1-based inclusive boxes, an ImageSets listing per fold | bbox | — | — | validated | fixture; round trip |
| `yolo-obb` | export | oriented object detection: Ultralytics OBB: class x1 y1 x2 y2 x3 y3 x4 y4 rows, normalized, under the ultralytics layout | obb | — | yes | validated | fixture; round trip |
| `yolo-obb` | import | oriented object detection: Ultralytics OBB: class x1 y1 x2 y2 x3 y3 x4 y4 rows, normalized, under the ultralytics layout | obb | — | — | validated | fixture; round trip |
| `yolov5-yaml` | export | object detection: YOLOv5 data.yaml grammar (nc, a names list, ./ split paths) over YOLO class cx cy w h rows | bbox | obb, polygon | yes | validated | fixture; independent reader (test-local parser of the YOLOv5 data.yaml grammar (descriptor only)); round trip |
| `yolov5-yaml` | import | object detection: YOLOv5 data.yaml grammar (nc, a names list, ./ split paths) over YOLO class cx cy w h rows | bbox, polygon | — | — | validated | fixture; round trip |
<!-- format-matrix:end -->

## Related

[`docs/content/releases.md`](../../releases.md) covers the artifact being exported.
`ReleaseService`'s own docstring covers the consent gate.
