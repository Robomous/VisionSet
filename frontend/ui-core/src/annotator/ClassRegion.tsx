/**
 * The workspace panel's upper region: **the schema's classes, always on screen**.
 *
 * ## Why a list and not a dropdown
 *
 * A combobox on the top bar reads as right — the drawing class is the most-used
 * control on the page and the eye is already up there. What that misses is
 * *what is being chosen between*: the classes are the ontology,
 * and a picker keeps all of them one click away, so the answer to "what can I
 * draw here" was never on screen. A list shows the ontology and — stacked over
 * the objects region — puts it beside the things drawn from it, which are the two
 * surfaces an annotator alternates between.
 *
 * It also removes a defect rather than moving one. A top-bar combobox is clipped
 * by the fixed-width reservation it sits in: the popup is
 * `position: absolute` at `top-9` inside a 32px-tall `overflow-hidden` slot, so
 * the listbox renders entirely outside its clip and never appears. A list in a
 * region that scrolls has no popup to clip.
 *
 * ## The height rule, and why it is stated in rows
 *
 * Three rows' worth of height minimum, one row per class after that, eight rows
 * maximum — then the region is fixed and the list scrolls inside it. Small
 * schemas get a region proportional to what they hold instead of a fixed box with
 * five empty rows in it, and large ones cannot push the objects region off the
 * bottom of the panel.
 *
 * **It is computed from the schema's drawable class count, never from the
 * filtered one.** A height that tracked the filter would resize this region — and
 * reflow the objects region under it — on every keystroke, which is the same
 * controls-moving-under-the-cursor problem the top bar's constant widths exist to
 * prevent. So typing narrows the list inside a region that does not move.
 *
 * A row may take **two** lines — a long name pushes its chips under itself — and
 * the rule does not know which rows those are. Knowing would take a measurement;
 * a wrapped row is absorbed by the scroller instead, exactly as a ninth class is.
 *
 * ## Only classes something can be drawn with
 *
 * A class declaring nothing but `classification_tag` is not listed here: it has
 * no canvas gesture, and the Tags section below is where it is assigned. The
 * height rule reads the same count, so it does not size a region it has no row in.
 *
 * ## Hotkeys are the schema's order and nothing else's
 *
 * `hotkeyForClass` is the one derivation — schema position, capped at nine — so
 * the badge on a row and the digit the input layer claims cannot disagree.
 * Filtering deliberately does **not** remap them: a digit whose meaning depended
 * on what was typed in a filter box would be a keystroke nobody could predict, and
 * the badge is on the row precisely so the mapping is read rather than memorised.
 */

import {
  drawableGeometries,
  hotkeyForClass,
  toolForClass,
  type AnnotationSchema,
  type LabelClass,
  type Tool,
} from "@visionset/annotator";
import { Plus } from "lucide-react";
import { useState, type JSX, type RefObject } from "react";

import { formatGeometries, geometryLabel } from "../data/geometryCategory";
import { classColor } from "../palette";
import { Button } from "../primitives/button";
import { Input } from "../primitives/Input";
import { CLASS_ROW_PX, ClassListRow } from "../patterns/DataDisplay";

/** The fewest rows' worth of height the region ever takes. */
export const MIN_CLASS_ROWS = 3;
/** The most rows shown before the list scrolls inside a fixed region. */
export const MAX_CLASS_ROWS = 8;

/**
 * How tall the list viewport is, in pixels, for a schema of `classes` classes.
 *
 * Exported and pure so the rule is testable as arithmetic rather than only
 * through a rendered box — jsdom has no layout, so a component test can assert
 * the style this returns but never the pixels a browser would draw.
 */
export function classListHeight(classes: number): number {
  const rows = Math.min(Math.max(classes, MIN_CLASS_ROWS), MAX_CLASS_ROWS);
  return rows * CLASS_ROW_PX;
}

export interface ClassRegionProps {
  readonly schema: AnnotationSchema;
  /** The drawing class, or `null` for select mode — the tool palette's `V`. */
  readonly activeClass: string | null;
  readonly onActivateClass: (labelClass: string) => void;
  /**
   * Which of the armed class's shapes the next drag produces, and how to change
   * it — the same pair `ToolPalette` takes, held once by the page.
   *
   * Here because arming a class stopped answering it. A class accepting a set has
   * no single implied tool, and until this the only place that answer lived was
   * the strip at the **far left** of the canvas while the class was chosen on the
   * right: one decision split across the width of the picture, in a loop repeated
   * hundreds of times a job. Optional, so a host with no tool state renders the
   * region as a pure list.
   */
  readonly activeTool?: Tool | null;
  readonly onActivateTool?: (tool: Tool) => void;
  /**
   * Focus target for `c`, held by the page because the keystroke arrives at the
   * canvas's own keyboard root and not at anything in this tree.
   */
  readonly filterRef?: RefObject<HTMLInputElement | null>;
  /**
   * Open the add-a-class dialog, seeded with a name, or absent where there is
   * nowhere to add one.
   *
   * The argument is what the filter had in it, so the no-match row can hand over
   * what somebody typed — the WS4 prefill, relocated. `+` in the header passes
   * the empty string: it means *I want a class*, not a particular one, and
   * carrying the last opening's name into it would be a prefill nobody asked for.
   */
  readonly onAddClass?: (name: string) => void;
}

export function ClassRegion({
  schema,
  activeClass,
  onActivateClass,
  activeTool = null,
  onActivateTool,
  filterRef,
  onAddClass,
}: ClassRegionProps): JSX.Element {
  const [filter, setFilter] = useState("");

  /**
   * The classes this region is about: the ones something can be drawn with.
   *
   * A tag-only class has no canvas gesture, so a row here would arm a tool the
   * canvas cannot answer. Everything below counts from this, so it does not size
   * the region either. `hotkeyForClass` is deliberately not derived from it —
   * digits are schema positions and the tag chips show the same ones.
   */
  const drawableClasses = schema.classes.filter(
    (declared) => drawableGeometries(declared).length > 0,
  );

  const query = filter.trim().toLowerCase();
  const shown = drawableClasses.filter((declared) =>
    declared.name.toLowerCase().includes(query),
  );

  /**
   * The name a "create it" row would carry, or null for no such row.
   *
   * Only when something was typed **and** nothing matched: an always-present
   * create row would put a schema change one stray Enter away from somebody who
   * was picking a class. An exact match suppresses it too, so the row never sits
   * under the very class it offers to add.
   */
  const creatable =
    onAddClass === undefined || query === "" || shown.length > 0 ? null : filter.trim();

  /**
   * Enter takes the first match, which is the typeahead the top-bar field had.
   *
   * The *first shown* rather than the active class or an exact match: somebody
   * who typed enough to narrow the list to one row means that row, and a
   * requirement to arrow down to it first would make the fast path slower than
   * the list it replaced.
   */
  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const first = shown[0];
    // Nothing matched what was typed, so Enter means the row that is actually
    // on screen — creating it. The same fallthrough the top-bar field had, and
    // the reason the create row is a row rather than a button underneath: it is
    // reachable by the keys that reach every other one.
    if (first === undefined) {
      if (creatable !== null) onAddClass?.(creatable);
      return;
    }
    onActivateClass(first.name);
  }

  return (
    <div className="flex shrink-0 flex-col gap-2" data-testid="class-region">
      <div className="flex items-center justify-between px-1">
        <span className="text-sm font-medium">Classes</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground" data-testid="class-count">
            {drawableClasses.length} class{drawableClasses.length === 1 ? "" : "es"}
          </span>
          {/* The same dialog the tool strip's `+` opens, with the same session
              semantics — one session publishes one version, and the
              save→publish→repin chain is the page's. Reached from here now
              because this is where somebody looking at the ontology notices it
              is missing something. */}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Add a class"
            data-testid="class-add"
            disabled={onAddClass === undefined}
            onClick={() => onAddClass?.("")}
          >
            <Plus className="size-4" />
          </Button>
        </div>
      </div>

      {/* The objects filter's pattern, one region up. Client-side and instant:
          the schema is already in hand, so a round trip would be a spinner in
          front of an answer the page is holding. */}
      <Input
        ref={filterRef}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Filter classes…"
        aria-label="Filter classes"
        data-testid="class-filter"
        className="h-8"
      />

      {drawableClasses.length === 0 ? (
        // An invitation rather than an empty list: a project with no classes yet
        // cannot draw anything, and a list showing nothing explains none of that.
        <p
          className="px-1 py-4 text-center text-xs text-muted-foreground"
          data-testid="classes-empty"
        >
          No classes yet — add one to start drawing.
        </p>
      ) : (
        <div
          className="overflow-y-auto"
          // The one inline dimension in this file, and it is arithmetic rather
          // than a token: the rule is *rows*, and no utility names a multiple of
          // a row height. `classListHeight` is the single spelling of it.
          style={{ height: `${classListHeight(drawableClasses.length)}px` }}
          data-testid="class-list"
          data-rows={Math.min(Math.max(drawableClasses.length, MIN_CLASS_ROWS), MAX_CLASS_ROWS)}
        >
          {shown.length === 0 && creatable === null ? (
            <p
              className="px-1 py-4 text-center text-xs text-muted-foreground"
              data-testid="classes-no-match"
            >
              No class matches that filter.
            </p>
          ) : (
            shown.map((declared) => (
              <ClassRow
                key={declared.name}
                declared={declared}
                schema={schema}
                selected={declared.name === activeClass}
                onSelect={() => onActivateClass(declared.name)}
                activeTool={activeTool}
                {...(onActivateTool === undefined ? {} : { onActivateTool })}
              />
            ))
          )}
          {creatable !== null && (
            <button
              type="button"
              data-testid="class-create"
              className="flex h-9 w-full shrink-0 items-center gap-2 border-t border-border px-3 text-left text-sm text-muted-foreground hover:bg-muted"
              onClick={() => onAddClass?.(creatable)}
            >
              <Plus className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">Create class “{creatable}”</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ClassRow({
  declared,
  schema,
  selected,
  onSelect,
  activeTool,
  onActivateTool,
}: {
  readonly declared: LabelClass;
  readonly schema: AnnotationSchema;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly activeTool: Tool | null;
  readonly onActivateTool?: (tool: Tool) => void;
}): JSX.Element {
  /**
   * The shapes this row offers, each one a press target.
   *
   * Every row, not only the armed one: a chip that also arms its class turns
   * "this class, then that shape" into one press. The only condition left is a
   * host that takes the answer, since a picker nothing listens to is worse than
   * none.
   *
   * `drawableGeometries` rather than `geometries` — a tag has no canvas gesture,
   * and the Tags section is where it is assigned.
   */
  const drawable = drawableGeometries(declared);
  const picker =
    onActivateTool === undefined
      ? undefined
      : drawable.map((tool) => ({
          value: tool,
          // The word, not a glyph. A square, a spline and a waypoint node are not
          // self-describing at this size on the one row whose job is telling
          // shapes apart; the strip can afford them because it is five controls
          // learned once. The display word, never the wire value.
          label: geometryLabel(tool),
          // Lit only on the armed row — a chip drawn as chosen on a class nothing
          // is armed to would claim a state the canvas is not in. Through
          // `toolForClass`, because the held tool may be one this class forbids
          // and the lit chip must be the shape that would actually be drawn.
          active: selected && toolForClass(declared, activeTool) === tool,
          onPick: () => {
            // Arm and choose in one press. The guard keeps them separable:
            // changing the shape must never move the class, and a rule enforced
            // by a no-op is a rule no test can watch fail.
            if (!selected) onSelect();
            onActivateTool(tool);
          },
        }));
  return (
    <ClassListRow
        testId={`class-row-${declared.name}`}
        name={declared.name}
        // The fallback for a host with no tool state, so it renders a plain list.
        // Drawable only, like the chips.
        geometry={formatGeometries(drawable)}
        {...(picker === undefined || picker.length === 0 ? {} : { shapes: picker })}
        // `classColor` — schema colour first, else a hash of the name — is the
        // single spelling, shared with the canvas, so a swatch here and a box out
        // there are the same colour by construction rather than by two formulas
        // agreeing.
        color={classColor(declared, declared.name)}
        hotkey={hotkeyForClass(schema, declared.name)}
        selected={selected}
        onSelect={onSelect}
      />
  );
}
