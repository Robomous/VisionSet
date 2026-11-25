import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@robomous/ui-core";
import { renderWithData } from "../testing/dataHarness";
import { stubResizeObserver } from "../testing/resizeObserver.js";
import { ScanStrip } from "./PointCloudStage";
import { NO_POLYLINE_CLASS_REASON, SOURCE_LOADING_REASON, useScanWorkspace, type ScanWorkspace } from "./scanWorkspace";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SOURCE = "44444444-4444-4444-8444-444444444444";
const ASSET = { id: "scan-1", modality: "point_cloud" as const, source_id: SOURCE };

const VEHICLE = { name: "vehicle", geometries: ["cuboid_3d"], color: "#38bdf8", attributes: [] };
const CURB = { name: "curb", geometries: ["polyline_3d"], color: "#a3e635", attributes: [] };

let holdSource: boolean;

beforeEach(() => {
  holdSource = false;
  stubResizeObserver();
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith(`/sources/${SOURCE}`)) {
      if (holdSource) return new Promise<Response>(() => {});
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

async function strip(classes: readonly unknown[]): Promise<() => ScanWorkspace> {
  let latest: ScanWorkspace | null = null;
  const schema = { project_id: PROJECT, version: 1, classes };
  const loaded: never[] = [];
  function Probe(): JSX.Element | null {
    latest = useScanWorkspace({ asset: ASSET, schema, loaded, readOnly: false });
    return latest === null ? null : <ScanStrip scan={latest} />;
  }
  renderWithData(
    <TooltipProvider>
      <Probe />
    </TooltipProvider>,
  );
  const current = (): ScanWorkspace => {
    if (latest === null) throw new Error("no workspace");
    return latest;
  };
  await waitFor(() => expect(current().editability.editable).toBe(true));
  act(() => current().setEditing(true));
  return current;
}

describe("the scan strip", () => {
  it("offers Draw a polyline in Edit, with its class and a hint once picked", async () => {
    const scan = await strip([VEHICLE, CURB]);
    const tool = screen.getByRole("radio", { name: "Draw a polyline" });
    expect(tool).toHaveProperty("disabled", false);
    act(() => scan().setToolKind("polyline"));
    expect(screen.getByTestId("scan-polyline-class").textContent).toContain("curb");
    expect(screen.queryByTestId("scan-cuboid-class")).toBeNull();
    expect(screen.getByTestId("scan-polyline-hint").textContent).toContain("Enter");

    act(() => scan().setToolKind("cuboid"));
    expect(screen.getByTestId("scan-cuboid-class").textContent).toContain("vehicle");
    expect(screen.queryByTestId("scan-polyline-class")).toBeNull();
    expect(screen.queryByTestId("scan-polyline-hint")).toBeNull();
  });

  it("withholds Edit with a reason while the source is read, rather than a bare disabled control", async () => {
    holdSource = true;
    const schema = { project_id: PROJECT, version: 1, classes: [VEHICLE] };
    const loaded: never[] = [];
    function Probe(): JSX.Element | null {
      const scan = useScanWorkspace({ asset: ASSET, schema, loaded, readOnly: false });
      return scan === null ? null : <ScanStrip scan={scan} />;
    }
    renderWithData(
      <TooltipProvider>
        <Probe />
      </TooltipProvider>,
    );
    const edit = await screen.findByTestId("scan-edit-toggle");
    expect(edit.hasAttribute("disabled")).toBe(false);
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    expect(edit.getAttribute("data-reason")).toBe(SOURCE_LOADING_REASON);
    await userEvent.click(edit);
    expect(edit.getAttribute("aria-pressed")).toBe("false");
  });

  it("disables Draw a polyline with the reason when no class accepts a 3D polyline", async () => {
    const scan = await strip([VEHICLE]);
    const tool = screen.getByTestId("scan-tool-polyline");
    expect(tool.getAttribute("aria-disabled")).toBe("true");
    expect(tool.closest("[data-reason]")?.getAttribute("data-reason")).toBe(NO_POLYLINE_CLASS_REASON);

    await userEvent.click(tool);
    expect(scan().toolKind).not.toBe("polyline");
  });

  it("keeps a withheld tool focusable with no wrapper inside the tool group, its reason read on focus", async () => {
    await strip([VEHICLE]);
    const select = screen.getByTestId("scan-tool-select");
    const tool = screen.getByTestId("scan-tool-polyline");
    expect(tool.parentElement).toBe(select.parentElement);
    tool.focus();
    expect(document.activeElement).toBe(tool);
    expect((await screen.findByRole("tooltip")).textContent).toBe(NO_POLYLINE_CLASS_REASON);
  });
});
