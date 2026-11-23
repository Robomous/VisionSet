/**
 * An info button beside a field's label, and the card it opens.
 *
 * What a choice means beyond its label — what a model takes, what a setting
 * is for — goes here instead of a line of helper text under the field, so a
 * form keeps one line per row. The card is a title and a line or two; it
 * opens on hover and on focus, so the keyboard reaches it too, and a screen
 * reader hears the button's name and then the card as its description.
 *
 * Put it beside the label with `PropertyRow`'s `labelAction`, never inside the
 * `<label>`: a label holds no interactive content of its own. The rules —
 * what belongs in a card and what never does — are in `DESIGN.md`.
 */

import { Info } from "lucide-react";
import { useId, type JSX, type ReactNode } from "react";

import { Button, cn, Tooltip, TooltipContent, TooltipTrigger } from "@robomous/ui-core";

/** Press feedback: a slight scale while held, none under reduced motion. */
const PRESS = "transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:active:scale-100";

export interface InfoTipProps {
  /** The button's accessible name: `About <the field>`. */
  readonly label: string;
  /**
   * The card's first line: the thing explained, or its one-line answer. Left out
   * where the words beside the button already are that line — the card then
   * carries the rest alone, rather than repeating what the row shows.
   */
  readonly title?: string;
  /** A line or two that says the rest. */
  readonly children: ReactNode;
  /**
   * Make the card's words the button's description for good, not only while
   * the card is open — `WarnTip`'s arrangement, for a card whose words a screen
   * reader should reach without opening anything. The copy is `hidden`, so
   * browsing past it never reads it twice.
   */
  readonly describe?: boolean;
  readonly testId?: string;
  readonly contentTestId?: string;
  /** The hidden description's id for tests, when `describe` is on. */
  readonly descriptionTestId?: string;
}

export function InfoTip({
  label,
  title,
  children,
  describe = false,
  testId,
  contentTestId,
  descriptionTestId,
}: InfoTipProps): JSX.Element {
  const said = useId();
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-describedby={describe ? said : undefined}
            className={cn("shrink-0 text-muted-foreground", PRESS)}
            data-testid={testId}
          >
            <Info aria-hidden="true" className="size-3.5" />
          </Button>
        </TooltipTrigger>
        {/* Opens from the button's start edge, over the label column, so it never covers the field it explains. */}
        <TooltipContent side="top" align="start" className="max-w-64 flex-col items-start gap-1 px-3 py-2.5 text-left" data-testid={contentTestId}>
          {title !== undefined && <span className="font-medium">{title}</span>}
          <span className={cn("text-pretty", title !== undefined && "text-background/70")}>{children}</span>
        </TooltipContent>
      </Tooltip>
      {describe && (
        <span id={said} hidden data-testid={descriptionTestId}>
          {children}
        </span>
      )}
    </>
  );
}
