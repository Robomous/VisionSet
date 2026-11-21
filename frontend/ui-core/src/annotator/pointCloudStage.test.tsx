/**
 * The scan stage without a GPU: jsdom has no WebGL2, which is exactly the
 * browser the fallback exists for. The view itself is covered by
 * `e2e/pointCloud.spec.ts`.
 */

import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@robomous/ui-core";
import type { AnnotationSchema } from "@visionset/annotator";
import { renderWithData } from "../testing/dataHarness";
import { PointCloudStage, type PointCloudStageProps } from "./PointCloudStage";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SOURCE = "44444444-4444-4444-8444-444444444444";

const SCHEMA: AnnotationSchema = {
  project_id: PROJECT,
  version: 1,
  classes: [],
  description: null,
  created_at: null,
  provenance: null,
};

const ASSET: PointCloudStageProps["asset"] = {
  id: "scan-1",
  source_id: SOURCE,
  thumbnail_hash: null,
  point_cloud: {
    format: "pcd",
    point_count: 120_000,
    fields: ["x", "y", "z", "intensity"],
    bounds: { minimum: [-40, -20.5, -2], maximum: [60, 20.25, 3.5] },
  },
};

function pointBuffer(count: number, flags = 0, magic = "VSPC"): ArrayBuffer {
  const out = new ArrayBuffer(16 + count * 12);
  const view = new DataView(out);
  for (let i = 0; i < 4; i += 1) view.setUint8(i, magic.charCodeAt(i));
  view.setUint32(4, 1, true);
  view.setUint32(8, count, true);
  view.setUint32(12, flags, true);
  return out;
}

let points: () => Response;

beforeEach(() => {
  points = () => new Response(pointBuffer(3), { status: 200, headers: { "content-type": "application/octet-stream" } });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/points")) return points();
    if (path.endsWith(`/sources/${SOURCE}`)) {
      return Response.json({
        id: SOURCE,
        project_id: PROJECT,
        kind: "point_cloud_directory",
        name: "sweeps",
        registered_at: "2026-11-01T00:00:00Z",
        frame: "lidar_flu",
        video: null,
      });
    }
    return Response.json({ code: "NO_STUB", message: path }, { status: 500 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stage(): void {
  renderWithData(
    <TooltipProvider>
      <PointCloudStage projectId={PROJECT} asset={ASSET} loaded={[]} schema={SCHEMA} />
    </TooltipProvider>,
  );
}

describe("the scan stage", () => {
  it("without WebGL2, says so and shows the scan's metadata instead of a view", async () => {
    stage();
    const fallback = await screen.findByTestId("point-cloud-unsupported");
    expect(fallback.textContent).toContain("offers no WebGL2");
    expect(screen.getByTestId("point-cloud-count").textContent).toBe((120_000).toLocaleString());
    expect(fallback.textContent).toContain("lidar_flu");
    expect(fallback.textContent).toContain("(-40.00, -20.50, -2.00)");
    expect(fallback.textContent).toContain("(60.00, 20.25, 3.50)");
    expect(screen.queryByTestId("point-cloud-gl")).toBeNull();
  });

  it("says the points could not be loaded when the route refuses", async () => {
    points = () => Response.json({ code: "ASSET_NOT_FOUND", message: "no" }, { status: 404 });
    stage();
    expect((await screen.findByTestId("point-cloud-error")).textContent).toContain(
      "could not be loaded",
    );
  });

  it("names what is wrong with a buffer this build cannot read", async () => {
    points = () => new Response(pointBuffer(1, 0, "NOPE"), { status: 200 });
    stage();
    expect((await screen.findByTestId("point-cloud-error")).textContent).toContain("magic");
  });
});
