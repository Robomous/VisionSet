/**
 * The save plan — the one piece of the annotation page that is pure and therefore
 * worth pinning away from a browser.
 *
 * Everything else on the annotation page is composition over screens that already
 * have their own tests; this is the part that decides what actually travels, and
 * getting it wrong is silent: an over-eager plan writes history entries nobody
 * asked for, and an under-eager one loses work.
 */

import {
  AnnotatorStore,
  addAnnotationCommand,
  documentFromWire,
  replaceScanAnnotation,
  scanDocumentFromWire,
  type ScanDocument,
} from "@visionset/annotator";
import { describe, expect, it } from "vitest";

import {
  assetParamFor,
  assetPositionOf,
  isEmptyPlan,
  mergePlans,
  planSave,
  planScanSave,
  type WireAnnotation,
} from "./jobQueries";

const SCHEMA = {
  project_id: "11111111-1111-4111-8111-111111111111",
  version: 2,
  classes: [
    { name: "vehicle", geometries: ["bbox"], color: null, attributes: [] },
    { name: "pedestrian", geometries: ["bbox"], color: null, attributes: [] },
  ],
};

function loaded(id: string, labelClass = "vehicle"): WireAnnotation {
  return {
    id,
    asset_id: "asset-1",
    label_class: labelClass,
    schema_version: 2,
    geometry: { type: "bbox", x: 10, y: 10, width: 20, height: 20 },
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: null,
  };
}

function storeOf(annotations: readonly WireAnnotation[]): AnnotatorStore {
  return new AnnotatorStore(
    documentFromWire({
      asset: { id: "asset-1", width: 100, height: 100 },
      schema: SCHEMA,
      annotations,
    }),
  );
}

describe("planSave", () => {
  it("plans nothing for a document nobody touched", () => {
    const server = [loaded("a"), loaded("b")];
    const plan = planSave(storeOf(server).document, server);
    // The claim that matters: a round trip through `documentFromWire` and back out
    // through `toAnnotationUpdate` is the identity. If it were not, opening an
    // asset and closing it would look like an edit.
    expect(isEmptyPlan(plan)).toBe(true);
  });

  it("plans a create for an annotation the server has never seen", () => {
    const server = [loaded("a")];
    const store = storeOf(server);
    store.execute(
      addAnnotationCommand({
        id: "local-1",
        asset_id: "asset-1",
        label_class: "vehicle",
        schema_version: 2,
        geometry: { type: "bbox", x: 1, y: 1, width: 5, height: 5 },
        attributes: {},
        provenance: "human",
        model_ref: null,
        confidence: null,
        job_id: null,
      }),
    );

    const plan = planSave(store.document, server);
    expect(plan.created.map((one) => one.id)).toEqual(["local-1"]);
    expect(plan.updated).toEqual([]);
    expect(plan.deleted).toEqual([]);
  });

  it("never plans a write for a 3D label, which loads and is carried past the scene", () => {
    const lane3d: WireAnnotation = {
      ...loaded("3d"),
      geometry: { type: "polyline_3d", points: [[-1.5, 1.2, 8], [-1.4, 1.2, 20]], visibility: [2, 1] },
    };
    const car3d: WireAnnotation = {
      ...loaded("cuboid"),
      geometry: { type: "cuboid_3d", center: [-2.5, 0.75, 12], size: [4.5, 1.9, 1.6], yaw: 1.2 },
    };
    const server = [loaded("a"), lane3d, car3d];
    const store = storeOf(server);
    expect(store.document.annotations.has("3d")).toBe(false);
    expect(store.document.annotations.has("cuboid")).toBe(false);
    expect(isEmptyPlan(planSave(store.document, server))).toBe(true);

    store.execute({ label: "drop", apply: (d) => ({ ...d, annotations: new Map() }) });
    const plan = planSave(store.document, server);
    expect(plan.deleted).toEqual(["a"]);
    expect(plan.updated).toEqual([]);
  });

  it("plans a delete for one the server has and the document does not", () => {
    const server = [loaded("a"), loaded("b")];
    const store = storeOf(server);
    store.execute({ label: "drop", apply: (d) => ({ ...d, annotations: new Map([["a", d.annotations.get("a")!]]) }) });

    const plan = planSave(store.document, server);
    expect(plan.deleted).toEqual(["b"]);
    expect(plan.created).toEqual([]);
  });

  it("plans an update only when what travels actually changed", () => {
    const server = [loaded("a")];
    const store = storeOf(server);
    const original = store.document.annotations.get("a")!;

    // A no-op replace: same values, new object. Re-sending it would be a write the
    // kernel accepts and a history entry nobody asked for.
    store.execute({
      label: "touch",
      apply: (d) => ({ ...d, annotations: new Map([["a", { ...original }]]) }),
    });
    expect(isEmptyPlan(planSave(store.document, server))).toBe(true);

    store.execute({
      label: "reclass",
      apply: (d) => ({
        ...d,
        annotations: new Map([["a", { ...original, label_class: "pedestrian" }]]),
      }),
    });
    const plan = planSave(store.document, server);
    expect(plan.updated.map((one) => one.id)).toEqual(["a"]);
  });

  it("plans all three at once, because a session is not one kind of edit", () => {
    const server = [loaded("a"), loaded("b")];
    const store = storeOf(server);
    const kept = store.document.annotations.get("a")!;
    store.execute({
      label: "session",
      apply: (d) => ({
        ...d,
        annotations: new Map([
          ["a", { ...kept, label_class: "pedestrian" }],
          [
            "local-1",
            {
              ...kept,
              id: "local-1",
              geometry: { type: "bbox", x: 50, y: 50, width: 5, height: 5 } as const,
            },
          ],
        ]),
      }),
    });

    const plan = planSave(store.document, server);
    expect(plan.updated.map((one) => one.id)).toEqual(["a"]);
    expect(plan.created.map((one) => one.id)).toEqual(["local-1"]);
    expect(plan.deleted).toEqual(["b"]);
  });
});

function loadedCuboid(id: string, geometry: Record<string, unknown> = {}): WireAnnotation {
  return {
    ...loaded(id, "car"),
    asset_id: "scan-1",
    geometry: { type: "cuboid_3d", center: [10, 0, 0.8], size: [4.2, 1.8, 1.5], yaw: 0.25, ...geometry },
    provenance: "import",
  };
}

const SCAN_SCHEMA = {
  ...SCHEMA,
  classes: [
    { name: "car", geometries: ["cuboid_3d"], color: null, attributes: [] },
    { name: "weather", geometries: ["classification_tag"], color: null, attributes: [] },
  ],
};

function scanStoreOf(annotations: readonly WireAnnotation[]): AnnotatorStore<ScanDocument> {
  return new AnnotatorStore<ScanDocument>(
    scanDocumentFromWire({
      asset: { id: "scan-1", width: null, height: null, modality: "point_cloud" },
      schema: SCAN_SCHEMA,
      annotations,
    }),
  );
}

describe("planScanSave", () => {
  const path: WireAnnotation = {
    ...loadedCuboid("path"),
    geometry: { type: "polyline_3d", points: [[0, 0, 0], [1, 1, 1]] },
  };
  const tag: WireAnnotation = { ...loaded("tag", "weather"), asset_id: "scan-1", geometry: { type: "classification_tag" } };

  it("plans nothing for a scan nobody touched, and never deletes what it carries past", () => {
    const server = [loadedCuboid("a"), path, tag, loadedCuboid("b", { yaw: -Math.PI })];
    expect(isEmptyPlan(planScanSave(scanStoreOf(server).document, server))).toBe(true);
  });

  it("an edited import is an update that keeps its provenance", () => {
    const server = [loadedCuboid("a")];
    const store = scanStoreOf(server);
    const box = store.document.annotations.get("a")!;
    store.execute({
      label: "move car",
      apply: (d) => replaceScanAnnotation(d, { ...box, geometry: { ...box.geometry, center: [11, 0, 0.8] } }),
    });
    const plan = planScanSave(store.document, server);
    expect(plan.created).toEqual([]);
    expect(plan.deleted).toEqual([]);
    expect(plan.updated.map((one) => [one.id, one.provenance, one.geometry.center])).toEqual([
      ["a", "import", [11, 0, 0.8]],
    ]);
  });

  it("wraps a yaw outside [-π, π] before it compares or sends", () => {
    const server = [loadedCuboid("a", { yaw: 3 })];
    const store = scanStoreOf(server);
    const box = store.document.annotations.get("a")!;
    store.execute({
      label: "turn",
      apply: (d) => replaceScanAnnotation(d, { ...box, geometry: { ...box.geometry, yaw: 3 + 2 * Math.PI } }),
    });
    expect(isEmptyPlan(planScanSave(store.document, server))).toBe(true);

    store.execute({
      label: "turn more",
      apply: (d) => replaceScanAnnotation(d, { ...box, geometry: { ...box.geometry, yaw: 3.5 } }),
    });
    const [sent] = planScanSave(store.document, server).updated;
    expect(sent.geometry.yaw).toBeCloseTo(3.5 - 2 * Math.PI, 12);
  });

  it("a drawn box is a create and a removed one a delete", () => {
    const server = [loadedCuboid("a"), loadedCuboid("b")];
    const store = scanStoreOf(server);
    const kept = store.document.annotations.get("a")!;
    store.execute({
      label: "session",
      apply: (d) => ({
        ...d,
        annotations: new Map([
          ["a", kept],
          ["local-1", { ...kept, id: "local-1", provenance: "human" as const }],
        ]),
      }),
    });
    const plan = planScanSave(store.document, server);
    expect(plan.created.map((one) => one.id)).toEqual(["local-1"]);
    expect(plan.deleted).toEqual(["b"]);
    expect(plan.updated).toEqual([]);
  });

  it("is disjoint from the image plan over the same scan, so a page may send both", () => {
    const server = [loadedCuboid("a"), tag, path];
    const scanPlan = planScanSave(scanStoreOf([]).document, server);
    const imagePlan = planSave(
      documentFromWire({ asset: { id: "scan-1", width: null, height: null, modality: "point_cloud" }, schema: SCAN_SCHEMA, annotations: [] }),
      server,
    );
    expect(scanPlan.deleted).toEqual(["a"]);
    expect(imagePlan.deleted).toEqual(["tag"]);

    const merged = mergePlans(imagePlan, scanPlan);
    expect(merged.deleted).toEqual(["tag", "a"]);
    expect(isEmptyPlan(merged)).toBe(false);
    expect(isEmptyPlan(mergePlans(imagePlan, { created: [], updated: [], deleted: [] }))).toBe(false);
    expect(isEmptyPlan(mergePlans({ created: [], updated: [], deleted: [] }, scanPlan))).toBe(false);
  });
});

/**
 * Where the annotator opens, given the asset a gallery tile handed it.
 *
 * The "on that asset" half. Pure, so it is pinned here; that the tile *reaches*
 * the annotator at all is a browser claim and lives in `cycle/cycle.spec.ts`,
 * because jsdom reports every element as 0×0 and the gallery's virtualizer
 * therefore renders no tiles to click.
 */
describe("assetPositionOf", () => {
  const ASSETS = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("opens on the asset that was asked for", () => {
    expect(assetPositionOf(ASSETS, "c")).toBe(2);
  });

  it("opens on the first asset when nobody asked for one", () => {
    // A deep link, or a reload: what the page always did, and still does.
    expect(assetPositionOf(ASSETS, undefined)).toBe(0);
  });

  it("opens on the first asset when the one asked for is not in this job", () => {
    // A stale link — the asset moved to another job, or the batch was
    // re-partitioned. "Here is the job, from the start" beats an error page about
    // a query parameter.
    expect(assetPositionOf(ASSETS, "gone")).toBe(0);
  });

  it("answers zero while the assets are still loading", () => {
    // The position has to be readable before the answer exists, because it is
    // derived on every render rather than seeded once by an effect, which is the
    // shape that misses its one chance to run.
    expect(assetPositionOf(undefined, "c")).toBe(0);
  });
});

/**
 * `assetPositionOf`'s inverse: keeping the address bar naming the frame on screen.
 *
 * The wiring either side of it is a browser claim — that pressing next rewrites
 * the address, and that the address survives a reload — so it lives in
 * `frontend/app/e2e/annotate.spec.ts` against the real router. What is decidable
 * without one is *when* to write, and that is here.
 */
describe("assetParamFor", () => {
  it("names the frame on screen when the URL names another one", () => {
    // The defect itself: one press of next, and `?asset=` still named the frame
    // the annotator was entered on.
    expect(assetParamFor("b", "a")).toBe("b");
  });

  it("names the frame on screen when the URL names no asset at all", () => {
    // `/jobs/{id}` with no parameter is a legitimate way in, and the frame it
    // lands on is worth being able to send to somebody.
    expect(assetParamFor("a", null)).toBe("a");
  });

  it("names the frame on screen when the URL names one this job does not carry", () => {
    // A stale link falls back to the first asset (`assetPositionOf`). Until this,
    // it fell back invisibly — the address kept naming an asset nobody could see.
    expect(assetParamFor("a", "gone")).toBe("a");
  });

  it("leaves the URL alone when it already names the frame on screen", () => {
    // Load-bearing, not an optimisation. The page reports on arrival as well as on
    // a change, so without this every entry through a correct link would write to
    // history — and `replace` would write over whatever the annotator was opened
    // from, which is the one place Back has somewhere useful to go.
    expect(assetParamFor("a", "a")).toBeNull();
  });
});
