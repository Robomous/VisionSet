/**
 * The side panel, driven against a real `AnnotatorStore`.
 *
 * No `fetch` and no provider: the panel's whole contract is that it is driven by
 * the store the page already holds and adds no second door to the document. A test
 * that mocked anything would be testing a different component.
 *
 * The visibility half is deliberately **not** here — a hidden object not
 * hit-testing is a claim about the canvas, and `visibility.test.ts` in the
 * annotator holds the projection while `panel.spec.ts` holds the browser end.
 * What is here is everything that is markup and commands.
 */

import { AnnotatorStore, documentFromWire, selectOnly } from "@visionset/annotator";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { JSX } from "react";

import { AnnotatorPanel } from "./AnnotatorPanel";

const SCHEMA = {
  project_id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  classes: [
    { name: "vehicle", geometry: "bbox", color: "#38bdf8", attributes: [] },
    { name: "pedestrian", geometry: "bbox", color: null, attributes: [] },
    { name: "lane", geometry: "polygon", color: "#f97316", attributes: [] },
    { name: "daytime", geometry: "classification_tag", color: "#a3e635", attributes: [] },
  ],
};

function annotation(id: string, labelClass: string, type: "bbox" | "polygon"): unknown {
  return {
    id,
    asset_id: "asset-1",
    label_class: labelClass,
    schema_version: 1,
    geometry:
      type === "bbox"
        ? { type: "bbox", x: 10, y: 10, width: 20, height: 20 }
        : { type: "polygon", points: [[0, 0], [10, 0], [10, 10]] },
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
  };
}

function storeWith(annotations: readonly unknown[]): AnnotatorStore {
  return new AnnotatorStore(
    documentFromWire({ asset: { id: "asset-1", width: 100, height: 100 }, schema: SCHEMA, annotations }),
  );
}

function mount(
  store: AnnotatorStore,
  overrides: Partial<Parameters<typeof AnnotatorPanel>[0]> = {},
): JSX.Element {
  return (
    <AnnotatorPanel
      store={store}
      hiddenIds={new Set()}
      onHiddenChange={vi.fn()}
      activeClass={null}
      onActivateClass={vi.fn()}
      {...overrides}
    />
  );
}

describe("the Objects tab", () => {
  it("numbers the annotations in draw order and names each one's class", () => {
    const store = storeWith([annotation("a", "vehicle", "bbox"), annotation("b", "lane", "polygon")]);
    render(mount(store));

    expect(screen.getByTestId("object-count").textContent).toBe("2 objects");
    expect(screen.getByTestId("object-row-0").textContent).toContain("1. vehicle");
    expect(screen.getByTestId("object-row-1").textContent).toContain("2. lane");
  });

  it("round-trips the selection, because there is only one", async () => {
    const store = storeWith([annotation("a", "vehicle", "bbox"), annotation("b", "lane", "polygon")]);
    render(mount(store));

    // Row → canvas.
    await userEvent.click(screen.getByTestId("object-select-1"));
    expect([...store.selection]).toEqual(["b"]);

    // Canvas → row. Not a synchronisation: the panel subscribes to the same store,
    // so this is one `Selection` seen twice rather than two kept in step.
    store.select(selectOnly("a"));
    expect(await screen.findByTestId("object-row-0")).toHaveProperty("dataset.selected", "true");
    expect(screen.getByTestId("object-row-1").dataset["selected"]).toBe("false");
  });

  it("deletes through the same command path the keyboard uses, and it is undoable", async () => {
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    render(mount(store));

    await userEvent.click(screen.getByTestId("object-delete-0"));
    expect(store.document.annotations.size).toBe(0);
    expect(store.canUndo).toBe(true);
    // The label a keyboard delete would have produced — one path, one history entry.
    expect(store.getSnapshot().undoLabel).toBe("delete 1 annotation");

    store.undo();
    expect(store.document.annotations.size).toBe(1);
  });

  it("asks the page to hide one object, and to hide or show all of them", async () => {
    const changes: ReadonlySet<string>[] = [];
    const store = storeWith([annotation("a", "vehicle", "bbox"), annotation("b", "lane", "polygon")]);
    const { rerender } = render(mount(store, { onHiddenChange: (next) => changes.push(next) }));

    await userEvent.click(screen.getByTestId("object-visibility-0"));
    expect([...changes[0]]).toEqual(["a"]);

    await userEvent.click(screen.getByTestId("toggle-all-visibility"));
    expect([...changes[1]].sort()).toEqual(["a", "b"]);

    // …and with everything hidden, the same control shows them again.
    rerender(mount(store, { hiddenIds: new Set(["a", "b"]), onHiddenChange: (n) => changes.push(n) }));
    await userEvent.click(screen.getByTestId("toggle-all-visibility"));
    expect([...changes[2]]).toEqual([]);
  });

  it("dims a hidden row rather than removing it — it is still an object", () => {
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    render(mount(store, { hiddenIds: new Set(["a"]) }));
    expect(screen.getByTestId("object-row-0").dataset["hidden"]).toBe("true");
    expect(screen.getByTestId("object-count").textContent).toBe("1 object");
  });
});

describe("the editing card", () => {
  it("appears only for exactly one selected object", async () => {
    const store = storeWith([annotation("a", "vehicle", "bbox"), annotation("b", "lane", "polygon")]);
    render(mount(store));
    expect(screen.queryByTestId("editing-card")).toBeNull();

    store.select(selectOnly("a"));
    expect(await screen.findByTestId("editing-card")).not.toBeNull();
    expect(screen.getByTestId("editing-geometry").textContent).toBe("bbox");
  });

  it("offers only classes that share the geometry, because the kernel judges per class", async () => {
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    render(mount(store));
    store.select(selectOnly("a"));
    await screen.findByTestId("editing-card");

    await userEvent.click(screen.getByTestId("reclass-select"));
    // Both bbox classes…
    expect(screen.queryByRole("option", { name: "pedestrian" })).not.toBeNull();
    // …and neither the polygon class nor the tag: a cross-geometry reassignment is
    // a write the API refuses with `DisallowedGeometry`, so offering it would be
    // offering a refusal.
    expect(screen.queryByRole("option", { name: "lane" })).toBeNull();
    expect(screen.queryByRole("option", { name: "daytime" })).toBeNull();
  });

  it("applies behind a button, so a picker does not fill the history", async () => {
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    render(mount(store));
    store.select(selectOnly("a"));
    await screen.findByTestId("editing-card");

    await userEvent.click(screen.getByTestId("reclass-select"));
    await userEvent.click(screen.getByRole("option", { name: "pedestrian" }));
    // Chosen, not applied.
    expect(store.document.annotations.get("a")?.label_class).toBe("vehicle");
    expect(store.canUndo).toBe(false);

    await userEvent.click(screen.getByTestId("reclass-apply"));
    expect(store.document.annotations.get("a")?.label_class).toBe("pedestrian");
    expect(store.canUndo).toBe(true);
  });
});

describe("the Labels tab", () => {
  async function open(): Promise<void> {
    await userEvent.click(screen.getByTestId("tab-labels"));
  }

  it("shows the digit each class answers to, from the same table the keyboard reads", async () => {
    const store = storeWith([]);
    render(mount(store));
    await open();

    // `hotkeyForClass`, so the panel and the input layer cannot disagree about
    // which number a class is.
    expect(within(screen.getByTestId("label-vehicle")).getByText("1")).not.toBeNull();
    // Digit N is palette row N in *authored* order, with no filtering — `daytime` is
    // the fourth class, so it is 4 even though it is the first tag.
    expect(within(screen.getByTestId("label-daytime")).getByText("4")).not.toBeNull();
  });

  it("activates a drawable class, exactly as its digit does", async () => {
    const activate = vi.fn();
    const store = storeWith([]);
    render(mount(store, { onActivateClass: activate }));
    await open();

    await userEvent.click(screen.getByTestId("label-lane"));
    expect(activate).toHaveBeenCalledWith("lane");
    expect(store.canUndo).toBe(false);
  });

  it("toggles a tag class instead, and shows its checked state", async () => {
    const activate = vi.fn();
    const store = storeWith([]);
    const { rerender } = render(mount(store, { onActivateClass: activate }));
    await open();

    await userEvent.click(screen.getByTestId("label-daytime"));
    // `classAction`'s split: a tag is a command, not an active class.
    expect(activate).not.toHaveBeenCalled();
    expect(store.document.annotations.size).toBe(1);

    rerender(mount(store, { onActivateClass: activate }));
    await open();
    expect(screen.getByTestId("label-daytime").dataset["active"]).toBe("true");

    // And a second press clears it — one tag per class, which the annotator holds
    // structurally because the kernel enforces no uniqueness (#121).
    await userEvent.click(screen.getByTestId("label-daytime"));
    expect(store.document.annotations.size).toBe(0);
  });

  it("marks select mode when no class is active", async () => {
    const store = storeWith([]);
    render(mount(store, { activeClass: null }));
    await open();
    expect(screen.getByTestId("label-select").dataset["active"]).toBe("true");
  });
});
