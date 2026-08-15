/**
 * The floating tool palette — `DESIGN.md`'s **Tool strip**, on the product page.
 *
 * ## What it fixes, and why the absence was invisible
 *
 * The page opens with `activeClass = null`, so `toolFor` answers `select` and a
 * drag on the canvas draws nothing. The capability was reachable — the Labels tab
 * and the digit hotkeys both move the active class — but neither is a *tool*, and
 * neither is discoverable from the canvas somebody is looking at. So a first-time
 * user gets a page whose primary gesture is inert.
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
 * ## `polyline` is a tool
 *
 * It spent one release as the strip's worked example of not-yet-drawable — a
 * disabled button carrying its own reason, because a missing control would have
 * said "this schema has no lanes", which was false. It has a tool now, so the
 * button is live and the sentence is gone.
 *
 * `PENDING_TOOLS` stays, empty. The rule it encodes — *declared but not drawable
 * is disabled-with-reason, never absent* — is the part worth keeping, and `mask`
 * and `keypoints` are still in that position the day a schema declares one.
 *
 * ## The suggest button is the one control here that is a mode
 *
 * Every other button on this strip *reports* a derived tool and moves the active
 * class to derive it. Suggest cannot: it is not a `Tool`, because `tool.ts`
 * derives the tool from the class and there is no class that means "ask a model".
 * So it is a mode held beside the class — the host arms it, the host lights it —
 * and it arrives as its own prop rather than as a row in `toolChoices`, so that
 * the list stays exactly what its type says it is.
 *
 * It is **absent** rather than disabled on a schema whose classes can hold
 * neither a box nor a polygon, which is the same rule that keeps a
 * `classification_tag` off the strip: a disabled control has to be explicable in
 * principle 9's terms, and "no class in this project could accept the answer" is
 * a fact about the schema rather than a capability that is coming.
 *
 * The *class* is a different question from the schema, and gets the other
 * treatment. An armed tool over a class that can hold nothing is **dimmed
 * with its reason**, not hidden: the capability is real in this project and comes
 * back the moment the active class moves, so a button that vanished and returned
 * as somebody worked down the class list would be describing a project that keeps
 * changing. `unavailable` carries the sentence.
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
 * the **digit row** — digit N is palette row N, capped at nine — so the chord
 * that reaches a tool is the one `hotkeyForClass` answers. Printing v1's letter
 * would be printing a key that does nothing. `select` has no class and therefore no
 * digit; `V` is its chord in `DEFAULT_BINDINGS` and in the Labels tab, so it is `V`
 * here too.
 */

import {
  drawableGeometries,
  hotkeyForClass,
  schemaCanSuggest,
  type AnnotationSchema,
  type GeometryType,
  type Tool,
} from "@visionset/annotator";

import { geometryLabel } from "../data/geometryCategory";
import {
  CircleHelp,
  Hand,
  Plus,
  Redo2,
  Sparkles,
  Undo2,
} from "lucide-react";

import { GeometryIcon } from "./GeometryIcon";
import type { JSX, MouseEvent, ReactNode } from "react";

import { Button } from "../primitives/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../primitives/Menu";

/**
 * Why a declared geometry has no tool yet, keyed by the geometry.
 *
 * **Empty**, and kept rather than deleted along with its last entry.
 * The mechanism is what earns its place: the day `mask` or `keypoints` is declared
 * in a schema, the strip says so without anyone remembering that it should, and
 * that is a property worth more than the twelve lines it costs.
 *
 * The record is typed on `string` rather than on the geometry union so an entry
 * can name a geometry `drawableGeometries` never returns, which is the case it
 * exists for.
 */
const PENDING_TOOLS: Readonly<Record<string, string>> = {};

/**
 * What each drawing tool is called on the strip.
 *
 * Read off the product's one geometry vocabulary rather than kept here. This used
 * to be a private map saying `Box` while every other surface printed `bbox`, so
 * the same tool had two names depending on which side of the canvas you read it
 * from. `geometryLabel` is now the single source; this only capitalises, because
 * a control label takes a capital and a word inside a sentence does not.
 */
function toolLabel(geometry: GeometryType): string {
  const word = geometryLabel(geometry);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

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
   * — inert, and indistinguishable from a canvas with no tool strip at all.
   */
  readonly unavailable: string | null;
}

/**
 * The tools this schema can reach, `select` first.
 *
 * A geometry is represented by the **first** class declaring it, in authored
 * order, which is the same order `classHotkeys` binds the digit row in. Nothing
 * here dedupes by class: two bbox classes are one bbox tool.
 *
 * **`activeClass` narrows it.** With a class selected the strip offers only that
 * class's own geometries, because those are the only shapes a gesture could
 * produce — a bbox button that armed a different class the moment it was pressed
 * would answer "what can I draw here?" with something about somewhere else. With
 * none selected it is the union, which is what the strip has always shown and is
 * still the right answer to "what does this project label?".
 *
 * A class is only narrowed *to* when it can be drawn: selecting a pure tag class
 * leaves the full union rather than emptying the strip, since the tag lives in a
 * panel and the strip would otherwise vanish for a reason nothing on it explains.
 */
export function toolChoices(
  schema: AnnotationSchema,
  activeClass: string | null = null,
): readonly ToolChoice[] {
  const selected = schema.classes.find((declared) => declared.name === activeClass);
  const narrowed =
    selected !== undefined && drawableGeometries(selected).length > 0 ? selected : undefined;
  const offered = narrowed === undefined ? schema.classes : [narrowed];

  const choices: ToolChoice[] = [
    { tool: "select", label: "Select", labelClass: null, hotkey: "V", unavailable: null },
  ];
  for (const declared of offered) {
    for (const geometry of drawableGeometries(declared)) {
      if (choices.some((choice) => choice.tool === geometry)) continue;
      choices.push({
        tool: geometry,
        label: toolLabel(geometry),
        labelClass: declared.name,
        hotkey: hotkeyForClass(schema, declared.name) ?? "—",
        unavailable: null,
      });
    }
  }
  // After the usable tools, never interleaved: the strip reads top to bottom as
  // "what you can do", and a disabled control in the middle of that list reads as
  // a broken one rather than as a coming one.
  //
  // Read off `schema.classes` rather than `offered`, deliberately: a geometry with
  // no tool is a fact about the *project*, and hiding it while a class is selected
  // would make the explanation come and go with the selection.
  for (const declared of schema.classes) {
    for (const geometry of declared.geometries) {
      const pending = PENDING_TOOLS[geometry];
      if (pending === undefined) continue;
      if (choices.some((choice) => choice.tool === geometry)) continue;
      choices.push({
        tool: geometry,
        label: geometry,
        // No class to activate, because there is no tool to activate it for.
        labelClass: null,
        hotkey: "—",
        unavailable: pending,
      });
    }
  }
  return choices;
}

/** Whether the held class can produce this shape. `false` when it holds none. */
function accepts(
  schema: AnnotationSchema,
  activeClass: string | null,
  tool: ToolChoice["tool"],
): boolean {
  const declared = schema.classes.find((one) => one.name === activeClass);
  return declared !== undefined && drawableGeometries(declared).some((one) => one === tool);
}

export interface ToolPaletteProps {
  readonly schema: AnnotationSchema;
  /** What `toolFor` currently answers. Reported, never stored here. */
  readonly tool: Tool;
  /**
   * The class the strip is narrowed to, or `null` for the schema's whole union.
   *
   * The strip answers *what can I draw here*, and once a class accepts a set of
   * geometries the honest answer depends on which class is held.
   */
  readonly activeClass: string | null;
  readonly onActivateClass: (labelClass: string | null) => void;
  /**
   * Prefer this shape, among the ones the held class accepts.
   *
   * Separate from `onActivateClass` because pressing a tool now means two
   * different things depending on the class: within a class that accepts the
   * shape it is only a change of shape, and the class must **not** move — a strip
   * that re-armed the geometry's first declaring class would silently retarget
   * somebody's labels to a different class than the one they had selected.
   */
  readonly onActivateTool: (tool: Tool | null) => void;
  readonly onToggleHelp: () => void;
  /**
   * The suggest tool, or absent where the host cannot serve one.
   *
   * A prop rather than a row in `toolChoices`, because it is not a `Tool` and
   * must not be made to look like one: `tool.ts` derives the tool from the active
   * class and stores nothing, while suggest is a *mode* held beside the class it
   * borrows. Folding it into the list would put a stored mode in a derived one's
   * row and force `toolFor` to answer for something it cannot see.
   *
   * **Hidden, not disabled, when this schema declares no class that can hold a
   * suggestion** — the strip's own rule for a tool the schema
   * cannot reach, and the same mechanism that keeps a `classification_tag` off it.
   * A disabled sparkle over a tag-only schema would be promising a capability
   * that does not apply to this project rather than one that is coming.
   *
   * Absent as a whole for the `onOpenGallery` reason: a host with no API behind
   * it — the showcase — renders no control rather than a dead one.
   */
  readonly suggest?: {
    /** Whether the tool is armed. Held by the host, like the active class. */
    readonly active: boolean;
    readonly onToggle: () => void;
    /**
     * Why the armed tool cannot act right now, or `null` when it can.
     *
     * The *class* half of what the schema check above is the project half of: a
     * schema with no suggestible class hides the button, and a suggestible schema
     * sitting on a class that can hold nothing dims it and says so. Disabled-with-
     * reason rather than hidden, because unlike the schema case this is a
     * capability that comes back the moment the active class moves — a control
     * that vanished and reappeared as somebody worked down the class list would
     * be describing a project that keeps changing.
     */
    readonly unavailable?: string | null;
  };
  /**
   * Open the add-a-class dialog, or absent where there is nowhere to add
   * one — the demo has no project behind it. The `onOpenGallery` rule: a host
   * that cannot honour a control renders no control rather than a dead one.
   */
  readonly onAddClass?: () => void;
  /**
   * The command log's two steps, made visible.
   *
   * `mod+z` and `mod+shift+z` work whether or not anything draws them; what these
   * add is a way to *find out* that they do. Undo is the annotator's headline
   * capability over v1, and a person who did not already know the chord would
   * otherwise have no route to it.
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
  /**
   * The hand, and it is the one button here that is **not schema-gated**.
   *
   * Every other control on this strip is a question about the schema: which
   * geometries the declared classes can hold, whether any of them can hold a
   * suggestion. The hand is a question about the *device* — it exists because a
   * pan had exactly one spelling, a middle- or secondary-button drag, and a
   * trackpad, a tablet and a pen have no second button to offer. No schema makes
   * that more or less true, so `toolChoices` never sees it and it is never
   * absent.
   *
   * Required rather than optional, unlike `suggest` and `history`: those are
   * capabilities a host may not have behind it, and this is one every host
   * already has — the canvas implements it, not the page.
   *
   * **It and the derived tool are one lit button, not two.** While the hand is
   * on no tool row reads as active, and pressing any of them puts the hand down:
   * the canvas answers a primary press with a pan before the machine hears it,
   * so a tool lit beside a raised hand is one that cannot draw. The class half of
   * that is the host's — every route to a drawing class puts the hand away, one
   * funnel there rather than a rule repeated at each button here.
   *
   * The suggest button is deliberately **not** in this: it is a mode over the
   * class it borrows, it is legitimately on together with a tool, and dimming it
   * would make a press that turns it *off* look like one that turns it on.
   */
  readonly hand: {
    readonly active: boolean;
    readonly onToggle: () => void;
  };
  /**
   * A viewer, who may navigate and may not draw.
   *
   * The strip used to be absent entirely in this mode, and the reason it gave
   * was sound while it held: *"every control on the palette picks a drawing
   * tool, and a tool palette over a canvas that cannot be drawn on is not an
   * explanation of anything."* The hand is what retires it. Navigating a batch
   * somebody may not edit is most of what a viewer does, so the one control that
   * is not about drawing stays, with the shortcut sheet beside it, and every
   * control that *is* about drawing goes.
   */
  readonly readOnly?: boolean;
}

export function ToolPalette({
  schema,
  tool,
  activeClass,
  onActivateClass,
  onActivateTool,
  onToggleHelp,
  onAddClass,
  history,
  suggest,
  hand,
  readOnly = false,
}: ToolPaletteProps): JSX.Element {
  /**
   * The canvas keeps the focus.
   *
   * `AnnotatorCanvas` reads the keyboard off its own root, so a button that took
   * the focus would leave every chord dead until the user clicked back on the
   * picture — the same class of failure a removed shape causes when it takes the
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
      {!readOnly &&
        toolChoices(schema, activeClass).map((choice) => (
          <PaletteButton
            key={choice.tool}
            testId={`tool-${choice.tool}`}
            label={choice.unavailable ?? `${choice.label} (${choice.hotkey})`}
            active={!hand.active && tool === choice.tool}
            disabled={choice.unavailable !== null}
            onMouseDown={keepFocus}
            // (1) above: the tool did not move, so nothing moves — except that
            // putting the hand down *is* a move. Without the second line, Select
            // is unreachable from the hand on a page whose derived tool is
            // already `select`: the press is a no-op, so nothing clears the mode
            // and the only way back is to arm some other tool first.
            onClick={() => {
              if (choice.unavailable !== null) return;
              if (tool === choice.tool) {
                if (hand.active) hand.onToggle();
                return;
              }
              // The shape always. The class only when the one being held cannot
              // produce that shape — otherwise this is a change of tool inside
              // one class, and moving the class would be the retarget the
              // `onActivateTool` docstring warns about.
              onActivateTool(choice.tool === "select" ? null : (choice.tool as Tool));
              if (!accepts(schema, activeClass, choice.tool)) {
                onActivateClass(choice.labelClass);
              }
            }}
          >
            <ToolIcon tool={choice.tool} />
          </PaletteButton>
        ))}

      {/* After the drawing tools and before the `+`, because it is a way of
          drawing rather than a way of managing the schema — and a mode, so it is
          the one control here whose `active` is not `tool === choice.tool`. */}
      {!readOnly && suggest !== undefined && schemaCanSuggest(schema) && (
        <PaletteButton
          testId="tool-suggest"
          // The reason replaces the name, as it does for every other disabled
          // control on this strip: the tooltip is where a refusal is readable, so
          // a dimmed button still labelled "Suggest (S)" would be the bare
          // disabled state principle 9 names.
          label={suggest.unavailable ?? "Suggest (S)"}
          active={suggest.active}
          disabled={suggest.unavailable !== undefined && suggest.unavailable !== null}
          onMouseDown={keepFocus}
          onClick={suggest.onToggle}
        >
          <Sparkles className="size-4" />
        </PaletteButton>
      )}

      {/* Beside the tools, because "the class I need is not here" is a thought
          somebody has while looking at this strip — and a digit hotkey for the
          new class arrives free, since the palette *is* the hotkey order. */}
      {!readOnly && onAddClass !== undefined && (
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

      {/* Last in the block, below the `+`, and in the block rather than above it.
          It sat on top for a release, as the one control that does not draw —
          which read as a heading over the tools instead of as one of them, and
          the strip lit it *and* whichever tool was derived, so two buttons
          claimed to be on at once. It is a mode like the rest, so it takes its
          place among them and takes the lit state with it: while it is on,
          nothing else here is. */}
      <PaletteButton
        testId="tool-hand"
        label="Hand (H)"
        active={hand.active}
        onMouseDown={keepFocus}
        onClick={hand.onToggle}
      >
        <Hand className="size-4" />
      </PaletteButton>

      {!readOnly && history !== undefined && (
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

/**
 * The strip's own name for the shared glyph.
 *
 * The map moved to `GeometryIcon` when the armed class row started drawing the
 * same shapes — see that file for why it is one spelling rather than two.
 */
function ToolIcon({ tool }: { readonly tool: ToolChoice["tool"] }): JSX.Element {
  return <GeometryIcon tool={tool} />;
}
