/**
 * A filtering combobox: a text field that narrows a list, plus one optional row
 * after it.
 *
 * ## Built here rather than installed
 *
 * `DESIGN.md`'s **Libraries** section constrains what may be added, and a
 * combobox is the wrong size of thing to take a dependency for. What it needs is
 * a text input, a list, and four keys — all of which this repository already has
 * — and what a library would bring with it is its own focus management, which is
 * exactly the part that has to cooperate with the annotator canvas's keyboard
 * root. The behaviour is modelled on the hand-built filter + arrow-key list in
 * `screens/SchemaEditor.tsx`.
 *
 * Radix is a dependency already, so `Popover` was available and was declined for
 * the same reason: it owns focus on open and restores it on close, and the one
 * caller here needs the field focused while the popup is open and the *canvas*
 * focused after it closes — neither of which is a Popover's idea of correct.
 *
 * ## The footer is an option, not a button under the list
 *
 * "Create class `<text>`" has to be reachable by the same ArrowDown that reaches
 * every other row, or a keyboard user meets a dead end in exactly the state the
 * row exists for — nothing matched what they typed. So it is the last entry of
 * the listbox, carries `role="option"`, and takes the active ring like any other.
 * A `<button>` sitting below a `<ul>` would be correct HTML and unreachable in
 * the flow this is for.
 *
 * ## What it owns and what it does not
 *
 * `open` is the caller's, because something outside the field opens it — a
 * hotkey, a click on a summary. The query text, the active row and the focus
 * dance are ephemeral view state and stay in here; hoisting them would put three
 * `useState`s in every caller and make the invariant "the active row is always
 * within the filtered list" the caller's to maintain.
 *
 * Selecting **never** mutates the field's own text: this is a picker, not an
 * autocomplete. The trigger renders what is selected, and the query is cleared on
 * every close so re-opening starts from the whole list rather than from whatever
 * was typed a minute ago.
 */

import { useEffect, useId, useMemo, useRef, useState, type JSX, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { Input } from "./input";

/** An extra row after the items, or `null` for none in this state. */
export interface ComboboxFooter {
  readonly label: string;
  readonly onSelect: () => void;
  readonly testId?: string;
}

export interface ComboboxProps<T> {
  /** What shows when the popup is closed. Pressing it opens. */
  readonly trigger: ReactNode;
  readonly items: readonly T[];
  readonly itemKey: (item: T) => string;
  /** What the filter matches on, and what a screen reader reads for the row. */
  readonly itemLabel: (item: T) => string;
  readonly renderItem: (item: T) => ReactNode;
  readonly onSelect: (item: T) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Called with the live query, so a caller can offer "create `<what they
   * typed>`". Returning `null` renders no row.
   */
  readonly footer?: (query: string) => ComboboxFooter | null;
  readonly placeholder?: string;
  /** Said when the filter matches nothing and there is no footer either. */
  readonly emptyLabel?: string;
  readonly label: string;
  readonly testId?: string;
  readonly disabled?: boolean;
}

export function Combobox<T>({
  trigger,
  items,
  itemKey,
  itemLabel,
  renderItem,
  onSelect,
  open,
  onOpenChange,
  footer,
  placeholder,
  emptyLabel = "No matches",
  label,
  testId = "combobox",
  disabled = false,
}: ComboboxProps<T>): JSX.Element {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const optionId = (index: number): string => `${listId}-option-${index}`;
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === ""
      ? items
      : items.filter((item) => itemLabel(item).toLowerCase().includes(needle));
    // `itemLabel` is a prop and callers write it inline, so a new identity every
    // render would defeat this memo — the deps are the data, and the accessor is
    // assumed pure the way `Array.prototype.map`'s callback is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, query]);

  const extra = footer?.(query.trim()) ?? null;
  /** The footer sits one past the last item, so one number indexes both. */
  const rows = shown.length + (extra === null ? 0 : 1);

  // Re-opening starts clean, and the ring starts at the top. Both are the same
  // decision: a picker that reopened mid-list would put the highlight somewhere
  // the person did not leave it, because the list itself may have changed.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    // Directly, not behind a frame: this effect runs after the open render has
    // committed, so the field is already in the tree. Deferring it to a
    // `requestAnimationFrame` was the first draft and it cost the field the
    // focus in any environment that does not paint — which is every test.
    fieldRef.current?.focus();
  }, [open]);

  // Typing shortens the list, so the ring has to come back inside it. Clamped
  // rather than reset, so narrowing from six rows to two keeps the highlight on
  // the last one instead of jumping to the first.
  useEffect(() => {
    setActive((current) => (rows === 0 ? 0 : Math.min(current, rows - 1)));
  }, [rows]);

  // A press outside is a dismissal, and it must reach the canvas: the annotator
  // reads the keyboard off its own root, so a popup that swallowed the press
  // would leave every chord dead until the user clicked twice.
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) return;
      onOpenChange(false);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [open, onOpenChange]);

  function choose(index: number): void {
    if (extra !== null && index === shown.length) {
      onOpenChange(false);
      extra.onSelect();
      return;
    }
    const item = shown[index];
    if (item === undefined) return;
    onOpenChange(false);
    onSelect(item);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onOpenChange(false);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(active);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (rows === 0) return;
    // Wrapping, because the footer is the last row: a person arrowing down past
    // "create it" expects to land back at the top, not to stick.
    const step = event.key === "ArrowDown" ? 1 : -1;
    setActive((current) => (current + step + rows) % rows);
  }

  if (!open) {
    return (
      <div ref={rootRef} className="relative" data-testid={testId}>
        <button
          type="button"
          aria-label={label}
          aria-expanded={false}
          aria-haspopup="listbox"
          data-testid={`${testId}-trigger`}
          disabled={disabled}
          className="flex h-8 max-w-64 items-center gap-2 rounded-md border border-input bg-card px-2 text-sm text-foreground disabled:cursor-not-allowed disabled:pointer-events-none disabled:opacity-50"
          onClick={() => onOpenChange(true)}
        >
          {trigger}
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative" data-testid={testId}>
      <Input
        ref={fieldRef}
        role="combobox"
        aria-label={label}
        aria-expanded
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={rows === 0 ? undefined : optionId(active)}
        data-testid={`${testId}-input`}
        className="h-8 w-64"
        placeholder={placeholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        // A blur that is not a dismissal — clicking a row — would close the popup
        // before the click landed. The outside-press listener above is what
        // dismisses, so blur does nothing here on purpose.
      />
      <ul
        id={listId}
        role="listbox"
        aria-label={label}
        data-testid={`${testId}-list`}
        className="dark absolute left-0 top-9 z-50 max-h-72 w-64 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
      >
        {shown.map((item, index) => (
          <li
            key={itemKey(item)}
            id={optionId(index)}
            role="option"
            aria-selected={index === active}
            data-testid={`${testId}-option-${itemKey(item)}`}
            data-active={index === active ? "true" : "false"}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm",
              index === active && "bg-accent text-accent-foreground",
            )}
            // `mousedown`, not `click`: the outside-press dismissal also runs on
            // mousedown, and a row that waited for `click` would be gone by then.
            onMouseDown={(event) => {
              event.preventDefault();
              choose(index);
            }}
            onMouseEnter={() => setActive(index)}
          >
            {renderItem(item)}
          </li>
        ))}

        {extra !== null && (
          <li
            id={optionId(shown.length)}
            role="option"
            aria-selected={shown.length === active}
            data-testid={extra.testId ?? `${testId}-footer`}
            data-active={shown.length === active ? "true" : "false"}
            className={cn(
              "mt-1 flex cursor-pointer items-center gap-2 rounded-md border-t border-border px-1.5 py-1 text-sm text-muted-foreground",
              shown.length === active && "bg-accent text-accent-foreground",
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              choose(shown.length);
            }}
            onMouseEnter={() => setActive(shown.length)}
          >
            {extra.label}
          </li>
        )}

        {rows === 0 && (
          <li
            role="presentation"
            data-testid={`${testId}-empty`}
            className="px-1.5 py-1 text-sm text-muted-foreground"
          >
            {emptyLabel}
          </li>
        )}
      </ul>
    </div>
  );
}
