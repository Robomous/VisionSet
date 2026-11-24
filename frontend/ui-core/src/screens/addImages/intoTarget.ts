/** Where the images land, as data: the target a person chose and the drafts they may choose from. */

import { BATCH_ACTION, declares } from "../../data/capabilities";
import { useBatches, type Batch } from "../queries";

/** The value the select uses for "make a new one". Never a batch id. */
export const NEW_BATCH = "__new__";

export interface Target {
  /** `NEW_BATCH`, or the id of the batch to add to. */
  readonly choice: string;
  /** The new batch's name; blank falls back to the suggestion. */
  readonly name: string;
}

export const NEW_TARGET: Target = { choice: NEW_BATCH, name: "" };

/** The project's drafts, and which of them may take more — the wire's answer, not the state's. */
export function useDraftTargets(projectId: string): readonly { readonly batch: Batch; readonly open: boolean }[] {
  const batches = useBatches(projectId);
  return (batches.data?.items ?? [])
    .filter((batch) => batch.state === "draft" || declares(batch, BATCH_ACTION.editMembership))
    .map((batch) => ({ batch, open: declares(batch, BATCH_ACTION.editMembership) }));
}

/** What the target is called in a sentence: the typed name, the suggestion, or the chosen batch. */
export function targetName(target: Target, suggestion: string, drafts: ReturnType<typeof useDraftTargets>): string {
  if (target.choice === NEW_BATCH) return target.name.trim() === "" ? suggestion : target.name.trim();
  return drafts.find((one) => one.batch.id === target.choice)?.batch.name ?? "the batch";
}
