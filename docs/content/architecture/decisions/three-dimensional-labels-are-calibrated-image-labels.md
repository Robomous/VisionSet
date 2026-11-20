# Three-dimensional labels are calibrated image labels

`GeometryType` reserves `cuboid_3d` and `polyline_3d`, and `Asset.modality` admits only
`image`. This page fixes what those reservations mean, so the first implementation does not
settle it by accident.

## The rule

A 3D label belongs to an **image asset** and is expressed in that image's **sensor frame**.
It is interpretable only together with the calibration of the source the image came from.

- **Calibration is per source**, with an optional per-asset override. Frames from one rig
  share intrinsics and extrinsics, so the source is where they are stored.
- **`polyline_3d` is its own geometry type**, not a `polyline` with a z coordinate. It keeps
  the vertex semantics of `polyline`: per-vertex visibility is `VertexVisibility`, checked by
  the same validator, not a parallel field.
- **`cuboid_3d` is a center, a size and a yaw**, in metres, in the sensor frame. A full
  rotation is an extension of that shape, not an alternative to it.
- **A point cloud is not an image.** If a point-cloud asset is ever admitted, it is a new
  modality holding a single scan, and it arrives with a manifest that records modality
  (`MANIFEST_VERSION` 4). A multi-sensor frame is not an asset.

## What this forbids

- a 3D geometry that is read without the calibration it depends on, or that stores pixel
  coordinates in a 3D field;
- widening `Asset.modality` as a side effect of adding a geometry: a 3D label on an image does
  not need it;
- a release manifest that changes shape without a `MANIFEST_VERSION` bump;
- a sensor-pose or ego-motion model, and a `video` modality, as part of this work;
- a new geometry that reaches code assuming 2D `.points` before every dispatch over
  `Geometry` is exhaustive.

## Why

Without a frame, a 3D coordinate is a bare number triple that two exporters will read two ways.
Without a separate type, `polyline` would carry a field that is meaningless for half its
callers. Widening modality is the expensive change in this area (ingest, thumbnails, the
manifest, the viewer), and it is separable from labeling an image in 3D.

Formats that carry 3D labels (KITTI, nuScenes, OpenLane 3D) are import and export work under
the existing format issues; they follow [An import is a labeled batch](an-import-is-a-labeled-batch.md).
