/**
 * The Images screen's reads: the project's sources, newest first, and each
 * source's images a page at a time, folded into the groups the sheet draws.
 *
 * A project with no registered source reads the whole listing as one run. Each
 * run's page count is local to the screen — `more` asks for a run's next page.
 */

import { useMemo, useState } from "react";

import { useAssetPages, useBatchAssets, useSources, type Asset, type Source } from "../queries";
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
  /** Set when the read itself failed — only a batch's read can, the project's runs are counted by the screen above. */
  readonly failure?: { readonly error: unknown; readonly retry: () => void };
}

/** The one group a batch's images form: the key every batch view's run answers to. */
export const BATCH_GROUP_KEY = "batch";

export function useImageGroups(projectId: string, pageSize: number): ImageGroups {
  const sourcesQuery = useSources(projectId);
  const sources = useMemo(() => newestFirst(sourcesQuery.data?.items ?? []), [sourcesQuery.data]);
  // With no source registered, the whole listing is the one run.
  // A point-cloud sequence orders scans its directory source holds, so no asset names it.
  const keys = useMemo(() => {
    const holding = sources.filter((s) => s.kind !== "point_cloud_sequence");
    return holding.length === 0 ? [null] : holding.map((s) => s.id);
  }, [sources]);
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

/**
 * The same shape, read from one batch: `GET /batches/{id}/assets`, a page at a
 * time, in the batch's own order.
 *
 * A batch is one run. The listing carries no per-source count, so grouping what
 * has arrived by source would put a partial tally on a heading that claims a
 * whole — the batch's images are one group, and each image still names its own
 * source in the detail (`sources` is read for that).
 */
export function useBatchGroups(projectId: string, batchId: string, enabled = true): ImageGroups {
  const sourcesQuery = useSources(projectId);
  const sources = useMemo(() => newestFirst(sourcesQuery.data?.items ?? []), [sourcesQuery.data]);
  const read = useBatchAssets(batchId, undefined, enabled);
  const { data, isSuccess, isError, error, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } = read;

  const groups = useMemo<ImageGroup[]>(() => {
    const last = data?.pages.at(-1);
    if (data === undefined || last === undefined || last.total === 0) return [];
    // A batch asset is an asset and more; the group holds the asset's own fields.
    const assets: Asset[] = data.pages.flatMap((page) => page.items);
    return [groupOf(BATCH_GROUP_KEY, undefined, assets, last.total, isFetchingNextPage)];
  }, [data, isFetchingNextPage]);

  function more(): void {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }

  return {
    sources,
    groups,
    settled: isSuccess,
    more,
    ...(isError ? { failure: { error, retry: () => void refetch() } } : {}),
  };
}
