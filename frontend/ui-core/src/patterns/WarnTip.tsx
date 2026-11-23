/**
 * A warning about a field, as an icon beside its label and the card it opens.
 *
 * What is true of a field and worth knowing before acting — a format that
 * cannot carry every shape, images exported without labels, a class nobody
 * labelled — but that does not stop anything. The row stays one line tall: the
 * warning's glyph says *look here*, its card says what and why.
 *
 * The same shape as `InfoTip` (`DESIGN.md` → *Info buttons*), in the warning
 * colour and the warning glyph, so a reader tells "here is something to know"
 * from "here is what this means" at a glance. The button's name is the
 * warning's title and its description is the rest, so a screen reader hears
 * both without opening anything — and a warning is never only a colour.
 *
 * A problem that holds an action back is not a warning: it is said as a
 * sentence where the form says problems.
 */

import { TriangleAlert } from "lucide-react";
import { useId, type JSX, type ReactNode } from "react";

import { Button, cn, Tooltip, TooltipContent, TooltipTrigger } from "@robomous/ui-core";

/** Press feedback: a slight scale while held, none under reduced motion. */
const PRESS = "transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:active:scale-100";

export interface WarnTipProps {
  /** The card's first line: the warning in a few words — "No labels for person". */
  readonly title: string;
  /** A line or two that says why it matters, or what to do. */
  readonly children?: ReactNode;
  /** `sm` beside a 12px label (a KPI's), `md` beside a field's. */
  readonly size?: "sm" | "md";
  readonly className?: string;
  readonly testId?: string;
}

export function WarnTip({ title, children, size = "md", className, testId }: WarnTipProps): JSX.Element {
  const said = useId();
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Warning: ${title}`}
            aria-describedby={children === undefined ? undefined : said}
            data-testid={testId}
            className={cn(
              // 24 or 28px drawn; the hit area reaches 40px either way.
              "relative shrink-0 text-warning after:absolute hover:bg-warning/10 hover:text-warning",
              size === "sm" ? "size-6 after:-inset-2" : "after:-inset-1.5",
              PRESS,
              className,
            )}
          >
            <TriangleAlert aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="max-w-64 flex-col items-start gap-1 px-3 py-2.5 text-left">
          <span className="font-medium">{title}</span>
          {children !== undefined && <span className="text-pretty text-background/70">{children}</span>}
        </TooltipContent>
      </Tooltip>
      {/* The description, for the button alone: hidden, so browsing past it never reads it twice. */}
      {children !== undefined && (
        <span id={said} hidden>
          {children}
        </span>
      )}
    </>
  );
}
