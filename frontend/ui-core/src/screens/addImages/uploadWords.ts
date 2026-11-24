/** What the upload step calls its selection: counts in words, no state, no markup. */

import { formatCount } from "../../lib/format";
import type { AddKind } from "./flowRules";

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** A single file by its name; several by what they are. */
export function chosenLabel(files: readonly File[], kind: AddKind): string {
  if (files.length === 1) return files[0].name;
  if (kind === "scans") return plural(files.length, "scan");
  return plural(files.length, kind === "mixed" ? "file" : "image");
}
