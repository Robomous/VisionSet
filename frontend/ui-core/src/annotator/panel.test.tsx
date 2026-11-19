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
import { act, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX } from "react";

import { AnnotatorPanel } from "./AnnotatorPanel";
import { TooltipProvider } from "@robomous/ui-core";
import { stubResizeObserver } from "../testing/resizeObserver.js";

const SCHEMA = {
  project_id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  classes: [
    { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
    { name: "pedestrian", geometries: ["bbox"], color: null, attributes: [] },
    { name: "lane", geometries: ["polygon"], color: "#f97316", attributes: [] },
    { name: "daytime", geometries: ["classification_tag"], color: "#a3e635", attributes: [] },
    { name: "centerline", geometries: ["polyline"], color: "#eb5a47", attributes: [] },
  ],
};

/** The same schema with its one tag class removed — the strip's absent case. */
const UNTAGGABLE_SCHEMA = {
  ...SCHEMA,
  classes: SCHEMA.classes.filter(
    (declared) => !declared.geometries.includes("classification_tag"),
  ),
};

function annotation(
  id: string,
  labelClass: string,
  type: "bbox" | "polygon" | "polyline",
): unknown {
  const shapes = {
    bbox: { type: "bbox", x: 10, y: 10, width: 20, height: 20 },
    polygon: { type: "polygon", points: [[0, 0], [10, 0], [10, 10]] },
    polyline: { type: "polyline", points: [[2, 4], [12, 40], [30, 96]] },
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

function storeWith(annotations: readonly unknown[], schema: unknown = SCHEMA): AnnotatorStore {
  return new AnnotatorStore(
    documentFromWire({ asset: { id: "asset-1", width: 100, height: 100 }, schema, annotations }),
  );
}

function mount(
  store: AnnotatorStore,
  overrides: Partial<Parameters<typeof AnnotatorPanel>[0]> = {},
): JSX.Element {
  // The provider the app mounts once at its root (`app/src/main.tsx`); a row's
  // model mark is a tooltip trigger, and Radix refuses one outside it.
  return (
    <TooltipProvider>
      <AnnotatorPanel
        store={store}
        hiddenIds={new Set()}
        onHiddenChange={vi.fn()}
        activeClass={null}
        onActivateClass={vi.fn()}
        {...overrides}
      />
    </TooltipProvider>
  );
}

// The provenance badge on an accepted row is a Tooltip trigger. See
// `testing/resizeObserver.ts`.
beforeEach(() => {
  stubResizeObserver();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the three regions the panel is now", () => {
  it("stacks them without tabs, so all three subjects are on screen at once", () => {
    // One view rather than Objects | Labels tabs.
    // A tab is a claim that things are alternatives, and these are three answers
    // about one frame: what may I draw, what is true of the whole picture, what
    // have I drawn.
    render(mount(storeWith([annotation("a", "vehicle", "bbox")])));

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByTestId("class-region")).toBeDefined();
    expect(screen.getByTestId("tag-region")).toBeDefined();
    expect(screen.getByTestId("objects-region")).toBeDefined();
  });

  it("orders them classes, tags, annotations", () => {
    // The reading order is the argument for the arrangement, so it is pinned:
    // the ontology, then what is true of the whole frame, then what is on it.
    render(mount(storeWith([annotation("a", "vehicle", "bbox")])));

    const panel = screen.getByTestId("annotator-panel");
    const order = [...panel.querySelectorAll("[data-testid]")]
      .map((node) => node.getAttribute("data-testid"))
      .filter((id) => id === "class-region" || id === "tag-region" || id === "objects-region");
    expect(order).toEqual(["class-region", "tag-region", "objects-region"]);
  });

  it("names itself and counts what is drawn", () => {
    const store = storeWith([annotation("a", "vehicle", "bbox"), annotation("b", "lane", "polygon")]);
    render(mount(store));

    expect(screen.getByTestId("annotator-panel").getAttribute("aria-label")).toBe(
      "Classes, tags and annotations",
    );
    expect(screen.getByTestId("object-count").textContent).toBe("2 objects");
  });

  it("renders no classes region when nothing in the schema can be drawn", () => {
    // A heading over an empty box claims something is missing. A schema of
    // nothing but tag classes has no drawing to offer, so the region goes — and
    // the split rule goes with it, which is why the panel decides this and not
    // `ClassRegion`.
    const tagsOnly = {
      ...SCHEMA,
      classes: SCHEMA.classes.filter((declared) =>
        declared.geometries.includes("classification_tag"),
      ),
    };
    render(mount(storeWith([], tagsOnly)));

    expect(screen.queryByTestId("class-region")).toBeNull();
    expect(screen.queryByTestId("panel-split")).toBeNull();
    // The other two are still there, and the tags one is the point of the schema.
    expect(screen.getByTestId("tag-region")).toBeDefined();
    expect(screen.getByTestId("objects-region")).toBeDefined();
  });
});

describe("the object list", () => {
  it("numbers the annotations in draw order and names each one's class", () => {
    const store = storeWith([annotation("a", "vehicle", "bbox"), annotation("b", "lane", "polygon")]);
    render(mount(store));

    expect(screen.getByTestId("object-row-0").textContent).toContain("1. vehicle");
    expect(screen.getByTestId("object-row-1").textContent).toContain("2. lane");
  });

  it("names each row's geometry, because the class name stopped identifying it", () => {
    // A class accepts a *set*, so two rows reading `sign` may be a box and a
    // polygon — and this row is where somebody picks which one to select or
    // delete. The display word, never the wire value.
    const multi = {
      ...SCHEMA,
      classes: [
        { name: "sign", geometries: ["bbox", "polygon"], color: null, attributes: [] },
        ...SCHEMA.classes,
      ],
    };
    const store = storeWith(
      [annotation("a", "sign", "bbox"), annotation("b", "sign", "polygon")],
      multi,
    );
    render(mount(store));

    expect(screen.getByTestId("object-row-0").textContent).toContain("1. sign · box");
    expect(screen.getByTestId("object-row-1").textContent).toContain("2. sign · polygon");
  });

  it("leaves classification tags out of it entirely", async () => {
    // They were in it, and twice over: the list was every annotation in the
    // document, so a tag was a chip *and* a numbered row — counted as an object,
    // with a hide button that hides nothing and a reassignment menu onto classes
    // that cannot hold it. Nothing asserted it, which is how it shipped.
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    const { rerender } = render(mount(store));
    expect(screen.getByTestId("object-count").textContent).toBe("1 object");

    await userEvent.click(screen.getByTestId("tag-chip-daytime"));
    rerender(mount(store));

    // The document holds both; the list holds one.
    expect(store.document.annotations.size).toBe(2);
    expect(screen.getByTestId("object-count").textContent).toBe("1 object");
    expect(screen.getByTestId("object-row-0").textContent).toContain("1. vehicle");
    expect(screen.queryByTestId("object-row-1")).toBeNull();
  });

  it("says nothing is drawn on an asset that carries only a tag", async () => {
    const store = storeWith([]);
    const { rerender } = render(mount(store));

    await userEvent.click(screen.getByTestId("tag-chip-daytime"));
    rerender(mount(store));

    expect(screen.getByTestId("object-count").textContent).toBe("0 objects");
    expect(screen.getByTestId("objects-empty").textContent).toBe("Nothing drawn yet.");
  });

  it("hides all objects without reaching for a tag, which has nothing to hide", async () => {
    const hidden = vi.fn();
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    const { rerender } = render(mount(store, { onHiddenChange: hidden }));
    await userEvent.click(screen.getByTestId("tag-chip-daytime"));
    rerender(mount(store, { onHiddenChange: hidden }));

    await userEvent.click(screen.getByTestId("toggle-all-visibility"));

    // The drawn one, and only it — a tag renders in neither canvas layer, so an
    // id for it in the hidden set would be an instruction about nothing.
    expect(hidden).toHaveBeenLastCalledWith(new Set(["a"]));
  });

  it("lists a lane like any other object, and selects it from its row", async () => {
    // A polyline drawn before the tool existed can only be reached from the object
    // list: `geometryContains` deliberately
    // answers false for an open path, so a canvas press cannot select it. A row
    // that could not select would leave a lane visible and untouchable.
    const store = storeWith([
      annotation("a", "vehicle", "bbox"),
      annotation("b", "centerline", "polyline"),
    ]);
    render(mount(store));

    expect(screen.getByTestId("object-count").textContent).toBe("2 objects");
    expect(screen.getByTestId("object-row-1").textContent).toContain("2. centerline");

    await userEvent.click(screen.getByTestId("object-select-1"));
    expect([...store.selection]).toEqual(["b"]);
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

describe("the filter", () => {
  it("is there before there is anything to filter", () => {
    // Always rendered: a control that appears once a list is long enough is a
    // control nobody finds.
    render(mount(storeWith([])));
    expect(screen.getByTestId("object-filter")).not.toBeNull();
    expect(screen.getByTestId("objects-empty").textContent).toBe("Nothing drawn yet.");
  });

  it("keeps the rows whose class matches, anywhere in the name", async () => {
    const store = storeWith([
      annotation("a", "vehicle", "bbox"),
      annotation("b", "lane", "polygon"),
      annotation("c", "centerline", "polyline"),
    ]);
    render(mount(store));

    // `line` is the tail of one class and the middle of another — a `startsWith`
    // rule would keep neither, and the top bar's own picker matches anywhere too.
    await userEvent.type(screen.getByTestId("object-filter"), "line");
    expect(screen.queryByTestId("object-row-0")).toBeNull();
    expect(screen.getByTestId("object-row-2").textContent).toContain("3. centerline");
  });

  it("keeps each object's number, because the number is its identity on the canvas", async () => {
    const store = storeWith([annotation("a", "vehicle", "bbox"), annotation("b", "lane", "polygon")]);
    render(mount(store));

    await userEvent.type(screen.getByTestId("object-filter"), "lane");
    // Still "2.", not renumbered to "1." — the panel and the picture must not
    // disagree about which shape is which.
    expect(screen.getByTestId("object-row-1").textContent).toContain("2. lane");
    expect(screen.queryByTestId("object-row-0")).toBeNull();
    // And the count is still the whole document, not the visible slice.
    expect(screen.getByTestId("object-count").textContent).toBe("2 objects");
  });

  it("says a filter matched nothing, rather than saying nothing is drawn", async () => {
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    render(mount(store));

    await userEvent.type(screen.getByTestId("object-filter"), "zzz");
    expect(screen.getByTestId("objects-empty").textContent).toBe("No object matches that filter.");
  });
});

describe("the classification-tag section", () => {
  it("is absent when the pinned schema declares no tag class", () => {
    render(mount(storeWith([], UNTAGGABLE_SCHEMA)));
    expect(screen.queryByTestId("tag-strip")).toBeNull();
    expect(screen.queryByTestId("tag-region")).toBeNull();
    expect(screen.queryByTestId("panel-split-tags")).toBeNull();
  });

  it("is a section of its own, with a heading, a count and a sentence", () => {
    render(mount(storeWith([])));

    const region = screen.getByTestId("tag-region");
    expect(within(region).getByText("Tags")).toBeDefined();
    expect(screen.getByTestId("tag-count").textContent).toBe("0 assigned");
    // The one thing that distinguishes these from everything else in the panel.
    expect(screen.getByTestId("tag-note").textContent).toBe("Tags apply to the whole image.");
  });

  it("counts what is assigned, not what is offered", async () => {
    const store = storeWith([]);
    const { rerender } = render(mount(store));
    expect(screen.getByTestId("tag-count").textContent).toBe("0 assigned");

    await userEvent.click(screen.getByTestId("tag-chip-daytime"));
    rerender(mount(store));

    expect(screen.getByTestId("tag-count").textContent).toBe("1 assigned");
  });

  it("carries a tag per class, so an image can hold several at once", async () => {
    // The kernel's own rule, and the whole reason this is multi-select rather
    // than a picker: `DuplicateClassificationTag` is keyed `(asset, label_class)`,
    // so one tag per class and as many classes as the schema declares.
    const twoTags = {
      ...SCHEMA,
      classes: [
        ...SCHEMA.classes,
        { name: "raining", geometries: ["classification_tag"], color: null, attributes: [] },
      ],
    };
    const store = storeWith([], twoTags);
    const { rerender } = render(mount(store));

    await userEvent.click(screen.getByTestId("tag-chip-daytime"));
    await userEvent.click(screen.getByTestId("tag-chip-raining"));
    rerender(mount(store));

    expect(store.document.annotations.size).toBe(2);
    expect(screen.getByTestId("tag-chip-daytime").dataset["active"]).toBe("true");
    expect(screen.getByTestId("tag-chip-raining").dataset["active"]).toBe("true");
    expect(screen.getByTestId("tag-count").textContent).toBe("2 assigned");
    // And neither of them is an object.
    expect(screen.getByTestId("object-count").textContent).toBe("0 objects");
  });

  it("shows the digit each tag answers to, from the same table the keyboard reads", () => {
    render(mount(storeWith([])));
    // `hotkeyForClass`, so the chip and the input layer cannot disagree. Digit N is
    // palette row N in *authored* order with no filtering — `daytime` is the fourth
    // class, so it is 4 even though it is the first tag.
    expect(within(screen.getByTestId("tag-chip-daytime")).getByText("4")).not.toBeNull();
  });

  it("toggles a tag through the store, and a second press clears it", async () => {
    const store = storeWith([]);
    const { rerender } = render(mount(store));

    await userEvent.click(screen.getByTestId("tag-chip-daytime"));
    expect(store.document.annotations.size).toBe(1);

    rerender(mount(store));
    expect(screen.getByTestId("tag-chip-daytime").dataset["active"]).toBe("true");
    expect(screen.getByTestId("tag-chip-daytime").getAttribute("aria-pressed")).toBe("true");

    // One tag per class — which the annotator holds structurally *and* the kernel
    // enforces, keyed `(asset, label_class)`. It did not always: the engine's
    // identity command was the only guard when this was written.
    await userEvent.click(screen.getByTestId("tag-chip-daytime"));
    expect(store.document.annotations.size).toBe(0);
  });

  it("offers only tag classes, so a drawable class cannot be tagged from here", () => {
    render(mount(storeWith([])));
    expect(screen.getByTestId("tag-chip-daytime")).not.toBeNull();
    expect(screen.queryByTestId("tag-chip-vehicle")).toBeNull();
    expect(screen.queryByTestId("tag-chip-lane")).toBeNull();
  });
});

describe("reassigning a class from a row", () => {
  async function openMenu(index: number): Promise<void> {
    await userEvent.click(screen.getByTestId(`object-reclass-${index}`));
  }

  it("applies on selection and lands as one undoable history entry", async () => {
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    render(mount(store));

    await openMenu(0);
    await userEvent.click(screen.getByTestId("reclass-0-pedestrian"));

    expect(store.document.annotations.get("a")?.label_class).toBe("pedestrian");
    expect(store.canUndo).toBe(true);
    expect(store.getSnapshot().undoLabel).toBe("edit pedestrian");

    store.undo();
    expect(store.document.annotations.get("a")?.label_class).toBe("vehicle");
  });

  it("lists every class, disabling the ones whose geometry this object is not", async () => {
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    render(mount(store));
    await openMenu(0);

    // The other bbox class is offered…
    expect(screen.getByTestId("reclass-0-pedestrian").getAttribute("aria-disabled")).not.toBe(
      "true",
    );
    // …and the polygon, polyline and tag classes are present and refused, rather
    // than filtered out. A short list with no explanation reads as a schema that is
    // missing classes; the reason is what makes it actionable.
    for (const name of ["lane", "centerline", "daytime"]) {
      expect(screen.getByTestId(`reclass-0-${name}`).getAttribute("aria-disabled")).toBe("true");
    }
    expect(screen.getByTestId("reclass-0-lane").textContent).toContain("needs polygon");
    expect(screen.getByTestId("reclass-0-centerline").textContent).toContain("needs polyline");
  });

  it("will not reassign to a class the kernel would refuse", async () => {
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    render(mount(store));
    await openMenu(0);

    // `DisallowedGeometry` is the kernel's, and the menu must not be the surface
    // that discovers it: pressing a disabled item changes nothing at all.
    await userEvent.click(screen.getByTestId("reclass-0-lane"));
    expect(store.document.annotations.get("a")?.label_class).toBe("vehicle");
    expect(store.canUndo).toBe(false);
  });

  it("carries the class hotkeys, because the menu is the canvas picker's (#380)", async () => {
    // The row menu and the canvas one are the same component, so what the canvas
    // gained is on the panel too. This is the assertion that fails if a
    // second spelling is ever forked out of `ReassignMenu.tsx`.
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    render(mount(store));
    await openMenu(0);

    expect(screen.getByTestId("reclass-0-pedestrian").textContent).toContain("2");
  });

  it("reassigns on a class hotkey, at this anchor as at the other one", async () => {
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    render(mount(store));
    await openMenu(0);

    await userEvent.keyboard("2");
    expect(store.document.annotations.get("a")?.label_class).toBe("pedestrian");
    // A digit is not an item press, so the menu has to close itself — held open
    // by the row rather than by Radix for exactly this.
    expect(screen.queryByTestId("reclass-0-pedestrian")).toBeNull();
  });

  it("reassigns a polygon among polygon classes, so the rule is per geometry and not per row", async () => {
    const store = storeWith([annotation("a", "lane", "polygon")]);
    render(mount(store));
    await openMenu(0);

    // The control for the bbox case above: `vehicle` is the one refused here.
    expect(screen.getByTestId("reclass-0-vehicle").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("reclass-0-lane").getAttribute("aria-disabled")).not.toBe("true");
  });
});

/**
 * The panel is the *other* road into the document — audit finding F2's second half.
 *
 * The canvas being read-only is the visible part; a live panel beside it would
 * leave delete, class reassignment and tag toggling all still reachable, which is
 * a read-only mode with a hole in it. Every one of those is a `store.execute`
 * against a document the kernel will refuse to be handed.
 *
 * Visibility stays live on purpose and is the one thing that must **not** be
 * gated: hiding is a *view* decision the core document has no field for, which is
 * the same reason `visibility.ts` gives for why it must never travel to the API.
 * The filter is view state of the same kind.
 */
describe("what the panel offers when the document cannot be written", () => {
  it("draws no delete on an object row", async () => {
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    render(mount(store, { readOnly: true }));

    expect(screen.getByTestId("object-delete-0")).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByTestId("object-delete-0"));
    // Not merely disabled-looking: nothing reached the store, so there is nothing
    // in the history either.
    expect(store.getSnapshot().document.annotations.size).toBe(1);
    expect(store.getSnapshot().undoLabel).toBeNull();
  });

  it("offers no class reassignment, because reassigning is a write", () => {
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    render(mount(store, { readOnly: true }));

    // The control is gone rather than disabled: every item on the menu exists to
    // change the class, so a disabled one is an empty promise with a dropdown.
    expect(screen.queryByTestId("object-reclass-0")).toBeNull();
  });

  it("will not toggle a tag, which is the panel's quietest document change", async () => {
    const store = storeWith([]);
    render(mount(store, { readOnly: true }));

    const chip = screen.getByTestId("tag-chip-daytime");
    expect(chip).toHaveProperty("disabled", true);
    await userEvent.click(chip);
    expect(store.getSnapshot().document.annotations.size).toBe(0);
  });

  it("still hides and shows, because that is a view decision and never a document one", async () => {
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    const onHiddenChange = vi.fn();
    render(mount(store, { readOnly: true, onHiddenChange }));

    await userEvent.click(screen.getByTestId("object-visibility-0"));
    expect(onHiddenChange).toHaveBeenCalledOnce();
  });

  it("still filters, for the same reason", async () => {
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    render(mount(store, { readOnly: true }));

    await userEvent.type(screen.getByTestId("object-filter"), "zzz");
    expect(screen.getByTestId("objects-empty")).not.toBeNull();
  });

  it("offers all of it when the document can be written", () => {
    // The control: every assertion above is about `readOnly` and not about the
    // fixture happening to render nothing.
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    render(mount(store));

    expect(screen.getByTestId("object-delete-0")).toHaveProperty("disabled", false);
    expect(screen.queryByTestId("object-reclass-0")).not.toBeNull();
    expect(screen.getByTestId("tag-chip-daytime")).toHaveProperty("disabled", false);
  });

  it("renders no classes region at all — absent, not disabled", () => {
    // *What may I draw* is not a question a viewer can ask, so the region, its
    // filter, its quick-create and its hotkey badges all leave the panel. The
    // split rule goes with it — a divider between one region and nothing is a
    // line about nothing. What the region's absence buys — the objects region
    // taking the whole panel — is a layout fact, held in chromium.
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    render(mount(store, { readOnly: true }));

    expect(screen.queryByTestId("class-region")).toBeNull();
    expect(screen.queryByTestId("class-add")).toBeNull();
    expect(screen.queryByTestId("class-filter")).toBeNull();
    expect(screen.queryByTestId("panel-split")).toBeNull();
    expect(screen.getByTestId("objects-region")).toBeDefined();
  });
});

describe("selection is one state, reflected everywhere (#426 d)", () => {
  it("scrolls the selected row into view when the selection arrives from outside", async () => {
    // The canvas selects through `store.select`, never through this panel — so
    // the row has to notice its own `selected` moving. jsdom has no layout, so
    // what a unit test can hold is that the row *asks* to be scrolled; whether
    // it then is visible is `annotate.spec.ts`'s, in chromium.
    const store = storeWith([
      annotation("a", "vehicle", "bbox"),
      annotation("b", "lane", "polygon"),
    ]);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(mount(store));

    store.select(selectOnly("b"));

    expect(await screen.findByTestId("object-row-1")).toHaveProperty("dataset.selected", "true");
    expect(scrolled).toHaveBeenCalled();
  });
});

describe("what a model produced, on the row a reviewer accepts it from", () => {
  /** A predicted annotation: the write path stamps all three of these together. */
  function predicted(id: string, overrides: Record<string, unknown> = {}): unknown {
    return {
      ...(annotation(id, "vehicle", "bbox") as Record<string, unknown>),
      provenance: "model",
      model_ref: "IDEA-Research/grounding-dino-tiny@abc123",
      confidence: 0.62,
      ...overrides,
    };
  }

  it("marks it — that a model drew it, and no more than that", () => {
    render(mount(storeWith([predicted("m")])));

    expect(screen.getByTestId("object-model-0")).toBeDefined();
  });

  it("says in words what the glyph says in a picture", () => {
    // Never colour alone, and never shape alone either: the accessible name
    // carries the whole claim, so the mark survives a screen reader.
    render(mount(storeWith([predicted("m")])));

    expect(screen.getByTestId("object-model-0").getAttribute("aria-label")).toBe(
      "Model-produced by IDEA-Research/grounding-dino-tiny@abc123",
    );
  });

  it("shows no confidence anywhere on the row, nor in the name it announces", () => {
    // The number is an accept-or-reject aid and this row is past that decision.
    // Asserted on the whole row rather than on the element that used to hold
    // it, so a percentage reappearing anywhere in it turns this red.
    render(mount(storeWith([predicted("m")])));

    const row = screen.getByTestId("object-row-0");
    expect(row.textContent).not.toContain("%");
    expect(row.textContent).not.toContain("62");
    expect(screen.getByTestId("object-model-0").getAttribute("aria-label")).not.toContain("%");
  });

  it("puts nothing at all on a label a person drew", () => {
    // The common path stays exactly as it shipped — absence is the human case,
    // so a reviewer's thousandth row gains no badge and no noise.
    render(mount(storeWith([annotation("h", "vehicle", "bbox")])));

    expect(screen.queryByTestId("object-model-0")).toBeNull();
  });

  it("marks the model's work the same whether or not a score was recorded", () => {
    // `confidence` is optional on a model-produced annotation, and the mark no
    // longer depends on it at all — which is what makes the mark's absence mean
    // "a person drew this" rather than "the model did not score itself".
    render(mount(storeWith([predicted("m", { confidence: null })])));

    expect(screen.getByTestId("object-model-0")).toBeDefined();
    expect(screen.getByTestId("object-row-0").textContent).not.toContain("0");
  });

  it("marks nothing for an imported label, which has no model to name", () => {
    const imported = predicted("i", { provenance: "import", model_ref: null, confidence: null });
    render(mount(storeWith([imported])));

    expect(screen.queryByTestId("object-model-0")).toBeNull();
  });

  it("carries the full model reference for the reviewer who asks which model", () => {
    // The row is far too narrow for a hub id and a revision, so the reference
    // lives on the trigger's tooltip. Radix mounts the content on hover; the
    // accessible name above is what a keyboard or a screen reader gets.
    render(mount(storeWith([predicted("m")])));

    expect(screen.getByTestId("object-model-0").getAttribute("aria-label")).toContain(
      "IDEA-Research/grounding-dino-tiny@abc123",
    );
  });

  it("marks only the rows that are the model's, in a list holding both", () => {
    render(
      mount(
        storeWith([
          annotation("h", "vehicle", "bbox"),
          predicted("m", { confidence: 0.41 }),
        ]),
      ),
    );

    expect(screen.queryByTestId("object-model-0")).toBeNull();
    expect(screen.getByTestId("object-model-1")).toBeDefined();
    expect(screen.getByTestId("object-row-1").textContent).not.toContain("41");
  });
});

describe("the selected lane's vertices", () => {
  function laneStore(): AnnotatorStore {
    const store = storeWith([
      annotation("a", "vehicle", "bbox"),
      annotation("b", "centerline", "polyline"),
    ]);
    store.select(selectOnly("b"));
    return store;
  }

  it("is absent until exactly one lane is selected", () => {
    const store = storeWith([annotation("a", "vehicle", "bbox")]);
    store.select(selectOnly("a"));
    render(mount(store));
    expect(screen.queryByTestId("vertex-region")).toBeNull();
  });

  it("lists one toggle per vertex, none pressed while nothing is recorded", () => {
    render(mount(laneStore()));
    expect(screen.getByTestId("vertex-occluded-count").textContent).toBe("Not recorded");
    const toggles = within(screen.getByTestId("vertex-region")).getAllByRole("button");
    expect(toggles).toHaveLength(3);
    expect(toggles.map((one) => one.getAttribute("aria-pressed"))).toEqual(["false", "false", "false"]);
    expect(screen.getByRole("button", { name: "Vertex 2 occluded" })).toBe(toggles[1]);
  });

  it("marks a vertex occluded from the keyboard, as one undoable edit", async () => {
    const store = laneStore();
    render(mount(store));
    screen.getByTestId("vertex-toggle-1").focus();
    await userEvent.keyboard(" ");

    expect(screen.getByTestId("vertex-toggle-1").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("vertex-occluded-count").textContent).toBe("1 occluded");
    const geometry = store.document.annotations.get("b")?.geometry;
    expect(geometry).toMatchObject({ visibility: [2, 1, 2] });

    await userEvent.click(screen.getByTestId("vertex-toggle-1"));
    expect(store.document.annotations.get("b")?.geometry).toMatchObject({ visibility: [2, 2, 2] });
    store.undo();
    expect(store.document.annotations.get("b")?.geometry).toMatchObject({ visibility: [2, 1, 2] });
  });

  it("is disabled, not hidden, in the read-only mode, and says nothing about pressing", async () => {
    const store = laneStore();
    render(mount(store, { readOnly: true }));
    const toggles = within(screen.getByTestId("vertex-region")).getAllByRole("button");
    expect(toggles).toHaveLength(3);
    for (const toggle of toggles) expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByTestId("vertex-hint")).toBeNull();

    await userEvent.click(toggles[1]);
    toggles[1].focus();
    await userEvent.keyboard(" ");
    expect(toggles[1].getAttribute("aria-pressed")).toBe("false");
    expect(store.canUndo).toBe(false);
  });
});

/** A selected `centerline` lane of `count` vertices, carrying `visibility` when given. */
function longLane(count: number, visibility?: readonly number[]): AnnotatorStore {
  const lane = annotation("b", "centerline", "polyline") as { geometry: object };
  const store = storeWith([
    {
      ...lane,
      geometry: {
        type: "polyline",
        points: Array.from({ length: count }, (_, index) => [index * 2, index * 2]),
        ...(visibility === undefined ? {} : { visibility }),
      },
    },
  ]);
  store.select(selectOnly("b"));
  return store;
}

const toggle = (index: number): HTMLElement => screen.getByTestId(`vertex-toggle-${index}`);

describe("vertex toggles for a long lane", () => {
  it("lays the toggles out as one toolbar on a five-column grid", () => {
    render(mount(longLane(40)));
    const toolbar = screen.getByRole("toolbar", { name: "Vertex occlusion" });
    expect(toolbar.className).toContain("grid-cols-5");
    expect(within(toolbar).getAllByRole("button")).toHaveLength(40);
  });

  it("tells an unlabeled vertex from a visible one, in the count, the mark and the name", () => {
    render(mount(longLane(4, [2, 0, 1, 0])));
    expect(screen.getByTestId("vertex-occluded-count").textContent).toBe("1 occluded, 2 unlabeled");
    expect(toggle(1).getAttribute("data-visibility")).toBe("unlabeled");
    expect(toggle(0).getAttribute("data-visibility")).toBe("visible");
    expect(toggle(1).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Vertex 2 occluded (unlabeled)" })).toBe(toggle(1));
    expect(screen.getByRole("button", { name: "Vertex 1 occluded" })).toBe(toggle(0));
  });

  it("names no unlabeled count when there are none", () => {
    render(mount(longLane(3, [2, 1, 2])));
    expect(screen.getByTestId("vertex-occluded-count").textContent).toBe("1 occluded");
  });

  it("points the canvas at the vertex under the pointer, and at none once it leaves", async () => {
    const store = longLane(30);
    render(mount(store));
    await userEvent.hover(toggle(22));
    expect(store.getSnapshot().highlightedVertex).toEqual({ id: "b", index: 22 });
    await userEvent.unhover(toggle(22));
    expect(store.getSnapshot().highlightedVertex).toBeNull();
  });

  it("points the canvas at the focused vertex, also in the read-only mode, and clears on leaving", async () => {
    const store = longLane(6);
    const { unmount } = render(mount(store, { readOnly: true }));
    toggle(3).focus();
    expect(store.getSnapshot().highlightedVertex).toEqual({ id: "b", index: 3 });
    toggle(3).blur();
    expect(store.getSnapshot().highlightedVertex).toBeNull();

    toggle(2).focus();
    unmount();
    expect(store.getSnapshot().highlightedVertex).toBeNull();
  });

  it("is one tab stop, and the arrows, Home and End move between toggles on the grid", async () => {
    render(mount(longLane(12)));
    const stops = within(screen.getByRole("toolbar")).getAllByRole("button")
      .filter((one) => one.tabIndex === 0);
    expect(stops).toEqual([toggle(0)]);

    toggle(0).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(toggle(1));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(toggle(6));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(toggle(11));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(toggle(11));
    await userEvent.keyboard("{ArrowUp}{ArrowLeft}");
    expect(document.activeElement).toBe(toggle(5));
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(toggle(0));
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(toggle(0));
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(toggle(11));
    expect(toggle(11).tabIndex).toBe(0);
    expect(toggle(0).tabIndex).toBe(-1);

    await userEvent.tab();
    expect(screen.getByRole("toolbar").contains(document.activeElement)).toBe(false);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(toggle(11));
  });

  it("toggles the focused vertex with Enter as well as Space", async () => {
    const store = longLane(3);
    render(mount(store));
    toggle(2).focus();
    await userEvent.keyboard("{Enter}");
    expect(toggle(2).getAttribute("aria-pressed")).toBe("true");
  });

  it("undoes and redoes from a focused toggle", async () => {
    const store = longLane(3);
    render(mount(store));
    toggle(1).focus();
    await userEvent.keyboard(" ");
    expect(toggle(1).getAttribute("aria-pressed")).toBe("true");

    await userEvent.keyboard("{Control>}z{/Control}");
    expect(toggle(1).getAttribute("aria-pressed")).toBe("false");
    expect(store.canRedo).toBe(true);

    await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    expect(toggle(1).getAttribute("aria-pressed")).toBe("true");
  });

  it("does not undo or redo from a toggle in the read-only mode", async () => {
    const store = longLane(3);
    const { unmount } = render(mount(store));
    toggle(1).focus();
    await userEvent.keyboard(" ");
    unmount();

    render(mount(store, { readOnly: true }));
    toggle(1).focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(store.canUndo).toBe(true);
    expect(store.canRedo).toBe(false);

    store.undo();
    await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    expect(store.canRedo).toBe(true);
    expect(store.canUndo).toBe(false);
  });

  it("starts the next lane's toggles at the first, not at the previous roving index", async () => {
    const lane = (id: string): unknown => ({
      ...(annotation(id, "centerline", "polyline") as object),
      geometry: { type: "polyline", points: Array.from({ length: 8 }, (_, i) => [i * 2, i * 2]) },
    });
    const store = storeWith([lane("b"), lane("c")]);
    store.select(selectOnly("b"));
    render(mount(store));
    toggle(0).focus();
    await userEvent.keyboard("{End}");
    expect(toggle(7).tabIndex).toBe(0);

    act(() => store.select(selectOnly("c")));
    const stops = within(screen.getByRole("toolbar")).getAllByRole("button")
      .filter((one) => one.tabIndex === 0);
    expect(stops).toEqual([toggle(0)]);
  });

  it("leaves the history chords to the filter field", async () => {
    const store = longLane(3);
    render(mount(store));
    toggle(1).focus();
    await userEvent.keyboard(" ");

    await userEvent.click(screen.getByTestId("object-filter"));
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(store.canUndo).toBe(true);
    expect(toggle(1).getAttribute("aria-pressed")).toBe("true");
  });
});
