/**
 * The class-palette rule, asserted from the *consumer's* side.
 *
 * `classColor` is unit-tested where it is implemented (`paint.test.ts` in the
 * annotator). What is tested here is the thing #128's acceptance criterion is
 * actually about: that ui-core reaches **the same function the canvas draws
 * with**, so a side-panel swatch (#126) and a gallery badge (#55) cannot disagree
 * with the shape beside them.
 *
 * A test asserting the hash's *output* here would not prove that — two identical
 * implementations produce identical output and are still two implementations. So
 * the first assertion compares the imported reference against the annotator's own
 * export, which is the only thing that can catch a well-meaning re-port.
 */

import { classColor as fromEngine } from "@visionset/annotator";
import { describe, expect, it } from "vitest";

import { CLASS_FILL_OPACITY, classColor, type LabelClass } from "./palette";

const withColour: LabelClass = {
  name: "vehicle",
  geometry: "bbox",
  color: "#38bdf8",
  attributes: [],
};

const without: LabelClass = {
  name: "pedestrian",
  geometry: "bbox",
  color: null,
  attributes: [],
};

describe("the class palette", () => {
  it("is the annotator's own function, not a port of it", () => {
    // The whole point of the module. v1's `getClassPalette` was a different
    // formula; porting it would have produced swatches that disagree with the
    // shapes, which is exactly what "one spelling" is meant to prevent.
    expect(classColor).toBe(fromEngine);
  });

  it("prefers the schema's colour, which is the kernel's stated precedence", () => {
    expect(classColor(withColour, withColour.name)).toBe("#38bdf8");
  });

  it("derives a stable hue when the schema declares none", () => {
    const first = classColor(without, without.name);
    expect(first).toMatch(/^hsl\(/);
    expect(classColor(without, without.name)).toBe(first);
    // Stable per *class*, not per call: a different name is a different hue.
    expect(classColor({ ...without, name: "cyclist" }, "cyclist")).not.toBe(first);
  });

  it("answers for a class the schema does not declare at all", () => {
    // `SCHEMA_CHANGE_WOULD_ORPHAN`'s case, one layer out: an annotation may name a
    // class a later version removed, and a panel still has to draw a row for it.
    expect(classColor(undefined, "removed-class")).toMatch(/^hsl\(/);
  });

  it("names the fill opacity rather than baking alpha into the colour", () => {
    // The kernel accepts any CSS spelling, so `#ff0000` and `rgb(255 0 0)` are both
    // legal in `LabelClass.color` and neither can be given an alpha without being
    // parsed. The opacity is applied by whatever draws the shape.
    expect(CLASS_FILL_OPACITY).toBeGreaterThan(0);
    expect(CLASS_FILL_OPACITY).toBeLessThan(1);
  });
});
