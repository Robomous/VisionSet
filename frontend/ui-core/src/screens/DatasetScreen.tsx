/**
 * The curation-and-publication tail, as a line of versions: the trunk as it
 * stands, and every release frozen out of it.
 *
 * ## Two columns
 *
 * The left column holds the open version's facts on top (`VersionFacts`), each
 * a section whose heading already answers, then the versions. The wall takes
 * the rest; the selected image opens beside it in the Images section's own
 * detail (`dataset/Member.tsx`), so a picture reads the same wherever it is
 * opened.
 *
 * ## Publish in the project bar, Export in the column
 *
 * The working copy's forward action is *Publish release*, in the project bar.
 * A release's is its export, a section of its facts with the rest — the model,
 * the recipe, the button and the job's state — so the bar draws nothing for a
 * release. The export's form lives here, above the column, so a job keeps
 * running whatever the column does.
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

import { useState, type JSX } from "react";

import { Async } from "../data/Async";
import { refusalProse } from "../data/refusals";
import { Button } from "@robomous/ui-core";
import { formatCount } from "../lib/format";
import { ErrorState } from "../patterns/AsyncStates";
import { PageStatus } from "../patterns/PageStatus";
import { SectionActions } from "../patterns/SectionActions";
import { PublishDialog } from "./dataset/dialogs";
import { ExportForm, type ExportParts } from "./dataset/ExportForm";
import { VersionFacts } from "./dataset/VersionFacts";
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

/** The window, less the host's chrome and the 48px project bar: the columns scroll inside it. */
const FIT = "lg:h-[calc(100dvh-var(--page-inset-top,0px)-var(--page-inset-bottom,0px)-3rem)] lg:min-h-[30rem]";

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

  function layout(parts: ExportParts | null): JSX.Element {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="dataset-screen">
        {/* The project bar is the section's header; this names it to the outline. */}
        <h1 className="sr-only">Dataset</h1>
        {release === null && (
          <SectionActions>
            <Button size="lg" data-testid="publish-release" disabled={dataset.data === undefined} onClick={() => setPublishing(true)}>
              Publish release
            </Button>
          </SectionActions>
        )}

        <div className={`flex min-w-0 flex-col lg:flex-row ${FIT}`}>
          <VersionNav
            versions={versions}
            open={version.id}
            onOpen={setOpened}
            head={
              <section aria-label={`About ${version.title}`} data-testid="version-facts" className="shrink-0 border-b border-border/70 p-4 text-sm">
                {release === null ? (
                  <Async query={stats} loadingRows={3}>
                    {(counts) => <VersionFacts projectId={projectId} version={version} stats={counts} parts={null} />}
                  </Async>
                ) : (
                  <VersionFacts projectId={projectId} version={version} stats={stats.data} parts={parts} />
                )}
              </section>
            }
          >
            {/* A list that could not be read is said, never shown as a dataset with no releases. */}
            {releases.isError && (
              <div className="border-t border-border/70 p-4" data-testid="releases-error">
                <ErrorState message={refusalProse(releases.error)} onRetry={() => void releases.refetch()} />
              </div>
            )}
          </VersionNav>
          <VersionView key={version.id} projectId={projectId} datasetId={dataset.data?.id} version={version} latestTag={latestTag} />
        </div>

        <PublishDialog datasetId={dataset.data?.id ?? ""} open={publishing} onClose={() => setPublishing(false)} />
        <PageStatus>
          <span className="tabular-nums" data-testid="dataset-status">
            {version.title} · {formatCount(version.images)} {version.images === 1 ? "image" : "images"} · {formatCount(versions.length - 1)} {versions.length === 2 ? "release" : "releases"}
          </span>
        </PageStatus>
      </div>
    );
  }

  return release === null ? (
    layout(null)
  ) : (
    <ExportForm key={release.id} projectId={projectId} releaseId={release.id} tag={release.tag} render={(parts) => layout(parts)} />
  );
}
