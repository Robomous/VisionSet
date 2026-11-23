/**
 * The open version's panels, at the top of the left rail. Its numbers are the
 * KPI row over the page (`VersionKpis.tsx`); the rail holds what the numbers
 * cannot say.
 *
 * The working copy's is its classes — the Overview's own panel
 * (`patterns/project/ClassRail.tsx`), read off the trunk — because what a
 * release would teach a model is the question before publishing. A release's
 * are its proof and its export, each a panel that folds (`Fold.tsx`).
 *
 * ## A release's export is a panel too
 *
 * The model, the recipe and the button — in the rail with the rest, open by
 * default, because it is what a release is opened for. The job's state is the
 * panel's answer, open or folded. The form behind it wraps these facts alone
 * (`DatasetScreen`), so folding keeps it — and its job — mounted.
 *
 * ## A release is the only truly immutable artifact
 *
 * `docs/content/releases.md`: the manifest is a pure function of content. So a
 * release offers no edit and no delete here; its actions are the ones that
 * read it — verify it, take its manifest, export it.
 *
 * ## Verification is on demand, because it re-reads every blob
 *
 * `ReleaseService.verify` re-reads and re-hashes the lot, which is not
 * something to do because a column rendered: the query is `enabled: false` and
 * Verify runs it. A verify or a download that could not be asked is said in a
 * sentence under its row, and a stale report never stays under a failed one.
 */

import { Cpu, Fingerprint, PackageCheck, ShieldCheck } from "lucide-react";
import type { JSX } from "react";

import { Button, FieldError } from "@robomous/ui-core";
import { refusalProse } from "../../data/refusals";
import { WarnTip } from "../../patterns/WarnTip";
import { ClassRail } from "../../patterns/project/ClassRail";
import { saveBlob } from "../download";
import { imbalanceNote } from "../imbalance";
import { classRows } from "../overviewRows";
import { useActiveSchema, useDownloadManifest, useVerifyRelease, type DatasetStats, type Release } from "../queries";
import type { ExportParts } from "./ExportForm";
import { Field, Fold } from "./Fold";
import { Manifest } from "./Manifest";
import { RecipeChoice } from "./RecipeChoice";
import { integrityState, jobState } from "./states";
import { StateChip } from "../../patterns/StateChip";
import { Verification } from "./Verification";
import type { DatasetVersion } from "./versions";

export function VersionFacts({ projectId, version, stats, parts }: { readonly projectId: string; readonly version: DatasetVersion; readonly stats: DatasetStats | undefined; readonly parts: ExportParts | null }): JSX.Element {
  if (version.release !== null) return <ReleaseFacts projectId={projectId} release={version.release} parts={parts} />;
  if (stats === undefined) return <p className="px-4 py-3 text-xs text-muted-foreground md:px-6">Reading the dataset…</p>;
  return <WorkingFacts projectId={projectId} stats={stats} />;
}

/** What the working copy would teach a model: its classes, as the Overview draws them. */
function WorkingFacts({ projectId, stats }: { readonly projectId: string; readonly stats: DatasetStats }): JSX.Element {
  const schema = useActiveSchema(projectId);
  return (
    <div className="flex flex-col" data-testid="dataset-stats">
      <ClassRail rows={classRows(stats, schema.data?.classes)} totalAnnotations={stats.annotation_count} note={imbalanceNote(stats.classes)} />
    </div>
  );
}

function ReleaseFacts({ projectId, release, parts }: { readonly projectId: string; readonly release: Release; readonly parts: ExportParts | null }): JSX.Element {
  const verify = useVerifyRelease(release.id);
  const manifest = useDownloadManifest(release.id);
  const integrity = integrityState(release, verify);
  const job = parts === null ? null : jobState(parts);
  return (
    // A hairline between panels, as between every cell on the page.
    <div className="flex flex-col divide-y divide-border/70" data-testid={`release-${release.tag}`}>
      <Fold id="proof" icon={ShieldCheck} title="Proof" answer={<StateChip state={integrity} />}>
        <Field icon={ShieldCheck} label="Integrity">
          <span className="flex w-full min-w-0 items-center justify-between gap-2">
            <StateChip state={integrity} testId="state-integrity" />
            <Button variant="ghost" size="sm" className="-mr-2 shrink-0 text-xs" data-testid={`verify-${release.tag}`} disabled={verify.isFetching} onClick={() => void verify.refetch()}>
              Verify
            </Button>
          </span>
        </Field>
        {verify.isError ? (
          <FieldError data-testid={`verify-error-${release.tag}`}>{refusalProse(verify.error)}</FieldError>
        ) : verify.data !== undefined && !verify.data.ok ? (
          <Verification report={verify.data} tag={release.tag} />
        ) : null}
        <Field icon={Fingerprint} label="Manifest">
          <Manifest
            hash={release.manifest_hash}
            downloadTestId={`manifest-${release.tag}`}
            downloading={manifest.isPending}
            onDownload={() => manifest.mutate(undefined, { onSuccess: (blob) => saveBlob(blob, `${release.tag}-manifest.json`) })}
          />
        </Field>
        {/* A download that said nothing when it failed is indistinguishable from a browser that swallowed the save dialog. */}
        {manifest.isError && <FieldError data-testid={`manifest-error-${release.tag}`}>{refusalProse(manifest.error)}</FieldError>}
      </Fold>
      {parts !== null && (
        <Fold
          id="export"
          icon={PackageCheck}
          title="Export"
          answer={job === null ? "Not exported this session" : <StateChip state={job} testId="export-job-state" />}
          answerAlways
        >
          <ExportFields projectId={projectId} parts={parts} />
        </Fold>
      )}
    </div>
  );
}

/**
 * The export's fields: the model — with what its format cannot carry as a
 * warning beside it — the recipe, the consent a lossy export asks for, what
 * went wrong, and the button.
 */
function ExportFields({ projectId, parts }: { readonly projectId: string; readonly parts: ExportParts }): JSX.Element {
  const warning = parts.warning;
  return (
    <div className="flex flex-col gap-1" data-testid="export-form">
      <Field
        icon={Cpu}
        label="Model"
        htmlFor="export-target"
        action={
          warning === null ? undefined : (
            <WarnTip title={warning.title} size="sm" testId={warning.testId}>
              {warning.body}
            </WarnTip>
          )
        }
      >
        <div className="w-full min-w-0">{parts.target}</div>
      </Field>
      <RecipeChoice projectId={projectId} value={parts.recipe} onChange={parts.onRecipe} />
      {parts.consent}
      {parts.failures}
      <Button className="mt-2 w-full" data-testid="export-submit" disabled={parts.disabled} onClick={parts.submit}>
        {parts.label}
      </Button>
    </div>
  );
}
