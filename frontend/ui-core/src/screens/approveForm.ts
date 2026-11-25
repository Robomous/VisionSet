/**
 * The approval's state and its two requests, apart from where they are drawn.
 *
 * `ApproveDialog` draws them over a page; the Add images dialog draws them as its
 * last step, in place, because a dialog over a dialog is the one thing a modal
 * flow must not open (`DESIGN.md`: one deep). Both draw `ApproveFields`
 * (`BatchLifecycle.tsx`), so the switch, the cut and the refusals have one
 * spelling.
 */

import { useState } from "react";

import { batchNoun, type Modality } from "../lib/assetNoun";
import { formatCount } from "../lib/format";
import {
  useActiveSchema,
  useApproveBatch,
  useBatchTransition,
  type Batch,
  type Partition,
} from "./queries";

type CutMode = "one" | "split";

/** Even sizes, as `BySize` cuts them: every job `size` long, the last one the rest. */
function cutBySize(images: number, size: number): readonly number[] {
  const out: number[] = [];
  for (let left = images; left > 0; left -= size) out.push(Math.min(size, left));
  return out;
}

/**
 * Split's starting size: 25 a job, or half a batch too small for that — so
 * choosing Split always makes at least two jobs rather than repeating One job.
 */
function splitDefault(images: number): number {
  return images > 25 ? 25 : Math.max(1, Math.ceil(images / 2));
}

/** The stepper's step: by fives on a batch big enough for it to matter, by ones otherwise. */
function stepFor(images: number): number {
  return images > 20 ? 5 : 1;
}

/** Whether a typed images-per-job is one a cut can be made from. */
function usableSize(per: number): boolean {
  return Number.isFinite(per) && per >= 1;
}

/** How the batch is cut into jobs, as the form's pieces and as the request's body. */
interface Cut {
  /** Images per job, as typed. */
  readonly per: number;
  readonly valid: boolean;
  readonly parts: readonly number[];
  /** The folded heading's answer: *One job*, *3 jobs of up to 25*. */
  readonly answer: string;
  readonly partition: Partition;
}

function cutOf(mode: CutMode, size: string, images: number): Cut {
  const per = Math.floor(Number(size));
  const valid = mode === "one" || usableSize(per);
  const parts = mode === "one" || !valid ? [images] : cutBySize(images, per);
  const single = mode === "one" || parts.length <= 1;
  return {
    per,
    valid,
    parts,
    answer: single ? "One job" : `${parts.length} jobs of up to ${per}`,
    // `kind` is always explicit. A discriminated union's tag emitted by default
    // reads as optional in the schema while pydantic needs it in the input dict
    // to pick a variant, so omitting it fails with `union_tag_not_found`.
    partition: single ? { kind: "single" } : { kind: "by_size", size: per },
  };
}

/** The size after a step of `by`, held between one image and the whole batch. */
function steppedSize(images: number, per: number, by: number): string {
  const now = usableSize(per) ? per : 1;
  return String(Math.max(1, Math.min(images, now + by)));
}

/** What the approve form holds, and what it can do — one spelling for the dialog and the Add images step. */
export interface ApproveForm {
  readonly batch: Batch | null;
  readonly images: number;
  /** The asset noun for `images`, in the batch's modality. */
  readonly noun: string;
  /** What approving pins, said in words: `schema v3`, or the project's current schema while unread. */
  readonly pinned: string;
  readonly start: boolean;
  readonly setStart: (start: boolean) => void;
  readonly folded: boolean;
  readonly setFolded: (fold: (was: boolean) => boolean) => void;
  readonly mode: CutMode;
  readonly setMode: (mode: CutMode) => void;
  readonly size: string;
  readonly setSize: (size: string) => void;
  /** Images per job, as typed. */
  readonly per: number;
  readonly parts: readonly number[];
  /** The folded heading's answer: *One job*, *3 jobs of up to 25*. */
  readonly answer: string;
  readonly valid: boolean;
  readonly busy: boolean;
  /** The pinned version once the approval landed — set even when the start after it was refused. */
  readonly approvedAt: number | null;
  readonly approve: ReturnType<typeof useApproveBatch>;
  readonly begin: ReturnType<typeof useBatchTransition>;
  readonly step: (by: number) => void;
  readonly stepSize: number;
  /** Approve, then start when the switch says so. `onSettled` runs once both requests asked for have landed, with the approved batch. */
  readonly submit: (onSettled: (approved: Batch) => void) => void;
  readonly modalities: readonly Modality[];
  /** Back to the defaults, and no request outstanding: for a host that keeps the form mounted between openings. */
  readonly reset: () => void;
}

/**
 * A host that mounts the form per opening — `ApproveDialog`, keyed by the batch —
 * starts from the defaults for free. A host that keeps it mounted calls `reset`
 * when it opens, from the event that opens it.
 *
 * The cut's size is held only once typed: until then it is the default for the
 * batch's own image count, so a count that arrives late is not a reset.
 */
export function useApproveForm(batch: Batch | null): ApproveForm {
  const images = batch?.asset_count ?? 0;
  const [start, setStart] = useState(true);
  const [folded, setFolded] = useState(true);
  const [mode, setMode] = useState<CutMode>("one");
  const [typedSize, setTypedSize] = useState<string | null>(null);
  const approve = useApproveBatch(batch?.id ?? "");
  const begin = useBatchTransition(batch?.id ?? "", "start");
  const schema = useActiveSchema(batch?.project_id ?? "", batch !== null);
  const modalities = batch?.modalities ?? [];
  const [approvedAt, setApprovedAt] = useState<number | null>(null);

  const size = typedSize ?? String(splitDefault(images));
  const cut = cutOf(mode, size, images);
  const pinned = schema.data === undefined ? "the project’s current schema" : `schema v${schema.data.version}`;
  const resetApprove = approve.reset;
  const resetBegin = begin.reset;

  function submit(onSettled: (approved: Batch) => void): void {
    approve.mutate(cut.partition, {
      onSuccess: (approved) => {
        setApprovedAt(approved.schema_version ?? null);
        if (!start) return onSettled(approved);
        // A refused start stays where it was asked, under the approval it followed.
        begin.mutate(undefined, { onSuccess: () => onSettled(approved) });
      },
    });
  }

  return {
    batch,
    images,
    noun: batchNoun(modalities, images, "image"),
    pinned,
    start,
    setStart,
    folded,
    setFolded,
    mode,
    setMode,
    size,
    setSize: setTypedSize,
    per: cut.per,
    parts: cut.parts,
    answer: cut.answer,
    valid: cut.valid,
    busy: approve.isPending || begin.isPending,
    approvedAt,
    approve,
    begin,
    step: (by) => setTypedSize(steppedSize(images, cut.per, by)),
    stepSize: stepFor(images),
    submit,
    modalities,
    reset: () => {
      setStart(true);
      setFolded(true);
      setMode("one");
      setTypedSize(null);
      setApprovedAt(null);
      resetApprove();
      resetBegin();
    },
  };
}

/** The approve form's one-line cost: what freezes, what pins, and that a draft can't come back. */
export function approveCost(form: ApproveForm): string {
  return `Freezes its ${formatCount(form.images)} ${form.noun} and pins ${form.pinned}. A draft can’t come back.`;
}

/** The approve button's words while its two requests are in flight. */
export function approveLabel(form: ApproveForm): string {
  if (form.approve.isPending) return "Approving…";
  return form.begin.isPending ? "Starting…" : "Approve";
}
