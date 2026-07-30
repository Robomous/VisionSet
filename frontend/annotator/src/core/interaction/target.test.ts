/**
 * The five ranks: which of handle, vertex, body, edge and empty a point resolves
 * to when more than one is available.
 *
 * The ordering is what this file is for, so most of it is overlaps built on
 * purpose. Two of them are v1 bugs that a naive port would bring across:
 *
 * - a **grip under a foreign body** — v1 resolved this through SVG z-order,
 *   because its grips were real `<circle>` elements painted last. A headless
 *   engine has no painter to ask.
 * - a **small unselected box inside a large selected polygon** — v1 rendered the
 *   selected annotation last, so it won every overlap, and the enclosed box was
 *   literally unclickable. That is what "bodies are not selected-first" prevents.
 *
 * The third decision, `edge` ranking below `body`, gets its own block: an edge
 * tolerance of 15 screen pixels is generous by design, and above `body` that
 * band would steal presses from every annotation inside a selected polygon.
 */

import { describe, expect, it } from "vitest";

import { assetTolerances } from "../geometry/tolerance";
import { createDocument } from "../state/document";
import { ASSET, SCHEMA, annotation } from "../state/_sample";
import { selectionOf } from "../state/selection";
import type { Selection } from "../state/selection";
import type { Annotation, Point } from "../types";
import { nearestInsertion, resolveTarget } from "./target";
import type { Scene } from "./target";

const TOLERANCES = assetTolerances(1);

function boxAt(id: string, x: number, y: number, width: number, height: number): Annotation {
  return { ...annotation(id), geometry: { type: "bbox", x, y, width, height } };
}

function polygonAt(id: string, points: readonly Point[]): Annotation {
  return { ...annotation(id), label_class: "lane", geometry: { type: "polygon", points } };
}

/** A scene from annotations in draw order, plus whichever ids are picked. */
function scene(annotations: readonly Annotation[], ...picked: readonly string[]): Scene {
  return {
    document: createDocument(ASSET, SCHEMA, annotations),
    selection: selectionOf(picked) as Selection,
    tolerances: TOLERANCES,
  };
}

const SQUARE: readonly Point[] = [
  [100, 100],
  [300, 100],
  [300, 300],
  [100, 300],
];

describe("nothing is under the pointer", () => {
  it("answers empty over bare canvas", () => {
    const at = scene([boxAt("a", 10, 10, 20, 20)]);
    expect(resolveTarget(at, [400, 400])).toEqual({ kind: "empty" });
  });

  it("never answers a grip on a shape that is not picked", () => {
    // The grips are only drawn for a selected annotation, so resolving one on an
    // unselected shape would hand back a control nobody can see.
    const at = scene([boxAt("a", 100, 100, 80, 60)]);
    expect(resolveTarget(at, [100, 100])).toEqual({ kind: "body", id: "a" });
  });

  it("is never a classification tag, which has no coordinates", () => {
    const tag: Annotation = {
      ...annotation("tag"),
      geometry: { type: "classification_tag" },
    };
    const at = scene([tag], "tag");
    expect(resolveTarget(at, [10, 10])).toEqual({ kind: "empty" });
  });
});

describe("a grip outranks every body", () => {
  it("wins under a shape painted on top of it", () => {
    // `cover` is later in draw order, so it is the topmost body at the grip.
    const at = scene([boxAt("a", 100, 100, 80, 60), boxAt("cover", 60, 60, 240, 240)], "a");
    expect(resolveTarget(at, [100, 100])).toEqual({
      kind: "handle",
      id: "a",
      handle: "nw",
      point: [100, 100],
    });
  });

  it("wins for a vertex too", () => {
    const at = scene([polygonAt("p", SQUARE), boxAt("cover", 60, 60, 300, 300)], "p");
    expect(resolveTarget(at, [100, 100])).toEqual({
      kind: "vertex",
      id: "p",
      index: 0,
      point: [100, 100],
    });
  });

  it("takes the topmost picked shape when two of them offer a grip", () => {
    const at = scene([boxAt("under", 100, 100, 80, 60), boxAt("over", 100, 100, 80, 60)], "under", "over");
    const hit = resolveTarget(at, [100, 100]);
    expect(hit.kind === "handle" && hit.id).toBe("over");
  });
});

describe("bodies are plain draw order, not selected-first", () => {
  it("reaches a small unselected box inside a large picked polygon", () => {
    // v1's exact hole: it painted the selection last, so this box could not be
    // clicked at all. Here the polygon is picked and the box is still on top.
    const at = scene([polygonAt("p", SQUARE), boxAt("inner", 180, 180, 20, 20)], "p");
    expect(resolveTarget(at, [190, 190])).toEqual({ kind: "body", id: "inner" });
  });

  it("still reaches the picked polygon where nothing covers it", () => {
    const at = scene([polygonAt("p", SQUARE), boxAt("inner", 180, 180, 20, 20)], "p");
    expect(resolveTarget(at, [130, 130])).toEqual({ kind: "body", id: "p" });
  });
});

describe("an edge is the last thing tried", () => {
  it("is reached just outside a picked polygon, where nothing else is", () => {
    const at = scene([polygonAt("p", SQUARE)], "p");
    const hit = resolveTarget(at, [200, 92]);
    expect(hit.kind).toBe("edge");
    expect(hit.kind === "edge" && hit.index).toBe(0);
    expect(hit.kind === "edge" && hit.point).toEqual([200, 100]);
  });

  it("yields to a body inside the band, which is why it ranks below one", () => {
    // 15 screen pixels of edge tolerance around a selected polygon would
    // otherwise steal every press from its neighbours.
    const at = scene([polygonAt("p", SQUARE), boxAt("neighbour", 190, 86, 20, 8)], "p");
    expect(resolveTarget(at, [200, 92])).toEqual({ kind: "body", id: "neighbour" });
  });

  it("is not offered for a polygon nobody picked", () => {
    const at = scene([polygonAt("p", SQUARE)]);
    expect(resolveTarget(at, [200, 92])).toEqual({ kind: "empty" });
  });
});

describe("where a double-click would put a vertex", () => {
  it("projects onto the nearest edge of the topmost polygon", () => {
    const at = scene([polygonAt("p", SQUARE)]);
    expect(nearestInsertion(at, [200, 104])).toEqual({ id: "p", index: 0, point: [200, 100] });
  });

  it("refuses when the click is on an existing vertex, which is v1's rule", () => {
    const at = scene([polygonAt("p", SQUARE)]);
    expect(nearestInsertion(at, [102, 102])).toBeNull();
  });

  it("refuses when no edge is near enough", () => {
    const at = scene([polygonAt("p", SQUARE)]);
    expect(nearestInsertion(at, [200, 200])).toBeNull();
  });

  it("does not need the polygon picked first, because a double-click is unambiguous", () => {
    const at = scene([polygonAt("p", SQUARE)]);
    expect(nearestInsertion(at, [200, 104])).not.toBeNull();
  });

  it("names the closing edge as the last one, the index hitTest already uses", () => {
    const at = scene([polygonAt("p", SQUARE)]);
    expect(nearestInsertion(at, [96, 200])).toEqual({ id: "p", index: 3, point: [100, 200] });
  });
});
