/**
 * The floating tool palette — `DESIGN.md`'s **Tool strip**, on the product page.
 *
 * ## What it fixes, and why the absence was invisible
 *
 * The page opens with `activeClass = null`, so `toolFor` answers `select` and a
 * drag on the canvas draws nothing. The capability was reachable — the Labels tab
 * and the digit hotkeys both move the active class — but neither is a *tool*, and
 * neither is discoverable from the canvas somebody is looking at. So a first-time
 * user got a page whose primary gesture was inert (#198; #145 recorded the same
 * absence as ergonomics, which was too generous).
 *
 * ## A tool strip over a derived tool
 *
 * `core/interaction/tool.ts` is emphatic that the tool is **derived from the active
 * class and never stored**, and it is right: v1 held both and spent two mechanisms
 * keeping them from disagreeing. So this strip does not select a tool. It *reports*
 * the derived one and, when pressed, moves the active class to one that derives the
 * tool asked for — the only honest way to spell a tool button over a store that has
 * no tool.
 *
 * Two consequences, both deliberate:
 *
 * 1. A press whose tool is **already active is a no-op**. A schema may declare two
 *    bbox classes; with `pedestrian` held, the box button is lit, and re-pointing
 *    the class at `vehicle` would silently change what the next shape is labelled.
 *    The tool did not move, so nothing moves. Changing *which* class is the job of
 *    the Labels tab, which lists all of them.
 * 2. The strip shows only the tools **this schema can reach** — `select`, plus one
 *    button per distinct drawable geometry among the declared classes, built from
 *    `drawableGeometry`. A `classification_tag` and a `polyline` both answer
 *    `null`, and neither gets a canvas tool.
 *
 * ## Why this is a second component rather than the showcase's, moved
 *
 * `@visionset/app`'s `demo/ToolStrip.tsx` is the same rule with inline styles from
 * `demo/theme.ts`, and it stays there. The showcase exists to demonstrate that the
 * annotator ships headless — no Tailwind, no design tokens, no chrome — and a
 * showcase importing product UI would be demonstrating the opposite. What the two
 * share is the rule stated in `tool.ts`, not a file. The third option, putting a
 * strip in `@visionset/annotator`'s adapters, is out on `AnnotatorPanel`'s
 * argument: a styled control there is the first thing an embedder has to fight.
 *
 * ## The shortcut in the tooltip is the digit, not v1's letter
 *
 * `DESIGN.md` writes "Box (B)", "Polygon (P)" from v1. This build binds classes to
 * the **digit row** (#46: digit N is palette row N, capped at nine), so the chord
 * that reaches a tool is the one `hotkeyForClass` answers. Printing v1's letter
 * would be printing a key that does nothing. `select` has no class and therefore no
 * digit; `V` is its chord in `DEFAULT_BINDINGS` and in the Labels tab, so it is `V`
 * here too.
 */

import {
  drawableGeometry,
  hotkeyForClass,
  type AnnotationSchema,
  type Tool,
} from "@visionset/annotator";
import { CircleHelp, MousePointer2, Spline, Square } from "lucide-react";
import type { JSX, MouseEvent, ReactNode } from "react";

import { Button } from "../primitives/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../primitives/Menu";

/** A schema's tools, in the order the strip lists them. */
interface ToolChoice {
  readonly tool: Tool;
  readonly label: string;
  /** The class this button activates — `null` is select mode. */
  readonly labelClass: string | null;
  readonly hotkey: string;
}

/**
 * The tools this schema can reach, `select` first.
 *
 * A geometry is represented by the **first** class declaring it, in authored
 * order, which is the same order `classHotkeys` binds the digit row in. Nothing
 * here dedupes by class: two bbox classes are one bbox tool.
 */
export function toolChoices(schema: AnnotationSchema): readonly ToolChoice[] {
  const choices: ToolChoice[] = [
    { tool: "select", label: "Select", labelClass: null, hotkey: "V" },
  ];
  for (const declared of schema.classes) {
    const geometry = drawableGeometry(declared);
    if (geometry === null) continue;
    if (choices.some((choice) => choice.tool === geometry)) continue;
    choices.push({
      tool: geometry,
      label: geometry === "bbox" ? "Box" : "Polygon",
      labelClass: declared.name,
      hotkey: hotkeyForClass(schema, declared.name) ?? "—",
    });
  }
  return choices;
}

export interface ToolPaletteProps {
  readonly schema: AnnotationSchema;
  /** What `toolFor` currently answers. Reported, never stored here. */
  readonly tool: Tool;
  readonly onActivateClass: (labelClass: string | null) => void;
  readonly onToggleHelp: () => void;
}

export function ToolPalette({
  schema,
  tool,
  onActivateClass,
  onToggleHelp,
}: ToolPaletteProps): JSX.Element {
  /**
   * The canvas keeps the focus.
   *
   * `AnnotatorCanvas` reads the keyboard off its own root, so a button that took
   * the focus would leave every chord dead until the user clicked back on the
   * picture — the same class of failure #47 measured when a removed shape took the
   * focus with it, arrived at from the other direction. `mousedown` is where the
   * browser moves focus, so that is where it is refused.
   */
  function keepFocus(event: MouseEvent): void {
    event.preventDefault();
  }

  return (
    <div
      data-testid="tool-palette"
      className="absolute left-3 top-3 flex w-12 flex-col items-center gap-1 rounded-xl border border-border bg-muted p-2 shadow-lg"
    >
      {toolChoices(schema).map((choice) => (
        <PaletteButton
          key={choice.tool}
          testId={`tool-${choice.tool}`}
          label={`${choice.label} (${choice.hotkey})`}
          active={tool === choice.tool}
          onMouseDown={keepFocus}
          // (1) above: the tool did not move, so nothing moves.
          onClick={() => {
            if (tool !== choice.tool) onActivateClass(choice.labelClass);
          }}
        >
          <ToolIcon tool={choice.tool} />
        </PaletteButton>
      ))}

      <div className="my-1 h-px w-6 bg-border" />

      <PaletteButton
        testId="tool-help"
        label="Shortcuts (?)"
        active={false}
        onMouseDown={keepFocus}
        onClick={onToggleHelp}
      >
        <CircleHelp className="size-4" />
      </PaletteButton>
    </div>
  );
}

/** `DESIGN.md`: 36px, the primary variant when active and ghost when not. */
function PaletteButton({
  testId,
  label,
  active,
  onClick,
  onMouseDown,
  children,
}: {
  readonly testId: string;
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly onMouseDown: (event: MouseEvent) => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? "primary" : "ghost"}
          size="icon"
          aria-label={label}
          aria-pressed={active}
          data-testid={testId}
          data-active={active ? "true" : "false"}
          onMouseDown={onMouseDown}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      {/* Right, because the strip is against the canvas's left edge and a tooltip
          opening over the picture would cover the thing being annotated. */}
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/** `DESIGN.md` pins the three icons. */
function ToolIcon({ tool }: { readonly tool: Tool }): JSX.Element {
  if (tool === "bbox") return <Square className="size-4" />;
  if (tool === "polygon") return <Spline className="size-4" />;
  return <MousePointer2 className="size-4" />;
}
