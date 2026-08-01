/**
 * The tool palette's contract: which buttons exist, which one is lit, and what a
 * press emits.
 *
 * The gesture itself — press the box tool, drag, get an object — is a browser
 * claim and lives in `e2e/annotate.spec.ts`. jsdom has no layout, so a drag here
 * would prove nothing about the thing that was broken.
 */

import { render, screen } from "@testing-library/react";
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

  it("gives a tag and an unimplemented geometry no canvas tool", () => {
    render(mount());

    // Both answer `null` from `drawableGeometry`, for different reasons, and
    // neither is drawable. `daytime` is reachable from the Labels tab; `kerb` is
    // not reachable at all, and must not look like it is.
    expect(screen.queryByTestId("tool-classification_tag")).toBeNull();
    expect(screen.queryByTestId("tool-polyline")).toBeNull();
  });

  it("names each geometry's first declaring class, in authored order", () => {
    // The activated class is what makes the tool derive; `pedestrian` declaring
    // bbox second must not be what the box button reaches for, because the digit
    // row is bound in the same order.
    const choices = toolChoices(SCHEMA);
    expect(choices.map((choice) => choice.tool)).toEqual(["select", "bbox", "polygon"]);
    expect(choices.map((choice) => choice.labelClass)).toEqual([null, "vehicle", "lane"]);
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
