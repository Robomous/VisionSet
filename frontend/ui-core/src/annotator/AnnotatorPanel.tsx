/**
 * The annotation page's right-hand panel: **Annotations**, one view.
 *
 * ## Why it is here and not in `@visionset/annotator`
 *
 * #126 left the choice open. It lands in `ui-core` because the annotator's whole
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
 * ## There are no tabs, and the panel no longer picks a class
 *
 * It used to be **Objects | Labels**. The Labels tab was the schema's palette, and
 * it did two unrelated jobs under one heading: it armed the drawing class, and it
 * toggled the asset's classification tags. #368 split them by where they belong.
 * Arming the drawing class is the most-used control on the page, so it moved to the
 * top bar (`ClassField`) where the eye already is; tagging the *asset* is a fact
 * about this frame, so it stays here, as a chip strip over the list.
 *
 * What that leaves is one view about one subject — what is on this asset — which is
 * why `activeClass` and `onActivateClass` are gone from the props entirely rather
 * than kept and ignored. A panel that could still arm a class would be a second
 * road to a setting with one owner.
 *
 * ## The order of the parts, and the one that is not obvious
 *
 * Header, tags, filter, list. The chip strip sits above the list because the tags
 * describe the whole asset and the list describes the things drawn on it — decision
 * 2's own wording. The filter sits *below* the chips and immediately above the rows
 * it filters, because a control's position is the cheapest statement of what it acts
 * on; between the chips and the list it would read as filtering both.
 *
 * It renders even with nothing drawn. A control that appears once a list is long
 * enough is a control nobody finds, and the panel's width is fixed, so there is no
 * layout to protect by hiding it.
 *
 * ## Every write goes through a command
 *
 * Delete uses `removeAnnotationsCommand`, the same path the keyboard takes, so
 * #46's guards cannot diverge — including the one that reads oddly until you know
 * why: an identity command still goes through `store.execute`, which drops a staged
 * preview, so a delete of nothing must not be executed at all.
 *
 * Class reassignment uses `replaceAnnotationCommand`, so it lands in the history and
 * undo takes it back like anything else. It is offered per row rather than for the
 * selection, and it lists **every** class the schema declares, with the ones whose
 * geometry does not match this annotation's **disabled and carrying the reason**.
 * That is a deliberate reversal of what shipped before, which filtered them out: a
 * short list with no explanation looks like the schema is missing classes, and the
 * rule — the kernel judges geometry per class (#7, `DisallowedGeometry`) — is
 * invisible exactly when somebody is hunting for the class that is not there.
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
  hotkeyForClass,
  isTaggableClass,
  randomUuid,
  removeAnnotationsCommand,
  replaceAnnotationCommand,
  selectOnly,
  taggedClassNames,
  toggleTagCommand,
  useAnnotatorSnapshot,
  type Annotation,
  type AnnotationSchema,
  type AnnotatorStore,
  type LabelClass,
} from "@visionset/annotator";
import { Check, Eye, EyeOff, Tag, Trash2 } from "lucide-react";
import { useState, type JSX } from "react";

import { classColor } from "../palette";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../primitives/Menu";
import { cn } from "../lib/cn";

export interface AnnotatorPanelProps {
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
}

export function AnnotatorPanel({
  store,
  hiddenIds,
  onHiddenChange,
  readOnly = false,
}: AnnotatorPanelProps): JSX.Element {
  const snapshot = useAnnotatorSnapshot(store);
  const [filter, setFilter] = useState("");

  const drawn = annotationsInDrawOrder(snapshot.document);
  const schema = snapshot.document.schema;
  const tagClasses = schema.classes.filter(isTaggableClass);

  const query = filter.trim().toLowerCase();
  // Numbered by **draw order**, never by position in the filtered list: the number
  // is the object's identity on the canvas, and renumbering it as somebody types
  // would make the panel and the picture disagree about which one is "3".
  const rows = drawn
    .map((annotation, index) => ({ annotation, index }))
    .filter((row) => row.annotation.label_class.toLowerCase().includes(query));

  const allHidden = drawn.length > 0 && drawn.every((one) => hiddenIds.has(one.id));

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
    // identity command still drops a staged preview, which is #46's finding about
    // `delete-selection` seen from the panel.
    if (!store.document.annotations.has(id)) return;
    store.execute(removeAnnotationsCommand([id]));
  }

  function reassign(annotation: Annotation, labelClass: string): void {
    // Same class is the identity, and an identity command still drops a staged
    // preview — the `remove` guard's reason, one row over.
    if (readOnly || labelClass === annotation.label_class) return;
    store.execute(replaceAnnotationCommand({ ...annotation, label_class: labelClass }));
  }

  return (
    <section
      className="flex w-72 flex-col gap-2 rounded-lg border border-border bg-muted p-2"
      data-testid="annotator-panel"
      aria-label="Annotations"
    >
      <div className="flex items-center justify-between px-1">
        <span className="text-body font-medium">Annotations</span>
        <div className="flex items-center gap-2">
          <span className="text-meta text-muted-foreground" data-testid="object-count">
            {drawn.length} object{drawn.length === 1 ? "" : "s"}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={allHidden ? "Show all objects" : "Hide all objects"}
            data-testid="toggle-all-visibility"
            disabled={drawn.length === 0}
            onClick={() => onHiddenChange(allHidden ? new Set() : new Set(drawn.map((o) => o.id)))}
          >
            {allHidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        </div>
      </div>

      {/* Only when the pinned schema declares one — decision 2. A strip with no
          chips is a heading over nothing, and most schemas declare no tags at all. */}
      {tagClasses.length > 0 && (
        <TagStrip
          store={store}
          readOnly={readOnly}
          schema={schema}
          tagClasses={tagClasses}
          tagged={taggedClassNames(snapshot.document)}
        />
      )}

      <Input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter objects…"
        aria-label="Filter objects"
        data-testid="object-filter"
        className="h-8"
      />

      {rows.length === 0 ? (
        <p
          className="px-1 py-4 text-center text-meta text-muted-foreground"
          data-testid="objects-empty"
        >
          {drawn.length === 0 ? "Nothing drawn yet." : "No object matches that filter."}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map(({ annotation, index }) => (
            <ObjectRow
              key={annotation.id}
              annotation={annotation}
              index={index}
              declared={classNamed(snapshot.document, annotation.label_class)}
              classes={schema.classes}
              selected={snapshot.selection.has(annotation.id)}
              hidden={hiddenIds.has(annotation.id)}
              onSelect={() => store.select(selectOnly(annotation.id))}
              onToggleVisible={() => toggleHidden(annotation.id)}
              {...(readOnly
                ? {}
                : {
                    onRemove: () => remove(annotation.id),
                    onReassign: (labelClass: string) => reassign(annotation, labelClass),
                  })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The asset's classification tags, as chips.
 *
 * This is the Labels tab's one capability that had nowhere else to go: a tag is not
 * a shape and cannot be drawn, so no tool and no canvas gesture reaches it. The
 * digit is shown because the keyboard binding is still the fastest way to set one
 * and this is the only surface left that can name it — `hotkeyForClass`, so the chip
 * and the input layer cannot disagree about which number a class answers to.
 */
function TagStrip({
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
  function press(declared: LabelClass): void {
    if (readOnly) return;
    const command = toggleTagCommand(store.document, declared.name, randomUuid);
    // `null` is a refusal — an undeclared or non-taggable class — and it is
    // asymmetric by design: untag never refuses. Neither arm can fire here, since
    // the strip is built by filtering the schema's own tag classes.
    if (command !== null) store.execute(command);
  }

  return (
    <div className="flex flex-wrap gap-1 px-1" data-testid="tag-strip">
      {tagClasses.map((declared) => {
        const on = tagged.has(declared.name);
        return (
          <button
            key={declared.name}
            type="button"
            data-testid={`tag-chip-${declared.name}`}
            data-active={on ? "true" : "false"}
            aria-pressed={on}
            disabled={readOnly}
            onClick={() => press(declared)}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-meta",
              on
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-card text-muted-foreground",
            )}
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
              <kbd className="rounded-sm border border-border px-1 font-mono text-meta">
                {hotkeyForClass(schema, declared.name) ?? "—"}
              </kbd>
            )}
          </button>
        );
      })}
    </div>
  );
}

function ObjectRow({
  annotation,
  index,
  declared,
  classes,
  selected,
  hidden,
  onSelect,
  onToggleVisible,
  onRemove,
  onReassign,
}: {
  readonly annotation: Annotation;
  readonly index: number;
  readonly declared: LabelClass | undefined;
  readonly classes: readonly LabelClass[];
  readonly selected: boolean;
  readonly hidden: boolean;
  readonly onSelect: () => void;
  readonly onToggleVisible: () => void;
  /** Absent in read-only: there is no delete to offer, so no button is drawn. */
  readonly onRemove?: () => void;
  /** Absent in read-only for the same reason — every item on it is a write. */
  readonly onReassign?: (labelClass: string) => void;
}): JSX.Element {
  return (
    <li
      data-testid={`object-row-${index}`}
      data-selected={selected ? "true" : "false"}
      data-hidden={hidden ? "true" : "false"}
      className={cn(
        "flex items-center gap-1 rounded-md border px-1.5 py-1",
        selected ? "border-primary bg-primary/10" : "border-transparent bg-card",
        hidden && "opacity-50",
      )}
    >
      <button
        type="button"
        data-testid={`object-select-${index}`}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-meta"
      >
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-sm"
          // The schema's colour, which no utility could name — the one sanctioned
          // inline colour, and the same `classColor` the canvas draws with.
          style={{ background: classColor(declared, annotation.label_class) }}
        />
        <span className="truncate">
          {index + 1}. {annotation.label_class}
        </span>
      </button>
      {onReassign !== undefined && (
        <ReassignMenu
          index={index}
          annotation={annotation}
          classes={classes}
          onReassign={onReassign}
        />
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label={hidden ? `Show object ${index + 1}` : `Hide object ${index + 1}`}
        data-testid={`object-visibility-${index}`}
        onClick={onToggleVisible}
      >
        {hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label={`Delete object ${index + 1}`}
        data-testid={`object-delete-${index}`}
        onClick={onRemove}
        disabled={onRemove === undefined}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </li>
  );
}

/**
 * Every class the schema declares, and why the ones that cannot be picked cannot.
 *
 * The disabled items are the point. A menu listing only the compatible classes
 * answers "which class do you want" while silently withholding the answer to "where
 * is `lane`" — and `lane` is missing for a reason the person can act on, which is to
 * draw a polygon instead. So the row is there, greyed, naming the geometry it needs.
 */
function ReassignMenu({
  index,
  annotation,
  classes,
  onReassign,
}: {
  readonly index: number;
  readonly annotation: Annotation;
  readonly classes: readonly LabelClass[];
  readonly onReassign: (labelClass: string) => void;
}): JSX.Element {
  const geometry = annotation.geometry.type;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={`Reassign object ${index + 1}`}
          data-testid={`object-reclass-${index}`}
        >
          <Tag className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-64">
        {classes.map((declared) => {
          const fits = declared.geometry === geometry;
          const current = declared.name === annotation.label_class;
          return (
            <DropdownMenuItem
              key={declared.name}
              disabled={!fits}
              data-testid={`reclass-${index}-${declared.name}`}
              onSelect={() => onReassign(declared.name)}
            >
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-sm"
                style={{ background: classColor(declared, declared.name) }}
              />
              <span className="min-w-0 flex-1 truncate">{declared.name}</span>
              {current && <Check className="size-3.5 shrink-0" aria-label="current class" />}
              {!fits && (
                <span className="shrink-0 text-meta text-muted-foreground">
                  needs a {declared.geometry}
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
