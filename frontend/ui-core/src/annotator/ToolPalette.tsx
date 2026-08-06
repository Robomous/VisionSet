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
 *    `drawableGeometry`. A `classification_tag` answers `null` and gets no canvas
 *    tool, because there is nothing to draw: the label is about the whole image
 *    and the Labels tab is where it is toggled.
 *
 * ## `polyline` is the one geometry that is declared, real, and not yet drawable
 *
 * `drawableGeometry` answers `null` for it too, but for a different reason and
 * only for now. #223 shipped the geometry end to end — a schema declares it, the
 * API and MCP write it, five lane exporters consume it, and the canvas renders it
 * — and stopped short of an interactive drawing tool, which is #342. The intended
 * workflow is that an agent pre-labels lanes and a person reviews them here.
 *
 * So a schema declaring a polyline class gets a **disabled button with the reason
 * on it**, never a gap. A missing control says "this schema has no lanes", which
 * is false and is exactly the ambiguity `ui-capabilities` forbids: absent and
 * not-yet-available look identical, and only one of them is true. The button
 * carries the sentence, so the answer to "where do lanes come from?" is on the
 * strip rather than in a changelog.
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
import {
  CircleHelp,
  MousePointer2,
  Plus,
  Redo2,
  Spline,
  Square,
  Undo2,
  Waypoints,
} from "lucide-react";
import type { JSX, MouseEvent, ReactNode } from "react";

import { Button } from "../primitives/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../primitives/Menu";

/**
 * Why a declared geometry has no tool yet, keyed by the geometry.
 *
 * One entry, and the shape is what matters: this is a map rather than an `if`
 * so the day `mask` or `keypoints` lands the same way, the strip says so without
 * anyone remembering that it should.
 */
const PENDING_TOOLS: Readonly<Record<string, string>> = {
  polyline:
    "Polyline drawing arrives with 0.2 — lanes are written via the SDK or MCP " +
    "and reviewed here.",
};

/** A schema's tools, in the order the strip lists them. */
interface ToolChoice {
  /** A real `Tool`, or a geometry the strip shows as not-yet-drawable. */
  readonly tool: Tool | keyof typeof PENDING_TOOLS;
  readonly label: string;
  /** The class this button activates — `null` is select mode. */
  readonly labelClass: string | null;
  readonly hotkey: string;
  /**
   * Why this tool cannot be picked, or `null` when it can.
   *
   * Disabled-with-reason rather than hidden: see the module docstring. A button
   * carrying this never calls `onActivateClass`, because activating a class whose
   * tool does not exist would leave the canvas in `select` with a lane class held
   * — inert, and indistinguishable from the bug #198 fixed.
   */
  readonly unavailable: string | null;
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
    { tool: "select", label: "Select", labelClass: null, hotkey: "V", unavailable: null },
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
      unavailable: null,
    });
  }
  // After the usable tools, never interleaved: the strip reads top to bottom as
  // "what you can do", and a disabled control in the middle of that list reads as
  // a broken one rather than as a coming one.
  for (const declared of schema.classes) {
    const pending = PENDING_TOOLS[declared.geometry];
    if (pending === undefined) continue;
    if (choices.some((choice) => choice.tool === declared.geometry)) continue;
    choices.push({
      tool: declared.geometry,
      label: "Polyline",
      // No class to activate, because there is no tool to activate it for.
      labelClass: null,
      hotkey: "—",
      unavailable: pending,
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
  /**
   * Open the add-a-class dialog (#233), or absent where there is nowhere to add
   * one — the demo has no project behind it. The `onOpenGallery` rule: a host
   * that cannot honour a control renders no control rather than a dead one.
   */
  readonly onAddClass?: () => void;
  /**
   * The command log's two steps, made visible (#368).
   *
   * `mod+z` and `mod+shift+z` have worked since #46 and are unchanged; what was
   * missing is any way to *find out* that they do. Undo is the annotator's
   * headline capability over v1, and it had no representation on screen at all —
   * a person who did not already know the chord had no route to it.
   *
   * Optional as a pair: a host with no store to step (the showcase) renders
   * neither, rather than two dead buttons.
   */
  readonly history?: {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly onUndo: () => void;
    readonly onRedo: () => void;
  };
}

export function ToolPalette({
  schema,
  tool,
  onActivateClass,
  onToggleHelp,
  onAddClass,
  history,
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
          label={
            choice.unavailable ?? `${choice.label} (${choice.hotkey})`
          }
          active={tool === choice.tool}
          disabled={choice.unavailable !== null}
          onMouseDown={keepFocus}
          // (1) above: the tool did not move, so nothing moves.
          onClick={() => {
            if (choice.unavailable !== null) return;
            if (tool !== choice.tool) onActivateClass(choice.labelClass);
          }}
        >
          <ToolIcon tool={choice.tool} />
        </PaletteButton>
      ))}

      {/* Beside the tools, because "the class I need is not here" is a thought
          somebody has while looking at this strip — and a digit hotkey for the
          new class arrives free, since the palette *is* the hotkey order (#46). */}
      {onAddClass !== undefined && (
        <PaletteButton
          testId="tool-add-class"
          label="Add a label class"
          active={false}
          onMouseDown={keepFocus}
          onClick={onAddClass}
        >
          <Plus className="size-4" />
        </PaletteButton>
      )}

      {history !== undefined && (
        <>
          <div className="my-1 h-px w-6 bg-border" />
          {/*
            Disabled *with the reason*, which is principle 9's treatment and the
            right one here: an empty history is a real state a person reaches
            constantly — every freshly opened frame is in it — and a control that
            simply vanished when there was nothing to undo would make the button
            appear and disappear as they worked.
          */}
          <PaletteButton
            testId="tool-undo"
            label={history.canUndo ? "Undo (\u2318Z)" : "Nothing to undo"}
            active={false}
            disabled={!history.canUndo}
            onMouseDown={keepFocus}
            onClick={history.onUndo}
          >
            <Undo2 className="size-4" />
          </PaletteButton>
          <PaletteButton
            testId="tool-redo"
            label={history.canRedo ? "Redo (\u21e7\u2318Z)" : "Nothing to redo"}
            active={false}
            disabled={!history.canRedo}
            onMouseDown={keepFocus}
            onClick={history.onRedo}
          >
            <Redo2 className="size-4" />
          </PaletteButton>
        </>
      )}

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
  disabled = false,
  onClick,
  onMouseDown,
  children,
}: {
  readonly testId: string;
  readonly label: string;
  readonly active: boolean;
  readonly disabled?: boolean;
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
          // `aria-disabled`, never the native `disabled` attribute. A disabled
          // <button> receives no pointer events, so Radix's trigger never opens —
          // and a disabled-with-reason control whose reason cannot be read is a
          // bare disabled control. This keeps the hover and refuses the press.
          aria-disabled={disabled || undefined}
          data-testid={testId}
          data-active={active ? "true" : "false"}
          className={disabled ? "cursor-not-allowed opacity-40" : undefined}
          onMouseDown={onMouseDown}
          onClick={() => {
            // The press is refused here rather than by the native attribute, which
            // `aria-disabled` deliberately does not do — see the comment above.
            if (disabled) return;
            onClick();
          }}
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
function ToolIcon({ tool }: { readonly tool: ToolChoice["tool"] }): JSX.Element {
  if (tool === "bbox") return <Square className="size-4" />;
  if (tool === "polygon") return <Spline className="size-4" />;
  // A lane is a path, and `Waypoints` is the one icon in the set that reads as an
  // open one — `Spline` is already the polygon's and would say "closed".
  if (tool === "polyline") return <Waypoints className="size-4" />;
  return <MousePointer2 className="size-4" />;
}
