/**
 * The top bar's class picker — the centre zone, and where class selection lives
 * as of #368.
 *
 * ## What it replaces, and why the panel was the wrong home
 *
 * The Labels tab held the schema's classes beside the object list, which meant
 * the two competed for one panel and the drawing class was two clicks and a tab
 * switch away from the canvas. It also meant the *most-used control on the page*
 * was the one furthest from the eye: a person drawing boxes looks at the picture
 * and at the top bar, never at the bottom of a side panel. So the picker moves to
 * the bar and the panel becomes one list of objects (WS3).
 *
 * ## It shows the drawing class, and never follows the selection
 *
 * Selecting an existing annotation does **not** move this field. That is
 * deliberate and it is the one thing most likely to be "fixed" later: the field
 * answers *what will the next shape be*, and a picker that tracked the selection
 * would silently re-point the drawing class every time somebody clicked a box to
 * look at it. Re-classing an existing annotation is the panel's row menu (WS3),
 * which is a different question asked of a different object.
 *
 * ## The tool follows the class, because it always has
 *
 * `core/interaction/tool.ts`: the tool is derived from the active class and never
 * stored. So picking a polygon class here changes the tool, and nothing in this
 * file does that — `toolFor` reads it downstream. There is no second mechanism to
 * keep in step, which is the pair v1 spent two of them on.
 *
 * ## An empty schema is an invitation, not an empty list
 *
 * A project with no classes yet cannot draw anything, and a picker offering
 * nothing explains none of that. So the resting state becomes a dashed
 * `No classes — create one` that opens the same dialog the no-match row does.
 */

import {
  classColor,
  hotkeyForClass,
  type AnnotationSchema,
  type LabelClass,
} from "@visionset/annotator";
import type { JSX } from "react";

import { Combobox } from "../primitives/Combobox";

/** `select` mode plus every declared class, as the picker's rows. */
interface ClassChoice {
  /** `null` is select mode — no drawing class, v1's `v`. */
  readonly labelClass: string | null;
  readonly name: string;
  readonly geometry: string;
  readonly declared: LabelClass | undefined;
  readonly hotkey: string | null;
}

export interface ClassFieldProps {
  readonly schema: AnnotationSchema;
  readonly activeClass: string | null;
  readonly onActivateClass: (labelClass: string | null) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Recently used in this job, most recent first. Ordered ahead of the schema's
   * own order, because a person labelling a road scene uses three of forty
   * classes and re-finding them by scrolling is the whole cost this saves.
   */
  readonly recent?: readonly string[];
  /**
   * Open the add-a-class dialog, or absent where there is nowhere to add one.
   *
   * It takes the typed name so a caller *can* seed the dialog with it; the
   * annotator page deliberately does not yet, because `AddClassDialog` has no
   * prop to seed and belongs to WS4. The argument is here rather than added
   * later so the row's contract does not change when that lands.
   */
  readonly onAddClass?: (name: string) => void;
  readonly disabled?: boolean;
}

/**
 * The rows, recent first and then the schema's own order.
 *
 * `select` leads always: it is not a class and has no recency, and burying the
 * way *out* of drawing mode under a usage list would be the one row a person
 * cannot predict the position of.
 */
export function classChoices(
  schema: AnnotationSchema,
  recent: readonly string[],
): readonly ClassChoice[] {
  const declared = new Map<string, LabelClass>(
    schema.classes.map((entry) => [entry.name, entry]),
  );
  const ordered: LabelClass[] = [];
  for (const name of recent) {
    const found = declared.get(name);
    // A recently-used class the schema no longer declares is simply gone — the
    // list is a convenience over the schema, never a second source of classes.
    if (found !== undefined && !ordered.includes(found)) ordered.push(found);
  }
  for (const entry of schema.classes) if (!ordered.includes(entry)) ordered.push(entry);

  return [
    { labelClass: null, name: "Select", geometry: "no drawing", declared: undefined, hotkey: "V" },
    ...ordered.map((entry) => ({
      labelClass: entry.name,
      name: entry.name,
      geometry: entry.geometry,
      declared: entry,
      // The digit is the schema's authored position, never this list's — the
      // hotkeys are bound in schema order (#46) and reordering rows here must
      // not reprint them.
      hotkey: hotkeyForClass(schema, entry.name),
    })),
  ];
}

export function ClassField({
  schema,
  activeClass,
  onActivateClass,
  open,
  onOpenChange,
  recent = [],
  onAddClass,
  disabled = false,
}: ClassFieldProps): JSX.Element {
  const choices = classChoices(schema, recent);
  const current = choices.find((choice) => choice.labelClass === activeClass) ?? choices[0];

  if (schema.classes.length === 0) {
    return (
      <button
        type="button"
        data-testid="class-field-empty"
        aria-label="No classes — create one"
        disabled={disabled || onAddClass === undefined}
        className="flex h-8 items-center gap-2 rounded-md border border-dashed border-input px-3 text-body text-muted-foreground disabled:cursor-not-allowed"
        onClick={() => onAddClass?.("")}
      >
        No classes — create one
      </button>
    );
  }

  return (
    <Combobox
      testId="class-field"
      label="Drawing class"
      placeholder="Filter classes…"
      emptyLabel="No class matches"
      open={open}
      onOpenChange={onOpenChange}
      disabled={disabled}
      items={choices}
      itemKey={(choice) => choice.labelClass ?? "__select__"}
      itemLabel={(choice) => choice.name}
      onSelect={(choice) => onActivateClass(choice.labelClass)}
      trigger={
        <>
          <Swatch choice={current} />
          <span className="truncate" data-testid="class-field-name">
            {current.name}
          </span>
          {current.hotkey !== null && <Hotkey>{current.hotkey}</Hotkey>}
        </>
      }
      renderItem={(choice) => (
        <>
          <Swatch choice={choice} />
          <span className="min-w-0 flex-1 truncate">{choice.name}</span>
          <span className="text-meta text-muted-foreground">{choice.geometry}</span>
          {choice.hotkey !== null && <Hotkey>{choice.hotkey}</Hotkey>}
        </>
      )}
      footer={(query) => {
        // Only when nothing matched *and* something was typed: an always-present
        // create row would put a schema change one stray Enter away from a person
        // who was picking a class.
        if (onAddClass === undefined || query === "") return null;
        if (choices.some((choice) => choice.name.toLowerCase() === query.toLowerCase())) {
          return null;
        }
        const name = query;
        return {
          label: `Create class "${name}"`,
          testId: "class-field-create",
          onSelect: () => onAddClass(name),
        };
      }}
    />
  );
}

/**
 * The class's colour, from the one derivation there is.
 *
 * `classColor` — schema colour first, else a hash of the name — is the single
 * spelling, shared with the canvas so a swatch here and a box out there are the
 * same colour by construction rather than by two formulas agreeing.
 */
function Swatch({ choice }: { readonly choice: ClassChoice }): JSX.Element {
  if (choice.labelClass === null) {
    return <span className="size-2.5 shrink-0 rounded-full border border-border" aria-hidden="true" />;
  }
  return (
    <span
      className="size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: classColor(choice.declared, choice.name) }}
      aria-hidden="true"
    />
  );
}

function Hotkey({ children }: { readonly children: string }): JSX.Element {
  return (
    <kbd className="shrink-0 rounded border border-border px-1 font-mono text-meta text-muted-foreground">
      {children}
    </kbd>
  );
}
