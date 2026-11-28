/**
 * The annotation page's right-hand panel: **Classes, Tags, Annotations** — three
 * stacked regions — and, on a frame of a sequence source, the page's Tracks
 * region under them.
 *
 * ## Why it is here and not in `@visionset/annotator`
 *
 * It lands in `ui-core` because the annotator's whole
 * claim is that it *"owns no UI a product would want to restyle"* — it ships
 * headless, with no Tailwind and no design tokens, and a styled panel inside
 * `adapters/react` would be the first thing an embedder had to fight. `ui-core`
 * already depends on the annotator (for `classColor`), so the dependency runs the
 * right way.
 *
 * The *capability* the panel needs went the other way, and had to: hiding an
 * object must remove it from the **hit test** as well as the drawing, and only the
 * canvas owns the document the machine tests against. So `AnnotatorCanvas` grew a
 * `hiddenIds` prop and this panel drives it. The split is: the annotator gained an
 * ability, `ui-core` gained the UI.
 *
 * ## Three regions, no tabs, and no splitter
 *
 * There are no **Objects | Labels** tabs. A tab claims two things are
 * alternatives; these are three answers about one frame, read in order — *what
 * may I draw*, *what is true of the whole picture*, *what have I drawn*.
 *
 * Tags used to be a chip strip *inside* the objects region, under a heading that
 * named the rows below them and not the chips. Worse, the list was every
 * annotation in the document, so each tag was *also* a row — counted as an
 * object, with a hide button that hides nothing and a reassignment menu onto
 * classes that cannot hold it.
 *
 * The splits are a rule, not a handle. `ClassRegion` sizes itself in rows,
 * `TagRegion` is capped, and the objects region takes what is left; each scrolls
 * inside itself. **A region with nothing to show is not rendered**, and its
 * divider goes with it — a heading over an empty box claims something is missing.
 * Annotations is the exception: an empty frame is the normal state of a fresh
 * one, and it says so in words. Its filter renders even with nothing drawn,
 * because a control that appears once a list is long enough is one nobody finds.
 *
 * ## Every write goes through a command
 *
 * Delete uses `removeAnnotationsCommand`, the same path the keyboard takes, so
 * the keyboard's guards cannot diverge — including the one that reads oddly until you know
 * why: an identity command still goes through `store.execute`, which drops a staged
 * preview, so a delete of nothing must not be executed at all.
 *
 * Class reassignment uses `replaceAnnotationCommand`, so it lands in the history and
 * undo takes it back like anything else. It is offered per row rather than for the
 * selection, which is the one thing about it this file still decides — everything
 * else lives in `ReassignMenu.tsx`, because the same picker has a second
 * anchor on the canvas and a rule with two spellings is a rule that drifts. The
 * row's anchor is the class name itself: the thing being changed is the control.
 *
 * An attribute edit is the same command with new `attributes` — one change, one
 * history entry — built by `withAttribute` (`attributes.ts`); `AttributeControls.tsx`
 * renders the selected row's controls. Required is shown, never enforced: the kernel's
 * `MissingRequiredAttribute` is the rule, and a dot beside a name is not a second one.
 *
 * Applied on selection rather than behind an **Apply**, which the card this replaces
 * needed and a menu does not: a Radix menu highlights on arrow and commits only on
 * Enter or a click, so there is no per-keystroke state to keep out of the history.
 *
 * ## No new core state and no new events
 *
 * Everything below is a command or a projection that already existed. Visibility is
 * the one piece of new state and it lives *beside* the store, exactly where the
 * adapter's own `skipId` and `hotId` live; the filter is view state of the same
 * kind, held here and travelling nowhere.
 */

import {
  annotationsInDrawOrder,
  classNamed,
  drawableGeometries,
  hotkeyForClass,
  isTagAnnotation,
  isTaggableClass,
  randomUuid,
  reassignedAnnotation,
  removeAnnotationsCommand,
  replaceAnnotationCommand,
  selectOnly,
  taggedClassNames,
  toggleTagCommand,
  type Annotation,
  type AnnotationSchema,
  type AnnotatorStore,
  type AttributeValue,
  type LabelClass,
  type ScanAnnotation,
  type ScanDocument,
  type Tool,
} from "@visionset/annotator";
import { useAnnotatorSnapshot } from "@visionset/annotator/react";
import { Check, ChevronDown, Eye, EyeOff, Route, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type JSX, type ReactNode, type RefObject } from "react";

import { geometryLabel } from "../data/geometryCategory";
import { classColor } from "../palette";
import { Badge, Button, DropdownMenu, DropdownMenuTrigger, Input, Kbd, Tooltip, TooltipContent, TooltipTrigger, cn } from "@robomous/ui-core";
import { AttributeControls, NeedsValueDot } from "./AttributeControls";
import { missingRequired, rowSummary, withAttribute } from "./attributes";
import { ClassRegion } from "./ClassRegion";
import { keepCanvasFocus } from "./keepCanvasFocus";
import { ReassignMenu, type ClassLock } from "./ReassignMenu";
import { VertexRegion } from "./VertexRegion";
import type { WireAnnotation } from "./jobQueries";

function geometryLabel3D(geometry: unknown): string {
  return (geometry as { readonly type?: unknown } | null)?.type === "polyline_3d"
    ? geometryLabel("polyline_3d")
    : geometryLabel("cuboid_3d");
}

export interface AnnotatorPanelProps {
  /**
   * `card` is the bordered column the showcase floats beside its stage;
   * `flush` is the editor's inspector, where the column itself is the surface.
   */
  readonly layout?: "card" | "flush";
  readonly store: AnnotatorStore;
  /** Held by the page, because the canvas needs the same set. */
  readonly hiddenIds: ReadonlySet<string>;
  readonly onHiddenChange: (hidden: ReadonlySet<string>) => void;
  /**
   * The document is displayed and cannot be changed.
   *
   * The panel is the *other* road into the document — delete a row, reassign a
   * class, toggle a tag — so a read-only canvas with a live panel is a read-only
   * mode with a hole in it. Visibility toggles stay live either way: hiding is a
   * **view** decision the core document has no field for, which is the same
   * argument `visibility.ts` makes for why it must never travel to the API.
   */
  readonly readOnly?: boolean;
  /**
   * The drawing class, and the one way to change it.
   *
   * Held by the page, so the canvas, the tool strip, a digit hotkey and this
   * list all land on one callback. A panel that owned the value would be a
   * second road to a setting with one owner; a panel that renders somebody
   * else's value is a view of it.
   */
  readonly activeClass: string | null;
  readonly onActivateClass: (labelClass: string) => void;
  /** Which shape the armed class draws, and how to change it. See `ClassRegion`. */
  readonly activeTool?: Tool | null;
  readonly onActivateTool?: (tool: Tool) => void;
  /** Focus target for `c`. See `ClassRegion`. */
  readonly classFilterRef?: RefObject<HTMLInputElement | null>;
  /** Open the add-a-class dialog, or absent where there is nowhere to add one. */
  readonly onAddClass?: (name: string) => void;
  /**
   * A scan's 3D labels when no scan editor holds them, listed and counted
   * read-only.
   */
  readonly labels3D?: readonly WireAnnotation[];
  /**
   * A scan's cuboids and polylines, from the scan editor's store: a row selects its label, and
   * deletes it through the same command log as the keyboard, unless `readOnly`
   * or the scan cannot be edited.
   */
  readonly scan?: {
    readonly store: AnnotatorStore<ScanDocument>;
    readonly onRemove: ((id: string) => void) | null;
  } | null;
  /**
   * Hand the keyboard back to the view after a row selects, so its keys act on
   * the selection. The page owns the view, so it owns the way to focus it.
   */
  readonly onReturnFocus?: () => void;
  /**
   * The Tracks region, composed by the page: it reads tracks off the wire,
   * which this panel never does. Absent for a frame that is not part of a
   * sequence source.
   */
  readonly tracks?: ReactNode;
  /** For each drawn object a track observes, by its id in the document: what to call the track, and how to show it. */
  readonly trackMarks?: ReadonlyMap<string, TrackMark>;
  /** For each drawn object a track observes, by its id in the document: the class it keeps. */
  readonly classLocks?: ReadonlyMap<string, ClassLock>;
}

/** That an object is on a track — the track's name and where, and the way to open it in the Tracks region. */
export interface TrackMark {
  readonly label: string;
  readonly onShow: () => void;
}

const NO_TRACK_MARKS: ReadonlyMap<string, TrackMark> = new Map();
const NO_CLASS_LOCKS: ReadonlyMap<string, ClassLock> = new Map();

export function AnnotatorPanel({
  store,
  hiddenIds,
  onHiddenChange,
  readOnly = false,
  activeClass,
  onActivateClass,
  activeTool,
  onActivateTool,
  classFilterRef,
  onAddClass,
  labels3D = [],
  scan = null,
  layout = "card",
  onReturnFocus,
  tracks,
  trackMarks = NO_TRACK_MARKS,
  classLocks = NO_CLASS_LOCKS,
}: AnnotatorPanelProps): JSX.Element {
  const snapshot = useAnnotatorSnapshot(store);
  const scanSnapshot = useAnnotatorSnapshot(scan?.store ?? null);
  const [filter, setFilter] = useState("");

  /**
   * What is on the picture — and tags are not.
   *
   * The row numbers come from this list, so they are the drawn shapes' own 1..N.
   */
  const drawn = annotationsInDrawOrder(snapshot.document).filter(
    (annotation) => !isTagAnnotation(annotation),
  );
  const schema = snapshot.document.schema;
  const tagClasses = schema.classes.filter(isTaggableClass);
  // The composer asks, rather than `ClassRegion` hiding itself, because the split
  // rule below goes with the region.
  // A scan draws only through the scan editor's own class picker; these tools draw on pixels.
  const drawableClasses =
    snapshot.document.asset.modality === "point_cloud"
      ? []
      : schema.classes.filter((declared) => drawableGeometries(declared).length > 0);

  const query = filter.trim().toLowerCase();
  // Numbered by **draw order**, never by position in the filtered list: the number
  // is the object's identity on the canvas, and renumbering it as somebody types
  // would make the panel and the picture disagree about which one is "3".
  const rows = drawn
    .map((annotation, index) => ({ annotation, index }))
    .filter((row) => row.annotation.label_class.toLowerCase().includes(query));

  const cuboids = scanSnapshot === null ? [] : [...scanSnapshot.document.annotations.values()];
  const cuboidRows = cuboids
    .map((annotation, index) => ({ annotation, index: drawn.length + index }))
    .filter((row) => row.annotation.label_class.toLowerCase().includes(query));
  const rows3D = labels3D
    .map((label, index) => ({ label, index: drawn.length + cuboids.length + index }))
    .filter((row) => row.label.label_class.toLowerCase().includes(query));
  const total = drawn.length + cuboids.length + labels3D.length;

  const lane =
    snapshot.selection.size === 1
      ? drawn.find((one) => snapshot.selection.has(one.id) && one.geometry.type === "polyline")
      : undefined;

  function toggleHidden(id: string): void {
    const next = new Set(hiddenIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onHiddenChange(next);
  }

  function remove(id: string): void {
    // The same path the keyboard takes, so the command's label and the history
    // entry read identically however the delete was asked for.
    //
    // Guarded on the annotation still being there rather than on the command being
    // non-null — `removeAnnotationsCommand` always returns one, and executing an
    // identity command still drops a staged preview — the same trap
    // `delete-selection` has, seen from the panel.
    if (!store.document.annotations.has(id)) return;
    store.execute(removeAnnotationsCommand([id]));
  }

  function reassign(annotation: Annotation, labelClass: string): void {
    // Same class is the identity, and an identity command still drops a staged
    // preview — the `remove` guard's reason, one row over.
    //
    // Deliberately **no** `readOnly` check here: this function is only handed to a
    // row when the document can be written, so one would be unreachable — and an
    // unreachable guard is worse than none, because it makes the reachable one
    // untestable. Removing the real enforcement would then turn no test red, since
    // the second copy silently keeps the behaviour correct.
    if (labelClass === annotation.label_class) return;
    store.execute(
      replaceAnnotationCommand(reassignedAnnotation(store.document, annotation, labelClass)),
    );
  }

  function setAttribute(id: string, name: string, value: AttributeValue | null): void {
    // Read from the store, not from the render that drew the row: a field commits on
    // blur and on unmount, which can land after the document moved on.
    const current = store.document.annotations.get(id);
    if (current === undefined) return;
    const next = withAttribute(current, name, value);
    // No change is no command — the identity trap `remove` and `reassign` guard too.
    if (next === current) return;
    store.execute(replaceAnnotationCommand(next));
  }

  return (
    <section
      // 288px, and 320px only from `2xl`. The extra 32px is headroom for a class
      // naming three shapes, not a fix — and it is withheld below 1536px on
      // purpose: `ANNOTATOR_MIN_VIEWPORT_PX` is 768, where a collapsed rail
      // already leaves a 384px stage, and a width chosen on a large monitor must
      // not be charged to the smallest screen the editor opens on at all.
      // `EditorNotice`'s clearance arithmetic is stated at 1280px and stays true.
      className={
        layout === "flush"
          ? "flex min-h-0 flex-1 flex-col gap-2 px-2 py-3"
          : "flex w-72 min-h-0 flex-col gap-2 rounded-lg border border-border bg-muted p-2 2xl:w-80"
      }
      data-testid="annotator-panel"
      aria-label="Classes, tags and objects"
    >
      {/* Upper region: the ontology — absent, not disabled, in the read-only
          mode: what may I draw is not a question a viewer can ask, so
          rendering the list there would be information about nothing. The objects region
          below takes the whole panel by the same rule that always sized it —
          it is `flex-1` and there is nothing else left.

          `shrink-0`, and it sizes itself in rows — see `ClassRegion` for the
          rule and for why it is computed from the schema's count rather than
          from the filtered one. */}
      {!readOnly && drawableClasses.length > 0 && (
        <>
          <ClassRegion
            schema={schema}
            activeClass={activeClass}
            onActivateClass={onActivateClass}
            activeTool={activeTool ?? null}
            {...(onActivateTool === undefined ? {} : { onActivateTool })}
            {...(classFilterRef === undefined ? {} : { filterRef: classFilterRef })}
            {...(onAddClass === undefined ? {} : { onAddClass })}
          />

          {/* The split. A rule, not a handle — `ClassRegion` decides its own
              height and everything below takes the rest. */}
          <div className="h-px shrink-0 bg-border" aria-hidden="true" data-testid="panel-split" />
        </>
      )}

      {/* Only when the pinned schema declares a tag class — a section with no
          chips is a heading over nothing, and most schemas declare none. */}
      {tagClasses.length > 0 && (
        <>
          <TagRegion
            store={store}
            readOnly={readOnly}
            schema={schema}
            tagClasses={tagClasses}
            tagged={taggedClassNames(snapshot.document)}
          />
          <div
            className="h-px shrink-0 bg-border"
            aria-hidden="true"
            data-testid="panel-split-tags"
          />
        </>
      )}

      {/* Lower region: what is on this asset. `min-h-0` is what lets it be
          shorter than its content so the list inside can scroll — without it a
          flex child refuses to go below its content and the panel grows past the
          viewport instead. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="objects-region">
      <div className="flex items-center justify-between px-2">
        <span className="text-sm font-medium">Objects</span>
        {/* No hide-all here: the rail's `tool-visibility` writes the same
            `hiddenIds`, and two buttons for one set is two places to read it. */}
        <span className="text-xs text-muted-foreground" data-testid="object-count">
          {total} object{total === 1 ? "" : "s"}
        </span>
      </div>

      <Input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter objects…"
        aria-label="Filter objects"
        data-testid="object-filter"
        className="h-8"
      />

      <div className="vs-scroll-fade-y min-h-0 flex-1 overflow-y-auto" data-testid="objects-scroller">
        {rows.length + cuboidRows.length + rows3D.length === 0 ? (
          <p
            className="px-1 py-4 text-center text-xs text-muted-foreground"
            data-testid="objects-empty"
          >
            {total === 0 ? "Nothing drawn yet." : "No object matches that filter."}
          </p>
        ) : (
          <ul className="flex flex-col">
            {rows.map(({ annotation, index }) => (
              <ObjectRow
                key={annotation.id}
                annotation={annotation}
                index={index}
                declared={classNamed(snapshot.document, annotation.label_class)}
                schema={schema}
                selected={snapshot.selection.has(annotation.id)}
                hidden={hiddenIds.has(annotation.id)}
                trackMark={trackMarks.get(annotation.id)}
                classLock={classLocks.get(annotation.id)}
                onSelect={() => {
                  store.select(selectOnly(annotation.id));
                  onReturnFocus?.();
                }}
                onToggleVisible={() => toggleHidden(annotation.id)}
                {...(readOnly
                  ? {}
                  : {
                      onRemove: () => remove(annotation.id),
                      onReassign: (labelClass: string) => reassign(annotation, labelClass),
                      onAttributeChange: (name: string, value: AttributeValue | null) =>
                        setAttribute(annotation.id, name, value),
                    })}
              />
            ))}
            {cuboidRows.map(({ annotation, index }) => (
              <CuboidRow
                key={annotation.id}
                annotation={annotation}
                index={index}
                color={classColor(classNamed(snapshot.document, annotation.label_class), annotation.label_class)}
                selected={scanSnapshot?.selection.has(annotation.id) === true}
                trackMark={trackMarks.get(annotation.id)}
                onSelect={() => {
                  scan?.store.select(selectOnly(annotation.id));
                  onReturnFocus?.();
                }}
                onRemove={readOnly || scan?.onRemove == null ? null : () => scan.onRemove?.(annotation.id)}
              />
            ))}
            {rows3D.map(({ label, index }) => (
              <li
                key={label.id}
                data-testid={`object-row-${index}`}
                className="flex items-center gap-2 rounded-md border border-transparent bg-card px-1.5 py-1 text-xs"
              >
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{ background: classColor(classNamed(snapshot.document, label.label_class), label.label_class) }}
                />
                <span className="truncate">
                  {index + 1}. {label.label_class}{" "}
                  <span className="text-muted-foreground">· {geometryLabel3D(label.geometry)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {lane !== undefined && lane.geometry.type === "polyline" && (
        <VertexRegion
          key={lane.id}
          store={store}
          annotationId={lane.id}
          geometry={lane.geometry}
          readOnly={readOnly}
        />
      )}
      </div>

      {tracks !== undefined && (
        <>
          <div className="h-px shrink-0 bg-border" aria-hidden="true" data-testid="panel-split-tracks" />
          {tracks}
        </>
      )}
    </section>
  );
}

/**
 * The asset's classification tags: a section of its own, between the classes and
 * the objects.
 *
 * This is the Labels tab's one capability that had nowhere else to go: a tag is not
 * a shape and cannot be drawn, so no tool and no canvas gesture reaches it. The
 * digit is shown because the keyboard binding is still the fastest way to set one
 * and this is the only surface left that can name it — `hotkeyForClass`, so the chip
 * and the input layer cannot disagree about which number a class answers to.
 *
 * Assigning is multi-select and unbounded: an image carries one tag per
 * tag-capable class and as many classes as it likes, which is the kernel's own
 * rule (`DuplicateClassificationTag` is keyed `(asset, class)`). Nothing here
 * enforces a limit the chips could disagree with.
 *
 * `shrink-0` with a capped scroller, so thirty tag classes cannot push the
 * objects region off the panel. The heading and the line under it sit outside
 * that scroller.
 */
function TagRegion({
  store,
  readOnly,
  schema,
  tagClasses,
  tagged,
}: {
  readonly store: AnnotatorStore;
  readonly readOnly: boolean;
  readonly schema: AnnotationSchema;
  readonly tagClasses: readonly LabelClass[];
  readonly tagged: ReadonlySet<string>;
}): JSX.Element {
  // No `readOnly` early return: the chips carry `disabled`, so a press cannot
  // arrive here in the first place, and a second guard behind it would keep the
  // behaviour correct with the first one deleted — which is a test that cannot
  // fail. One enforcement, and it is the one the person can see.
  function press(declared: LabelClass): void {
    const command = toggleTagCommand(store.document, declared.name, randomUuid);
    // `null` is a refusal — an undeclared or non-taggable class — and it is
    // asymmetric by design: untag never refuses. Neither arm can fire here, since
    // the strip is built by filtering the schema's own tag classes.
    if (command !== null) store.execute(command);
  }

  // Counted over the chips, not the document: a tag whose class a later schema
  // version removed has no chip, and a count the section cannot show is a lie.
  const assigned = tagClasses.filter((declared) => tagged.has(declared.name)).length;

  return (
    <div className="flex shrink-0 flex-col gap-2" data-testid="tag-region">
      <div className="flex items-center justify-between px-2">
        <span className="text-sm font-medium">Tags</span>
        <span className="text-xs text-muted-foreground" data-testid="tag-count">
          {assigned} assigned
        </span>
      </div>

      {/* Everything else in this panel is about a thing on the picture. This is
          the one line saying these are not. */}
      <p className="px-2 text-xs text-muted-foreground" data-testid="tag-note">
        Tags apply to the whole image.
      </p>

      <div
        className="max-h-24 overflow-y-auto"
        data-testid="tag-scroller"
      >
        <div className="flex flex-wrap gap-1 px-2" data-testid="tag-strip">
          {tagClasses.map((declared) => {
            const on = tagged.has(declared.name);
            return (
              <Badge
                key={declared.name}
                asChild
                variant="outline"
                className={cn(
                  on
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-card text-muted-foreground",
                )}
              >
                <button
                  type="button"
                  data-testid={`tag-chip-${declared.name}`}
                  data-active={on ? "true" : "false"}
                  aria-pressed={on}
                  disabled={readOnly}
                  onClick={() => press(declared)}
                >
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: classColor(declared, declared.name) }}
                  />
                  <span className="truncate">{declared.name}</span>
                  {on ? (
                    <Check className="size-3 text-primary" aria-hidden="true" />
                  ) : (
                    <Kbd>{hotkeyForClass(schema, declared.name) ?? "—"}</Kbd>
                  )}
                </button>
              </Badge>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * That a model produced this one — on the rows that have one, and nothing more.
 *
 * Renders nothing at all for a person's work. That is the whole of the design:
 * accepting a predicted box is the act that most needs the reviewer to know what
 * they are accepting, and the *common* path is a label somebody drew, which
 * earns no badge. Absence is the human case, so the row a reviewer sees a
 * thousand times is exactly the row that shipped.
 *
 * **The confidence is deliberately not here.** It is a decision aid for
 * accept-or-reject and it stops being one once the shape is accepted; a column
 * of percentages down a settled list invites a reviewer to sort by a number
 * that means different things per capability — a point-prompted mask score and
 * a detection's prompt affinity are not the same quantity. Where the number
 * does belong is the batch review loop, and it will be named there. In the
 * editor it appears on the live suggestion preview alone.
 *
 * Never colour alone: the glyph carries it, and the accessible name says it in
 * words, so neither a monochrome screen nor a screen reader depends on the
 * muted foreground this is tinted with.
 *
 * `import` provenance is deliberately not marked. It would need a mark of its
 * own to mean anything, and the importers that would produce one do not exist
 * yet; marking it as a model's work would be a claim about where the label came
 * from that this build cannot support.
 */
function ModelMark({
  annotation,
  index,
}: {
  readonly annotation: Annotation;
  readonly index: number;
}): JSX.Element | null {
  if (annotation.provenance !== "model") return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid={`object-model-${index}`}
          // The glyph is the sighted reading; the label is the claim in words,
          // because a sparkle is not self-describing.
          aria-label={`Model-produced by ${annotation.model_ref ?? "an unnamed model"}`}
          className="relative flex shrink-0 items-center text-xs text-muted-foreground"
        >
          <Sparkles className="size-3" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      {/* The full reference, which is far too long for the row and is exactly
          what a reviewer wants when they ask "which model said so". */}
      <TooltipContent side="left">{annotation.model_ref ?? "Model not recorded"}</TooltipContent>
    </Tooltip>
  );
}

/** That a track follows this object: its name on hover, and a press opens it in the Tracks region. */
function TrackBadge({ mark, index }: { readonly mark: TrackMark | undefined; readonly index: number }): JSX.Element | null {
  if (mark === undefined) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid={`object-track-${index}`}
          aria-label={`On track ${mark.label}`}
          onMouseDown={keepCanvasFocus}
          onClick={mark.onShow}
          className="relative inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          <Route className="size-3" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">On track {mark.label}</TooltipContent>
    </Tooltip>
  );
}

interface ObjectRowProps {
  readonly annotation: Annotation;
  readonly index: number;
  readonly declared: LabelClass | undefined;
  /** The pinned schema — the reassignment menu reads its classes and hotkeys. */
  readonly schema: AnnotationSchema;
  readonly selected: boolean;
  readonly hidden: boolean;
  readonly trackMark: TrackMark | undefined;
  readonly classLock: ClassLock | undefined;
  readonly onSelect: () => void;
  readonly onToggleVisible: () => void;
  /** Absent in read-only: there is no delete to offer, so no button is drawn. */
  readonly onRemove?: () => void;
  /** Absent in read-only for the same reason — every item on it is a write. */
  readonly onReassign?: (labelClass: string) => void;
  /** Absent in read-only: the attribute controls render, disabled. */
  readonly onAttributeChange?: (name: string, value: AttributeValue | null) => void;
}

/**
 * One drawn object: its class, its values at a glance, its number — and, selected,
 * its values open beneath it.
 *
 * The row is one surface: an invisible select button fills it, and the few things
 * that are controls of their own (the class name, the mark, hide and delete) sit
 * above it as siblings, so a press on the class opens the class menu and never also
 * selects, without a propagation rule anyone has to remember — a button cannot hold
 * a button, so the two are never nested in the first place.
 */
function ObjectRow({
  annotation,
  index,
  declared,
  schema,
  selected,
  hidden,
  trackMark,
  classLock,
  onSelect,
  onToggleVisible,
  onRemove,
  onReassign,
  onAttributeChange,
}: ObjectRowProps): JSX.Element {
  const row = useRef<HTMLLIElement | null>(null);
  /**
   * Selection is one state, reflected everywhere: a shape picked on the
   * canvas selects this row too, and a row a filter or a long list has pushed
   * out of the scroller scrolls into view. Each row watches its own `selected`,
   * so the rule costs nothing to the rows it does not concern; `nearest` keeps
   * an already-visible row exactly where it is, which is what makes the same
   * effect harmless when the selection came from a click on this very row.
   *
   * DOM focus deliberately does not move: the keyboard stays where the gesture
   * happened — the canvas reads its chords off its own root, and a selection
   * that stole focus would kill them (`PinBadge`'s reason, one surface over).
   */
  useEffect(() => {
    if (selected) row.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const number = index + 1;
  const hasAttributes = declared !== undefined && declared.attributes.length > 0;
  const summary = rowSummary(annotation, declared);
  const swatch = classColor(declared, annotation.label_class);

  return (
    <li
      ref={row}
      data-testid={`object-row-${index}`}
      data-selected={selected ? "true" : "false"}
      data-hidden={hidden ? "true" : "false"}
      className={cn(
        // A full border, unlike the class row's left rule — a different kind of
        // selection (docs/content/ui/annotator.md).
        "group flex flex-col rounded-md border transition-colors",
        selected ? "border-primary bg-primary/10" : "border-transparent hover:bg-muted",
        hidden && "opacity-50",
      )}
    >
      {/* 1px plus the border plus the class field's own 6px puts the swatch on the
          panel's one inset, where the headings start. */}
      <div className="relative flex h-8 items-center gap-1 pr-1 pl-px">
        <button
          type="button"
          data-testid={`object-select-${index}`}
          aria-label={`Select object ${number}, ${annotation.label_class}`}
          aria-expanded={hasAttributes ? selected : undefined}
          onMouseDown={keepCanvasFocus}
          onClick={onSelect}
          className="absolute inset-0 rounded-[5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        />
        {onReassign === undefined ? (
          <span className="pointer-events-none relative flex h-6 max-w-[70%] min-w-0 shrink-0 items-center gap-1.5 px-1.5 text-sm">
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ background: swatch }} />
            <span className="truncate">{annotation.label_class}</span>
          </span>
        ) : (
          <RowReassign
            index={index}
            annotation={annotation}
            schema={schema}
            swatch={swatch}
            lock={classLock}
            onReassign={onReassign}
          />
        )}
        {summary !== "" && (
          <span
            className="pointer-events-none relative min-w-0 truncate text-xs text-muted-foreground"
            data-testid={`object-summary-${index}`}
          >
            {summary}
          </span>
        )}
        {missingRequired(annotation, declared).length > 0 && (
          <NeedsValueDot testId={`object-missing-${index}`} className="relative" />
        )}
        {/* A mark, not a target: it sits above the row so its tooltip can open, and
            nothing about it selects. */}
        <ModelMark annotation={annotation} index={index} />
        <TrackBadge mark={trackMark} index={index} />
        <span className="pointer-events-none relative ml-auto shrink-0 pr-1 text-xs text-muted-foreground tabular-nums">
          #{number}
        </span>
        <RowActions
          index={index}
          selected={selected}
          hidden={hidden}
          onToggleVisible={onToggleVisible}
          {...(onRemove === undefined ? {} : { onRemove })}
        />
      </div>
      {/* Only while selected, and only for a class that declares something to set.
          A short rise in — the row is opened by a press, not a keystroke repeated
          down a list — and no exit: closing is a selection change, which never
          waits on an animation. */}
      {selected && declared !== undefined && hasAttributes && (
        <div className="animate-in px-3 pt-1 pb-3 duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none">
          <AttributeControls
            annotation={annotation}
            declared={declared}
            idPrefix={`object-attributes-${index}`}
            {...(onAttributeChange === undefined ? {} : { onChange: onAttributeChange })}
          />
        </div>
      )}
    </li>
  );
}

/**
 * Hide and delete, at the row's end.
 *
 * They show on hover, on keyboard focus inside the row and on the selected row — a
 * column of icons per object was the loudest thing in the list. Always shown where
 * there is no hover to reveal them, and a hidden object's eye stays put: it is the
 * only sign the object is still there.
 */
function RowActions({
  index,
  selected,
  hidden,
  onToggleVisible,
  onRemove,
}: {
  readonly index: number;
  readonly selected: boolean;
  readonly hidden: boolean;
  readonly onToggleVisible: () => void;
  readonly onRemove?: () => void;
}): JSX.Element {
  const number = index + 1;
  const reveal = cn(
    "transition-opacity duration-150",
    !selected &&
      "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100",
  );
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn("relative", hidden ? undefined : reveal)}
        aria-label={hidden ? `Show object ${number}` : `Hide object ${number}`}
        data-testid={`object-visibility-${index}`}
        onClick={onToggleVisible}
      >
        {hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Delete object ${number}`}
        className={cn("relative", reveal)}
        data-testid={`object-delete-${index}`}
        onClick={onRemove}
        disabled={onRemove === undefined}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </>
  );
}

/** One cuboid or polyline on a scan: select it, or delete it. No visibility toggle: the scan view has none per label. */
function CuboidRow({
  annotation,
  index,
  color,
  selected,
  trackMark,
  onSelect,
  onRemove,
}: {
  readonly annotation: ScanAnnotation;
  readonly index: number;
  readonly color: string;
  readonly selected: boolean;
  readonly trackMark: TrackMark | undefined;
  readonly onSelect: () => void;
  readonly onRemove: (() => void) | null;
}): JSX.Element {
  const row = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (selected) row.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <li
      ref={row}
      data-testid={`object-row-${index}`}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "flex items-center gap-1 rounded-md border px-1.5 py-1",
        selected ? "border-primary bg-primary/10" : "border-transparent bg-card",
      )}
    >
      <button
        type="button"
        data-testid={`object-select-${index}`}
        onMouseDown={keepCanvasFocus}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
      >
        <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ background: color }} />
        <span className="truncate">
          {index + 1}. {annotation.label_class}{" "}
          <span className="text-muted-foreground">· {geometryLabel3D(annotation.geometry)}</span>
        </span>
      </button>
      <TrackBadge mark={trackMark} index={index} />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Delete object ${index + 1}`}
        data-testid={`object-delete-${index}`}
        onClick={onRemove ?? undefined}
        disabled={onRemove === null}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </li>
  );
}

/**
 * The row's anchor for `ReassignMenu` — the class name itself.
 *
 * Everything this menu decides moved into `ReassignMenu.tsx` when the canvas grew
 * a second anchor for it: the class list, the disabled-with-reason rendering, the
 * hotkey and the apply. What is left here is a trigger and a row number, which are
 * the only two things a list legitimately has that a shape does not. The trigger
 * is the name, not an icon beside it: what the menu changes is what it says.
 *
 * Open is held rather than left to Radix, because a hotkey is not an item
 * selection: nothing would dismiss the menu after a digit reassigns.
 */
function RowReassign({
  index,
  annotation,
  schema,
  swatch,
  lock,
  onReassign,
}: {
  readonly index: number;
  readonly annotation: Annotation;
  readonly schema: AnnotationSchema;
  readonly swatch: string;
  readonly lock: ClassLock | undefined;
  readonly onReassign: (labelClass: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // The visible name leads the accessible one, so a voice command that says
          // what is on screen reaches it.
          aria-label={`${annotation.label_class}, change class of object ${index + 1}`}
          data-testid={`object-reclass-${index}`}
          className="group/name relative flex h-6 max-w-[70%] min-w-0 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-left text-sm transition-colors outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/30 data-[state=open]:bg-foreground/5"
        >
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-sm"
            // The schema's colour, which no utility could name — the one sanctioned
            // inline colour, and the same `classColor` the canvas draws with.
            style={{ background: swatch }}
          />
          <span className="truncate">{annotation.label_class}</span>
          <ChevronDown
            aria-hidden="true"
            className="size-3 shrink-0 text-muted-foreground/60 transition-colors group-hover/name:text-muted-foreground"
          />
        </button>
      </DropdownMenuTrigger>
      <ReassignMenu
        annotation={annotation}
        schema={schema}
        idPrefix={`reclass-${index}`}
        onReassign={onReassign}
        onClose={() => setOpen(false)}
        align="start"
        lock={lock}
      />
    </DropdownMenu>
  );
}
