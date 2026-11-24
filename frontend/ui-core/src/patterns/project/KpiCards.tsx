/**
 * The project in four numbers: one row of cells, each a door into the section
 * that owns its number.
 *
 * ## Cells, not cards
 *
 * The four sit on one sheet — a 1px gap over the border colour between them,
 * no radius, no shadow — the list pages' header row grown to hold a number.
 * The work row under it uses the same four columns, so every vertical hairline
 * on the page continues one from here.
 *
 * ## The door
 *
 * A number whose section answers it is a way in (`docs/content/ui/navigation.md`:
 * Overview never duplicates a section's full function): a real `<button>` on
 * the label, stretched over the cell by its `::after`, so the whole cell is the
 * target. Anything else that takes the pointer is raised above that layer —
 * never a button inside a button.
 *
 * ## What needs attention, without a row for it
 *
 * A cell never reserves a row for a button it may not have. What needs somebody
 * — drafts waiting for review, a batch ready to add to the dataset — is a small badge in
 * the label row, and its steps open from it: on hover after a short intent
 * delay, on click, and on Enter. The steps are the screen's, labelled from what
 * the wire declares; this file draws, it never decides.
 *
 * A warning — true of the number, holding nothing back — is a warning glyph in
 * the same row, its card on hover and on focus (`patterns/WarnTip.tsx`).
 *
 * ## Still while loading
 *
 * Every cell has the same rows — label, value, context — in one fixed height
 * (`KPI_CARD_HEIGHT`, shared with the skeleton), so the numbers arriving change
 * text and nothing else. A value still loading is a dash in the value's own box.
 */

import { ArrowUpRight, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type JSX, type PointerEvent, type ReactNode } from "react";

import { Button, Popover, PopoverContent, PopoverTrigger, cn } from "@robomous/ui-core";
import { WarnTip } from "../WarnTip";
import { ProgressRing } from "../ProgressRing";

/** One cell's height, shared with the skeleton that stands in for it. */
export const KPI_CARD_HEIGHT = "h-[6.25rem]";

/** The sheet the cells — and their skeletons — sit in. */
export const KPI_GRID = "grid grid-cols-2 gap-px bg-border/70 lg:grid-cols-4";

/** The pane's inset, so a cell's text starts where the page's does. */
const INSET = "px-4 md:px-6";

/** A step that needs somebody, reached from the cell's badge. */
export interface KpiStep {
  readonly key: string;
  /** What it is about: a batch's name, "The dataset". */
  readonly subject: string;
  /** The step, already labelled from what the wire declares: "Review and add to dataset". */
  readonly label: string;
  readonly Icon: LucideIcon;
  readonly onGo: () => void;
  readonly "data-testid"?: string;
}

export interface KpiAttention {
  /** The badge, short: "2 to review", "Unreleased". */
  readonly badge: string;
  /** The popover's heading, whole: "2 drafts waiting for review". */
  readonly title: string;
  readonly tone: "warning" | "info";
  readonly steps: readonly KpiStep[];
  readonly "data-testid"?: string;
}

export interface KpiCard {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Pre-formatted, without its unit. `null` while its source has not answered. */
  readonly value: string | null;
  /** Beside the label, quieter: the count a cell drawing a chart instead of a number still owes. */
  readonly count?: string;
  /**
   * A drawing in place of the value and its context — the Classes cell's bar
   * of shares — in the same rows, so the cell keeps the row's one height. It
   * sits above the door's layer, so pointing into it never opens the section.
   */
  readonly body?: ReactNode;
  /** Drawn quieter than the value it follows — `62` and `%`, not four equal characters. */
  readonly unit?: string;
  /** A share of a whole, drawn as a ring after the figure: `progress` while partway, `success` once whole. */
  readonly meter?: { readonly value: number; readonly total: number };
  /** One short line under the value. */
  readonly context?: ReactNode;
  /** The section that owns the number. */
  readonly onGo?: () => void;
  /** Where `onGo` leads, for the accessible name: "Images", "the Dataset". */
  readonly goTo?: string;
  readonly attention?: KpiAttention;
  /** Something true of the number worth knowing, that holds nothing back: a warning glyph and its card. */
  readonly warning?: KpiWarning;
  readonly "data-testid"?: string;
}

export interface KpiWarning {
  /** The warning in a few words — "8 assets without labels". */
  readonly title: string;
  /** A line or two that says why it matters. */
  readonly body?: ReactNode;
  readonly "data-testid"?: string;
}

export function KpiCards({ cards, "data-testid": testId }: { readonly cards: readonly KpiCard[]; readonly "data-testid"?: string }): JSX.Element {
  return (
    <div className={KPI_GRID} data-testid={testId}>
      {cards.map((card) => (
        <Cell key={card.key} card={card} />
      ))}
    </div>
  );
}

function Cell({ card }: { readonly card: KpiCard }): JSX.Element {
  const door = card.onGo !== undefined;
  const { icon: Icon } = card;
  return (
    <section
      aria-label={card.label}
      data-testid={card["data-testid"]}
      className={cn(
        "group/kpi relative flex min-w-0 flex-col bg-background py-3",
        INSET,
        KPI_CARD_HEIGHT,
        // Instant, like a list row's: the pointer sweeps across these.
        door && "has-[[data-door]:hover]:bg-muted/40",
      )}
    >
      <h3 className="flex h-5 items-center gap-1.5 text-xs text-muted-foreground">
        <Icon aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.75} />
        {door ? (
          <button
            type="button"
            data-door=""
            onClick={card.onGo}
            aria-label={`${card.label}${card.value === null ? "" : `, ${card.value}${card.unit ?? ""}`}. Open ${card.goTo ?? card.label}`}
            className="min-w-0 truncate rounded-sm text-left outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset group-has-[[data-door]:hover]/kpi:text-foreground"
          >
            {card.label}
          </button>
        ) : (
          <span className="min-w-0 truncate">{card.label}</span>
        )}
        {card.count !== undefined && <span className="shrink-0 tabular-nums">{card.count}</span>}
        <LabelEnd card={card} door={door} />
      </h3>

      {card.body !== undefined ? <div className="relative z-10 mt-2 min-w-0">{card.body}</div> : <Figures card={card} />}
    </section>
  );
}

/** The label row's end: a warning, what needs somebody, and the door's arrow. */
function LabelEnd({ card, door }: { readonly card: KpiCard; readonly door: boolean }): JSX.Element {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5">
      {card.warning !== undefined && (
        // Above the door's layer: the warning is its own target.
        <span className="relative z-10 -my-1 flex">
          <WarnTip title={card.warning.title} size="sm" testId={card.warning["data-testid"]}>
            {card.warning.body}
          </WarnTip>
        </span>
      )}
      {card.attention !== undefined && <Attention attention={card.attention} />}
      {door && (
        <ArrowUpRight
          aria-hidden="true"
          strokeWidth={1.75}
          className="size-3.5 opacity-0 group-has-[[data-door]:focus-visible]/kpi:opacity-100 group-has-[[data-door]:hover]/kpi:opacity-100"
        />
      )}
    </span>
  );
}

/** A cell's number and the line under it, each in its own fixed row. */
function Figures({ card }: { readonly card: KpiCard }): JSX.Element {
  return (
    <>
      <p className="mt-1 flex h-8 items-baseline overflow-hidden">
        {card.value === null ? (
          <span className="text-2xl font-semibold text-muted-foreground">—</span>
        ) : (
          <>
            <span className="truncate text-2xl font-semibold tracking-tight tabular-nums">{card.value}</span>
            {card.unit !== undefined && <span className="ml-px text-sm font-medium text-muted-foreground">{card.unit}</span>}
            {/* The figure, then its ring, centred on its capitals — a touch taller than them (20px to their 18), because a circle reads smaller than a figure of the same height. */}
            {card.meter !== undefined && <ProgressRing
                value={card.meter.value}
                total={card.meter.total}
                className="ml-2.5 size-5 self-center"
                detail={{ title: card.label }}
              />}
          </>
        )}
      </p>

      <p className="mt-1 flex h-4 min-w-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
        <span className="min-w-0 truncate">{card.context}</span>
      </p>
    </>
  );
}

const TONE = {
  warning: { badge: "bg-warning/10 text-warning hover:bg-warning/15 data-[state=open]:bg-warning/15", dot: "bg-warning" },
  info: { badge: "bg-info-surface text-info hover:bg-info/15 data-[state=open]:bg-info/15", dot: "bg-info" },
} as const;

/** How long the pointer rests on the badge before its steps open, and leaves before they close. */
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 180;

/**
 * The badge and its steps. A popover rather than a tooltip, because what it
 * holds are buttons: it takes focus when opened from the keyboard or a click,
 * and stays out of the way of focus when the pointer merely rests on it.
 */
function Attention({ attention }: { readonly attention: KpiAttention }): JSX.Element {
  const [open, setOpen] = useState(false);
  const byHover = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const tone = TONE[attention.tone];

  useEffect(() => () => window.clearTimeout(timer.current), []);

  function later(next: boolean, delay: number): void {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      byHover.current = next;
      setOpen(next);
    }, delay);
  }
  const hover = {
    onPointerEnter: (event: PointerEvent) => event.pointerType === "mouse" && later(true, OPEN_DELAY_MS),
    onPointerLeave: (event: PointerEvent) => event.pointerType === "mouse" && later(false, CLOSE_DELAY_MS),
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        window.clearTimeout(timer.current);
        byHover.current = false;
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          {...hover}
          data-testid={attention["data-testid"]}
          aria-label={attention.title}
          className={cn(
            // Above the door's layer: the badge is its own target. Its 20px
            // face grows to a 32px hit area without moving the label row.
            "relative z-10 inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium tabular-nums outline-none transition-colors duration-150 ease-out after:absolute after:-inset-1.5 focus-visible:ring-2 focus-visible:ring-ring/50",
            tone.badge,
          )}
        >
          <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone.dot)} />
          {attention.badge}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-72 gap-0 p-0"
        {...hover}
        // A pointer resting on the badge is reading, not choosing: focus stays where it was.
        onOpenAutoFocus={(event) => byHover.current && event.preventDefault()}
      >
        <p className="border-b px-3 py-2 text-xs font-medium">{attention.title}</p>
        <ul className="flex flex-col p-1">
          {attention.steps.map((step) => (
            <li key={step.key}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  step.onGo();
                }}
                data-testid={step["data-testid"]}
                className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left font-normal"
              >
                <step.Icon data-icon="inline-start" className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px]">{step.label}</span>
                  <span className="truncate text-xs text-muted-foreground">{step.subject}</span>
                </span>
              </Button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
