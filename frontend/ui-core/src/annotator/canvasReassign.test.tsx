/**
 * The reassignment picker's canvas anchor, driven against a real store.
 *
 * The same shape `panel.test.tsx` has: no `fetch`, no provider, no mock. What is
 * asserted here is *wiring* — that the affordance appears for the right subject,
 * that it applies through the command, and that a digit is claimed. The two claims
 * that need a real browser (a right-click reaching the machine, and the button
 * landing on the shape's corner) are in `frontend/app/e2e/annotate.spec.ts`:
 * jsdom's `getBoundingClientRect` answers all zeros, so a layout
 * assertion here would pass whatever the transform did.
 */

import {
  AnnotatorStore,
  IDENTITY_VIEWPORT,
  documentFromWire,
  selectOnly,
  selectionOf,
} from "@visionset/annotator";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { JSX } from "react";

import { CanvasReassign } from "./CanvasReassign";

const SCHEMA = {
  project_id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  classes: [
    { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
    { name: "pedestrian", geometries: ["bbox"], color: null, attributes: [] },
    { name: "lane", geometries: ["polygon"], color: "#f97316", attributes: [] },
    { name: "daytime", geometries: ["classification_tag"], color: "#a3e635", attributes: [] },
  ],
};

function annotation(
  id: string,
  labelClass: string,
  type: "bbox" | "polygon" | "classification_tag",
): unknown {
  const shapes = {
    bbox: { type: "bbox", x: 10, y: 20, width: 30, height: 40 },
    polygon: { type: "polygon", points: [[0, 0], [10, 0], [10, 10]] },
    classification_tag: { type: "classification_tag" },
  } as const;
  return {
    id,
    asset_id: "asset-1",
    label_class: labelClass,
    schema_version: 1,
    geometry: shapes[type],
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: null,
  };
}

function storeWith(annotations: readonly unknown[]): AnnotatorStore {
  return new AnnotatorStore(
    documentFromWire({
      asset: { id: "asset-1", width: 100, height: 100 },
      schema: SCHEMA,
      annotations,
    }),
  );
}

function mount(
  store: AnnotatorStore,
  overrides: Partial<Parameters<typeof CanvasReassign>[0]> = {},
): JSX.Element {
  return (
    <CanvasReassign
      store={store}
      view={IDENTITY_VIEWPORT}
      openFor={null}
      onOpenChange={vi.fn()}
      {...overrides}
    />
  );
}

/** One bbox, selected — the ordinary case every assertion below varies from. */
function selectedBox(): AnnotatorStore {
  const store = storeWith([annotation("a", "vehicle", "bbox")]);
  store.select(selectOnly("a"));
  return store;
}

describe("when the picker is offered at all", () => {
  it("rides the one selected shape, and names what it will reassign", () => {
    render(mount(selectedBox()));

    expect(screen.getByTestId("canvas-reclass").getAttribute("aria-label")).toBe(
      "Reassign the selected vehicle",
    );
  });

  it("is absent with nothing selected, because it has no subject", () => {
    render(mount(storeWith([annotation("a", "vehicle", "bbox")])));

    expect(screen.queryByTestId("canvas-reclass")).toBeNull();
  });

  it("is absent with two selected, rather than silently acting on the first", () => {
    const store = storeWith([
      annotation("a", "vehicle", "bbox"),
      annotation("b", "pedestrian", "bbox"),
    ]);
    store.select(selectionOf(["a", "b"]));
    render(mount(store));

    expect(screen.queryByTestId("canvas-reclass")).toBeNull();
  });

  it("is absent for a classification tag, which the canvas draws nowhere", () => {
    // Nothing is rendered for a tag, so there is no position on the stage that
    // means it. It is still reachable from its panel row, which is a list and
    // needs no anchor.
    const store = storeWith([annotation("a", "daytime", "classification_tag")]);
    store.select(selectOnly("a"));
    render(mount(store));

    expect(screen.queryByTestId("canvas-reclass")).toBeNull();
  });

  it("is absent before the stage has been measured, rather than anchored at an invented origin", () => {
    render(mount(selectedBox(), { view: null }));

    expect(screen.queryByTestId("canvas-reclass")).toBeNull();
  });

  it("is absent entirely when the document cannot be written", () => {
    // Gone rather than disabled: every item on it is a write, so a disabled one
    // is an empty promise with a dropdown — the panel's own call.
    render(mount(selectedBox(), { readOnly: true }));

    expect(screen.queryByTestId("canvas-reclass")).toBeNull();
  });
});

describe("what the picker does", () => {
  it("applies through the command, so undo takes the class back", async () => {
    const store = selectedBox();
    const onOpenChange = vi.fn();
    render(mount(store, { openFor: "a", onOpenChange }));

    await userEvent.click(screen.getByTestId("canvas-reclass-pedestrian"));

    expect(store.document.annotations.get("a")?.label_class).toBe("pedestrian");
    expect(store.getSnapshot().undoLabel).toBe("edit pedestrian");
    store.undo();
    expect(store.document.annotations.get("a")?.label_class).toBe("vehicle");
  });

  it("lists every class, disabling the ones this shape cannot become and saying why", () => {
    render(mount(selectedBox(), { openFor: "a" }));

    expect(
      screen.getByTestId("canvas-reclass-pedestrian").getAttribute("aria-disabled"),
    ).not.toBe("true");
    for (const name of ["lane", "daytime"]) {
      expect(screen.getByTestId(`canvas-reclass-${name}`).getAttribute("aria-disabled")).toBe(
        "true",
      );
    }
    expect(screen.getByTestId("canvas-reclass-lane").textContent).toContain("needs polygon");
  });

  it("checks the class the shape already carries", () => {
    render(mount(selectedBox(), { openFor: "a" }));

    expect(
      screen.getByTestId("canvas-reclass-vehicle").querySelector('[aria-label="current class"]'),
    ).not.toBeNull();
  });

  it("shows the class hotkey where it works, and the reason where it does not", () => {
    render(mount(selectedBox(), { openFor: "a" }));

    // `pedestrian` is the schema's second class, so digit 2 — the same numbering
    // the canvas arms a drawing class with.
    expect(screen.getByTestId("canvas-reclass-pedestrian").textContent).toContain("2");
    // A key chip on a row that refuses the key would be a lie; the reason takes
    // the slot instead.
    expect(screen.getByTestId("canvas-reclass-lane").textContent).not.toContain("3");
  });

  it("reassigns on a class hotkey and closes itself, since a digit is not an item press", async () => {
    const store = selectedBox();
    const onOpenChange = vi.fn();
    render(mount(store, { openFor: "a", onOpenChange }));

    await userEvent.keyboard("2");

    expect(store.document.annotations.get("a")?.label_class).toBe("pedestrian");
    expect(onOpenChange).toHaveBeenCalledWith(null);
  });

  it("changes nothing on a digit for a class this shape cannot become, and stays open", async () => {
    const store = selectedBox();
    const onOpenChange = vi.fn();
    render(mount(store, { openFor: "a", onOpenChange }));

    // `lane` is digit 3 and is a polygon class — the same refusal its own row
    // carries, reached by the other door.
    await userEvent.keyboard("3");

    expect(store.document.annotations.get("a")?.label_class).toBe("vehicle");
    expect(store.canUndo).toBe(false);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes on Escape with the document untouched", async () => {
    const store = selectedBox();
    const onOpenChange = vi.fn();
    render(mount(store, { openFor: "a", onOpenChange }));

    await userEvent.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(null);
    expect(store.document.annotations.get("a")?.label_class).toBe("vehicle");
    expect(store.canUndo).toBe(false);
  });
});
