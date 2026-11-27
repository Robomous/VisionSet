# Changelog

All notable changes to VisionSet. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
[PEP 440](https://peps.python.org/pep-0440/) for the Python distribution and the equivalent npm
semver for the frontend packages, both derived from the repository-root `VERSION`.

Six internal milestones (M1–M6) got here. The first five ended in a **git tag only** —
`v0.0.1-alpha.1` … `v0.0.1-alpha.5`, with `VERSION` sitting at `0.0.1.dev0` throughout, because
nothing was being distributed. This is the first version that is.

## [Unreleased]

### Added

- **COCO RLE masks, and semantic segmentation masks as `segmentation-png`, import and export.** The `coco` importer
  reads an RLE `segmentation` object, compressed string or uncompressed list `counts` with `size` `[height, width]`,
  as a mask, which must be the image entry's size; a malformed or wrongly sized one is a `label` loss. A polygon of
  several rings is rasterized part by part at pixel centres and the parts are unioned into one mask, a `geometry`
  loss; boxes and single-ring polygons read as before. VisionSet has no crowd flag, so a row with `iscrowd` `1` keeps
  its shape and the flag is an `attribute` loss. The `coco` exporter writes a mask as compressed RLE with its `bbox`
  and `area` read off its pixels and `iscrowd` `0`, so `coco` now supports `mask` and an export reads back pixel for
  pixel; `pycocotools` decodes it to the same pixels. `segmentation-png` is a new format of pictures and
  name-matched class-index PNG masks, read only as a `segmentation.json` descriptor at the top states: `index`
  encoding (an `L` or `I;16` greyscale PNG whose grey level is the id) or `palette` encoding (a `P` or `RGB` PNG with
  an explicit colour-to-id map), the class each id names (gaps allowed), background and ignore ids, and the layout,
  `images/` + `masks/` with optional split directories or Pascal VOC's `JPEGImages/` + `SegmentationClass/`. A source
  without a descriptor, a PNG mode its encoding does not read, an undeclared id or a colour outside the palette is
  refused; each class present becomes one mask, ignored pixels and a mask with no picture or of another size are
  `label` losses, and a picture with no mask is an `image` loss. The exporter writes an `L` PNG per picture (`I;16`
  past 255 ids), ids `1` upward in schema order with `0` background, and the descriptor: masks are written pixel for
  pixel, polygons rasterized and reported degraded, boxes dropped; overlapping classes keep the lower id and are
  listed in the descriptor. COCO panoptic layouts and colour-encoded masks without an explicit palette are not
  supported (#1163).
- **Rotated boxes through CVAT XML.** `cvat-images` and `cvat-video` import a `<box>` whose `rotation`, reduced
  modulo 360 degrees, is not zero as an `obb`: CVAT turns the box before rotation clockwise on screen about its
  centre, the sense of an `obb`'s angle, so the centre and size come from `xtl`, `ytl`, `xbr` and `ybr` and the angle
  is `rotation` in radians. A `rotation` that is not a finite number is a `label` loss; a rotated box is no longer
  one. Both exporters write an `obb` as the box before rotation and its angle as `rotation` in `[0, 360)` degrees,
  none at angle 0, and declare `obb` supported, so it is no longer reported dropped; a track may mix boxes and
  rotated boxes. A rotated box reads back within float rounding (`1e-9`). The convention is taken from CVAT's
  source, not checked against a running CVAT's export (#1209).
- **Raster masks: the `mask` geometry.** A class may declare `mask`, a binary raster over the whole asset stored
  inline as COCO compressed run-length encoding: `size` is `[height, width]` and must equal the asset's pixel size,
  and `counts` is the string over the pixels read column-major, first run background. Each side is 1 to 32768, the
  area at most 100,000,000 pixels and `counts` at most 1,048,576 characters; malformed or oversized input is
  refused, and decoding is bounded by the declared size, never by the string. A mask is re-encoded canonically on
  construction, so equal masks have equal `counts` and a read may spell them differently from the write; an
  uncompressed run list is not accepted on the wire. One mask is one instance of one class, and the kernel's
  `split_class_map` and `compose_class_map` convert a class-id map to and from one mask per class present.
  `rasterize_polygon`, `rasterize_rings` and `trace_mask` convert between polygons and masks. The SDK, REST and MCP
  carry it; the annotator carries it untouched and does not draw or edit it yet. `hflip` and `rot90` move it
  exactly; every resize strategy refuses it, and the preview's size cap resamples it nearest-neighbour. No exporter
  writes a mask: every export reports it dropped. A release holding one is a version-10 manifest; every other
  release keeps its version, bytes and hash (#1162).
- **DOTA's `difficult` flag imports as a boolean attribute.** `dota` import carries a row's `0` or `1` as the boolean
  `difficult` attribute the exporter writes it from, so a DOTA dataset round-trips its flags with no `attribute` loss;
  a class with a flagged box defines the attribute, a row with no flag carries no value, and any other flag is still
  an `attribute` loss with the box kept (#1207).
- **Rotated-box formats: `yolo-obb` and `dota`, import and export.** `yolo-obb` is the Ultralytics OBB layout - the
  `ultralytics` detection layout and `data.yaml` with rows of a class index and four normalized corners - and `dota`
  is the DOTA benchmark's `<fold>/images` and `<fold>/labelTxt`, rows of four pixel corners, a category and
  `difficult`. Both write rotated boxes only: every other geometry is reported dropped, and a rectangular polygon is
  not converted. Corners are written unclamped and precise enough that a round trip returns every corner within
  `1e-6` of the box's longest side. On import, any start corner in either direction is the same canonical box. Four
  corners near a rectangle - every corner within a sixth of the fitted rectangle's shorter side of it, or within one
  unit of the row's last decimal for a box too small to judge, which takes in DOTA's hand-drawn whole-pixel
  quadrilaterals (at most 0.131 of the shorter side on Ultralytics' DOTA8) - import as the nearest rectangle and a
  `geometry` loss; a trapezoid, a skewed parallelogram, a kite, a bow-tie, or corners enclosing no area are a
  `label` loss. `difficult` is written from a boolean
  `difficult` attribute. A DOTA row cannot quote
  a category, so each whitespace run in a class name is written as one hyphen, DOTA's own spelling
  (`baseball diamond` as `baseball-diamond`), and a re-import names the class with the hyphen; two classes that would
  share a category refuse the export naming both. `yolo-obb` keeps names unchanged in `data.yaml`. The `ultralytics`
  formats and targets are unchanged (#1161).
- **Commands and MCP tools are tracked like the background jobs they mirror.** With tracking on, pre-labeling
  (`job`, `batch` and `project pre-label`; `pre_label_job`, `pre_label_batch`, `pre_label_project`), `export`
  (`export_release`), `ingest` and `inference download` (`download_connection_weights`) open the same runs, with the
  same allowlisted tags, parameters, metrics and release lineage, as the job of the same type, and
  `visionset.execution_source` is `cli` or `mcp`. Pre-labeling opens one run per job row it writes and carries that
  row's id; nothing a background job runs opens a second run. A command waits up to 10 seconds at exit for its
  deliveries and never changes its output or exit code; nothing reaches standard output, the MCP protocol channel,
  and `MLFLOW_SUPPRESS_PRINTING_URL_TO_STDOUT` is always forced to `true` so MLflow's run links cannot reach it either.
  With tracking off, nothing is imported or started. See [tracking](docs/content/tracking.md#command-line-and-mcp)
  (#1177).
- **A local MLflow server for development, and the adapter tested against a real one.** An optional `mlflow`
  Compose profile runs a pinned MLflow server on loopback port 5050 (`VISIONSET_MLFLOW_PORT` moves it) with its own
  `mlflow-data` volume; plain `docker compose up` never starts it and no service depends on it.
  `docker/compose.mlflow.yaml` installs the `mlflow` extra into the api image and points it at `http://mlflow:5000`.
  The tracking page now covers turning tracking off, standalone and Compose servers, host, container and remote
  URIs, and basic, bearer and client-certificate authentication over TLS, and states what leaves VisionSet: no
  artifacts, ever. A new test runs the adapter and background jobs against that server, directly and behind an
  authenticating HTTPS proxy with a certificate authority generated per run; CI's `tracking-smoke` job runs it on one
  Python. See [tracking](docs/content/tracking.md#a-tracking-server-for-development) (#1177).
- **Export, ingest and weight-download runs carry their own facts, and releases their lineage.** When tracking is
  on, an export run records its format, target, lossy consent, whether a recipe ran and the recipe's content hash,
  the files and bytes it wrote and the source and augmented image counts; a succeeded export also records the
  release it read as an MLflow dataset input, named by release id with the manifest hash as its digest and the label
  schema version, asset and annotation counts as its profile. An ingest run records its ingest run's own processed,
  total and failure counters, the assets it put in its batch and how many were new, and the source and batch ids. A
  weight download records the model id, commit, serving driver and declared family, and its progress as
  `bytes_done`/`bytes_total` rather than as counts. Each operation's exact allowlist is documented; nothing is
  uploaded, and no archive, weights, manifest, image, label, path, address, batch name, release tag or connection
  name is sent. `Tracker` gains `log_inputs`. See
  [tracking](docs/content/tracking.md#export) (#1176).
- **A frame says whether its objects can join a track, and why not.** A batch asset declares `observe` wherever it
  declares `annotate`, except on a `pre_labeled` frame, and `BatchAssetOut.withheld_actions` lists each refusal code
  with the actions a writable frame withholds - `ASSET_NOT_JUDGED` for `observe` there. The annotator disables *Add
  selected object* and the new-track `+` on such a frame with that reason instead of waiting for the refusal, which
  still stands behind it; removing an object from a track needs only `annotate`. Starting a track from an object is
  one write - `POST /jobs/{job_id}/tracks`, `visionset track start`, the `start_track` tool - judged as an observe
  is and then against the batch's pinned version, so a refusal leaves no empty track behind (#1194).
- **An observed object keeps its track's class in the editor.** A batch asset's `observed` names every annotation a
  track observes, from any source, with the track's class. The reassignment menu, from the row and from the canvas,
  disables every other class for such an object, naming the track, and their hotkeys do nothing; undo and redo
  refuse a step off that class, saying why, and because the history is linear a refused step holds back the steps
  behind it. This source's tracks, once read, are trusted over the declaration for their own tracks. The save refusal (`TRACK_CLASS_MISMATCH`) stays behind a declaration gone stale, and
  changing a whole track's class stays a track operation (#1195).
- **Imports carry attribute values and definitions.** An importer may define attributes on a class and give each
  label values. With no schema, the version an import creates declares the source's definitions; every value is
  judged against the class it lands under, so a value the class does not declare or does not accept is an
  `attribute` loss counted per class and attribute name, the label kept, and a label lacking a required attribute is
  a `label` loss rather than refusing the whole import. A label already on its asset with other values is not
  updated and is an `attribute` loss. `cvat-images` and `cvat-video` read `<meta>` attribute definitions and
  per-shape values, so a CVAT export reads back with the same values, options and non-empty defaults (`required` and
  an empty-string default have no place in CVAT); `coco` reads the values its exporter writes (or the row's own
  `attributes`), defining each by its first value's type; `openlane-2d` carries a lane's `attribute` 1 to 4 as
  `position_role`, ignoring only the exporter's own echo of the category. `inspect_import` and
  `import --dry-run --json` list each class's attribute definitions (#1198).
- **Background jobs are tracked in MLflow when tracking is on.** Each execution attempt of a background job opens
  one run, named after the job type and correlated by `visionset.job_id`, `visionset.attempt` and a per-attempt
  `visionset.execution_id`, so a retry or a re-queued orphan is a run of its own. A succeeded, failed or cancelled job
  ends its run `FINISHED`, `FAILED` or `KILLED`; a failure records the exception's class and error code, never its
  message. Every run carries `duration_seconds` (execution only, monotonic) and the job's final counts when it
  reported them; pre-labeling adds its confidence, replace flag, requested shapes, the answering model's id and
  revision when it is named as `<id>@<commit>`, and its written, replaced, skipped, discarded and out-of-bounds counts.
  Values come from an allowlist and are omitted, never zeroed, when unknown. Delivery runs on a thread beside the job,
  so a tracking server that is slow or down never delays or changes a job; a run left open by a dead worker or a
  stopped server is failed late on a best-effort basis. `Tracker` gains `running_runs`. See
  [tracking](docs/content/tracking.md#background-jobs) (#1175).
- **Manifest version 9: sources' frames, and timing that may be unknown.** A release holding an asset of an
  image-sequence source lists that source under `sources` with every occurrence whose asset it holds -
  `position`, `timestamp`, `asset_id`, in position order - so `cvat-video` and `mot` write every held frame of a
  tracked source, observed or not, and only a position the release holds nothing for is a gap; a CVAT task
  released whole no longer shifts its frame numbers. A frame occurrence's `timestamp` is now nullable end to end
  (`ImportedFrame`, `FrameOccurrence` through migration 26, manifest observations, REST, CLI and MCP): the
  `cvat-video` importer writes `null` where CVAT records no timing instead of `0`, and a `mot` export refuses
  unknown timing with its own message, apart from timing that is all `0`. Migration 26 keeps every stored value,
  so a sequence imported from CVAT earlier keeps its `0`. `sources` is omitted when no released asset belongs to an
  image sequence, so such a release keeps its version and hash (#1199).
- **Rotated boxes: the `obb` geometry.** A class may declare `obb`, a rectangle turned in the image plane: centre
  `cx`, `cy`, sides `width`, `height` and the width side's `angle` in radians, y down. Every box is stored in one
  canonical spelling - `width >= height`, `angle` in `[-pi/2, pi/2)`, a square's in `[-pi/4, pi/4)` - and a zero or
  negative side or a nonfinite value is refused. The SDK, REST and MCP write it, the annotator draws, moves,
  resizes and rotates it, and a frame check uses the rectangle itself. `voc`, `darknet` and `yolov5-yaml`
  write it as its enclosing axis-aligned box, reported degraded; every other format drops it, reported dropped.
  `letterbox`, `hflip`, `rot90` and `brightness_contrast` move it exactly; `stretch`, `fill` and `center_crop`
  refuse it. A release holding one is a version-8 manifest; every other release keeps its version and hash
  (#1160).
- **Optional MLflow tracking adapter.** `visionset.tracking` adds a neutral `Tracker`, a no-op default and an MLflow
  implementation that addresses runs by explicit id through `MlflowClient`, installed with
  `pip install "visionset[mlflow]"` (`mlflow-skinny`). Off unless `VISIONSET_MLFLOW_ENABLED` is true - a
  `MLFLOW_TRACKING_URI` alone never turns it on - and, when off, the client is not imported and nothing is sent.
  Enabled with no URI, a URI carrying credentials or a query string, or no client installed is refused as `TRACKING_UNAVAILABLE`; a
  server that is down is a sanitized warning with bounded timeouts, never a failure. Only the settings cross into a
  worker. See [tracking](docs/content/tracking.md) (#1174).
- **Tracks in the annotation workspace.** On a frame of a video or image-sequence source, the side panel gains a
  Tracks region: the source's tracks with their class and frame count, the followed track's standing in this batch,
  and `‹` / `›` to its previous and next frame in the job, through the save-first path, passing over - and saying
  so - frames another job carries. *Add selected object* observes the selected object at this frame, *Remove from
  track* takes the observation away and keeps the object, and `+` starts a track of the object's class from it. A
  frame whose bytes repeat at several positions asks which one a write names. Writes save first, are gated on the
  frame's `annotate` declaration and render the kernel's refusals as prose; an observed object's row carries a
  track badge, and a pasted copy is on no track. Merging, splitting, a class change and deleting a track stay off
  the editor (#1180).
- **Image sequences read as sequences.** An `image_sequence` source has its own icon and reads *Sequence* on its
  heading and in the Images view's source menu, which groups *Videos*, *Sequences* and *Folders* when a project
  holds more than one kind (#1188).
- **Detect all: every instance of a class on one image, and you keep the ones you want.** `POST /inference/detect`
  asks a `text_detect` connection for one class on one asset - by the class's name unless a `phrase` is sent - and
  writes nothing. Each candidate carries its own `confidence`, the class it maps to, the model's label and its
  geometry, highest confidence first, at most 100; regions whose label names no phrase asked, whose shape the class
  does not admit or the model does not draw, that miss the asset or score under `minimum_confidence` are dropped and
  counted in `discarded`, never relabeled or redrawn. The editor's suggest bar gains *Detect all*, on Server only;
  every candidate starts chosen, a click on one or a tick in the `N of M chosen` list leaves it out (drawn dotted
  and hatched, labelled `left out`), `Accept N` writes only the chosen ones with their own scores in one undo step,
  and with none chosen Accept is disabled and `↵` writes nothing. A point suggestion still proposes at most one
  shape (#548).
- **CVAT XML 1.1, in and out, as two named dialects.** `cvat-images` reads and writes CVAT for images 1.1
  (`annotations.xml` with `<image>` elements and pictures under `images/`): boxes, polygons, polylines and
  image-level tags, with label attribute definitions and values written on export. `cvat-video` reads and writes
  CVAT for video 1.1: each task becomes an image-sequence source over `images/frame_<frame:06d><ext>` and each
  `<track id>` a track with that id, frames numbered from the task's `start_frame` every `frame_filter` step;
  `outside="1"` is a gap, interpolation is not expanded (the frames CVAT would draw and the `keyframe="0"` mark are
  declared losses), and the exporter closes every run of observations with an `outside="1"` keyframe and declares
  `tracked_only`. Project exports read each subset from `images/<subset>/`, and an empty label is a `label` loss. Points, ellipses, cuboids, masks, skeletons and rotated boxes
  are `label` losses; attribute values, `occluded`, `z_order`, `group_id` and a non-default `subset` are
  `attribute` losses. Documents are parsed with the standard library, a `DOCTYPE` or entity declaration is refused,
  and malformed input is refused by file and line (#1171).
- **MOTChallenge sequences, in and out.** A `mot` importer reads MOT16/17/20 sequences - every directory with a
  `seqinfo.ini`, its frames `<imDir>/<frame:06d><imExt>`, `gt/gt.txt` boxes and an optional `gt/labels.txt`
  class table - as image sequences whose positive ids become tracks scoped to their sequence. A missing frame stays
  a gap, `conf` `0` rows and box visibility are declared losses, a non-positive id keeps its box untracked, a
  fractional `conf` becomes the box's confidence, and a malformed row or `seqinfo.ini` refuses the source by file
  and line. A `mot` exporter writes each source a released track observes as `<source-id>/seqinfo.ini`, `img1/`
  and `gt/`, frame numbers from positions and ids from the imported ones, and reports every box no track observes
  dropped through a new optional `tracked_only` exporter declaration. MOTS is not supported until raster masks
  exist (#1170).
- **OpenLane track ids import as tracks.** An import may order its images into sequences; each one holding an
  asset the run creates or labels becomes a new `image_sequence` source with its frame occurrences, and each track
  id in it a track of that source with the id as `external_id`, written in the import's transaction. The
  `openlane-2d` importer reads every `segment-*` directory of numbered documents as a sequence ordered by frame
  timestamp and each lane's `track_id` as its track, so a track id is no longer an `attribute` loss there; one
  outside a sequence, or that a track cannot hold, still is. The same id in two segments or two imports is two
  tracks. A track observes 2D labels only, so nuScenes' `instance_token` stays a declared loss. The plan reports
  `sequences` and `tracks`, the run `source_ids` and `tracks_written` (#1182).
- **Release manifests carry tracks.** `MANIFEST_VERSION` is 7: a release lists every track observing an
  annotation it copies - `id`, `source_id`, `label_class`, `external_id` - with only the observations whose
  asset and annotation it holds, each as `position`, `timestamp`, `asset_id` and `annotation_id`, ordered by
  position and never by when it was recorded; tracks sort by source, first position and id, so publishing twice
  still agrees byte for byte. `tracks` is omitted when nothing in the release is observed, so an untracked
  release keeps the version and the hash it had, and every published manifest reads unchanged (#1181).
- **Tracks.** A `Track(id, source_id, label_class, external_id?)` follows one object through a video
  source as a set of observations, each naming a frame occurrence and an existing annotation on that
  occurrence's asset; `Annotation` gains no field. `TrackService` creates, observes, unobserves,
  changes a class (rewriting every observed annotation atomically, or refusing), merges, splits and
  deletes - with or without the annotations - and derives a track's status in a batch from its observed
  assets' progress, storing none. Every write but creation acts through a job and is refused unless that
  job may write every observation it touches, so a job holding part of a track cannot restructure the
  rest. Twelve new error codes; REST routes under `/sources/{id}/tracks`, `/tracks/{id}` and
  `/jobs/{id}/tracks/{track_id}`, `GET /sources/{id}/occurrences`, a `visionset track` command group and
  ten MCP tools. Migration 25 creates `track` and `track_observation` (#1179).
- **Frame occurrences.** A video import's commit writes one `FrameOccurrence` - `(source_id, position,
  timestamp, asset_id)`, unique on `(source_id, position)` - per committed frame, so two grid positions whose
  bytes deduplicate to one asset are two occurrences of it, and a second import of one clip keeps its own.
  Assets, deduplication and batch membership are unchanged. Migration 24 creates the table and backfills each
  video frame's first-seen position; positions an earlier import deduplicated away were never recorded and are
  not invented (#1178).
- **`fill` and `center_crop` resize strategies.** `fill` scales a recipe's images to cover the size and crops the
  overflow, centred; `center_crop` cuts a centred window at the source's own scale and pads an axis the source is
  too small to fill. A box or polygon is clipped to the canvas - a polygon cut into pieces keeps its largest -
  and a label left with under half its area is dropped. Cut-down labels are reported degraded and cut-away ones
  dropped, in the compatibility report - in rows of their own, marked by the new `cropped_by` field on a class
  row - and in the export report's `preprocessing` block (`dropped_annotations`, `clipped_annotations`); either
  needs `allow_lossy`, and the refusal carries the format's and the crop's loss in one report, before anything
  is written. Both strategies refuse a polyline with `PreprocessingStepUnsupportedGeometry`; `canvas_fit` is the
  shared arithmetic the geometry transform and the Pillow driver read (#786).
- **A split recipe can keep a group in one fold.** `SplitRecipe.group_by="group_label"` (REST `split.group_by`,
  CLI `release publish --group-by group_label`, MCP `publish_release`) cuts by the group label an importer wrote on
  each asset instead of by asset, so a group never straddles train, val and test. The fractions then count groups,
  so fold sizes are approximate; an asset with no label is still cut on its own. Opt-in: a recipe that does not
  group omits the key, so every existing recipe, split and manifest keeps its bytes. The nuScenes import writes each
  keyframe's scene name as its group label (an asset field, migration 23), and a release holding a labelled asset
  is written as manifest version 6. On `v1.0-mini` under `0.8/0.1/0.1` (seed 0), a per-asset split puts every one of the 10
  scenes in more than one fold; a grouped one puts none. Frames cut from a video clip are still split per asset
  (#1147).
- **`GET /geometries`, the geometries a class may declare.** A read-only catalog generated from the kernel's
  `IMPLEMENTED_GEOMETRIES`. The schema editor's class sheet and the annotator's add-a-class dialog read their
  shape picker from it instead of a hard-coded list; while it loads, or if the read fails, the picker is
  disabled and a failure is shown with a retry (#1128).
- **A `darknet` export dialect.** Writes `obj.data`, `obj.names`, `train.txt` and `valid.txt` over the shared
  images-and-labels layout, with `yolov4` as its target (#787).
- **Camera calibration per source, with a per-asset override.** Intrinsics, extrinsics and optional `plumb_bob`
  distortion are stored on a source and can be overridden on an asset (migration 21), over REST
  (`GET/PUT/DELETE .../calibration` on a source and on an asset), the CLI (`calibration show`, `set`, `clear`) and
  MCP (`get_calibration`, `set_calibration`, `clear_calibration`) (#1041).
- **The `polyline_3d` geometry.** An ordered path of `[x, y, z]` points in metres in the camera's sensor frame,
  with the polyline's per-vertex visibility and no image-frame bounds check. Every write, import, publish and
  pre-processing preview needs the asset's effective calibration: `CALIBRATION_MISSING` (409) when there is none,
  `CALIBRATION_RESOLUTION_MISMATCH` (422) when it was measured at another size. No export format writes it, so an
  export reports it as lost (#1038).
- **The `cuboid_3d` geometry.** A box in the same sensor frame, in metres: `center`, `size` (`[length, width,
  height]`) and a `yaw` in `[-pi, pi]`, under the same calibration rules as `polyline_3d` (#1045).
- **A read-only 3D overlay on images.** The annotation page projects a frame's `polyline_3d` and `cuboid_3d`
  labels through the asset's effective calibration and draws them under the 2D annotations; they are not
  selectable, edited or saved, and a missing or mismatched calibration draws nothing, with a notice (#1039).
- **The `point_cloud` modality.** A directory of PCD or PLY scans is registered with a declared frame
  (`lidar_flu` or `camera_rdf`) and each scan ingested as one `point_cloud` asset with a top-down thumbnail
  (migration 22; CLI `visionset ingest DIR --point-clouds FRAME`). A `polyline_3d` or `cuboid_3d` on a scan is
  read in that frame and needs no calibration; a `bbox`, `polygon` or `polyline` on one is `INVALID_ANNOTATION`
  (#1046).
- **`GET /projects/{project_id}/assets/{asset_id}/points`.** Serves a stored scan thinned to `max_points`
  (1,000 to 2,000,000, default 500,000) as a little-endian `VSPC` buffer of positions, with intensity and colour
  when the scan has them (#1048).
- **A point-cloud viewer.** On the annotation page a scan opens in a WebGL2 view that orbits about its frame's up
  axis, colours points by height, intensity or the scan's own colour, and draws its `cuboid_3d` and `polyline_3d`
  labels over the points. `@visionset/annotator` exports the scan buffer decoder, the frame axes, the orbit
  camera, the colour ramps and the label geometry from its root, and `PointCloudCanvas` from
  `@visionset/annotator/react` (#1048).
- **Scan sources over REST and MCP.** `POST /projects/{project_id}/sources/point-clouds` takes a multipart upload
  with a `frame`, and the MCP `ingest` tool takes a `frame` to read a directory as scans (#1050).
- **A `kitti` importer.** Reads a KITTI 3D object detection split (`velodyne/*.bin`, `label_2`, `calib`) into
  `point_cloud` assets under a `lidar_flu` source, with each box converted from the camera frame into the lidar
  frame as a `cuboid_3d`; a new `scan` loss kind covers a scan whose points repeat another's (#1049).
- **A `nuscenes` importer and the `lidar_rfu` scan frame.** Reads a nuScenes data root's LIDAR_TOP keyframes
  into `point_cloud` assets under a source declaring the new `lidar_rfu` frame (x right, y forward, z up), with
  each global box moved into the sensor frame through the keyframe's ego pose and calibration as a `cuboid_3d`;
  a box leaning more than 6 degrees is a `label` loss rather than flattened (#1056, #1069).
- **Cuboids are edited on a point-cloud scan.** An Edit mode on the scan view draws, moves, resizes and
  turns a `cuboid_3d` in the scan's declared frame and saves it with the frame's other work; it is disabled,
  with the reason, on a scan whose source declares no frame or a frame open for viewing only (#1070).
- **A top-down view for editing cuboids.** In Edit, an orthographic top-down view beside the perspective one
  follows its centre and drives the same editor: draw a footprint, move a box, pull a side face, or turn its yaw
  with a handle on the heading, and the other view follows while the drag is under way (#1071).
- **Point-cloud scans are uploaded from the browser.** `.pcd` and `.ply` files dropped on the ingest screen
  register a point-cloud source in a frame chosen there (`lidar_flu`, `camera_rdf` or `lidar_rfu`, with no
  default) and ingest into a batch; a drop that mixes scans with other files is refused on the screen (#1057).
- **Polylines are edited on a point-cloud scan.** In Edit, a polyline tool places `polyline_3d` vertices on the
  ground plane; Enter or a double-click finishes the line and Escape cancels it. A vertex of the selected
  polyline is dragged along the ground, a click on its segment inserts a vertex, alt-click removes one (never
  below two), and Delete removes the label; an edit that would leave every vertex in one place is refused.
  Vertex visibility is not editable on a scan: a new polyline leaves it out, so it stays unknown, and an imported
  polyline keeps its declared visibility, with an inserted vertex recorded as unlabeled (#1065).
- **Scan polyline vertices snap to the scan's height.** Placing, inserting or dragging a `polyline_3d` vertex
  takes the height of the scan point nearest the pointer on screen within 10 px, preferring the point nearest
  the eye, in the perspective and the top-down view; the vertex keeps the pointer's place, and falls back to the
  ground plane (or, when dragged, its own height) where no point is that close (#1082).
- **`BatchOut.modalities`.** A batch lists the modalities of the assets it holds, sorted and empty only for an
  empty batch, read in one aggregate per project; the MCP batch tools and `visionset batch … --json` carry it
  too. The UI names a batch's assets from it (*12 scans*, or *12 assets* for a batch holding images and scans)
  instead of guessing from the project's sources with one `/assets?limit=1` request per batch (#1111).
- **The schema editor offers `cuboid_3d` and `polyline_3d`.** *Drawn as* lists **3D box** and **3D polyline**
  beside the four image shapes, so a class the scan editor can draw is created in the browser; one class may
  declare image and scan shapes together (#1092).
- **The exporter port hands a plugin the release's split `assignment`.** Cut once over the whole frozen
  manifest; `folds_of(manifest, assignment)` places assets by it. `supported_modalities` is optional on the
  port (read through `supported_modalities_of`), so a plugin declaring none is discovered and writes images
  (#1111).
- **A `kitti` exporter, the first format that writes 3D.** Writes a release's scans as KITTI splits, one per
  fold (`velodyne/*.bin` decoded from the stored PCD, `label_2`, `calib`), and each `cuboid_3d` in the camera
  frame of one fixed calibration written beside every frame: KITTI's nominal lidar-to-camera axes with no
  offset and an identity `R0_rect`. Importing the export returns the same boxes and points; the boxes are not
  in the original sensor's camera frame. Images, `polyline_3d` and tags are reported dropped, a PLY,
  compressed or georeferenced scan is refused by asset, and a pre-processing recipe is refused for an export
  that writes scans (#1122).
- **A dark theme, and a System / Light / Dark control on the rail.** The standalone app follows
  `prefers-color-scheme` (light when the system says nothing) unless the viewer picked Light or Dark, and keeps
  following live system changes while the choice is System. The choice is kept per browser, never on the server,
  and the theme is set before the first paint. Screens only follow `.dark` on `<html>`; a host sets it with
  `ui-core`'s `startTheme` and `setThemePreference` (#1125).

### Changed

- **A repeated frame in an image sequence keeps its labels.** A sequence frame whose bytes repeat an earlier image
  was already an occurrence of that image's asset, but its labels were dropped as an `image` loss, so a track over
  static or duplicated frames lost those positions. Its labels now land on the shared asset: each tracked label as
  an annotation of its own, so the track observes every occurrence, and an untracked one only when the asset does
  not already carry an equal label. A fully static clip is one asset with one annotation per tracked label per
  frame. A repeat outside any sequence is still an `image` loss, and re-running the same source still writes
  nothing. A source imported before this change, whose repeated frames' labels were a consented `image` loss, now
  has labels its held assets do not carry, so re-running it is refused with `ASSET_NOT_WRITABLE` (#1197).
- **The annotator returns focus to its view through a handle, not a DOM lookup.** `AnnotatorView` gains `focus()`,
  and `PointCloudCanvas` takes a `viewRef` whose `PointCloudView.focus()` does the same for a scan view; each leaves
  focus alone when it is already inside the view. The object panel, the frame gallery and the suggest bar call an
  `onReturnFocus` the page wires to the active view, instead of looking the view up by test id. Closing the frame
  gallery on a scan now hands the keyboard to the perspective view. The showcase uses the same handle, and
  `keepCanvasFocus` from `@visionset/ui-core` in place of its own copy (#1130).
- **A label write reads each asset once, not once per label.** The checks an import, `add`, `update` and
  `enter_unreviewed` run on every label read the label's asset, and its source for a 3D label, from the store each
  time; they now read each once per call. On the nuScenes mini split (404 keyframes, 18,538 boxes) the import's
  final transaction falls from about 9.3 to 5.1 seconds and the whole commit from about 15.3 to 11.2 (medians of
  three runs). Every refusal, its message and the position it blames are unchanged (#1148).
- **A batch of labels is inserted with one flush, not one per label.** The `Repository` port gains `add_many`,
  which reads which ids are taken for the whole batch at once, flushes every row together and then writes their
  children. An import, `add` and `enter_unreviewed` store their labels through it. On the nuScenes mini split
  (404 keyframes, 18,538 boxes) the import's final transaction falls from about 5.2 to 1.5 seconds and the whole
  commit from about 11.2 to 7.5 (medians of three runs). A duplicate id, in the store or within the batch, is
  still `EntityAlreadyExists` and a constraint failure still `ConstraintViolated`; a duplicate is now refused
  before any row of the batch is written (#1153).
- **The tilt tolerance is 6 degrees, not 5.** Run on the real nuScenes mini split (404 keyframes, 18,538 boxes), the
  pose chain reproduces nuScenes' own `num_lidar_pts` for every box. The tilt is the sensor's against the world and is
  the same for every box in a frame; it reaches 5.8 degrees, so five refused 27 frames and every label in them (495
  boxes, 2.7%), while six keeps them. Both importers share the constant (#1069).
- **The scan view follows the page theme.** The point-cloud view and the scan preview's legend and swatches draw
  on the ramps for the theme set by `.dark` on `<html>`, and the selection and drawing highlight is read again
  when that class changes, so a live switch recolours an open scan. `PointCloudCanvas` takes an optional `theme`
  (`light` when absent); without `.dark` nothing changes (#1124).
- **Release manifests gain versions 4 and 5.** A release holding a 3D label is written as manifest version 4, with
  the asset's `calibration` embedded beside it (#1038); a release holding a scan is written as version 5, whose
  assets record `modality`, their `point_cloud` metadata and the source's `frame` (#1046). Both keys are omitted
  where they do not apply, so a release of 2D images is still written as version 3 with the bytes and hash it had;
  an older build refuses a manifest that carries either.
- **`@visionset/annotator` is headless at its root; the React adapter moved to `@visionset/annotator/react`.**
  Importing the root no longer pulls in `react`, so the optional peer is genuinely optional. Breaking for
  anything that imported a React adapter name (`AnnotatorCanvas`, `useAnnotatorSnapshot`, `classColor`, …)
  from the root: import it from `@visionset/annotator/react` instead (#843).
- **`@visionset/annotator`: one place for scan cuboid maths, and one rule for the root's point-cloud exports.**
  `pointcloud/cuboid` now owns `upAxis`, `standingCuboid` and `cuboidCorners3D`, which the drawn labels, the
  handle overlay and the editor share. `boundsOf` and `framingBounds` take the sample's `origin` and always
  return scan-frame bounds. The root exports everything a point-cloud module exports (adding `zoomAt`,
  `perspective`, `lookAt`, `multiply`, the remaining `POINT_*` buffer constants, `rampRange` among others),
  except the vector arithmetic and the snap grid. The scan legend reads the ramp's ends from `rampRange`, the
  same percentiles the canvas coloured with (#1112).
- **Annotator: one disabled-with-reason pattern for the scan controls.** Edit, the draw tools, colour by and the
  labels toggle carry `aria-disabled` and their reason on the control itself, as Finish job on an editable page
  already did, so a withheld tool adds no tab stop inside its tool group and stays reachable by arrow key and
  hover. The keep-focus-on-canvas handler is one shared helper (#1112).
- **Refusals about assets say "asset", not "frame".** `ASSET_NOT_WRITABLE`, `JOB_NOT_COMPLETE`, `ASSET_NOT_IN_JOB`,
  `ASSET_NOT_IN_DATASET`, `ASSET_NOT_IN_BATCH`, `ASSET_NOT_FOUND`, `ANNOTATION_GEOMETRY_OUT_OF_BOUNDS`, `EMPTY_BATCH`
  and `EMPTY_RELEASE` read the same for a frame and a scan, and no longer collide with a scan's coordinate frame
  (#1113).
- **`@visionset/annotator`: the scan editor's chords are one table.** `SCAN_KEY_BINDINGS` lists every chord
  `scanKeyIntent` answers, and `?` is one of them (intent `help`) (#1113).
- **A batch declares `complete` only once every asset is settled.** `allowed_actions` on a batch now applies the
  `SETTLED_PROGRESS` condition a job's `complete` already applied, read from the batch's own progress tally, and
  REST, the CLI and MCP all publish the same answer. The batch panel's *Complete* follows the declaration alone
  (withheld, with its count, until it is declared) (#1112).
- **Finishing a batch is one kernel transaction.** `BatchService.finish` completes every job not yet `completed`
  (starting a `pending` one first) and then the batch, all or nothing, and only while the batch declares
  `complete`; an asset reopened while it runs refuses the whole call and moves no job. It is `POST
  /batches/{id}/finish` (answering the batch and `jobs_completed`), `visionset batch finish [--promote]` and the MCP
  tool `finish_batch`, with the same refusals on each: `BATCH_NOT_COMPLETE` for an unsettled asset,
  `INVALID_TRANSITION` outside `in_annotation`. The batch panel's *Complete* sends that one request instead of a
  request per job (#1127).
- **Test fixtures no longer declare an open batch's `complete` by default.** The ui-core and e2e transcriptions of
  a batch's actions require `settled` for an `in_annotation` batch, and every fixture derives it from the progress
  it stubs (#1129).

### Removed

- **`nearestSegment`, `cuboidFromScanCorners` and `scanCuboidCorners` from `@visionset/annotator`.** None had a
  caller; `cuboidCorners3D` replaces `scanCuboidCorners` with the same corners (#1112).
- **`BatchSummary`, `BatchSummaryItem` and `BatchSummaryProps` from `@visionset/ui-core`.** Unused outside the
  styleguide; `BatchPhase` is still exported (#1112).

### Fixed

- **A replacing pre-label run no longer deletes labels another open batch confirmed.** A frame may sit in several
  open batches at once, and a run with `replace_model_labels` in one of them deleted the labels a person had just
  confirmed in another, which then completed and promoted labels nobody judged. The run now passes over, and
  `enter_unreviewed` refuses, a frame a person moved to `annotated`, `review_pending` or `accepted` in any other
  batch, open or completed; a state seeded at approval counts only once its batch completes. The job's own earlier
  model labels stay replaceable only when they were written after every such confirmation, so labels another batch
  confirmed after this job wrote them are protected too. Reading the confirmations is now one query over the
  superseded frames instead of a walk through every batch holding them (#1212).
- **A replacing pre-label run no longer deletes labels a completed batch confirmed.** A frame settled `annotated`
  or `accepted` in a completed batch, promoted or not, reopens `pre_labeled` in a later batch because its labels
  are all a model's; a run with `replace_model_labels` now passes it over and `enter_unreviewed` refuses it, as both
  already did for a frame in the dataset, so those labels and the track observations on them survive; the entry
  above extends this to batches still open and narrows when the same job's own earlier labels stay replaceable.
  The run outcome, `pre_label_run`, the CLI summary, the MCP outcome and the MLflow metrics carry a new
  `assets_protected` count, and the Pre-label dialog reports it (#1211).
- **A suggestion answer that arrives after Escape or a class change no longer repaints the discarded preview**,
  and `↵` pressed while a suggestion is still being asked no longer moves to the next frame.
- **A scan's annotation page carries no 2D chrome and says "scan" throughout.** The 2D tool bar, the empty tool
  rail and the 2D canvas hint are gone on a scan, and Keyboard shortcuts (and `?` from the scan view) open a list
  read from the scan editor's own key table instead of the 2D sheet. The island, the job's progress, the review
  move, Skip and Un-skip, Finish job, the finished-job banner and toast, and the skipped notice name scans, not
  frames or assets (#1113).
- **A failed request for a scan's source is reported as a failure.** The stage shows the refusal with a retry,
  Edit says the source could not be read, and the summary says the frame is unknown, instead of claiming the
  source declares no frame; while the source is read, Edit carries that reason rather than a bare disabled
  control (#1113).

- **Polyline vertex snapping on a scan with stray or non-finite points.** A point with a non-finite coordinate no
  longer displaces a real point from the snap grid or stops every snap, and one far stray return no longer
  coarsens the grid's cells (#1112).

- **A scan cuboid's far-side face handles are neither drawn nor grabbable.** In the perspective view a selected
  box offers a handle only on each face turned towards the camera, so a press can no longer push a face through
  the box; the overlay and the hit test share that one test. The top-down view still offers all four side faces.
  Occlusion by the points or by other boxes is not tested (#1086).
- **A new scan cuboid starts along its drag, not at yaw 0.** The footprint drag now sets one edge: its length is
  the box's length and its direction the box's yaw, in the declared frame's axes. The width is then set across
  it with the pointer and a click or Enter, before the height as before. A drag shorter than 5 cm draws nothing
  (#1087).
- **The scan top-down view zooms about the pointer.** The wheel keeps the ground point under the pointer where
  it is, zooming in and out and at the zoom's limits; the perspective view still zooms about its centre (#1088).
- **Every edit to a scan's labels is autosaved.** The autosave now waits on the frame's image and scan documents
  together, so a second and later cuboid or polyline edit on a frame saves without `mod+s`, and a box or polyline
  being drawn, or a drag in the scan editor, holds the save (`data-autosave="held"`) as a 2D gesture does (#1110).
- **The island no longer covers a scan's view controls.** Colour by, the labels toggle and reset view share one
  bottom row with the island, beside it where the stage is wide enough and stacked above it where it is not, in
  View and in Edit; in Edit the top-down view keeps its foot clear of that row, so none of its handles sit under
  it (#1110).
- **One undo and redo on a scan.** The island's buttons and `mod+z` / `mod+shift+z` send the same undo: while a
  label is drawn it steps the draft back (the last polyline vertex, the height to the width, the width to
  nothing) and leaves the history alone, and redo does nothing; mid-drag both discard the drag first. On a scan the
  island's undo and redo name the step they take (`Undo move vehicle`), and the Edit strip's duplicate undo and redo
  buttons are removed (#1110).
- **Scan gestures end cleanly.** A drag whose label was changed underneath it, by an undo taken outside the editor
  or a delete from the panel, ends without writing anything instead of rebuilding the label from where the drag
  began, while a change to another label or to the selection leaves the drag going; a cuboid's width and height
  are taken from the click that sets them rather than the last hover, so tap and pen drawing work; a lost pointer
  capture ends the drag as a cancel, and a press with the same pointer ends a stale one; the orthographic view's
  near plane and its picking rays share one standoff, so what is drawn above the eye can be picked (#1110).
- **The scan view's chrome no longer sits under the status tag and object count.** The points summary and the
  Edit strip start below them, so at the 768 px floor the object count no longer covers the strip, and with the
  views side by side the object count keeps to the perspective view (#1088).
- **The ingest refusal for a video or a single file names point-cloud scans.** The CLI's `ingest` and the MCP
  `ingest` tool, handed something that is not a directory, now say they take a directory of still images or of
  point-cloud scans (`--point-clouds` on the CLI, `frame` on MCP) before pointing a video at the browser import
  (#1068).
- **The point-cloud e2e spec fails in CI when WebGL2 is missing.** The `annotator e2e (chromium)` job sets
  `VISIONSET_REQUIRE_WEBGL=1`, so a runner without a WebGL2 context fails those tests instead of skipping them
  (#1068).
- **Scan batches are counted in scans.** On a batch of point-cloud scans, the Overview's batch row ("1 scan",
  "N scans") and its sheet ("Scans"), the batch-delete dialog and the Complete button's line ("N scans still to
  annotate or skip") no longer say images or frames; image batches keep their wording. The delete dialog's count
  is singular for one (#1090).
- **Project-wide counts say assets, not images.** The Overview's *Assets* card and its context lines, the
  auto-label line and tooltip ("N assets have no labels yet", "1 asset has no labels yet"), the Projects list's
  *Assets* column, footer, *No assets* status, tooltips and sort label, the Home project rows and the project
  delete confirmation count a project's assets in one neutral noun, whatever kinds of media the project holds
  (#1098).
- **The Dataset screen counts assets, not images.** Its *Assets* KPI, the *N of M assets* and *N assets without
  labels* lines, *per asset*, the status line, the version history's gains, the release wall's notes and empty
  states, and the class readout (*N on M assets*, shared with the Overview's Classes card) use the neutral noun, so
  a scan dataset no longer reads as images. A single member is named by its kind (*No labels on this scan*, the
  removal dialog) (#1100).
- **Scan editing follow-ups.** After a cuboid footprint drag, focus moves to the perspective view and the height
  hint says Enter or a click finishes it; a click on an objects-panel row no longer takes keyboard focus off the
  view, in 2D and on scans; the editor's breadcrumb counts a scan job in scans ("Job · 1 scan", "Job · N scans")
  rather than frames; a `CALIBRATION_IN_USE` refusal shows a browser-worded message.
- **Replacing a calibration that 3D labels were drawn against is refused.** Setting a source's calibration, or
  an asset's override, to a different value - including a first override other than the source calibration the
  asset inherits - and clearing an override onto a different source calibration now answer `CALIBRATION_IN_USE`
  (409) while an asset it applies to holds a `cuboid_3d` or `polyline_3d` label, on every surface, instead of
  silently re-reading those labels against the new camera. Setting the identical calibration again changes
  nothing, and a first calibration where none applied, or a change nothing depends on, is still accepted (#1067).
- **A georeferenced scan keeps its precision on the `points` wire.** Positions are sent relative to an origin:
  each axis whose median point lies 8,192 or more from zero is offset by that median, rounded to a whole unit,
  and the `VSPC` buffer carries it as f64 `x, y, z` after the header under flag bit 2. A scan near zero has no
  origin and its buffer is unchanged. The viewer keeps labels and the camera in the scan's frame and subtracts the origin, in
  doubles, only from what it draws; cuboid and polyline segments are built in doubles (#1068).
- **The `points` route decodes a scan once per budget.** The decoded sample is cached per open workspace, keyed
  by the asset's content hash and the budget, bounded at 128 MiB with the least recently used dropped first;
  concurrent requests for the same uncached sample decode once (#1068).
- **An export writes the folds its release reports.** A release holding images and scans was re-cut by an image
  format over the images alone, so its folds differed from `GET /releases/{id}/assignment` and an augmented
  variant of a train image could land in `val` or `test` (#1111).
- **An image export no longer refuses over a missing scan blob**, and a class whose labels sit only on a dropped
  modality says so in its zero-count report row (#1111).
- **Declaring another frame for a point-cloud source redraws its scan previews.** The same transaction drops
  them for the thumbnail backfill to draw again, and a scan's thumbnail is served `private, no-cache` with its
  hash as the `ETag` (304 on a match) rather than as immutable at an unchanged URL (#1111).
- **The `points` route decodes a scan once for every budget, faster and in less memory.** Every budget is thinned
  from the scan's stride-1 sample, byte for byte as before; concurrent requests share one decode and at most two
  scans decode at once. A 2-million-point binary PCD now samples in about 1 s instead of about 4.5 s, and three
  concurrent budgets of it in under 4 s and about 0.4 GB peak instead of 17 s or more and 0.64 GB. The route
  sends an `ETag` of content hash, budget and build, and answers 304 before reading the scan (#1111).
- **A PLY's elements before its vertices are bounded by its vertices.** An element of empty lists ahead of one
  vertex is refused at once instead of being walked for half a minute; the bytes skipped count toward the
  point-data limit (#1111).
- **KITTI refuses a calibration tilted more than 6 degrees**, the nuScenes tolerance, as a `label` loss per box
  instead of flattening it silently (#1111).
- **An import re-checks every labelled scan's frame inside its commit**, so a frame declared again while its
  blobs were stored refuses the import; the refusal of an import into a directory declaring another frame says
  it stands even while no scan there holds a label (#1111).
- **A PCD colour field not four bytes wide is no longer listed in a scan's `fields`**, and two upload parts
  under one filename are named by content rather than arrival order (#1111).
- **Annotator: Finish job on a read-only page, and the header at 768 px.** On a read-only page Finish job is
  natively `disabled`, and its reason stays reachable by hover and keyboard focus on a wrapper around it. Below a
  56rem header the job progress drops its bar (the count stays) and the save state shows its icon alone (`Not
  saved` keeps its word), so the breadcrumb keeps the batch name readable at the 768 px viewport floor (#1063).

## [0.0.1b4] — 2026-09-15

### Changed

- **Video is imported in the browser, and this process no longer decodes one at all.** A clip is
  demuxed and decoded where it already lives - the browser, with its own `WebCodecs` support, via
  the new `@visionset/media` package - and only JPEG frames and the provenance describing them ever
  reach the server. The clip itself is never uploaded. That replaces the whole server-side path:
  `POST /projects/{id}/sources/video` is gone and a `VIDEO` source is now opened through a session
  with a middle to it -

  ```
  POST   /projects/{project_id}/video-imports    declare the clip, open the session
  GET    /video-imports/{import_id}              the session's progress
  POST   /video-imports/{import_id}/frames       stage a bounded chunk of frames (multipart)
  POST   /video-imports/{import_id}/commit       every expected frame arrived → the batch
  DELETE /video-imports/{import_id}              throw the session away
  ```

  The invariant the session exists for: **nothing staged is a project asset before `commit`**. A
  closed tab, a crashed decoder or an aborted import adds no asset and no batch to the project,
  where a half-finished server-side extraction used to leave frames in a batch and a report
  explaining the rest. `commit` refuses with `VIDEO_IMPORT_INCOMPLETE` until every expected
  ordinal has arrived, is idempotent, and answers the batch it made; `FRAME_CONTENT_CONFLICT`,
  `FRAME_ORDINAL_OUT_OF_RANGE`, `FRAME_TIMESTAMP_OFF_GRID`, `VIDEO_IMPORT_NOT_FOUND` and
  `VIDEO_IMPORT_NOT_OPEN` are the session's other refusals — the timestamp a frame declares must
  be its ordinal's own grid point, which the server derives rather than takes on trust. Opening a
  session is bounded as well as gated: a *selected cut* holding more frames than one session may
  stage is `VIDEO_IMPORT_TOO_LARGE` — counted over the canonical ranges, so narrowing a selection
  genuinely lifts it — a project already holding the
  most open sessions it may is `TOO_MANY_OPEN_VIDEO_IMPORTS`, and `start` sweeps sessions nothing
  has touched for a day — deleting each through its source, so the `VIDEO` source it declared goes
  with it. A frame must also decode to the geometry the session declared, the clip's size after
  `scale_percent`, rather than merely agree with its own descriptor - and a part heavier than that
  geometry's own raster is refused off its weight before anything decodes it, since
  `FRAMES_PER_REQUEST` bounds how many parts a request carries and never how big one is. Frame
  parts are streamed from the handle the server already spooled rather than read whole. Workspace format version 19
  adds the `video_import` and `video_import_frame` tables.

  A `VIDEO` source's locator is now an opaque `video-import:<uuid4>`, so importing the same clip
  twice creates two sources rather than deduplicating onto one; content addressing still collapses
  identical frames into one asset. `VideoProvenance` gains `policy_version` and `materializer`, so
  which sampling rules and which decoder produced a set of frames is legible in the data.

  In the browser, the ingest screen picks between `ImageIngestFlow` and `VideoImportFlow` by the
  chosen file's kind. A clip is inspected locally **before** anything is registered - container,
  codec, size, duration and source rate, or one of a closed set of refusals naming why this
  browser will not decode it - and the import shows materialized against expected frames with a
  Cancel that costs nothing, because nothing has landed yet.

- **`ffmpeg` is no longer a prerequisite for anything.** It is not installed, not shipped, not
  pinned and not documented as a dependency, and the `MediaToolUnavailable` error it was the only
  cause of is gone with it. A machine with no media binary at all now does everything VisionSet does, video included. There
  is deliberately **no fallback decoder**: a browser that cannot decode a codec says so, in the
  browser, rather than handing the file to a server that would have decoded it instead. A gate,
  `tests/scripts/no_server_video_decode.test.mjs`, refuses the reintroduction.

### Removed

- **`POST /projects/{id}/sources/video`.** There is no route that takes a video file.

- **The CLI's video path.** `visionset ingest` takes a directory of still images and only that;
  pointed at a clip it is a usage error (exit 2) naming where video import actually happens.
  `--fps`, `--range` and `--scale` are gone with it.

- **The MCP video path.** No tool in the stdio server decodes video or registers a clip: `ingest`
  takes `project`, `path` and `batch_name`, refuses anything that is not a directory, and there is
  no `register_video_source` and no `extraction_fps` parameter anywhere. A stdio agent has no way
  to perform a browser capability, so nothing stands in for it.

- **Three fields from the wire, all part of the same removal.** `IngestFailureOut.frames_produced`
  and `IngestFailureOut.frames_expected_estimate` are gone, and so is the `IngestFailureKind`
  enum member `"partial"`. They existed for one case - a clip whose bytes ran out part-way through
  a server-side extraction - and there is no longer a decode running inside `IngestService` long
  enough to stop partway. `IngestFailureKind` has two members, `unsupported` and `corrupt`, both a
  total loss for the file they name. **A client branching on `"partial"`, or reading either
  count, must be updated**: the interrupted-import case now surfaces as a `VIDEO_IMPORT_*` refusal
  on a session holding zero assets, not as a batch with a footnote. **Workspace format version 20
  rewrites the reports already on disk**: every entry a previous release wrote carries both retired
  keys, so the model that forbids extras would refuse to read one. The migration strips them, and
  folds a `partial` entry's counts into its `reason` before recording it as `corrupt`, so what a
  damaged clip actually contributed is still legible.

- **`VideoProcessor`, `FfmpegVideoProcessor` and `MediaToolUnavailable`.** The kernel declares no
  video-decoding port at all; the browser-side contract is `VideoMaterializer`.

## [0.0.1b3] — 2026-09-14

### Added

- **Pre-processing: resize and augmentation recipes applied at export.** Part of the
  pre-processing epic (#785). A recipe is a named project resource - at most one resize step
  (`letterbox` or `stretch`) followed by augmentation steps (`hflip`, `brightness_contrast`,
  `rot90`) and a number of variants per train-fold image - served as
  `/projects/{id}/preprocessing-recipes` with a preview at
  `POST /projects/{id}/preprocessing-preview`, `visionset recipe`, and the
  `create_preprocessing_recipe`, `list_preprocessing_recipes`, `get_preprocessing_recipe`,
  `update_preprocessing_recipe` and (behind `--allow-destructive`) `delete_preprocessing_recipe`
  tools. An export names one beside its target - `recipe=` on the
  export and compatibility routes, `visionset export --recipe`, `recipe` on `export_release` and
  `check_export` - and keeps the spec by value: the job carries a snapshot, and the export report
  gains a `preprocessing` block with the spec, its hash, the Pillow version and a mapping from
  every written image to its source. `ExportResult` separates `source_file_count` and
  `augmented_file_count` from the total. Augmented variants are written for the train fold only
  and named `<hash>-aug<k>`; a recipe that augments refuses a release published without a split
  (`AUGMENTATION_REQUIRES_SPLIT`), and a step refuses a geometry it cannot move
  (`PREPROCESSING_STEP_UNSUPPORTED_GEOMETRY`). Workspace format version 17 adds the
  `preprocessing_recipes` table. In the browser, **Pre-processing** is the Dataset section's
  fourth view, between Assets and Releases: the project's recipes as a list, an editor whose
  resize step is preselected from the chosen target's hints, and a preview of three sample
  assets through the export's own path; the Export dialog gains a **Pre-processing recipe**
  control, `None` by default.

- **Export targets: a release is exported for the model it will train.** Part of the
  export-targets epic (#784). Every installed format declares the targets it writes for, and the
  catalog is served on every surface: `GET /export-targets`, `visionset target list` and the
  `list_export_targets` tool, with `FormatOut.targets` naming each format's own. `POST
  /releases/{id}/export` and `GET /releases/{id}/export-compatibility` take `target` beside
  `format`, exactly one of the two; `visionset export --target` and the `target` parameter of
  `export_release` and `check_export` do the same. A target narrows its format to the geometries
  its trainer has a task for - the drop is reported, consented through `allow_lossy`, and honoured
  in the output - and the compatibility report, the export result and the job payload all record
  `target` beside `format`. The target table in `docs/content/releases.md` is generated from the
  catalog by `scripts/export_target_catalog.py`, behind a drift gate. The browser's Export
  dialog chooses a **Target model** rather than a format - the catalog grouped by family, each
  option saying what the model accepts - and its lossy consent names the target and what the
  release would lose to it.

- **A schema version records which kind of work published it** (#368). New nullable
  `provenance` on `AnnotationSchema`: `curated` for a version somebody sat down and designed,
  `annotation` for one that fell out of adding a class part-way through labeling. It gates
  nothing, enters no diff, and two versions differing only in provenance are the same
  contract — it exists so a version history can tell the milestones apart from the runs
  between them.

  Each writer states its own answer, because what makes a version incidental is the *surface*
  it came from and never the size of the change: the browser's Schema tab and
  `visionset schema apply` say `curated`, the annotator's add-class dialog says `annotation`,
  and the MCP tool takes an optional parameter defaulting to `curated`. An SDK caller may say
  nothing.

  Migration 5 (`schema_provenance`) appends the column and `FORMAT_VERSION` becomes 5.
  **Nothing is backfilled and nothing could be** — no build ever recorded which surface
  published a version, so every existing one reads as "nobody said", which a reader groups
  with `curated`. Not to be confused with `Annotation.provenance` (`human` / `model` /
  `import`), which is a different question about a different entity.

- **`⌘/Ctrl + C` and `⌘/Ctrl + V` in the annotator, and the clipboard survives moving to the next
  frame** (#123). Copy the selection, walk forward, paste it — the second half is the point: the
  clipboard is held per *job*, above the per-asset store, because a store carries an undo history
  that must not follow you between frames. It is the annotator's own clipboard, never the system
  one: what is copied is a geometry in that asset's pixel frame, meaningless anywhere else.

  A paste re-mints every id, reads `asset_id` and `schema_version` off the frame it lands on,
  and is **one** undo step however many annotations it carries. It offsets by 20 *screen* pixels
  — v1's number, divided by the live zoom, so the copy is grabbable at a fitted 20% and not
  flung across the pane at 8× — steps further out rather than stacking when a repeat would land
  on the copy before it, and clamps into a smaller frame the way dragging into the edge does,
  keeping the shape rather than flattening it. Pasting a classification tag the frame already
  carries does nothing, so a duplicate cannot reach the kernel's `DUPLICATE_CLASSIFICATION_TAG`.

  Copy is a read and works in a read-only view — carrying a box out of a completed batch is how a
  correction starts; paste is refused there by the engine itself. In a text field both chords stay
  the browser's. See `docs/content/annotations.md`.

- **An embedded job system: work that outlives its request now has a queue, and it survives a
  restart** (#328). The whole background story was 77 lines — a one-worker `ThreadPoolExecutor`
  holding closures in memory, reachable from two lambdas, losing everything queued when the
  server stopped. There is now a `JobQueue` port with a SQLite adapter (a `job` table in the
  workspace's own database, migration 4), a `ProgressReporter` port, and a dispatcher thread in
  the FastAPI lifespan feeding a `spawn` `ProcessPoolExecutor`. No separate worker command:
  `visionset server` still starts everything.

  The claim is one guarded `UPDATE` whose `rowcount` is the answer — the shape
  `set_asset_progress` already uses — so two dispatchers can never hand one job to two workers.
  A row left `running` by a dead server is settled at the next startup, and an idempotent one is
  re-queued as a **new** job so a list shows the crash *and* the recovery. `spawn` is pinned
  rather than defaulted: `fork` is unsafe beside a live pooled SQLite connection.

  Handlers live in a new `visionset.jobs` package — a sibling of `formats` and `wire` — because
  the export handler resolves a format plugin, which the kernel may not import. Two new
  import-linter contracts hold both directions; the second is load-bearing, since a worker that
  imported `visionset.server` would re-execute its module-level `app = create_app()` under
  `spawn`. See `docs/content/background-jobs.md`.

- **`GET /background-jobs`, `/background-jobs/{id}`, `/background-jobs/{id}/cancel` and
  `/background-jobs/{id}/artifact`** (#328). The generic twin of `/ingest-jobs`. Not `/jobs`:
  that prefix has served *annotation* jobs since #29 and two different things wanted the word.
  There is deliberately no `POST` — a generic launch route taking a type and a payload would be
  a remote-code surface, so every launch stays on the resource it is about.

- **`VISIONSET_JOB_WORKERS`, `VISIONSET_JOB_POLL_INTERVAL_S` and
  `VISIONSET_JOB_PROGRESS_MIN_INTERVAL_S`** (#328), through this repository's first
  `pydantic-settings` object. The default is **one** worker, and that is a property of the store
  rather than a cautious guess: SQLite has a single writer and a run writes progress as it goes.

### Deprecated

- **The `yolo` format name.** `ultralytics` is its name now; `yolo` is accepted as an alias for
  this release only and is removed in the next. `visionset export --format yolo` prints a
  deprecation line on stderr and continues, and the browser's export dialog never offers it.

### Changed

- **`yolo` format renamed `ultralytics`.**
  Part of the export-targets epic (#784). The dialect now derives its task from the release -
  segment when it holds a polygon, classify when it holds only classification tags, detect
  otherwise - and its `data.yaml` carries `path: .`, one key per fold present, and `names` as a
  mapping with no `nc`. A second dialect, `yolov5-yaml`, writes the YOLOv5 descriptor grammar
  (`./` paths, `nc`, `names` as a list) for YOLOv7. Every exporter now declares the targets it
  writes for, and the registry refuses a target declared by two formats or one promising a
  geometry its format never writes.

- **A schema version that only widens the contract now moves every open batch onto it** (#381).
  A batch is judged against the version it pinned at approval, and that pin used to move only
  when somebody asked for it. Publishing an additive version now takes every batch in
  `REPINNABLE_STATES` — `approved` or `in_annotation` — along with it, in the same transaction.

  **The safety argument is a construction rather than a policy.** `diff_classes` already answers
  *does an annotation valid under the old version stay valid under the new one?*, and when it
  answers yes a wider contract cannot invalidate anything already drawn. A **narrowing** version
  moves nothing, with `allow_destructive` or without it: that flag says *publish this*, never
  *and drag every open batch across it*. `BatchService.repin` is untouched and is now the manual
  route for exactly that case, judged against a single batch's own labels. A `completed` batch
  never moves either way — its pin is the record of what its finished work was judged against.

  This inverts a written invariant. `Batch.schema_version` said the pin "never follows the active
  version on its own — a schema that evolved mid-batch would change the rules under work in
  flight", and that turned out to be an argument about narrowing, which still never follows. What
  the old rule cost was the reason it was reopened: a project could sit two versions ahead of the
  batch somebody was annotating in, with the class they had just published invisible to them.

  `SchemaService.create_version` returns `SchemaPublication` — the version, and the batches that
  moved — instead of the version alone, and `POST /projects/{id}/schema/versions` answers
  `{published, advanced_batches}` in place of a bare version. The reads are unchanged. The
  annotator's add-a-class chain drops its third call, and with it the half-applied state audit
  finding F23 was about: publishing and moving the pin are one transaction, so *the version
  exists and the pin has not moved* is now unrepresentable rather than guarded against.

  No migration, no new port method, and no event.

- **The annotator's top bar has a verb for finishing a frame** (#383). Dogfooding #368's bar
  found that the commonest move in the product had no button: after annotating a frame, the
  thing to do is store it and go to the next one, and the only control that advanced was the
  navigator's `›` chevron — chrome rather than a verb. So **Skip** inherited prominence by
  vacuum and became the most obvious thing to press on work somebody had just done.

  **Save and next** is the bar's one filled control now, on `↵`, and **Skip** is beside it on
  `X`: two ways to resolve this frame — annotated or skipped — that both advance, and
  neither collapses into the overflow. It is the navigator's own save-first advance and not a
  second pipeline, so a refused save keeps you on the frame with the refusal on screen. It reads
  **`Next`** when no save will happen, because a button must not promise one it will not
  perform. On the last frame it is not rendered at all and **Finish job** takes the filled slot,
  which is the only place the two could have contended.

  The review move (**Submit for review**, else **Accept**) is an outline control rather than the
  primary, and submitting now says what it means — this product has no annotator identity, so a
  submitted frame is *marked for a review pass*, not routed to anybody. **Save and stay** comes
  back onto the bar as a ghost button: #368 removed it because ⌘S and every exit already save,
  and what that missed is that the chord is invisible. When the bar runs out of room it is the
  first thing reabsorbed into the overflow, the review move the second.

  `enter` now has two meanings and they never overlap: it is still the polygon ring close, and
  with nothing being drawn the React adapter reads it as the flow verb. `x` is a new row in the
  default binding table. Hotkey chips are printed on the ghost and outline controls only — they
  are a lighter-than-the-surface treatment, so on the one filled button a chip inverts into a
  dark box inside a dark button and reads as a smudge (#385); the shortcut sheet carries every
  chord regardless, derived from the live registry. Left of the bar, the progress dot gains its
  word — one microtext reading `● annotated · Saved`, because a tooltip is a place a word goes
  to not be read.

- **The annotation workspace is reorganized around where each control belongs** (#368). The top
  bar was one undifferentiated row of thirteen controls in which a navigation arrow, the save
  state and the button that ends the job all looked alike; the side panel was two tabs, and the
  Labels tab did two unrelated jobs under one heading. Both are re-cut.

  The **top bar** is three zones — where you are, what you are drawing, what happens next. The
  drawing class moves into the middle of it as a combobox with typeahead, recently-used first and
  a `Create class "…"` row when nothing matches; `c` opens it and the digits still work. Exactly
  **one** workflow primary is rendered, from the wire's own `allowed_actions`; Skip stays a
  visible secondary and the rest move to an overflow. The Save *button* is gone and `⌘/Ctrl + S`
  now exists — it never had a binding, so removing the button without adding one would have left
  save-on-navigate as the only way to store work in place. Zoom and a new fullscreen control move
  to a floating widget on the stage; undo and redo become visible tool-strip buttons.

  The **side panel** is one Annotations view. Class *selection* left it for the top bar, so the
  Labels tab is gone and the panel can no longer arm a drawing class at all; the one capability
  that tab uniquely held — toggling the asset's classification tags — stays, as a chip strip
  above the object list, rendered when the pinned schema declares a tag class. An always-present
  filter narrows the list without renumbering it, because the number is the object's identity on
  the canvas. Class reassignment moves from a card under the selection to a per-row menu, and it
  now lists **every** class with the geometry-incompatible ones disabled and carrying the reason
  (`needs a polygon`) rather than filtered out — a short list with no explanation reads as a
  schema missing its classes.

  **Adding a class mid-job is a session**, and one session is one published schema version.
  `Create and add another` (`⌘/Ctrl + ↵`) banks a class and clears the form; the primary
  publishes everything banked in one go, under one auto-written description naming them all.
  Cancelling with classes banked asks first — and asks on Escape too, since everything a session
  holds lives in the browser. The create row in the class field now carries the name that was
  typed into the dialog instead of dropping it. When it lands, the last class written becomes the
  drawing class and a toast says so.

  Related, and a promise the page could not previously keep: **the drawing class now survives the
  re-pin that follows publishing, and moving to the next frame.** It was held in a component
  keyed on the asset, and re-pinning changes the pinned-schema query key — so the class somebody
  had just created was armed and silently discarded a moment later by the refetch the re-pin
  caused. Its lifetime is now the job, the same scope the clipboard has.

  The **pinned `v{n}` badge** answers the question it raises. Pressing it says whether the batch's
  version is still the project's current one and, when it is not, what arrived since — fetched
  only on opening, because the editor is judged against the pin and a page that read the active
  version on arrival would offer classes the API then refuses.

  The project's **version history groups the versions the annotator published**: consecutive
  versions whose provenance is `annotation` collapse into one expandable row, so the curated
  milestones somebody opened the table to read are not buried under a run of `Added class "cone"
  from the annotation view`. Curated versions, and versions from before provenance existed, always
  render on their own; a run of one is not a run.

  Behind it, one ratified principle: **the annotation workspace is self-sufficient — no flow may
  force navigation out of the editor, and no exit may lose work.** Back and grid save first.

  The `Tabs` `segmented` variant is retired with the switch that was its only caller, and with it
  the `variant` prop, the context that carried it and the `data-variant` attribute.

- **The annotator's zoom has a named ceiling, honest pixels at depth, and controls that say when
  they stop** (#228). The maximum is **8x**, where one asset pixel is already an eight-pixel
  block and further magnification produces larger blocks of the same data; it was 16. Above
  **4x** the image layer renders `image-rendering: pixelated`, so deep zoom shows the asset's
  real sampling grid instead of gradients the browser invented between the pixels somebody
  zoomed in to look at — the annotation chrome is untouched by the rule.

  The annotation page's `−`/`+` used to stay enabled at both ends of the range and do nothing
  when pressed. They now carry `aria-disabled` and a tooltip naming the limit ("Maximum zoom —
  8× image pixels"), and the readout stops at exactly `800%`. `aria-disabled` rather than the
  native attribute, because a disabled `<button>` takes no pointer events and its tooltip would
  never open — a disabled-with-reason control whose reason cannot be read is a bare disabled
  control.

  This closes out #131's measurement: the frame ceiling at depth is the browser's raster of a
  scaled stage, not anything this codebase executes, so it is accepted as a limit rather than
  chased. Vector re-rendering of the annotation chrome is deferred to `cf. #342`.

- **The MCP server retires `start_job`: the first write starts the job** (#109). **Breaking for
  MCP clients**, and for that surface only — the REST route and the CLI are untouched. An agent
  no longer marks a job as being worked on: `add_annotations`, `update_annotations`,
  `delete_annotations`, `set_asset_progress` and `complete_job` each take a `pending` job to
  `in_progress` on the way in, and each publishes **`job_started`** in its answer so the move is
  never invisible. Thirty-eight tools, down from thirty-nine.

  The evidence is #36's twelve real agent runs: two of them labeled a whole job and then had
  `complete_job` refuse, because writing is gated on the *batch* being `in_annotation` and never
  on the job, so nothing in the loop forced the call until the end. #36 answered that with tool
  descriptions pointing at each other; this removes the failure mode instead.

  **Adapter policy, not a domain change.** `JOB_TRANSITIONS` is untouched, `require_move` is
  still the funnel, and only `pending` moves — a `completed` job is left alone and a batch that
  is not `in_annotation` refuses first, so nothing is quietly marked as being worked on.
  `complete_job` starts a job too, which is not redundant: a correction batch cut over
  already-labeled assets opens fully settled, so its job can be finished with no edits and no
  other write would ever reach it.

- **`POST /releases/{id}/export` answers `202` instead of the archive** (#328). **Breaking, for
  this one endpoint.** It used to be a synchronous `FileResponse` that blocked until the exporter
  finished; a real format walks every asset in a release and copies its bytes, which is minutes
  of work behind a request with no way to report progress and every proxy's timeout in front of
  it. It now returns `202` with a job to poll and a `Location: /background-jobs/{job_id}`, and
  the archive comes from `GET /background-jobs/{job_id}/artifact` once that job reports
  `succeeded`.

  Everything a *request* can refuse is still refused on the request: an unknown format is a 404
  and an unconsented lossy export a 409, neither creating a job. The browser's consent flow is
  unchanged; the export dialog polls and downloads when the job succeeds.

- **Ingest runs on the same executor**, with no wire change at all (#328). `IngestJobOut` is
  still what a client polls and `POST /sources/{id}/ingest-jobs` still answers 202 with the same
  body — only who does the work moved. An ingest now has two rows for one run: the `ingest_job`
  is the domain record, the `job` is execution plumbing, and collapsing them is a later
  migration with its own wire discussion.

### Fixed

- **The dev Docker stack no longer writes files its own user cannot own** (#672). Its three
  built services bind-mount part of the checkout read-write and ran as root, so everything they
  created there was root-owned: a `__pycache__` beside every module uvicorn imports, and the
  documentation projection the docs service writes back through its source mount. The host could
  then neither rebuild over those files nor delete them, and none of the failures pointed at the
  cause — `pnpm -r build` died on `TS5033 EACCES`, `check.sh docs` failed three stages naming
  documents nobody had edited, and `git worktree remove` gave up partway through, after having
  already deleted most of the tree and dropped the registration.

  Each image now builds a user from `VISIONSET_UID`/`VISIONSET_GID` and drops to it, and compose
  selects the same pair at run time. Both halves are needed: running as another id against an
  image whose `/workspace` belongs to root fails on the first write. The default is 1000, so the
  documented `docker compose -f docker/compose.yaml up` is unchanged for almost everybody, and
  `docker/.env` carries it where 1000 is not the right answer. Changing either value needs
  `--build`. Under rootless Docker, where the daemon already maps container-root onto the
  invoking user, set both to `0`.

  Two things travel with it because the uid change would otherwise have broken them. Corepack
  recorded the pnpm it activated under root's home, and the docs image has no `packageManager`
  field to re-derive it from, so `COREPACK_HOME` moves that record somewhere any id can read.
  And Docker creates a missing bind-mount source as root before any container starts, so
  `workspace-data/` is now tracked as an empty directory and `docker/api-dev.sh` refuses an
  unwritable one by naming the command that fixes it.

- **A narrowing schema change is judged by the shape it removes, not by the class that held
  it** (#592). Since a label class began accepting a set of geometries (#584), taking one shape
  away from a class was refused whenever *any* annotation of that class existed — including when
  every one of them was drawn as a shape the change keeps, so nothing would have been orphaned.
  The refusal is the one no flag overrides, so there was no way past it.

  An annotation carries one class **and one shape**, and that pair is now what the guard matches
  on. A `car` accepting `bbox · polygon` whose labels are all boxes may drop `polygon`; the same
  change is still refused the moment one `car` polygon exists. A class removed outright, and any
  attribute narrowed, still doom every annotation of that class whatever its shape — enumerated
  as every shape the class used to declare, which is complete because each annotation was
  validated against that declaration when it was written.

  The counts moved with the gate: a refusal, and the `blockers` `preview` publishes ahead of it,
  now report the annotations that would actually be orphaned rather than everything the class
  holds. Both gates changed together — publishing a version and re-pinning a batch ask the same
  question at different scopes — and no wire shape moved.

- **A broken internal doc link now fails a test instead of landing quietly at the top of the
  page** (#337). Renaming a `##` heading invalidates every inbound `#fragment` pointing at it, and
  nothing anywhere says so — the link still works, it just goes somewhere else, which is
  indistinguishable from correct unless you already knew which paragraph you were promised. A near
  miss during the `visionset ui` → `visionset server` rename (#329).

  `tests/scripts/docs_links.test.mjs` resolves every internal link and every anchor across all 46
  tracked Markdown files — 266 links, 551 headings — naming the file, the line and the dead
  fragment. It rides `pnpm test`, so it is in `check.sh` and in CI with no new job and no new
  dependency. External URLs are deliberately out of scope: a gate that goes red for somebody
  else's rate limit is one people learn to re-run rather than read. **No broken links were
  found** — the five its first run reported were all the checker being wrong (headings that are
  entirely inline code, and underscores in slugs), which is its own argument for the unit tests
  beside it.

- **`scripts/check.sh` says what it covered, on the stream a caller actually reads** (#336). It
  had aborted correctly on a missing `node_modules` since #249 — but on **stderr**, with nothing
  at all on stdout, so an agent or a CI step capturing stdout saw a partial run and a full one as
  the same thing: some green pytest output, then silence. The exit code was right, and nobody
  reads an exit code out of a transcript.

  Every run now ends with `check.sh: PASSED  ran=…  skipped=…` on stdout, printed from a
  `trap … EXIT` so no way out can skip it. `ran=` is what *completed*, never what was asked for,
  and `INCOMPLETE` is kept apart from `FAILED` because "the checks did not happen" and "the checks
  found something" are different news. The browser banner now follows what ran rather than what
  was requested — a run that asked for everything and died in `frontend` skipped those suites just
  as completely as `--fast` did — and stays quiet when nothing ran at all, so a usage error is not
  buried under twelve lines about Playwright. `tests/scripts/check_stages.test.mjs` guards it,
  including that every group the script knows is still dispatched: the way this rots is a stage
  quietly leaving the loop, which shrinks coverage while everything left passes.

- **The annotator's address bar names the frame on screen** (#353). `?asset=` recorded where the
  annotator was *entered*: the next and previous buttons moved through the job in the page's own
  state and never touched it, so after one press the URL named a different picture than the
  screen. Copy that link on frame 7 and the colleague you send it to lands on frame 1 — with
  nothing anywhere saying so, and answering about a picture that was never meant.

  Every frame change now rewrites it, with `replace` rather than `push`: Back still leaves the
  annotator instead of walking backwards one picture at a time, which would turn the browser's
  own button into an undo two keys away from the real one. A reload lands where you were, and a
  `?asset=` naming an asset this job does not carry is *corrected* in the address rather than
  falling back to the first frame in silence.

  It was also making tests lie: #223's cycle step read the frame out of the URL, wrote a lane
  against that id, and watched every assertion pass — against a frame that was not the one under
  test. `data-asset` on the page root was added then so a harness would stop having to ask the
  URL; the two now agree.

- **A batch whose every frame was finished could not be completed** (#301). `Complete` answered
  `BATCH_NOT_COMPLETE` beside a progress bar reading `0 to do`, and both were true: completion is
  derived at *two* levels — `BatchService.complete` refuses while any **job** is outstanding,
  `JobService.complete` while any **asset** is — and the browser only ever sent the outer one.
  `POST /jobs/{id}/complete` had a single caller in the whole app, the `Finish job` button inside
  the annotator, which somebody settling frames from the gallery never passes. `Complete` now
  finishes the batch's jobs first (starting any the annotator never opened, since
  `JOB_TRANSITIONS` has no `pending → completed` edge), and it is withheld with a count while
  frames are still outstanding rather than offered and refused. It is also on the gallery header
  now, which is the screen the work is done from.

- **A skip could not be taken back from the grid, and marking an already-skipped selection
  claimed to work** (#301). `skipped → unannotated` is a first-class edge in
  `ASSET_PROGRESS_TRANSITIONS` and had no spelling anywhere in the browser, so a mis-aimed
  shift-click over forty frames was unrecoverable without opening each one. Meanwhile
  `JobService.mark` treats a re-stated state as a documented no-op, answered `200` with nothing
  changed — so `Mark skipped` over already-skipped frames reported success over work it had not
  done. The bulk bar now offers `Mark skipped` **and** `Restore`, each counting only the selected
  frames its move is legal for and sending only those.

- **The way into the annotator disappeared once a batch had no unlabeled work left** (#301).
  `Start annotating` was drawn only while some frame was `unannotated`, so an `in_annotation`
  batch that was fully annotated or skipped rendered no action in its header at all. Opening a
  frame is legal whatever its state — the annotator lists a job's assets with no progress filter
  and carries `Un-skip` — so the door is now open whenever the batch has jobs, aimed at the first
  waiting frame when there is one and labelled for which of the two it is doing.

- **Bulk progress moves are sent one at a time.** Three concurrent moves over one job were
  measured answering `200`, `200`, `200` and moving exactly one asset: `JobService.mark` is a
  read-modify-write over one row through `session.merge`, and SQLite's single writer serializes
  *writes* rather than read-modify-write. That is a kernel-level hazard filed as **#302**; this
  release stops `ui-core` from causing it.

### Changed

- **`visionset ui` is now `visionset server`** (#329). The command starts the FastAPI server; the
  browser application is one client of it, alongside REST, the SDK and MCP, so the old name
  described a single consumer of the process rather than the process. Nothing else moved — same
  flags and defaults, same `/app` mount, same one-sentence refusal at exit 1 outside a workspace.

  **There is no alias.** `visionset ui` now fails with Typer's ordinary `No such command 'ui'`,
  so a script that calls the old name needs one edit. A deprecation shim was declined
  deliberately rather than overlooked: this is a pre-1.0 beta with no installed base to carry,
  and a hidden second spelling of the front door is a thing every later reader has to explain
  away.

- **The browser application moved from `/ui` to `/app`.** `visionset server` now serves it at
  `http://127.0.0.1:8000/app/`, and `/` still redirects there. One constant moved —
  `UI_PREFIX` in `src/visionset/server/main.py` — and `frontend/app/vite.config.ts`'s build
  `base` follows it, which is what keeps the router's basename in agreement: it is read from
  `import.meta.env.BASE_URL`, so nothing in the application names the prefix. The argument for
  *having* a prefix is unchanged (#33): the API owns the root, so an app at `/` could never
  claim `/projects/abc` as one of its own client routes.

  **This is a public URL change.** A bookmark or a pasted link under `/ui/…` now 404s; there is
  no redirect from the old prefix, because `/ui` is not a path the API answers on and adding a
  permanent redirect for a pre-1.0 beta would outlive the reason for it. The development stacks
  are untouched — `vite dev` and the compose stack both serve the app at `/`, and only a build
  has a base at all.

## [0.0.1b2] — 2026-07-31

The beta corrected. `0.0.1b1` shipped with every CI gate green — 2,000+ Python tests, 700
annotator vitest, 76 Playwright scenarios, a browser cycle against a real server, and a wheel
job — and a manual pass over the **built wheel** then found three things that made the
advertised flow wrong or unusable.

**The gap is the useful finding, and it shaped what this release adds.** Each defect sat in a
blind spot of an otherwise strong suite, and all three are the same shape: *a claim verified
against itself rather than against the artifact.* The export tests asserted the counts the code
intended, never the counts in the bytes on disk. The gallery's own docstring called its
one-column fallback "correct-but-slow rather than wrong", so its unit tests asserted exactly the
broken value. Every screen was tested in isolation and nothing walked the app the way a person
does.

So each fix ships with the guard that was missing, and every one of them was **verified by
mutation** — reintroducing the defect turns a named test red:

- an export report is now checked against the annotations actually written into the label files,
  XML documents and COCO JSON, for every installed format;
- the product is walked end to end **by clicking**, and the helper that let a spec type a job URL
  is deleted;
- the gallery's column count is measured in a real browser at two viewport widths.

### Fixed

- **`/favicon.ico` 404'd on every page** (#161) — the only console error in an otherwise clean
  load. `frontend/app/index.html` declared no icon, so the browser asked for one unprompted and
  the API root, which owns `/` deliberately (#33), correctly answered 404 in the one error body.
  Cosmetic on its own, and worth closing: a console that is empty when things are fine is worth
  more than one that always has a line in it.

  An inline SVG mark ships in `frontend/app/public/`, referenced root-relative so Vite's `base`
  rewrite puts it at `/ui/favicon.svg` in the build and `/favicon.svg` under `vite dev` — a
  literal prefix would have worked in the wheel and 404'd in development, silently either way.
  No `/favicon.ico` route was added to the API; the spec is the REST contract and a browser
  convenience file has no place in it.

- **The schema editor's colour swatch showed grey for a derived class colour** (#162), contradicting
  the dot two inches to its left and the colour the annotator actually draws — in the one control
  whose whole job is to say what colour something is. `<input type="color">` accepts only
  `#rrggbb`, `classColor` answers `hsl(...)` for a class with no declared colour, and the editor
  fell back to a neutral rather than converting.

  `hexColor` in `frontend/ui-core/src/palette.ts` converts the notation and nothing else — the rule
  stays `classColor`'s single spelling. Showing a colour still does not *declare* one: an untouched
  save sends `color: null` for a derived class, asserted on the request payload rather than on the
  control, so a schema version can never silently freeze today's hash output as if it had been
  authored. "Derive" still clears a declared colour, and now the swatch follows it.

- **The gallery rendered one tile per row at every viewport width** (#159). `useColumns` attached
  its `ResizeObserver` in an effect that began `if (element === null) return` — and the scroller it
  points at lives inside `<Async>`'s children render-prop, so on mount it does not exist yet. The
  effect took the early return, both of its dependencies were stable, and it never ran again once
  the real element arrived. `columns` stayed at its initial `1` for the life of the screen; a batch
  of six 160-px thumbnails occupied one 160-px column of a 1239-px pane.

  The arithmetic was correct throughout, which is why nothing caught it: `columnsFor(1239)` is 7
  and always was. Now the scroller is taken by a **callback ref** — React calls it with the node on
  attach and `null` on detach, so an effect keyed on that state re-runs by construction — and
  `useVirtualizer` reads the same state value, so the two halves of the screen cannot disagree
  about which element they are measuring.

  The guard is in `frontend/app/cycle/cycle.spec.ts`, against a real browser, because jsdom reports
  every element as 0×0 and the screen's unit tests were passing in exactly the state the bug
  produced. It asserts the rendered count agrees with what fits, that it is more than one at a wide
  viewport, and that narrowing the window re-flows the grid. Verified by mutation, both halves.

- **The annotator was unreachable from inside the UI** (#160). Every gallery tile rendered
  `disabled`, the annotator's own "Open the gallery" button rendered `disabled`, and nothing
  anywhere navigated to `/jobs/:jobId` — so the one thing the product is for could be reached only
  by pasting a URL whose job id came out of the REST API. `routes.tsx` never passed
  `GalleryScreen`'s `onOpenAsset`, while every sibling route wired its callbacks.

  Clicking a tile now opens the annotator **on that asset** (`/jobs/:jobId?asset=<id>`), because a
  click that landed on the fifth picture and opened the first reads as the click being ignored;
  the grid button returns to that batch's gallery, handed the project and batch by the page that
  already resolved them. Tiles in a `draft` batch stay inert — there is no job to open until
  approval cuts one — and now say so on the control itself rather than looking broken.

  The guard is the one the epic asked for: `frontend/app/cycle/cycle.spec.ts` reaches the
  annotator **entirely by clicking**, and the helper that used to fetch a job id out of the API so
  the spec could type a URL is deleted. Verified by mutation — disabling the tiles again, or
  ignoring the requested asset, each turns the walk red.

- **The export report said polygons were not carried while YOLO and VOC wrote them as bounding
  boxes** (#158). `Exporter.supported_geometries` carried one meaning and was read with two
  intents: the compatibility report treated an unsupported geometry as absent from the output,
  while both lossy exporters converted it and wrote it. A user was told three annotations would be
  lost, consented, and received two of them back as boxes under the polygon's own class name — well
  formed in every way a validator can check, and not what the report promised.

  `Exporter` gained **`degraded_geometries`** (`{polygon}` for `yolo` and `voc`, empty for `coco`
  and `dummy`), and `ClassCompatibility.supported: bool` became **`status`**, one of `supported` /
  `degraded` / `dropped`. `excluded_annotations` and `excluded_assets` now count **dropped only**,
  with `degraded_annotations` / `degraded_assets` beside them; every `reason` says what actually
  happens to that class. `compatible` is still false for either, so the `allow_lossy` gate did not
  move — only the accounting became true. `GET /formats` publishes `degraded_geometries`, and
  `visionset export` prints the two outcomes on separate lines.

  Shipped with the guard that was missing: `tests/formats/test_report_agreement.py` exports one
  release through **every installed format** and counts the annotations in the artifacts on disk,
  so a report that disagrees with its own output fails — and a fourth exporter either lands a
  counter there or is declared non-writing.

  **Breaking for API clients**: `ClassCompatibilityOut.supported` is replaced by `status`, and
  `ExportCompatibilityOut` gains two fields. Regenerate any generated client.

## [0.0.1b1] — 2026-07-31

The first published artifact: video in, a training dataset out, and nothing to install but a
wheel.

### Added

**Export formats.** Three real exporters, each declaring what it can carry.

- **YOLO** detection — `data.yaml`, one label file per image, images laid out per split. Classes
  come from the release's frozen schema rather than from the annotations present, so a class
  nobody has used yet keeps its index and a new one cannot renumber the others.
- **COCO** instances — boxes *and* polygon segmentation in one document, per split. Lossless:
  everything COCO has no field for (attributes, confidence, provenance) rides in a `visionset`
  object per annotation, so a release of boxes and polygons exports with no consent at all.
- **Pascal VOC** — one XML per image, folds as `ImageSets/Main/*.txt` listings. Coordinates are
  1-based and inclusive, which is what the format means.

**Export validation.** Before anything is written, VisionSet works out exactly what a format would
drop from a release — per class, with annotation and asset counts — and refuses to drop it
silently. The report travels three ways: attached to the refusal, carried on the result, and
written into the export directory as `visionset-export-report.json`. `check_export` /
`GET /releases/{id}/export-compatibility` ask the same question without writing.

**One wheel, with the app inside it.** `scripts/build_dist.sh` builds the frontend, copies it into
the package, and builds the distribution — in that order, which is enforced rather than
documented. `tests/packaging/` then checks the artifact rather than the source tree: the bundle is
in it, built for the right base, the entry points ship, the version metadata agrees, nothing
enormous came along, and a clean-venv install serves `/ui` for real.

**The thirty-minute flow, as a CI gate.** `examples/thirty_minute_flow.py` drives project → clip →
50 frames → 50 boxes → verified release → YOLO export → `ultralytics` loading the result. CI runs
it from the installed wheel in an empty environment, with every stage named and timed.

**Documentation for people who have not seen the repository.** A real quickstart, an
[install guide](docs/content/install.md), a [first-dataset tutorial](docs/content/tutorial.md), a
[release runbook](docs/content/releasing.md), and an MCP tool reference generated from the server's own
listing so it cannot drift from what an agent is told.

### Changed

- **The MCP server no longer advertises `delete_project` unless it was started with
  `--allow-destructive`.** Four measured agent runs sent `confirm: true` on the *first* call,
  having read the parameter in the tool description — so `confirm` is an instruction rather than a
  gate when the caller is a model. `confirm` itself is unchanged and still correct for every other
  surface; the change is only whether an agent is shown the tool. **33 tools by default.**
- `Exporter` gained `supported_geometries` / `supported_modalities`, and `export` takes a
  read-only content reader — a manifest's `uri` is where bytes were first *seen*, not a file
  anything can open.

### Fixed

- **A classification tag is now unique per `(asset, class)`**, enforced by a partial index
  (migration 12, `FORMAT_VERSION` 12). Nothing had enforced it: the service judged against the
  pinned schema alone and never read the store.
- A release naming bytes that are gone or will not decode now fails the export by name
  (`EXPORT_SOURCE_UNREADABLE`) instead of producing a training set quietly missing an image.

### Known limits

- Ingest and export are **synchronous** — there is no job to poll, and a long video is a long call.
- Video-derived asset identity is reproducible within one ffmpeg build, not across versions.
- `mask`, `polyline`, keypoints and 3D geometries are named in the domain and not implemented.
- A zoom in the annotator is O(annotations) — pan and drag hold 60fps over 220 shapes, a zoom does
  not (#131).

---

## Milestones

Each alpha is a git tag, never published. They are listed because the tree is bisectable across
them and the numbers say what each one cost.

| | | | |
| --- | --- | --- | --- |
| **M1** — the SDK | `v0.0.1-alpha.1` | 2026-07-27 | The kernel: workspaces, projects, schemas, batches, jobs, annotations, datasets, releases, events — hexagonal, framework-free, 13 issues |
| **M2** — ingest | `v0.0.1-alpha.2` | 2026-07-27 | Where assets come from: image and video sources, decomposition, content-addressed storage, thumbnails, 8 issues |
| **M3** — surfaces | `v0.0.1-alpha.3` | 2026-07-29 | The same kernel three ways: a 53-operation REST API with a committed OpenAPI contract, a full CLI, 33 MCP tools, 15 issues |
| **M4** — the annotator | `v0.0.1-alpha.4` | 2026-07-31 | A headless annotation engine and a React renderer over it: command store, geometry, interaction machine, bbox/polygon/tag tools, 14 issues |
| **M5** — the browser client | `v0.0.1-alpha.5` | 2026-07-31 | The product shell: design system, data layer, every screen, and a browser cycle test that drives a real server, 12 issues |
| **M6** — the beta | `v0.0.1-beta.1` | 2026-07-31 | Exporters, the wheel, and the thirty-minute flow as a gate, 11 issues |
| **beta.2** — the correction | `v0.0.1-beta.2` | 2026-07-31 | Five defects a manual pass over the wheel found, each with the guard that would have caught it, 6 issues |

[0.0.1b4]: https://github.com/Robomous/VisionSet/releases/tag/v0.0.1-beta.4
[0.0.1b3]: https://github.com/Robomous/VisionSet/releases/tag/v0.0.1-beta.3
[0.0.1b2]: https://github.com/Robomous/VisionSet/releases/tag/v0.0.1-beta.2
[0.0.1b1]: https://github.com/Robomous/VisionSet/releases/tag/v0.0.1-beta.1
