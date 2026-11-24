/**
 * Where the images land: a new batch, or one of the project's drafts.
 *
 * The offer is the project's draft batches — the batches a person thinks of as
 * still open — and which of them may take more is read off the wire: only a
 * batch declaring `edit_membership` can, and anything else is refused at the
 * launch with 409 `BATCH_NOT_EDITABLE`. So a draft that does not declare it is
 * listed and withheld, with its reason, rather than offered as a refusal
 * (`ui-capabilities`: disabled with a reason over hidden), and nothing here
 * decides legality from `state`. A batch the kernel lets grow is offered
 * whatever its state says.
 */

import { useId, type JSX } from "react";

import { Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@robomous/ui-core";
import { formatCount } from "../../lib/format";
import { NEW_BATCH, useDraftTargets, type Target } from "./intoTarget";

export function IntoField({
  projectId,
  target,
  onTarget,
  suggestion,
  noun,
}: {
  readonly projectId: string;
  readonly target: Target;
  readonly onTarget: (target: Target) => void;
  /** The new batch's name when nobody types one — the source's or the clip's. */
  readonly suggestion: string;
  /** What lands, for the field's description: `images`, `frames`, `scans`. */
  readonly noun: string;
}): JSX.Element {
  const drafts = useDraftTargets(projectId);
  const selectId = useId();
  const nameId = useId();
  const isNew = target.choice === NEW_BATCH;
  return (
    <section className="flex flex-col gap-2" aria-labelledby={selectId + "-label"}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label id={selectId + "-label"} htmlFor={selectId}>
            Into
          </Label>
          <Select value={target.choice} onValueChange={(choice) => onTarget({ ...target, choice })}>
            <SelectTrigger id={selectId} data-testid="target-batch" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEW_BATCH}>New batch</SelectItem>
              {drafts.map(({ batch, open }) => (
                <SelectItem key={batch.id} value={batch.id} disabled={!open} data-testid={`target-${batch.id}`}>
                  <span className="tabular-nums">
                    {batch.name} ({formatCount(batch.asset_count)})
                  </span>
                  {!open && <span className="text-muted-foreground"> · not taking {noun} now</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {isNew && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>Batch name</Label>
            <Input
              id={nameId}
              data-testid="batch-name"
              value={target.name}
              placeholder={suggestion}
              onChange={(event) => onTarget({ ...target, name: event.target.value })}
            />
          </div>
        )}
      </div>
      <p className="text-xs text-pretty text-muted-foreground">
        {isNew
          ? `A new draft batch, named ${suggestion === "" ? "after the source" : `“${suggestion}”`} unless you name it.`
          : `Only a draft batch can take new ${noun}.`}
      </p>
    </section>
  );
}
