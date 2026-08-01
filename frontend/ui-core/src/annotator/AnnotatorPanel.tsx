/**
 * The annotation page's right-hand panel: **Objects** and **Labels**.
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
 * ## One `Selection`, two views of it
 *
 * The panel reads and writes the same store the canvas does. Clicking a row calls
 * `store.select`; clicking a shape on the canvas updates the same selection and the
 * row highlights. There is no second source of truth and no synchronisation, which
 * is what makes the round trip a *property* rather than a feature.
 *
 * ## Every write goes through a command
 *
 * Delete uses `removeAnnotationsCommand`, the same path the keyboard takes, so
 * #46's guards cannot diverge — including the one that reads oddly until you know
 * why: an identity command still goes through `store.execute`, which drops a staged
 * preview, so a delete of nothing must not be executed at all.
 *
 * Class reassignment uses `replaceAnnotationCommand` and offers **only classes that
 * share the annotation's geometry**, because the kernel judges geometry per class
 * (#7, `DisallowedGeometry`) — a cross-geometry reassignment is a write the API
 * refuses, so offering it would be offering a refusal.
 *
 * ## No new core state and no new events
 *
 * Everything below is a command or a projection that already existed. Visibility is
 * the one piece of new state and it lives *beside* the store, exactly where the
 * adapter's own `skipId` and `hotId` live.
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
  type AnnotatorStore,
  type LabelClass,
} from "@visionset/annotator";
import { Check, Eye, EyeOff, Trash2 } from "lucide-react";
import { useMemo, useState, type JSX } from "react";

import { classColor } from "../palette";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { Label } from "../primitives/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/Select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../primitives/Tabs";
import { cn } from "../lib/cn";

export interface AnnotatorPanelProps {
  readonly store: AnnotatorStore;
  /** Held by the page, because the canvas needs the same set. */
  readonly hiddenIds: ReadonlySet<string>;
  readonly onHiddenChange: (hidden: ReadonlySet<string>) => void;
  /** The class a drawing gesture will carry. `null` is select mode. */
  readonly activeClass: string | null;
  readonly onActivateClass: (labelClass: string | null) => void;
}

export function AnnotatorPanel({
  store,
  hiddenIds,
  onHiddenChange,
  activeClass,
  onActivateClass,
}: AnnotatorPanelProps): JSX.Element {
  const snapshot = useAnnotatorSnapshot(store);
  const drawn = annotationsInDrawOrder(snapshot.document);

  return (
    <Tabs defaultValue="objects" className="flex w-72 flex-col gap-3" data-testid="annotator-panel">
      {/* The one place the segmented control is still the right shape (#182): two
          equal halves inside a 288px card is a switch, and there is no full-width
          run to hang an underline's hairline on that would not cut the panel in
          two. `DESIGN.md`'s side-panel line names the variant. */}
      <TabsList variant="segmented" className="w-full">
        <TabsTrigger value="objects" data-testid="tab-objects">
          Objects
        </TabsTrigger>
        <TabsTrigger value="labels" data-testid="tab-labels">
          Labels
        </TabsTrigger>
      </TabsList>

      <TabsContent value="objects">
        <ObjectsTab
          store={store}
          drawn={drawn}
          selection={snapshot.selection}
          hiddenIds={hiddenIds}
          onHiddenChange={onHiddenChange}
        />
      </TabsContent>

      <TabsContent value="labels">
        <LabelsTab
          store={store}
          activeClass={activeClass}
          onActivateClass={onActivateClass}
        />
      </TabsContent>
    </Tabs>
  );
}

function ObjectsTab({
  store,
  drawn,
  selection,
  hiddenIds,
  onHiddenChange,
}: {
  readonly store: AnnotatorStore;
  readonly drawn: readonly Annotation[];
  readonly selection: ReadonlySet<string>;
  readonly hiddenIds: ReadonlySet<string>;
  readonly onHiddenChange: (hidden: ReadonlySet<string>) => void;
}): JSX.Element {
  const allHidden = drawn.length > 0 && drawn.every((one) => hiddenIds.has(one.id));

  function toggle(id: string): void {
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

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted p-2">
      <div className="flex items-center justify-between px-1">
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

      {drawn.length === 0 ? (
        <p className="px-1 py-4 text-center text-meta text-muted-foreground">
          Nothing drawn yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {drawn.map((annotation, index) => (
            <ObjectRow
              key={annotation.id}
              annotation={annotation}
              index={index}
              declared={classNamed(store.document, annotation.label_class)}
              selected={selection.has(annotation.id)}
              hidden={hiddenIds.has(annotation.id)}
              onSelect={() => store.select(selectOnly(annotation.id))}
              onToggleVisible={() => toggle(annotation.id)}
              onRemove={() => remove(annotation.id)}
            />
          ))}
        </ul>
      )}

      <EditingCard store={store} selection={selection} />
    </div>
  );
}

function ObjectRow({
  annotation,
  index,
  declared,
  selected,
  hidden,
  onSelect,
  onToggleVisible,
  onRemove,
}: {
  readonly annotation: Annotation;
  readonly index: number;
  readonly declared: LabelClass | undefined;
  readonly selected: boolean;
  readonly hidden: boolean;
  readonly onSelect: () => void;
  readonly onToggleVisible: () => void;
  readonly onRemove: () => void;
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
      >
        <Trash2 className="size-3.5" />
      </Button>
    </li>
  );
}

/**
 * What the selected object is, and the one thing about it that can be changed here.
 *
 * Behind an **Apply** rather than applied on change, because a class reassignment is
 * a command that lands in the undo history: a picker that wrote on every keystroke
 * of a keyboard-driven `Select` would fill the history with states nobody chose.
 */
function EditingCard({
  store,
  selection,
}: {
  readonly store: AnnotatorStore;
  readonly selection: ReadonlySet<string>;
}): JSX.Element | null {
  const [pending, setPending] = useState<string | null>(null);

  const selected = useMemo(() => {
    if (selection.size !== 1) return null;
    const [id] = [...selection];
    return store.document.annotations.get(id) ?? null;
  }, [selection, store.document]);

  if (selected === null) return null;

  const geometry = selected.geometry.type;
  // Only classes that share the geometry. The kernel judges geometry **per class**
  // (`DisallowedGeometry`), so a cross-geometry reassignment is a write the API
  // refuses — offering it would be offering a refusal.
  const compatible = store.document.schema.classes.filter(
    (declared) => declared.geometry === geometry,
  );
  const choice = pending ?? selected.label_class;

  function apply(): void {
    if (selected === null || choice === selected.label_class) return;
    store.execute(replaceAnnotationCommand({ ...selected, label_class: choice }));
    setPending(null);
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-2" data-testid="editing-card">
      <div className="flex items-center justify-between">
        <span className="text-meta font-medium">Selected</span>
        <Badge data-testid="editing-geometry">{geometry}</Badge>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="reclass" className="text-meta">
          Class
        </Label>
        <Select value={choice} onValueChange={setPending}>
          <SelectTrigger id="reclass" data-testid="reclass-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {compatible.map((declared) => (
              <SelectItem key={declared.name} value={declared.name}>
                {declared.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        variant="primary"
        size="sm"
        data-testid="reclass-apply"
        disabled={choice === selected.label_class}
        onClick={apply}
      >
        Apply
      </Button>
    </div>
  );
}

/**
 * The schema's palette, and clicking a row does exactly what its digit does.
 *
 * `classAction`'s split, spelled once more because this is the *other* road to it:
 * a drawable class becomes active, a `classification_tag` toggles. The digit shown
 * is `hotkeyForClass`, so the panel and the keyboard cannot disagree about which
 * number a class answers to.
 */
function LabelsTab({
  store,
  activeClass,
  onActivateClass,
}: {
  readonly store: AnnotatorStore;
  readonly activeClass: string | null;
  readonly onActivateClass: (labelClass: string | null) => void;
}): JSX.Element {
  const snapshot = useAnnotatorSnapshot(store);
  const schema = snapshot.document.schema;
  const tagged = taggedClassNames(snapshot.document);

  function press(declared: LabelClass): void {
    if (isTaggableClass(declared)) {
      const command = toggleTagCommand(snapshot.document, declared.name, randomUuid);
      // `null` is a refusal — an undeclared or non-taggable class — and it is
      // asymmetric by design: untag never refuses. Nothing to report here.
      if (command !== null) store.execute(command);
      return;
    }
    onActivateClass(declared.name);
  }

  return (
    <ul className="flex flex-col gap-1 rounded-lg border border-border bg-muted p-2">
      <li>
        <button
          type="button"
          data-testid="label-select"
          data-active={activeClass === null ? "true" : "false"}
          onClick={() => onActivateClass(null)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md border px-1.5 py-1 text-left text-meta",
            activeClass === null ? "border-primary bg-primary/10" : "border-transparent bg-card",
          )}
        >
          <kbd className="rounded-sm border border-border bg-muted px-1 text-meta">V</kbd>
          select
        </button>
      </li>
      {schema.classes.map((declared) => {
        const taggable = isTaggableClass(declared);
        const on = taggable ? tagged.has(declared.name) : activeClass === declared.name;
        return (
          <li key={declared.name}>
            <button
              type="button"
              data-testid={`label-${declared.name}`}
              data-active={on ? "true" : "false"}
              onClick={() => press(declared)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md border px-1.5 py-1 text-left text-meta",
                on ? "border-primary bg-primary/10" : "border-transparent bg-card",
              )}
            >
              <kbd className="rounded-sm border border-border bg-muted px-1 text-meta">
                {hotkeyForClass(schema, declared.name) ?? "—"}
              </kbd>
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-sm"
                style={{ background: classColor(declared, declared.name) }}
              />
              <span className="flex-1 truncate">{declared.name}</span>
              {taggable && on && (
                <Check className="size-3.5 text-primary" aria-label="tagged" />
              )}
              {!taggable && (
                <span className="text-meta text-muted-foreground">{declared.geometry}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
