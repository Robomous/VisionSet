/**
 * The curation-and-publication tail, as a line of versions: the trunk as it
 * stands, and every release frozen out of it.
 *
 * ## Two columns
 *
 * The left column holds the open version's facts on top (`VersionFacts`), each
 * a section that folds and says its answer while folded, and the releases docked
 * at its foot (`VersionNav`), so opening one never moves the list. The wall takes
 * the rest; the selected image opens beside it in the Images section's own
 * detail (`dataset/Member.tsx`), so a picture reads the same wherever it is
 * opened.
 *
 * ## Publish in the project bar, Export in the column
 *
 * The working copy's forward action is *Publish release*, in the project bar.
 * A release's is its export, a section of its facts with the rest — the model,
 * the recipe, the button and the job's state — so the bar draws nothing for a
 * release. The export's form wraps the release's facts alone, so opening
 * another version never re-mounts the column, and folding Export keeps the form
 * — and its job — mounted.
 *
 * ## Recipes are chosen where they are used
 *
 * A recipe exists for an export, so it is chosen, written, edited and deleted
 * in a release's Export section (`dataset/RecipeChoice.tsx`), each write in its
 * own dialog — never shelved beside the versions.
 *
 * ## What `tab` still means
 *
 * The host holds the four names so no host has to change; every one opens the
 * working copy.
 */

import { PackagePlus } from "lucide-react";
import { useState, type JSX } from "react";

import { Async } from "../data/Async";
import { refusalProse } from "../data/refusals";
import { Button, cn } from "@robomous/ui-core";
import { formatCount } from "../lib/format";
import { ErrorState } from "../patterns/AsyncStates";
import { PageStatus } from "../patterns/PageStatus";
import { SectionActions } from "../patterns/SectionActions";
import { PublishDialog } from "./dataset/dialogs";
import { ExportForm } from "./dataset/ExportForm";
import { FoldsProvider } from "./dataset/Fold";
import { VersionFacts } from "./dataset/VersionFacts";
import { VersionKpis } from "./dataset/VersionKpis";
import { VersionNav } from "./dataset/VersionNav";
import { VersionView } from "./dataset/VersionView";
import type { DatasetTab } from "./dataset/tabs";
import { WORKING, datasetVersions } from "./dataset/versions";
import { useDatasetStats, useProjectDataset, useReleases } from "./queries";

export type { DatasetTab };

export interface DatasetScreenProps {
  readonly projectId: string;
  /** Kept for hosts that hold it; every view opens on the working copy. */
  readonly tab?: string;
  readonly onTabChange?: (tab: DatasetTab) => void;
}

/**
 * Fitted to the window at `lg` and up, less the host's chrome and the 48px
 * project bar, as the Overview is: the rail and the wall scroll inside their
 * own cells and the page never does.
 */
const FIT = "lg:h-[calc(100dvh-var(--page-inset-top,0px)-var(--page-inset-bottom,0px)-3rem)] lg:min-h-[30rem]";

/** Below `lg` the project bar becomes a strip over a padded column, so the sheet is framed instead of running edge to edge. */
const FRAMED_BELOW_LG = "max-lg:overflow-hidden max-lg:rounded-lg max-lg:border max-lg:border-border/70";

/**
 * The work row on the KPI row's four columns from `xl`, a 1px gap over the
 * border colour between its cells, so every vertical hairline on the page
 * continues one from the KPIs: the rail takes one, the wall three.
 */
const WORK_ROW = "grid min-h-0 flex-1 gap-px bg-border/70 lg:grid-cols-[20rem_minmax(0,1fr)] xl:grid-cols-4";

export function DatasetScreen({ projectId }: DatasetScreenProps): JSX.Element {
  const dataset = useProjectDataset(projectId);
  const stats = useDatasetStats(dataset.data?.id);
  const releases = useReleases(dataset.data?.id);
  const [publishing, setPublishing] = useState(false);
  const [opened, setOpened] = useState(WORKING);

  const versions = datasetVersions(stats.data, releases.data?.items ?? []);
  const version = versions.find((one) => one.id === opened) ?? versions[0];
  const latestTag = versions[1]?.release?.tag ?? null;
  const release = version.release;

  // One tree for every version: the release's export form wraps its facts
  // alone, so opening another version never re-mounts the rail or the wall and
  // the rail keeps its scroll. Folding Export keeps the form mounted (`Fold`
  // folds an inert body), so a job keeps running while it is folded.
  const facts = (
    <section aria-label={`About ${version.title}`} data-testid="version-facts" className="shrink-0">
      {release === null ? (
        stats.data !== undefined ? (
          <VersionFacts projectId={projectId} version={version} stats={stats.data} parts={null} />
        ) : (
          // Loading and a failed read stand on the rail's inset; the panels draw their own.
          <div className="px-4 py-3 md:px-6">
            <Async query={stats} loadingRows={3}>
              {(counts) => <VersionFacts projectId={projectId} version={version} stats={counts} parts={null} />}
            </Async>
          </div>
        )
      ) : (
        <ExportForm key={release.id} projectId={projectId} releaseId={release.id} tag={release.tag} render={(parts) => <VersionFacts projectId={projectId} version={version} stats={stats.data} parts={parts} />} />
      )}
    </section>
  );
  // A list that could not be read is said, never shown as a dataset with no releases.
  const footer = releases.isError ? (
    <div className="border-t border-border/70 px-4 py-3 md:px-6" data-testid="releases-error">
      <ErrorState message={refusalProse(releases.error)} onRetry={() => void releases.refetch()} />
    </div>
  ) : null;

  return (
    <FoldsProvider>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="dataset-screen">
        {/* The project bar is the section's header; this names it to the outline. */}
        <h1 className="sr-only">Dataset</h1>
        {release === null && (
          <SectionActions>
            <Button size="lg" data-testid="publish-release" aria-label="Publish release" disabled={dataset.data === undefined} onClick={() => setPublishing(true)}>
              <PackagePlus data-icon="inline-start" className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              Publish
            </Button>
          </SectionActions>
        )}

        {/* One sheet of cells, as every project screen is: hairlines between them, no cards. */}
        <div className={cn("flex min-w-0 flex-col gap-px bg-border/70", FIT, FRAMED_BELOW_LG)}>
          <VersionKpis projectId={projectId} version={version} versions={versions} stats={stats.data} />
          <div className={WORK_ROW}>
            <VersionNav versions={versions} open={version.id} onOpen={setOpened} head={facts}>
              {footer}
            </VersionNav>
            <div className="flex min-h-0 min-w-0 flex-col bg-background lg:flex-row xl:col-span-3">
              <VersionView key={version.id} projectId={projectId} datasetId={dataset.data?.id} version={version} latestTag={latestTag} />
            </div>
          </div>
        </div>

        <PublishDialog datasetId={dataset.data?.id ?? ""} open={publishing} onClose={() => setPublishing(false)} />
        <PageStatus>
          <span className="tabular-nums" data-testid="dataset-status">
            {version.title} · {formatCount(version.images)} {version.images === 1 ? "image" : "images"} · {formatCount(versions.length - 1)} {versions.length === 2 ? "release" : "releases"}
          </span>
        </PageStatus>
      </div>
    </FoldsProvider>
  );
}
