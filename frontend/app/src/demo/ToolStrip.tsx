/**
 * The floating tool strip — `DESIGN.md`'s `AnnotationToolStrip`, at the showcase's
 * scale.
 *
 * ## A tool strip over a derived tool
 *
 * `core/interaction/tool.ts` is emphatic that the tool is **derived from the
 * active class and never stored**, and it is right: v1 held both and spent two
 * mechanisms keeping them from disagreeing. So this strip does not select a tool.
 * It *reports* the derived one and, when pressed, moves the active class to one
 * that derives the tool asked for — which is the only honest way to spell a tool
 * button over a store that has no tool.
 *
 * Two consequences fall out of that and are deliberate:
 *
 * 1. A press whose tool is **already active is a no-op**. The schema here declares
 *    two bbox classes; with `pedestrian` held, the box button is lit, and making
 *    it re-point the class at `vehicle` would silently change what the next shape
 *    is labelled. The tool did not move, so nothing moves.
 * 2. The strip shows only the tools **this schema can reach** — `select`, plus one
 *    button per distinct drawable geometry among the declared classes. It is built
 *    from `drawableGeometry`, the export `tool.ts` provides for exactly this: a
 *    `classification_tag` and a `polyline` both answer `null`, and neither gets a
 *    canvas tool. The demo's schema declares both, so both omissions are visible
 *    rather than theoretical.
 *
 *    The two answers are `null` for different reasons, and the product strip in
 *    `@visionset/ui-core` distinguishes them: a tag has nothing to draw and never
 *    will, while `polyline` has a geometry and no tool *yet* (#342), so there it
 *    is a disabled button carrying the reason. This showcase keeps the plain
 *    omission on purpose — it demonstrates that the engine ships headless, and
 *    "what a product does about a missing tool" is a product decision it is not
 *    the job of a demo to make.
 *
 * ## The icons are hand-drawn, and that is a deferral rather than a preference
 *
 * `DESIGN.md` pins lucide-react (MousePointer2 / Square / Spline) and #128 is the
 * task that installs it. Adding a dependency to `@visionset/app` so a demo can
 * draw three glyphs would put the choice in the wrong milestone, so these are
 * three inline paths at lucide's 24-unit grid and 2px stroke. They are replaced,
 * not extended, when the real icon set arrives.
 */

import { drawableGeometry, hotkeyForClass } from "@visionset/annotator";
import type { AnnotationSchema, Tool } from "@visionset/annotator";
import type { CSSProperties, JSX, MouseEvent, ReactNode } from "react";

import { COLOR, RADIUS, SHADOW, SPACE, TEXT } from "./theme";

/** A schema's tools, in the order the strip lists them. */

/**
 * What each drawing tool is called. Total over what `drawableGeometry` answers, so
 * a fourth geometry gaining a tool cannot reach the strip unnamed — which is what
 * the ternary this replaced let `polyline` do, silently reading "Polygon" (#342).
 *
 * The showcase keeps its own strip on purpose (see `ToolPalette.tsx`), so this is
 * a second table rather than an import; what it must not be is a second *rule*,
 * and it is not — `drawableGeometry` is still the only thing deciding which tools
 * exist.
 */
const TOOL_LABELS: Readonly<Record<"bbox" | "polygon" | "polyline", string>> = {
  bbox: "Box",
  polygon: "Polygon",
  polyline: "Polyline",
};

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
function toolChoices(schema: AnnotationSchema): readonly ToolChoice[] {
  const choices: ToolChoice[] = [
    { tool: "select", label: "Select", labelClass: null, hotkey: "V" },
  ];
  for (const declared of schema.classes) {
    const geometry = drawableGeometry(declared);
    if (geometry === null) continue;
    if (choices.some((choice) => choice.tool === geometry)) continue;
    choices.push({
      tool: geometry,
      label: TOOL_LABELS[geometry],
      labelClass: declared.name,
      hotkey: hotkeyForClass(schema, declared.name) ?? "—",
    });
  }
  return choices;
}

export interface ToolStripProps {
  readonly schema: AnnotationSchema;
  /** What `toolFor` currently answers. Reported, never stored here. */
  readonly tool: Tool;
  readonly onActivateClass: (labelClass: string | null) => void;
  readonly onToggleHelp: () => void;
  /** Keeps the canvas focused when a button is pressed. */
  readonly onMouseDown: (event: MouseEvent) => void;
}

export function ToolStrip({
  schema,
  tool,
  onActivateClass,
  onToggleHelp,
  onMouseDown,
}: ToolStripProps): JSX.Element {
  const choices = toolChoices(schema);

  return (
    <div style={STRIP} data-testid="tool-strip">
      {choices.map((choice) => (
        <IconButton
          key={choice.tool}
          testId={`tool-${choice.tool}`}
          title={`${choice.label} (${choice.hotkey})`}
          active={tool === choice.tool}
          onMouseDown={onMouseDown}
          // (1) above: the tool did not move, so nothing moves.
          onClick={() => tool !== choice.tool && onActivateClass(choice.labelClass)}
        >
          <ToolIcon tool={choice.tool} />
        </IconButton>
      ))}
      <div style={DIVIDER} />
      <IconButton
        testId="tool-help"
        title="Shortcuts (?)"
        active={false}
        onMouseDown={onMouseDown}
        onClick={onToggleHelp}
      >
        <HelpIcon />
      </IconButton>
    </div>
  );
}

const STRIP: CSSProperties = {
  position: "absolute",
  left: SPACE.md,
  top: "50%",
  transform: "translateY(-50%)",
  width: 48,
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: SPACE.xs,
  padding: SPACE.sm,
  background: COLOR.muted,
  border: `1px solid ${COLOR.border}`,
  borderRadius: RADIUS.lg,
  boxShadow: SHADOW.overlay,
};

const DIVIDER: CSSProperties = {
  width: 24,
  height: 1,
  background: COLOR.border,
  margin: `${SPACE.xs}px 0`,
};

interface IconButtonProps {
  readonly testId: string;
  readonly title: string;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly onMouseDown: (event: MouseEvent) => void;
  readonly children: ReactNode;
}

/** 36px, ghost when idle and the accent when active — `DESIGN.md`'s tool strip. */
function IconButton({
  testId,
  title,
  active,
  onClick,
  onMouseDown,
  children,
}: IconButtonProps): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      data-testid={testId}
      data-active={active ? "true" : "false"}
      onMouseDown={onMouseDown}
      onClick={onClick}
      style={{
        width: 36,
        height: 36,
        display: "grid",
        placeItems: "center",
        padding: 0,
        borderRadius: RADIUS.md,
        border: active ? `1px solid ${COLOR.primary}` : "1px solid transparent",
        background: active ? COLOR.primary : "transparent",
        color: active ? COLOR.background : COLOR.mutedForeground,
        cursor: "pointer",
        font: "inherit",
      }}
    >
      {children}
    </button>
  );
}

/** lucide's grid and stroke, three paths of it. See the header note. */
function ToolIcon({ tool }: { readonly tool: Tool }): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {tool === "select" && <path d="M5 3l14 8-6.5 1.8L10 20z" />}
      {tool === "bbox" && <rect x="3" y="3" width="18" height="18" rx="2" />}
      {tool === "polygon" && <path d="M12 3l9 6.5-3.5 10.5h-11L3 9.5z" />}
    </svg>
  );
}

function HelpIcon(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.2a2.6 2.6 0 1 1 3.4 2.5c-.6.2-.9.8-.9 1.4v.4" />
      <path d="M12 17.2h.01" />
    </svg>
  );
}

/** The zoom readout. `DESIGN.md` puts a percent between −/+; #56 adds the pair. */
export function ZoomBadge({ zoom }: { readonly zoom: number }): JSX.Element {
  return (
    <div
      data-testid="zoom-readout"
      style={{
        position: "absolute",
        right: SPACE.md,
        bottom: SPACE.md,
        // Never a pointer target. A readout that swallowed a press would be a
        // corner of the image nobody could annotate, and this suite's coordinates
        // are in *asset* pixels — they cannot see where a badge landed.
        pointerEvents: "none",
        padding: `${SPACE.xs}px ${SPACE.sm}px`,
        borderRadius: RADIUS.full,
        background: COLOR.muted,
        border: `1px solid ${COLOR.border}`,
        color: COLOR.mutedForeground,
        fontVariantNumeric: "tabular-nums",
        ...TEXT.meta,
      }}
    >
      {Math.round(zoom * 100)}%
    </div>
  );
}
