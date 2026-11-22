/**
 * The version history as a graph: which lane each version sits on, and which
 * versions carry exactly the classes of an older one.
 *
 * ## Lanes are the annotating runs
 *
 * The main lane is the contract as it was curated. A run of versions published
 * while annotating — `groupByProvenance`'s rule, unchanged: consecutive
 * `annotation` versions, never fewer than `RUN_MINIMUM` — branches off it and
 * back, so a sitting in the annotator reads as one detour rather than nine
 * rows burying the milestones. A single annotation version stays on the main
 * lane, as it stays a single row in the grouping.
 *
 * ## The branch palette
 *
 * Lanes are data, so they draw from the design system's data hues, never its
 * status roles: green, amber, blue and red already mean success, warning, info
 * and destructive on this page. Main is indigo; runs take orange, fuchsia and
 * teal in that fixed order, counted from the oldest run, so a run keeps its
 * colour as newer ones arrive. Validated in both themes (lightness, chroma,
 * colour-vision separation — worst ΔE 12.8 — and 3:1 against the surface).
 *
 * ## A restore, told from the classes
 *
 * Nothing on the wire points from a restore to the version it restored, so a
 * version whose classes equal an older one's (not the one just before it —
 * that is "nothing changed") says so: `sameAs`.
 */

import { groupByProvenance } from "./schemaHistory";
import type { SchemaVersion } from "./queries";

/** One row of the history: the graph is drawn on this grid. */
export const LANE_ROW = 40;
export const laneRowY = (row: number): number => row * LANE_ROW + LANE_ROW / 2;

/** The main lane's centre, and the step between lanes, px. */
export const LANE_MAIN = 14;
export const LANE_STEP = 18;

/** Tailwind utilities spelled out whole, so the scanner sees every one. */
export const LANE_HUES = [
  { stroke: "stroke-indigo-500", fill: "fill-indigo-500", bg: "bg-indigo-500", tint: "hover:bg-indigo-500/[0.06]" },
  { stroke: "stroke-orange-600", fill: "fill-orange-600", bg: "bg-orange-600", tint: "hover:bg-orange-600/[0.06]" },
  {
    stroke: "stroke-fuchsia-600 dark:stroke-fuchsia-500",
    fill: "fill-fuchsia-600 dark:fill-fuchsia-500",
    bg: "bg-fuchsia-600 dark:bg-fuchsia-500",
    tint: "hover:bg-fuchsia-600/[0.06]",
  },
  { stroke: "stroke-teal-600", fill: "fill-teal-600", bg: "bg-teal-600", tint: "hover:bg-teal-600/[0.06]" },
] as const;

export type LaneHue = (typeof LANE_HUES)[number];

export interface Run {
  /** 1-based from the oldest run. */
  readonly index: number;
  readonly hue: LaneHue;
  /** Its first and last rows in the newest-first list. */
  readonly top: number;
  readonly bottom: number;
  /** "Annotating session 2". */
  readonly name: string;
}

export interface LaneNode {
  readonly version: SchemaVersion;
  readonly row: number;
  readonly run: Run | null;
  /** An older version this one carries exactly the classes of. */
  readonly sameAs: number | null;
}

export interface Lanes {
  /** Newest first. */
  readonly nodes: readonly LaneNode[];
  readonly runs: readonly Run[];
}

export const laneX = (run: Run | null): number => (run === null ? LANE_MAIN : LANE_MAIN + LANE_STEP * run.index);
/** The room the graph takes at a row's start. */
export const laneInset = (runs: readonly Run[]): number => LANE_MAIN + LANE_STEP * runs.length + 18;
export const hueOf = (node: LaneNode): LaneHue => node.run?.hue ?? LANE_HUES[0];

const shapeOf = (version: SchemaVersion): string =>
  JSON.stringify(version.classes.map((declared) => [declared.name, declared.geometries, declared.attributes]));

/** Lay out a history. Sorted here, newest first, whatever order it is handed in. */
export function laneLayout(versions: readonly SchemaVersion[]): Lanes {
  const ordered = [...versions].sort((a, b) => b.version - a.version);
  const rowOf = new Map(ordered.map((version, row) => [version.version, row]));
  const spans = groupByProvenance(ordered).flatMap((entry) =>
    entry.kind === "run" ? [{ top: rowOf.get(entry.versions[0]!.version)!, bottom: rowOf.get(entry.versions.at(-1)!.version)! }] : [],
  );
  const runs: Run[] = spans.map((span, at) => {
    const index = spans.length - at;
    return { index, hue: LANE_HUES[((index - 1) % 3) + 1]!, top: span.top, bottom: span.bottom, name: `Annotating session ${index}` };
  });
  const shapes = ordered.map(shapeOf);
  const firstRowOf = new Map<string, number>();
  shapes.forEach((shape, row) => firstRowOf.set(shape, row));
  const nodes = ordered.map((version, row) => {
    // The oldest version with these classes, unless it is this one or the one just before.
    const older = firstRowOf.get(shapes[row]!)!;
    return {
      version,
      row,
      run: runs.find((run) => row >= run.top && row <= run.bottom) ?? null,
      sameAs: older > row + 1 ? ordered[older]!.version : null,
    };
  });
  return { nodes, runs };
}
