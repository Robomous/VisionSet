/**
 * Images: pick files, register a source, launch a run, watch it finish.
 *
 * This is the path the server reads. It was the whole of `IngestScreen` until a
 * clip stopped being something the server can decode, and it is unchanged by that
 * split — the reasoning below is the reasoning it already had.
 *
 * ## One step is active at a time
 *
 * The flow is a vertical stepper: three steps always visible, exactly one
 * active. Which one is **derived** from the data — a run in flight is step 3, a
 * registered source is step 2, otherwise step 1 — never stored, so it cannot
 * disagree with the flow. A completed step collapses to a one-line summary of
 * what was decided and keeps **no live controls**, which also closes a real
 * hole: the old layout left step 1's dropzone active under an open step 2, so a
 * user could swap the files while the source card still described the old
 * ones, and nothing handled that. An upcoming step shows its number and one
 * line of what it will ask — the road ahead is what makes three cards read as
 * one workflow instead of appearing from nowhere.
 *
 * Steps 2 and 3 — configuring and watching the run — live in `IngestRunSteps`,
 * which owns the reasoning behind them.
 */

import { Image } from "lucide-react";
import { useState, type FormEvent, type JSX } from "react";

import { refusalProse } from "../data/refusals";
import { Button, Card, CardContent, Input, Label, FieldDescription, FieldError } from "@robomous/ui-core";
import { formatBytes, formatCount } from "../lib/format";
import { IngestRunSteps } from "./IngestRunSteps";
import { ClearSelection, Dropzone, Step } from "./ingestSteps";
import { useRegisterSource, type Source } from "./queries";

export interface ImageIngestFlowProps {
  readonly projectId: string;
  readonly files: readonly File[];
  readonly onFiles: (files: readonly File[]) => void;
  /** Empty the selection and remount the dropzone. The screen owns both. */
  readonly onClearFiles: () => void;
  readonly dropzonePrompt: string;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly onOpenSchema?: () => void;
}

export function ImageIngestFlow({
  projectId,
  files,
  onFiles,
  onClearFiles,
  dropzonePrompt,
  onOpenBatch,
  onOpenSchema,
}: ImageIngestFlowProps): JSX.Element {
  // What to call the source. Empty means "use the suggestion".
  const [sourceName, setSourceName] = useState("");
  const [source, setSource] = useState<Source | null>(null);

  const register = useRegisterSource(projectId);

  // What the source is called unless the user types otherwise.
  // Without a stated name the server calls the source by its staged directory,
  // whose basename is a content digest — 64 hex characters that then become the
  // default batch name too. The first file's stem is deterministic, editable
  // right there, and honest: it names what was actually picked.
  const suggestedName = files.length > 0 ? stem(files[0].name) : "";

  const canRegister = files.length > 0 && !register.isPending;

  function upload(event: FormEvent): void {
    event.preventDefault();
    if (!canRegister) return;
    // Blank falls back to the suggestion the placeholder shows — the batch-name pattern.
    const stated = (sourceName.trim() === "" ? suggestedName : sourceName.trim()).trim();
    register.mutate(
      { files, ...(stated === "" ? {} : { name: stated }) },
      { onSuccess: (registered) => setSource(registered) },
    );
  }

  /**
   * Empty the selection without touching anything downstream — there is nothing
   * downstream yet, since this control only exists while step 1 is active.
   */
  function clearFiles(): void {
    setSourceName("");
    onClearFiles();
    register.reset();
  }

  /**
   * Back to a clean form — the whole of "ingest a second source without a reload".
   *
   * Every piece of the flow is cleared, including both mutations: a stale
   * `register.isError` left behind would sit above an empty dropzone as a
   * refusal of files nobody has chosen yet. The run itself is untouched — it is
   * a row on the server and this is a form, so starting over here neither
   * cancels nor forgets what was ingested.
   */
  function again(): void {
    setSourceName("");
    setSource(null);
    onClearFiles();
    register.reset();
  }

  const chosenLabel = files.length === 1 ? files[0].name : `${files.length} files`;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <ol className="flex flex-col">
      <Step
        index={1}
        title="Choose files"
        testId="step-1"
        state={source === null ? "active" : "complete"}
        summary={`${chosenLabel} · ${formatBytes(totalBytes)}`}
      >
        <Card className="mt-2">
          <CardContent className="pt-4">
            <form className="flex flex-col gap-4" onSubmit={upload}>
              <Dropzone onFiles={onFiles} prompt={dropzonePrompt} />

              {files.length > 0 && (
                <SelectionPanel
                  files={files}
                  sourceName={sourceName}
                  onSourceName={setSourceName}
                  suggestedName={suggestedName}
                  onClear={clearFiles}
                />
              )}

              {register.isError && (
                <FieldError data-testid="register-error">
                  {refusalProse(register.error)}
                </FieldError>
              )}

              <div className="flex justify-end">
                <Button
                  type="submit"
                  variant="default"
                  data-testid="register-source"
                  // Explained by adjacency (`DESIGN.md` principle 9): with no
                  // files the dropzone above says what to do.
                  disabled={!canRegister}
                >
                  {register.isPending ? "Uploading…" : "Register source"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </Step>

      <IngestRunSteps
        projectId={projectId}
        source={source}
        onChangeFiles={again}
        onIngestAnother={again}
        {...(onOpenBatch === undefined ? {} : { onOpenBatch })}
        {...(onOpenSchema === undefined ? {} : { onOpenSchema })}
      />
    </ol>
  );
}

/**
 * The selection, read back before anything uploads.
 */
function SelectionPanel({
  files,
  sourceName,
  onSourceName,
  suggestedName,
  onClear,
}: {
  readonly files: readonly File[];
  readonly sourceName: string;
  readonly onSourceName: (value: string) => void;
  readonly suggestedName: string;
  readonly onClear: () => void;
}): JSX.Element {
  const kind = files.length === 1 ? "image" : "images";
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <div className="flex flex-col rounded-lg border border-border" data-testid="selection">
      <div className="flex items-center gap-3 p-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
          <Image className="size-4 text-muted-foreground" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" data-testid="chosen">
            {files.length === 1 ? files[0].name : `${files.length} files`}
          </p>
          <p className="text-xs text-muted-foreground">
            {kind} · {formatBytes(totalBytes)}
          </p>
          {/* A bunch reads back its *contents*, not only its count — the first
              few names are what let somebody catch "that is the wrong folder"
              before a single byte uploads. Three, because the point is
              recognition, not inventory; the batch says the rest. */}
          {files.length > 1 && (
            <p className="truncate text-xs text-muted-foreground" data-testid="selection-names">
              {files
                .slice(0, 3)
                .map((file) => file.name)
                .join(" · ")}
              {files.length > 3 && ` · +${formatCount(files.length - 3)} more`}
            </p>
          )}
        </div>
        <ClearSelection onClear={onClear} />
      </div>

      <div className="border-t border-border p-3">
        <div className="flex max-w-sm flex-col gap-1.5">
          <Label htmlFor="source-name">Source name</Label>
          <Input
            id="source-name"
            data-testid="source-name"
            value={sourceName}
            placeholder={suggestedName}
            onChange={(event) => onSourceName(event.target.value)}
          />
          <FieldDescription>
            Names the source — and the new batch inherits it. Without one the server calls
            both by the upload&apos;s content digest.
          </FieldDescription>
        </div>
      </div>
    </div>
  );
}

/** The filename without its last extension: `photo-0.png` → `photo-0`. */
function stem(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}
