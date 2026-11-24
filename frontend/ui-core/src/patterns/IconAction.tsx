/**
 * An icon button named by its tooltip — the batch panel's one control shape.
 *
 * The name is the button's accessible name and the tooltip's first line, so a
 * pointer, a keyboard and a screen reader meet the same words. A control that
 * is withheld keeps its tooltip, which then also says why: a `disabled` button
 * fires no pointer or focus events, so it is `aria-disabled` instead — still
 * focusable, the tooltip hung straight on it (`ui-capabilities`: disabled with
 * its reason, never hidden for a reason the person cannot read).
 *
 * Presses scale to 0.97 in 100 ms on the ease-out and nothing else moves:
 * these are pressed many times a session (`craft`: hover restraint).
 */

import type { LucideIcon } from "lucide-react";
import { forwardRef, type ComponentProps, type JSX, type ReactNode } from "react";

import { Button, Spinner, Tooltip, TooltipContent, TooltipTrigger, cn } from "@robomous/ui-core";

import { quietUnlessVisible } from "./iconFocus";

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

/** What a withheld button looks like: the Button's disabled look, but still hoverable and focusable. */
const WITHHELD = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:translate-y-0 aria-disabled:active:scale-100";

/**
 * The button alone, ref-forwarding, so it can be a Radix trigger (`asChild`).
 *
 * Withheld (a reason, a request in flight, or `disabled`) it stays focusable and
 * says `aria-disabled` instead of `disabled`: the pointer and the keyboard still
 * reach it, so its tooltip can say why, and no press does anything — not its own
 * `onClick`, and not a Radix trigger's, which arrives through the same props.
 */
export const IconButton = forwardRef<HTMLButtonElement, Omit<IconActionProps, "hint">>(function IconButton(
  { icon: Icon, label, reason, busy = false, className, variant = "ghost", disabled, onClick, onPointerDown, onKeyDown, ...props },
  ref,
) {
  const withheld = disabled === true || (reason ?? null) !== null || busy;
  return (
    <Button
      ref={ref}
      variant={variant}
      size="icon-lg"
      aria-label={label}
      aria-disabled={withheld || undefined}
      aria-busy={busy || undefined}
      className={cn(PRESS, WITHHELD, className)}
      onClick={withheld ? (event) => event.preventDefault() : onClick}
      onPointerDown={withheld ? undefined : onPointerDown}
      onKeyDown={withheld ? undefined : onKeyDown}
      {...props}
    >
      {busy ? <Spinner /> : <Icon aria-hidden="true" strokeWidth={1.75} />}
    </Button>
  );
});

/** The button with its tooltip, and its reason when it is withheld. */
export function IconAction({ hint, ...props }: IconActionProps): JSX.Element {
  const { label, reason } = props;
  return (
    <Tooltip>
      <TooltipTrigger asChild onFocus={quietUnlessVisible}>
        <IconButton {...props} />
      </TooltipTrigger>
      <TooltipContent side="top">
        <IconActionTip label={label} detail={reason ?? hint ?? null} />
      </TooltipContent>
    </Tooltip>
  );
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
