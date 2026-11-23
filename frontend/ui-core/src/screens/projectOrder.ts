/**
 * How the project list is ordered, and the two numbers its rows read off a
 * project's digest: when it last moved, and how much is left to annotate. Kept
 * apart from the screen's components so that file exports components only.
 */

import type { ProjectListItem } from "./queries";

export type ProjectSortKey = "name" | "images" | "annotated" | "classes" | "activity";
export type Direction = "ascending" | "descending";

/**
 * When the project last moved: the newest dated thing that happened in it, else
 * when it was made. NULL only for a project the workspace never dated at all.
 */
export function lastMoved(project: ProjectListItem): string | null {
  return project.digest.last_activity_at ?? project.created_at;
}

const VALUE: Record<ProjectSortKey, (p: ProjectListItem) => number | string | null> = {
  name: (p) => p.name.toLocaleLowerCase(),
  images: (p) => p.digest.asset_count,
  annotated: (p) => p.digest.annotated_fraction,
  classes: (p) => p.digest.class_count,
  activity: (p) => {
    const at = lastMoved(p);
    return at === null ? null : Date.parse(at);
  },
};

/**
 * The list in the chosen order. A row with no value for the key — a project
 * the workspace never dated, sorted by activity — goes last in **both**
 * directions, in the order the wire gave it: a missing date is a missing date,
 * never a guessed position among the dated rows.
 */
export function orderedProjects(
  items: readonly ProjectListItem[],
  key: ProjectSortKey,
  direction: Direction,
): readonly ProjectListItem[] {
  const read = VALUE[key];
  const known = items.filter((p) => read(p) !== null);
  const unknown = items.filter((p) => read(p) === null);
  const sign = direction === "descending" ? -1 : 1;
  known.sort((a, b) => {
    const x = read(a) as number | string;
    const y = read(b) as number | string;
    const order = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
    // Ties keep the wire's order, so equal rows never swap places between sorts.
    return sign * order;
  });
  return [...known, ...unknown];
}

/** What is left for a person to annotate; see `RemainingCell`. */
export function leftToAnnotate(digest: ProjectListItem["digest"]): number {
  const done = Math.min(digest.annotated_asset_count, digest.asset_count);
  return Math.max(digest.asset_count - done, digest.frames_left);
}
