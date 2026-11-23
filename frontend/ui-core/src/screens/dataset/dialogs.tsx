/**
 * The Dataset section's two dialogs, carried over as they were: taking an
 * image out of the trunk, and publishing a release.
 */

import { Upload } from "lucide-react";
import { useState, type FormEvent, type JSX } from "react";

import { asApiError } from "../../data/errors";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, FieldDescription, FieldError, Input, Label } from "@robomous/ui-core";
import { classBlockers, describeClassCount, refusalProse } from "../../data/refusals";
import { trunkAssetLabel } from "../datasetAsset";
import { usePublishRelease, useRemoveDatasetAsset, type DatasetAsset } from "../queries";

/** The 409 that names classes: the active schema no longer describes some of the trunk. */
const CONTENT_VIOLATES_SCHEMA = "RELEASE_CONTENT_WOULD_VIOLATE_SCHEMA";

/**
 * Curation, and a confirmation that says what it actually costs.
 *
 * `DESIGN.md`: a confirmation names what will happen. Here the useful half of
 * that is mostly what will **not** happen, and every clause below was read off
 * `DatasetService.remove_asset` rather than assumed:
 *
 * - the asset, its annotations and its bytes all stay — content is hash-addressed
 *   and shared, so no dataset can know it is the last owner, and `BlobStore` has
 *   no `delete` at all;
 * - **a release that already names the asset is untouched**, because a release is
 *   a snapshot and curating the trunk afterwards does not reach back into it;
 * - promotion is a *union* with no memory of removals, so re-promoting the batch
 *   the asset came from puts it back.
 *
 * Which is exactly why the kernel gives this no `confirm=` gate — it is one of
 * only two service methods without one. The dialog is here because taking an
 * asset out of a release-bound dataset is still a decision, not because the
 * kernel demands consent for it, and the copy has to be honest about that
 * difference or it teaches the wrong thing about what removal means.
 */
export function RemoveAssetDialog({
  datasetId,
  asset,
  onClose,
  onRemoved,
}: {
  readonly datasetId: string;
  readonly asset: DatasetAsset;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}): JSX.Element {
  const remove = useRemoveDatasetAsset(datasetId);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="remove-asset-dialog">
        <DialogTitle>Remove {trunkAssetLabel(asset)} from the dataset?</DialogTitle>
        <DialogDescription data-testid="remove-asset-consequence">
          This removes the image from the dataset, together with its annotations. The image itself
          is not deleted: the file, its annotations and its stored data remain in the project, and
          any release already published is unaffected. Promoting the batch again will restore it to
          the dataset.
        </DialogDescription>
        {remove.isError && (
          <FieldError data-testid="remove-asset-error">{refusalProse(remove.error)}</FieldError>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="remove-asset-submit"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(asset.id, {
                onSuccess: () => {
                  onRemoved();
                  onClose();
                },
              })
            }
          >
            {remove.isPending ? "Removing…" : "Remove from dataset"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


export function PublishDialog({
  datasetId,
  open,
  onClose,
}: {
  readonly datasetId: string;
  readonly open: boolean;
  readonly onClose: () => void;
}): JSX.Element {
  const publish = usePublishRelease(datasetId);
  const [tag, setTag] = useState("");
  const [split, setSplit] = useState(false);
  const [fractions, setFractions] = useState({ train: "0.7", val: "0.15", test: "0.15" });
  const [seed, setSeed] = useState("0");

  const sum = Number(fractions.train) + Number(fractions.val) + Number(fractions.test);
  // The kernel compares with `math.isclose(..., abs_tol=1e-9)` because
  // `0.7 + 0.15 + 0.15 != 1.0` in binary floating point. Mirrored rather than
  // restated: a stricter check here would refuse a recipe the API accepts.
  const balanced = Math.abs(sum - 1) < 1e-9;
  const failure = publish.isError ? asApiError(publish.error) : null;
  const blockers =
    failure?.code === CONTENT_VIOLATES_SCHEMA ? classBlockers(failure.detail) : null;

  function submit(event: FormEvent): void {
    event.preventDefault();
    publish.mutate(
      {
        tag: tag.trim(),
        ...(split
          ? {
              split: {
                train: Number(fractions.train),
                val: Number(fractions.val),
                test: Number(fractions.test),
                seed: Number(seed),
              },
            }
          : {}),
      },
      {
        onSuccess: () => {
          setTag("");
          onClose();
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent data-testid="publish-dialog">
        <DialogTitle>Publish a release</DialogTitle>
        <DialogDescription>
          Freezes the dataset as it is now. The manifest is a pure function of content, so
          publishing an unchanged dataset twice produces byte-identical documents.
        </DialogDescription>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="release-tag">Tag</Label>
            <Input
              id="release-tag"
              data-testid="release-tag"
              value={tag}
              onChange={(event) => setTag(event.target.value)}
              placeholder="v1"
              autoFocus
            />
            {/* The opposite of a project name, which is unique case-insensitively.
                Two rules, each beside its own index. */}
            <FieldDescription>Unique per dataset, and case-sensitive.</FieldDescription>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-primary"
              data-testid="use-split"
              checked={split}
              onChange={(event) => setSplit(event.target.checked)}
            />
            Assign train / val / test folds
          </label>

          {split && (
            <div className="grid grid-cols-4 gap-2">
              {(["train", "val", "test"] as const).map((fold) => (
                <div key={fold} className="flex flex-col gap-1">
                  <Label htmlFor={`fraction-${fold}`} className="text-xs">
                    {fold}
                  </Label>
                  <Input
                    id={`fraction-${fold}`}
                    data-testid={`fraction-${fold}`}
                    type="number"
                    step="0.05"
                    min="0"
                    max="1"
                    value={fractions[fold]}
                    onChange={(event) =>
                      setFractions((current) => ({ ...current, [fold]: event.target.value }))
                    }
                  />
                </div>
              ))}
              <div className="flex flex-col gap-1">
                <Label htmlFor="split-seed" className="text-xs">
                  seed
                </Label>
                <Input
                  id="split-seed"
                  data-testid="split-seed"
                  type="number"
                  value={seed}
                  onChange={(event) => setSeed(event.target.value)}
                />
              </div>
              <p className="col-span-4 text-xs text-muted-foreground" data-testid="split-hint">
                {balanced
                  ? "The split keys on each asset's content hash, so the same seed gives the same folds on every machine."
                  : `Fractions must sum to 1 — they sum to ${sum.toFixed(2)}.`}
              </p>
            </div>
          )}

          {publish.isError && (
            <FieldError data-testid="publish-error">
              {refusalProse(publish.error)}
            </FieldError>
          )}
          {blockers !== null && (
            <div className="flex flex-col gap-1 text-sm" data-testid="publish-blockers">
              <ul className="list-disc pl-5">
                {blockers.map((blocker) => (
                  <li key={blocker.label_class}>{describeClassCount(blocker)}</li>
                ))}
              </ul>
              <p className="text-muted-foreground" data-testid="publish-remedy">
                Correct those labels in a new batch, remove the frames from the dataset, or
                publish a schema version that describes the classes again — then publish.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              data-testid="publish-submit"
              disabled={tag.trim() === "" || publish.isPending || (split && !balanced)}
            >
              <Upload className="size-4" aria-hidden="true" />
              {publish.isPending ? "Publishing…" : "Publish"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

