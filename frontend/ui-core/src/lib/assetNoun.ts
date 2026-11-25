export type Modality = "image" | "point_cloud";

/**
 * The noun for `count` assets of one modality. A point-cloud asset is a scan,
 * never an image or a frame; anything else takes the surface's own word.
 */
export function assetNoun(modality: Modality, count: number, otherwise: "frame" | "image" = "frame"): string {
  const noun = modality === "point_cloud" ? "scan" : otherwise;
  return count === 1 ? noun : `${noun}s`;
}

/**
 * The noun for `count` of a batch's assets, from what it holds
 * (`BatchOut.modalities`): one modality reads as `assetNoun` does; a batch
 * holding several, or none yet, reads as assets.
 */
export function batchNoun(modalities: readonly Modality[], count: number, otherwise: "frame" | "image" = "frame"): string {
  const [only] = modalities;
  if (only === undefined || modalities.length > 1) return count === 1 ? "asset" : "assets";
  return assetNoun(only, count, otherwise);
}
