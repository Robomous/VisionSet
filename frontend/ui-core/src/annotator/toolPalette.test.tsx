/**
 * The tool palette's contract: which buttons exist, which one is lit, and what a
 * press emits.
 *
 * The gesture itself — press the box tool, drag, get an object — is a browser
 * claim and lives in `e2e/annotate.spec.ts`. jsdom has no layout, so a drag here
 * would prove nothing about the thing that was broken.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { JSX } from "react";

import { TooltipProvider } from "../primitives/Menu";
import { ToolPalette, toolChoices } from "./ToolPalette";

/**
 * Four classes covering all four cases `drawableGeometry` distinguishes: two bbox
 * classes (which must collapse to one tool), a polygon, a tag, and a geometry the
 * wire names but no annotation may carry.
 */
const SCHEMA = {
  project_id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  classes: [
    { name: "vehicle", geometry: "bbox", color: "#38bdf8", attributes: [] },
    { name: "pedestrian", geometry: "bbox", color: null, attributes: [] },
    { name: "lane", geometry: "polygon", color: "#f97316", attributes: [] },
    { name: "daytime", geometry: "classification_tag", color: "#a3e635", attributes: [] },
    { name: "kerb", geometry: "polyline", color: null, attributes: [] },
  ],
} as unknown as Parameters<typeof toolChoices>[0];

function mount(
  overrides: Partial<Parameters<typeof ToolPalette>[0]> = {},
): JSX.Element {
  return (
    <TooltipProvider>
      <ToolPalette
        schema={SCHEMA}
        tool="select"
        onActivateClass={vi.fn()}
        onToggleHelp={vi.fn()}
        {...overrides}
      />
    </TooltipProvider>
  );
}

describe("the tools a schema can reach", () => {
  it("offers select, plus one button per distinct drawable geometry", () => {
    render(mount());

    expect(screen.getByTestId("tool-select")).toBeTruthy();
    expect(screen.getByTestId("tool-bbox")).toBeTruthy();
    expect(screen.getByTestId("tool-polygon")).toBeTruthy();
    expect(screen.getByTestId("tool-help")).toBeTruthy();
  });

  it("collapses two classes of the same geometry into one tool", () => {
    // `vehicle` and `pedestrian` are both bbox. A strip listing a button each
    // would be a class palette wearing a tool strip's clothes — that is the
    // Labels tab's job, and it lists all five.
    expect(screen.queryAllByTestId("tool-bbox")).toHaveLength(0);
    render(mount());
    expect(screen.getAllByTestId("tool-bbox")).toHaveLength(1);
  });

  it("gives a classification tag no canvas tool at all", () => {
    render(mount());

    // `drawableGeometry` answers `null`, and unlike `polyline` it always will:
    // there is nothing to draw, because the label is about the whole image. The
    // Labels tab is where it is toggled, so a strip button would be a second
    // spelling of a control that exists elsewhere.
    expect(screen.queryByTestId("tool-classification_tag")).toBeNull();
  });

  it("offers polyline as a live tool, and it activates its class (#342)", () => {
    // It spent one release as the strip's worked example of not-yet-drawable —
    // disabled, carrying its own reason. #342 shipped the tool, so the button is
    // live and the sentence is gone. Both halves are asserted, because a button
    // that merely stopped being disabled while still activating nothing would
    // leave the canvas inert with a lane class held (#198's bug).
    const onActivateClass = vi.fn();
    render(mount({ onActivateClass }));

    const button = screen.getByTestId("tool-polyline");
    expect(button.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(button);

    expect(onActivateClass).toHaveBeenCalledWith("kerb");
  });

  it("has nothing left that is declared and not drawable, and keeps the mechanism", () => {
    // `PENDING_TOOLS` is empty now and the rule it encodes still holds: `mask` and
    // `keypoints` are in the position `polyline` was, so this asserts the *absence
    // of a pending entry for this schema* rather than the absence of the feature.
    const choices = toolChoices(SCHEMA);
    expect(choices.filter((choice) => choice.unavailable !== null)).toEqual([]);
  });

  it("names each geometry's first declaring class, in authored order", () => {
    // The activated class is what makes the tool derive; `pedestrian` declaring
    // bbox second must not be what the box button reaches for, because the digit
    // row is bound in the same order.
    const choices = toolChoices(SCHEMA);
    expect(choices.map((choice) => choice.tool)).toEqual([
      "select",
      "bbox",
      "polygon",
      "polyline",
    ]);
    expect(choices.map((choice) => choice.labelClass)).toEqual([
      null,
      "vehicle",
      "lane",
      "kerb",
    ]);
  });

  it("offers no polyline button at all when the schema declares no lane class", () => {
    // The affordance is about *this* schema. A strip advertising a geometry
    // nobody declared would be a roadmap, not a tool strip.
    const noLanes = {
      ...SCHEMA,
      classes: SCHEMA.classes.filter((declared) => declared.geometry !== "polyline"),
    } as typeof SCHEMA;
    render(mount({ schema: noLanes }));

    expect(screen.queryByTestId("tool-polyline")).toBeNull();
  });

  it("carries the digit the engine actually binds, and V for select", () => {
    // #46 binds digit N to palette row N. Printing v1's "B"/"P" would be printing
    // a key that does nothing in this build.
    const choices = toolChoices(SCHEMA);
    expect(choices.find((choice) => choice.tool === "select")?.hotkey).toBe("V");
    expect(choices.find((choice) => choice.tool === "bbox")?.hotkey).toBe("1");
    expect(choices.find((choice) => choice.tool === "polygon")?.hotkey).toBe("3");
  });

  it("shows only select when no class draws anything", () => {
    const tagsOnly = {
      ...SCHEMA,
      classes: [{ name: "daytime", geometry: "classification_tag", color: null, attributes: [] }],
    } as unknown as typeof SCHEMA;

    render(mount({ schema: tagsOnly }));
    expect(screen.getByTestId("tool-select")).toBeTruthy();
    expect(screen.queryByTestId("tool-bbox")).toBeNull();
    expect(screen.queryByTestId("tool-polygon")).toBeNull();
  });
});

describe("the derived tool is reported, never stored", () => {
  it("lights the button matching the tool it was handed", () => {
    render(mount({ tool: "polygon" }));

    expect(screen.getByTestId("tool-polygon").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("tool-select").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("tool-bbox").getAttribute("data-active")).toBe("false");
  });

  it("states the active tool to assistive technology as well as to the eye", () => {
    render(mount({ tool: "bbox" }));
    expect(screen.getByTestId("tool-bbox").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("a press moves the active class", () => {
  it("activates the class that derives the tool asked for", async () => {
    const onActivateClass = vi.fn();
    render(mount({ tool: "select", onActivateClass }));

    await userEvent.click(screen.getByTestId("tool-bbox"));
    expect(onActivateClass).toHaveBeenCalledWith("vehicle");
  });

  it("returns to select mode with a null class", async () => {
    const onActivateClass = vi.fn();
    render(mount({ tool: "bbox", onActivateClass }));

    await userEvent.click(screen.getByTestId("tool-select"));
    expect(onActivateClass).toHaveBeenCalledWith(null);
  });

  it("emits nothing when the pressed tool is already the active one", async () => {
    // The trap this guards: with `pedestrian` held, the box button is lit, and
    // re-pointing the class at `vehicle` would silently change what the next
    // shape is labelled without changing the tool.
    const onActivateClass = vi.fn();
    render(mount({ tool: "bbox", onActivateClass }));

    await userEvent.click(screen.getByTestId("tool-bbox"));
    expect(onActivateClass).not.toHaveBeenCalled();
  });

  it("opens the shortcut sheet from the help entry", async () => {
    const onToggleHelp = vi.fn();
    const onActivateClass = vi.fn();
    render(mount({ onToggleHelp, onActivateClass }));

    await userEvent.click(screen.getByTestId("tool-help"));
    expect(onToggleHelp).toHaveBeenCalledTimes(1);
    // Help is not a tool, so it must not disturb the class.
    expect(onActivateClass).not.toHaveBeenCalled();
  });
});

describe("the canvas keeps the focus", () => {
  it("refuses the focus move a mousedown would otherwise make", async () => {
    render(mount());

    // `AnnotatorCanvas` reads the keyboard off its own root, so a button that
    // took the focus would leave every chord dead until the user clicked back on
    // the picture. `mousedown` is where the browser moves focus.
    // Listened for on `document`, not on the button: React 19 delegates to the
    // render root, so a listener on the target itself runs *before* the handler
    // it is meant to observe and would report `false` however the component
    // behaved. The assertion has to sit outside the root to see the answer.
    const seen: boolean[] = [];
    const watch = (event: MouseEvent): void => void seen.push(event.defaultPrevented);
    document.addEventListener("mousedown", watch);
    try {
      await userEvent.click(screen.getByTestId("tool-bbox"));
    } finally {
      document.removeEventListener("mousedown", watch);
    }

    expect(seen).toEqual([true]);
  });
});

describe("adding a class from the palette (#233)", () => {
  it("offers no button where the host cannot honour one", () => {
    // The `onOpenGallery` rule: a host with nowhere to send anybody renders no
    // control rather than a dead one. The annotator demo has no project behind it.
    render(mount());

    expect(screen.queryByTestId("tool-add-class")).toBeNull();
  });

  it("asks the host to open the dialog, and keeps the canvas's focus", async () => {
    const add = vi.fn();
    render(mount({ onAddClass: add }));

    const button = screen.getByTestId("tool-add-class");
    await userEvent.click(button);

    expect(add).toHaveBeenCalledTimes(1);
    // Focus stays on the canvas for the reason every other palette button keeps
    // it: `AnnotatorCanvas` reads the keyboard off its own root, so a button that
    // took focus would leave every chord dead until the user clicked the picture.
    expect(document.activeElement).not.toBe(button);
  });
});
