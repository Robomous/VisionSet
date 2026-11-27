# Import

An import brings a dataset that already has labels - a COCO export from another tool, say, or
KITTI or nuScenes lidar scans with their boxes - into a project. The images or scans become assets, the dataset's classes become the project's schema when it has
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

A dataset of images may also order some of its images into **sequences**, such as OpenLane's
segments or MOTChallenge sequences, and name the object each label draws within one - its **track id**. Each sequence holding
an asset the run creates or labels becomes a new `image_sequence` source, with one frame occurrence
per position it holds, and every track id in it becomes a track of that source with the id as its
`external_id`, observing the labels the run writes; the rules are
[a track observes frame occurrences](architecture/decisions/a-track-observes-frame-occurrences.md).
Every import writes its own sources, so the same id in two sequences, or in two imports of one,
is two tracks and never merges. A position whose image the source does not hold is a gap, and one
whose bytes repeat an earlier image is an occurrence of that image's asset, its labels dropped as
an `image` loss as any repeat's are; within a sequence, earlier means earlier in the sequence's own
order, not in path order. A track takes the class of its first label in sequence order: a
later label of the same id and another class, or a second label of one id in one frame, is kept
untracked and reported as an `attribute` loss. The plan counts the `sequences` a commit would
write and the `tracks` over the labels it would write, so a re-run that writes nothing counts none;
the run returns the sources in `source_ids` and counts `tracks_written`. A track observes 2D labels only.

A dataset of scans differs in three ways. A headerless scan is stored as a binary PCD of its own
bytes, so it is a `point_cloud` asset like an ingested one, with its preview. The same transaction
writes a point-cloud source at the import directory declaring the dataset's frame, or reuses the
one already there; one there declaring another frame refuses the import with
`CALIBRATION_IN_USE`, as does a scan already in the project under a source of another frame,
because its labels would be read in other axes. The first is refused even while none of the
source's scans holds a label, where registering the directory directly with another frame would
replace the declaration: an import never re-declares a frame, so register the directory with the
import's frame first when nothing depends on the old one. The frame of every labelled scan is
checked again inside the commit's transaction, under the write lock a frame change takes, so a
frame declared again while the scans were being stored refuses the import rather than leaving a
label in axes its source no longer declares. A scan label has no image to fall outside of, so
none is dropped for its position. The plan counts `scans` and names the `frame`. A scan may name
a `group_label` - the set the source says it belongs to, such as a nuScenes scene - and a new
asset keeps it as provenance; an asset already in the project keeps whatever it arrived with.

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
| `label` | A whole label: an RLE or crowd mask, a polygon of several rings, a label outside its image, a MOT row whose `conf` marks it ignored. |
| `image` | An image the source names but does not hold, or one whose bytes repeat an earlier image; its labels go with it. A nuScenes camera frame, which is not read. |
| `scan` | A scan whose points repeat an earlier scan's, or one gone from the source; its labels go with it. A nuScenes sweep or radar frame, which is not read. |
| `attribute` | Extras the importer does not carry, such as COCO attributes, VOC difficult or pose flags, an OpenLane camera calibration, a track id outside a sequence or one a track cannot hold, a MOT box's visibility ratio or the absence of an identity (an `id` that is not positive), KITTI truncation, occlusion, alpha and calibration, nuScenes attributes, visibility, instance tokens, point counts, poses and a scene's fields other than its name. |

The refusal carries the full report in its `detail.losses`. Inspecting the source first returns
the same report and writes nothing; its `loss_kinds` is exactly what the commit has to consent to,
and its `conflicts` are what would refuse the commit whatever it consents to.

## Re-running

An import is one-shot, not a sync. Running the same source again adds no asset, because assets
are addressed by content, and no label already on its asset; when nothing is new it creates no
batch at all, and no source or track. A re-run that does write lands every sequence it touches as a
new source, whose tracks observe only the labels that run wrote. Once a reviewer has changed an
imported label, the source's version is new again and lands on an asset a batch holds, so the
re-run is refused.

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
| `openlane-2d` | `labels/**/*.json`, one document per image naming it in `file_path`, the layout the OpenLane 2D exporter writes; lanes as polylines with their per-vertex `visibility`; each `segment-*` directory as an image sequence and its lanes' `track_id` as tracks | 3D points (`xyz`), a camera calibration, a track id outside a `segment-*` sequence, and lane `attribute` values beyond the exporter's own, a `visibility` that is not one `0` or `1` per point (the lane is kept without it), malformed lanes |
| `ultralytics` | `data.yaml` with `names` and pictures under any `images/` directory, labels at the matching `labels/` path, the layout the exporter writes; boxes (four values) and polygons (six or more, an even count); or a class tree (`train`/`val`/`test` directories of class directories) as tags | Keypoints of a pose dataset (`kpt_shape`), malformed rows, an unknown class index, a zero-area or wholly outside box, a label file with no picture, the labels of a picture whose size cannot be read |
| `yolov5-yaml` | The same layout with `nc` and a list of `names` | As `ultralytics` |
| `darknet` | `obj.names` (and `obj.data`) with the same `images/` and `labels/` layout | As `ultralytics`, bar keypoints |
| `voc` | `Annotations/**/*.xml` with pictures under `JPEGImages/`; boxes | Pose, truncated, difficult and occluded values other than unspecified or `0`, other `<object>` children, parts, segmentation, an object with no name or box, a zero-area or outside box |
| `classification` | `labels.csv` (`image`, `class`) and `classes.txt` beside `images/`; one tag per row | A row naming a class `classes.txt` does not declare, a second row of one class on one picture, a malformed row, a row with no picture or class |
| `kitti` | A 3D object detection split: `velodyne/*.bin` scans, `label_2/*.txt` and `calib/*.txt`, at the top or in `training/` and `testing/` (or the `train/`, `val/`, `test/` the exporter writes); boxes as `cuboid_3d` in the `lidar_flu` frame | `DontCare` regions, each box's 2D image `bbox`, truncation, occlusion and alpha, the calibration itself, a score outside 0 to 1, a label with no scan, no usable calibration, a malformed line or a dimension that is not positive |
| `mot` | MOTChallenge (MOT16/17/20) sequences: every directory holding a `seqinfo.ini`, its frames `<imDir>/<frame:06d><imExt>` for frames 1 to `seqLength`, and `gt/gt.txt` boxes with `gt/labels.txt` as the class table; each sequence as an image sequence and its ids as tracks | A row whose `conf` is `0` (ignored), each box's `visibility`, the identity of a row whose `id` is not positive (the box is kept untracked), frames the sequence names but does not hold; `det/det.txt` is not read. A malformed row or `seqinfo.ini` refuses the source |
| `nuscenes` | A data root: a version folder (`v1.0-mini`, `v1.0-trainval`, ...) of JSON tables beside `samples/LIDAR_TOP/*.pcd.bin`; the LIDAR_TOP keyframes, boxes as `cuboid_3d` in the `lidar_rfu` frame, and each keyframe's scene name as its group label | Attributes, visibility, instance tokens (tracking identity, because a track follows 2D labels only), `num_lidar_pts` and `num_radar_pts`, a scene's description, log and map, the ego pose and calibration themselves, a box leaning more than 6 degrees, a malformed box or a dimension that is not positive, an annotation whose sample has no LIDAR_TOP keyframe, the sweeps, and every other sensor's data |

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

**OpenLane segments are sequences.** A directory named `segment-*` whose documents are all named by
a number, as upstream OpenLane names a frame by its timestamp, is one image sequence named after the
directory. Its frames are ordered by that number and read as hundredths of a microsecond, OpenLane's
Waymo timestamp with two digits appended, so a frame's occurrence `timestamp` is its time in seconds
since the segment's first frame. A lane's `track_id`, which OpenLane keeps unique across a segment,
becomes its label's track id, as the integer's decimal text or the name as written. A name that
spells an integer id of the same segment, such as `"7"` beside `7`, is not assumed to be that lane:
its label is kept untracked and reported as an `attribute` loss. The segment's directory name
becomes the source's name and must be a valid one, so a name a source cannot carry refuses the
source at inspection. The exporter
writes `lane_<n>`, its echo of the lane's order in the image rather than an identity, so that value
is neither carried nor reported. Any other track id outside a sequence, such as in the exporter's
fold directories or a segment with a document not named by a number, is an `attribute` loss, as is
one that is neither an integer nor a non-blank name.
**MOTChallenge sequences.** Every directory under the source holding a `seqinfo.ini` is one
sequence, named by the file's `name`; two directories naming one sequence refuse the source. Its
`[Sequence]` section must give `name`, `imDir`, `frameRate`, `seqLength`, `imWidth`, `imHeight` and
`imExt`. Frame `n`, from 1 to `seqLength`, is `<imDir>/<n:06d><imExt>` at position `n - 1` and
`(n - 1) / frameRate` seconds in. Every frame is listed whether the directory holds it or not, so a
missing frame is an `image` loss whose position stays a gap and the rest keep their numbers.
`gt/gt.txt` rows are `frame,id,bb_left,bb_top,bb_width,bb_height,conf,class,visibility`, read as
pixel boxes as written; a sequence without one, such as a test split, imports unlabelled. A row's
`id` is its label's track id as decimal text, scoped to its sequence: the same id in two sequences
is two tracks, and nothing but a positive `id` makes one, so a row whose `id` is `0` or negative is
kept untracked and reported as an `attribute` loss. `conf` `0` marks an entry the benchmark ignores,
which is not imported and is a `label` loss; `1` is ground truth, and a value between, such as a
tracker's predicted box, becomes the label's confidence. `class` is a 1-based line number into
`gt/labels.txt`, one class name per line, the table CVAT and Datumaro write beside `gt.txt`; without
that file a class is named by its number (`1`, `2`, ...), because the integers mean different things
in different datasets and are not guessed. `visibility` is `-1` (unknown) or a ratio from 0 to 1,
and a ratio is reported as an `attribute` loss with the box kept; an occluded object is simply a
track with no row in those frames, and it reappears at its next row. Anything else refuses the
source and names the file and line: a row that is not nine numbers (MOT15's ten columns included),
a frame outside `1..seqLength` or not an integer, a non-integer id, a box with no area, a `conf`
outside 0 to 1, a visibility neither `-1` nor within 0 to 1, a class that is not a positive integer
or not in the table, and a `seqinfo.ini` missing a field or giving one that is not a positive
number. The image size `seqinfo.ini` gives must be the size of every frame it holds. MOTS, whose
rows are instance masks, is not read: it needs raster masks, which the domain does not have yet.

**KITTI.** Each `velodyne/<id>.bin` is one scan of float32 `x, y, z, reflectance` records, kept
byte for byte with reflectance as `intensity`; a file that is not a whole number of 16-byte
points refuses the source. Its labels are `label_2/<id>.txt`, and a scan with none (the testing
split) is imported unlabelled. A label is written in the rectified camera frame (x right, y down,
z forward) with `location` the centre of the box's bottom face, dimensions `h w l` and
`rotation_y` about camera y, while a scan's label must be in the scan's own frame. So the import
converts each box with that frame's `calib/<id>.txt`, an explicit conversion the loss report names
(an `attribute` loss on `calib`), never a silent one: the centre is lifted by `h / 2` along camera
up and mapped through the inverse of `R0_rect` and `Tr_velo_to_cam` (`R_rect` and `Tr_velo_cam`
are read too when written as `KEY: values`; every line of a calibration file must be), the size
becomes `(l, w, h)`, and the heading `(cos ry, 0, -sin ry)` is mapped through the inverse rotation
and read back as `yaw = atan2(y, x)`. On KITTI's nominal axes that is `yaw = -rotation_y - pi/2`,
wrapped into `[-pi, pi]`. A cuboid has no pitch or roll: the small lean a real calibration has
between camera up and lidar z is projected out of the heading, and a calibration whose camera up
leans more than 6 degrees from the lidar's up axis - the tolerance the nuScenes import refuses a
leaning box by - places none of its frame's boxes, each a `label` loss, rather than flattening
them.
Coordinates are rounded to the micrometre. Classes are the names labels use, KITTI's own
(`Car`, `Van`, `Truck`, `Pedestrian`, `Person_sitting`, `Cyclist`, `Tram`, `Misc`) first in that
order. A 16th column, a detection score, becomes the label's confidence when it lies in 0 to 1.
Camera images are not read. The `kitti` exporter writes this layout with a canonical calibration
(see [releases](releases.md#the-kitti-format)), so importing its output returns the same boxes,
within 2 micrometres, and the same points, with intensity as the scan stored it (0 to 255 for a
nuScenes scan, not KITTI's 0 to 1); the boxes are then consistent with that calibration, not with the original
sensor's camera frame, which no export holds.

**nuScenes.** The source is a data root, the directory that holds `samples/` beside one or more
version folders of JSON tables (`v1.0-mini`, `v1.0-trainval`, `v1.0-test`); several version
folders are merged by token, and naming a version folder itself is refused, because the tables
name files relative to the root. The tables read are `scene`, `sample`, `sensor`,
`calibrated_sensor`, `ego_pose`, `sample_data`, `sample_annotation`, `instance` and `category`;
one that is missing, is not a JSON
list of objects, or names a row another table does not hold refuses the source. Each LIDAR_TOP
keyframe (`is_key_frame`) is one scan of float32 `x, y, z, intensity, ring` records, kept byte for
byte with `ring` skipped; a file that is not a whole number of 20-byte points refuses the source,
and a root with no LIDAR_TOP keyframe is refused. A keyframe with no annotations is imported
unlabelled. The scans are declared in the `lidar_rfu` frame (x right, y forward, z up), LIDAR_TOP's
own axes, so no point is re-expressed.

**Scene membership is carried.** Each keyframe's sample names its scene (`sample.scene_token`),
and the scene's `name` (such as `scene-0061`) becomes the new asset's **group label**, so a
release split can [keep every keyframe of a scene in one fold](releases.md#keeping-a-group-in-one-fold).
The label is written at the asset's first arrival and never rewritten, so an asset imported before
labels existed keeps none. The loss report names what the scene does not bring along - an
`attribute` loss on `scene`, counted per scene, for its description, log and map - and the
instance token that tracks an object across a scene's keyframes is still not carried: it follows a
3D box through lidar scans, and a track follows 2D labels only until point-cloud tracking is
decided ([a track observes frame occurrences](architecture/decisions/a-track-observes-frame-occurrences.md)).

An annotation is in the global frame: `translation` is the box's centre, `size` is `(w, l, h)` and
`rotation` a `(w, x, y, z)` quaternion. The import moves each box into the scan's frame through
that keyframe's poses, an explicit conversion the loss report names (an `attribute` loss on
`ego_pose`): the inverse of its `ego_pose`, then the inverse of its `calibrated_sensor`, so
`p_sensor = Rc^T (Re^T (p - te) - tc)`. The box's own x axis, its heading, is mapped through both
rotations and read back as `yaw = atan2(-x, y)`, the turn from forward (+y) toward left (-x); the
size becomes `(l, w, h)`. A cuboid has no pitch or roll, so a box whose up axis leans more than
**6 degrees** from the sensor's is a `label` loss rather than a flattened box; within that, the lean
is projected out of the heading. Coordinates are rounded to the micrometre. Classes are
`category.name` (such as `vehicle.car`), sorted. Sweeps, camera images, radar and tracking
identity are out of scope; each is reported, never dropped silently.

**The scale it has been run at.** The largest root imported so far is `v1.0-mini`: 404 keyframes
and 18,538 boxes, committed in about 7.5 seconds on one developer workstation (the median of three
runs), of which about 1.5 seconds is the final transaction. The commit's progress counts scans as
their bytes are stored; the rows that follow - assets, labels, the batch and its approval - are
written in one transaction that reports no progress and holds the workspace's write lock, so other
writes to the workspace wait for it. Its time grows with the number of labels. `v1.0-trainval` has
not been imported, and no time is claimed for it.

nuScenes is licensed CC BY-NC-SA 4.0 and downloaded only after registering at nuscenes.org;
VisionSet ships none of it, and its tests build a synthetic root instead.

TuSimple, CurveLanes, BDD100K and CULane have no importer: none of them carries anything a
polyline import does not already get from OpenLane, and none has a per-vertex slot.

An importer is a plugin in the `visionset.formats` entry-point group, beside the exporters; see
[formats](architecture/backend/formats.md#importers). A name nothing is installed under is refused
with `IMPORT_FORMAT_NOT_FOUND`, which lists the importable formats.
