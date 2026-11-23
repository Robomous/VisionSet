/**
 * The Classes section's table: one row per class, in hotkey order, on the
 * same full-bleed grid the workspace lists use (`ListGrid`).
 *
 * A row is the class at a glance — its colour and name, the shapes it is drawn
 * with, its attributes, how much has been drawn with it and on how many
 * images, and the digit the annotator binds to it. Its name is a real button
 * that opens the class sheet; `↑`/`↓` (or `J`/`K`) move between rows and
 * `Enter` opens the focused one. The `⋯` menu holds the row's edits.
 *
 * ## What the draft does to a row
 *
 * A dot in the inset beside the swatch says the draft touches the class, and
 * its tooltip says how, in the kernel's own words where the kernel has said
 * any (`POST .../schema/preview`). A class the draft removed stays in the table
 * where it stood, struck through, with the way to keep it — a removal is a
 * change like any other, and one that is about to be published should be seen.
 * The marks are read by `SchemaEditor`; this file only draws them.
 *
 * ## Read-only is structural
 *
 * A published version's rows open to read the class and have **no edit
 * affordance at all** — no menu, no restore, nothing that takes input. Not
 * disabled: there is no "not now" for an immutable version.
 *
 * ## Data-only
 *
 * Rows arrive as view models, so the editor does the reading and this file
 * only draws and moves.
 */

import { Ellipsis, Hash, Images, Keyboard, ListTree, Pencil, RotateCcw, Shapes, Tags, Trash2, Undo2 } from "lucide-react";
import { useId, useMemo, useRef, type JSX, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Kbd,
  Progress,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@robomous/ui-core";
import { formatGeometries } from "../data/geometryCategory";
import { formatCount } from "../lib/format";
import { BODY_ROW, ColumnHeader, ListGrid, type ListColumn } from "../patterns/ListPage";
import { columnLines } from "../patterns/listColumns";
import { usePagination } from "../patterns/pagination";
import { ShapeGlyph } from "../patterns/ShapeGlyph";
import { TableFooter } from "../patterns/TablePager";
import type { AttributeBody, LabelClassBody } from "./queries";
import type { ClassChange } from "./schemaClassDiff";
import { AttributeDiff, KeyDiff, NarrowsPill, ShapeDiff, StatusPill } from "./SchemaVersionMarks";

/**
 * What the draft — or the version being read — does to one class.
 *
 * `blocked` is a class the preview says frames still carry, over whatever else
 * the row would say; `removed` is a class the active version declares and the
 * draft does not.
 */
export type RowMark = "new" | "changed" | "blocked" | "removed";

const MARK: Record<RowMark, { readonly label: string; readonly dot: string }> = {
  new: { label: "New", dot: "bg-success" },
  changed: { label: "Changed", dot: "bg-info" },
  blocked: { label: "In the way", dot: "bg-warning" },
  removed: { label: "Removed", dot: "bg-destructive" },
};

export interface ClassRowView {
  /** Stable across renders: the draft index, or the removed class's name. */
  readonly key: string;
  readonly declared: LabelClassBody;
  /** Its place in the list it is read from; `null` for a class the draft removed. */
  readonly index: number | null;
  /** Its colour, declared or derived. */
  readonly swatch: string;
  readonly annotations: number;
  /** How many images carry it. */
  readonly images: number;
  readonly mark: RowMark | null;
  /** What the mark's tooltip says, one line each. */
  readonly markDetail: readonly string[];
  /** The draft's copy differs from the active version's, so it can be undone. */
  readonly revertable: boolean;
  /**
   * A published version's row, compared with its parent: what each cell gained
   * and lost. Present only in `read` mode, where it replaces the mark dot.
   */
  readonly change?: ClassChange;
}

export interface ClassTableProps {
  readonly rows: readonly ClassRowView[];
  /** `draft` edits; `read` shows a published version, with no control to change it. */
  readonly mode: "draft" | "read";
  /** The busiest class's count, which a share bar is measured against. Never zero. */
  readonly mostDrawn: number;
  /** A save or a removal check is in flight: the edits wait for it. */
  readonly locked: boolean;
  readonly label: string;
  readonly testId: string;
  readonly onOpen: (row: ClassRowView) => void;
  readonly onRemove?: (index: number) => void;
  readonly onRevert?: (index: number) => void;
  readonly onKeep?: (row: ClassRowView) => void;
  /** The row's open button, for focus to return to. */
  readonly rowRef: (row: ClassRowView, element: HTMLButtonElement | null) => void;
  /**
   * What the rows were narrowed by — the filter, the lens, the version read —
   * as one string: a new value sends the table back to its first page.
   */
  readonly resetKey: string;
  /** How many classes there are before a filter narrowed `rows`; the footer says so when it did. */
  readonly unfiltered: number;
  /**
   * A row to bring into view: the one a sheet opened on, or focus is about to
   * return to. A new `token` asks again; `key` is the row's.
   */
  readonly reveal?: { readonly key: string; readonly token: string } | null;
}

/**
 * The columns, declared once. Every width but the first is a plain `w-N`, so
 * `columnLines` can carry the hairlines on below the last row.
 */
function classColumns(mode: "draft" | "read"): readonly ListColumn[] {
  return [
    { key: "class" },
    { key: "shapes", width: "w-36" },
    { key: "attributes", width: "w-44" },
    { key: "annotations", width: "w-40" },
    { key: "images", width: "w-24" },
    { key: "key", width: "w-20" },
    ...(mode === "draft" ? [{ key: "menu", width: "w-14" }] : []),
  ];
}

/** Below this the grid scrolls sideways inside its frame, never the page. */
export const CLASS_TABLE_MIN_WIDTH = "min-w-[57rem]";

export function ClassTable({
  rows,
  mode,
  mostDrawn,
  locked,
  label,
  testId,
  onOpen,
  onRemove,
  onRevert,
  onKeep,
  rowRef,
  resetKey,
  unfiltered,
  reveal = null,
}: ClassTableProps): JSX.Element {
  const columns = useMemo(() => classColumns(mode), [mode]);
  const editable = mode === "draft";
  // 25 to a page, in hotkey order: a row's digit is its place in the schema,
  // never its place on the page.
  const paging = usePagination(rows, {
    pageSize: 25,
    resetKey,
    reveal: reveal === null ? null : { token: reveal.token, index: rows.findIndex((row) => row.key === reveal.key) },
  });
  const frame = useRef<HTMLDivElement>(null);

  function onKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const down = event.key === "ArrowDown" || event.key === "j";
    const up = event.key === "ArrowUp" || event.key === "k";
    if (!down && !up) return;
    // Only from a row's own button: inside a menu or a hint the keys are theirs.
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.dataset.classRow === undefined) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-class-row]")];
    const at = buttons.indexOf(target as HTMLButtonElement);
    const next = buttons[at + (down ? 1 : -1)];
    // Stops at the ends rather than wrapping or leaving the table.
    event.preventDefault();
    next?.focus();
  }

  // A click anywhere else on a class's row opens it too — a pointer
  // convenience. The keyboard's way in is the row's name button, so this is
  // delegated to the table's frame rather than put on each (non-focusable) row.
  function onTableClick(event: MouseEvent<HTMLDivElement>): void {
    const key = event.target instanceof Element ? event.target.closest<HTMLElement>("tr[data-open-key]")?.dataset.openKey : undefined;
    const row = key === undefined ? undefined : rows.find((one) => one.key === key);
    if (row !== undefined) onOpen(row);
  }

  return (
    <>
      {/* Fills the section and scrolls inside it where the section is fitted to
      the window; the header row stays on top on the page's own surface, so
      rows never show through it. Below the last row the column hairlines run
      on to the foot, so a short list leaves table, not a blank page. */}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col bg-no-repeat [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-background",
          // The draft's commit bar floats over the table's foot: room below the
          // last row, so every row scrolls clear of it. Wide, where the table
          // scrolls inside the section; narrower, the page scrolls and the bar's
          // own anchor makes the room.
          editable && "lg:[&>div>div]:pb-24",
        )}
        style={columnLines(columns)}
        // A wrapper that only catches the rows' bubbled keys and clicks: the
        // interactive things are the rows' own buttons, so it carries no
        // semantics of its own.
        role="presentation"
        onKeyDown={onKey}
        onClick={onTableClick}
      >
        <ListGrid
          columns={columns}
          minWidth={CLASS_TABLE_MIN_WIDTH}
          label={label}
          testId={testId}
          frameRef={frame}
          head={
            <>
              <ColumnHeader icon={Tags} label="Class" />
              <ColumnHeader icon={Shapes} label="Shapes" />
              <ColumnHeader icon={ListTree} label="Attributes" />
              <ColumnHeader icon={Hash} label="Annotations" align="right" />
              <ColumnHeader icon={Images} label="Images" align="right" />
              <ColumnHeader icon={Keyboard} label="Key" />
              {editable && <ColumnHeader label="Actions" hidden />}
            </>
          }
        >
          <tbody>
            {paging.slice.map((row) =>
              row.change !== undefined ? (
                <VersionClassRow
                  key={row.key}
                  row={row}
                  change={row.change}
                  mostDrawn={mostDrawn}
                  onOpen={() => onOpen(row)}
                  buttonRef={(element) => rowRef(row, element)}
                />
              ) : (
                <ClassRow
                  key={row.key}
                  row={row}
                  mode={mode}
                  mostDrawn={mostDrawn}
                  locked={locked}
                  onOpen={() => onOpen(row)}
                  {...(onRemove === undefined ? {} : { onRemove })}
                  {...(onRevert === undefined ? {} : { onRevert })}
                  {...(onKeep === undefined ? {} : { onKeep: () => onKeep(row) })}
                  buttonRef={(element) => rowRef(row, element)}
                />
              ),
            )}
          </tbody>
        </ListGrid>
      </div>
      {/* Under the table, outside the rows' delegating frame and its hairlines. */}
      <TableFooter pagination={paging} frameRef={frame} noun="class" plural="classes" unfiltered={unfiltered} />
    </>
  );
}

/** A detail said on hover and on focus. Its trigger is always a real button. */
function Hint({
  content,
  children,
  side = "top",
}: {
  readonly content: ReactNode;
  readonly children: ReactNode;
  readonly side?: "top" | "right" | "bottom" | "left";
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="max-w-72 text-pretty">
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

function ClassRow({
  row,
  mode,
  mostDrawn,
  locked,
  onOpen,
  onRemove,
  onRevert,
  onKeep,
  buttonRef,
}: {
  readonly row: ClassRowView;
  readonly mode: "draft" | "read";
  readonly mostDrawn: number;
  readonly locked: boolean;
  readonly onOpen: () => void;
  readonly onRemove?: (index: number) => void;
  readonly onRevert?: (index: number) => void;
  readonly onKeep?: () => void;
  readonly buttonRef: (element: HTMLButtonElement | null) => void;
}): JSX.Element {
  const { declared, index, swatch, mark } = row;
  const removed = mark === "removed" || index === null;
  const editable = mode === "draft";
  const name = declared.name === "" ? "New class" : declared.name;
  const attributes = declared.attributes ?? [];
  const slot = index === null ? row.key : String(index);

  return (
    <tr
      // Opened by the table frame's delegated click (`ClassTable`), unless removed.
      data-open-key={removed ? undefined : row.key}
      className={cn(
        BODY_ROW,
        // Hover is a fill that appears at once: rows are scanned, and a fade on
        // every one the pointer crosses would trail behind it.
        "[--row-fill:color-mix(in_oklab,var(--color-muted)_40%,var(--color-background))]",
        !removed && "cursor-pointer hover:bg-(--row-fill) focus-within:bg-(--row-fill)",
      )}
      data-testid={index === null ? `class-removed-${declared.name}` : `${editable ? "class" : "past"}-row-${index}`}
      data-mark={mark ?? undefined}
    >
      <td className="relative">
        <ClassNameCell
          row={row}
          editable={editable}
          removed={removed}
          name={name}
          locked={locked}
          onOpen={onOpen}
          onKeep={onKeep}
          buttonRef={buttonRef}
        />
      </td>

      <td>
        <ClassShapes geometries={declared.geometries} swatch={swatch} faded={removed} />
      </td>

      <td>
        <AttributesCell attributes={attributes} name={name} slot={slot} />
      </td>

      <td className="text-right">
        <ClassAnnotationShare row={row} name={name} mostDrawn={mostDrawn} />
      </td>

      <td className="text-right tabular-nums">
        <ImageCount images={row.images} />
      </td>

      <td>{!removed && index < 9 && <Hotkey index={index} />}</td>

      {editable && (
        <td className="text-right" onClick={(event) => event.stopPropagation()}>
          {!removed && (
            <RowMenu
              name={name}
              index={index}
              revertable={row.revertable}
              locked={locked}
              onEdit={onOpen}
              onRemove={onRemove}
              onRevert={onRevert}
            />
          )}
        </td>
      )}
    </tr>
  );
}

/** The shapes a class is drawn with, as glyphs in its own colour. */
function ClassShapes({
  geometries,
  swatch,
  faded,
}: {
  readonly geometries: ClassRowView["declared"]["geometries"];
  readonly swatch: string;
  readonly faded: boolean;
}): JSX.Element {
  return (
    <span className={cn("flex items-center gap-0.5 overflow-hidden", faded && "opacity-50")} title={formatGeometries(geometries)}>
      <span className="sr-only">{formatGeometries(geometries)}</span>
      {geometries.map((geometry) => (
        <ShapeGlyph key={geometry} geometry={geometry} color={swatch} className="h-5 w-7 shrink-0" />
      ))}
    </span>
  );
}

/** The first cell of a draft row: the mark's dot, swatch, name, and a removed class's way back. */
function ClassNameCell({
  row,
  editable,
  removed,
  name,
  locked,
  onOpen,
  onKeep,
  buttonRef,
}: {
  readonly row: ClassRowView;
  readonly editable: boolean;
  readonly removed: boolean;
  readonly name: string;
  readonly locked: boolean;
  readonly onOpen: () => void;
  readonly onKeep: (() => void) | undefined;
  readonly buttonRef: (element: HTMLButtonElement | null) => void;
}): JSX.Element {
  const { declared, swatch, mark } = row;
  // The row's name is what pressing it does; the mark is said after it, as a
  // description, so "Edit person" stays the name a person — or a test — finds.
  const markId = useId();
  const kept = editable && removed && onKeep !== undefined;
  return (
    <>
      {mark !== null && <ClassMarkDot row={row} mark={mark} markId={markId} />}
      <div className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-[3px]", removed && "opacity-40")} style={{ background: swatch }} />
        {removed ? (
          <RemovedClassName name={name} mark={mark} annotations={row.annotations} />
        ) : (
          <ClassOpenButton row={row} editable={editable} name={name} markId={markId} onOpen={onOpen} buttonRef={buttonRef} />
        )}
        {kept && <RestoreButton name={name} declaredName={declared.name} locked={locked} onKeep={onKeep} />}
      </div>
    </>
  );
}

/** The dot in the row's inset that says the draft touches the class; its tooltip says how. */
function ClassMarkDot({ row, mark, markId }: { readonly row: ClassRowView; readonly mark: RowMark; readonly markId: string }): JSX.Element {
  const { declared, index } = row;
  const markTestId = index === null ? `class-mark-removed-${declared.name}` : `class-mark-${index}`;
  return (
    <Hint side="right" content={<MarkHint mark={mark} lines={row.markDetail} />}>
      <button
        type="button"
        id={markId}
        onClick={(event) => event.stopPropagation()}
        data-testid={markTestId}
        // The dot sits in the row's inset, beside the swatch; its hit
        // area reaches 32px past the 6px it draws.
        className={cn(
          "absolute top-1/2 left-[5px] size-1.5 -translate-y-1/2 rounded-full outline-none after:absolute after:-inset-[13px] focus-visible:ring-2 focus-visible:ring-ring/50 md:left-[9px]",
          MARK[mark].dot,
        )}
      >
        <span className="sr-only">{MARK[mark].label}</span>
      </button>
    </Hint>
  );
}

/** A class the draft removed: struck through, with why it still shows. */
function RemovedClassName({ name, mark, annotations }: { readonly name: string; readonly mark: RowMark | null; readonly annotations: number }): JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="min-w-0 truncate text-muted-foreground line-through decoration-muted-foreground/60">{name}</span>
      <span className={cn("shrink-[100] truncate text-xs", mark === "blocked" ? "text-warning" : "text-muted-foreground")}>
        {mark === "blocked" ? `In use · ${formatCount(annotations)}` : "Removed"}
      </span>
    </span>
  );
}

/** The class's name as the real button that opens it. */
function ClassOpenButton({
  row,
  editable,
  name,
  markId,
  onOpen,
  buttonRef,
}: {
  readonly row: ClassRowView;
  readonly editable: boolean;
  readonly name: string;
  readonly markId: string;
  readonly onOpen: () => void;
  readonly buttonRef: (element: HTMLButtonElement | null) => void;
}): JSX.Element {
  const { declared, index, mark } = row;
  const attributes = declared.attributes ?? [];
  return (
    <button
      type="button"
      ref={buttonRef}
      data-class-row=""
      data-testid={`${editable ? "class-card" : "past-class"}-${index}`}
      aria-label={`${editable ? "Edit" : "Show"} ${name}`}
      {...(mark === null ? {} : { "aria-describedby": markId })}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className="-mx-1.5 flex min-w-0 flex-1 items-baseline gap-2 rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <span className={cn("min-w-0 truncate font-medium", declared.name === "" && "text-muted-foreground")}>{name}</span>
      {mark === "new" && <span className="shrink-0 text-xs text-success">New</span>}
      {attributes.length > 0 && (
        // Gives way before the name does.
        <span className="min-w-0 shrink-[100] truncate text-xs text-muted-foreground tabular-nums">
          {formatCount(attributes.length)} {attributes.length === 1 ? "attribute" : "attributes"}
        </span>
      )}
    </button>
  );
}

/** A removed class's way back into the draft. */
function RestoreButton({
  name,
  declaredName,
  locked,
  onKeep,
}: {
  readonly name: string;
  /** The class's declared name, which names the control for a test. */
  readonly declaredName: string;
  readonly locked: boolean;
  readonly onKeep: (() => void) | undefined;
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      // Its word folds away before the name does; the icon and its
      // name for a screen reader stay.
      className="ml-auto shrink-0 max-xl:px-2"
      disabled={locked}
      data-testid={`keep-class-${declaredName}`}
      aria-label={`Restore ${name}`}
      onClick={(event) => {
        event.stopPropagation();
        onKeep?.();
      }}
    >
      <RotateCcw data-icon="inline-start" className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
      <span className="max-xl:hidden">Restore</span>
    </Button>
  );
}

/** A draft row's annotation count and its share of the busiest class, with test hooks for the row's slot. */
function ClassAnnotationShare({ row, name, mostDrawn }: { readonly row: ClassRowView; readonly name: string; readonly mostDrawn: number }): JSX.Element {
  const { index, swatch } = row;
  const countTestId = index === null ? undefined : `class-card-count-${index}`;
  if (row.annotations === 0) {
    return (
      <span className="text-xs text-muted-foreground" data-testid={countTestId}>
        Not used yet
      </span>
    );
  }
  return (
    <span className="flex items-center justify-end gap-2.5">
      {/* In the class's own colour, so a bar is found by the swatch at the
          row's start; the track is the same hue, faint — `color-mix`
          because the colour may be any CSS spelling. */}
      <Progress
        value={(row.annotations / mostDrawn) * 100}
        aria-label={`${name}: share of the most-drawn class`}
        data-testid={index === null ? undefined : `class-card-bar-${index}`}
        className="min-w-0 flex-1 bg-(--bar-track) [&>[data-slot=progress-indicator]]:bg-(--bar)"
        style={{
          ["--bar" as string]: swatch,
          ["--bar-track" as string]: `color-mix(in oklab, ${swatch} 16%, transparent)`,
        }}
      />
      <span className="w-14 shrink-0 tabular-nums" data-testid={countTestId}>
        {formatCount(row.annotations)}
        <span className="sr-only"> {row.annotations === 1 ? "annotation" : "annotations"}</span>
      </span>
    </span>
  );
}

/** How many images carry the class, or a dash that says none do. */
function ImageCount({ images }: { readonly images: number }): JSX.Element {
  if (images === 0) {
    return (
      <span className="text-muted-foreground">
        <span aria-hidden="true">—</span>
        <span className="sr-only">No images</span>
      </span>
    );
  }
  return <>{formatCount(images)}</>;
}

/** The digit the annotator binds to the class. */
function Hotkey({ index }: { readonly index: number }): JSX.Element {
  return (
    <Kbd aria-label={`Hotkey ${index + 1}`} className="tabular-nums">
      {index + 1}
    </Kbd>
  );
}

function MarkHint({ mark, lines }: { readonly mark: RowMark; readonly lines: readonly string[] }): JSX.Element {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium">{MARK[mark].label}</span>
      {lines.map((line, at) => (
        <span key={at}>{line}</span>
      ))}
    </span>
  );
}

const KIND_WORD: Record<AttributeBody["kind"], string> = {
  string: "text",
  number: "a number",
  boolean: "yes or no",
  select: "a choice",
};

function describeAttribute(attribute: AttributeBody): string {
  const options = attribute.kind === "select" && (attribute.options ?? []).length > 0 ? `: ${(attribute.options ?? []).join(", ")}` : "";
  return `${KIND_WORD[attribute.kind]}${options}${attribute.required ? " · required" : ""}`;
}

/** The attributes by name, truncated, with the whole list a hover away. */
function AttributesCell({
  attributes,
  name,
  slot,
}: {
  readonly attributes: readonly AttributeBody[];
  readonly name: string;
  readonly slot: string;
}): JSX.Element {
  if (attributes.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        <span aria-hidden="true">—</span>
        <span className="sr-only">No attributes</span>
      </span>
    );
  }
  // A required attribute carries a star, the way a form marks one.
  const names = attributes.map((attribute) => `${attribute.name === "" ? "unnamed" : attribute.name}${attribute.required ? "*" : ""}`).join(", ");
  return (
    <Hint
      side="bottom"
      content={
        <span className="flex flex-col gap-1">
          {attributes.map((attribute, at) => (
            <span key={at} className="flex gap-3">
              <span className="font-medium">{attribute.name === "" ? "unnamed" : attribute.name}</span>
              <span className="opacity-80">{describeAttribute(attribute)}</span>
            </span>
          ))}
        </span>
      }
    >
      <button
        type="button"
        onClick={(event) => event.stopPropagation()}
        data-testid={`class-attributes-${slot}`}
        aria-label={`Attributes of ${name}: ${names}`}
        className="flex h-7 max-w-full min-w-0 items-center rounded-sm text-left text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="truncate">{names}</span>
      </button>
    </Hint>
  );
}

/**
 * A published version's class, marked against the version before it.
 *
 * A touched row carries a 3px bar at its edge in its status colour and a word
 * after its name (New, Changed, Removed), with the kernel's sentences on
 * hover; a class the kernel says narrows the contract carries a warning. New
 * and removed rows wash faintly in their colour; in a changed row only the
 * cell that changed lifts, and in it only the values that moved are chips —
 * + added, − removed, optional → required. A removed class keeps its place,
 * struck through; a hotkey that moved shows its old digit struck beside it.
 * Read-only throughout: the name opens the class to read, nothing edits.
 */
function VersionClassRow({
  row,
  change,
  mostDrawn,
  onOpen,
  buttonRef,
}: {
  readonly row: ClassRowView;
  readonly change: ClassChange;
  readonly mostDrawn: number;
  readonly onOpen: () => void;
  readonly buttonRef: (element: HTMLButtonElement | null) => void;
}): JSX.Element {
  const { declared, index, swatch } = row;
  const removed = change.status === "removed";
  const whole = change.status === "added" || removed;
  // In a changed row, the cell that changed lifts.
  const lift = (moved: boolean): string | false => change.status === "changed" && moved && "bg-info/[0.045]";
  return (
    // The name is the row's one press (a real button); the row itself only
    // shows where the pointer is.
    <tr
      data-testid={index === null ? `class-removed-${declared.name}` : `past-row-${index}`}
      data-mark={row.mark ?? undefined}
      className={cn(
        BODY_ROW,
        "[--row-fill:color-mix(in_oklab,var(--color-muted)_40%,var(--color-background))]",
        !removed && "hover:bg-(--row-fill) focus-within:bg-(--row-fill)",
        change.status === "added" && "bg-success/[0.035] hover:bg-success/[0.06]",
        removed && "bg-destructive/[0.035] [&>td:not(:first-child)]:opacity-60",
      )}
    >
      <td className="relative">
        <VersionClassName row={row} change={change} onOpen={onOpen} buttonRef={buttonRef} />
      </td>
      <td className={cn(lift(change.shapes.some((token) => token.state !== "kept")))}>
        <ShapeDiff shapes={change.shapes} swatch={swatch} plain={whole} />
      </td>
      <td className={cn(lift(change.attributes.some((token) => token.state !== "kept")))}>
        <AttributeDiff attributes={change.attributes} plain={whole} />
      </td>
      <td className="text-right">
        <AnnotationShare name={declared.name} annotations={row.annotations} mostDrawn={mostDrawn} swatch={swatch} />
      </td>
      <td className="text-right tabular-nums">
        <ImageCount images={row.images} />
      </td>
      <td>
        <KeyDiff before={change.slot.before} after={change.slot.after} />
      </td>
    </tr>
  );
}

/** The first cell of a version's row: the status bar at its edge, swatch, name, and what happened to it. */
function VersionClassName({
  row,
  change,
  onOpen,
  buttonRef,
}: {
  readonly row: ClassRowView;
  readonly change: ClassChange;
  readonly onOpen: () => void;
  readonly buttonRef: (element: HTMLButtonElement | null) => void;
}): JSX.Element {
  const { declared, index, swatch, mark } = row;
  const removed = change.status === "removed";
  const slot = index === null ? declared.name : String(index);
  return (
    <>
      {mark !== null && <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-[3px]", MARK[mark].dot)} />}
      <div className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden="true" className={cn("size-2.5 shrink-0 rounded-[3px]", removed && "opacity-40")} style={{ background: swatch }} />
        {removed ? (
          <span className="min-w-0 truncate text-muted-foreground line-through decoration-muted-foreground/60">{declared.name}</span>
        ) : (
          <button
            type="button"
            ref={buttonRef}
            data-class-row=""
            data-testid={`past-class-${index}`}
            aria-label={`Show ${declared.name}`}
            onClick={onOpen}
            className="-mx-1.5 min-w-0 truncate rounded-md px-1.5 py-1 text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {declared.name}
          </button>
        )}
        {mark !== null && <StatusPill mark={mark} lines={row.markDetail} testId={index === null ? `class-mark-removed-${declared.name}` : `class-mark-${index}`} />}
        {change.narrows && <NarrowsPill testId={`class-mark-narrows-${slot}`} />}
      </div>
    </>
  );
}

/** How much of the busiest class this one has, as a bar in its own colour and a count. */
function AnnotationShare({
  name,
  annotations,
  mostDrawn,
  swatch,
}: {
  readonly name: string;
  readonly annotations: number;
  readonly mostDrawn: number;
  readonly swatch: string;
}): JSX.Element {
  if (annotations === 0) return <span className="text-xs text-muted-foreground">Not used yet</span>;
  return (
    <span className="flex items-center justify-end gap-2.5">
      <Progress
        value={(annotations / mostDrawn) * 100}
        aria-label={`${name}: share of the most-drawn class`}
        className="min-w-0 flex-1 bg-(--bar-track) [&>[data-slot=progress-indicator]]:bg-(--bar)"
        style={{
          ["--bar" as string]: swatch,
          ["--bar-track" as string]: `color-mix(in oklab, ${swatch} 16%, transparent)`,
        }}
      />
      <span className="w-14 shrink-0 tabular-nums">
        {formatCount(annotations)}
        <span className="sr-only"> {annotations === 1 ? "annotation" : "annotations"}</span>
      </span>
    </span>
  );
}

/**
 * The row's edits. Remove asks the server first, like every removal: a class
 * frames already carry is refused in the dialog that says which frames — the
 * item is never greyed out ahead of the answer.
 */
function RowMenu({
  name,
  index,
  revertable,
  locked,
  onEdit,
  onRemove,
  onRevert,
}: {
  readonly name: string;
  readonly index: number;
  readonly revertable: boolean;
  readonly locked: boolean;
  readonly onEdit: () => void;
  readonly onRemove: ((index: number) => void) | undefined;
  readonly onRevert: ((index: number) => void) | undefined;
}): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for ${name}`}
          data-testid={`class-menu-${index}`}
          // 28px drawn, 32px and more to press.
          className="relative after:absolute after:-inset-2"
        >
          <Ellipsis className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={onEdit} data-testid="class-menu-edit">
          <Pencil strokeWidth={1.75} aria-hidden="true" />
          Edit class
        </DropdownMenuItem>
        {revertable && onRevert !== undefined && (
          <DropdownMenuItem disabled={locked} onSelect={() => onRevert(index)} data-testid="class-menu-revert">
            <Undo2 strokeWidth={1.75} aria-hidden="true" />
            Undo its changes
          </DropdownMenuItem>
        )}
        {onRemove !== undefined && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={locked} onSelect={() => onRemove(index)} data-testid="class-menu-remove">
              <Trash2 strokeWidth={1.75} aria-hidden="true" />
              Remove class
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
