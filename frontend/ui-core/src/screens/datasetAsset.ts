/**
 * How a trunk member and the model behind a label are named, wherever the
 * Dataset section names them.
 */

import type { DatasetAsset } from "./queries";

/** The frame number when there is one, and a short content hash when there is not. */
export function trunkAssetLabel(asset: DatasetAsset): string {
  return asset.frame_index == null ? asset.content_hash.slice(0, 12) : `frame ${asset.frame_index}`;
}

/** `IDEA-Research/grounding-dino-tiny@a2bb…` reads as `grounding-dino-tiny`; the whole reference rides on `title`. */
export function modelName(ref: string): string {
  const [path] = ref.split("@", 1);
  const segments = (path ?? ref).split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? ref;
}
