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
 * `PENDING_TOOLS` holds `mask`. The rule it encodes — *declared but not drawable
 * is disabled-with-reason, never absent* — is why a schema declaring `mask` gets a
 * disabled button, and `keypoints` takes the same path the day a schema declares one.
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

import { schemaCanSuggest, type AnnotationSchema, type Tool } from "@visionset/annotator";

import { CircleHelp, Eye, EyeOff, Hand, Redo2, Sparkles, Undo2 } from "lucide-react";

import { GeometryIcon } from "./GeometryIcon";
import { keepCanvasFocus } from "./keepCanvasFocus";
import { accepts, toolChoices, type ToolChoice } from "./toolChoices";
import type { JSX, MouseEvent, ReactNode } from "react";

import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from "@robomous/ui-core";

export interface ToolPaletteProps {
  /**
   * `floating` is the card over the picture the showcase uses; `rail` is the
   * editor's fixed tool column, flush with the page, with the help at its foot.
   */
  readonly layout?: "floating" | "rail";
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
   * Hide or show every object on the picture at once — the same view state the
   * panel's per-row eyes write, all hidden ↔ none hidden.
   *
   * A way of *looking*, not of drawing, so it stays in the read-only mode with
   * the hand and the shortcut sheet. Optional: a host with no object list to
   * hide from (the showcase) renders none rather than a dead one. `empty` is a
   * frame with nothing on it, where the button is disabled with that reason.
   */
  readonly visibility?: {
    readonly allHidden: boolean;
    readonly empty: boolean;
    readonly onToggle: () => void;
  };
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
  visibility,
  history,
  suggest,
  hand,
  readOnly = false,
  layout = "floating",
}: ToolPaletteProps): JSX.Element {
  return (
    <div
      data-testid="tool-palette"
      data-layout={layout}
      className={
        layout === "rail"
          ? "flex h-full w-12 flex-col items-center gap-1 py-2"
          : "absolute left-3 top-3 flex w-12 flex-col items-center gap-1 rounded-xl border border-border bg-muted p-2 shadow-lg"
      }
    >
      {!readOnly &&
        toolChoices(schema, activeClass).map((choice) => (
          <PaletteButton
            key={choice.tool}
            testId={`tool-${choice.tool}`}
            label={choice.unavailable ?? `${choice.label} (${choice.hotkey})`}
            active={!hand.active && tool === choice.tool}
            disabled={choice.unavailable !== null}
            onMouseDown={keepCanvasFocus}
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

      {/* After the drawing tools, because it is a way of drawing — and a mode, so it is
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
          onMouseDown={keepCanvasFocus}
          onClick={suggest.onToggle}
        >
          <Sparkles className="size-4" />
        </PaletteButton>
      )}

      {/* Last in the block, and in the block rather than above it.
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
        onMouseDown={keepCanvasFocus}
        onClick={hand.onToggle}
      >
        <Hand className="size-4" />
      </PaletteButton>

      {!readOnly && history !== undefined && <HistoryButtons history={history} />}

      {/* In the rail the help sits at the foot, out of the tools' run — with the
          objects' visibility above it, the other control about looking. */}
      <div className={layout === "rail" ? "mt-auto" : "my-1 h-px w-6 bg-border"} />

      {visibility !== undefined && <VisibilityButton visibility={visibility} />}

      <PaletteButton
        testId="tool-help"
        label="Shortcuts (?)"
        active={false}
        onMouseDown={keepCanvasFocus}
        onClick={onToggleHelp}
      >
        <CircleHelp className="size-4" />
      </PaletteButton>
    </div>
  );
}

/** The command log's two steps — disabled *with the reason*, see `history`. */
function HistoryButtons({
  history,
}: {
  readonly history: NonNullable<ToolPaletteProps["history"]>;
}): JSX.Element {
  return (
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
        onMouseDown={keepCanvasFocus}
        onClick={history.onUndo}
      >
        <Undo2 className="size-4" />
      </PaletteButton>
      <PaletteButton
        testId="tool-redo"
        label={history.canRedo ? "Redo (\u21e7\u2318Z)" : "Nothing to redo"}
        active={false}
        disabled={!history.canRedo}
        onMouseDown={keepCanvasFocus}
        onClick={history.onRedo}
      >
        <Redo2 className="size-4" />
      </PaletteButton>
    </>
  );
}

/** Hide or show every object — see `visibility`. Pressed while all are hidden. */
function VisibilityButton({
  visibility,
}: {
  readonly visibility: NonNullable<ToolPaletteProps["visibility"]>;
}): JSX.Element {
  const label = visibility.empty
    ? "No objects to hide"
    : visibility.allHidden
      ? "Show all objects"
      : "Hide all objects";
  return (
    <PaletteButton
      testId="tool-visibility"
      label={label}
      active={visibility.allHidden}
      disabled={visibility.empty}
      onMouseDown={keepCanvasFocus}
      onClick={visibility.onToggle}
    >
      {visibility.allHidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
    </PaletteButton>
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
          // A surface step, not a fill: the frame's verb is the screen's one
          // filled control.
          variant="ghost"
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
          className={cn(
            active && "bg-muted text-foreground ring-1 ring-inset ring-foreground/10",
            disabled && "cursor-not-allowed opacity-40",
          )}
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
 * The map lives in `GeometryIcon`, so one glyph per geometry is decided once
 * rather than at each call site.
 */
function ToolIcon({ tool }: { readonly tool: ToolChoice["tool"] }): JSX.Element {
  return <GeometryIcon tool={tool} />;
}
