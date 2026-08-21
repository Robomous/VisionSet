/**
 * The Batches tab's project-wide launch. The batch stays the unit on the wire
 * — the route fans out one `annotation.pre_label` row per checked batch — so
 * this dialog's whole job is choosing the batches and the settings, then
 * saying which rows were queued and which joined a run already in flight.
 * Gated on `pre_label` in some batch's own `allowed_actions`, never on state
 * read here.
 */

import { Sparkles } from "lucide-react";
import { useMemo, useState, type JSX } from "react";

import { BATCH_ACTION, declares } from "../data/capabilities";
import { useConnections, type Connection } from "../data/inferenceQueries";
import { refusalProse } from "../data/refusals";
import { Alert } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../primitives/Dialog";
import { Label } from "../primitives/Input";
import { DEFAULT_CONFIDENCE, PreLabelSettings, TEXT_DETECT } from "./PreLabelDialog";
import { usePreLabelProject, type Batch, type ProjectPreLabelOut } from "./queries";

export interface ProjectPreLabelButtonProps {
  readonly projectId: string;
  readonly batches: readonly Batch[];
  readonly onOpenBatch: (batchId: string) => void;
}

export function ProjectPreLabelButton({
  projectId,
  batches,
  onOpenBatch,
}: ProjectPreLabelButtonProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const eligible = useMemo(
    () => batches.filter((one) => declares(one, BATCH_ACTION.preLabel)),
    [batches],
  );
  if (eligible.length === 0) return null;

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        data-testid="project-prelabel"
        onClick={() => setOpen(true)}
      >
        <Sparkles className="size-4" aria-hidden="true" />
        Pre-label
      </Button>
      {open && (
        <ProjectPreLabelDialog
          projectId={projectId}
          batches={eligible}
          onClose={() => setOpen(false)}
          onOpenBatch={onOpenBatch}
        />
      )}
    </>
  );
}

function ProjectPreLabelDialog({
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
  // Checked where there is something to reach: a batch nothing is untouched in
  // would contribute a guaranteed no-op run, which is the gallery dialog's
  // `blocked` reasoning applied one row at a time.
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(batches.filter((one) => one.progress.unannotated > 0).map((one) => one.id)),
  );
  const [result, setResult] = useState<ProjectPreLabelOut | null>(null);
  const launch = usePreLabelProject(projectId);
  const active = candidates.find((row) => row.id === connectionId) ?? candidates[0];
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
    active !== undefined && validConfidence && checked.size > 0 && !launch.isPending;

  function toggle(id: string): void {
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function start(): void {
    if (active === undefined) return;
    launch.mutate(
      {
        connectionId: active.id,
        minimumConfidence: confidenceValue,
        batchIds: batches.filter((one) => checked.has(one.id)).map((one) => one.id),
      },
      { onSuccess: setResult },
    );
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="project-prelabel-dialog">
        <DialogTitle>Pre-label open batches</DialogTitle>
        <DialogDescription>
          One run per batch, over every asset nothing has touched yet. What a run finds lands{" "}
          <strong>pre-labeled and editable</strong> in that batch, never as somebody&rsquo;s own
          annotation.
        </DialogDescription>

        {result === null ? (
          <div className="flex flex-col gap-3">
            <PreLabelSettings
              candidates={candidates}
              activeId={active?.id ?? ""}
              onConnectionChange={setConnectionId}
              confidence={confidence}
              onConfidenceChange={setConfidence}
              disabled={launch.isPending}
            />

            <fieldset className="flex flex-col gap-1.5">
              <Label asChild>
                <legend>Batches</legend>
              </Label>
              {batches.map((one) => (
                <label key={one.id} className="flex items-center gap-2 text-sm">
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
              ))}
            </fieldset>

            {launch.isError && (
              <Alert variant="destructive" data-testid="project-prelabel-error">
                {refusalProse(launch.error)}
              </Alert>
            )}
          </div>
        ) : (
          <ul className="flex flex-col gap-1 text-sm" data-testid="project-prelabel-result">
            {result.items.map((item) => (
              <li key={item.batch_id} className="flex items-center justify-between gap-2">
                <Button
                  variant="link"
                  className="h-auto p-0"
                  onClick={() => onOpenBatch(item.batch_id)}
                >
                  {item.batch_name}
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
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                data-testid="project-prelabel-start"
                disabled={!canStart}
                onClick={start}
              >
                {launch.isPending ? "Labeling…" : "Start"}
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
