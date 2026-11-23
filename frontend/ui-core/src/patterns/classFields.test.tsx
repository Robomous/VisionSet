/**
 * The class form's fields, below the screens that host them.
 *
 * `ClassFields` is one component in two layouts: the stacked form the annotator's
 * add-a-class dialog uses, and the `inspector` layout the Classes page's class
 * sheet hosts — a property grid of Name, Colour, Shortcut, Drawn as and In use,
 * with the attributes as groups that open onto the same grid. What these tests
 * hold is what the sheet's controls *write* — the colour a palette tile
 * declares, the choices a chips field commits, the default that follows the
 * kind, the Switch that flips `required` — read off the value the component
 * reports upward, never off the markup that happens to carry it.
 *
 * The harness owns the value the way a caller does (a working copy in state), so
 * a control that only works for one keystroke fails here.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState, type JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AttributeBody, LabelClassBody } from "../screens/queries";
import { stubResizeObserver } from "../testing/resizeObserver.js";
import { ClassFields } from "./ClassFields";
import { CLASS_PALETTE, hexOf } from "./classFieldsRules";

// A Radix Checkbox or Switch measures itself through `ResizeObserver` once it
// sits inside a `<form>`, which the sheet's body does and jsdom has no such thing.
beforeEach(() => {
  stubResizeObserver();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function attribute(overrides: Partial<AttributeBody> = {}): AttributeBody {
  return { name: "state", kind: "select", required: false, options: [], default: null, ...overrides };
}

function declaredWith(overrides: Partial<LabelClassBody> = {}): LabelClassBody {
  return { name: "vehicle", geometries: ["bbox"], color: null, attributes: [], ...overrides };
}

interface SheetProps {
  readonly disabled?: boolean;
  readonly previous?: LabelClassBody | null;
  readonly nameInvalid?: boolean;
}

/** The colour a class with no declared one is drawn in, standing in for the derived hue. */
const DERIVED = "#0891B2";

/** Mounts the inspector over one working copy, and reports each value the form writes. */
function mountSheet(
  initial: LabelClassBody,
  props: SheetProps = {},
): { latest: () => LabelClassBody; update: (next: SheetProps) => void } {
  let latest = initial;
  function Host(host: SheetProps): JSX.Element {
    const [declared, setDeclared] = useState(initial);
    return (
      <form>
        <ClassFields
          layout="inspector"
          declared={declared}
          slot="0"
          // As the sheet does: the declared colour, else a stand-in for the derived one.
          swatch={declared.color ?? DERIVED}
          hotkey={null}
          disabled={host.disabled ?? false}
          previous={host.previous ?? null}
          nameInvalid={host.nameInvalid ?? false}
          nameDescribedBy="status"
          shortcut={
            <button type="button" id="class-position-0" data-testid="class-position-0">
              1
            </button>
          }
          note={<span data-testid="note">Not used yet.</span>}
          onChange={(next) => {
            latest = next;
            setDeclared(next);
          }}
        />
      </form>
    );
  }
  const view = render(<Host {...props} />);
  return { latest: () => latest, update: (next) => view.rerender(<Host {...next} />) };
}

/** The attribute `index` of the latest value the form wrote. */
function attributeOf(form: { latest: () => LabelClassBody }, index = 0): AttributeBody {
  return form.latest().attributes![index]!;
}

/** Opens the colour popover: the palette and the custom picker live behind the field. */
async function openColour(): Promise<void> {
  await userEvent.click(screen.getByTestId("class-color-trigger-0"));
}

/** Opens attribute `index`'s group onto its own rows; every group starts closed. */
async function openGroup(index = 0): Promise<void> {
  await userEvent.click(screen.getByTestId(`attr-toggle-0-${index}`));
}

async function chooseKind(label: string, index = 0): Promise<void> {
  await userEvent.click(screen.getByTestId(`attr-kind-0-${index}`));
  await userEvent.click(await screen.findByRole("option", { name: label }));
}

describe("the inspector's colour", () => {
  it("shows the colour in force as a field, and keeps the palette and the picker behind it", async () => {
    mountSheet(declaredWith());

    const trigger = screen.getByTestId("class-color-trigger-0");
    // Labelled by the row's "Colour", and describing what it holds.
    expect(screen.getByRole("button", { name: "Colour" })).toBe(trigger);
    expect(trigger.getAttribute("aria-description")).toBe("From the name");
    // The hex as the field holds it; capitals are the stylesheet's.
    expect(trigger.textContent).toBe(`${hexOf(DERIVED)}from the name`);
    expect(screen.queryByTestId("class-palette-0")).toBeNull();
    expect(screen.queryByTestId("class-color-hex-0")).toBeNull();

    await userEvent.click(trigger);

    expect(screen.getByTestId("class-palette-0")).toBeTruthy();
    expect(screen.getByTestId("class-color-hex-0")).toBeTruthy();
    expect(screen.getByTestId("class-color-field-0").getAttribute("role")).toBe("slider");
    expect(screen.getByTestId("class-color-hue-0").getAttribute("role")).toBe("slider");
    // The old native picker is gone from the page, and nothing is declared to put back.
    expect(screen.queryByTestId("class-color-0")).toBeNull();
    expect(screen.queryByTestId("clear-color-0")).toBeNull();
    expect(screen.getByText("Derived from the name")).toBeTruthy();
  });

  it("offers the twelve palette colours as tiles, none chosen for a class with no colour", async () => {
    mountSheet(declaredWith());
    await openColour();

    const tiles = CLASS_PALETTE.map((color) => screen.getByTestId(`class-palette-0-${color.slice(1)}`));
    expect(tiles).toHaveLength(12);
    expect(within(screen.getByTestId("class-palette-0")).getAllByRole("radio")).toHaveLength(12);
    expect(tiles.every((tile) => tile.getAttribute("data-state") === "off")).toBe(true);
  });

  it("declares a palette colour, marks it chosen and says it on the field", async () => {
    const form = mountSheet(declaredWith());
    await openColour();

    await userEvent.click(screen.getByTestId("class-palette-0-7C3AED"));

    expect(form.latest().color).toBe("#7C3AED");
    expect(screen.getByTestId("class-palette-0-7C3AED").getAttribute("data-state")).toBe("on");
    expect(screen.getByTestId("class-palette-0-2563EB").getAttribute("data-state")).toBe("off");
    const trigger = screen.getByTestId("class-color-trigger-0");
    expect(trigger.getAttribute("aria-description")).toBe("#7C3AED");
    // A palette colour is not "custom", and it is not "from the name" any more.
    expect(trigger.textContent).toBe("#7c3aed");
  });

  it("keeps a palette colour declared when its tile is pressed again", async () => {
    const form = mountSheet(declaredWith({ color: "#2563EB" }));
    await openColour();

    await userEvent.click(screen.getByTestId("class-palette-0-2563EB"));

    // Pressing the chosen tile is not a way to un-declare: that is the reset's job.
    expect(form.latest().color).toBe("#2563EB");
    expect(screen.getByTestId("class-palette-0-2563EB").getAttribute("data-state")).toBe("on");
  });

  it("reads a palette colour whatever its case", async () => {
    mountSheet(declaredWith({ color: "#db2777" }));
    await openColour();

    expect(screen.getByTestId("class-palette-0-DB2777").getAttribute("data-state")).toBe("on");
  });

  it("chooses no palette tile for a custom colour, and calls it custom on the field", async () => {
    mountSheet(declaredWith({ color: "#123456" }));

    const trigger = screen.getByTestId("class-color-trigger-0");
    expect(trigger.getAttribute("aria-description")).toBe("#123456");
    expect(trigger.textContent).toBe("#123456custom");
    await openColour();
    const chosen = within(screen.getByTestId("class-palette-0"))
      .getAllByRole("radio")
      .filter((tile) => tile.getAttribute("data-state") === "on");
    expect(chosen).toHaveLength(0);
  });

  it("goes back to the name's colour with \"Use the name’s colour\", which exists only while one is declared", async () => {
    const form = mountSheet(declaredWith({ color: "#E5484D" }));

    await openColour();
    const clear = screen.getByTestId("clear-color-0");
    expect(clear.textContent).toBe("Use the name’s colour");

    await userEvent.click(clear);

    expect(form.latest().color).toBeNull();
    expect(screen.queryByTestId("clear-color-0")).toBeNull();
    expect(screen.getByTestId("class-color-trigger-0").getAttribute("aria-description")).toBe("From the name");
  });

  it("shows the derived colour in the open picker once \"Use the name’s colour\" clears a declared one", async () => {
    mountSheet(declaredWith({ color: "#E5484D" }));

    await openColour();
    const hex = screen.getByTestId("class-color-hex-0") as HTMLInputElement;
    expect(hex.value).toBe("E5484D");

    await userEvent.click(screen.getByTestId("clear-color-0"));

    // The popover is still open, and says the colour now in force.
    expect(screen.getByTestId("class-color-hex-0")).toBe(hex);
    expect(hex.value).toBe(hexOf(DERIVED).slice(1).toUpperCase());
  });

  it("declares what the saturation field chooses, from the keyboard", async () => {
    const form = mountSheet(declaredWith({ color: "#FF0000" }));
    await openColour();
    const field = screen.getByTestId("class-color-field-0");
    expect(field.getAttribute("aria-valuenow")).toBe("100");

    // Left takes saturation down by one, Shift takes it by ten.
    fireEvent.keyDown(field, { key: "ArrowLeft", shiftKey: true });
    expect(field.getAttribute("aria-valuenow")).toBe("90");
    expect(form.latest().color).toMatch(/^#[0-9A-F]{6}$/);
    expect(form.latest().color).not.toBe("#FF0000");

    fireEvent.keyDown(field, { key: "ArrowRight" });
    expect(field.getAttribute("aria-valuenow")).toBe("91");
  });

  it("declares what the hue strip chooses, from the keyboard", async () => {
    const form = mountSheet(declaredWith({ color: "#FF0000" }));
    await openColour();
    const hue = screen.getByTestId("class-color-hue-0");
    expect(hue.getAttribute("aria-valuenow")).toBe("0");

    fireEvent.keyDown(hue, { key: "ArrowRight", shiftKey: true });

    expect(hue.getAttribute("aria-valuenow")).toBe("10");
    expect(form.latest().color).toMatch(/^#FF[0-9A-F]{2}00$/);
    expect(form.latest().color).not.toBe("#FF0000");
    // The hue is a strip, not a field: it never goes below zero.
    fireEvent.keyDown(hue, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(hue, { key: "ArrowLeft", shiftKey: true });
    expect(hue.getAttribute("aria-valuenow")).toBe("0");
  });
});

describe("the inspector's hex field", () => {
  it("shows the colour in force, without its #", async () => {
    mountSheet(declaredWith({ color: "#3e8ef7" }));
    await openColour();

    expect((screen.getByTestId("class-color-hex-0") as HTMLInputElement).value).toBe("3E8EF7");
  });

  it("writes nothing until six digits are typed, then declares that colour", async () => {
    const form = mountSheet(declaredWith());
    await openColour();
    const hex = screen.getByTestId("class-color-hex-0") as HTMLInputElement;

    await userEvent.clear(hex);
    await userEvent.type(hex, "2c6");
    // A half-typed colour never reaches the class.
    expect(form.latest().color ?? null).toBeNull();
    expect(hex.value).toBe("2C6");

    await userEvent.type(hex, "8f6");
    expect(form.latest().color).toBe("#2C68F6");
    expect(screen.getByTestId("class-color-trigger-0").getAttribute("aria-description")).toBe("#2C68F6");
  });

  it("takes a pasted colour with its #, and drops what is not hex", async () => {
    const form = mountSheet(declaredWith());
    await openColour();
    const hex = screen.getByTestId("class-color-hex-0");

    await userEvent.clear(hex);
    await userEvent.click(hex);
    await userEvent.paste("#ff00aa");

    expect(form.latest().color).toBe("#FF00AA");
  });

  it("puts the colour in force back when left half-typed", async () => {
    const form = mountSheet(declaredWith({ color: "#3E8EF7" }));
    await openColour();
    const hex = screen.getByTestId("class-color-hex-0") as HTMLInputElement;

    await userEvent.clear(hex);
    await userEvent.type(hex, "12{Enter}");

    expect(hex.value).toBe("3E8EF7");
    expect(form.latest().color).toBe("#3E8EF7");
  });

  it("marks the palette tile a typed colour matches, and none once it matches none", async () => {
    mountSheet(declaredWith());
    await openColour();
    const hex = screen.getByTestId("class-color-hex-0");

    await userEvent.clear(hex);
    await userEvent.type(hex, "7c3aed");
    expect(screen.getByTestId("class-palette-0-7C3AED").getAttribute("data-state")).toBe("on");

    await userEvent.clear(hex);
    await userEvent.type(hex, "123456");
    const chosen = CLASS_PALETTE.filter((color) => screen.getByTestId(`class-palette-0-${color.slice(1)}`).getAttribute("data-state") === "on");
    expect(chosen).toHaveLength(0);
  });
});

describe("the inspector's name, shortcut and shapes", () => {
  it("writes the name as it is typed, into a field labelled Name", async () => {
    const form = mountSheet(declaredWith({ name: "" }));

    const name = screen.getByLabelText("Name");
    expect(name).toBe(screen.getByTestId("class-name-0"));
    await userEvent.type(name, "bus");

    expect(form.latest().name).toBe("bus");
  });

  it("marks the name invalid only when the caller says so, and points at what says why", () => {
    const { unmount } = render(
      <ClassFields layout="inspector" declared={declaredWith()} slot="0" swatch="#888888" hotkey={null} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId("class-name-0").hasAttribute("aria-invalid")).toBe(false);
    expect(screen.getByTestId("class-name-0").hasAttribute("aria-describedby")).toBe(false);
    unmount();

    render(
      <ClassFields layout="inspector" declared={declaredWith()} slot="0" swatch="#888888" hotkey={null} onChange={vi.fn()} nameInvalid nameDescribedBy="status" />,
    );
    expect(screen.getByTestId("class-name-0").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByTestId("class-name-0").getAttribute("aria-describedby")).toBe("status");
  });

  it("gives the caller's shortcut its own labelled row, and none when there is no shortcut", () => {
    mountSheet(declaredWith());
    expect(screen.getByLabelText("Shortcut")).toBe(screen.getByTestId("class-position-0"));
    const rows = ["Name", "Colour", "Shortcut", "Drawn as"].map((label) => screen.getByText(label));
    for (let at = 1; at < rows.length; at += 1) {
      expect(rows[at - 1]!.compareDocumentPosition(rows[at]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("has no Shortcut row without a shortcut", () => {
    render(<ClassFields layout="inspector" declared={declaredWith()} slot="0" swatch="#888888" hotkey={null} onChange={vi.fn()} />);

    expect(screen.queryByText("Shortcut")).toBeNull();
  });

  it("offers the four shapes an annotation can carry, as icon buttons named for them", () => {
    mountSheet(declaredWith());

    const group = screen.getByTestId("class-geometry-0");
    const items = within(group).getAllByRole("button");
    expect(items.map((item) => item.getAttribute("data-testid"))).toEqual([
      "class-geometry-0-bbox",
      "class-geometry-0-polygon",
      "class-geometry-0-polyline",
      "class-geometry-0-classification_tag",
    ]);
    // Icon only: the word is the accessible name, never visible text.
    expect(items.map((item) => item.getAttribute("aria-label"))).toEqual(["Box", "Polygon", "Polyline", "Tag"]);
    expect(items.map((item) => item.textContent)).toEqual(["", "", "", ""]);
    expect(items.map((item) => item.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
    expect(screen.queryByTestId(/^geometry-category-/)).toBeNull();
  });

  it("names the chosen shapes beside the group, for the eye and not for a screen reader", async () => {
    mountSheet(declaredWith({ geometries: ["polygon"] }));

    const names = screen.getByText("Polygon");
    expect(names.getAttribute("aria-hidden")).toBe("true");

    await userEvent.click(screen.getByTestId("class-geometry-0-bbox"));
    // In the order the shapes are offered, whatever the order they were chosen in.
    expect(screen.getByText("Box, Polygon").getAttribute("aria-hidden")).toBe("true");
  });

  it("adds a shape to the class rather than replacing the one it had", async () => {
    const form = mountSheet(declaredWith());

    await userEvent.click(screen.getByTestId("class-geometry-0-polygon"));

    expect(form.latest().geometries).toEqual(["bbox", "polygon"]);
    expect(screen.getByTestId("class-geometry-0-polygon").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("class-geometry-0-bbox").getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps shapes in the order they were first chosen", async () => {
    const form = mountSheet(declaredWith({ geometries: ["polygon"] }));

    await userEvent.click(screen.getByTestId("class-geometry-0-bbox"));

    expect(form.latest().geometries).toEqual(["polygon", "bbox"]);
  });

  it("refuses to unpress the last shape, and says why rather than greying out", async () => {
    const form = mountSheet(declaredWith({ geometries: ["bbox", "polygon"] }));

    const box = screen.getByTestId("class-geometry-0-bbox");
    const polygon = screen.getByTestId("class-geometry-0-polygon");
    expect(box.hasAttribute("aria-disabled")).toBe(false);

    await userEvent.click(box);
    expect(form.latest().geometries).toEqual(["polygon"]);
    expect(box.getAttribute("aria-pressed")).toBe("false");
    expect(polygon.getAttribute("aria-disabled")).toBe("true");
    expect(polygon.getAttribute("title")).toBe("A class needs at least one shape");
    expect(polygon.hasAttribute("disabled")).toBe(false);

    await userEvent.click(polygon);
    expect(form.latest().geometries).toEqual(["polygon"]);
    expect(polygon.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders the caller's note as the In use row, after the shapes and before the attributes", () => {
    mountSheet(declaredWith());

    const note = screen.getByTestId("note");
    expect(screen.getByText("In use")).toBeTruthy();
    const shapes = screen.getByTestId("class-geometry-0");
    const add = screen.getByTestId("add-attribute-0");
    expect(shapes.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("has no In use row without a note", () => {
    render(<ClassFields layout="inspector" declared={declaredWith()} slot="0" swatch="#888888" hotkey={null} onChange={vi.fn()} />);

    expect(screen.queryByText("In use")).toBeNull();
  });
});

describe("the inspector's attribute groups", () => {
  it("shows each attribute as a closed group that says its kind and whether it is required", () => {
    mountSheet(
      declaredWith({
        attributes: [
          attribute({ name: "occluded", kind: "boolean", options: null, required: true }),
          attribute({ name: "state", options: ["open", "shut"], default: "shut" }),
          attribute({ name: "label", kind: "string", options: null }),
        ],
      }),
    );

    expect(screen.getByTestId("attr-toggle-0-0").getAttribute("aria-label")).toBe("occluded, Yes / no · required");
    expect(screen.getByTestId("attr-toggle-0-1").getAttribute("aria-label")).toBe("state, Choice of 2 · optional");
    expect(screen.getByTestId("attr-toggle-0-2").getAttribute("aria-label")).toBe("label, Text · optional");
    // Every group starts closed: the fields are not on the page until one is opened.
    for (const at of [0, 1, 2]) {
      expect(screen.getByTestId(`attr-toggle-0-${at}`).getAttribute("aria-expanded")).toBe("false");
      expect(screen.getByTestId(`attr-row-0-${at}`)).toBeTruthy();
    }
    expect(screen.queryByTestId("attr-name-0-0")).toBeNull();
    expect(screen.queryByTestId("attr-required-0-0")).toBeNull();
    // The count is said beside the heading.
    expect(screen.getByRole("heading", { name: /^Attributes/ }).textContent).toBe("Attributes3");
  });

  it("says there are none, and offers only the way to add one", () => {
    mountSheet(declaredWith());

    expect(screen.getByText(/None — an annotation carries only its class\./)).toBeTruthy();
    expect(screen.queryByTestId("attr-row-0-0")).toBeNull();
    expect(screen.getByTestId("add-attribute-0")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Attributes" }).textContent).toBe("Attributes");
  });

  it("opens a group onto its own rows, and puts it away again", async () => {
    mountSheet(declaredWith({ attributes: [attribute({ name: "occluded", kind: "boolean", options: null })] }));
    const toggle = screen.getByTestId("attr-toggle-0-0");

    await userEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const row = screen.getByTestId("attr-row-0-0");
    expect(within(row).getByTestId("attr-name-0-0")).toHaveProperty("value", "occluded");
    expect(within(row).getByTestId("attr-kind-0-0").textContent).toBe("Yes / no");
    expect(within(row).getByTestId("attr-default-0-0")).toBeTruthy();
    expect(within(row).getByTestId("attr-required-0-0")).toBeTruthy();
    expect(within(row).getByTestId("remove-attribute-0-0").textContent).toBe("Remove attribute");

    await userEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("attr-name-0-0")).toBeNull();
  });

  it("opens one group at a time", async () => {
    mountSheet(declaredWith({ attributes: [attribute({ name: "a" }), attribute({ name: "b" })] }));

    await openGroup(0);
    expect(screen.getByTestId("attr-name-0-0")).toBeTruthy();
    expect(screen.queryByTestId("attr-name-0-1")).toBeNull();

    await openGroup(1);
    expect(screen.queryByTestId("attr-name-0-0")).toBeNull();
    expect(screen.getByTestId("attr-name-0-1")).toBeTruthy();
    expect(screen.getByTestId("attr-toggle-0-0").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("attr-toggle-0-1").getAttribute("aria-expanded")).toBe("true");
  });

  it("labels the nested name row Name, like the class's own", async () => {
    mountSheet(declaredWith({ attributes: [attribute({ name: "a", kind: "string", options: null })] }));
    expect(screen.getAllByLabelText("Name")).toHaveLength(1);

    await openGroup();

    const names = screen.getAllByLabelText("Name");
    expect(names).toHaveLength(2);
    expect(names[0]).toBe(screen.getByTestId("class-name-0"));
    expect(names[1]).toBe(screen.getByTestId("attr-name-0-0"));
    // And the other rows are named by their words too, not by a testid.
    expect(screen.getByLabelText("Kind")).toBe(screen.getByTestId("attr-kind-0-0"));
    expect(screen.getByLabelText("Required")).toBe(screen.getByTestId("attr-required-0-0"));
  });

  it("adds a text attribute with no default, opened, with its name in focus", async () => {
    const form = mountSheet(declaredWith());

    await userEvent.click(screen.getByTestId("add-attribute-0"));

    expect(form.latest().attributes).toEqual([{ name: "", kind: "string", required: false, default: null }]);
    expect(screen.getByTestId("attr-toggle-0-0").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("attr-kind-0-0").textContent).toBe("Text");
    expect(document.activeElement).toBe(screen.getByTestId("attr-name-0-0"));
    // Unnamed, so the closed row would say which line it is by its place.
    expect(screen.getByTestId("attr-toggle-0-0").getAttribute("aria-label")).toBe("attribute 1, Text · optional");
  });

  it("keeps Add attribute where it was, in the heading, as groups are added under it", async () => {
    mountSheet(declaredWith());

    const add = screen.getByTestId("add-attribute-0");
    const heading = screen.getByRole("heading", { name: "Attributes" });
    // In the section's heading row — before the list, never after it.
    expect(add.parentElement).toBe(heading.parentElement);

    await userEvent.click(add);
    await userEvent.click(screen.getByTestId("add-attribute-0"));
    await userEvent.click(screen.getByTestId("add-attribute-0"));

    // The same element throughout: nothing remounted it, so it did not move.
    expect(screen.getByTestId("add-attribute-0")).toBe(add);
    expect(add.parentElement).toBe(heading.parentElement);
    for (const at of [0, 1, 2]) {
      expect(add.compareDocumentPosition(screen.getByTestId(`attr-row-0-${at}`)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // Each press lands the next group, opens it, and takes focus into its name —
    // closing the one before.
    expect(screen.getByTestId("attr-toggle-0-2").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("attr-toggle-0-1").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(screen.getByTestId("attr-name-0-2"));
    expect(screen.getByRole("heading", { name: /^Attributes/ }).textContent).toBe("Attributes3");
  });

  it("moves focus into a new group's name, and not into one opened by hand", async () => {
    mountSheet(declaredWith({ attributes: [attribute({ name: "a", kind: "string", options: null })] }));

    await openGroup(0);
    expect(document.activeElement).not.toBe(screen.getByTestId("attr-name-0-0"));

    await userEvent.click(screen.getByTestId("add-attribute-0"));
    expect(document.activeElement).toBe(screen.getByTestId("attr-name-0-1"));

    // Typing keeps focus where the person put it.
    await userEvent.type(screen.getByTestId("attr-name-0-1"), "b");
    expect(document.activeElement).toBe(screen.getByTestId("attr-name-0-1"));
  });

  it("keeps the same rows when a kind changes, and swaps Default for Choices in place", async () => {
    mountSheet(declaredWith({ attributes: [attribute({ name: "a", kind: "string", options: null }), attribute({ name: "b", kind: "string", options: null })] }));
    const rows = [screen.getByTestId("attr-row-0-0"), screen.getByTestId("attr-row-0-1")];
    await openGroup(0);
    expect(within(rows[0]!).getByTestId("attr-default-0-0")).toBeTruthy();

    await chooseKind("Choice");

    expect(screen.getByTestId("attr-row-0-0")).toBe(rows[0]);
    expect(screen.getByTestId("attr-row-0-1")).toBe(rows[1]);
    expect(within(rows[0]!).getByTestId("attr-options-0-0")).toBeTruthy();
    expect(within(rows[0]!).queryByTestId("attr-default-0-0")).toBeNull();
    expect(within(rows[0]!).getByText("Choices")).toBeTruthy();
    expect(within(rows[0]!).queryByText("Default")).toBeNull();
  });

  it("says in the closed row what the attribute now asks, as its kind and required change", async () => {
    mountSheet(declaredWith({ attributes: [attribute({ name: "a", kind: "string", options: null })] }));
    const toggle = screen.getByTestId("attr-toggle-0-0");
    expect(toggle.getAttribute("aria-label")).toBe("a, Text · optional");
    await openGroup();

    await userEvent.click(screen.getByTestId("attr-required-0-0"));
    expect(toggle.getAttribute("aria-label")).toBe("a, Text · required");
    expect(within(toggle).getByText("Text · required")).toBeTruthy();

    await chooseKind("Yes / no");
    expect(toggle.getAttribute("aria-label")).toBe("a, Yes / no · required");

    await chooseKind("Choice");
    // A choice with none yet is just a choice; with some it counts them.
    expect(toggle.getAttribute("aria-label")).toBe("a, Choice · required");
    await userEvent.type(screen.getByTestId("attr-options-0-0"), "red,blue,");
    expect(toggle.getAttribute("aria-label")).toBe("a, Choice of 2 · required");

    await userEvent.click(screen.getByTestId("attr-required-0-0"));
    expect(toggle.getAttribute("aria-label")).toBe("a, Choice of 2 · optional");
  });

  it("follows the name in the closed row as it is typed", async () => {
    mountSheet(declaredWith({ attributes: [attribute({ name: "a", kind: "string", options: null })] }));
    await openGroup();

    await userEvent.type(screen.getByTestId("attr-name-0-0"), "bc");

    expect(screen.getByTestId("attr-toggle-0-0").getAttribute("aria-label")).toBe("abc, Text · optional");
  });

  it("edits the name of the group it is typed in", async () => {
    const form = mountSheet(declaredWith({ attributes: [attribute({ name: "a", kind: "string", options: null })] }));
    await openGroup();

    await userEvent.type(screen.getByTestId("attr-name-0-0"), "bc");

    expect(attributeOf(form).name).toBe("abc");
  });

  it("flips `required` with the switch", async () => {
    const form = mountSheet(declaredWith({ attributes: [attribute({ name: "occluded", kind: "boolean", options: null })] }));
    await openGroup();

    const toggle = screen.getByRole("switch", { name: "Required" });
    expect(toggle).toBe(screen.getByTestId("attr-required-0-0"));
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await userEvent.click(toggle);
    expect(attributeOf(form).required).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("data-state")).toBe("checked");

    await userEvent.click(toggle);
    expect(attributeOf(form).required).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("drops the default and the options when the kind changes", async () => {
    const form = mountSheet(declaredWith({ attributes: [attribute({ options: ["red", "blue"], default: "red", required: true })] }));
    await openGroup();

    await chooseKind("Number");

    expect(attributeOf(form)).toMatchObject({ kind: "number", default: null, options: null, required: true });
    expect(screen.queryByTestId("attr-options-0-0")).toBeNull();
    expect(screen.getByTestId("attr-default-0-0").getAttribute("type")).toBe("number");
  });

  it("starts a choice with no options when the kind changes to it", async () => {
    const form = mountSheet(declaredWith({ attributes: [attribute({ kind: "string", options: null, default: "x" })] }));
    await openGroup();

    await chooseKind("Choice");

    expect(attributeOf(form)).toMatchObject({ kind: "select", default: null, options: [] });
    expect(screen.getByTestId("attr-options-0-0")).toBeTruthy();
  });

  it("names every kind in words, and writes the wire value", async () => {
    const form = mountSheet(declaredWith({ attributes: [attribute({ kind: "string", options: null })] }));
    await openGroup();

    await userEvent.click(screen.getByTestId("attr-kind-0-0"));
    const labels = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(labels).toEqual(["Text", "Number", "Yes / no", "Choice"]);

    await userEvent.click(screen.getByRole("option", { name: "Yes / no" }));
    expect(attributeOf(form).kind).toBe("boolean");
  });

  it("removes an attribute from its open group", async () => {
    const form = mountSheet(declaredWith({ attributes: [attribute({ name: "a" }), attribute({ name: "b" })] }));
    await openGroup(0);

    await userEvent.click(screen.getByRole("button", { name: "Remove a" }));

    expect(form.latest().attributes!.map((one) => one.name)).toEqual(["b"]);
    expect(screen.queryByTestId("attr-row-0-1")).toBeNull();
    // Nothing is left open, and the one that remains is `b`, closed.
    expect(screen.queryByTestId("attr-name-0-0")).toBeNull();
    expect(screen.getByTestId("attr-toggle-0-0").getAttribute("aria-label")).toBe("b, Choice · optional");
  });

  it("marks an attribute the active version does not have as new, in its closed row", () => {
    const previous = declaredWith({ attributes: [attribute({ name: "state", options: ["open"] })] });
    mountSheet(
      declaredWith({
        attributes: [
          attribute({ name: "state", options: ["open", "shut"] }),
          attribute({ name: "angle", kind: "number", options: null }),
        ],
      }),
      { previous },
    );

    expect(within(screen.getByTestId("attr-toggle-0-0")).queryByText("new")).toBeNull();
    expect(within(screen.getByTestId("attr-toggle-0-1")).getByText("new")).toBeTruthy();
  });

  it("marks a choice the active version does not offer, once its group is open", async () => {
    const previous = declaredWith({ attributes: [attribute({ name: "state", options: ["open"] })] });
    mountSheet(declaredWith({ attributes: [attribute({ name: "state", options: ["open", "shut"] })] }), { previous });
    await openGroup();

    const row = screen.getByTestId("attr-row-0-0");
    // Said to a screen reader too, beside the choice rather than in its name.
    expect(within(row).getByRole("button", { name: /^shut/ }).textContent).toContain("(new)");
    expect(within(row).getByRole("button", { name: "open" }).textContent).not.toContain("(new)");
  });

  it("does not call a group new before it has a name", () => {
    mountSheet(declaredWith({ attributes: [attribute({ name: "", kind: "string", options: null })] }), { previous: declaredWith() });

    expect(within(screen.getByTestId("attr-toggle-0-0")).queryByText("new")).toBeNull();
  });

  it("marks nothing as new for a class with no active version to compare with", async () => {
    mountSheet(declaredWith({ attributes: [attribute({ name: "state", options: ["open"] })] }), { previous: null });
    await openGroup();

    expect(within(screen.getByTestId("attr-row-0-0")).queryByText(/new/)).toBeNull();
  });
});

describe("the inspector's choices", () => {
  async function withChoices(options: string[], extra: Partial<AttributeBody> = {}) {
    const form = mountSheet(declaredWith({ attributes: [attribute({ options, ...extra })] }));
    await openGroup();
    return form;
  }

  it("commits a chip when a comma is typed", async () => {
    const form = await withChoices([]);

    await userEvent.type(screen.getByTestId("attr-options-0-0"), "red,");

    expect(attributeOf(form).options).toEqual(["red"]);
    expect(screen.getByRole("button", { name: "Remove choice red" })).toBeTruthy();
    expect(screen.getByTestId("attr-options-0-0")).toHaveProperty("value", "");
  });

  it("commits a chip on Enter, and does not submit anything around it", async () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    function Host(): JSX.Element {
      const [declared, setDeclared] = useState(declaredWith({ attributes: [attribute({ options: [] })] }));
      return (
        <form onSubmit={onSubmit}>
          <ClassFields layout="inspector" declared={declared} slot="0" swatch="#888888" hotkey={null} onChange={setDeclared} />
        </form>
      );
    }
    render(<Host />);
    await openGroup();

    await userEvent.type(screen.getByTestId("attr-options-0-0"), "red{Enter}blue{Enter}");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove choice red" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove choice blue" })).toBeTruthy();
  });

  it("commits what is typed when the field loses focus", async () => {
    const form = await withChoices(["red"]);

    await userEvent.type(screen.getByTestId("attr-options-0-0"), "green");
    expect(attributeOf(form).options).toEqual(["red"]);
    await userEvent.tab();

    expect(attributeOf(form).options).toEqual(["red", "green"]);
  });

  it("trims, and drops blanks, as a list is typed", async () => {
    const form = await withChoices([]);

    await userEvent.type(screen.getByTestId("attr-options-0-0"), "  a , ,b ,");

    expect(attributeOf(form).options).toEqual(["a", "b"]);
  });

  it("ignores a choice that is already there", async () => {
    const form = await withChoices(["red"]);

    await userEvent.type(screen.getByTestId("attr-options-0-0"), "red{Enter}");

    expect(attributeOf(form).options).toEqual(["red"]);
    expect(screen.getAllByRole("button", { name: /^Remove choice/ })).toHaveLength(1);
  });

  it("takes the last chip back on Backspace in the empty field, and only then", async () => {
    const form = await withChoices(["red", "blue"]);

    const field = screen.getByTestId("attr-options-0-0");
    await userEvent.type(field, "x{Backspace}");
    // Deleting a typed character is only that.
    expect(attributeOf(form).options).toEqual(["red", "blue"]);

    await userEvent.type(field, "{Backspace}");
    expect(attributeOf(form).options).toEqual(["red"]);
  });

  it("removes a chip with its own button", async () => {
    const form = await withChoices(["red", "blue", "green"]);

    await userEvent.click(screen.getByRole("button", { name: "Remove choice blue" }));

    expect(attributeOf(form).options).toEqual(["red", "green"]);
  });

  it("makes a chip the default when it is pressed, and clears it when the default is pressed again", async () => {
    const form = await withChoices(["red", "blue"]);
    const red = screen.getByRole("button", { name: "red" });
    const blue = screen.getByRole("button", { name: "blue" });
    expect(red.getAttribute("aria-pressed")).toBe("false");
    expect(blue.getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(red);
    expect(attributeOf(form).default).toBe("red");
    expect(red.getAttribute("aria-pressed")).toBe("true");
    expect(blue.getAttribute("aria-pressed")).toBe("false");

    // One default: pressing another moves it.
    await userEvent.click(blue);
    expect(attributeOf(form).default).toBe("blue");
    expect(red.getAttribute("aria-pressed")).toBe("false");
    expect(blue.getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(blue);
    expect(attributeOf(form).default).toBeNull();
    expect(blue.getAttribute("aria-pressed")).toBe("false");
    // A choice has its default among its chips, not in a separate field.
    expect(screen.queryByTestId("attr-default-0-0")).toBeNull();
  });

  it("clears the default when the choice it names is removed, and keeps it otherwise", async () => {
    const form = await withChoices(["red", "blue"], { default: "red" });

    await userEvent.click(screen.getByRole("button", { name: "Remove choice blue" }));
    expect(attributeOf(form).default).toBe("red");

    await userEvent.click(screen.getByRole("button", { name: "Remove choice red" }));
    expect(attributeOf(form).options).toEqual([]);
    expect(attributeOf(form).default).toBeNull();
  });

  it("clears the default when Backspace takes back the choice it names", async () => {
    const form = await withChoices(["red", "blue"], { default: "blue" });

    await userEvent.type(screen.getByTestId("attr-options-0-0"), "{Backspace}");

    expect(attributeOf(form).options).toEqual(["red"]);
    expect(attributeOf(form).default).toBeNull();
  });

  it("offers no choices for a kind that has none", async () => {
    mountSheet(declaredWith({ attributes: [attribute({ kind: "number", options: null })] }));
    await openGroup();

    expect(screen.queryByTestId("attr-options-0-0")).toBeNull();
    expect(screen.getByTestId("attr-default-0-0")).toBeTruthy();
  });
});

describe("the inspector's default", () => {
  it("is a yes/no pick for a boolean", async () => {
    const form = mountSheet(declaredWith({ attributes: [attribute({ kind: "boolean", options: null })] }));
    await openGroup();

    const trigger = screen.getByTestId("attr-default-0-0");
    expect(trigger.textContent).toBe("No default");
    await userEvent.click(trigger);
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual(["No default", "Yes", "No"]);

    await userEvent.click(screen.getByRole("option", { name: "No" }));
    expect(attributeOf(form).default).toBe(false);

    await userEvent.click(screen.getByTestId("attr-default-0-0"));
    await userEvent.click(await screen.findByRole("option", { name: "Yes" }));
    expect(attributeOf(form).default).toBe(true);

    await userEvent.click(screen.getByTestId("attr-default-0-0"));
    await userEvent.click(await screen.findByRole("option", { name: "No default" }));
    expect(attributeOf(form).default).toBeNull();
  });

  it("is a number field for a number, written as a number, and empty is no default", async () => {
    const form = mountSheet(declaredWith({ attributes: [attribute({ kind: "number", options: null })] }));
    await openGroup();

    const field = screen.getByTestId("attr-default-0-0");
    expect(field.getAttribute("type")).toBe("number");
    await userEvent.type(field, "12");
    expect(attributeOf(form).default).toBe(12);

    await userEvent.clear(field);
    expect(attributeOf(form).default).toBeNull();
  });

  it("is a text field for a string", async () => {
    const form = mountSheet(declaredWith({ attributes: [attribute({ kind: "string", options: null })] }));
    await openGroup();

    const field = screen.getByTestId("attr-default-0-0");
    expect(field.getAttribute("type")).toBe("text");
    await userEvent.type(field, "n/a");

    expect(attributeOf(form).default).toBe("n/a");
  });
});

describe("the inspector while disabled", () => {
  it("locks the name, shapes, colour and the way to add an attribute", () => {
    mountSheet(declaredWith({ attributes: [attribute({ options: ["red"], default: "red" })] }), { disabled: true });

    expect(screen.getByTestId("class-name-0")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("class-color-trigger-0")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("class-geometry-0-bbox")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("add-attribute-0")).toHaveProperty("disabled", true);
  });

  it("locks every control in an open group", async () => {
    mountSheet(declaredWith({ attributes: [attribute({ options: ["red"], default: "red" })] }), { disabled: true });
    // A group still opens, to be read: the lock is on what is in it.
    await openGroup();

    expect(screen.getByTestId("attr-name-0-0")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("attr-kind-0-0")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("attr-options-0-0")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("attr-required-0-0")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("remove-attribute-0-0")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "red" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Remove choice red" })).toHaveProperty("disabled", true);
  });

  it("locks an open group when the form becomes disabled under it", async () => {
    const form = mountSheet(declaredWith({ attributes: [attribute({ options: ["red"] })] }));
    await openGroup();
    expect(screen.getByTestId("attr-name-0-0")).toHaveProperty("disabled", false);

    form.update({ disabled: true });

    expect(screen.getByTestId("attr-name-0-0")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("attr-options-0-0")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("attr-required-0-0")).toHaveProperty("disabled", true);
  });

  it("does not write when a shape is pressed", async () => {
    const onChange = vi.fn();
    render(<ClassFields layout="inspector" declared={declaredWith({ geometries: ["bbox"] })} slot="0" swatch="#888888" hotkey={null} disabled onChange={onChange} />);

    await userEvent.click(screen.getByTestId("class-geometry-0-polygon"));

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("the stacked layout", () => {
  function mountStacked(initial: LabelClassBody): { latest: () => LabelClassBody } {
    let latest = initial;
    function Host(): JSX.Element {
      const [declared, setDeclared] = useState(initial);
      return (
        <ClassFields
          declared={declared}
          slot="new"
          swatch="#888888"
          hotkey={null}
          onChange={(next) => {
            latest = next;
            setDeclared(next);
          }}
        />
      );
    }
    render(<Host />);
    return { latest: () => latest };
  }

  it("still renders its labelled fields, with the colour picker always on the page", () => {
    mountStacked(declaredWith());

    expect(screen.getByLabelText("Name")).toBe(screen.getByTestId("class-name-new"));
    expect(screen.getByTestId("class-color-new")).toBeTruthy();
    expect(screen.getByTestId("clear-color-new")).toBeTruthy();
    expect(screen.queryByTestId("class-color-trigger-new")).toBeNull();
    // Four shapes, each a toggle the group reports as pressed or not.
    const shapes = within(screen.getByTestId("class-geometry-new")).getAllByRole("button");
    expect(shapes).toHaveLength(4);
    expect(shapes.every((shape) => shape.hasAttribute("aria-pressed"))).toBe(true);
  });

  it("groups the geometries it offers under their category", () => {
    mountStacked(declaredWith());

    const captions = screen.getAllByTestId(/^geometry-category-/);
    expect(captions.length).toBeGreaterThan(1);
    const grouped = captions.flatMap((caption) => [...(caption.parentElement?.querySelectorAll("[data-testid^='class-geometry-new-']") ?? [])]);
    expect(grouped).toHaveLength(4);
  });

  it("names the attribute kinds in words and keeps the wire values", async () => {
    const form = mountStacked(declaredWith());

    await userEvent.click(screen.getByTestId("add-attribute-new"));
    expect(screen.getByTestId("attr-kind-new-0").textContent).toBe("Text");

    await userEvent.click(screen.getByTestId("attr-kind-new-0"));
    const labels = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(labels).toEqual(["Text", "Number", "Yes / no", "Choice"]);

    await userEvent.click(screen.getByRole("option", { name: "Choice" }));
    expect(form.latest().attributes![0]).toMatchObject({ kind: "select", options: [], default: null });
  });

  it("keeps the geometry toggles pressable, and the last one on", async () => {
    const form = mountStacked(declaredWith());

    const only = screen.getByTestId("class-geometry-new-bbox");
    expect(only.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(only);
    expect(form.latest().geometries).toEqual(["bbox"]);
    expect(only.getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(screen.getByTestId("class-geometry-new-polygon"));
    expect(form.latest().geometries).toEqual(["bbox", "polygon"]);
    expect(screen.getByTestId("class-geometry-new-polygon").getAttribute("aria-pressed")).toBe("true");
  });

  it("refuses to unpress the last shape, and says why on the toggle left standing", async () => {
    const form = mountStacked(declaredWith({ geometries: ["bbox", "polygon"] }));

    const box = screen.getByTestId("class-geometry-new-bbox");
    const polygon = screen.getByTestId("class-geometry-new-polygon");
    expect(box.hasAttribute("aria-disabled")).toBe(false);

    await userEvent.click(box);
    expect(form.latest().geometries).toEqual(["polygon"]);
    expect(box.getAttribute("aria-pressed")).toBe("false");
    expect(polygon.getAttribute("aria-disabled")).toBe("true");
    expect(polygon.getAttribute("title")).toBe("A class needs at least one geometry");

    await userEvent.click(polygon);
    expect(form.latest().geometries).toEqual(["polygon"]);
    expect(polygon.getAttribute("aria-pressed")).toBe("true");
  });

  it("disables its toggles together while the form is locked", async () => {
    const onChange = vi.fn();
    render(<ClassFields declared={declaredWith({ geometries: ["bbox"] })} slot="0" swatch="#888888" hotkey={1} disabled onChange={onChange} />);

    const toggles = within(screen.getByTestId("class-geometry-0")).getAllByRole("button");
    expect(toggles.length).toBeGreaterThan(1);
    expect(toggles.every((toggle) => toggle.hasAttribute("disabled"))).toBe(true);

    await userEvent.click(screen.getByTestId("class-geometry-0-polygon"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the hotkey, and none past the ninth class", () => {
    const { unmount } = render(<ClassFields declared={declaredWith()} slot="0" swatch="#888888" hotkey={3} onChange={vi.fn()} />);
    expect(screen.getByText("Hotkey").textContent).toContain("3");
    unmount();

    render(<ClassFields declared={declaredWith()} slot="0" swatch="#888888" hotkey={null} onChange={vi.fn()} />);
    expect(screen.queryByText("Hotkey")).toBeNull();
  });
});
