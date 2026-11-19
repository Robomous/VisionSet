# Import

An import brings a dataset that already has labels - a COCO export from another tool, say - into
a project. The images become assets, the dataset's classes become the project's schema when it has
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
   returns the classes, the images by relative path, the labels on each, and a report of
   everything it could not represent. It writes nothing.
2. **Plans.** Every listed image is decoded and matched by content against the project's assets.
   An image the source names but does not hold, an image whose bytes repeat another's, and a
   label wholly outside its image are added to the loss report.
3. **Commits.** The images are stored by content hash, as [ingest](ingest.md) stores them; a
   project with no schema gets version 1 from the dataset's classes; the labels and a batch are
   written and the batch is approved, in one transaction. Approval seeds each labeled asset as
   `annotated`. Nothing is completed or promoted.

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
| `geometry` | Part of a shape the kernel has no type for, such as keypoints, 3D lane points or an unusable per-vertex visibility, while the shape itself is kept. |
| `label` | A whole label: an RLE or crowd mask, a polygon of several rings, a label outside its image. |
| `image` | An image the source names but does not hold, or one whose bytes repeat an earlier image; its labels go with it. |
| `attribute` | Extras the importer does not carry, such as COCO attributes, an OpenLane camera calibration or track id. |

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
TuSimple, CurveLanes, BDD100K and CULane have no importer: none of them carries anything a
polyline import does not already get from OpenLane, and none has a per-vertex slot.

An importer is a plugin in the `visionset.formats` entry-point group, beside the exporters; see
[formats](architecture/backend/formats.md#importers). A name nothing is installed under is refused
with `IMPORT_FORMAT_NOT_FOUND`, which lists the importable formats.
