/**
 * The page's scan editor, driven with a real store and a real machine: only the
 * source fetch is stubbed, because whether a frame is declared is the one input
 * the editor takes from the server.
 */

import { isCuboidScanAnnotation, screenOf, selectOnly, type OrbitCamera } from "@visionset/annotator";
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithData } from "../testing/dataHarness";
import type { WireAnnotation } from "./jobQueries";
import {
  FRAME_UNDECLARED_REASON,
  NO_CUBOID_CLASS_REASON,
  READ_ONLY_REASON,
  useScanWorkspace,
  type ScanWorkspace,
  type ScanWorkspaceAsset,
} from "./scanWorkspace";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SOURCE = "44444444-4444-4444-8444-444444444444";

const SCHEMA = {
  project_id: PROJECT,
  version: 3,
  classes: [
    { name: "vehicle", geometries: ["bbox", "cuboid_3d"], color: "#38bdf8", attributes: [] },
    { name: "lane", geometries: ["polygon"], color: "#f97316", attributes: [] },
  ],
};

const FLAT_SCHEMA = { ...SCHEMA, classes: [SCHEMA.classes[1]] };

const SCAN: ScanWorkspaceAsset = { id: "scan-1", modality: "point_cloud", source_id: SOURCE };

const CAR: WireAnnotation = {
  id: "car",
  asset_id: "scan-1",
  label_class: "vehicle",
  schema_version: 3,
  geometry: { type: "cuboid_3d", center: [8, 0, 0], size: [4, 2, 1.6], yaw: 0.3 },
  attributes: {},
  provenance: "import",
  model_ref: null,
  confidence: null,
  job_id: null,
} as WireAnnotation;

const LOOKING_DOWN: OrbitCamera = { yaw: Math.PI, pitch: 1.2, distance: 30, target: [0, 0, 0] };
const VIEW = { camera: LOOKING_DOWN, viewport: { width: 800, height: 600 } };

let frame: string | null;

beforeEach(() => {
  frame = "lidar_flu";
  vi.stubGlobal("fetch", async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith(`/sources/${SOURCE}`)) {
      return Response.json({
        id: SOURCE,
        project_id: PROJECT,
        kind: "point_cloud_directory",
        name: "sweeps",
        registered_at: "2026-11-01T00:00:00Z",
        frame,
        video: null,
      });
    }
    return Response.json({ code: "NO_STUB", message: path }, { status: 500 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function workspace(
  options: { asset?: ScanWorkspaceAsset; schema?: unknown; loaded?: readonly WireAnnotation[]; readOnly?: boolean } = {},
): { current: () => ScanWorkspace | null } {
  let latest: ScanWorkspace | null = null;
  // Held once, as the query cache holds them: the store is rebuilt whenever they change.
  const asset = options.asset ?? SCAN;
  const schema = options.schema ?? SCHEMA;
  const loaded = options.loaded ?? [CAR];
  function Probe(): null {
    latest = useScanWorkspace({ asset, schema, loaded, readOnly: options.readOnly ?? false });
    return null;
  }
  renderWithData(<Probe />);
  return { current: () => latest };
}

function pixel(point: readonly [number, number, number]): readonly [number, number] {
  const at = screenOf(VIEW.camera, "lidar_flu", VIEW.viewport, point);
  if (at === null) throw new Error("behind the test camera");
  return at;
}

const NONE = { shift: false, ctrl: false, meta: false, alt: false };

describe("useScanWorkspace", () => {
  it("is absent for an image", () => {
    const probe = workspace({ asset: { id: "image-1", modality: "image", source_id: null } });
    expect(probe.current()).toBeNull();
  });

  it("holds the scan's cuboids and turns Edit on once the frame is known", async () => {
    const probe = workspace();
    expect(probe.current()?.snapshot.document.annotations.has("car")).toBe(true);
    await waitFor(() => expect(probe.current()?.editability.editable).toBe(true));
    expect(probe.current()?.editBlocked).toBeNull();
    expect(probe.current()?.cuboidClasses.map((one) => one.name)).toEqual(["vehicle"]);
    expect(probe.current()?.cuboidClass).toBe("vehicle");
    act(() => probe.current()?.setEditing(true));
    expect(probe.current()?.editing).toBe(true);
  });

  it("will not edit a scan whose source declares no frame, and says why", async () => {
    frame = null;
    const probe = workspace();
    await waitFor(() => expect(probe.current()?.editBlocked).toBe(FRAME_UNDECLARED_REASON));
    act(() => probe.current()?.setEditing(true));
    expect(probe.current()?.editing).toBe(false);
  });

  it("will not edit a read-only scan, and says why", async () => {
    const probe = workspace({ readOnly: true });
    await waitFor(() => expect(probe.current()?.editability.editable).toBe(true));
    expect(probe.current()?.editBlocked).toBe(READ_ONLY_REASON);
    act(() => probe.current()?.setEditing(true));
    expect(probe.current()?.editing).toBe(false);
  });

  it("offers no cuboid tool on a schema without a cuboid class", async () => {
    const probe = workspace({ schema: FLAT_SCHEMA, loaded: [] });
    await waitFor(() => expect(probe.current()?.editability.editable).toBe(true));
    expect(probe.current()?.drawBlocked).toBe(NO_CUBOID_CLASS_REASON);
    act(() => probe.current()?.setToolKind("cuboid"));
    expect(probe.current()?.toolKind).toBe("select");
  });

  it("plans a delete from the panel, and an undo takes it back out of the plan", async () => {
    const probe = workspace();
    await waitFor(() => expect(probe.current()?.editability.editable).toBe(true));
    act(() => probe.current()?.remove(["car"]));
    expect(probe.current()?.plan).toEqual({ created: [], updated: [], deleted: ["car"] });
    act(() => {
      probe.current()?.store.undo();
    });
    expect(probe.current()?.plan).toEqual({ created: [], updated: [], deleted: [] });
  });

  it("draws a cuboid from pointer events, and plans it as a human create", async () => {
    const probe = workspace({ loaded: [] });
    await waitFor(() => expect(probe.current()?.editability.editable).toBe(true));
    act(() => {
      probe.current()?.setEditing(true);
      probe.current()?.setToolKind("cuboid");
    });
    const editor = () => {
      const current = probe.current();
      if (current === null) throw new Error("no workspace");
      return current.editor;
    };
    act(() => editor().onScanPointer({ type: "pointer-down", point: pixel([-2, -1, 0]), button: "primary", modifiers: NONE }, VIEW));
    act(() => editor().onScanPointer({ type: "pointer-move", point: pixel([2, 1, 0]) }, VIEW));
    expect(probe.current()?.editor.draft?.size[0]).toBeCloseTo(4, 3);
    act(() => editor().onScanPointer({ type: "pointer-up", point: pixel([2, 1, 0]), button: "primary", modifiers: NONE }, VIEW));
    act(() => editor().send({ type: "commit" }));

    const plan = probe.current()?.plan;
    expect(plan?.created).toHaveLength(1);
    expect(plan?.created[0]).toMatchObject({ label_class: "vehicle", provenance: "human", asset_id: "scan-1" });
    expect(plan?.created.filter(isCuboidScanAnnotation)[0]?.geometry.size[1]).toBeCloseTo(2, 3);
    expect(probe.current()?.editor.draft).toBeNull();
    expect(probe.current()?.snapshot.selection.size).toBe(1);
  });

  it("plans a moved imported box as an update that keeps its provenance", async () => {
    const probe = workspace();
    await waitFor(() => expect(probe.current()?.editability.editable).toBe(true));
    act(() => probe.current()?.setEditing(true));
    const onBody = pixel([7.2, 0.4, 0.8]);
    const to: readonly [number, number] = [onBody[0] + 40, onBody[1]];
    act(() =>
      probe.current()?.editor.onScanPointer({ type: "pointer-down", point: onBody, button: "primary", modifiers: NONE }, VIEW),
    );
    act(() => probe.current()?.editor.onScanPointer({ type: "pointer-move", point: to }, VIEW));
    act(() =>
      probe.current()?.editor.onScanPointer({ type: "pointer-up", point: to, button: "primary", modifiers: NONE }, VIEW),
    );
    const [updated] = (probe.current()?.plan.updated ?? []).filter(isCuboidScanAnnotation);
    expect(updated).toMatchObject({ id: "car", provenance: "import", geometry: { yaw: 0.3 } });
    expect(updated?.geometry.center[1]).toBeLessThan(-1);
    expect(probe.current()?.snapshot.canUndo).toBe(true);
  });

  it("ends a drag when Edit turns off under it", async () => {
    const probe = workspace();
    await waitFor(() => expect(probe.current()?.editability.editable).toBe(true));
    act(() => {
      probe.current()?.setEditing(true);
      probe.current()?.store.select(selectOnly("car"));
    });
    const onBody = pixel([7.2, 0.4, 0.8]);
    act(() =>
      probe.current()?.editor.onScanPointer({ type: "pointer-down", point: onBody, button: "primary", modifiers: NONE }, VIEW),
    );
    act(() => probe.current()?.editor.onScanPointer({ type: "pointer-move", point: [onBody[0] + 40, onBody[1]] }, VIEW));
    expect(probe.current()?.editor.state.type).toBe("moving");
    expect(probe.current()?.snapshot.preview).not.toBeNull();

    act(() => probe.current()?.setEditing(false));
    expect(probe.current()?.editor.state.type).toBe("idle");
    expect(probe.current()?.snapshot.preview).toBeNull();
    expect(probe.current()?.plan.updated).toEqual([]);
  });
});
