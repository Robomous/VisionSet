/**
 * Auto-label: the Overview's project-wide launch (its line over the Batches
 * table, or its icon in the band — `AutoLabel.tsx`), and its one-batch form
 * from a batch's row menu and panel. The person's word is *auto-label*; the
 * wire's is `pre_label`, and labels a run writes land `pre_labeled`.
 *
 * The batch stays the unit on the wire — the route fans out one `annotation.pre_label` row per checked batch — so
 * this dialog's whole job is choosing the batches and the settings, then
 * saying which rows were queued and which joined a run already in flight.
 * Gated on `pre_label` in some batch's own `allowed_actions`, never on state
 * read here.
 *
 * Each batch row carries its own plan — what a run under this model and this
 * shape selection would ask for against *that* batch's pin, and what it would
 * leave out — read per row because two open batches can pin two versions. A
 * checked row whose plan is refused keeps the launch off the table, on the
 * per-job dialog's reasoning: the launch refuses whole on the same gate, so
 * pressing Start could only reproduce the refusal the row already shows.
 */

import { useState, type JSX } from "react";

import { useConnections, type Connection } from "../data/inferenceQueries";
import { refusalProse } from "../data/refusals";
import { formatCount } from "../lib/format";
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Label, FieldError } from "@robomous/ui-core";
import {
  DEFAULT_CONFIDENCE,
  PreLabelSettings,
  PromptClasses,
  TEXT_DETECT,
} from "./PreLabelDialog";
import { NO_SHAPES, selectedShapes } from "./preLabelShapes";
import {
  usePreLabelPlans,
  usePreLabelProject,
  type Batch,
  type GeometryType,
  type PreLabelFanOutOut,
} from "./queries";

/**
 * One row per job. A batch that fanned out to several jobs would otherwise
 * repeat its name over indistinguishable rows, so a row past the first for
 * that batch is suffixed by its 1-based position among them.
 */
function resultRows(
  items: PreLabelFanOutOut["items"],
): readonly { item: PreLabelFanOutOut["items"][number]; label: string }[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.batch_id, (counts.get(item.batch_id) ?? 0) + 1);
  const seen = new Map<string, number>();
  return items.map((item) => {
    const position = (seen.get(item.batch_id) ?? 0) + 1;
    seen.set(item.batch_id, position);
    const label =
      (counts.get(item.batch_id) ?? 0) > 1 ? `${item.batch_name} · job ${position}` : item.batch_name;
    return { item, label };
  });
}

/**
 * The dialog, for a host that opens it from its own control — the Overview's
 * offer over every batch that declares the run, a batch's row menu and panel
 * over that one. Handed one batch, it is titled for that batch; the checklist,
 * gating and refusals are the same.
 */
export function ProjectPreLabelDialog({
  projectId,
  batches,
  onClose,
  onOpenBatch,
}: {
  readonly projectId: string;
  readonly batches: readonly Batch[];
  readonly onClose: () => void;
  readonly onOpenBatch: (batchId: string) => void;
}): JSX.Element {
  const connections = useConnections(true);
  const candidates: readonly Connection[] = (connections.data?.items ?? []).filter((row) =>
    row.capabilities.includes(TEXT_DETECT),
  );
  const [connectionId, setConnectionId] = useState("");
  const [confidence, setConfidence] = useState(DEFAULT_CONFIDENCE);
  const [unticked, setUnticked] = useState<ReadonlySet<GeometryType>>(NO_SHAPES);
  // Checked where there is something to reach: a batch nothing is untouched in
  // would contribute a guaranteed no-op run, which is the per-job dialog's
  // `blocked` reasoning applied one row at a time.
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(batches.filter((one) => one.progress.unannotated > 0).map((one) => one.id)),
  );
  const [result, setResult] = useState<PreLabelFanOutOut | null>(null);
  const launch = usePreLabelProject(projectId);
  const active = candidates.find((row) => row.id === connectionId) ?? candidates[0];
  const shapes = active?.produces ?? [];
  const selection = selectedShapes(shapes, unticked);
  const noShape = selection !== null && selection.length === 0;
  const plans = usePreLabelPlans(batches, active?.id, result === null && !noShape, selection);
  // What Start will reach: the untouched images of the checked batches.
  const checkedImages = batches.reduce((sum, one) => sum + (checked.has(one.id) ? one.progress.unannotated : 0), 0);
  const refused = batches.filter((one, index) => checked.has(one.id) && plans[index]?.isError);
  const confidenceValue = Number(confidence);
  // `confidence.trim() !== ""` first, on `PreLabelDialog`'s reasoning: `Number("")`
  // is `0`, inside the valid range, so an emptied field would otherwise post a
  // floor that writes every region the model returns.
  const validConfidence =
    confidence.trim() !== "" &&
    Number.isFinite(confidenceValue) &&
    confidenceValue >= 0 &&
    confidenceValue <= 1;
  const canStart =
    active !== undefined &&
    validConfidence &&
    checked.size > 0 &&
    !noShape &&
    refused.length === 0 &&
    !launch.isPending;

  function toggle(id: string): void {
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleShape(shape: GeometryType): void {
    setUnticked((previous) => {
      const next = new Set(previous);
      if (next.has(shape)) next.delete(shape);
      else next.add(shape);
      return next;
    });
  }

  function chooseConnection(id: string): void {
    setConnectionId(id);
    setUnticked(NO_SHAPES);
  }

  function start(): void {
    if (active === undefined) return;
    launch.mutate(
      {
        connectionId: active.id,
        minimumConfidence: confidenceValue,
        batchIds: batches.filter((one) => checked.has(one.id)).map((one) => one.id),
        geometries: selection,
      },
      { onSuccess: setResult },
    );
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="project-prelabel-dialog">
        <DialogTitle>{batches.length === 1 && batches[0] !== undefined ? `Auto-label ${batches[0].name}` : "Auto-label batches"}</DialogTitle>
        <DialogDescription>
          A model draws boxes on every image nothing has touched yet, one run per batch. What it finds
          lands <strong>pre-labeled and editable</strong> for someone to check, never as somebody&rsquo;s
          own annotation.
        </DialogDescription>

        {result === null ? (
          <div className="flex flex-col gap-3">
            <PreLabelSettings
              candidates={candidates}
              activeId={active?.id ?? ""}
              onConnectionChange={chooseConnection}
              confidence={confidence}
              onConfidenceChange={setConfidence}
              shapes={shapes}
              unticked={unticked}
              onToggleShape={toggleShape}
              disabled={launch.isPending}
            />

            <fieldset className="flex flex-col gap-2">
              <Label asChild>
                <legend>Batches</legend>
              </Label>
              {batches.map((one, index) => {
                const plan = plans[index];
                return (
                  <div key={one.id} className="flex flex-col gap-1">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        data-testid={`prelabel-pick-${one.id}`}
                        checked={checked.has(one.id)}
                        disabled={launch.isPending}
                        onChange={() => toggle(one.id)}
                      />
                      <span>{one.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {one.progress.unannotated} untouched
                      </span>
                    </label>
                    {/* Indented under the row it is about, so two batches with
                        two pins read as two plans and not one. */}
                    <div className="pl-6">
                      <PromptClasses plan={plan?.data ?? null} />
                      {plan?.isError && (
                        <FieldError data-testid="prelabel-plan-error">
                          {refusalProse(plan.error)}
                        </FieldError>
                      )}
                    </div>
                  </div>
                );
              })}
            </fieldset>

            {refused.length > 0 && (
              <Alert data-testid="project-prelabel-blocked">
                <AlertDescription>
                {refused.length === 1
                  ? `${refused[0]!.name} cannot be auto-labeled as planned — uncheck it, or change the model or the shapes, to start.`
                  : `${refused.map((one) => one.name).join(", ")} cannot be auto-labeled as planned — uncheck them, or change the model or the shapes, to start.`}
                </AlertDescription>
              </Alert>
            )}

            {launch.isError && (
              <Alert variant="destructive" data-testid="project-prelabel-error">
                <AlertDescription>{refusalProse(launch.error)}</AlertDescription>
              </Alert>
            )}
          </div>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" data-testid="project-prelabel-result">
            {resultRows(result.items).map(({ item, label }) => (
              <li key={item.annotation_job_id} className="flex items-center justify-between gap-2">
                <Button
                  variant="link"
                  className="h-auto p-0"
                  onClick={() => onOpenBatch(item.batch_id)}
                >
                  {label}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {item.joined ? "already running — joined" : "queued"}
                </span>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          {result === null ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="default"
                data-testid="project-prelabel-start"
                disabled={!canStart}
                onClick={start}
              >
                {launch.isPending ? "Starting…" : checkedImages > 0 ? `Auto-label · ${formatCount(checkedImages)} ${checkedImages === 1 ? "image" : "images"}` : "Auto-label"}
              </Button>
            </>
          ) : (
            <Button variant="default" onClick={onClose}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
