/**
 * A model's runs and its state, as both the Models list and the model's sheet
 * read them: the state's word, the download and the integrity check read off
 * the connection, and their progress — one layout, two vocabularies.
 *
 * Shared by the row (`ModelsScreen.tsx`) and the sheet (`ModelSheet.tsx`), so a
 * run reads the same in a State cell and under the sheet's bar.
 */

import type { JSX } from "react";

import { Badge } from "@robomous/ui-core";
import {
  isLive,
  useCheckIntegrity,
  useDownloadWeights,
  type Connection,
  type IntegrityCheck,
  type WeightDownload,
} from "../data/inferenceQueries";
import { jobFailureProse, refusalProse } from "../data/refusals";
import { ProgressBar } from "../patterns/ProgressBar";
import { STATE_LABELS, bytes } from "./modelCopy";

/**
 * Semantic token **and** text, never colour alone: the word is what a screen
 * reader announces and what somebody who cannot tell the two desaturated chips
 * apart reads.
 */
export function StateBadge({ connection }: { readonly connection: Connection }): JSX.Element {
  return (
    <Badge variant={connection.setup_state === "ready" ? "success" : "warning"} data-testid="connection-status" data-state={connection.setup_state}>
      {STATE_LABELS[connection.setup_state]}
    </Badge>
  );
}

/**
 * The connection's weight transfer, read off the row rather than followed.
 *
 * **Nothing here remembers that a download was started**, and that is the whole
 * of why leaving the screen no longer loses one. The wire says which job, what
 * state and how many bytes; this reads it. A version of this that held the job id
 * from the `202` — which is what shipped — could only show a transfer the *same
 * mount* had launched, so a reload, a second tab, or walking to another screen
 * and back all produced `Not set up` beside a download that was still running.
 *
 * The mutation is still here because starting one is still an event, and its own
 * refusal (a 409, a missing runtime) is answered to the request rather than to a
 * job that was never created.
 *
 * A settled transfer stays readable, which is what makes a failure survivable: the
 * row goes on carrying the sentence until a retry replaces the record.
 */
export function useDownloadRun(connection: Connection): {
  readonly start: () => void;
  readonly running: boolean;
  readonly live: WeightDownload | null;
  readonly failure: string | null;
} {
  const mutation = useDownloadWeights();
  const download = connection.download ?? null;
  const live = isLive(download);
  return {
    start: () => mutation.mutate(connection.id),
    // `isPending` covers the gap between the click and the re-read that brings
    // the queued job back, which is the one moment the wire has not caught up.
    running: mutation.isPending || live,
    live: live ? download : null,
    failure: mutation.isError
      ? refusalProse(mutation.error)
      : download?.state === "failed"
        ? jobFailureProse(download, "The download did not finish.")
        : null,
  };
}

/**
 * The connection's integrity check, read off the row rather than followed.
 *
 * `useDownloadRun`'s twin over the same files, and it holds no job id for the
 * same reason: a check outlives the request that started it, so the only way a
 * screen can show one it did not itself launch — a reload, a second tab, a
 * terminal — is for the connection it lists to say so. Holding the id meant only
 * the mount that pressed the menu item could see a run reading gigabytes.
 *
 * A settled check stays readable, which is what makes a failure survivable: the
 * verdict is on `setup_state` and the sentence is here, and both outlive the tab
 * that was watching.
 */
export function useIntegrityRun(connection: Connection): {
  readonly start: () => void;
  readonly running: boolean;
  readonly live: IntegrityCheck | null;
  readonly failure: string | null;
} {
  const mutation = useCheckIntegrity();
  const check = connection.integrity_check ?? null;
  const live = isLive(check);
  return {
    start: () => mutation.mutate(connection.id),
    running: mutation.isPending || live,
    live: live ? check : null,
    failure: mutation.isError
      ? refusalProse(mutation.error)
      : check?.state === "failed"
        ? jobFailureProse(check, "The check did not finish.")
        : null,
  };
}

/**
 * A run in flight: a bar somebody watches, and a sentence they can read.
 *
 * Both, never one — a bar alone cannot say *queued*, and prose alone makes
 * somebody read a number every two seconds to find out whether anything is
 * moving. Amounts rather than a bare percentage, because "38%" of an unstated
 * quantity answers neither *how much longer* nor *how much of what*.
 *
 * **One layout, two vocabularies.** The geometry, the tabular figures and the
 * bar are shared; what each run *counts* is not, and the callers below supply the
 * sentence. A component that branched on a `kind` would be the place the two
 * vocabularies met, which is exactly what the wire is shaped to avoid.
 *
 * A run whose total is not known gets the sentence and **no bar at all**.
 * `Progress` renders an indeterminate value as an empty track, which reads as
 * *0%* — a lie in the one case where the truth is *this is going, and nobody can
 * say how far*. Giving the primitive an indeterminate animation is a
 * design-system change and not this screen's to make.
 */
export function RunProgress({
  testId,
  title,
  label,
  phase,
  percent,
  children,
}: {
  readonly testId: string;
  /** The run's name, short enough to share a line with its amounts. */
  readonly title: string;
  /** The bar's accessible name: the run, said in full. */
  readonly label: string;
  readonly phase?: string;
  readonly percent: number | null;
  readonly children: string;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={testId}>
      <span className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className="shrink-0 font-medium">{title}</span>
        {/*
          Tabular figures, `DESIGN.md`'s Numbers rule: the number changes every
          two seconds and the words around it must not move under a reader's eye.
          Right-aligned, so the percentage keeps one place down the column.
        */}
        <span className="ml-auto truncate text-muted-foreground tabular-nums" title={children} data-testid={`${testId}-prose`}>
          {children}
        </span>
      </span>
      {percent !== null ? (
        <ProgressBar value={percent} aria-label={label} className="h-1" data-testid={`${testId}-bar`} data-phase={phase} />
      ) : (
        // The bar's room, kept: the line above stays put when the bar arrives.
        <span aria-hidden="true" className="h-1" />
      )}
    </div>
  );
}

/**
 * What a transfer is doing, in bytes.
 *
 * **Three renderings, and the middle one is why this is not one line.**
 *
 * - *Queued* — no bytes yet, and the honest bar is absent rather than empty.
 * - *Transferring* — determinate, and it is the whole point of the feature.
 * - *Settling* — every byte is here and the job has not finished, because a
 *   download ends by reading what arrived and recording the connection ready.
 *   The bar is full and the sentence names that phase, so a bar sitting at 100%
 *   for a second reads as a step rather than as a stall.
 */
export function DownloadProgress({ download, ready }: { readonly download: WeightDownload; readonly ready: boolean }): JSX.Element {
  const { state, bytes_done: done, bytes_total: total } = download;
  // **Known and measurable are two questions, and folding them lost one.**
  // `total > 0` was doing both jobs, so a download of *nothing* — the built-in
  // stand-in has no weights to fetch — rendered "the published size could not be
  // read", which is a sentence about a failure in front of a total that was read
  // and is zero. A bar still needs a positive total to divide by, hence the
  // second name rather than one loosened test.
  const known = total !== null;
  const measurable = known && total > 0;
  const settling = known && done >= total;
  const percent =
    measurable && state !== "queued" ? Math.min(100, Math.round((done / total) * 100)) : null;
  return (
    <RunProgress
      testId="download-progress"
      // At `Ready` a download reads an index for missing files; before setup it
      // is the transfer itself — the same two readings the controls use.
      title={ready ? "Checking" : "Downloading"}
      label={ready ? "Checking for missing files" : "Downloading weights"}
      phase={settling ? "settling" : state}
      percent={percent}
    >
      {state === "queued"
        ? "Queued for a worker"
        : settling
          ? "Checking what arrived…"
          : measurable
            ? `${bytes(done)} of ${bytes(total)} · ${percent}%`
            : `${bytes(done)} so far · size unknown`}
    </RunProgress>
  );
}

/**
 * What a check is doing, in files.
 *
 * Files because that is what it counts: a check owns its loop and knows how many
 * the revision names before it opens the first one. It borrows no part of the
 * download's vocabulary, which is the whole reason the wire carries two shapes.
 *
 * The null-total window is short and real — a check reads the hub's listing
 * before its first file — so it gets the same no-bar treatment a download with no
 * published size does, and for the same reason.
 */
export function IntegrityProgress({ check }: { readonly check: IntegrityCheck }): JSX.Element {
  const { state, files_read: read, files_total: total } = check;
  const known = total !== null && total > 0;
  const percent = known && state !== "queued" ? Math.min(100, Math.round((read / total) * 100)) : null;
  return (
    <RunProgress testId="integrity-progress" title="Reading every file" label="Checking files are undamaged" phase={state} percent={percent}>
      {state === "queued"
        ? "Queued for a worker"
        : known
          ? `${read.toLocaleString()} of ${total.toLocaleString()} files · ${percent}%`
          : "Reading the file list…"}
    </RunProgress>
  );
}
