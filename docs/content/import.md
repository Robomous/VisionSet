# Import

An import brings a dataset that already has labels - a COCO export from another tool, say, or
KITTI lidar scans with their boxes - into a project. The images or scans become assets, the dataset's classes become the project's schema when it has
none, and every label is written with `import` provenance into one batch, which is then approved.
The import stops there. A person reviews the labels and promotes them as with any other batch,
because a label from outside is third-party truth. The rule is
[an import is a labeled batch](architecture/decisions/an-import-is-a-labeled-batch.md).

**Stated limit:** an import reads a directory on the machine VisionSet runs on, so it is a CLI and
MCP operation. REST has no route that takes a server-side path, for the reason given in
[sources.md](sources.md#over-http-a-directory-is-an-upload-a-clip-is-never-one), and there is no
upload variant yet. [surfaces.md](surfaces.md) shows what each surface can do.

## What an import does

1. **Reads the source.** An importer plugin, chosen by format name, reads the directory and
   returns the classes, the images (or the point-cloud scans) by relative path, the labels on
   each, and a report of everything it could not represent. It writes nothing. A dataset of
   scans also declares the [frame](sources.md#point-cloud-directories-and-their-frame) its scans
   and labels are written in.
2. **Plans.** Every listed image is decoded and matched by content against the project's assets.
   An image the source names but does not hold, an image whose bytes repeat another's, and a
   label wholly outside its image are added to the loss report.
3. **Commits.** The images are stored by content hash, as [ingest](ingest.md) stores them; a
   project with no schema gets version 1 from the dataset's classes; the labels and a batch are
   written and the batch is approved, in one transaction. Approval seeds each labeled asset as
   `annotated`. Nothing is completed or promoted.

A dataset of scans differs in three ways. A headerless scan is stored as a binary PCD of its own
bytes, so it is a `point_cloud` asset like an ingested one, with its preview. The same transaction
writes a point-cloud source at the import directory declaring the dataset's frame, or reuses the
one already there; one there declaring another frame refuses the import with
`CALIBRATION_IN_USE`, as does a scan already in the project under a source of another frame,
because its labels would be read in other axes. A scan label has no image to fall outside of, so
none is dropped for its position. The plan counts `scans` and names the `frame`.

An existing schema is never changed by an import. A label the active schema cannot accept refuses
the whole import, as does a label that would land on an asset already in the dataset or held by
another batch.

## Losses need consent, per kind

Whether an import loses anything depends on the file in hand, not on the format: a COCO file of
boxes and polygons imports whole, one with RLE masks or keypoints does not. So the loss report is
computed from the content, and a commit that would drop something is refused with
`IMPORT_NOT_CONSENTED` unless the caller consents to each **kind** of loss it reports:

| Kind | What is dropped |
| --- | --- |
| `class` | A class the project's schema does not declare and no label uses. |
| `geometry` | Part of a shape the kernel has no type for, such as YOLO keypoints, VOC parts, 3D lane points or an unusable per-vertex visibility, while the shape itself is kept. |
| `label` | A whole label: an RLE or crowd mask, a polygon of several rings, a label outside its image. |
| `image` | An image the source names but does not hold, or one whose bytes repeat an earlier image; its labels go with it. |
| `scan` | A scan whose points repeat an earlier scan's, or one gone from the source; its labels go with it. |
| `attribute` | Extras the importer does not carry, such as COCO attributes, VOC difficult or pose flags, an OpenLane camera calibration or track id, KITTI truncation, occlusion, alpha and calibration. |

The refusal carries the full report in its `detail.losses`. Inspecting the source first returns
the same report and writes nothing; its `loss_kinds` is exactly what the commit has to consent to,
and its `conflicts` are what would refuse the commit whatever it consents to.

## Re-running

An import is one-shot, not a sync. Running the same source again adds no asset, because assets
are addressed by content, and no label already on its asset; when nothing is new it creates no
batch at all. Once a reviewer has changed an imported label, the source's version is new again and
lands on an asset a batch holds, so the re-run is refused.

## At a terminal and from an agent

```sh
visionset import coco ./coco-export --project road-signs --dry-run
visionset import coco ./coco-export --project road-signs --consent-lossy label
```

`--dry-run` prints the loss report and exits 1 when the same command without it would be refused.
The batch id goes to stdout. See [cli.md](cli.md#visionset-import).

Over MCP, `inspect_import` returns the plan and `import_dataset` commits, with `consent_lossy`
naming the kinds to accept. See [mcp-tools.md](mcp-tools.md).

## Formats

| Format | Reads | Reported as lost |
| --- | --- | --- |
| `coco` | `annotations/instances_*.json` with images under `images/<fold>/` or `images/`, the layout the COCO exporter writes; boxes and single-ring polygons | RLE and crowd masks, multi-ring polygons, keypoints, captions and other non-instances files, attributes |
| `openlane-2d` | `labels/**/*.json`, one document per image naming it in `file_path`, the layout the OpenLane 2D exporter writes; lanes as polylines with their per-vertex `visibility` | 3D points (`xyz`), a camera calibration, track ids and lane `attribute` values beyond the exporter's own, a `visibility` that is not one `0` or `1` per point (the lane is kept without it), malformed lanes |
| `ultralytics` | `data.yaml` with `names` and pictures under any `images/` directory, labels at the matching `labels/` path, the layout the exporter writes; boxes (four values) and polygons (six or more, an even count); or a class tree (`train`/`val`/`test` directories of class directories) as tags | Keypoints of a pose dataset (`kpt_shape`), malformed rows, an unknown class index, a zero-area or wholly outside box, a label file with no picture, the labels of a picture whose size cannot be read |
| `yolov5-yaml` | The same layout with `nc` and a list of `names` | As `ultralytics` |
| `darknet` | `obj.names` (and `obj.data`) with the same `images/` and `labels/` layout | As `ultralytics`, bar keypoints |
| `voc` | `Annotations/**/*.xml` with pictures under `JPEGImages/`; boxes | Pose, truncated, difficult and occluded values other than unspecified or `0`, other `<object>` children, parts, segmentation, an object with no name or box, a zero-area or outside box |
| `classification` | `labels.csv` (`image`, `class`) and `classes.txt` beside `images/`; one tag per row | A row naming a class `classes.txt` does not declare, a second row of one class on one picture, a malformed row, a row with no picture or class |
| `kitti` | A 3D object detection split: `velodyne/*.bin` scans, `label_2/*.txt` and `calib/*.txt`, at the top or in `training/` and `testing/`; boxes as `cuboid_3d` in the `lidar_flu` frame | `DontCare` regions, each box's 2D image `bbox`, truncation, occlusion and alpha, the calibration itself, a score outside 0 to 1, a label with no scan, no usable calibration, a malformed line or a dimension that is not positive |

**YOLO family** (`ultralytics`, `yolov5-yaml`, `darknet`). A picture is any file under an `images/`
directory; its label is at the same path with the last `images` segment swapped for `labels` and
the suffix `.txt`, which covers both `images/<fold>` and `<fold>/images`. Normalized coordinates
are scaled by the picture's EXIF-oriented size, read from its header, and rounded to six decimals
in pixels. Classes come from `data.yaml` (`names` as a mapping or a list; `nc` must agree) or the
single YAML at the top, and for darknet from `obj.names`, found by file name at the top, with
`classes =` in `obj.data` agreeing. A class no label uses is declared as a box class. Only the
YAML subset a descriptor uses is read (top-level `key: value`, a flow or block list or mapping of
scalars); anything else in `names` is refused, as are a name given to two indices, a plain
`yes`, `no`, `null` or `~` that YAML would not read as a name, a key with a leading zero, and a
spelled-out `nan` or `inf`. A picture with no label file is imported unlabelled. A symbolic
link to a directory, or a file resolving outside the source, is refused. The exporters write
six-decimal normalized coordinates, so a round trip is exact to a millionth of the picture size; a
box in an ultralytics segment export is written as four corners and reads back as a four-point
polygon; the exporters clamp boxes into the image and drop tags beside boxes. The split is not
imported: darknet's `train.txt` and `valid.txt` are ignored, and no importer reads a fold.
With no `data.yaml` and no `images/` directory, an `ultralytics` source with `train`, `val` or
`test` directories is a class tree: each class directory is a tag class, in sorted order rather
than the original schema order, and a picture copied under several class directories (the same
bytes) is one image with each tag; the same bytes twice under one class directory is a repeated
tag, a `label` loss, and a picture directly under a fold, outside every class directory, is an
`image` loss.

**VOC.** A box is `xmin`, `ymin`, `xmax`, `ymax`, 1-based and inclusive, so `x = xmin - 1` and
`width = xmax - xmin + 1`. Only boxes are read. Classes are the names objects use, in order of
first appearance: an unused class and the schema's order are not recovered, and a box the
exporter rounded outward to integers stays rounded. A picture under `JPEGImages/` that no document
names is imported unlabelled. A `DOCTYPE` or `ENTITY` declaration refuses the file, in whatever
encoding it is written.

**Classification.** `labels.csv` needs an `image` and a `class` column; a `fold` column is
ignored and each row is one tag. A picture carries one tag of a class, so a second row of the
same class on the same picture is a `label` loss. `classes.txt` declares the classes in
order, including unused ones. A picture under `images/` with no row is imported untagged.

**OpenLane 2D.** A lane's `category` becomes its class, under OpenLane's own names (`white-dash`,
`yellow-solid`, ... and `unknown` for `0`); the exporter's road edges, `13` and `14`, both read
back as `road_edge`, the class name the exporter writes them from, and a category with no name
becomes `category-<n>`. `visibility` reads `1` as visible and `0` as occluded, so a lane exported
with occluded vertices imports back with the same `visibility`. OpenLane has no "unknown", so an
import never produces an unlabeled vertex, and a lane exported without visibility comes back
all-visible. The exporter maps style and colour to the category and writes no class name, so the
lane attributes and the source class are not recovered: only the category is. Upstream OpenLane's
column-major `uv` (`[[u...], [v...]]`) is a different layout and is refused rather than guessed.
One case cannot be told apart: a two-point lane is `[[a, b], [c, d]]` in both layouts, and is read
as the two points `(a, b)` and `(c, d)`. A document with any longer column-major lane is refused
whole, so only a document whose every lane has two points can be misread. A lane `attribute` is
kept quiet only when it equals the lane's category, which is what the exporter writes; any other
value is an `attribute` loss. A symbolic link to a directory under `labels/` is refused, not
followed.
**KITTI.** Each `velodyne/<id>.bin` is one scan of float32 `x, y, z, reflectance` records, kept
byte for byte with reflectance as `intensity`; a file that is not a whole number of 16-byte
points refuses the source. Its labels are `label_2/<id>.txt`, and a scan with none (the testing
split) is imported unlabelled. A label is written in the rectified camera frame (x right, y down,
z forward) with `location` the centre of the box's bottom face, dimensions `h w l` and
`rotation_y` about camera y, while a scan's label must be in the scan's own frame. So the import
converts each box with that frame's `calib/<id>.txt`, an explicit conversion the loss report names
(an `attribute` loss on `calib`), never a silent one: the centre is lifted by `h / 2` along camera
up and mapped through the inverse of `R0_rect` and `Tr_velo_to_cam` (`R_rect` and `Tr_velo_cam`
are read too), the size becomes `(l, w, h)`, and the heading `(cos ry, 0, -sin ry)` is mapped
through the inverse rotation and read back as `yaw = atan2(y, x)`. On KITTI's nominal axes that is
`yaw = -rotation_y - pi/2`, wrapped into `[-pi, pi]`; the small pitch a real calibration has
between camera y and lidar z is not modelled by a cuboid and is projected out of the heading.
Coordinates are rounded to the micrometre. Classes are the names labels use, KITTI's own
(`Car`, `Van`, `Truck`, `Pedestrian`, `Person_sitting`, `Cyclist`, `Tram`, `Misc`) first in that
order. A 16th column, a detection score, becomes the label's confidence when it lies in 0 to 1.
Camera images are not read. nuScenes has no importer yet.

TuSimple, CurveLanes, BDD100K and CULane have no importer: none of them carries anything a
polyline import does not already get from OpenLane, and none has a per-vertex slot.

An importer is a plugin in the `visionset.formats` entry-point group, beside the exporters; see
[formats](architecture/backend/formats.md#importers). A name nothing is installed under is refused
with `IMPORT_FORMAT_NOT_FOUND`, which lists the importable formats.
