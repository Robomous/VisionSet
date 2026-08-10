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

import { AlertTriangle, Inbox } from "lucide-react";
import type { JSX, ReactNode } from "react";

import { cn } from "../lib/cn";
import { Alert } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { Skeleton } from "../primitives/Feedback";

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
  readonly icon?: ReactNode;
  readonly className?: string;
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-8 text-center",
        className,
      )}
    >
      <span className="text-muted-foreground" aria-hidden="true">
        {icon ?? <Inbox className="size-8" />}
      </span>
      <p className="text-section font-semibold">{title}</p>
      {description !== undefined && (
        <p className="max-w-md text-body text-muted-foreground">{description}</p>
      )}
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  /** The API error body's `code`. The field a client is supposed to branch on. */
  readonly code?: string;
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
  return (
    <Alert
      variant="destructive"
      title={
        <span className="flex items-center gap-2">
          <AlertTriangle className="size-4" aria-hidden="true" />
          {code ?? "Something went wrong"}
        </span>
      }
      className={className}
    >
      <p className="text-body">{message}</p>
      {incidentId !== undefined && (
        <p className="mt-1 font-mono text-meta">Incident {incidentId}</p>
      )}
      {onRetry !== undefined && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </Alert>
  );
}
