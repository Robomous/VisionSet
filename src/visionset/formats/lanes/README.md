# `visionset.formats.lanes`

The port of v1's `lane_utils.py`, landed by **#223**. Five exporter plugins over v1's six
exporter functions — CULane's `.lines.txt` and its segmentation mask are two artifacts of one
format, and a caller asking for CULane wants both.

| entry point | writes | `polyline` |
| --- | --- | --- |
| `tusimple` | `label_data_<fold>.json` (JSON Lines), one record per image | **degraded** — resampled onto a fixed row grid |
| `curvelanes` | `labels/<fold>/<hash>.lines.json` | supported |
| `bdd100k-lane` | `labels/<fold>/<hash>.json`, `poly2d` with `closed: false` | supported |
| `culane` | `labels/<fold>/<hash>.lines.txt` + `laneseg_label_w16/<fold>/<hash>.png` | supported |
| `openlane-2d` | `labels/<fold>/<hash>.json` | supported |

All five declare `lossy = True`: a lane file has fields for a lane, and none of them has
anywhere to put an annotation's arbitrary attributes, its confidence, its provenance or its id.

## The lane vocabulary is a convention on attribute names

Style, colour and road position are `select` attributes on the annotation, keyed `style`,
`color` and `position_role`. That convention is defined and documented in `_core.py`, not in the
kernel — the domain does not know what a road is, and the same `polyline` geometry labels
railway tracks. `_core.declare_lane_attributes()` hands back the three declarations so a caller
building a schema does not transcribe the option lists by hand.

A missing attribute resolves to `other` and is never an error. `position_role` falls back to the
class name when the attribute is absent, so a schema whose classes *are* the positions
(`ego_left`, `road_edge`, …) needs no attributes at all.

## What is deliberately not carried

`PolylineGeometry` carries an optional per-vertex `visibility` (unlabeled, occluded, visible —
COCO's 0/1/2), added in #352 as a domain and wire change rather than a format's business.
OpenLane 2D is the one lane format with a slot for it: occluded writes `0`, visible writes `1`,
and unlabeled — like a lane with no visibility at all — writes `1`, because OpenLane has no
"unknown" and an unjudged vertex is no claim of occlusion. TuSimple, CurveLanes, BDD100K and
CULane have no per-vertex field and drop it; their `lossy` flag already says so.

`reader.py` is the inverse for OpenLane 2D, the one lane format with an importer: `0` reads back
as occluded and `1` as visible, a lane's category becomes its class, and what the domain cannot
hold (3D points, camera calibration, track ids) is reported as an import loss. See
[import](../../../../docs/content/import.md#formats).

## Drawing lanes

The annotator has a polyline tool: draw a lane point by point, select it, drag or insert and
delete its vertices, and mark individual vertices occluded. Lanes can also be written through the
SDK, the REST API and MCP. See [the annotator page](../../../../docs/content/ui/annotator.md).
