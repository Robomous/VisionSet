export type Modality = "image" | "point_cloud";

/**
 * The noun for `count` assets of one modality. A point-cloud asset is a scan,
 * never an image or a frame; anything else takes the surface's own word.
 */
export function assetNoun(modality: Modality, count: number, otherwise: "frame" | "image" = "frame"): string {
  const noun = modality === "point_cloud" ? "scan" : otherwise;
  return count === 1 ? noun : `${noun}s`;
}
