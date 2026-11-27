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
   An image the source names but does not hold, an image outside any sequence whose bytes repeat
   another's, and a label wholly outside its image are added to the loss report.
3. **Commits.** The images are stored by content hash, as [ingest](ingest.md) stores them; a
   project with no schema gets version 1 from the dataset's classes; the labels and a batch are
   written and the batch is approved, in one transaction. Approval seeds each labeled asset as
   `annotated`. Nothing is completed or promoted.

A dataset of images may also order some of its images into **sequences**, such as OpenLane's
segments, MOTChallenge sequences or CVAT video tasks, and name the object each label draws within one - its **track id**. Each sequence holding
an asset the run creates or labels becomes a new `image_sequence` source, with one frame occurrence
per position it holds, and every track id in it becomes a track of that source with the id as its
`external_id`, observing the labels the run writes; the rules are
[a track observes frame occurrences](architecture/decisions/a-track-observes-frame-occurrences.md).
Every import writes its own sources, so the same id in two sequences, or in two imports of one,
is two tracks and never merges. A position whose image the source does not hold is a gap, and one
whose bytes repeat an earlier image is an occurrence of that image's asset; within a sequence,
earlier means earlier in the sequence's own order, not in path order. Its labels land on that asset
rather than being lost: a tracked label always becomes an annotation of its own, because a track
observes each occurrence through a different annotation, and an untracked one is added only when the
asset does not already carry an equal label, so it never stacks. A fully static clip - every frame
the same bytes - is therefore one asset holding one annotation per tracked label per frame, N
identical boxes for a track that stands still across N frames. A track takes the class of its first label in sequence order: a
later label of the same id and another class, or a second label of one id in one frame, is kept
untracked and reported as an `attribute` loss. The plan counts the `sequences` a commit would
write and the `tracks` over the labels it would write, so a re-run that writes nothing counts none;
the run returns the sources in `source_ids` and counts `tracks_written`. A track observes 2D labels
on images, and takes a single geometry type, a rotated box counting as a box: a later label of the
same id and another geometry type is kept untracked and reported the same way.

A dataset of scans may order its scans the same way, as a nuScenes scene does: each sequence
holding a scan the run creates or labels becomes a new `point_cloud_sequence` source, and each track
id a track over its `cuboid_3d` labels. The rules are the image sequence's, with two differences. A
scan whose points repeat an earlier one is an occurrence of that scan's asset, but its own labels are
lost, as they always were for a repeated scan. And a sequence may state each frame's position, so a
place in the dataset's order with no scan, such as a nuScenes sample with no LIDAR_TOP keyframe, is a
gap rather than shifting the rest. The sequence declares no scan frame: each scan stays an asset of
the point-cloud source at the import root, which declares the frame its cuboids are read in.

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

An existing schema is never changed by an import. A label whose class or geometry the active
schema cannot accept refuses the whole import, as does a label that would land on an asset already
in the dataset or held by another batch.

**Attributes.** An importer may define attributes on a class and give each label attribute values.
With no schema, the version the import creates declares each class with the definitions the source
gives it. Every value is then judged against the class it lands under - the active schema's, or
the one the import creates - by the rule an annotation write uses: a value the class does not
declare, or one its definition rejects, is an `attribute` loss counted per class and attribute
name, and the label is kept without it. A label then lacking an attribute its class requires is a
`label` loss alone and is not written. An existing schema is never widened to take a value, and
the definitions a source gives are not consulted against one. Whether a label is already on its
asset is decided by class and geometry: one already there is not written again, and when it is
there with other attribute values - a re-run after the source changed a value, or a repeated
sequence frame whose label differs only in its values - the stored values are kept and the
difference is an `attribute` loss, never a silent no-op.

## Losses need consent, per kind

Whether an import loses anything depends on the file in hand, not on the format: a COCO file of
boxes, polygons and RLE masks imports whole, one with crowd regions, multi-part polygons or keypoints does not. So the loss report is
computed from the content, and a commit that would drop something is refused with
`IMPORT_NOT_CONSENTED` unless the caller consents to each **kind** of loss it reports:

| Kind | What is dropped |
| --- | --- |
| `class` | A class the project's schema does not declare and no label uses; a CVAT label that names no geometry the domain holds. |
| `geometry` | Part of a shape the kernel has no type for, such as YOLO keypoints, VOC parts, 3D lane points or an unusable per-vertex visibility, while the shape itself is kept; a `yolo-obb` or `dota` row whose corners are only near a rectangle, kept as the nearest rectangle; or a COCO polygon of several rings, kept as one mask rasterized at pixel centres; or a Create ML `coordinates` key other than `x`, `y`, `width` and `height`, the box kept; or Open Images extreme-click points (`XClick1X` ... `YClick4Y`), the box kept; or a TFRecord box's instance mask or keypoints, the box kept. |
| `label` | A whole label: a COCO RLE mask that is malformed or not its image's size, a `segmentation-png` mask with no picture or not the size of its picture, the pixels a `segmentation-png` ignore id marks, a COCO panoptic picture's void pixels, a panoptic segment map not the size of its picture or a segment naming no declared category, a label outside its image, a label lacking an attribute its class requires, a MOT row whose `conf` marks it ignored, a CVAT shape the domain has no geometry for (points, ellipse, cuboid, mask, skeleton) or a CVAT box whose `rotation` is not a finite number, a LabelMe shape other than a rectangle or a polygon, or one with the wrong number of points, a Create ML annotation with no label, an Open Images box on an `ImageID` the source holds no picture for, a TFRecord box on an example with no `image/encoded` picture, a `yolo-obb` or `dota` row whose four corners are not near a rectangle, or enclose no area. |
| `image` | An image the source names but does not hold, or one outside any sequence whose bytes repeat an earlier image; its labels go with it. A sequence frame that repeats one keeps its labels on that image's asset. A nuScenes camera frame, which is not read. A `segmentation-png` picture with no mask file, which is not imported. A LabelMe picture held only as embedded `imageData`. An Open Images `ImageID` with no picture under its split's directory, counted per box file. A TFRecord example with no `image/encoded` picture, counted per record file. |
| `scan` | A scan whose points repeat an earlier scan's, or one gone from the source; its labels go with it. A nuScenes sweep or radar frame, which is not read. |
| `attribute` | An attribute value its class does not declare or does not accept, or one a label already on its asset holds otherwise, and extras the importer does not carry, such as a COCO attribute value that is not a string, a boolean or a number, COCO's `iscrowd` flag (the region is kept as an ordinary label), VOC difficult or pose flags, a DOTA `difficult` flag other than `0` or `1`, an OpenLane camera calibration, a track id outside a sequence or one a track cannot hold, a MOT box's visibility ratio or the absence of an identity (an `id` that is not positive), a CVAT attribute definition the domain has no kind for or a number's range, `occluded`, `z_order`, `group_id`, a `subset` and the interpolation CVAT would expand, a LabelMe `group_id`, picture flags, a shape flag that is not a boolean and keys LabelMe does not define, keys a Create ML entry or annotation does not define, an Open Images `LabelName` (MID) other than its `DisplayName`, a non-blank `Source` and columns the box file's documented set does not hold, a TFRecord `image/object/area`, any feature outside the Object Detection schema, an `image/source_id` other than the filename's stem and a label-map `display_name` other than its `name`, a COCO panoptic segment's `iscrowd` `1`, a category's `isthing` `0`, a `supercategory` other than its name, its `color` and any other panoptic field the schema has no place for, KITTI truncation, occlusion, alpha and calibration, nuScenes attributes, visibility, instance tokens, point counts, poses and a scene's fields other than its name. |

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
| `coco` | `annotations/instances_*.json` with images under `images/<fold>/` or `images/`, the layout the COCO exporter writes; boxes, single-ring polygons, and RLE `segmentation` objects (compressed string or uncompressed list `counts`, `size` `[height, width]`) as masks | `iscrowd` (the region is kept), a polygon of several rings (kept as one rasterized mask), an RLE mask that is malformed or not its image's size, keypoints, captions and other non-instances files, an attribute value that is not a string, a boolean or a number. Panoptic files are not read |
| `coco-panoptic` | `panoptic_*.json` under `annotations/` or at the top, each picture's RGB segment PNG in the directory named after the JSON (beside it or at the top), pictures under `images/<split>/`, `images/`, `<split>/` or the top; each segment as one mask of its category | Void pixels, a PNG not the size of its picture, a segment of an undeclared category (`label`); `iscrowd` 1, `isthing` 0, `supercategory`, `color` and other fields (`attribute`) |
| `segmentation-png` | Pictures and name-matched class-index PNG masks laid out as a `segmentation.json` descriptor at the top states: `images/` + `masks/`, with split directories when it names them, or Pascal VOC's `JPEGImages/` + `SegmentationClass/`; one mask per class present in each picture | Ignored pixels, a picture with no mask (not imported), a mask with no picture or not the size of its picture. No descriptor, a PNG mode the encoding does not read, an id the descriptor does not declare or a colour outside its palette refuses the source |
| `openlane-2d` | `labels/**/*.json`, one document per image naming it in `file_path`, the layout the OpenLane 2D exporter writes; lanes as polylines with their per-vertex `visibility`; each `segment-*` directory as an image sequence and its lanes' `track_id` as tracks | 3D points (`xyz`), a camera calibration, a track id outside a `segment-*` sequence, a lane `attribute` other than `1` to `4` or the exporter's own, a `visibility` that is not one `0` or `1` per point (the lane is kept without it), malformed lanes |
| `ultralytics` | `data.yaml` with `names` and pictures under any `images/` directory, labels at the matching `labels/` path, the layout the exporter writes; boxes (four values) and polygons (six or more, an even count); or a class tree (`train`/`val`/`test` directories of class directories) as tags | Keypoints of a pose dataset (`kpt_shape`), malformed rows, an unknown class index, a zero-area or wholly outside box, a label file with no picture, the labels of a picture whose size cannot be read |
| `yolov5-yaml` | The same layout with `nc` and a list of `names` | As `ultralytics` |
| `darknet` | `obj.names` (and `obj.data`) with the same `images/` and `labels/` layout | As `ultralytics`, bar keypoints |
| `yolo-obb` | The `ultralytics` layout and `data.yaml`, every row a class index and four normalized corners; each a rotated box | Corners only near a rectangle, kept as the nearest rectangle and a `geometry` loss; a row that is not a class and exactly eight numbers, four corners that are not near a rectangle or enclose no area, an unknown class index, a box wholly outside its picture, a label file with no picture, the labels of a picture whose size cannot be read |
| `dota` | Pictures under any `images/` directory, labels at the matching `labelTxt/` path (`<fold>/images` and `<fold>/labelTxt` as the benchmark and the exporter lay them out), every row four pixel corners, a category and an optional `difficult`; each a rotated box, the category its class, a `0` or `1` flag its boolean `difficult` attribute | A `difficult` flag other than `0` or `1`, kept as the box and lost as the flag; corners only near a rectangle, kept as the nearest rectangle and a `geometry` loss; a row that is not eight numbers, a category and at most one flag, four corners that are not near a rectangle or enclose no area, a box wholly outside its picture, a label file with no picture |
| `voc` | `Annotations/**/*.xml` with pictures under `JPEGImages/`; boxes | Pose, truncated, difficult and occluded values other than unspecified or `0`, other `<object>` children, parts, segmentation, an object with no name or box, a zero-area or outside box |
| `labelme` | Every `.json` under the source that is an object holding `shapes`, one LabelMe document per picture, `imagePath` resolved against the document's directory; `rectangle` shapes as boxes and `polygon` shapes (or shapes with no `shape_type`) as polygons, in pixels as written; shape `flags` as boolean attributes and a non-empty `description` as a string attribute | Every other shape type (`circle`, `line`, `linestrip`, `point`, `points`, `mask`, `oriented_rectangle`, ...), a rectangle that is not two points, a polygon of fewer than three, a shape with no area, no label or wholly outside its picture, `group_id`, picture flags, other keys, a picture held only as `imageData`. An `imagePath` leaving the source, malformed JSON, a non-finite coordinate or bad `imageData` refuses the source |
| `createml` | Every `.json` under the source that is an array of objects holding `image`, Apple Create ML's object-detection annotation JSON, each `image` resolved against the file's directory and measured for its size; each annotation's `coordinates` (`x`, `y` the centre, `width`, `height`, in pixels) as a box, its `label` its class | An annotation with no label or wholly outside its picture, other keys of an entry or annotation, other keys of `coordinates` (kept as the box and a `geometry` loss). An `image` leaving the source or not in it, an unreadable picture, malformed JSON or coordinates, a non-finite number or a width or height that is not positive refuses the source |
| `open-images` | `<split>-annotations-bbox.csv` at the top (an `oidv<N>-` prefix allowed), its pictures `<split>/**/<ImageID>.<ext>` measured for their size, and one `class-descriptions-boxable.csv` (or `class-descriptions.csv`) mapping `LabelName` to `DisplayName`; each row a box from its normalized `XMin`, `XMax`, `YMin`, `YMax`, its class the `DisplayName`, `Confidence` other than `1` its confidence and `IsOccluded`, `IsTruncated`, `IsGroupOf`, `IsDepiction`, `IsInside` of `1` or `0` boolean attributes | A `LabelName` other than its `DisplayName`, a non-blank `Source`, extreme-click points (kept as the box and a `geometry` loss), other columns, a box wholly outside its picture, an `ImageID` with no picture (an `image` loss, its boxes `label` losses). A malformed row or header, a non-numeric or non-finite coordinate, a maximum not above its minimum, an undescribed `LabelName`, two used `LabelName` sharing a `DisplayName`, an `ImageID` in two splits or matching two pictures, and an unreadable picture refuse the source |
| `tfrecord` | TensorFlow Object Detection `tf.train.Example` records: `<split>.tfrecord` or `.record` at the top, a complete shard set `<split>.tfrecord-00000-of-0000N`, or either GZIP-compressed (detected by its magic), beside one `label_map.pbtxt`; each record a picture from `image/encoded`, its boxes from normalized `image/object/bbox/{xmin,xmax,ymin,ymax}`, the class from `image/object/class/text` checked against `class/label` through the label map, and `difficult`, `truncated`, `is_crowd` of `0` or `1` boolean attributes | Instance masks and keypoints (a `geometry` loss, the box kept), `image/object/area` and other features, an `image/source_id` other than the filename's stem, a label-map `display_name` other than its `name`, an example with no `image/encoded` (an `image` loss, its boxes `label` losses). A feature of the wrong type, a malformed label map (id `0`, a repeated id or name), an unknown class or id, a text and id that disagree, a coordinate outside `[0, 1]` or a maximum not above its minimum, a declared size the picture does not have, an unreadable picture, an incomplete shard set and a record failing its CRC, truncated or followed by garbage refuse the source |
| `classification` | `labels.csv` (`image`, `class`) and `classes.txt` beside `images/`; one tag per row | A row naming a class `classes.txt` does not declare, a second row of one class on one picture, a malformed row, a row with no picture or class |
| `classification-dir` | Class directories: `<split>/<class>/<picture>` with splits `train`, `val` (or `valid`, `validation`) and `test`, or `<class>/<picture>` when there is no split directory; each picture as one tag of its directory's class, every class directory a class, an empty one included | A picture outside every class directory, a file in a class directory that is not a picture this import reads, a picture or split-level directory whose name starts with a dot (`image`). A directory inside a class directory, split directories beside other directories, two directories naming one split, class names that are not NFC-normalized or collide ignoring case, one picture filed under two classes, a link to a directory or out of the source refuse the source |
| `kitti` | A 3D object detection split: `velodyne/*.bin` scans, `label_2/*.txt` and `calib/*.txt`, at the top or in `training/` and `testing/` (or the `train/`, `val/`, `test/` the exporter writes); boxes as `cuboid_3d` in the `lidar_flu` frame | `DontCare` regions, each box's 2D image `bbox`, truncation, occlusion and alpha, the calibration itself, a score outside 0 to 1, a label with no scan, no usable calibration, a malformed line or a dimension that is not positive |
| `mot` | MOTChallenge (MOT16/17/20) sequences: every directory holding a `seqinfo.ini`, its frames `<imDir>/<frame:06d><imExt>` for frames 1 to `seqLength`, and `gt/gt.txt` boxes with `gt/labels.txt` as the class table; each sequence as an image sequence and its ids as tracks | A row whose `conf` is `0` (ignored), each box's `visibility`, the identity of a row whose `id` is not positive (the box is kept untracked), frames the sequence names but does not hold; `det/det.txt` is not read. A malformed row or `seqinfo.ini` refuses the source |
| `cvat-images` | CVAT for images 1.1: every `annotations.xml` holding `<image>` elements, its pictures under `images/` beside it; boxes, rotated boxes, polygons, polylines and image-level tags | Points, ellipses, cuboids, masks, skeletons, a box whose `rotation` is not a finite number, attribute definitions of an input type the domain has no kind for, `occluded`, a non-zero `z_order`, a `group_id`, a `subset` other than `default`, a second tag of one class on a picture. A malformed document refuses the source by file and line |
| `cvat-video` | CVAT for video 1.1: every `annotations.xml` holding `<track>` elements, its frames `images/frame_<frame:06d><ext>` beside it; each task as an image sequence and its tracks' ids as tracks, with boxes, rotated boxes, polygons and polylines per frame and `<tag frame>` as untracked tags | Tracks of shapes the domain has no geometry for, a box whose `rotation` is not a finite number, attribute definitions of an input type the domain has no kind for, `occluded`, `z_order`, `group_id`, the `keyframe="0"` mark of an interpolated frame, the frames CVAT interpolates between stored shapes or carries to the task's end, frames the task counts but does not hold. A malformed document refuses the source by file and line |
| `nuscenes` | A data root: a version folder (`v1.0-mini`, `v1.0-trainval`, ...) of JSON tables beside `samples/LIDAR_TOP/*.pcd.bin`; the LIDAR_TOP keyframes, boxes as `cuboid_3d` in the `lidar_rfu` frame, each keyframe's scene name as its group label, each scene as a point-cloud sequence in its sample order, and each `instance_token` as a track | Attributes, visibility, `num_lidar_pts` and `num_radar_pts`, a scene's description, log and map, the ego pose and calibration themselves, a box leaning more than 6 degrees, a malformed box or a dimension that is not positive, an annotation whose sample has no LIDAR_TOP keyframe, the sweeps, and every other sensor's data |

This table says what each importer reads. What has been checked, and how, is the
[verification matrix](architecture/backend/formats.md#verification-matrix): per format and
direction, the tests recorded for it and whether each is a fixture, a round trip through the
exporter, or an independent reader. `visionset format matrix` prints it for the formats installed
here.

**COCO attributes.** A label's attribute values are read from the `"visionset"` object the
exporter writes on each annotation, else from the row's own `attributes`, as CVAT's COCO export
writes them; when both are present the row's own are an `attribute` loss. A string, a boolean or a
number is carried, anything else is an `attribute` loss. COCO has no attribute definitions, so a
class defines each attribute by the first value it sees - `number`, `boolean` or `string`, never
required and with no options or default. A COCO export imported into a project whose schema
already declares the attributes therefore reads back with the same values; into a project with no
schema, a `select` reads back as a `string`.

**COCO masks.** A `segmentation` object is an RLE mask: `counts` is COCO's compressed string or
the uncompressed list of runs a crowd region is written with, over the pixels in column-major order,
and `size` is `[height, width]`, which must equal the image entry's `height` and `width`; a mask of
another size, or counts that do not cover exactly that many pixels, is a `label` loss. An image entry
with no size defers the check to the picture itself, before commit. A list of one ring is a polygon,
as before, and so is a list whose other rings have fewer than three points or no area. A list of
several rings is one object drawn in parts, which needs the image entry's `width` and `height` (a
`label` loss without them), and VisionSet's polygon has one
ring, so each part is rasterized on its own at pixel centres (a pixel is lit when its centre is
inside) and the parts are unioned into one mask - a part inside another is not a hole - reported as a
`geometry` loss. Rasterization loses what is finer than a pixel, and `pycocotools` rasterizes
polygons by its own rule, so the mask can differ from `annToMask` along the edges; RLE masks are read
exactly. VisionSet has no crowd flag: a row with `iscrowd` `1` keeps its shape - a crowd RLE becomes
an ordinary mask, a crowd polygon an ordinary polygon - and the flag is an `attribute` loss. Holes,
disconnected regions and an all-background mask are pixels like any other and read as they are.

**Class directories** (`classification-dir`). The single-label layout most classification
tooling reads, independent of the multi-label `classification` CSV. When the top of the source holds
any of `train`, `val`, `valid`, `validation` or `test`, those are the split directories and every
directory directly under one is a class; `valid` and `validation` are read as `val`, and two
directories naming one split refuse the source. Without them, the top-level directories are the
classes and the source is one undivided set. The split is not imported, as no importer imports
one: a release's split recipe assigns folds, and an export without one writes every picture under
`train`. Split directories beside other directories refuse the source, since either reading would
be a guess.

Each picture carries one tag, its directory's class. Every class directory is a class, sorted by
name in code-point order, including an empty one. Names are kept verbatim; one that is not
NFC-normalized or not valid UTF-8, holds a control character or surrounding whitespace, or equals
another ignoring case refuses the source, naming the directories. A directory inside a class
directory refuses the source rather than flattening it. The same bytes under two different classes
refuse the source, naming both paths: a class-directory dataset gives a picture one class, and
reading it as two tags would invent a multi-label fact the layout cannot state. The same bytes twice
under one class are left to the import's ordinary handling of repeated pictures.

Entries whose name starts with a dot (`.DS_Store`, `.ipynb_checkpoints`) are skipped as filesystem
metadata; a skipped picture, and a skipped directory directly under a split, where a class would
sit, are `image` losses. A picture directly under the top or a split directory, and any file in a class directory
that is not a picture with one of the suffixes the import reads (a `.gif`, a `.txt`), are `image`
losses, so the import asks before leaving them out; other files outside class directories, such as
a README, are ignored. A link to a directory, and a link resolving outside the source, refuse it.

**COCO panoptic** (`coco-panoptic`). Independent of `coco`: the source holds
`panoptic_<split>.json` files under `annotations/` or at its top, and nothing else is read as one.
Each lists `images`, `categories` and, per picture, an annotation naming its PNG in `file_name`
and its segments in `segments_info`. The PNGs are in the directory named after the JSON file,
beside it (`annotations/panoptic_val2017/`) or at the top of the source, and the pictures under
`images/<split>/`, `images/`, `<split>/` or the top, the first that exists, so COCO's own
`annotations/panoptic_val2017.json` beside `val2017/` reads as it is downloaded. A PNG is RGB, each
pixel's segment id `R + 256 × G + 65536 × B`, and `0` is void; it is never read as a class-index
mask.

Each segment becomes one `mask` label of its category, exactly the pixels holding its id, so a
segment wrapped around another keeps its hole and two segments never share a pixel. Every declared
category is imported as a mask class, used or not. VisionSet has no thing/stuff or crowd flag and
keeps no segment or image ids: a category with `isthing` `0` is an ordinary class, an `attribute`
loss once per category, as are a `supercategory` other than its own name, a `color` and any other
category field; a segment with `iscrowd` `1` is kept as an ordinary mask, an `attribute` loss, as
is any segment field beyond `id`, `category_id`, `area`, `bbox` and `iscrowd`. `bbox` and `area`
are read off the pixels, not from the file. Void pixels are a `label` loss once per picture: they
mark an area left unlabelled or ambiguous, which no geometry holds, and they read back as
unlabelled. A segment whose `category_id` is not declared is a `label` loss and its pixels stay
unlabelled; a PNG of another size than its image entry is a `label` loss and the picture is
imported unlabelled, as is a picture with no annotation.

The JSON and the PNG must agree, and the import is refused, by file and id, when they do not: an
id `segments_info` lists that the PNG does not hold, an id the PNG holds that `segments_info` does
not list, a segment id given twice in one picture or `0`, a PNG that is missing, unreadable or not
RGB, an image or category id given twice, an annotation naming an image the file does not list,
and a picture annotated twice. `file_name` paths may not leave the source.

No external panoptic reader is run in the tests; fixtures built in the tests and the round trip
through the exporter are what has been checked.

**LabelMe JSON** (`labelme`). The documents LabelMe 3.x to 7.x writes are read: the top-level
`version`, `flags`, `shapes`, `imagePath`, `imageData`, `imageHeight` and `imageWidth`, and each
shape's `label`, `points`, `shape_type`, `flags`, `group_id`, `description` and `mask`. A JSON file
that is not an object holding `shapes`, such as an export report, is not read; a source holding no
document is refused. `version` is not checked. A `rectangle` is two opposite corners in either
order and becomes the box between them; a `polygon` is three or more vertices, kept in order with
no closing repeat added or removed; a shape with no `shape_type` is a polygon, as LabelMe 3.x
treats it. No coordinate is rounded, clamped or normalized. Nothing else is converted: a
`linestrip` is not read as a polyline, nor a `circle`, `point` or `oriented_rectangle` as anything,
each a `label` loss.

Only one attribute mapping is made, because only it is unambiguous: each entry of a shape's
`flags` is a boolean attribute of that name, and a non-empty `description` is the string attribute
`description`; a class defines each by the first label carrying it. A flag whose value is not a
boolean, or which is named `description`, is an `attribute` loss. `group_id` joins shapes into one
object, which a label cannot say, so a non-null one is an `attribute` loss and the shape is kept;
so are picture-level `flags` set true and any other non-null key, such as LabelMe 3.x's colours.

`imagePath` is untrusted. A `\` is read as `/`, so a file written on Windows resolves; the path is
joined to the document's directory and normalized, and an absolute path, a drive letter or one that
leaves the source refuses the import. A `..` that stays inside the source, as LabelMe writes for a
document saved apart from its picture, is followed. A path naming a link that resolves outside the
source is refused. A picture the source does not hold is an `image` loss of the import, and a
picture no document names is imported unlabelled. A document above 128 MiB is refused unread.

`imageData`, when present, is decoded before anything trusts it: above 64 MiB of base64 text it is
refused undecoded, and otherwise it must be strict base64 (no whitespace, no `data:` prefix) of a
picture Pillow can read and verify, of exactly `imageWidth` by `imageHeight` when those are given;
anything else refuses the import. Its pixels are not imported: VisionSet ingests the linked file,
which LabelMe writes beside the document. A picture held only as `imageData` is an `image` loss,
its labels with it; extract it beside the document under its `imagePath` to import it.

Verified against LabelMe 7.9.1's own reader and writer: a file it writes, with embedded
`imageData`, a `group_id` and a `linestrip`, imports with exactly the losses above. Files of
earlier LabelMe versions are read from their documented shape and were not opened in those
versions.

**Create ML object detection** (`createml`). Apple Create ML's object-detection annotation JSON is
read, and no other Create ML task: a JSON array of entries `{"image": <file name>, "annotations":
[{"label": <class>, "coordinates": {"x", "y", "width", "height"}}]}`, where `x` and `y` are the
box's centre and every number is in pixels, `y` growing downward. Every `.json` under the source
that is an array holding an object with an `image` key is such a file, so a Create ML folder or an
export of `train/`, `val/` and `test/` folders reads alike; other JSON, such as an export report,
is not read, and a source holding no such file is refused. Each box becomes a box of its class
whose top-left corner is the centre less half the extent, rounded to ten decimal places to shed
float noise; no coordinate is clamped, so a box crossing its picture's border is kept as written
and only one with no pixel inside its picture is a `label` loss. Create ML has no attributes, so
none are defined.

The file records no picture size, so every picture it names is measured, as a viewer shows it.
That makes the picture required: an `image` the source does not hold, or one that is not a
readable picture, refuses the import rather than becoming an `image` loss, because its boxes could
not be checked against anything. `image` is untrusted and resolved as LabelMe's `imagePath` is -
against the file's directory, `\` read as `/`, refused when absolute, carrying a drive letter,
leaving the source or naming a link that resolves outside it. A picture named twice is refused,
and a picture no file names is imported unlabelled.

A coordinate that is missing, not a number, `true` or `false`, or not finite, a `width` or
`height` that is zero or negative, and an entry, annotation list or `coordinates` that is not the
shape above refuse the source by file. An annotation with no `label` is a `label` loss; any other
non-null key of an entry or an annotation is an `attribute` loss, and any other key of
`coordinates` (a rotation, say) a `geometry` loss that keeps the box. A file above 256 MiB is
refused unread. Checked against the documented schema; files Create ML itself wrote were not
available to test against.

**Open Images boxes** (`open-images`). The box annotations of Open Images V4 to V7 are read, and
nothing else of the dataset: image-level labels, segmentation masks, visual relationships, localized
narratives and image metadata are separate files this importer does not open, so no mask or
relationship is ever claimed. The source holds at its top one class descriptions file -
`class-descriptions-boxable.csv` or `class-descriptions.csv`, optionally prefixed `oidv6-` or
`oidv7-` as Google names them, `LabelName,DisplayName` rows with or without that header - and one
`<split>-annotations-bbox.csv` per split (`train`, `validation`, `test`, or any other name, the
`oidv<N>-` prefix again allowed), whose pictures are `<split>/**/<ImageID>.<ext>`. Two class files,
or two box files for one split, refuse the import as ambiguous.

The box file's header names its columns, in any order: `ImageID`, `LabelName`, `XMin`, `XMax`,
`YMin` and `YMax` are required, and `Source`, `Confidence`, `IsOccluded`, `IsTruncated`,
`IsGroupOf`, `IsDepiction`, `IsInside` and the V5+ extreme-click columns `XClick1X` to `YClick4Y`
are understood. Every other column is an `attribute` loss where a row fills it. The coordinates are
fractions of the picture's width and height, which no file records, so each picture an `ImageID`
names is measured as a viewer shows it; each corner is the fraction times that size, rounded to
ten decimal places of a pixel, so a box written by the exporter reads back exactly. No coordinate
is clamped, and a box with no pixel inside its picture is a `label` loss.

The class is the row's `DisplayName`, so an Open Images MID such as `/m/0k4j` is not kept: a
`LabelName` other than its `DisplayName` is an `attribute` loss, one entry per class. Class ids
are opaque strings, so the descriptions file may list them in any order with any gaps, and only
the classes a kept box uses are imported. A `LabelName` the file does not describe, one described
twice, and two used `LabelName` sharing a `DisplayName` refuse the import rather than merge two
classes; a shared `DisplayName` no box uses is not consulted.

`Confidence` of `1`, or blank, is Open Images' ground truth and sets none; any other value in
`[0, 1]` is the label's confidence. The five `Is*` flags become boolean attributes of the same names
for `1` and `0`; `-1` (unknown) or blank sets nothing. Any other flag value, a confidence outside
`[0, 1]`, a coordinate that is not a finite number, a maximum not above its minimum, a row with
more or fewer fields than the header and a malformed header refuse the source by file and line. A
non-blank `Source` is an `attribute` loss and extreme-click points a `geometry` loss that keeps
the box.

An `ImageID` is a bare file stem - letters, digits, `_` and `-` - so it cannot name a path outside
its split's directory, and an `ImageID` in two splits' files, or matching two pictures (`a.jpg`
and `a.png`), is refused. An `ImageID` with no picture is an `image` loss and its boxes `label`
losses, because the published files list every image while a download often holds a subset; a
picture that is there but unreadable refuses the import. A picture no row names is imported
unlabelled. Checked against the documented columns; files Google published were not read in a
test.

**TensorFlow Object Detection TFRecords** (`tfrecord`). What is read is the TensorFlow Object
Detection API's `tf.train.Example` dataset schema, not "a TFRecord": a TFRecord file is only a
container of length-prefixed, CRC32C-checked records, and the features inside say what a record
means. No TensorFlow or protobuf is needed; the framing and the protobuf wire format are read by
hand. The source holds at its top one label map - `label_map.pbtxt`, or one other `*.pbtxt` - and
one record file per split: `<split>.tfrecord` or `<split>.record`, or a complete shard set
`<split>.tfrecord-00000-of-0000N`. A file that starts with the gzip magic, and not with a valid record
header, is read as GZIP-compressed whatever its name, so `<split>.tfrecord.gz` is read too; it is
decompressed once, into a temporary file outside the source. A split held both whole and in shards, a
shard set missing a shard, two files for one split, two label maps, or none, refuse the import.

The label map is protobuf text: `item { id: N name: "x" }` blocks, with `display_name`, comments,
either quote and nested blocks such as `keypoints { ... }` understood, other fields skipped. A class
is named by its `name`, or by its `display_name` when it has no `name`; a `display_name` other than
the `name` is an `attribute` loss. Id `0` is the background the API reserves and refuses, as do a
negative id, an id or a name given twice, and an item with no id or no name. Every label-map class
is imported, used or not.

Each record is one picture, its bytes in `image/encoded`. The import reads them out of the record:
an image is named `<record file>/<index>-<image/filename>`, a path no file can have, and the
importer serves the picture for it through the optional `OpensPictures` port, so nothing is
unpacked into the source. `image/height` and `image/width`, when present, must be the decoded
picture's size. An example with no `image/encoded`, or an empty one, is an `image` loss and its boxes
`label` losses, as an Open Images `ImageID` without a picture is; an example with no boxes is a
picture with no labels.

The supported features, and their types: `image/encoded`, `image/filename`, `image/source_id`,
`image/format` and `image/key/sha256` (bytes); `image/height` and `image/width` (int64);
`image/object/bbox/xmin`, `xmax`, `ymin` and `ymax` (float); `image/object/class/text` (bytes);
`image/object/class/label`, `image/object/difficult`, `image/object/truncated` and
`image/object/is_crowd` (int64). Any of them holding another type refuses the source. The four
coordinate lists have one value per box and the class and flag lists either one per box or none;
each coordinate is a fraction in `[0, 1]` with the minimum below the maximum, or the source is
refused. A box's class is its `class/text`, which the label map must name; a `class/label` beside it
must be that name's id, and alone names the class by id. `difficult`, `truncated` and `is_crowd` of
`0` or `1` become boolean attributes of those names. Instance masks (`image/object/mask`) and
keypoints (`image/object/keypoint/*`) are not read in this version, a `geometry` loss that keeps the
box; `image/object/area` and any other feature are `attribute` losses, as is an `image/source_id`
other than the filename's stem. `image/format` and `image/key/sha256` describe the bytes and are not
reported.

The coordinates are float32. A corner is the fraction times the picture's size rounded to three
decimal places of a pixel, so a box whose corners carry at most three decimals - every whole-pixel
box among them - reads back exactly on a picture up to 16,384 pixels a side; any other corner is
within half a thousandth of a pixel plus the size over 2^25 - under a thousandth of a pixel up to
16,384 pixels. Checked against
the documented feature schema with a test-local parser; no file TensorFlow wrote was read in a test.

**Semantic segmentation masks** (`segmentation-png`). Nothing about a mask is guessed: the source
holds `segmentation.json` at its top, and an import without one is refused with an example of what
to write. The exporter writes one:

```json
{
  "format": "segmentation-png",
  "version": 1,
  "encoding": "index",
  "classes": {"1": "road", "7": "car"},
  "background": [0],
  "ignore": [255],
  "images": "images",
  "masks": "masks",
  "splits": ["train", "val"]
}
```

`encoding` is `index` - each pixel's grey level is its id, in an 8-bit (`L`) or 16-bit (`I;16`)
greyscale PNG - or `palette`, which adds `"palette": {"<id>": [r, g, b]}` and reads an indexed (`P`)
PNG through its own palette, or an `RGB` one, colour by colour. A mask whose PNG mode its encoding
does not read is refused by name, so an indexed PNG is never read as grey levels nor the reverse.
`classes` maps ids to names and may skip ids; `background` ids become no label unless they are listed
as a class instead; `ignore` ids become no label either, and a mask holding them is a `label` loss,
as KITTI's `DontCare` is. Ids are written in plain decimal (`"7"`, never `"07"`), an id appears in
at most one of the three, and a pixel holding an id or a colour none of them declares refuses the
source, as do two mask files that are the mask of one picture. Each class present in a picture's mask becomes one
`mask` label of that class; every declared class is imported, used or not. Pictures are under
`<images>/<split>/` and masks under `<masks>/<split>/` for each split listed, or directly under the
two directories when `splits` is empty, and neither directory may be inside the other; the split
itself is not imported. A mask is drawn over the picture as it is shown, after any EXIF quarter
turn, which is the frame ingest stores. A picture's mask has its relative path with the suffix
replaced by `<mask_suffix>.png` (`mask_suffix` is optional and empty
by default), so VOC reads with `"images": "JPEGImages", "masks": "SegmentationClass", "splits": []`
and a `palette` listing VOC's colours - VOC's masks are indexed PNGs, and its void border is the
`ignore` id `255`. A picture with no mask is not imported, an `image` loss; a mask with no picture,
or of another size than its picture, is a `label` loss, and the second's picture is imported
unlabelled. Colour-encoded masks without an explicit palette are not read, and COCO panoptic
segment maps are read by `coco-panoptic`, never as class-index masks.

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

**Rotated boxes** (`yolo-obb`, `dota`). Ordinary YOLO detection, OBB and DOTA are three formats:
an `ultralytics` row of four values is an axis-aligned box, while `yolo-obb` reads eight values as
the four corners of a rotated box. The `ultralytics` importer reads an OBB row as a four-point
polygon, because nothing in the row says it is a rectangle, so an OBB dataset is imported with
`yolo-obb`. Each row's corners go through `obb_from_corners`: any start corner, in either
direction, is the same canonical box, and four corners that are a rectangle within
`OBB_CORNER_TOLERANCE` (`1e-6` of the longest side) import with no loss.

Real corners are seldom an exact rectangle. A file writes its coordinates to a fixed number of
decimals, and DOTA's boxes are drawn by hand on whole pixels of the source picture: on the 133 rows
of Ultralytics' DOTA8, the two diagonals' midpoints sit 0.7 pixels apart at the median and 4.5 at
the 99th percentile, and corners stray up to about five degrees off square. Corners that are not an
exact rectangle are fitted to the nearest one - centred on their mean, its axis from the sides
weighted by their length, each side the mean of the two opposite ones - and that rectangle is kept
when every corner lies within **a sixth of its shorter side** of its fitted corner. The measure has
no unit, so it judges a 10-pixel ship and a 300-pixel ground track field alike. On DOTA8 the
farthest corner lies 0.035 of the shorter side from the fit at the median and 0.131 at worst; a
clear trapezoid lies at 0.30, a parallelogram skewed 30 degrees at 0.20 to 0.32 depending on its
proportions, a kite at 0.35 or more and a dart at 0.85, and a bow-tie has no fit at all. A box too
small for its shape to tell from its rounding is also kept when every corner lies within **one
unit of the row's last decimal** of the fit on each axis; the precision is read per row, from the
most decimals any of its eight coordinates spells, so `34` and `34.0` are different claims. A kept
fit is a `geometry` loss, `its four corners are only near a rectangle; the nearest rectangle is
kept`, counted once per row. Farther than that - a trapezoid, a strongly skewed parallelogram, a
kite, a bow-tie - the row is a `label` loss, never kept as a polygon.
`yolo-obb` corners are scaled by the picture's EXIF-oriented size and not rounded; a class
no row uses is declared as an `obb` class, and the descriptor rules are the YOLO family's.
`dota` skips `imagesource:` and `gsd:` header lines; its classes are the categories of the boxes it
keeps, in order of first appearance, so a class nobody used and the schema's order are not
recovered. A category is taken as spelled: the exporter writes whitespace in a class name as a
hyphen, because a row cannot quote a name, so a class `baseball diamond` exported to DOTA imports
back as `baseball-diamond`. A row's `difficult` flag is carried as the boolean `difficult`
attribute the exporter writes it from, `1` as true and `0` as false, and a class with a flagged box
defines that attribute; a row with no flag carries no value, and any other flag is an `attribute`
loss with the box kept. A picture
with no label file is imported unlabelled, an empty label file is a picture with nothing in it,
and the split is not imported. An export imports back exact, with no loss: every corner within
`1e-6` of the box's longest side (see [releases](releases.md#the-rotated-box-formats)).

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
OpenLane's left-to-right position and is carried as the `position_role` lane attribute: `1`
(left-left) is `adjacent_left`, `2` (left) `ego_left`, `3` (right) `ego_right` and `4`
(right-right) `adjacent_right`, and a class carrying one defines `position_role` as the lane
vocabulary does. The exporter writes the lane's category there instead, beside its own
`lane_<n>` track id, so a value equal to the category on a lane whose `track_id` is `lane_<n>` at
its own position `n` is that echo and is neither carried nor reported; on any other lane the value
is read like any other. Any other value is an `attribute` loss. A symbolic link to a directory under `labels/` is refused, not
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
rows are instance masks, is not read.

**CVAT XML.** Two dialects of CVAT's XML 1.1 are read, each by its own importer, and neither reads
the other's documents: `cvat-images` refuses a `<track>` and `cvat-video` refuses an `<image>`.
Every `annotations.xml` under the source is one task, the layout CVAT writes when a task is exported
with its images. The document must have an `<annotations>` root with `<version>1.1</version>`; a
`DOCTYPE` or entity declaration refuses it before anything expands. Labels are matched by name: a
shape whose `label` the document's `<meta>` labels do not declare refuses the source, and a declared
label no shape uses becomes a class when its `<type>` names a geometry the domain holds
(`rectangle`, `polygon`, `polyline` or `tag`, not `any`); a label left with no geometry, such as one
of type `any` nothing draws or one only points or skeletons use, is a `class` loss. A skeleton's
sub-labels, declared with a `<parent>`, are not classes of their own. Coordinates are pixels from the picture's
top-left corner as CVAT writes them, so a box is `x = xtl`, `width = xbr - xtl`, and polygon and
polyline `points` are `x,y;x,y;...`. Every label is written with `import` provenance, whatever its
`source`.

**CVAT rotated boxes.** CVAT draws a rotated box as the axis-aligned `<box>` before the turn and a
`rotation` in degrees, turning it about its centre clockwise on screen (x right, y down): CVAT's
canvas turns a point by `x' = dx cos r - dy sin r`, `y' = dy cos r + dx sin r` about the centre
(`rotate2DPoints` in `cvat-canvas/src/typescript/shared.ts`), and its XML writer gives `rotation`
two decimals and only when it is not zero (`cvat/apps/dataset_manager/formats/cvat.py`). That is
the sense of an `obb`'s angle, so a box whose `rotation`, reduced modulo 360, is not zero becomes
an `obb` of centre `((xtl + xbr) / 2, (ytl + ybr) / 2)`, width `xbr - xtl`, height `ybr - ytl`
and angle `rotation` in radians, stored in its canonical form (see
[annotations](annotations.md#a-rotated-box-is-a-centre-a-size-and-an-angle)). `390`, `-330` and
`210` are the same box as `30`; `0`, `360` and `-360` are an axis-aligned box. A `rotation` that is
not a finite number (`nan`, `inf`, text) is a `label` loss. The convention is taken from CVAT's
source; it has not been checked against an export from a running CVAT.

**CVAT attributes.** A label's `<attributes>` in the `<meta>` are its class's definitions: `text`
is a `string`, `number` a `number`, `checkbox` a `boolean`, and `select` and `radio` a `select`
whose options are the `<values>`, one per non-empty line, exactly as written. A non-empty
`<default_value>` the definition accepts is its default. CVAT has no required attribute, so none is; a `number`'s range and step have no place in a
definition and are an `attribute` loss, the attribute kept, and an input type other than these
five, a `select` with no values, a default the definition rejects and a second definition of one
name are each an `attribute` loss. A shape's `<attribute name>` values are read as the kind their
definition declares - a number, `true` or `false` for a checkbox - and text that does not read as
that kind, or a value with no definition, is carried as written for the import to judge. A class
takes each definition from the first document defining it.

What a `cvat-images` or `cvat-video` export reads back: every attribute value, and each
definition's name, kind, options and non-empty default. CVAT has no place for `required` or for an
empty-string default, so those read back as an optional attribute with no default; the exporter is
`lossy` and asks for consent on that account. An option that is empty or spans lines cannot be a
line of `<values>` and refuses the export before anything is written.

| CVAT 1.1 | `cvat-images` | `cvat-video` |
| --- | --- | --- |
| `<box>` | bbox | bbox, tracked |
| `<box rotation>` not a whole turn | obb | obb, tracked |
| `<box rotation>` not a finite number | `label` loss | `label` loss |
| `<polygon>`, `<polyline>` | polygon, polyline | polygon, polyline, tracked |
| `<points>`, `<ellipse>`, `<cuboid>`, `<mask>`, `<skeleton>` | `label` loss | `label` loss per stored shape |
| `<tag>` | classification tag | `<tag frame>`: an untracked classification tag on that frame |
| `<attribute>` values | the label's attribute values | the label's attribute values, per frame |
| `occluded="1"`, non-zero `z_order`, `group_id` | `attribute` loss, shape kept | `attribute` loss, shape kept |
| `subset` | `attribute` loss unless `default` | - |
| `<track id>` | refused | the track's external id, scoped to its task |
| `outside="1"` | - | a gap: no observation that frame |
| `keyframe="0"` | - | imported as an ordinary label; the mark is an `attribute` loss |
| frames between stored shapes, or after a track's last one | - | not expanded; counted as an `attribute` loss |

**CVAT for images.** Each `<image>` names its picture by a relative `name` under `images/` beside
the document (`../` and absolute names refuse the source), with an `id` that is a non-negative
integer and a positive `width` and `height`. A project export, whose `<meta>` holds a `<project>`,
keeps each subset's pictures under `images/<subset>/` and numbers them per subset, so its pictures
are read from there and an `id` is unique within its subset; a task export's are unique in the
document. A picture listed twice, in one document or two, refuses the source. A shape whose `label`
is empty, as Datumaro writes an unlabelled one, is a `label` loss on `unlabelled`. Only
`annotations.xml`, the name CVAT writes, is read: Datumaro's `<subset>.xml` naming is not.

**CVAT for video.** The task's `<meta>` must hold a `<task>` or `<job>` with a positive `<size>`,
the frame count. CVAT numbers a task's frames in its source video: the task's `<start_frame>`
(default `0`), then every `step` of a `<frame_filter>` `step=<n>` (default `1`), so a task starting
at 10 with `step=3` holds frames 10, 13, 16 and so on. The `k`-th of them is position `k`, and is
`images/frame_<frame:06d><ext>` beside the document, named by the source frame number; every frame
shares one `<ext>`. A shape or file at a frame that is not one of the task's refuses the source, as
does a `<frame_filter>` other than `step=<n>`, a `<size>` above 1,000,000 frames, and a `<job>`
export whose `<start_frame>` is not 0 (export its task instead). A video export of a task made from
images names its frames by their pictures rather than `frame_<frame:06d>`, so it is not read. Every
frame of the task is listed whether the directory holds it or not, so a
missing frame is an `image` loss whose position stays a gap. `<original_size>`, when given, is
every frame's size. The task is one image sequence named by its `<name>`, or by its directory when
it has none; two tasks naming one sequence refuse the source. CVAT records no frame timing, so
every frame's timestamp is unknown - `null`, not `0` - and its order lives in its position; a `mot`
export of such a sequence is refused for it. A sequence imported before timing could be unknown
keeps the `0` it was given. Frames whose pictures are byte-identical share one asset, and each keeps its own labels. Each `<track id>` is a track of
that sequence whose external id is the decimal `id`, and each of its shapes at `outside="0"` an
observation at its `frame`; a shape at `outside="1"` says the object is absent, so that frame is a
gap and nothing is written. Interpolation is not expanded: a stored shape at `keyframe="0"` is kept
as an ordinary label, and every frame CVAT would draw between two stored shapes, or carry from a
track's last stored shape to the task's end, is counted once in an `attribute` loss. A `<track>`
field other than `id`, `label`, `source` and `group_id` is an `attribute` loss, the track kept. A track's
shapes share one type, a track id or a frame within a track given twice refuses the source, as does
a `frame`, `outside`, `keyframe` or `occluded` that is not what CVAT writes.

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
`attribute` loss on `scene`, counted per scene, for its description, log and map.

**Each scene is a sequence, and each instance a track.** A scene's keyframes become one
`point_cloud_sequence` source named after the scene, ordered by its chain of samples
(`first_sample_token`, then each `sample.next`): a keyframe's position is its sample's index in
that chain, so a sample with no LIDAR_TOP keyframe, or whose scan the source does not hold, is a
gap, and its time is the sample's `timestamp` since the chain's first, in seconds. A box's
`instance_token` is its track id, so each instance becomes a track of that source with the token as
its `external_id`, observing its cuboids
([a track observes frame occurrences](architecture/decisions/a-track-observes-frame-occurrences.md)).
A chain that does not hold exactly the scene's samples is reported as an `attribute` loss on the
scene and the keyframes are ordered by `timestamp` instead; a scene that has neither keeps its boxes
untracked and reports that too. A timestamp missing or out of order leaves the whole scene's timing
`null`, never `0`. Every import writes its own sources, so one token in two imports is two tracks.

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
