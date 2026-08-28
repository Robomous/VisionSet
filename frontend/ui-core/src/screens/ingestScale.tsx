import { Image } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useState } from "react";

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
 *
 * The block leads with the outcome, not the mechanism: a readout that is
 * always present (what resolution exists, what will be stored) and a purpose
 * line that says what the value costs — the two facts a person needs *before*
 * touching the slider.
 */
export function ScaleField({
  percent,
  onPercent,
  native,
  id = "scale-percent",
  label = "Stored size",
  subject = "frame",
  readout = true,
  purpose,
}: {
  readonly percent: number;
  readonly onPercent: (value: number) => void;
  readonly native: { readonly width: number; readonly height: number } | null;
  readonly id?: string;
  readonly label?: string;
  /** What one stored item is called in the purpose line: "frame" or "image". */
  readonly subject?: string;
  /** False where a caller renders its own readouts — the mosaic's tiles do. */
  readonly readout?: boolean;
  /** Replaces the computed purpose line — the mosaic's mixed state needs its own. */
  readonly purpose?: string;
}): JSX.Element {
  const pixels = Math.round((percent * percent) / 100);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        {readout &&
          (native !== null ? (
            percent < 100 ? (
              <span className="text-xs tabular-nums text-muted-foreground" data-testid="stored-size">
                {native.width}×{native.height} → {scaledDimension(native.width, percent)}×
                {scaledDimension(native.height, percent)} · {percent}%
              </span>
            ) : (
              <span
                className="text-xs tabular-nums text-muted-foreground"
                data-testid="stored-size-native"
              >
                {native.width}×{native.height} · native
              </span>
            )
          ) : (
            <span className="text-xs tabular-nums text-muted-foreground" data-testid="stored-size-blind">
              {percent < 100 ? `${percent}% per side · ` : ""}exact size read at upload
            </span>
          ))}
      </div>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">10%</span>
        <input
          id={id}
          data-testid={id}
          type="range"
          min={10}
          max={100}
          step={5}
          value={percent}
          aria-label="Stored size percent"
          aria-valuetext={`${percent}%`}
          onChange={(event) => onPercent(Number(event.target.value))}
          className="h-1 flex-1 cursor-pointer accent-primary"
        />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">100%</span>
      </div>
      <p className="text-xs text-muted-foreground" data-testid={`${id}-purpose`}>
        {purpose ??
          (percent < 100
          ? `Every ${subject} stored at ${percent}% per side — about ${pixels}% of the ` +
            `pixels, so smaller files and faster training. Annotations are drawn on ` +
            `what is stored.`
            : `Stored as captured. Drag left to store smaller ${subject}s.`)}
      </p>
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
  //
  // Created inside the effect, never memoized: StrictMode mounts, cleans up,
  // and mounts again, and a memoized URL survives that cycle already revoked —
  // every thumbnail rendered as a broken image under the dev server. The
  // remounted effect must mint its own URL, the way the clip preview does.
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (typeof URL.createObjectURL !== "function") return undefined;
    const created = URL.createObjectURL(file);
    setUrl(created);
    return () => {
      setUrl(null);
      URL.revokeObjectURL(created);
    };
  }, [file]);
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
  const mixed = new Set(shown.map((file) => scales[file.name] ?? 100)).size > 1;
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
        label="Stored size — set all"
        subject="image"
        percent={commonPercent(shown, scales)}
        native={null}
        readout={false}
        purpose={mixed ? "Sizes differ per image — each tile below shows its own." : undefined}
        onPercent={(percent) =>
          onScales(
            percent === 100
              ? {}
              : Object.fromEntries(files.map((file) => [file.name, percent])),
          )
        }
      />
      <p className="text-xs text-muted-foreground">
        Sets every image at once — adjust any tile individually after. Each scales relative
        to its own size, and the choice is part of the source&apos;s identity.
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
