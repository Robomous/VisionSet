/**
 * The Dataset section's views, by the names a host already holds — kept apart
 * from the screen so the component module exports components only.
 * Recipes now live in a release's export, so every name opens the working copy;
 * the four are kept so no host has to change.
 */

export type DatasetTab = "overview" | "assets" | "preprocessing" | "releases";

export const DATASET_TABS: readonly DatasetTab[] = ["overview", "assets", "preprocessing", "releases"];
const DEFAULT_DATASET_TAB: DatasetTab = "overview";

/** The `DatasetTab` a raw value names, or the default: the host's normaliser. */
export function resolveDatasetTab(tab: string | undefined): DatasetTab {
  return DATASET_TABS.find((one) => one === tab) ?? DEFAULT_DATASET_TAB;
}
