/**
 * One thing a control has to say — the outcome of a press, or a refusal — in an
 * icon in the line's tone, the words, and the way on at the end when it leads
 * somewhere.
 *
 * A control renders its own lines and never knows where they land. Inside a
 * sheet (`BatchSheet`) the sheet has no room for messages: an outcome and a
 * refusal become a toast — the house `Toaster`, bottom right — carrying the
 * same words, the same way on and the same `data-testid`. A lasting state is no
 * line at all: the sheet's own properties say it (State and its *Open the
 * dataset ↗*, In dataset). Anywhere else — a test, a screen with no sheet — the
 * line stays in place, as a row.
 *
 * A toast is raised once, when the line appears, and keyed by its test id, so a
 * second render (StrictMode, a refetch) never stacks another; its words follow
 * the line live (`spokenLines`), so a report that settles after the press is
 * corrected in place, and a toast a person closed stays closed.
 * A refusal stays up twice as long as an outcome: it is the one a person has to
 * read and act on.
 */

import { cn } from "@robomous/ui-core";
import { CircleAlert, CircleCheckBig, type LucideIcon } from "lucide-react";
import { useContext, useEffect, useEffectEvent, useId, useSyncExternalStore, type JSX, type ReactNode } from "react";
import { toast } from "sonner";

import { InSheet, spokenLines } from "./sheetLines";

export type SheetLineTone = "success" | "error";

const TONE: Record<SheetLineTone, { readonly Icon: LucideIcon; readonly ink: string }> = {
  success: { Icon: CircleCheckBig, ink: "text-success" },
  error: { Icon: CircleAlert, ink: "text-destructive" },
};

/** How long a toast stays: an outcome is glanced at, a refusal is read. */
const DURATION: Record<SheetLineTone, number> = { success: 5000, error: 10000 };

export interface SheetLineProps {
  readonly tone: SheetLineTone;
  /** The words. Mark a secondary clause muted inside them. */
  readonly children: ReactNode;
  /** The way on — a link — at the line's end. */
  readonly action?: ReactNode;
  /** On the words, so a test reads the sentence and not the link beside it. */
  readonly "data-testid"?: string;
}

export function SheetLine(props: SheetLineProps): JSX.Element | null {
  return useContext(InSheet) ? <AsToast {...props} /> : <AsRow {...props} />;
}

/** Inside a sheet: an outcome or a refusal, raised as a toast once. */
function AsToast({ tone, children, action, "data-testid": testId }: SheetLineProps): null {
  const fallback = useId();
  const id = testId ?? fallback;
  // The words follow the line every render; the toast is raised once per line.
  useEffect(() => {
    spokenLines.set(id, { words: children, way: action });
  });
  const raise = useEffectEvent((): void => {
    spokenLines.set(id, { words: children, way: action });
    (tone === "error" ? toast.error : toast.success)(<Spoken id={id} testId={testId} />, { id, duration: DURATION[tone] });
  });
  useEffect(() => raise(), [tone, id]);
  return null;
}

/** A toast's words, read live from the line that raised it. */
function Spoken({ id, testId }: { readonly id: string; readonly testId: string | undefined }): JSX.Element | null {
  const line = useSyncExternalStore(spokenLines.subscribe, () => spokenLines.get(id));
  if (line === undefined) return null;
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="text-pretty tabular-nums" data-testid={testId}>
        {line.words as ReactNode}
      </span>
      {line.way !== undefined && <span className="flex">{line.way as ReactNode}</span>}
    </span>
  );
}

/** Anywhere else: the line in place, a row of its own. */
function AsRow({ tone, children, action, "data-testid": testId }: SheetLineProps): JSX.Element {
  const { Icon, ink } = TONE[tone];
  return (
    <div
      data-line=""
      {...(tone === "error" ? { role: "alert" } : {})}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 text-xs leading-5"
    >
      {/* 16px on a 20px line: 2px down centres it on the first line, however many the words wrap to. */}
      <Icon aria-hidden="true" strokeWidth={1.75} className={cn("mt-0.5 size-4 shrink-0", ink)} />
      <span className="min-w-0 text-pretty text-foreground tabular-nums" data-testid={testId}>
        {children}
      </span>
      {action !== undefined && <span className="flex shrink-0 justify-end">{action}</span>}
    </div>
  );
}
