/**
 * Where keyboard focus lands in the scan editor. jsdom has no WebGL2, so the
 * view is a stand-in carrying the same `data-scan-view` host and focusable
 * canvas; the store, the machine and the stage's key handling are real.
 */

import { screenOf, type AnnotationSchema, type OrbitCamera } from "@visionset/annotator";
import type { ScanPointerEvent, ScanView } from "@visionset/annotator/react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@robomous/ui-core";
import { renderWithData } from "../testing/dataHarness";
import { PointCloudStage, type PointCloudStageProps } from "./PointCloudStage";
import { useScanWorkspace, type ScanWorkspace } from "./scanWorkspace";

type Pointer = (event: ScanPointerEvent, view: ScanView) => void;
const pointers: { perspective?: Pointer } = {};

vi.mock("@visionset/annotator/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@visionset/annotator/react")>();
  return {
    ...actual,
    PointCloudCanvas: (props: { pinned?: boolean; onScanPointer?: Pointer }): JSX.Element => {
      if (props.pinned !== true && props.onScanPointer !== undefined) pointers.perspective = props.onScanPointer;
      return (
        <div data-scan-view={props.pinned === true ? "top-down" : "perspective"}>
          <canvas tabIndex={0} data-testid={props.pinned === true ? "top-gl" : "perspective-gl"} />
        </div>
      );
    },
  };
});

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SOURCE = "44444444-4444-4444-8444-444444444444";

const SCHEMA = {
  project_id: PROJECT,
  version: 3,
  classes: [{ name: "vehicle", geometries: ["cuboid_3d"], color: "#38bdf8", attributes: [] }],
  description: null,
  created_at: null,
  provenance: null,
};

const ASSET: PointCloudStageProps["asset"] = {
  id: "scan-1",
  source_id: SOURCE,
  thumbnail_hash: null,
  point_cloud: null,
};

const NOTHING_LOADED: readonly never[] = [];

const LOOKING_DOWN: OrbitCamera = { yaw: Math.PI, pitch: 1.2, distance: 30, target: [0, 0, 0] };
const VIEW: ScanView = { camera: LOOKING_DOWN, viewport: { width: 800, height: 600 }, kind: "perspective" };
const NONE = { shift: false, ctrl: false, meta: false, alt: false };

function pixel(point: readonly [number, number, number]): readonly [number, number] {
  const at = screenOf(VIEW.camera, "lidar_flu", VIEW.viewport, point);
  if (at === null) throw new Error("behind the test camera");
  return at;
}

function pointBuffer(count: number): ArrayBuffer {
  const out = new ArrayBuffer(16 + count * 12);
  const view = new DataView(out);
  for (let i = 0; i < 4; i += 1) view.setUint8(i, "VSPC".charCodeAt(i));
  view.setUint32(4, 1, true);
  view.setUint32(8, count, true);
  return out;
}

beforeEach(() => {
  delete pointers.perspective;
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/points")) return new Response(pointBuffer(3), { status: 200 });
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
  vi.unstubAllGlobals();
});

async function editingCuboids(): Promise<() => ScanWorkspace> {
  let latest: ScanWorkspace | null = null;
  function Page(): JSX.Element {
    const scan = useScanWorkspace({
      asset: { id: ASSET.id, modality: "point_cloud", source_id: SOURCE },
      schema: SCHEMA,
      loaded: NOTHING_LOADED,
      readOnly: false,
    });
    latest = scan;
    return (
      <PointCloudStage projectId={PROJECT} asset={ASSET} loaded={NOTHING_LOADED} schema={SCHEMA as AnnotationSchema} scan={scan} />
    );
  }
  renderWithData(
    <TooltipProvider>
      <Page />
    </TooltipProvider>,
  );
  const toggle = await screen.findByTestId("scan-edit-toggle");
  await waitFor(() => expect(toggle.hasAttribute("aria-disabled")).toBe(false));
  await userEvent.click(toggle);
  await userEvent.click(await screen.findByTestId("scan-tool-cuboid"));
  await screen.findByTestId("scan-cuboid-class");
  return () => {
    if (latest === null) throw new Error("no workspace");
    return latest;
  };
}

function footprint(): void {
  const tell = pointers.perspective;
  if (tell === undefined) throw new Error("the perspective view takes no pointer");
  act(() => tell({ type: "pointer-down", point: pixel([-2, -1, 0]), button: "primary", modifiers: NONE }, VIEW));
  act(() => tell({ type: "pointer-move", point: pixel([2, -1, 0]) }, VIEW));
  act(() => tell({ type: "pointer-up", point: pixel([2, -1, 0]), button: "primary", modifiers: NONE }, VIEW));
  act(() => tell({ type: "pointer-move", point: pixel([2, 1, 0]) }, VIEW));
}

describe("keyboard focus in the scan editor", () => {
  it("moves to the perspective view once a footprint is drawn from the class dropdown, and Enter sets the width then finishes the height", async () => {
    const scan = await editingCuboids();
    screen.getByTestId("scan-cuboid-class").focus();

    footprint();
    expect(scan().editor.state.type).toBe("drawing-width");
    expect(document.activeElement).toBe(screen.getByTestId("perspective-gl"));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Enter" });
    expect(scan().editor.state.type).toBe("drawing-height");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Enter" });
    expect(scan().snapshot.document.annotations.size).toBe(1);
    expect(scan().editor.state.type).toBe("idle");
  });

  it("leaves focus on the top-down view when the footprint was drawn there", async () => {
    const scan = await editingCuboids();
    const top = screen.getByTestId("top-gl");
    top.focus();

    footprint();
    expect(scan().editor.state.type).toBe("drawing-width");
    expect(document.activeElement).toBe(top);
  });

  it("commits nothing on Enter in the class dropdown before any footprint", async () => {
    const scan = await editingCuboids();
    const dropdown = screen.getByTestId("scan-cuboid-class");
    dropdown.focus();

    fireEvent.keyDown(dropdown, { key: "Enter" });
    expect(scan().snapshot.document.annotations.size).toBe(0);
    expect(scan().editor.state.type).toBe("idle");
  });

  it("says how the width and height steps finish while each is open", async () => {
    await editingCuboids();
    expect(screen.queryByTestId("scan-width-hint")).toBeNull();
    expect(screen.queryByTestId("scan-height-hint")).toBeNull();
    footprint();
    expect(screen.getByTestId("scan-width-hint").textContent).toBe("Move the pointer to set the width. Enter or a click sets it.");
    expect(screen.queryByTestId("scan-height-hint")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("perspective-gl"), { key: "Enter" });
    expect(screen.queryByTestId("scan-width-hint")).toBeNull();
    expect(screen.getByTestId("scan-height-hint").textContent).toBe(
      "Move the pointer in the perspective view to set the height. Enter or a click in either view finishes it.",
    );
  });
});
