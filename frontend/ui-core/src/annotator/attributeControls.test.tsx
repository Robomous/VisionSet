/**
 * Per-object attribute editing, driven through the panel against a real store.
 *
 * The controls report a change; the panel turns it into `replaceAnnotationCommand`.
 * So what is worth asserting is the whole road — a press lands in the document as
 * one history entry — and that is only visible through the panel. The three pure
 * helpers the row and the controls share are pinned on their own first.
 */

import {
  AnnotatorStore,
  documentFromWire,
  selectOnly,
  type Annotation,
  type LabelClass,
} from "@visionset/annotator";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JSX } from "react";

import { AnnotatorPanel } from "./AnnotatorPanel";
import { attributeSummary, missingRequired, withAttribute } from "./attributes";
import { TooltipProvider } from "@robomous/ui-core";
import { stubResizeObserver } from "../testing/resizeObserver.js";

const CAR = {
  name: "car",
  geometries: ["bbox"],
  color: "#38bdf8",
  attributes: [
    { name: "colour", kind: "select", required: true, options: ["red", "blue", "green"], default: null },
    {
      name: "make",
      kind: "select",
      required: false,
      options: ["audi", "bmw", "fiat", "ford", "kia", "seat"],
      default: null,
    },
    { name: "doors", kind: "number", required: false, options: null, default: null },
    { name: "plate", kind: "string", required: false, options: null, default: null },
    { name: "occluded", kind: "boolean", required: false, options: null, default: false },
    { name: "parked", kind: "boolean", required: true, options: null, default: null },
  ],
};

const SCHEMA = {
  project_id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  classes: [
    CAR,
    { name: "tree", geometries: ["bbox"], color: null, attributes: [] },
  ],
};

function annotation(id: string, labelClass: string, attributes: Record<string, unknown> = {}): unknown {
  return {
    id,
    asset_id: "asset-1",
    label_class: labelClass,
    schema_version: 1,
    geometry: { type: "bbox", x: 10, y: 10, width: 20, height: 20 },
    attributes,
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: null,
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

/** A store holding one car, selected, and the panel showing it. */
function selectedCar(attributes: Record<string, unknown> = {}, readOnly = false): AnnotatorStore {
  const store = storeWith([annotation("a", "car", attributes), annotation("t", "car", {})]);
  store.select(selectOnly("a"));
  render(mount(store, { readOnly }));
  return store;
}

function attributes(store: AnnotatorStore, id = "a"): Readonly<Record<string, unknown>> {
  return store.document.annotations.get(id)?.attributes ?? {};
}

beforeEach(() => {
  stubResizeObserver();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the helpers the row and the controls share", () => {
  const declared = documentFromWire({
    asset: { id: "asset-1", width: 100, height: 100 },
    schema: SCHEMA,
    annotations: [],
  }).schema.classes[0] as LabelClass;
  const base = (attrs: Record<string, unknown>): Annotation =>
    ({ ...(annotation("a", "car") as object), attributes: attrs }) as unknown as Annotation;

  it("sets and removes one key, and hands back the same object for no change", () => {
    const one = base({ colour: "red" });
    expect(withAttribute(one, "colour", "red")).toBe(one);
    expect(withAttribute(one, "plate", null)).toBe(one);
    expect(withAttribute(one, "colour", "blue").attributes).toEqual({ colour: "blue" });
    expect(withAttribute(one, "colour", null).attributes).toEqual({});
    // Never mutated in place: undo holds the old one.
    expect(one.attributes).toEqual({ colour: "red" });
  });

  it("summarises values in declared order, a true boolean by its name", () => {
    expect(
      attributeSummary(base({ parked: true, plate: "AB-12", colour: "red", occluded: false, doors: 4 }), declared),
    ).toBe("red · 4 · AB-12 · parked");
    expect(attributeSummary(base({}), declared)).toBe("");
  });

  it("reads missing as the kernel does — no key — so false answers a required boolean", () => {
    expect(missingRequired(base({}), declared).map((one) => one.name)).toEqual(["colour", "parked"]);
    expect(missingRequired(base({ colour: "red", parked: false }), declared)).toEqual([]);
  });
});

describe("where the controls open", () => {
  it("opens beneath the selected row only", () => {
    selectedCar();
    expect(screen.getByTestId("object-attributes-0")).not.toBeNull();
    expect(screen.queryByTestId("object-attributes-1")).toBeNull();
    expect(screen.getByTestId("object-select-0").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("object-select-1").getAttribute("aria-expanded")).toBe("false");
  });

  it("opens nothing for a class that declares no attributes", () => {
    const store = storeWith([annotation("t", "tree")]);
    store.select(selectOnly("t"));
    render(mount(store));
    expect(screen.queryByTestId("object-attributes-0")).toBeNull();
    // Nothing to expand, so the row claims no expanded state at all.
    expect(screen.getByTestId("object-select-0").hasAttribute("aria-expanded")).toBe(false);
  });

  it("summarises the values on the row itself, without opening it", () => {
    const store = storeWith([annotation("a", "car", { colour: "red", parked: true, occluded: false })]);
    render(mount(store));
    expect(screen.getByTestId("object-summary-0").textContent).toBe("red · parked");
  });
});

describe("a select of four options or fewer", () => {
  it("is a radiogroup named for its attribute", () => {
    selectedCar();
    const group = screen.getByRole("radiogroup", { name: "colour" });
    expect(within(group).getAllByRole("radio").map((one) => one.textContent)).toEqual(["red", "blue", "green"]);
  });

  it("sets the value as one undoable edit", async () => {
    const store = selectedCar();
    await userEvent.click(screen.getByTestId("object-attributes-0-colour-blue"));

    // A loaded annotation carries what it was saved with — defaults are seeded on
    // draw, never on load — so the one key is the one written.
    expect(attributes(store)).toEqual({ colour: "blue" });
    expect(screen.getByTestId("object-attributes-0-colour-blue").getAttribute("aria-checked")).toBe("true");
    expect(store.getSnapshot().undoLabel).toBe("edit car");

    store.undo();
    expect(attributes(store)).toEqual({});
    // One press, one entry: nothing else is left to undo.
    expect(store.canUndo).toBe(false);
  });

  it("clears on a second press of the chosen option, removing the key", async () => {
    const store = selectedCar({ colour: "red" });
    await userEvent.click(screen.getByTestId("object-attributes-0-colour-red"));
    expect("colour" in attributes(store)).toBe(false);
  });
});

describe("a select of more than four options", () => {
  it("is a select with a placeholder, and choosing writes the value", async () => {
    const store = selectedCar();
    const trigger = screen.getByTestId("object-attributes-0-make");
    expect(trigger.textContent).toContain("Choose");

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("option", { name: "kia" }));
    expect(attributes(store)["make"]).toBe("kia");
  });

  it("clears from the button beside it, which exists only once there is a value", async () => {
    const store = selectedCar({ make: "fiat" });
    await userEvent.click(screen.getByTestId("object-attributes-0-make-clear"));
    expect("make" in attributes(store)).toBe(false);
    expect(screen.queryByTestId("object-attributes-0-make-clear")).toBeNull();
  });
});

describe("a boolean", () => {
  it("is a toggle chip that writes true, then false — never removing the key", async () => {
    const store = selectedCar({ occluded: false });
    const chip = screen.getByTestId("object-attributes-0-occluded");
    expect(chip.getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(chip);
    expect(attributes(store)["occluded"]).toBe(true);
    expect(chip.getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(chip);
    expect(attributes(store)["occluded"]).toBe(false);
  });
});

describe("a number", () => {
  it("commits on Enter, as a number", async () => {
    const store = selectedCar();
    await userEvent.type(screen.getByTestId("object-attributes-0-doors"), "4{Enter}");
    expect(attributes(store)["doors"]).toBe(4);
  });

  it("commits on blur", async () => {
    const store = selectedCar();
    await userEvent.type(screen.getByTestId("object-attributes-0-doors"), "2.5");
    expect("doors" in attributes(store)).toBe(false);
    await userEvent.tab();
    expect(attributes(store)["doors"]).toBe(2.5);
  });

  it("refuses what is not a number without writing or throwing, and shows the field invalid", async () => {
    const store = selectedCar({ doors: 3 });
    const field = screen.getByTestId("object-attributes-0-doors") as HTMLInputElement;
    await userEvent.clear(field);
    await userEvent.type(field, "four");
    expect(field.getAttribute("aria-invalid")).toBe("true");

    await userEvent.keyboard("{Enter}");
    expect(attributes(store)["doors"]).toBe(3);
    expect(field.value).toBe("3");
    expect(store.canUndo).toBe(false);
  });

  it("reverts on Escape", async () => {
    const store = selectedCar({ doors: 3 });
    const field = screen.getByTestId("object-attributes-0-doors") as HTMLInputElement;
    await userEvent.clear(field);
    await userEvent.type(field, "9{Escape}");
    expect(field.value).toBe("3");
    await userEvent.tab();
    expect(attributes(store)["doors"]).toBe(3);
    expect(store.canUndo).toBe(false);
  });

  it("clears when emptied, removing the key", async () => {
    const store = selectedCar({ doors: 3 });
    await userEvent.clear(screen.getByTestId("object-attributes-0-doors"));
    await userEvent.keyboard("{Enter}");
    expect("doors" in attributes(store)).toBe(false);
  });
});

describe("a string", () => {
  it("commits on blur, once, as one undo step", async () => {
    const store = selectedCar();
    await userEvent.type(screen.getByTestId("object-attributes-0-plate"), "AB-12");
    // Not per keystroke: five characters are not five history entries.
    expect(store.canUndo).toBe(false);
    await userEvent.tab();
    expect(attributes(store)["plate"]).toBe("AB-12");

    store.undo();
    expect("plate" in attributes(store)).toBe(false);
    expect(store.canUndo).toBe(false);
  });

  it("reverts on Escape and writes nothing", async () => {
    const store = selectedCar({ plate: "X" });
    const field = screen.getByTestId("object-attributes-0-plate") as HTMLInputElement;
    await userEvent.type(field, "YZ{Escape}");
    expect(field.value).toBe("X");
    await userEvent.tab();
    expect(attributes(store)["plate"]).toBe("X");
  });

  it("types a digit as a digit — no class hotkey reaches through the field", async () => {
    const store = selectedCar();
    await userEvent.type(screen.getByTestId("object-attributes-0-plate"), "2{Enter}");
    expect(attributes(store)["plate"]).toBe("2");
    expect(store.document.annotations.get("a")?.label_class).toBe("car");
  });

  it("keeps a draft the selection closed before it could blur", async () => {
    // The canvas selects on pointer-down, which can unmount this row's controls
    // before the field sees a blur. A typed value is not a thing to lose silently.
    const store = selectedCar();
    await userEvent.type(screen.getByTestId("object-attributes-0-plate"), "KEEP");
    store.select(selectOnly("t"));
    await screen.findByTestId("object-attributes-1");
    expect(attributes(store)["plate"]).toBe("KEEP");
  });
});

describe("required is information, never a gate", () => {
  it("marks the row and each empty required attribute, and the mark goes once answered", async () => {
    const store = selectedCar();
    expect(screen.getByTestId("object-missing-0").getAttribute("aria-label")).toBe("Needs a value");
    expect(screen.getByTestId("object-attributes-0-colour-missing")).not.toBeNull();
    expect(screen.getByTestId("object-attributes-0-parked-missing")).not.toBeNull();
    // Not required, or not empty: no mark.
    expect(screen.queryByTestId("object-attributes-0-make-missing")).toBeNull();
    expect(screen.queryByTestId("object-attributes-0-occluded-missing")).toBeNull();

    await userEvent.click(screen.getByTestId("object-attributes-0-colour-red"));
    await userEvent.click(screen.getByTestId("object-attributes-0-parked"));
    expect(screen.queryByTestId("object-attributes-0-colour-missing")).toBeNull();
    expect(screen.queryByTestId("object-missing-0")).toBeNull();
    expect(attributes(store)).toMatchObject({ colour: "red", parked: true });
  });

  it("says so in a tooltip", async () => {
    selectedCar();
    await userEvent.hover(screen.getByTestId("object-missing-0"));
    expect((await screen.findAllByText("Needs a value")).length).toBeGreaterThan(0);
  });

  it("disables nothing and still lets a required value be cleared", async () => {
    const store = selectedCar({ colour: "red" });
    expect(screen.getByTestId("object-delete-0")).toHaveProperty("disabled", false);
    await userEvent.click(screen.getByTestId("object-attributes-0-colour-red"));
    expect("colour" in attributes(store)).toBe(false);
    expect(screen.getByTestId("object-missing-0")).not.toBeNull();
  });
});

describe("when the document cannot be written", () => {
  it("shows the values, disabled, and nothing reaches the store", async () => {
    const store = selectedCar({ colour: "red", make: "kia", doors: 3, plate: "X", occluded: true }, true);

    for (const radio of within(screen.getByRole("radiogroup", { name: "colour" })).getAllByRole("radio")) {
      expect(radio).toHaveProperty("disabled", true);
    }
    expect(screen.getByTestId("object-attributes-0-make")).toHaveProperty("disabled", true);
    expect(screen.queryByTestId("object-attributes-0-make-clear")).toBeNull();
    expect(screen.getByTestId("object-attributes-0-doors")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("object-attributes-0-plate")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("object-attributes-0-occluded")).toHaveProperty("disabled", true);

    await userEvent.click(screen.getByTestId("object-attributes-0-colour-blue"));
    await userEvent.click(screen.getByTestId("object-attributes-0-occluded"));
    expect(attributes(store)).toEqual({ colour: "red", make: "kia", doors: 3, plate: "X", occluded: true });
    expect(store.getSnapshot().undoLabel).toBeNull();
  });
});
