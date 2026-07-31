/**
 * The draw list: what is drawn, in what order, in what colour — and the two
 * rules that make the committed layer able to sit still through a drag.
 */

import { describe, expect, it } from "vitest";

import { BOX_ID, POLY_ID, box, polygon, sceneDocument } from "../../core/interaction/_scene";
import { everyStateType, worldIn } from "../../core/interaction/_scene";
import { ASSET, SCHEMA, annotation } from "../../core/state/_sample";
import { createDocument } from "../../core/state/document";
import { EMPTY_SELECTION, selectionOf } from "../../core/state/selection";
import type { Annotation } from "../../core/types";
import {
  classColor,
  editedId,
  paintAnnotation,
  paintDocument,
  pendingPolygon,
  rubberBand,
  screenPx,
} from "./paint";

function tag(id: string): Annotation {
  return { ...annotation(id), geometry: { type: "classification_tag" } };
}

describe("a screen measurement is an asset measurement divided by the zoom", () => {
  it("is the identity at native scale", () => {
    expect(screenPx(2, 1)).toBe(2);
  });

  it("halves as the image is zoomed in, so the line stays 2 pixels on screen", () => {
    expect(screenPx(2, 2)).toBe(1);
  });

  it("grows as it is zoomed out", () => {
    // v1's bug, pointed at drawing instead of at hit-testing: a stroke asked for
    // as `2` and drawn without this is 2 *asset* pixels, which is a slab at 10%.
    expect(screenPx(2, 0.25)).toBe(8);
  });

  it("falls back to the screen value rather than throwing out of a render", () => {
    expect(screenPx(2, 0)).toBe(2);
    expect(screenPx(2, Number.NaN)).toBe(2);
  });
});

describe("a class draws in the schema's colour, or in one derived from its name", () => {
  it("uses the colour the kernel stored", () => {
    expect(classColor(SCHEMA.classes[0], "sign")).toBe("#ff0000");
  });

  it("derives one when the schema left it null", () => {
    expect(classColor(SCHEMA.classes[1], "lane")).toMatch(/^hsl\(\d+ 72% 58%\)$/);
  });

  it("derives one for a class the schema does not declare at all", () => {
    expect(classColor(undefined, "stranger")).toMatch(/^hsl\(/);
  });

  it("gives the same class the same colour every time, with no palette to thread", () => {
    expect(classColor(undefined, "lane")).toBe(classColor(undefined, "lane"));
  });

  it("gives different classes different colours", () => {
    expect(classColor(undefined, "lane")).not.toBe(classColor(undefined, "sign"));
  });

  it("treats an empty stored colour as no colour rather than as a colour", () => {
    expect(classColor({ ...SCHEMA.classes[0], color: "" }, "sign")).toMatch(/^hsl\(/);
  });
});

describe("the committed draw list", () => {
  it("keeps the document's own draw order, which is what a click resolves against", () => {
    const painted = paintDocument(sceneDocument(), EMPTY_SELECTION, null, null);
    expect(painted.map((shape) => shape.id)).toEqual([BOX_ID, POLY_ID]);
  });

  it("marks the selected shapes and nothing else", () => {
    const painted = paintDocument(sceneDocument(), selectionOf([POLY_ID]), null, null);
    expect(painted.map((shape) => shape.selected)).toEqual([false, true]);
  });

  it("marks exactly the hot one", () => {
    const painted = paintDocument(sceneDocument(), EMPTY_SELECTION, null, BOX_ID);
    expect(painted.map((shape) => shape.hot)).toEqual([true, false]);
  });

  it("omits what a drag is holding, so the shape is not drawn twice", () => {
    const painted = paintDocument(sceneDocument(), EMPTY_SELECTION, BOX_ID, null);
    expect(painted.map((shape) => shape.id)).toEqual([POLY_ID]);
  });

  it("omits classification tags, which have no coordinates to draw", () => {
    const document = createDocument(ASSET, SCHEMA, [box(), tag("t1"), polygon()]);
    const painted = paintDocument(document, EMPTY_SELECTION, null, null);
    expect(painted.map((shape) => shape.id)).toEqual([BOX_ID, POLY_ID]);
  });

  it("carries each shape's own class colour", () => {
    const painted = paintDocument(sceneDocument(), EMPTY_SELECTION, null, null);
    expect(painted[0].color).toBe("#ff0000");
    expect(painted[1].color).toMatch(/^hsl\(/);
  });

  it("is empty for an empty document rather than undefined", () => {
    const document = createDocument(ASSET, SCHEMA, []);
    expect(paintDocument(document, EMPTY_SELECTION, null, null)).toEqual([]);
  });
});

describe("one annotation, which is what the transient layer draws", () => {
  it("agrees with what the whole-document walk would have produced", () => {
    const document = sceneDocument();
    const one = paintAnnotation(document, selectionOf([BOX_ID]), BOX_ID, BOX_ID);
    const all = paintDocument(document, selectionOf([BOX_ID]), null, BOX_ID);
    expect(one).toEqual(all[0]);
  });

  it("answers null for an id the document no longer holds", () => {
    // An undo landing between a machine turn and the next paint. `null` rather
    // than a throw, for `runEffects.ts`'s reason one layer out.
    expect(paintAnnotation(sceneDocument(), EMPTY_SELECTION, "gone", null)).toBeNull();
  });

  it("answers null for a tag, which has nothing to draw", () => {
    const document = createDocument(ASSET, SCHEMA, [tag("t1")]);
    expect(paintAnnotation(document, EMPTY_SELECTION, "t1", null)).toBeNull();
  });
});

describe("what the preview is speaking for", () => {
  it("names the box being dragged, resized, and the polygon's vertex", () => {
    expect(editedId(worldIn("moving").state)).toBe(BOX_ID);
    expect(editedId(worldIn("resizing").state)).toBe(BOX_ID);
    expect(editedId(worldIn("moving-vertex").state)).toBe(POLY_ID);
  });

  it("names nothing in every state that is not a drag", () => {
    // Swept off the union rather than listed, so a state added without an answer
    // here shows up as a failure rather than as a shape drawn twice.
    const dragging: ReadonlySet<string> = new Set(["moving", "resizing", "moving-vertex"]);
    for (const type of everyStateType()) {
      if (dragging.has(type)) continue;
      expect(editedId(worldIn(type).state)).toBeNull();
    }
  });

  it("is the same value across a whole drag, which is what lets a memo bail out", () => {
    // A fresh `new Set([id])` per pointer-move would be a new prop every time and
    // would defeat the bail-out entirely; a string is the same string.
    const world = worldIn("moving");
    const first = editedId(world.state);
    world.dispatch({ type: "pointer-move", point: [160, 150] });
    world.dispatch({ type: "pointer-move", point: [180, 170] });
    expect(editedId(world.state)).toBe(first);
  });
});

describe("the rubber band", () => {
  it("is the normalized box while one is being dragged out", () => {
    const world = worldIn("drawing-bbox");
    expect(rubberBand(world.state)).toEqual({
      type: "bbox",
      x: 200,
      y: 200,
      width: 0,
      height: 0,
    });
  });

  it("normalizes a drag that went up and to the left", () => {
    const world = worldIn("drawing-bbox");
    world.dispatch({ type: "pointer-move", point: [150, 120] });
    expect(rubberBand(world.state)).toEqual({
      type: "bbox",
      x: 150,
      y: 120,
      width: 50,
      height: 80,
    });
  });

  it("is null in every other state", () => {
    for (const type of everyStateType()) {
      if (type === "drawing-bbox") continue;
      expect(rubberBand(worldIn(type).state)).toBeNull();
    }
  });
});

describe("the polygon under construction", () => {
  it("carries the vertices placed so far and the class they will land under", () => {
    const world = worldIn("drawing-polygon");
    // The cursor starts *on* the opening vertex rather than null: the machine
    // seeds it at the press, so the rubber band has somewhere to end before the
    // pointer has moved at all and a renderer needs no null branch on the first
    // frame of a session.
    expect(pendingPolygon(world.state)).toEqual({
      points: [[200, 200]],
      cursor: [200, 200],
      labelClass: "lane",
    });
  });

  it("carries the rubber-band endpoint once the pointer has moved", () => {
    const world = worldIn("drawing-polygon");
    world.dispatch({ type: "pointer-move", point: [260, 240] });
    expect(pendingPolygon(world.state)?.cursor).toEqual([260, 240]);
  });

  it("is null in every other state", () => {
    for (const type of everyStateType()) {
      if (type === "drawing-polygon") continue;
      expect(pendingPolygon(worldIn(type).state)).toBeNull();
    }
  });
});
