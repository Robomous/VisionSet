/**
 * Point-cloud scans: pick `.pcd`/`.ply` files, state their frame, register a
 * source, then the same run steps the image flow uses.
 *
 * The frame has no default: the server cannot read it from the bytes, and a
 * wrong guess is a dataset silently drawn in the wrong axes.
 */

import { Box } from "lucide-react";
import { useState, type FormEvent, type JSX } from "react";

import { Button, Card, CardContent, FieldDescription, FieldError, Input, Label } from "@robomous/ui-core";
import type { components } from "../generated/api";
import { refusalProse } from "../data/refusals";
import { formatBytes } from "../lib/format";
import { IngestRunSteps } from "./IngestRunSteps";
import { ClearSelection, Dropzone, Step } from "./ingestSteps";
import { SCAN_FRAMES } from "./scanFiles";
import { useRegisterPointCloudSource, type Source } from "./queries";

type ScanFrame = components["schemas"]["ScanFrame"];

export interface PointCloudIngestFlowProps {
  readonly projectId: string;
  readonly files: readonly File[];
  readonly onFiles: (files: readonly File[]) => void;
  readonly onClearFiles: () => void;
  readonly onOpenBatch?: (batchId: string) => void;
  readonly onOpenSchema?: () => void;
}

export function PointCloudIngestFlow({
  projectId,
  files,
  onFiles,
  onClearFiles,
  onOpenBatch,
  onOpenSchema,
}: PointCloudIngestFlowProps): JSX.Element {
  const [sourceName, setSourceName] = useState("");
  const [frame, setFrame] = useState<ScanFrame | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [chosen, setChosen] = useState(files);
  const register = useRegisterPointCloudSource(projectId);

  // A new selection is a new question: the frame stated for the old one does not carry over.
  if (chosen !== files) {
    setChosen(files);
    setFrame(null);
  }

  const suggestedName = files.length > 0 ? files[0].name.replace(/\.[^.]+$/, "") : "";
  const canRegister = files.length > 0 && frame !== null && !register.isPending;

  function upload(event: FormEvent): void {
    event.preventDefault();
    if (!canRegister) return;
    const stated = sourceName.trim() === "" ? suggestedName : sourceName.trim();
    register.mutate(
      { files, frame, ...(stated === "" ? {} : { name: stated }) },
      { onSuccess: (registered) => setSource(registered) },
    );
  }

  function again(): void {
    setSourceName("");
    setFrame(null);
    setSource(null);
    onClearFiles();
    register.reset();
  }

  const chosenLabel = files.length === 1 ? files[0].name : `${files.length} files`;
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  return (
    <ol className="flex flex-col" data-testid="point-cloud-flow">
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
              <Dropzone
                onFiles={(dropped) => {
                  register.reset();
                  onFiles(dropped);
                }}
                prompt="Drop point clouds here"
                note="Each file's format is read from its header at ingest, and a file that is not a scan is reported then."
              />

              {files.length > 0 && (
                <div className="flex flex-col rounded-lg border border-border" data-testid="selection">
                  <div className="flex items-center gap-3 p-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                      <Box className="size-4 text-muted-foreground" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" data-testid="chosen">
                        {chosenLabel}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {files.length === 1 ? "point cloud" : "point clouds"} · {formatBytes(totalBytes)}
                      </p>
                    </div>
                    <ClearSelection onClear={again} />
                  </div>

                  <div className="border-t border-border p-3">
                    <fieldset className="flex flex-col gap-1.5" data-testid="scan-frame">
                      <legend className="mb-1.5 text-sm font-medium">Frame</legend>
                      {SCAN_FRAMES.map((option) => (
                        <label key={option.value} className="flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name="scan-frame"
                            value={option.value}
                            checked={frame === option.value}
                            onChange={() => setFrame(option.value)}
                          />
                          {option.label}
                          <span className="text-xs text-muted-foreground">{option.axes}</span>
                        </label>
                      ))}
                      <FieldDescription>
                        The axes the scans were recorded in. Required — it cannot be read from the
                        files.
                      </FieldDescription>
                    </fieldset>
                  </div>

                  <div className="border-t border-border p-3">
                    <div className="flex max-w-sm flex-col gap-1.5">
                      <Label htmlFor="source-name">Source name</Label>
                      <Input
                        id="source-name"
                        data-testid="source-name"
                        value={sourceName}
                        placeholder={suggestedName}
                        onChange={(event) => setSourceName(event.target.value)}
                      />
                      <FieldDescription>
                        Names the source — and the new batch inherits it.
                      </FieldDescription>
                    </div>
                  </div>
                </div>
              )}

              {register.isError && (
                <FieldError data-testid="register-error">{refusalProse(register.error)}</FieldError>
              )}

              <div className="flex justify-end">
                <Button
                  type="submit"
                  variant="default"
                  data-testid="register-source"
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
