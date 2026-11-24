/**
 * An icon button named by its tooltip — the batch panel's one control shape.
 *
 * The name is the button's accessible name and the tooltip's first line, so a
 * pointer, a keyboard and a screen reader meet the same words. A control that
 * is withheld keeps its tooltip, which then also says why: a disabled button
 * fires no pointer or focus events, so the tooltip hangs off a focusable
 * wrapper instead (`ui-capabilities`: disabled with its reason, never hidden
 * for a reason the person cannot read).
 *
 * Presses scale to 0.97 in 100 ms on the ease-out and nothing else moves:
 * these are pressed many times a session (`craft`: hover restraint).
 */

import type { LucideIcon } from "lucide-react";
import { forwardRef, type ComponentProps, type FocusEvent, type JSX, type ReactNode } from "react";

import { Button, Spinner, Tooltip, TooltipContent, TooltipTrigger, cn } from "@robomous/ui-core";

const PRESS = "transition-[background-color,scale] duration-100 ease-out active:scale-[0.97] motion-reduce:transition-none";

export interface IconActionProps extends Omit<ComponentProps<typeof Button>, "children" | "size" | "aria-label"> {
  readonly icon: LucideIcon;
  /** The action's name: the accessible name and the tooltip's first line. */
  readonly label: string;
  /** Why it is withheld. Present means disabled. */
  readonly reason?: string | null;
  /** A request in flight: a spinner in place of the icon, and no second press. */
  readonly busy?: boolean;
  /** A second line under the name, when the name needs one. */
  readonly hint?: ReactNode;
}

/** The button alone, ref-forwarding, so it can be a Radix trigger (`asChild`). */
export const IconButton = forwardRef<HTMLButtonElement, Omit<IconActionProps, "hint">>(function IconButton(
  { icon: Icon, label, reason, busy = false, className, variant = "ghost", disabled, ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant={variant}
      size="icon-lg"
      aria-label={label}
      disabled={disabled === true || (reason ?? null) !== null || busy}
      aria-busy={busy || undefined}
      className={cn(PRESS, className)}
      {...props}
    >
      {busy ? <Spinner /> : <Icon aria-hidden="true" strokeWidth={1.75} />}
    </Button>
  );
});

/** The button with its tooltip, and its reason when it is withheld. */
export function IconAction({ hint, ...props }: IconActionProps): JSX.Element {
  const { label, reason } = props;
  const withheld = (reason ?? null) !== null || props.busy === true || props.disabled === true;
  const button = <IconButton {...props} />;
  return (
    <Tooltip>
      <TooltipTrigger asChild onFocus={quietUnlessVisible}>
        {withheld ? (
          // Focusable, so the keyboard reaches the reason too.
          <span tabIndex={0} className="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            {button}
          </span>
        ) : (
          button
        )}
      </TooltipTrigger>
      <TooltipContent side="top">
        <IconActionTip label={label} detail={reason ?? hint ?? null} />
      </TooltipContent>
    </Tooltip>
  );
}

/** Set only while `focusQuietly` moves the focus. */
let quiet = false;

/**
 * Move the focus without opening the tooltip of what it lands on. For focus a
 * screen moves on its own — a panel opening on its forward step — which would
 * otherwise open a tooltip nobody asked for, so that the first Escape closed the
 * tooltip instead of the panel. Focus the person moves still opens it.
 */
export function focusQuietly(target: HTMLElement): void {
  quiet = true;
  try {
    target.focus({ preventScroll: true });
  } finally {
    quiet = false;
  }
}

/**
 * A `TooltipTrigger`'s `onFocus` for a trigger composed by hand (a popover's or a
 * menu's): Radix skips its own focus handler when this one prevents the default.
 */
export function quietUnlessVisible(event: FocusEvent<HTMLElement>): void {
  if (quiet) event.preventDefault();
}

/** The tooltip's words: the name, then the reason or a hint. */
export function IconActionTip({ label, detail }: { readonly label: string; readonly detail: ReactNode }): JSX.Element {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium">{label}</span>
      {detail !== null && <span className="opacity-70">{detail}</span>}
    </span>
  );
}
