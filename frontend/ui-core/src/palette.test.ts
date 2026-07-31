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

import { CLASS_FILL_OPACITY, classColor, hexColor, type LabelClass } from "./palette";

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

/**
 * `hexColor` — the notation change that lets a colour input show the truth.
 *
 * #162: `<input type="color">` accepts only `#rrggbb`, `classColor`'s derived
 * branch answers `hsl(h 72% 58%)`, and the editor's old fallback turned every
 * derived class grey — beside a dot showing the real colour, and against an
 * annotator drawing that same real colour.
 *
 * The *rule* stays `classColor`'s: nothing here respells the hash, and the last
 * case states the property that actually matters rather than a table of hexes.
 */
describe("hexColor", () => {
  it("passes a six-digit hex through, lowercased", () => {
    expect(hexColor("#38BDF8")).toBe("#38bdf8");
    expect(hexColor("  #38bdf8  ")).toBe("#38bdf8");
  });

  it("expands the three-digit form the input does not take", () => {
    expect(hexColor("#f00")).toBe("#ff0000");
    expect(hexColor("#0AB")).toBe("#00aabb");
  });

  it("accepts both spellings of hsl", () => {
    // `classColor` emits the space-separated form; a schema stored by something
    // older may use commas, and the difference is one character in the pattern.
    expect(hexColor("hsl(0 72% 58%)")).toBe(hexColor("hsl(0, 72%, 58%)"));
    expect(hexColor("hsl(210 0% 0%)")).toBe("#000000");
    expect(hexColor("hsl(210 100% 100%)")).toBe("#ffffff");
  });

  it("covers every hue sector, because a wrong one is off by a whole primary", () => {
    // Six sectors, six answers. A conversion that swapped two of them would look
    // plausible for most classes and be wrong for a sixth of them.
    const at = (hue: number): string | null => hexColor(`hsl(${hue} 100% 50%)`);
    expect([at(0), at(60), at(120), at(180), at(240), at(300)]).toEqual([
      "#ff0000",
      "#ffff00",
      "#00ff00",
      "#00ffff",
      "#0000ff",
      "#ff00ff",
    ]);
    // And it wraps rather than running off the end of the table.
    expect(at(360)).toBe(at(0));
  });

  it("gives up on any other CSS spelling rather than guessing", () => {
    // The kernel accepts any CSS colour in `LabelClass.color`, so a schema
    // authored elsewhere may legitimately hold these. `null` lets the caller show
    // its own neutral; a guess would be a CSS parser shipped to fill one input.
    expect(hexColor("rgb(255 0 0)")).toBeNull();
    expect(hexColor("rebeccapurple")).toBeNull();
    expect(hexColor("")).toBeNull();
    expect(hexColor("#12345")).toBeNull();
    expect(hexColor("hsl(210 72%)")).toBeNull();
  });

  it("converts everything the derived branch can produce", () => {
    // The property, stated once: whatever `classColor` derives for a class with no
    // declared colour is convertible. The moment that stops holding, the editor
    // goes grey again — which is #162.
    for (const name of ["lane", "vehicle", "pedestrian", "weather", "", "ünïcodé", "a".repeat(64)]) {
      const derived = classColor({ name, geometry: "bbox", color: null, attributes: [] }, name);
      expect(derived).toMatch(/^hsl\(/);
      expect(hexColor(derived)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("leaves a declared colour alone, because the schema's answer wins", () => {
    expect(hexColor(classColor(withColour, withColour.name))).toBe("#38bdf8");
  });
});
