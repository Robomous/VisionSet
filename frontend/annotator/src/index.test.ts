import { describe, expect, it } from "vitest";

import * as root from "./index";
import * as angle from "./core/pointcloud/angle";
import * as camera from "./core/pointcloud/camera";
import * as cuboid from "./core/pointcloud/cuboid";
import * as decode from "./core/pointcloud/decode";
import * as frame from "./core/pointcloud/frame";
import * as input from "./core/pointcloud/edit/input";
import * as labels from "./core/pointcloud/labels";
import * as machine from "./core/pointcloud/edit/machine";
import * as overlay from "./core/pointcloud/edit/overlay";
import * as polyline from "./core/pointcloud/polyline";
import * as ramp from "./core/pointcloud/ramp";
import * as ray from "./core/pointcloud/ray";
import * as runScanEffects from "./core/pointcloud/edit/runScanEffects";
import * as scanDocument from "./core/pointcloud/edit/scanDocument";
import * as scene from "./core/pointcloud/edit/scene";
import * as snap from "./core/pointcloud/snap";

const INTERNAL = new Set(["surfaceGrid"]);

describe("the package root's point-cloud surface", () => {
  const modules = {
    angle,
    camera,
    cuboid,
    decode,
    frame,
    input,
    labels,
    machine,
    overlay,
    polyline,
    ramp,
    ray,
    runScanEffects,
    scanDocument,
    scene,
    snap,
  };

  for (const [name, module] of Object.entries(modules)) {
    it(`exports every value ${name} exports, the same binding`, () => {
      const missing = Object.keys(module).filter(
        (key) => !INTERNAL.has(key) && (root as Record<string, unknown>)[key] !== (module as Record<string, unknown>)[key],
      );
      expect(missing).toEqual([]);
    });
  }
});
