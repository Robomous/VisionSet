/**
 * The glyph a class row draws for each geometry the class may use.
 *
 * What a test can hold is the contract the row relies on: every geometry the
 * editor offers has its own drawing, in the class's colour at the annotator's
 * fill, with the grips or vertices the canvas shows — hollow, and hollow on
 * any surface, because the outline is cut away under them rather than painted
 * over; and a geometry a newer server names still draws something — a dashed
 * box — rather than a hole.
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CLASS_FILL_OPACITY } from "../palette";
import type { GeometryType } from "../screens/queries";
import { ShapeGlyph } from "./ShapeGlyph";

const COLOR = "#38bdf8";

function drawn(geometry: GeometryType | string): SVGSVGElement {
  const { container } = render(<ShapeGlyph geometry={geometry as GeometryType} color={COLOR} />);
  const svg = container.querySelector("svg");
  if (svg === null) throw new Error("Expected the glyph to render an svg");
  return svg;
}

const outline = (svg: SVGSVGElement): Element | null => svg.querySelector("[data-part=outline]");

describe("ShapeGlyph", () => {
  it.each([
    { geometry: "bbox", element: "rect" },
    { geometry: "obb", element: "polygon" },
    { geometry: "polygon", element: "polygon" },
    { geometry: "polyline", element: "polyline" },
    { geometry: "classification_tag", element: "rect" },
  ])("draws a $element for $geometry, in the class's colour", ({ geometry, element }) => {
    const shape = outline(drawn(geometry));

    expect(shape?.tagName.toLowerCase()).toBe(element);
    expect(shape?.getAttribute("stroke")).toBe(COLOR);
    expect(shape?.getAttribute("stroke-dasharray")).toBeNull();
  });

  it("fills a closed shape at the annotator's opacity, and leaves a line unfilled", () => {
    expect(Number(outline(drawn("bbox"))?.getAttribute("fill-opacity"))).toBe(CLASS_FILL_OPACITY);
    expect(Number(outline(drawn("polygon"))?.getAttribute("fill-opacity"))).toBe(CLASS_FILL_OPACITY);
    expect(outline(drawn("polyline"))?.getAttribute("fill")).toBe("none");
  });

  it("draws the handles the canvas draws: four square grips on a box, a round vertex per point otherwise", () => {
    const box = drawn("bbox").querySelectorAll("[data-part=grip]");
    expect(box).toHaveLength(4);
    expect(box[0]?.tagName.toLowerCase()).toBe("rect");

    const polygon = drawn("polygon").querySelectorAll("[data-part=vertex]");
    expect(polygon).toHaveLength(5);
    expect(polygon[0]?.tagName.toLowerCase()).toBe("circle");

    expect(drawn("polyline").querySelectorAll("[data-part=vertex]")).toHaveLength(4);
    expect(drawn("obb").querySelectorAll("[data-part=grip]")).toHaveLength(4);
  });

  it.each(["bbox", "obb", "polygon", "polyline"])("leaves the handles of a %s hollow on whatever it sits on", (geometry) => {
    const svg = drawn(geometry);
    const handles = [...svg.querySelectorAll("[data-part=grip], [data-part=vertex]")];
    const mask = svg.querySelector("mask");

    // Ringed in the class's colour, never painted with a surface colour.
    for (const handle of handles) {
      expect(handle.getAttribute("fill")).toBe("none");
      expect(handle.getAttribute("stroke")).toBe(COLOR);
    }
    // The outline is cut away under each one: a black shape per handle in its mask.
    expect(mask?.querySelectorAll("[fill='#000']")).toHaveLength(handles.length);
    expect(outline(svg)?.closest("g")?.getAttribute("mask")).toBe(`url(#${mask?.id})`);
  });

  it("gives each glyph on a page a mask of its own", () => {
    const { container } = render(
      <>
        <ShapeGlyph geometry="bbox" color={COLOR} />
        <ShapeGlyph geometry="bbox" color={COLOR} />
        <ShapeGlyph geometry="polygon" color={COLOR} />
      </>,
    );
    const ids = [...container.querySelectorAll("mask")].map((mask) => mask.id);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    // Each is a plain fragment identifier, so `url(#…)` needs no escaping.
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
  });

  it("draws a pill with a pin for a tag, so it reads differently from a box", () => {
    const svg = drawn("classification_tag");

    expect(outline(svg)?.getAttribute("rx")).toBe("4.25");
    expect(svg.querySelector("circle")?.getAttribute("fill")).toBe(COLOR);
    // Nothing to hold it by: a tag has no grips, so nothing is cut away.
    expect(svg.querySelector("mask")).toBeNull();
  });

  it("gives each geometry a drawing of its own", () => {
    // Without the mask ids, which differ between any two glyphs.
    const offered = ["bbox", "obb", "polygon", "polyline", "classification_tag"].map((geometry) => drawn(geometry).innerHTML.replace(/shape-glyph-[\w-]+/g, ""));

    expect(new Set(offered).size).toBe(offered.length);
  });

  it("is drawn on the 28×20 grid a row renders it at", () => {
    expect(drawn("bbox").getAttribute("viewBox")).toBe("0 0 28 20");
  });

  it("falls back to a dashed box for a geometry it does not know, rather than drawing nothing", () => {
    const svg = drawn("hologram");

    expect(svg.children).toHaveLength(1);
    expect(svg.querySelector("rect")?.getAttribute("stroke-dasharray")).toBe("2 2");
  });

  it("is decorative: the row names the shapes in words", () => {
    expect(drawn("bbox").getAttribute("aria-hidden")).toBe("true");
  });
});
