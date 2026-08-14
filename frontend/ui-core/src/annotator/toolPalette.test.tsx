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
        hand={{ active: false, onToggle: vi.fn() }}
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
    // disabled, carrying its own reason. The tool exists, so the button is
    // live and the sentence is gone. Both halves are asserted, because a button
    // that merely stopped being disabled while still activating nothing would
    // leave the canvas inert with a lane class held.
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
    // Digit N is palette row N. Printing v1's "B"/"P" would be printing
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

describe("the suggest tool (#424)", () => {
  it("is absent without the prop — a host with no model behind it renders none", () => {
    render(mount());
    expect(screen.queryByTestId("tool-suggest")).toBeNull();
  });

  it("is offered when the schema declares a class that can hold the answer", () => {
    render(mount({ suggest: { active: false, onToggle: vi.fn() } }));
    expect(screen.getByTestId("tool-suggest")).toBeTruthy();
    expect(screen.getByTestId("tool-suggest").getAttribute("aria-label")).toBe("Suggest (S)");
  });

  it("is hidden, not disabled, on a schema no class of which could hold one", () => {
    // D3's third case. A disabled sparkle here would be promising a capability
    // that does not apply to this project rather than one that is coming — which
    // is the distinction `PENDING_TOOLS` exists for and this is not.
    const tagsOnly = {
      ...(SCHEMA as unknown as { classes: unknown[] }),
      classes: [
        { name: "daytime", geometry: "classification_tag", color: null, attributes: [] },
        { name: "kerb", geometry: "polyline", color: null, attributes: [] },
      ],
    } as unknown as Parameters<typeof toolChoices>[0];
    render(mount({ schema: tagsOnly, suggest: { active: false, onToggle: vi.fn() } }));
    expect(screen.queryByTestId("tool-suggest")).toBeNull();
  });

  it("is lit from the host's mode rather than from the derived tool", () => {
    // The one control on this strip whose `active` is not `tool === choice.tool`:
    // suggest is a mode held beside the class, and the class still derives `bbox`.
    render(mount({ tool: "bbox", suggest: { active: true, onToggle: vi.fn() } }));
    expect(screen.getByTestId("tool-suggest").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("tool-bbox").getAttribute("data-active")).toBe("true");
  });

  it("toggles on a press, and does not move the active class itself", async () => {
    const onToggle = vi.fn();
    const onActivateClass = vi.fn();
    render(mount({ onActivateClass, suggest: { active: false, onToggle } }));
    await userEvent.click(screen.getByTestId("tool-suggest"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    // Arming *does* activate a class — but that is the page's decision, made from
    // `suggestClassFor`, not this strip reaching for one.
    expect(onActivateClass).not.toHaveBeenCalled();
  });

  it("keeps the canvas's focus, like every other button here", () => {
    render(mount({ suggest: { active: false, onToggle: vi.fn() } }));
    const press = fireEvent.mouseDown(screen.getByTestId("tool-suggest"));
    expect(press).toBe(false);
  });

  /**
   * The class half of what the schema check is the project half of.
   *
   * Hidden is for a schema that could never hold an answer; dimmed-with-reason is
   * for a class that cannot hold one *right now*, because that comes back the
   * moment the active class moves.
   */
  it("is dimmed with its reason, not hidden, while the held class can hold nothing", async () => {
    const onToggle = vi.fn();
    render(
      mount({
        suggest: {
          active: true,
          onToggle,
          unavailable: "Suggest is on, but “kerb” cannot hold a suggested shape",
        },
      }),
    );

    const button = screen.getByTestId("tool-suggest");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // The reason replaces the name, because the tooltip is where a refusal is
    // readable — a dimmed button still labelled "Suggest (S)" is the bare
    // disabled state principle 9 names.
    expect(button.getAttribute("aria-label")).toContain("kerb");
    // Lit and dimmed at once, both true: the tool is armed, and it cannot act.
    expect(button.getAttribute("data-active")).toBe("true");

    await userEvent.click(button);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("is an ordinary button again when the reason is absent or null", () => {
    render(mount({ suggest: { active: true, onToggle: vi.fn(), unavailable: null } }));
    expect(screen.getByTestId("tool-suggest").getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByTestId("tool-suggest").getAttribute("aria-label")).toBe("Suggest (S)");
  });
});

describe("the hand is the one button here that is not about the schema (#576)", () => {
  it("is offered on a schema that declares nothing drawable at all", () => {
    // Every other control on the strip answers a question about the schema. This
    // one answers a question about the device — a trackpad, a pen and a finger
    // have no second mouse button, which is the only spelling a pan used to have
    // — so a tag-only project gets it exactly as a bbox project does.
    const tagsOnly = {
      ...SCHEMA,
      classes: [SCHEMA.classes[3]],
    } as unknown as Parameters<typeof toolChoices>[0];
    render(mount({ schema: tagsOnly }));

    expect(screen.getByTestId("tool-hand")).toBeTruthy();
    expect(screen.queryByTestId("tool-bbox")).toBeNull();
    expect(screen.queryByTestId("tool-polygon")).toBeNull();
  });

  it("names its chord, and lights up when the host says it is on", () => {
    const { rerender } = render(mount());
    expect(screen.getByTestId("tool-hand").getAttribute("aria-label")).toBe("Hand (H)");
    expect(screen.getByTestId("tool-hand").getAttribute("data-active")).toBe("false");

    rerender(mount({ hand: { active: true, onToggle: vi.fn() } }));
    expect(screen.getByTestId("tool-hand").getAttribute("data-active")).toBe("true");
  });

  it("asks the host to toggle rather than holding the mode itself", () => {
    const onToggle = vi.fn();
    render(mount({ hand: { active: false, onToggle } }));

    fireEvent.click(screen.getByTestId("tool-hand"));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("takes the lit state off the derived tool while it is on", () => {
    // The bug this is here for: the hand is a mode beside the derived tool
    // rather than one of its values, so the strip lit both and two buttons
    // claimed to be on at once. The canvas answers a primary press with a pan
    // before the machine ever hears it, so the derived tool cannot act while the
    // hand is up — and a lit button for a tool that does nothing is the lie.
    const { rerender } = render(mount({ tool: "bbox" }));
    expect(screen.getByTestId("tool-bbox").getAttribute("data-active")).toBe("true");

    rerender(mount({ tool: "bbox", hand: { active: true, onToggle: vi.fn() } }));
    expect(screen.getByTestId("tool-bbox").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("tool-hand").getAttribute("data-active")).toBe("true");
  });

  it("takes it off the suggest tool too, which the same press cannot reach", () => {
    // Suggest is armed rather than derived, so it is a second thing that would
    // otherwise stay lit — and it is reached by the same primary press the pan
    // branch answers first, so it is inert for the same reason.
    const armed = { active: true, onToggle: vi.fn(), unavailable: null };
    const { rerender } = render(mount({ suggest: armed }));
    expect(screen.getByTestId("tool-suggest").getAttribute("data-active")).toBe("true");

    rerender(mount({ suggest: armed, hand: { active: true, onToggle: vi.fn() } }));
    expect(screen.getByTestId("tool-suggest").getAttribute("data-active")).toBe("false");
  });

  it("is the last of the tools, below the button that adds a class", () => {
    // Order, asserted because it is the half a `getByTestId` cannot see. It was
    // above the strip for a release, which read as a heading over the tools
    // rather than as one of them.
    render(mount({ onAddClass: vi.fn(), suggest: { active: false, onToggle: vi.fn() } }));

    const strip = screen.getByTestId("tool-palette");
    const order = [...strip.querySelectorAll("[data-testid^='tool-']")].map((node) =>
      node.getAttribute("data-testid"),
    );

    expect(order.slice(0, 3)).toEqual(["tool-select", "tool-bbox", "tool-polygon"]);
    expect(order.slice(-4)).toEqual([
      "tool-suggest",
      "tool-add-class",
      "tool-hand",
      "tool-help",
    ]);
  });
});

describe("a viewer gets the strip, carrying only what does not draw (#576)", () => {
  it("keeps the hand and the shortcut sheet", () => {
    render(mount({ readOnly: true }));

    expect(screen.getByTestId("tool-hand")).toBeTruthy();
    expect(screen.getByTestId("tool-help")).toBeTruthy();
  });

  it("drops every control that draws, adds a class or steps the command log", () => {
    render(
      mount({
        readOnly: true,
        onAddClass: vi.fn(),
        suggest: { active: false, onToggle: vi.fn(), unavailable: null },
        history: { canUndo: true, canRedo: true, onUndo: vi.fn(), onRedo: vi.fn() },
      }),
    );

    // Every one of these is offered by the same mount without `readOnly`, which
    // is what the tests above assert — so their absence here is the flag doing
    // the work and not a prop nobody passed.
    for (const testId of [
      "tool-select",
      "tool-bbox",
      "tool-polygon",
      "tool-polyline",
      "tool-suggest",
      "tool-add-class",
      "tool-undo",
      "tool-redo",
    ]) {
      expect(screen.queryByTestId(testId)).toBeNull();
    }
  });
});
