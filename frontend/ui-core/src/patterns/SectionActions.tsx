/**
 * A section's own actions, drawn in the project bar.
 *
 * The bar belongs to the frame, but what a section offers — Add class on
 * Classes, Publish release on Dataset — belongs to state the section holds:
 * the class dialog, the publish dialog, whether a past version is open. So the
 * section renders its actions where that state lives and they portal into the
 * bar's slot, the `PageStatus` arrangement turned the other way up. The bar
 * shows only what the open section offers, and nothing a section did not ask
 * for.
 *
 * With no bar around it — a section rendered on its own, in a test or the
 * styleguide — the actions stay where they were rendered, so a section never
 * loses its controls for want of a frame.
 */

import { createContext, useContext, useMemo, useState, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@robomous/ui-core";

interface Slot {
  readonly target: HTMLElement | null;
  readonly setTarget: (node: HTMLElement | null) => void;
}

const SectionActionsContext = createContext<Slot | null>(null);

export function SectionActionsProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const slot = useMemo(() => ({ target, setTarget }), [target]);
  return <SectionActionsContext.Provider value={slot}>{children}</SectionActionsContext.Provider>;
}

/** Where the bar draws them; collapses to nothing while the section offers none. */
export function SectionActionsOutlet({ className }: { readonly className?: string }): JSX.Element {
  const slot = useContext(SectionActionsContext);
  return <div ref={slot?.setTarget} data-testid="section-actions" className={cn("flex items-center gap-2 empty:hidden", className)} />;
}

export function SectionActions({ children }: { readonly children: ReactNode }): JSX.Element | null {
  const slot = useContext(SectionActionsContext);
  if (slot === null) return <div className="flex items-center justify-end gap-2">{children}</div>;
  // The outlet mounts in the same commit; the portal follows before paint.
  if (slot.target === null) return null;
  return createPortal(children, slot.target);
}
