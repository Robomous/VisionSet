/**
 * Step 1, Upload: drop or pick, read the selection back, name the source.
 *
 * Hand-rolled rather than `react-dropzone`. The library earns its keep on MIME
 * filtering, size limits and per-file rejection — and every one of those is a
 * rule the **server** already owns and refuses better: a `.txt` among the
 * photographs comes back as an `unsupported` row in the run's report, with the
 * kernel's own reason. Duplicating that here would be a second spelling of the
 * accepted-format list, and the two would drift. What is left is a `drop`
 * handler and two hidden inputs: files, and a folder.
 *
 * The selection is read back before anything uploads — the pictures
 * themselves for images, the clip's own facts as the decoder read them, the
 * scans by name — because recognising "that is the wrong folder" is the point.
 * Its size and the ✕ that clears it sit on the line that heads it, so there is
 * one card per selection, not a summary card above another one.
 */

import { Box, Check, FileQuestion, Film, FolderOpen, ImagePlus, Upload, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type DragEvent, type JSX } from "react";

import { Alert, AlertDescription, AlertTitle, Button, FieldError, Input, Label, Spinner, cn } from "@robomous/ui-core";
import { refusalProse } from "../../data/refusals";
import { formatBytes, formatCount } from "../../lib/format";
import { clock } from "../clipRanges";
import { SCAN_FRAMES } from "../scanFiles";
import { decodeProse } from "./clipDerived";
import { ClipFacts, ClipRefusal } from "./clipImport";
import { EASE, PRESS } from "./motion";
import { chosenLabel, plural } from "./uploadWords";
import type { AddImagesFlow } from "./useAddImagesFlow";

/** How many pictures the selection previews; the rest is a count. */
const PREVIEWED = 17;

export function UploadStep({ flow }: { readonly flow: AddImagesFlow }): JSX.Element {
  const [over, setOver] = useState(false);
  // A source already registered is a choice made; the selection reads back
  // what it was, and its ✕ is the way to choose again.
  const locked = flow.register.isPending;

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setOver(false);
    if (locked || event.dataTransfer.files.length === 0) return;
    flow.choose(Array.from(event.dataTransfer.files));
  }

  return (
    <div
      className="flex flex-col gap-4"
      onDragOver={(event) => {
        event.preventDefault();
        if (!locked) setOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOver(false);
      }}
      onDrop={onDrop}
      data-testid={flow.kind === "scans" ? "point-cloud-flow" : undefined}
    >
      {flow.files.length === 0 ? <Dropzone flow={flow} over={over} /> : <Selection flow={flow} over={over} />}

      {flow.register.isError && <FieldError data-testid="register-error">{refusalProse(flow.register.error)}</FieldError>}

      {flow.landed.length > 0 && flow.files.length === 0 && (
        <p className="text-xs text-pretty text-muted-foreground" data-testid="landed">
          Added this time: {flow.landed.map((one) => `“${one.name}”`).join(", ")}.
        </p>
      )}
    </div>
  );
}

function Pickers({ flow }: { readonly flow: AddImagesFlow }): JSX.Element {
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const take = (list: FileList | null): void => {
    if (list !== null && list.length > 0) flow.choose(Array.from(list));
  };
  return (
    <div className="flex flex-wrap justify-center gap-2" key={flow.attempt}>
      <Button className={PRESS} onClick={() => files.current?.click()} data-testid="choose-files">
        <ImagePlus data-icon="inline-start" aria-hidden="true" />
        Choose files
      </Button>
      <Button variant="outline" className={PRESS} onClick={() => folder.current?.click()} data-testid="choose-folder">
        <FolderOpen data-icon="inline-start" aria-hidden="true" />
        Choose a folder
      </Button>
      <input ref={files} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" data-testid="file-input" onChange={(event) => take(event.target.files)} />
      <input
        ref={folder}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="folder-input"
        {...({ webkitdirectory: "" } as Record<string, string>)}
        onChange={(event) => take(event.target.files)}
      />
    </div>
  );
}

function Dropzone({ flow, over }: { readonly flow: AddImagesFlow; readonly over: boolean }): JSX.Element {
  // No runtime, no clip: the zone never says it takes one.
  const prompt = flow.canDecode ? "Drop images, a folder, a video or point clouds" : "Drop images, a folder or point clouds";
  return (
    <div
      data-testid="dropzone"
      data-over={over ? "true" : "false"}
      className={cn(
        "flex min-h-64 flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed p-8 text-center transition-[border-color,background-color] duration-150 ease-out motion-reduce:transition-none",
        over ? "border-primary bg-primary/5" : "border-border bg-muted/30",
      )}
    >
      <span
        className={cn(
          "grid size-11 place-items-center rounded-xl bg-background shadow-xs ring-1 ring-border transition-transform duration-200 motion-reduce:transition-none",
          over && "-translate-y-0.5",
        )}
        style={{ transitionTimingFunction: EASE }}
      >
        <Upload className="size-5 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{over ? "Drop to add them" : prompt}</p>
        <p className="max-w-sm text-xs text-pretty text-muted-foreground">
          Adding the same files twice creates nothing new. Nothing is filtered here — the server reads every file and reports what it could not.
        </p>
      </div>
      <Pickers flow={flow} />
    </div>
  );
}

/** The ✕ every selection carries on its heading line, one spelling. */
function ClearSelection({ flow }: { readonly flow: AddImagesFlow }): JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("-my-1 shrink-0", PRESS)}
      data-testid="clear-files"
      aria-label="Clear selection"
      disabled={flow.register.isPending}
      onClick={flow.clear}
    >
      <X aria-hidden="true" />
    </Button>
  );
}

function Selection({ flow, over }: { readonly flow: AddImagesFlow; readonly over: boolean }): JSX.Element {
  const bytes = flow.files.reduce((sum, file) => sum + file.size, 0);
  return (
    <>
      <SelectionCard flow={flow} over={over} bytes={bytes} />

      {flow.kind === "mixed" && (
        <FieldError data-testid="mixed-drop">Add point clouds (.pcd, .ply) separately from other files.</FieldError>
      )}

      {flow.kind === "scans" && <ScanFrameField flow={flow} />}

      {(flow.kind === "images" || flow.kind === "scans") && <SourceNameField flow={flow} />}

      {flow.register.isPending && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums" aria-live="polite" data-testid="uploading">
          <Spinner aria-hidden="true" />
          Uploading {plural(flow.files.length, flow.kind === "scans" ? "scan" : "image")} · {formatBytes(bytes)}…
        </p>
      )}
    </>
  );
}

/** The one card per selection: what was chosen, how big, and the ✕ to choose again. */
function SelectionCard({ flow, over, bytes }: { readonly flow: AddImagesFlow; readonly over: boolean; readonly bytes: number }): JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border transition-[border-color,background-color] duration-150 ease-out motion-reduce:transition-none",
        over ? "border-primary bg-primary/5" : "border-border",
      )}
      data-testid="selection"
    >
      {flow.kind === "video" ? (
        <VideoCard flow={flow} bytes={bytes} />
      ) : (
        <>
          <div className="flex items-center gap-3 py-2 pr-2 pl-3">
            <span className="min-w-0 flex-1 truncate text-sm">
              <span className="font-medium" data-testid="chosen">
                {chosenLabel(flow.files, flow.kind)}
              </span>
              <span className="text-muted-foreground tabular-nums"> · {formatBytes(bytes)}</span>
            </span>
            <ClearSelection flow={flow} />
          </div>
          {flow.kind === "images" && <Thumbnails files={flow.files} />}
          {flow.kind === "scans" && <ScanList files={flow.files} />}
        </>
      )}
    </div>
  );
}

function SourceNameField({ flow }: { readonly flow: AddImagesFlow }): JSX.Element {
  const nameId = useId();
  return (
    <div className="flex max-w-sm flex-col gap-1.5">
      <Label htmlFor={nameId}>Source name</Label>
      <Input
        id={nameId}
        data-testid="source-name"
        value={flow.sourceName}
        placeholder={flow.source?.name ?? flow.suggestedName}
        disabled={flow.register.isPending || flow.source !== null}
        onChange={(event) => flow.setSourceName(event.target.value)}
      />
      <p className="text-xs text-pretty text-muted-foreground">
        Names the source — and a new batch takes its name. Without one the server calls both by the upload&apos;s content digest.
      </p>
    </div>
  );
}

/** A blob URL for a file, made and revoked by the same effect, so a remount never revokes one in use. */
function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (file === null || typeof URL.createObjectURL !== "function") return;
    const made = URL.createObjectURL(file);
    setUrl(made);
    return () => {
      setUrl(null);
      URL.revokeObjectURL(made);
    };
  }, [file]);
  return url;
}

function Thumb({ file }: { readonly file: File }): JSX.Element {
  const url = useObjectUrl(file.type.startsWith("image/") ? file : null);
  const [broken, setBroken] = useState(false);
  return (
    // The image outline: a 1px edge inside every picture, so a white frame still has one.
    <div
      className="vs-image-outline relative aspect-[4/3] overflow-hidden rounded-[6px] bg-stage"
      title={file.name}
      role="img"
      aria-label={file.name}
      data-testid="selection-thumb"
    >
      {url === null || broken ? (
        <span className="grid size-full place-items-center text-muted-foreground">
          <FileQuestion className="size-4" aria-hidden="true" />
        </span>
      ) : (
        // The browser's own reading of the picture; one it cannot draw falls
        // back to the icon — the server still decides whether it is an image.
        <img src={url} alt="" loading="lazy" decoding="async" className="size-full object-cover" onError={() => setBroken(true)} />
      )}
    </div>
  );
}

function Thumbnails({ files }: { readonly files: readonly File[] }): JSX.Element {
  const rest = files.length - PREVIEWED;
  return (
    // 8px inside a 12px card: the thumbnails' 6px corners keep the curve concentric.
    <div className="grid grid-cols-4 gap-1.5 px-2 pb-2 sm:grid-cols-6" data-testid="selection-names">
      {files.slice(0, rest > 0 ? PREVIEWED : files.length).map((file, at) => (
        <Thumb key={`${file.name}-${at}`} file={file} />
      ))}
      {rest > 0 && (
        <div className="grid aspect-[4/3] place-items-center rounded-[6px] bg-muted text-xs font-medium text-muted-foreground tabular-nums" data-testid="selection-more">
          +{formatCount(rest)}
        </div>
      )}
    </div>
  );
}

function ScanList({ files }: { readonly files: readonly File[] }): JSX.Element {
  return (
    <ul className="mx-2 mb-2 flex max-h-48 flex-col divide-y divide-border overflow-y-auto rounded-md bg-muted/40 text-xs" data-testid="selection-names">
      {files.map((file, at) => (
        <li key={`${file.name}-${at}`} className="flex items-center gap-2 px-3 py-2">
          <Box className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate" title={file.name}>
            {file.name}
          </span>
          <span className="text-muted-foreground tabular-nums">{formatBytes(file.size)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The scans' frame. No default: the server cannot read it from the bytes, and a
 * wrong guess is a dataset silently drawn in the wrong axes. It is asked here,
 * before the upload, because the frame rides on the registration itself.
 */
function ScanFrameField({ flow }: { readonly flow: AddImagesFlow }): JSX.Element {
  const locked = flow.register.isPending || flow.source !== null;
  return (
    <fieldset className="flex flex-col gap-2" data-testid="scan-frame">
      <legend className="mb-2 flex w-full items-baseline justify-between gap-3 text-sm font-medium">
        Coordinate frame
        <span className="text-xs font-normal text-muted-foreground">Required — it cannot be read from the files</span>
      </legend>
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Coordinate frame">
        {SCAN_FRAMES.map((option) => {
          const on = flow.frame === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={locked}
              data-testid={`scan-frame-${option.value}`}
              onClick={() => flow.setFrame(option.value)}
              className={cn(
                "flex min-h-10 flex-col items-start gap-1 rounded-lg border p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-60",
                PRESS,
                on ? "border-foreground/40 bg-muted/60 shadow-xs" : "border-border hover:bg-muted/40",
              )}
            >
              <span className="flex w-full items-center justify-between text-sm font-medium">
                {option.label}
                {on && <Check className="size-4" aria-hidden="true" />}
              </span>
              <span className="text-xs text-muted-foreground">{option.axes}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** The clip, as the decoder read it: name, duration · size on screen · bytes, the ✕, and the verdict. */
function VideoCard({ flow, bytes }: { readonly flow: AddImagesFlow; readonly bytes: number }): JSX.Element {
  const file = flow.files[0];
  const url = flow.clip.clipUrl;
  const { inspection, unreadable } = flow.clip;
  const facts = [
    ...(inspection !== null && flow.clip.duration > 0 ? [clock(flow.clip.duration)] : []),
    ...(inspection !== null && inspection.displayWidth > 0 ? [`${inspection.displayWidth}×${inspection.displayHeight}`] : []),
    formatBytes(bytes),
  ];
  return (
    <div className="flex flex-col gap-3 p-2">
      <div className="flex gap-3">
        {/* 8px inside a 12px card: the poster's 4px corners keep the curve concentric. */}
        <div className="vs-image-outline relative aspect-video w-36 shrink-0 overflow-hidden rounded-[4px] bg-stage">
          {url === null ? (
            <span className="grid size-full place-items-center text-muted-foreground">
              <Film className="size-5" aria-hidden="true" />
            </span>
          ) : (
            <video src={url} preload="metadata" muted playsInline className="size-full object-cover" aria-hidden="true" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 text-xs">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="chosen" title={file.name}>
              {file.name}
            </span>
            <ClearSelection flow={flow} />
          </div>
          <span className="text-muted-foreground tabular-nums" data-testid="clip-summary">
            {facts.join(" · ")}
          </span>
          {inspection === null && unreadable === null && (
            <span className="flex items-center gap-1.5 text-muted-foreground" data-testid="clip-inspecting">
              <Spinner aria-hidden="true" />
              Reading the clip…
            </span>
          )}
          {inspection !== null && <ClipFacts inspection={inspection} />}
        </div>
      </div>
      {unreadable !== null && (
        <Alert variant="destructive" data-testid="clip-unreadable">
          <AlertTitle>This clip could not be read</AlertTitle>
          <AlertDescription>{decodeProse(unreadable)}</AlertDescription>
        </Alert>
      )}
      {inspection?.refusal !== undefined && <ClipRefusal refusal={inspection.refusal} inspection={inspection} />}
      {inspection !== null && inspection.refusal === undefined && (
        <p className="px-1 text-xs text-pretty text-muted-foreground">
          Decoded here, in this browser. The clip itself is never uploaded — only the frames it is cut into.
        </p>
      )}
    </div>
  );
}
