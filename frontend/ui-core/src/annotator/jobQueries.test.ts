/**
 * The save plan — the one piece of #56 that is pure and therefore worth pinning
 * away from a browser.
 *
 * Everything else on the annotation page is composition over screens that already
 * have their own tests; this is the part that decides what actually travels, and
 * getting it wrong is silent: an over-eager plan writes history entries nobody
 * asked for, and an under-eager one loses work.
 */

import { AnnotatorStore, addAnnotationCommand, documentFromWire } from "@visionset/annotator";
import { describe, expect, it } from "vitest";

import { isEmptyPlan, planSave, type WireAnnotation } from "./jobQueries";

const SCHEMA = {
  project_id: "11111111-1111-4111-8111-111111111111",
  version: 2,
  classes: [
    { name: "vehicle", geometry: "bbox", color: null, attributes: [] },
    { name: "pedestrian", geometry: "bbox", color: null, attributes: [] },
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
      }),
    );

    const plan = planSave(store.document, server);
    expect(plan.created.map((one) => one.id)).toEqual(["local-1"]);
    expect(plan.updated).toEqual([]);
    expect(plan.deleted).toEqual([]);
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
