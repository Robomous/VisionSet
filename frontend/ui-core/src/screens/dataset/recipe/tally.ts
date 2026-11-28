/**
 * What a recipe writes for one release, counted from the release's folds.
 *
 * A stopgap until the recipe assessment (#1279) answers this on the server:
 * it is arithmetic over fold sizes only, so it knows nothing of what an export
 * drops by modality or by a crop, and must not learn it here.
 */

export interface Folds {
  readonly train: number;
  readonly val: number;
  readonly test: number;
}

export type Tally =
  | { readonly kind: "no-release" }
  /** `written` is null when variants are asked for: they need a split to run. */
  | { readonly kind: "no-split"; readonly written: number | null }
  | { readonly kind: "pending" }
  | { readonly kind: "folds"; readonly train: number; readonly val: number; readonly test: number; readonly added: number; readonly written: number };

/** Every asset is written once, and each training asset `variants` times more. */
export function tallyRelease(
  release: { readonly asset_count: number; readonly split: unknown } | undefined,
  folds: Folds | undefined,
  variants: number,
): Tally {
  if (release === undefined) return { kind: "no-release" };
  if (release.split === null) return { kind: "no-split", written: variants > 0 ? null : release.asset_count };
  if (folds === undefined) return { kind: "pending" };
  const added = folds.train * variants;
  return { kind: "folds", ...folds, added, written: folds.train + folds.val + folds.test + added };
}
