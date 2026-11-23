/**
 * The Images screen's reads: the project's sources, newest first, and each
 * source's images a page at a time, folded into the groups the sheet draws.
 *
 * A project with no registered source reads the whole listing as one run. Each
 * run's page count is local to the screen — `more` asks for a run's next page.
 */

import { useMemo, useState } from "react";

import { useAssetPages, useSources, type Source } from "../queries";
import { groupOf, type ImageGroup } from "./imageFacts";

function newestFirst(sources: readonly Source[]): Source[] {
  return [...sources].sort((a, b) => (b.registered_at ?? "").localeCompare(a.registered_at ?? ""));
}

export interface ImageGroups {
  readonly sources: readonly Source[];
  readonly groups: readonly ImageGroup[];
  /** True once every run has answered with its total. */
  readonly settled: boolean;
  /** Ask for the next page of one group, unless it has none or one is on its way. */
  readonly more: (key: string) => void;
}

export function useImageGroups(projectId: string, pageSize: number): ImageGroups {
  const sourcesQuery = useSources(projectId);
  const sources = useMemo(() => newestFirst(sourcesQuery.data?.items ?? []), [sourcesQuery.data]);
  // With no source registered, the whole listing is the one run.
  const keys = useMemo(() => (sources.length === 0 ? [null] : sources.map((s) => s.id)), [sources]);
  const [pages, setPages] = useState<Readonly<Record<string, number>>>({});
  const runs = useAssetPages(
    projectId,
    pageSize,
    keys.map((key) => ({ sourceId: key, pages: pages[key ?? "all"] ?? 1 })),
  );

  const groups = useMemo<ImageGroup[]>(
    () =>
      keys.flatMap((key, i) => {
        const run = runs[i];
        if (run === undefined || run.total === undefined || run.total === 0) return [];
        return [groupOf(key ?? "all", sources.find((s) => s.id === key), run.items, run.total, run.isFetchingMore)];
      }),
    [keys, runs, sources],
  );

  function more(key: string): void {
    const group = groups.find((g) => g.key === key);
    if (group === undefined || !group.hasMore || group.isFetchingMore) return;
    setPages((was) => ({ ...was, [key]: (was[key] ?? 1) + 1 }));
  }

  return { sources, groups, settled: runs.every((run) => run.total !== undefined), more };
}
