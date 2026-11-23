/**
 * The Classes section's versioning, shared by the editor and its dialogs: how
 * long a proposal settles before the server is asked about it, the kernel's
 * words for what changed, and the frames a narrowing would orphan.
 *
 * The history sheet is `SchemaHistorySheet.tsx`; a published version's head and
 * navigator, `SchemaVersionHead.tsx`; its marks in the class table,
 * `SchemaVersionMarks.tsx`.
 *
 * ## The changes are the kernel's, never computed here
 *
 * The draft's change list is `POST .../schema/preview` and a version's is
 * `GET .../schema/compare` against the one before it, both rendered in the
 * API's own words. An optional attribute added is additive while a required one
 * is not, and a TypeScript copy of that rule would drift into a screen calling
 * a change safe that the API then refuses.
 */

import { Check } from "lucide-react";
import { useEffect, useState, type JSX } from "react";

import { Button, cn } from "@robomous/ui-core";
import { formatCount } from "../lib/format";
import { AssetThumbnail } from "./AssetThumbnail";
import { Async } from "../data/Async";
import type { LabelClassBody, SchemaChange } from "./queries";
import { useBatches, useSchemaBlockingAssets } from "./queries";

/**
 * How long a proposal has to hold still before the server is asked about it.
 *
 * `ClassFields` emits an edit per character typed into a class name, and both
 * questions the page asks — what would change, which frames are in the way —
 * cost the server a walk over every annotation in the project. A half-typed
 * name is a proposal nobody made. The same 400ms the draft's autosave settles on.
 */
export const DRAFT_SETTLE_MS = 400;

/**
 * `value`, once it has held still for `ms`.
 *
 * Identity is what settles, so a caller passing a derived array memoises it.
 * It holds the last value across anything short of a remount, so a caller whose
 * subject can change under it — a project — keys the component on that subject.
 */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** A change's dot: green adds to the contract, red narrows it. */
function ChangeDot({ change }: { readonly change: SchemaChange }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-1.5 size-1.5 shrink-0 rounded-full",
        change.kind === "destructive" ? "bg-destructive" : "bg-success",
      )}
    />
  );
}

/**
 * What one diff says, one line per change. `detail` is verbatim: it is the
 * string the kernel's refusals are built from, so a line here and the sentence
 * in a 409 are the same sentence.
 *
 * `limit` keeps a long diff to a summary — the rest is counted, not dropped
 * silently.
 */
export function ChangeList({
  changes,
  limit,
  "data-testid": testId,
}: {
  readonly changes: readonly SchemaChange[];
  readonly limit?: number;
  readonly "data-testid"?: string;
}): JSX.Element {
  const shown = limit === undefined ? changes : changes.slice(0, limit);
  const more = changes.length - shown.length;
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid={testId}>
        {shown.map((change) => (
          <li key={`${change.kind}:${change.label_class}:${change.detail}`} className="flex gap-2" data-kind={change.kind}>
            <ChangeDot change={change} />
            <span className="min-w-0 text-pretty">
              {change.detail}
              {/* The colour is not the only cue: a narrowing says so in words. */}
              {change.kind === "destructive" && <span className="sr-only"> (narrows the schema)</span>}
            </span>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <p className="pl-3.5 text-xs text-muted-foreground tabular-nums">
          and {formatCount(more)} more
        </p>
      )}
    </div>
  );
}

/**
 * How many blocking frames the dialog shows before it says how many more.
 *
 * The route's limit defaults to everything, and `AssetThumbnail` fetches on
 * mount — so an unwindowed page for a narrowing that orphans five thousand
 * frames is five thousand credentialed requests at once.
 */
const BLOCKING_ASSET_WINDOW = 12;

/**
 * The frames a proposal would orphan, each with every batch that holds it.
 *
 * **A frame links to every batch holding it, never to one.** An annotation
 * carries an `asset_id` and nothing else — no batch, no job — so a blocking
 * annotation has no single annotator address. A frame in three batches offers
 * three links; a frame in none offers none rather than a guess.
 *
 * Only rendered for a host that can open a batch: a list whose every link leads
 * nowhere reads as broken.
 */
export function BlockingFrames({
  projectId,
  classes,
  onOpenBatch,
}: {
  readonly projectId: string;
  readonly classes: readonly LabelClassBody[];
  readonly onOpenBatch: (batchId: string) => void;
}): JSX.Element {
  const query = useSchemaBlockingAssets(projectId, classes, BLOCKING_ASSET_WINDOW);
  // Three links all reading "Open batch" would name no destination between them.
  const batches = useBatches(projectId);
  const names = new Map((batches.data?.items ?? []).map((batch) => [batch.id, batch.name]));
  return (
    <div className="flex flex-col gap-2" data-testid="blocking-assets">
      <Async
        query={query}
        loadingRows={2}
        empty={{
          size: "compact",
          icon: <Check className="size-7" strokeWidth={1.5} />,
          title: "Nothing is in the way any more",
          description: "No frame carries a label this draft would drop.",
        }}
      >
        {(page) => (
          <>
            {/* `total` is every blocking frame, never this page's size. There is
                no "see all" route, so the remainder is text, not a control. */}
            <p className="text-xs text-muted-foreground" data-testid="blocking-asset-count">
              <span className="tabular-nums">{formatCount(page.total)}</span>{" "}
              {page.total === 1 ? "frame is" : "frames are"} in the way
              {page.total > page.items.length ? `, showing the first ${formatCount(page.items.length)}` : ""}.
            </p>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3" data-testid="blocking-asset-list">
              {page.items.map((item) => (
                <li key={item.asset.id} className="flex min-w-0 flex-col gap-1">
                  {/* A faint inner edge, pure black or white, so a dark frame
                      keeps its corners against the dialog. */}
                  <span className="vs-image-outline block aspect-video overflow-hidden rounded-md bg-stage">
                    <AssetThumbnail
                      projectId={projectId}
                      assetId={item.asset.id}
                      thumbnailHash={item.asset.thumbnail_hash}
                      alt=""
                      className="size-full object-cover"
                    />
                  </span>
                  {/* Named, because two tiles reading "12 labels" are one tile to
                      a screen reader. A still has no `frame_index` and falls back
                      to the short id the API's own errors quote. */}
                  <span className="truncate text-[11px]">
                    <span className="font-medium">Frame {item.asset.frame_index ?? item.asset.id.slice(0, 8)}</span>
                    {" · "}
                    <span className="tabular-nums">{formatCount(item.annotations)}</span>{" "}
                    {item.annotations === 1 ? "label" : "labels"} under {item.label_classes.join(", ")}
                  </span>
                  <span className="flex flex-wrap gap-x-2">
                    {item.batch_ids.map((batchId) => (
                      <Button
                        key={batchId}
                        variant="link"
                        className="h-auto max-w-full truncate p-0 text-[11px]"
                        data-testid="blocking-asset-batch"
                        onClick={() => onOpenBatch(batchId)}
                      >
                        Open {names.get(batchId) ?? "batch"}
                      </Button>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Async>
    </div>
  );
}
