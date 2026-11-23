/**
 * What the page on screen says in the workbench's status bar.
 *
 * The status bar belongs to the app's shell and the screens belong to this
 * package, which must not know how the app frames them. So the shell puts a
 * `PageStatusOutlet` where the page's facts go, and a screen hands its facts to
 * `PageStatus`, which portals them there. A host that mounts the screens
 * without an outlet simply shows none of them — the facts are a summary of the
 * page, never the only place something is said.
 *
 * The outlet is a polite status region that exists before anything is put in
 * it, so a search or filter that changes a count is heard as well as seen.
 */

import { createContext, useContext, useMemo, useState, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@robomous/ui-core";

interface Slot {
  readonly target: HTMLElement | null;
  readonly setTarget: (node: HTMLElement | null) => void;
}

const PageStatusContext = createContext<Slot | null>(null);

export function PageStatusProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const slot = useMemo(() => ({ target, setTarget }), [target]);
  return <PageStatusContext.Provider value={slot}>{children}</PageStatusContext.Provider>;
}

/** Where the page's facts land: the shell's status bar, at its left edge. */
export function PageStatusOutlet({ className }: { readonly className?: string }): JSX.Element {
  const slot = useContext(PageStatusContext);
  return <div ref={slot?.setTarget} role="status" data-testid="page-status" className={cn("flex min-w-0 items-center gap-4", className)} />;
}

/** The page's facts, said once, in the status bar rather than on the page. */
export function PageStatus({ children }: { readonly children: ReactNode }): JSX.Element | null {
  const slot = useContext(PageStatusContext);
  if (slot === null || slot.target === null) return null;
  return createPortal(children, slot.target);
}
