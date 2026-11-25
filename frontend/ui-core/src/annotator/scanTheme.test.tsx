/**
 * The scan view follows `.dark` on `<html>` while it is open: the points are
 * re-coloured on that theme's ramps and the highlight is read again, so a live
 * switch never leaves the view on the other theme's colours.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@robomous/ui-core";
import { decodePoints, pointColors, type AnnotationSchema, type PointSample } from "@visionset/annotator";
import { PointCloudCanvas, type PointCloudLabel } from "@visionset/annotator/react";
import { useTheme } from "../lib/theme";
import { renderWithData } from "../testing/dataHarness";
import { installFakeGl, type FakeGl } from "../testing/fakeGl";
import { PointCloudStage, type PointCloudStageProps } from "./PointCloudStage";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SOURCE = "44444444-4444-4444-8444-444444444444";

const SCHEMA: AnnotationSchema = { project_id: PROJECT, version: 1, classes: [], description: null, created_at: null, provenance: null };

const ASSET: PointCloudStageProps["asset"] = {
  id: "scan-1",
  source_id: SOURCE,
  thumbnail_hash: null,
  point_cloud: { format: "pcd", point_count: 5, fields: ["x", "y", "z"], bounds: { minimum: [0, 0, 0], maximum: [4, 4, 4] } },
};

/** Five points climbing the up axis, so the height ramp is spread over all of them. */
function climb(): ArrayBuffer {
  const count = 5;
  const out = new ArrayBuffer(16 + count * 12);
  const view = new DataView(out);
  for (let i = 0; i < 4; i += 1) view.setUint8(i, "VSPC".charCodeAt(i));
  view.setUint32(4, 1, true);
  view.setUint32(8, count, true);
  view.setUint32(12, 0, true);
  for (let i = 0; i < count; i += 1) {
    view.setFloat32(16 + i * 12, i, true);
    view.setFloat32(16 + i * 12 + 8, i, true);
  }
  return out;
}

const SCAN = decodePoints(climb());
const colorsIn = (theme: "light" | "dark"): number[] => [...pointColors(SCAN, "height", "lidar_flu", theme)];

/** What `var(--foreground)` computes to on each theme, as a browser would resolve it. */
const FOREGROUND = { light: "rgb(10, 10, 10)", dark: "rgb(250, 250, 250)" } as const;

let gl: FakeGl;

beforeEach(() => {
  gl = installFakeGl();
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    if (element instanceof HTMLSpanElement && element.style.display === "none") {
      return { color: FOREGROUND[document.documentElement.classList.contains("dark") ? "dark" : "light"] } as CSSStyleDeclaration;
    }
    return computed(element, pseudo);
  });
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/points")) return new Response(climb(), { status: 200, headers: { "content-type": "application/octet-stream" } });
    if (path.endsWith(`/sources/${SOURCE}`)) {
      return Response.json({ id: SOURCE, project_id: PROJECT, kind: "point_cloud_directory", name: "sweeps", registered_at: "2026-11-01T00:00:00Z", frame: "lidar_flu", video: null });
    }
    return Response.json({ code: "NO_STUB", message: path }, { status: 500 });
  });
});

afterEach(() => {
  document.documentElement.classList.remove("dark");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setDark(on: boolean): Promise<void> {
  await act(async () => {
    document.documentElement.classList.toggle("dark", on);
  });
  act(() => gl.flushFrames());
}

describe("the scan stage and the page theme", () => {
  async function stage(): Promise<void> {
    renderWithData(
      <TooltipProvider>
        <PointCloudStage projectId={PROJECT} asset={ASSET} loaded={[]} schema={SCHEMA} />
      </TooltipProvider>,
    );
    await screen.findByTestId("point-cloud-gl");
  }

  it("colours the points on the light ramps when the page has no dark class, as before themes", async () => {
    await stage();
    expect(gl.lastColors()).toEqual(colorsIn("light"));
    expect(gl.lastColors()).toEqual([...pointColors(SCAN, "height", "lidar_flu")]);
  });

  it("re-colours the points when the page turns dark, and back", async () => {
    await stage();
    await setDark(true);
    expect(colorsIn("dark")).not.toEqual(colorsIn("light"));
    await waitFor(() => expect(gl.lastColors()).toEqual(colorsIn("dark")));
    await setDark(false);
    await waitFor(() => expect(gl.lastColors()).toEqual(colorsIn("light")));
  });

  it("opens dark on a page that is already dark", async () => {
    document.documentElement.classList.add("dark");
    await stage();
    expect(gl.lastColors()).toEqual(colorsIn("dark"));
  });
});

describe("the highlight and the page theme", () => {
  const SAMPLE: PointSample = SCAN;
  // One array for every render, so only the theme can make the canvas read its labels again.
  const LABELS: readonly PointCloudLabel[] = [
    { id: "plain", color: "#ff0000", segments: new Float32Array([0, 0, 0, 1, 1, 1]) },
    { id: "picked", color: "#00ff00", segments: new Float32Array([0, 0, 0, 2, 2, 2]), emphasis: "selected" },
  ];

  function Themed(): JSX.Element {
    const theme = useTheme();
    return (
      <PointCloudCanvas
        sample={SAMPLE}
        frame="lidar_flu"
        colorMode="height"
        showLabels
        highlightColor="var(--foreground)"
        theme={theme}
        labels={LABELS}
      />
    );
  }

  const ink = (rgb: string): number[] => (rgb.match(/\d+/g) ?? []).map((channel) => Number(channel) / 255);

  it("draws the selected label in the foreground the page has now, read again on a switch", async () => {
    render(<Themed />);
    act(() => gl.flushFrames());
    expect(gl.lastLabelColors()).toEqual([[1, 0, 0], ink(FOREGROUND.light)]);

    await setDark(true);
    expect(gl.lastLabelColors()).toEqual([[1, 0, 0], ink(FOREGROUND.dark)]);

    await setDark(false);
    expect(gl.lastLabelColors()).toEqual([[1, 0, 0], ink(FOREGROUND.light)]);
  });
});
