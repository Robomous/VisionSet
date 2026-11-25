/**
 * Whether a control is inside a sheet (`BatchSheet` provides `true`). There, what
 * it says becomes a toast — a sheet has no room of its own for messages; anywhere
 * else a line stays where its control is.
 */

import { createContext } from "react";

export const InSheet = createContext(false);

/**
 * What a raised toast says, by its id, so its words follow the line that raised
 * it: an outcome is raised once, then corrected in place when its control's
 * report settles — never raised again, so a toast a person closed stays closed.
 */
export interface SpokenLine {
  readonly words: unknown;
  readonly way: unknown;
}

const spoken = new Map<string, SpokenLine>();
const listeners = new Set<() => void>();

export const spokenLines = {
  set(id: string, line: SpokenLine): void {
    spoken.set(id, line);
    for (const listener of listeners) listener();
  },
  get(id: string): SpokenLine | undefined {
    return spoken.get(id);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
