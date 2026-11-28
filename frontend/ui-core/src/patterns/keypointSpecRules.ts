/**
 * Why a class's keypoint spec would not publish, or `null` when it would.
 *
 * A draft holds a spec half-written — blank names, dangling edges — and the
 * spec is written over the API, so the editor can only say what is wrong. It
 * mirrors the kernel's `KeypointSpec` and `LabelClass` rules, in their order.
 */

import type { LabelClassBody } from "../screens/queries";

type Spec = NonNullable<LabelClassBody["keypoints"]>;

export function keypointSpecProblem(declared: Pick<LabelClassBody, "geometries" | "keypoints">): string | null {
  const spec = declared.keypoints;
  if (spec == null) return null;
  if (!declared.geometries.includes("keypoints")) return "It keeps a keypoint spec but is not drawn as keypoints — tick Keypoints to keep it.";
  const names = spec.names.map((name) => name.trim());
  if (names.length === 0) return "Its keypoint spec names no points.";
  const blank = names.findIndex((name) => name === "");
  if (blank !== -1) return `Keypoint ${blank + 1} has no name.`;
  const folded = names.map((name) => name.toLowerCase());
  const repeat = folded.findIndex((name, at) => folded.indexOf(name) !== at);
  if (repeat !== -1) return `Two keypoints are named “${names[repeat]}” — names ignore case.`;
  const seen = new Set<string>();
  for (const [first, second] of spec.skeleton ?? []) {
    const edge = `(${first}, ${second})`;
    if ([first, second].some((index) => !Number.isInteger(index) || index < 0 || index >= names.length)) {
      return `Skeleton edge ${edge} points past the ${names.length} named keypoints.`;
    }
    if (first === second) return `Skeleton edge ${edge} joins a keypoint to itself.`;
    const key = `${Math.min(first, second)}-${Math.max(first, second)}`;
    if (seen.has(key)) return `Skeleton edge ${edge} appears twice.`;
    seen.add(key);
  }
  return null;
}

/** Every class whose spec would not publish, with the reason. */
export function keypointSpecProblems(
  classes: readonly LabelClassBody[],
): readonly { readonly name: string; readonly index: number; readonly problem: string }[] {
  return classes.flatMap((declared, index) => {
    const problem = keypointSpecProblem(declared);
    return problem === null ? [] : [{ name: declared.name.trim(), index, problem }];
  });
}

/** A point's name, or its position when a draft left it blank or an edge points past the names. */
export function keypointName(spec: Spec, index: number): string {
  const name = spec.names[index];
  return name === undefined || name.trim() === "" ? `point ${index + 1}` : name;
}

/** Each edge as its two names, in the order the spec lists them. */
export function skeletonPairs(spec: Spec): readonly string[] {
  return spec.skeleton.map(([from, to]) => `${keypointName(spec, from)} – ${keypointName(spec, to)}`);
}
