/**
 * Loading, empty and error — the three states `DESIGN.md` says every async surface
 * must cover, as three components so that "covered" is a thing a reviewer can see
 * rather than a thing a screen claims.
 *
 * They are conventions, not policy: none of them fetches, retries or knows what an
 * API is. The data shell wires them to the query layer; the shapes are decided
 * here so that eight screens do not each invent one.
 *
 * ## Why the error state takes a `code`
 *
 * The API's error body is `{code, message, detail?, incident_id?}` and its whole
 * argument is that **clients branch on `code`, never on the status** — two 409s
 * exist and only one is retryable with a flag. A component that rendered only the
 * message would throw away the field that decides whether a retry is even
 * offered, so `ErrorState` takes the code, shows the message, and puts the
 * incident id where a person can quote it. What a retry *does* is the caller's.
 */

import { TriangleAlert } from "lucide-react";
import type { CSSProperties, JSX, ReactNode } from "react";

import { cn, Alert, AlertDescription, AlertTitle, Button, Skeleton } from "@robomous/ui-core";

import { EmptyArt, type EmptyArtName } from "./EmptyArt.js";

export interface LoadingStateProps {
  /** How many placeholder rows. Match the shape being waited for. */
  readonly rows?: number;
  readonly className?: string;
  readonly label?: string;
}

/**
 * Skeleton rows that occupy the space the data will.
 *
 * `aria-busy` with a visually hidden label, because the skeletons themselves are
 * `aria-hidden` — a screen reader announcing eight grey rectangles is worse than
 * silence, and silence with no explanation is worse than "Loading".
 */
export function LoadingState({
  rows = 3,
  className,
  label = "Loading",
}: LoadingStateProps): JSX.Element {
  return (
    <div aria-busy="true" className={cn("flex flex-col gap-2", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

export interface EmptyStateProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** One primary action, per `DESIGN.md`. Two is a decision, not an empty state. */
  readonly action?: ReactNode;
  /** The space's own drawing. Without one, the stack's front card holds `icon`. */
  readonly art?: EmptyArtName;
  readonly icon?: ReactNode;
  /** `compact` inside a pane, a sheet or a form: a smaller drawing and smaller type. */
  readonly size?: "default" | "compact";
  readonly className?: string;
}

/** Where each line stands in the entrance, after the drawing's cards. */
function rise(order: number): CSSProperties {
  return { "--vs-empty-i": order } as CSSProperties;
}

/**
 * An invitation: a drawing, a headline naming the space, one line of body and
 * one verb-first action.
 *
 * It is not a card. The drawing is the only thing here with a surface — a
 * border around the whole state would put a box around something whose point
 * is that nothing is here yet. In a flex column it takes the room it is given
 * and centres in it; anywhere else it is as tall as its content.
 *
 * The pointer spreads the drawing only while it is over the invitation itself
 * (`.vs-empty`), never the empty page around it.
 */
export function EmptyState({
  title,
  description,
  action,
  art,
  icon,
  size = "default",
  className,
}: EmptyStateProps): JSX.Element {
  const compact = size === "compact";
  return (
    <div className={cn("flex min-w-0 flex-1 flex-col items-center justify-center text-center", compact ? "px-4 py-6" : "px-6 py-10", className)}>
      <div className="vs-empty flex max-w-full flex-col items-center">
        <EmptyArt {...(art === undefined ? {} : { name: art })} icon={icon} compact={compact} />
        <p className={cn("vs-empty-rise-text font-heading font-semibold tracking-tight text-balance", compact ? "mt-2 text-sm" : "mt-4 text-base")} style={rise(4)}>
          {title}
        </p>
        {description !== undefined && (
          <p className={cn("vs-empty-rise-text mt-1.5 text-pretty text-muted-foreground", compact ? "max-w-xs text-xs/5" : "max-w-sm text-sm/6")} style={rise(5)}>
            {description}
          </p>
        )}
        {action !== undefined && action !== null && action !== false && (
          <div className="vs-empty-rise-text mt-4" style={rise(6)}>
            {action}
          </div>
        )}
      </div>
    </div>
  );
}

export interface ErrorStateProps {
  /**
   * The API error body's `code`. The field a client is supposed to branch on,
   * and the one a bug report should quote — so it is rendered on the meta line
   * below rather than as the heading. A kernel identifier is not a title.
   */
  readonly code?: string;
  /** What went wrong, in a sentence. `refusalProse` is where callers get one. */
  readonly message: ReactNode;
  readonly incidentId?: string;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly className?: string;
}

export function ErrorState({
  code,
  message,
  incidentId,
  onRetry,
  retryLabel = "Try again",
  className,
}: ErrorStateProps): JSX.Element {
  // `refusalProse` writes the code into its own last-resort sentence, for the
  // sites that show no code of their own. Here that sentence is the heading and
  // the code would land twice, so the meta line yields to it.
  const codeIsInTheSentence = typeof message === "string" && code !== undefined && message.includes(code);
  const meta = [
    ...(code === undefined || codeIsInTheSentence ? [] : [code]),
    ...(incidentId === undefined ? [] : [`Incident ${incidentId}`]),
  ];

  return (
    <Alert variant="destructive" className={className}>
      <AlertTitle>
        <span className="flex items-center gap-2">
          <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
          {message}
        </span>
      </AlertTitle>
      <AlertDescription>
      {meta.length > 0 && (
        <p className="font-mono text-xs" data-testid="error-code">
          {meta.join(" · ")}
        </p>
      )}
      {onRetry !== undefined && (
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
      </AlertDescription>
    </Alert>
  );
}
