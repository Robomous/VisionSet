/**
 * The scan stage when its source request fails, and the `?` key from the view.
 * jsdom has no WebGL2, so the view is a stand-in carrying the same
 * `data-scan-view` host and focusable canvas; the workspace and the stage's key
 * handling are real.
 */

import type { AnnotationSchema } from "@visionset/annotator";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@robomous/ui-core";
import { renderWithData } from "../testing/dataHarness";
import { stubResizeObserver } from "../testing/resizeObserver.js";
import { PointCloudStage, type PointCloudStageProps } from "./PointCloudStage";
import { SOURCE_FAILED_REASON, useScanWorkspace } from "./scanWorkspace";

vi.mock("@visionset/annotator/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@visionset/annotator/react")>();
  return {
    ...actual,
    PointCloudCanvas: (props: { pinned?: boolean }): JSX.Element => (
      <div data-scan-view={props.pinned === true ? "top-down" : "perspective"}>
        <canvas tabIndex={0} data-testid={props.pinned === true ? "top-gl" : "perspective-gl"} />
      </div>
    ),
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

function pointBuffer(count: number): ArrayBuffer {
  const out = new ArrayBuffer(16 + count * 12);
  const view = new DataView(out);
  for (let i = 0; i < 4; i += 1) view.setUint8(i, "VSPC".charCodeAt(i));
  view.setUint32(4, 1, true);
  view.setUint32(8, count, true);
  return out;
}

let sourceFails: boolean;

beforeEach(() => {
  sourceFails = false;
  stubResizeObserver();
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/points")) return new Response(pointBuffer(3), { status: 200 });
    if (path.endsWith(`/sources/${SOURCE}`)) {
      if (sourceFails) return Response.json({ code: "UNAUTHORIZED", message: "Sign in again." }, { status: 401 });
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

function mount(onToggleHelp?: () => void): void {
  function Page(): JSX.Element {
    const scan = useScanWorkspace({
      asset: { id: ASSET.id, modality: "point_cloud", source_id: SOURCE },
      schema: SCHEMA,
      loaded: NOTHING_LOADED,
      readOnly: false,
    });
    return (
      <PointCloudStage
        projectId={PROJECT}
        asset={ASSET}
        loaded={NOTHING_LOADED}
        schema={SCHEMA as AnnotationSchema}
        scan={scan}
        {...(onToggleHelp === undefined ? {} : { onToggleHelp })}
      />
    );
  }
  renderWithData(
    <TooltipProvider>
      <Page />
    </TooltipProvider>,
  );
}

describe("a scan whose source cannot be read", () => {
  it("says the request failed, with the refusal and a retry, and never that the source declares no frame", async () => {
    sourceFails = true;
    mount();
    const failure = await screen.findByTestId("scan-source-error");
    expect(failure.textContent).toContain("could not be read");
    expect(failure.textContent).toContain("Sign in again.");
    expect(screen.getByTestId("point-cloud-summary").textContent).toContain("frame unknown");
    expect(screen.getByTestId("point-cloud-summary").textContent).not.toContain("no declared frame");
    const edit = screen.getByTestId("scan-edit-toggle");
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    expect(edit.getAttribute("data-reason")).toBe(SOURCE_FAILED_REASON);

    sourceFails = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByTestId("scan-source-error")).toBeNull());
    expect(screen.getByTestId("point-cloud-summary").textContent).toContain("lidar_flu");
    await waitFor(() => expect(screen.getByTestId("scan-edit-toggle").hasAttribute("aria-disabled")).toBe(false));
  });
});

describe("the scan view's keys", () => {
  it("toggles the shortcut list on ?, and on no other key", async () => {
    const onToggleHelp = vi.fn();
    mount(onToggleHelp);
    const canvas = await screen.findByTestId("perspective-gl");
    fireEvent.keyDown(canvas, { key: "?", shiftKey: true });
    expect(onToggleHelp).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(canvas, { key: "x" });
    expect(onToggleHelp).toHaveBeenCalledTimes(1);
  });
});
