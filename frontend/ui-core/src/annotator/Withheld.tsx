import type { JSX, ReactElement, ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@robomous/ui-core";

/**
 * Disabled-with-reason on the control itself: `aria-disabled`, never the native
 * attribute, so the control keeps its hover and its focus and the reason is read
 * on both. No wrapper element, so it adds no tab stop inside a roving-focus
 * group. The press is the caller's to refuse.
 *
 * `pressed` is for a toggle: Radix's tooltip trigger writes its own `data-state`
 * onto the control, over the toggle's `on`/`off` that its styling reads.
 */
export function Withheld({
  reason,
  tip,
  side,
  pressed,
  contentTestId,
  children,
}: {
  readonly reason: string | null;
  readonly tip?: ReactNode;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly pressed?: boolean;
  readonly contentTestId?: string;
  readonly children: ReactElement;
}): JSX.Element {
  const withheld = reason !== null;
  const content = reason ?? tip;
  return (
    <Tooltip>
      <TooltipTrigger
        asChild
        aria-disabled={withheld || undefined}
        data-reason={reason ?? undefined}
        className={withheld ? "cursor-not-allowed opacity-50" : undefined}
        {...(pressed === undefined ? {} : { "data-state": pressed ? "on" : "off" })}
      >
        {children}
      </TooltipTrigger>
      {content !== undefined && content !== null && (
        <TooltipContent side={side} data-testid={contentTestId}>
          {content}
        </TooltipContent>
      )}
    </Tooltip>
  );
}
