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
 * An entry lives from the raise to the toast's end: `follow` never brings back
 * one that has ended, and the end a raise returns ends only that raise's entry,
 * never a newer one raised under the same id.
 */
export interface SpokenLine {
  readonly words: unknown;
  readonly way: unknown;
}

const spoken = new Map<string, SpokenLine>();
const owners = new Map<string, symbol>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

export const spokenLines = {
  raise(id: string, line: SpokenLine): () => void {
    const owner = Symbol(id);
    owners.set(id, owner);
    spoken.set(id, line);
    changed();
    return () => {
      if (owners.get(id) !== owner) return;
      owners.delete(id);
      spoken.delete(id);
      changed();
    };
  },
  follow(id: string, line: SpokenLine): void {
    if (!spoken.has(id)) return;
    spoken.set(id, line);
    changed();
  },
  get(id: string): SpokenLine | undefined {
    return spoken.get(id);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
