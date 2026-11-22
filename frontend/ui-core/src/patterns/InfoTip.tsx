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
import type { JSX, ReactNode } from "react";

import { Button, cn, Tooltip, TooltipContent, TooltipTrigger } from "@robomous/ui-core";

/** Press feedback: a slight scale while held, none under reduced motion. */
const PRESS = "transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:active:scale-100";

export interface InfoTipProps {
  /** The button's accessible name: `About <the field>`. */
  readonly label: string;
  /** The card's first line: the thing explained, or its one-line answer. */
  readonly title: string;
  /** A line or two that says the rest. */
  readonly children: ReactNode;
  readonly testId?: string;
  readonly contentTestId?: string;
}

export function InfoTip({ label, title, children, testId, contentTestId }: InfoTipProps): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} className={cn("shrink-0 text-muted-foreground", PRESS)} data-testid={testId}>
          <Info aria-hidden="true" className="size-3.5" />
        </Button>
      </TooltipTrigger>
      {/* Opens from the button's start edge, over the label column, so it never covers the field it explains. */}
      <TooltipContent side="top" align="start" className="max-w-64 flex-col items-start gap-1 px-3 py-2.5 text-left" data-testid={contentTestId}>
        <span className="font-medium">{title}</span>
        <span className="text-pretty text-background/70">{children}</span>
      </TooltipContent>
    </Tooltip>
  );
}
