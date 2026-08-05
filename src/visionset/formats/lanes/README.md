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

OpenLane 2D marks each vertex visible or occluded. `PolylineGeometry.points` is a list of
coordinates and there is no per-vertex slot, so the `visibility` array is written all-visible.
Extending the annotation model for one format was declined in #223 rather than smuggled in; if
per-vertex data is ever wanted it is a domain change with a wire change behind it, not a
format's business.

## Drawing lanes

There is no interactive polyline tool yet — lanes are written through the SDK, the REST API and
MCP, and reviewed in the annotator. The drawing tool is tracked separately; see #342.
