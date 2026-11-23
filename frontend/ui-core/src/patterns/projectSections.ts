/**
 * The project's sections and where an `Annotate ▾` entry goes: the ids that are
 * URL segments, the guard over them, and the batch-or-job destination. Plain
 * values and functions, kept apart from the nav's component so that file exports
 * components only.
 */

/**
 * The four sections of a project, in the order work happens in: what a project
 * *is* and what needs doing (the Overview, where batches are listed and opened),
 * what came *in* (every image), what it *means* (the classes), what came *out*
 * (the dataset).
 *
 * The ids are URL segments and stay the product's nouns — `schema` is what
 * links, the CLI and the API call it — while the labels below are the words a
 * person reads. A bookmarked URL is a promise, so a relabel never renames a
 * segment. Batches have no section: a batch is opened from the Overview, at
 * `/projects/:id/batches/:batchId`, and the old `batches` segment redirects.
 */
export type ProjectSection = "overview" | "images" | "schema" | "dataset";

export const PROJECT_SECTIONS: readonly ProjectSection[] = ["overview", "images", "schema", "dataset"];

export function isProjectSection(value: string | undefined): value is ProjectSection {
  return PROJECT_SECTIONS.includes(value as ProjectSection);
}

/** The section a project opens on, and where anything unrecognised lands. */
export const DEFAULT_PROJECT_SECTION: ProjectSection = "overview";

/** One batch the annotator can be opened on: what the `Annotate ▾` menu lists. */
export interface AnnotateTarget {
  readonly id: string;
  /** Already carries the `— correction` suffix where one applies. */
  readonly name: string;
  /** Frames still `unannotated` — the batch table's `N to do`. */
  readonly remaining: number;
  /** The schema version the batch is pinned to; null only for a row the wire left unpinned. */
  readonly schemaVersion: number | null;
  /** The batch's job ids, or undefined while unknown — unknown lands on the batch's panel. */
  readonly jobIds?: readonly string[] | undefined;
}

/** Exactly one job → straight into it; otherwise the batch's panel, where a job is chosen. */
export function destinationOf(target: AnnotateTarget): { kind: "job"; id: string } | { kind: "batch"; id: string } {
  const [only] = target.jobIds ?? [];
  return target.jobIds?.length === 1 && only !== undefined ? { kind: "job", id: only } : { kind: "batch", id: target.id };
}
