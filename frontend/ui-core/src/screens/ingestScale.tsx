import { Image } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";

import { Label } from "../primitives/label";

/**
 * The server's scaled-dimension formula, mirrored exactly.
 *
 * Integer half-up on purpose: Python `round` is half-even and `Math.round` is
 * half-up, so the one spelling both sides can share is integer arithmetic —
 * the kernel's `scaled_dimension`. The 25 × 50% → 13 fixture is pinned on both
 * sides to keep them one formula.
 */
export function scaledDimension(native: number, percent: number): number {
  return Math.max(1, Math.floor((native * percent + 50) / 100));
}

/**
 * A native `input[type=range]` and not a primitive, for SuggestPanel's reason:
 * no slider primitive exists in this package and one control does not earn
 * one. Never `preventDefault` its pointer press — a range *drags* on its
 * default action, and cancelling the press is what made one unmovable (#563).
 */
export function ScaleField({
  percent,
  onPercent,
  native,
  id = "scale-percent",
  preview = true,
}: {
  readonly percent: number;
  readonly onPercent: (value: number) => void;
  readonly native: { readonly width: number; readonly height: number } | null;
  readonly id?: string;
  /** False where a caller renders its own previews — the mosaic's tiles do. */
  readonly preview?: boolean;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Scale</Label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          data-testid={id}
          type="range"
          min={10}
          max={100}
          step={5}
          value={percent}
          aria-label="Scale percent"
          aria-valuetext={`${percent}%`}
          onChange={(event) => onPercent(Number(event.target.value))}
          className="h-1 flex-1 cursor-pointer accent-primary"
        />
        <span className="w-10 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
          {percent}%
        </span>
      </div>
      {preview && percent < 100 && (
        <p
          className="text-xs text-muted-foreground tabular-nums"
          data-testid={native !== null ? "stored-size" : "stored-size-blind"}
        >
          {native !== null
            ? `stored at ${scaledDimension(native.width, percent)}×${scaledDimension(native.height, percent)}`
            : `stored at ${percent}% of the clip's native size — the server reads the exact size`}
        </p>
      )}
    </div>
  );
}

const MOSAIC_CAP = 24;

/** The percent every shown file shares, or 100 when they disagree or none is set. */
function commonPercent(
  files: readonly File[],
  scales: Readonly<Record<string, number>>,
): number {
  const percents = new Set(files.map((file) => scales[file.name] ?? 100));
  return percents.size === 1 ? [...percents][0] : 100;
}

function MosaicTile({
  file,
  percent,
  onPercent,
}: {
  readonly file: File;
  readonly percent: number;
  readonly onPercent: (value: number) => void;
}): JSX.Element {
  // jsdom has no object URLs and decodes no images — the tile degrades to
  // name plus slider, the same way the clip timeline renders no player.
  const url = useMemo(
    () => (typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null),
    [file],
  );
  useEffect(() => {
    return () => {
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [url]);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  return (
    <figure className="flex flex-col gap-1 rounded-md border border-border p-2">
      {url !== null ? (
        <img
          src={url}
          alt={file.name}
          className="aspect-square w-full rounded object-cover"
          onLoad={(event) =>
            setSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
        />
      ) : (
        <span className="flex aspect-square w-full items-center justify-center rounded bg-muted">
          <Image className="size-4 text-muted-foreground" aria-hidden="true" />
        </span>
      )}
      <figcaption className="truncate text-xs" title={file.name}>
        {file.name}
      </figcaption>
      {size !== null && (
        <p className="text-xs text-muted-foreground tabular-nums" data-testid={`tile-size-${file.name}`}>
          {size.width}×{size.height}
          {percent < 100 &&
            ` → ${scaledDimension(size.width, percent)}×${scaledDimension(size.height, percent)}`}
        </p>
      )}
      <div className="flex items-center gap-1">
        <input
          type="range"
          min={10}
          max={100}
          step={5}
          value={percent}
          data-testid={`tile-scale-${file.name}`}
          aria-label={`Scale ${file.name}`}
          aria-valuetext={`${percent}%`}
          onChange={(event) => onPercent(Number(event.target.value))}
          className="h-1 w-full cursor-pointer accent-primary"
        />
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {percent}%
        </span>
      </div>
    </figure>
  );
}

/**
 * One slider per image, because a batch mixes sizes and one percent rarely
 * fits them all. "Set all" is pure UI — it bulk-writes the per-tile values,
 * and only the per-file map goes on the wire. Duplicate filenames in one drop
 * collapse to one key; the server applies one percent to every part with that
 * name, deliberately.
 */
export function ScaleMosaic({
  files,
  scales,
  onScales,
}: {
  readonly files: readonly File[];
  readonly scales: Readonly<Record<string, number>>;
  readonly onScales: (scales: Readonly<Record<string, number>>) => void;
}): JSX.Element {
  const shown = files.slice(0, MOSAIC_CAP);
  const setOne = (name: string, percent: number): void => {
    const next: Record<string, number> = { ...scales };
    if (percent === 100) delete next[name];
    else next[name] = percent;
    onScales(next);
  };
  return (
    <div className="flex flex-col gap-3">
      <ScaleField
        id="scale-all"
        percent={commonPercent(shown, scales)}
        native={null}
        preview={false}
        onPercent={(percent) =>
          onScales(
            percent === 100
              ? {}
              : Object.fromEntries(files.map((file) => [file.name, percent])),
          )
        }
      />
      <p className="text-xs text-muted-foreground">
        Moving this sets every image; adjust any image below individually. Each scales
        relative to its own size, and the choice is part of the source&apos;s identity.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {shown.map((file) => (
          <MosaicTile
            key={file.name}
            file={file}
            percent={scales[file.name] ?? 100}
            onPercent={(percent) => setOne(file.name, percent)}
          />
        ))}
      </div>
      {files.length > MOSAIC_CAP && (
        <p className="text-xs text-muted-foreground" data-testid="mosaic-overflow">
          … and {files.length - MOSAIC_CAP} more, following the Set all slider.
        </p>
      )}
    </div>
  );
}
