/**
 * Getting a release out: who it is for, which recipe, then the job — the
 * export's behaviour, without its layout.
 *
 * The form is a render prop. It holds the choices, the attempt-shaped lossy
 * consent, the job and its download, and hands them to whoever lays them out
 * (the release's Export section, `VersionFacts.tsx`). It is mounted above the
 * column that shows it, so a job keeps running whatever the column does.
 */

import { Plug } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";

import { asApiError } from "../../data/errors";
import { Alert, AlertDescription, AlertTitle, FieldError } from "@robomous/ui-core";
import { describeClassCount, describeTargetDrops, jobFailureProse, lostAssets, lostClasses, refusalProse } from "../../data/refusals";
import { EmptyState, ErrorState } from "../../patterns/AsyncStates";
import { ExportTargetSelect } from "../../patterns/ExportTargetSelect";
import { saveBlob } from "../download";
import { recipeKeys, useBackgroundJob, useExportRelease, useExportTargets, useFormats, useJobArtifact, type BackgroundJob, type ExportTarget } from "../queries";

/** The 409 that means "say you meant it". Not `confirm`, and not destructive. */
const LOSSY = "LOSSY_EXPORT_NOT_CONSENTED";

function isSettled(job: BackgroundJob): boolean {
  return job.state === "succeeded" || job.state === "failed" || job.state === "cancelled";
}

/**
 * A recipe name is a slug, so a tilde can never be one — which is what makes it
 * safe as the "no recipe" option's value.
 */
export const NO_RECIPE = "~none";

/** A warning about the chosen model: the title, a line under it, and its test hook. */
export interface ExportWarning {
  readonly title: string;
  readonly body: string;
  readonly testId: string;
}

/** What the form is made of, for the dialog to place. */
export interface ExportParts {
  /** The model picker, names only — or why there is nothing to pick. */
  readonly target: ReactNode;
  readonly recipe: string;
  readonly onRecipe: (name: string) => void;
  /** The consent gate: shut while nothing is chosen, while running, and while the API is asking. */
  readonly disabled: boolean;
  readonly running: boolean;
  /** "Export", "Exporting…" or "Export anyway". */
  readonly label: string;
  readonly submit: () => void;
  /** The job's `BackgroundJobState`, or `null` before one is asked for. */
  readonly state: string | null;
  readonly processed: number | null;
  readonly total: number | null;
  /** What the chosen model's format says about losing shapes, when it says anything: a warning beside the field. */
  readonly warning: ExportWarning | null;
  readonly consent: ReactNode;
  readonly failures: ReactNode;
}

export function ExportForm({ projectId, releaseId, tag, render }: { readonly projectId: string; readonly releaseId: string; readonly tag: string; readonly render: (parts: ExportParts) => ReactNode }): JSX.Element {
  const targets = useExportTargets();
  const formats = useFormats();
  const exportRelease = useExportRelease(releaseId);
  const artifact = useJobArtifact();
  const queries = useQueryClient();
  const [target, setTarget] = useState("");
  const [recipe, setRecipe] = useState(NO_RECIPE);
  const [consented, setConsented] = useState(false);
  // The job this form is watching. Null until a launch is accepted, and null
  // again once the archive has been saved — a finished download is not something
  // to keep polling.
  const [jobId, setJobId] = useState<string | null>(null);
  // Whether this attempt's archive has been asked for. Only the effect below
  // reads it, to ask once; nothing is drawn from it, so it is a ref.
  const saved = useRef(false);
  // The last state this form saw, held because a succeeded job clears `jobId`
  // the moment its archive is saved — so the state would announce the outcome
  // and remove it in the same tick. Set when the archive has been saved, and
  // cleared by `run`, not by the poll.
  const [outcome, setOutcome] = useState<string | null>(null);
  const job = useBackgroundJob(jobId);

  const chosen = (targets.data?.items ?? []).find((one) => one.name === target);
  // **The refusals still arrive on the launch.** An unknown target is a 404 and a
  // lossy export without consent is a 409, both answered by the request rather
  // than by the job — so the consent flow is exactly the one that shipped
  // before export was queued.
  const failure = exportRelease.isError ? asApiError(exportRelease.error) : null;
  const needsConsent = failure?.code === LOSSY;
  const running = exportRelease.isPending || (job.data !== undefined && !isSettled(job.data));

  // A consent answers one refusal for one request: it is spent by the request it
  // rides on, and a changed target or recipe is a different question, so the
  // refusal it answered goes with it. Another release is another form (`key`).
  function forgetConsent(): void {
    setConsented(false);
    if (exportRelease.isError) exportRelease.reset();
  }

  function run(allowLossy: boolean): void {
    saved.current = false;
    setOutcome(null);
    setConsented(false);
    exportRelease.mutate(
      {
        target,
        ...(recipe === NO_RECIPE ? {} : { recipe }),
        ...(allowLossy ? { allowLossy: true } : {}),
      },
      { onSuccess: (queued) => setJobId(queued.id) },
    );
  }

  // The download, once and only once the work has succeeded.
  //
  // An effect rather than a `usePollingQuery` callback because the *transition*
  // is what matters: the poll answers `succeeded` on every subsequent tick too,
  // and a browser asked to save the same archive four times does it four times.
  // `saved` is the guard. The effect sets no state: a job is only ever watched
  // after a launch, so it never runs on mount, where `<StrictMode>`'s second pass
  // would find a ref already set and lose the error of the first.
  useEffect(() => {
    if (saved.current || jobId === null || job.data?.state !== "succeeded") return;
    saved.current = true;
    // The recipe's `used_by` is read off succeeded export jobs, so this one
    // changed it.
    if (recipe !== NO_RECIPE) void queries.invalidateQueries({ queryKey: recipeKeys.recipes(projectId) });
    artifact.mutate(jobId, {
      onSuccess: (blob) => {
        saveBlob(blob, `${tag}-${target}.zip`);
        setOutcome("succeeded");
        setJobId(null);
      },
    });
  }, [jobId, job.data?.state, artifact, tag, target, recipe, queries, projectId]);

  return (
    <>
      {render(
        exportParts({
          targets,
          formats,
          chosen,
          target,
          setTarget: (next: string) => {
            forgetConsent();
            setTarget(next);
          },
          recipe,
          setRecipe: (next: string) => {
            forgetConsent();
            setRecipe(next);
          },
          running,
          needsConsent,
          consented,
          setConsented,
          run,
          // The state's subject: the live job while there is one, the outcome once
          // the archive has been handed over and the poll has stopped.
          shownState: job.data?.state ?? outcome,
          job: job.data,
          failure,
          artifact,
        }),
      )}
    </>
  );
}

/**
 * The parts, from the form's state: the gate, the words, the job, and the
 * sentences that go under it. A plain function, so the form's own body keeps
 * to the state.
 */
function exportParts(input: {
  readonly targets: ReturnType<typeof useExportTargets>;
  readonly formats: ReturnType<typeof useFormats>;
  readonly chosen: ExportTarget | undefined;
  readonly target: string;
  readonly setTarget: (name: string) => void;
  readonly recipe: string;
  readonly setRecipe: (name: string) => void;
  readonly running: boolean;
  readonly needsConsent: boolean;
  readonly consented: boolean;
  readonly setConsented: (next: boolean) => void;
  readonly run: (allowLossy: boolean) => void;
  readonly shownState: string | null;
  readonly job: BackgroundJob | undefined;
  readonly failure: ReturnType<typeof asApiError> | null;
  readonly artifact: ReturnType<typeof useJobArtifact>;
}): ExportParts {
  const { targets, formats, chosen, target, setTarget, recipe, setRecipe, running, needsConsent, consented, setConsented, run, shownState, job, failure, artifact } = input;
  const stopped = job !== undefined && isSettled(job) && job.state !== "succeeded" ? job : null;
  const lost = failure !== null && needsConsent ? lostClasses(failure.detail) : null;
  return {
    target: <TargetPicker targets={targets} target={target} onTarget={setTarget} />,
    recipe,
    onRecipe: setRecipe,
    disabled: target === "" || running || (needsConsent && !consented),
    running,
    label: running ? "Exporting…" : needsConsent ? "Export anyway" : "Export",
    submit: () => run(needsConsent),
    state: shownState,
    processed: job?.processed ?? null,
    total: job?.total ?? null,
    warning: lossyWarning(formats, chosen),
    consent: needsConsent ? <Consent chosen={chosen} lost={lost} failure={failure} consented={consented} onConsented={setConsented} /> : null,
    failures: <Failures refusal={needsConsent ? null : failure} stopped={stopped} download={artifact.isError ? artifact.error : null} />,
  };
}

/**
 * Who the export is for: the catalog, an error that says so and asks again, or
 * the line that says none is installed — three answers, because a failed
 * `GET /export-targets` is not an answer at all, an empty page is an answer
 * about this server's plugins, and the picker is for when there is something
 * to choose. Rolling the first two together produces a control offering
 * nothing and saying nothing, which is also the visible signature of an install
 * whose exporters are not discoverable. Loading is not a fourth branch: the
 * picker stands empty for the one tick it takes.
 */
function TargetPicker({ targets, target, onTarget }: { readonly targets: ReturnType<typeof useExportTargets>; readonly target: string; readonly onTarget: (name: string) => void }): JSX.Element {
  const catalog = targets.data?.items ?? [];
  if (targets.isError) {
    return (
      <div data-testid="export-targets-error">
        <ErrorState message={`${refusalProse(targets.error)} Try again to choose a model.`} onRetry={() => void targets.refetch()} />
      </div>
    );
  }
  if (targets.data !== undefined && catalog.length === 0) {
    return (
      <div data-testid="export-targets-empty">
        <EmptyState size="compact" icon={<Plug className="size-7" strokeWidth={1.5} />} title="No exporters installed" description="Exporters ship as plugins on the server. Install one to write this release out." />
      </div>
    );
  }
  return <ExportTargetSelect id="export-target" data-testid="export-target" compact targets={catalog} value={target} onValueChange={onTarget} />;
}

/**
 * Declared by the format, never by the release: a bbox-only format loses a
 * polygon whether or not today's dataset holds one. A formats read that failed
 * is said, not swallowed — the warning is there for a reason, and the launch
 * still asks before dropping.
 */
function lossyWarning(formats: ReturnType<typeof useFormats>, chosen: ExportTarget | undefined): ExportWarning | null {
  if (chosen === undefined) return null;
  if (formats.isError) {
    return { title: `Not known whether ${chosen.label} loses shapes`, body: "The formats could not be read. The export asks before dropping a shape.", testId: "lossy-unknown" };
  }
  const lossy = formats.data?.items.find((one) => one.name === chosen.format)?.lossy === true;
  return lossy ? { title: `${chosen.label} cannot take everything the schema allows`, body: "The export asks before it drops a shape.", testId: "lossy-hint" } : null;
}

/** Whatever went wrong, each in its own sentence: the refusal, the job that stopped, the download that failed. */
function Failures({ refusal, stopped, download }: { readonly refusal: ReturnType<typeof asApiError> | null; readonly stopped: BackgroundJob | null; readonly download: unknown }): JSX.Element | null {
  if (refusal === null && stopped === null && download === null) return null;
  return (
    <div className="flex flex-col gap-1">
      {refusal !== null && <FieldError data-testid="export-error">{refusalProse(refusal)}</FieldError>}
      {/* A job that stopped without producing anything: the only account of
          a failure that happened after the request had already been answered. */}
      {stopped !== null && (
        <FieldError data-testid="export-job-error">{stopped.state === "cancelled" ? "The export was cancelled." : jobFailureProse(stopped, "The export stopped without saying why.")}</FieldError>
      )}
      {download !== null && <FieldError data-testid="export-download-error">{refusalProse(asApiError(download))}</FieldError>}
    </div>
  );
}

/** The question a lossy export asks before it drops anything: what would be lost, and the tick that accepts it. */
function Consent({
  chosen,
  lost,
  failure,
  consented,
  onConsented,
}: {
  readonly chosen: ExportTarget | undefined;
  readonly lost: ReturnType<typeof lostClasses> | null;
  readonly failure: ReturnType<typeof asApiError> | null;
  readonly consented: boolean;
  readonly onConsented: (next: boolean) => void;
}): JSX.Element {
  return (
    <Alert variant="destructive" data-testid="lossy-consent">
      <AlertTitle>Some shapes cannot be exported</AlertTitle>
      <AlertDescription>
        {/* The sentence names the target and the counts when the 409
            carried its report; without one, the vocabulary's own line. */}
        <p>{chosen !== undefined && lost !== null ? describeTargetDrops(chosen, lost, lostAssets(failure?.detail ?? null)) : refusalProse(failure)}</p>
        {lost !== null && lost.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-sm" data-testid="lossy-classes">
            {lost.map((one) => (
              <li key={`${one.label_class}:${one.geometry}:${one.status}`}>
                {describeClassCount(one)}
                {one.reason != null && <span className="text-muted-foreground"> {one.reason}.</span>}
              </li>
            ))}
          </ul>
        )}
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-primary" data-testid="lossy-checkbox" checked={consented} onChange={(event) => onConsented(event.target.checked)} />
          Export anyway, accepting that the copy is incomplete.
        </label>
      </AlertDescription>
    </Alert>
  );
}
