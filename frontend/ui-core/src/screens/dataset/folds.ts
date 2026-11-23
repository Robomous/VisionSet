/**
 * Which of the Dataset column's sections are folded. The column holds it
 * (`VersionNav`), not each section, so opening another version keeps the
 * sections as the person left them.
 */

import { createContext, useContext, useState } from "react";

export interface FoldState {
  readonly isOpen: (id: string, byDefault: boolean) => boolean;
  readonly toggle: (id: string, byDefault: boolean) => void;
}

export const Folds = createContext<FoldState | null>(null);

/** A section's fold; without a column around it, a section holds its own. */
export function useFold(id: string, byDefault: boolean): { readonly open: boolean; readonly toggle: () => void } {
  const folds = useContext(Folds);
  const [own, setOwn] = useState(byDefault);
  if (folds === null) return { open: own, toggle: () => setOwn((was) => !was) };
  return { open: folds.isOpen(id, byDefault), toggle: () => folds.toggle(id, byDefault) };
}

/** The label column every field shares, so the values start on one edge. */
export const FIELD_GRID = "grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3";
