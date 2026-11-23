/**
 * Which batches the project frame offers to open for annotation. A plain function
 * over the wire's batches, kept apart from the frame's components so that file
 * exports components only.
 */

import type { AnnotateTarget } from "../patterns/projectSections";
import type { Batch, Job } from "./queries";

/**
 * The batches work can actually happen in, newest first. `in_annotation` is the
 * only state an annotation may be written into, so this is not a preference —
 * anything else would send somebody to work that refuses every save.
 *
 * Newest first is the wire's own order **reversed** rather than a timestamp
 * read: `BatchOut` carries no timestamp of any kind, and the metadata store
 * lists by `rowid`, so what arrives is creation order, oldest first. Inventing a
 * field to sort on would be the "No description." mistake in the other
 * direction. The copy is not decoration — the array belongs to the query cache,
 * and `reverse` mutates in place.
 */
export function openForAnnotation(
  batches: readonly Batch[] | undefined,
  jobs?: ReadonlyMap<string, readonly Job[]>,
): readonly AnnotateTarget[] {
  return [...(batches ?? [])]
    .filter((batch) => batch.state === "in_annotation")
    .reverse()
    .map((batch) => ({
      id: batch.id,
      name: batch.name,
      remaining: batch.progress.unannotated,
      schemaVersion: batch.schema_version ?? null,
      jobIds: jobs?.get(batch.id)?.map((job) => job.id),
    }));
}
