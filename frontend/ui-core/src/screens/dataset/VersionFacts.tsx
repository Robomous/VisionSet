/**
 * The open version's facts, at the top of the left column: a summary line per
 * section, the detail one click down.
 *
 * Each section's heading already answers — *48 images · 427 annotations*,
 * *Not verified* — so the column stays short and the versions under it stay in
 * view. A section's action sits at its heading's end, outside the toggle:
 * Verify beside Integrity, Download beside Manifest. A section with nothing to
 * open is only words, so a row never pretends to open.
 *
 * ## A release's export is a section too
 *
 * The model, the recipe and the button, with the job's state as the section's
 * answer — in the column with the rest, open by default, because it is what a
 * release is opened for. The form behind it lives above the column
 * (`ExportForm`), so a job keeps running whatever the column does.
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

import { parseLabelClass, type LabelClass } from "@visionset/annotator";
import { ChevronDown } from "lucide-react";
import { useState, type JSX, type ReactNode } from "react";

import { Button, cn, FieldError, Label } from "@robomous/ui-core";
import { refusalProse } from "../../data/refusals";
import { formatCount } from "../../lib/format";
import { classColor } from "../../palette";
import { StateChip } from "../../patterns/StateChip";
import { saveBlob } from "../download";
import { useActiveSchema, useDownloadManifest, useVerifyRelease, type DatasetStats, type Release } from "../queries";
import type { ExportParts } from "./ExportForm";
import { RecipeChoice } from "./RecipeChoice";
import { changesState, classesState, FOLDS, integrityState, jobState, labelingState, schemaChange, splitSaid, splitText } from "./states";
import { Verification } from "./Verification";
import { Manifest } from "./Manifest";
import type { DatasetVersion } from "./versions";

export function VersionFacts({ projectId, version, stats, parts }: { readonly projectId: string; readonly version: DatasetVersion; readonly stats: DatasetStats | undefined; readonly parts: ExportParts | null }): JSX.Element {
  if (version.release !== null) return <ReleaseFacts projectId={projectId} version={version} release={version.release} parts={parts} />;
  if (stats === undefined) return <p className="text-muted-foreground">Reading the dataset…</p>;
  return <WorkingFacts projectId={projectId} version={version} stats={stats} />;
}

function WorkingFacts({ projectId, version, stats }: { readonly projectId: string; readonly version: DatasetVersion; readonly stats: DatasetStats }): JSX.Element {
  const schema = useActiveSchema(projectId);
  const classes = classesState(schema.data?.classes.map((one) => one.name), stats);
  const schemaMoved = schemaChange(version, schema.data?.version);
  return (
    <div className="-my-1 flex flex-col" data-testid="dataset-stats">
      <Section id="contents" title="Contents" summary={`${formatCount(stats.asset_count)} images · ${formatCount(stats.annotation_count)} annotations`} aside={<StateChip state={changesState(version)} testId="state-changes" />}>
        <Line label="Labeled">
          <StateChip state={labelingState(stats)} testId="state-labeling" />
        </Line>
        <Line label="Per image">
          <span className="tabular-nums">{(stats.asset_count === 0 ? 0 : stats.annotation_count / stats.asset_count).toFixed(1)}</span>
        </Line>
        {schema.data !== undefined && (
          <Line label="Schema">{schemaMoved === null ? <span className="tabular-nums">v{schema.data.version}</span> : <StateChip state={schemaMoved} testId="state-schema" />}</Line>
        )}
      </Section>
      <Section
        id="classes"
        title="Classes"
        summary={classes?.label ?? `${formatCount(stats.classes.length)} in use`}
        aside={classes === null ? undefined : <StateChip state={classes} iconOnly linesOnly testId="state-classes" />}
        defaultOpen
      >
        <ClassList classes={schema.data?.classes} stats={stats} />
      </Section>
    </div>
  );
}

function ReleaseFacts({ projectId, version, release, parts }: { readonly projectId: string; readonly version: DatasetVersion; readonly release: Release; readonly parts: ExportParts | null }): JSX.Element {
  const verify = useVerifyRelease(release.id);
  const manifest = useDownloadManifest(release.id);
  const split = splitText(release);
  const job = parts === null ? null : jobState(parts);
  const moved = [
    [version.imagesDelta, "image", "images"],
    [version.annotationsDelta, "annotation", "annotations"],
  ] as const;
  const since = moved
    .filter(([delta]) => delta !== null && delta !== 0)
    .map(([delta, one, many]) => `${(delta ?? 0) > 0 ? "+" : "−"}${formatCount(Math.abs(delta ?? 0))} ${Math.abs(delta ?? 0) === 1 ? one : many}`);
  return (
    <div className="-my-1 flex flex-col" data-testid={`release-${release.tag}`}>
      <Section id="contents" title="Contents" summary={`${formatCount(release.asset_count)} images · ${formatCount(release.annotation_count)} annotations`}>
        {since.length > 0 && version.previous !== null && (
          <Line label={`Since ${version.previous.tag}`}>
            <span className="tabular-nums">{since.join(", ")}</span>
          </Line>
        )}
        <Line label="Split">
          {split === null || release.split == null ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            <span className="flex items-center gap-2.5" data-testid={`split-${release.tag}`}>
              <span className="tabular-nums" aria-hidden="true">
                {split}
              </span>
              <span className="sr-only">{splitSaid(release)}</span>
              <span aria-hidden="true" className="flex h-1.5 min-w-0 flex-1 gap-px overflow-hidden rounded-full">
                {FOLDS.map((fold) => (
                  <span key={fold.key} className={fold.shade} style={{ flexGrow: release.split?.[fold.key] ?? 0 }} />
                ))}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">seed {release.split.seed}</span>
            </span>
          )}
        </Line>
        <Line label="Schema">
          <span className="tabular-nums">v{release.schema_version}</span>
        </Line>
        <Line label="Built with">VisionSet {release.visionset_version}</Line>
      </Section>
      <Section
        id="integrity"
        title="Integrity"
        summary={<StateChip state={integrityState(release, verify)} testId="state-integrity" />}
        aside={
          <TextAction testId={`verify-${release.tag}`} disabled={verify.isFetching} onClick={() => void verify.refetch()}>
            Verify
          </TextAction>
        }
        note={
          verify.isError ? (
            <FieldError data-testid={`verify-error-${release.tag}`}>{refusalProse(verify.error)}</FieldError>
          ) : verify.data !== undefined && !verify.data.ok ? (
            <Verification report={verify.data} tag={release.tag} />
          ) : null
        }
      />
      <Section
        id="manifest"
        title="Manifest"
        summary={<Manifest hash={release.manifest_hash} />}
        aside={
          <TextAction
            testId={`manifest-${release.tag}`}
            disabled={manifest.isPending}
            onClick={() => manifest.mutate(undefined, { onSuccess: (blob) => saveBlob(blob, `${release.tag}-manifest.json`) })}
          >
            Download
          </TextAction>
        }
        // A download that said nothing when it failed is indistinguishable from a browser that swallowed the save dialog.
        note={manifest.isError ? <FieldError data-testid={`manifest-error-${release.tag}`}>{refusalProse(manifest.error)}</FieldError> : null}
      />
      {parts !== null && (
        <Section id="export" title="Export" summary={job === null ? <span className="text-muted-foreground">Not exported this session</span> : <StateChip state={job} testId="export-job-state" />} defaultOpen>
          <ExportFields projectId={projectId} parts={parts} />
        </Section>
      )}
    </div>
  );
}

/**
 * The export's fields: the model, the recipe, what the format says about
 * losing shapes, the consent it asks for, what went wrong, and the button.
 */
function ExportFields({ projectId, parts }: { readonly projectId: string; readonly parts: ExportParts }): JSX.Element {
  return (
    <div className="flex flex-col gap-3" data-testid="export-form">
      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3">
        <Label htmlFor="export-target" className="text-sm font-normal text-muted-foreground">
          Model
        </Label>
        <div className="min-w-0">{parts.target}</div>
      </div>
      <RecipeChoice projectId={projectId} value={parts.recipe} onChange={parts.onRecipe} />
      {parts.hint}
      {parts.consent}
      {parts.failures}
      <Button className="w-full" data-testid="export-submit" disabled={parts.disabled} onClick={parts.submit}>
        {parts.label}
      </Button>
    </div>
  );
}

/** A quiet text action at a section's end. */
function TextAction({ testId, disabled, onClick, children }: { readonly testId: string; readonly disabled: boolean; readonly onClick: () => void; readonly children: ReactNode }): JSX.Element {
  return (
    <Button variant="ghost" size="sm" className="-mr-2 shrink-0 text-xs" data-testid={testId} disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  );
}

/**
 * A section: its title, the answer under it, an action at its end, and — for
 * a section that holds more — the detail under a toggle. A `note` is what the
 * section must say whatever its toggle: a failure, a report.
 */
function Section({
  id,
  title,
  summary,
  aside,
  note,
  defaultOpen = false,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly summary: ReactNode;
  readonly aside?: ReactNode;
  readonly note?: ReactNode;
  readonly defaultOpen?: boolean;
  readonly children?: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const body = children !== null && children !== undefined && children !== false;
  const head = (
    <>
      <span className="flex min-h-6 items-center gap-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
        {body && <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none", open && "rotate-180")} />}
      </span>
      <span className="flex min-h-6 w-full min-w-0 items-center tabular-nums">{typeof summary === "string" ? <span className="truncate">{summary}</span> : summary}</span>
    </>
  );
  return (
    <div className="border-b border-border/60 py-1 last:border-b-0" data-testid={`section-${id}`}>
      {/* The action rides the heading's line, outside the toggle, so the answer under it keeps the column's whole width. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start">
        {body ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`section-${id}-body`}
            onClick={() => setOpen(!open)}
            className="col-start-1 col-end-3 row-start-1 -mx-2 flex min-w-0 cursor-pointer flex-col items-start rounded-md px-2 py-1 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {head}
          </button>
        ) : (
          <div className="col-start-1 col-end-3 row-start-1 flex min-w-0 flex-col items-start py-1">{head}</div>
        )}
        {aside !== undefined && <div className="relative col-start-2 row-start-1 flex h-8 items-center">{aside}</div>}
      </div>
      {note !== null && note !== undefined && <div className="pb-2">{note}</div>}
      {body && open && (
        <div id={`section-${id}-body`} className="flex flex-col gap-2 pt-1 pb-2.5">
          {children}
        </div>
      )}
    </div>
  );
}

function Line({ label, children }: { readonly label: string; readonly children: ReactNode }): JSX.Element {
  return (
    <div className="grid min-h-6 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3">
      <span className="truncate text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * How the labels divide: every class the schema declares, in use or not, its
 * bar and its count — annotations on images, because a thousand labels over a
 * thousand images and the same thousand over ten are a very different dataset.
 * A declared class nobody labelled is drawn too, muted, at zero: that is the
 * gap a person training on this needs to see.
 */
type DeclaredClasses = NonNullable<ReturnType<typeof useActiveSchema>["data"]>["classes"];

function ClassList({ classes, stats }: { readonly classes: DeclaredClasses | undefined; readonly stats: DatasetStats }): JSX.Element {
  const declared = new Map<string, LabelClass>();
  for (const one of classes ?? []) declared.set(one.name, parseLabelClass(one));
  const counts = new Map(stats.classes.map((row) => [row.label_class, row]));
  const names = [...new Set([...stats.classes.map((row) => row.label_class), ...declared.keys()])];
  const most = Math.max(1, ...stats.classes.map((row) => row.annotations));
  if (names.length === 0) return <p className="text-muted-foreground">No classes yet.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {names.map((name) => {
        const row = counts.get(name);
        const color = classColor(declared.get(name), name);
        const n = row?.annotations ?? 0;
        return (
          <li key={name} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_auto] items-center gap-3" data-testid={`class-count-${name}`}>
            <span className={cn("flex min-w-0 items-center gap-2", n === 0 && "text-muted-foreground")}>
              <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[3px]" style={{ background: color, opacity: n === 0 ? 0.4 : 1 }} />
              <span className="truncate">{name}</span>
            </span>
            <span aria-hidden="true" className="h-1 overflow-hidden rounded-full" style={{ background: `color-mix(in oklab, ${color} 16%, transparent)` }}>
              <span className="block h-full rounded-full" style={{ width: `${(n / most) * 100}%`, background: color }} />
            </span>
            <span className="text-right text-xs text-muted-foreground tabular-nums">
              {n === 0 ? (
                "none"
              ) : (
                <>
                  <span className="text-sm text-foreground">{formatCount(n)}</span> on {formatCount(row?.assets ?? 0)}
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
