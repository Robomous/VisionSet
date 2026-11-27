import { describe, expect, it } from "vitest";

import type { LabelClassBody } from "../screens/queries";
import { keypointSpecProblem, keypointSpecProblems } from "./keypointSpecRules";

type Spec = NonNullable<LabelClassBody["keypoints"]>;

function face(spec: Spec | null, geometries: LabelClassBody["geometries"] = ["keypoints"]): LabelClassBody {
  return { name: "face", geometries, color: null, attributes: [], keypoints: spec };
}

describe("why a keypoint spec would not publish", () => {
  it.each<[string, LabelClassBody, string]>([
    ["a spec on a class not drawn as keypoints", face({ names: ["a"], skeleton: [] }, ["bbox"]), "not drawn as keypoints"],
    ["no names", face({ names: [], skeleton: [] }), "names no points"],
    ["a blank name", face({ names: ["a", "  "], skeleton: [] }), "Keypoint 2 has no name."],
    ["a name repeated, ignoring case and padding", face({ names: ["Nose", " nose"], skeleton: [] }), "Two keypoints are named “nose”"],
    ["an edge past the names", face({ names: ["a", "b"], skeleton: [[0, 2]] }), "Skeleton edge (0, 2) points past the 2 named keypoints."],
    ["a negative index", face({ names: ["a", "b"], skeleton: [[-1, 1]] }), "Skeleton edge (-1, 1) points past"],
    ["a self-loop", face({ names: ["a", "b"], skeleton: [[1, 1]] }), "Skeleton edge (1, 1) joins a keypoint to itself."],
    ["an edge twice, either way round", face({ names: ["a", "b"], skeleton: [[0, 1], [1, 0]] }), "Skeleton edge (1, 0) appears twice."],
  ])("names %s", (_case, declared, said) => {
    expect(keypointSpecProblem(declared)).toContain(said);
  });

  it("finds nothing wrong with a spec the kernel publishes, or with no spec", () => {
    expect(keypointSpecProblem(face({ names: ["a", "b", "c"], skeleton: [[0, 1], [2, 1]] }))).toBeNull();
    expect(keypointSpecProblem(face({ names: ["a"] } as Spec))).toBeNull();
    expect(keypointSpecProblem(face(null, ["bbox"]))).toBeNull();
  });

  it("lists every class that would be refused, by position", () => {
    const bad = face({ names: ["a"], skeleton: [[0, 0]] });
    expect(keypointSpecProblems([face(null, ["bbox"]), bad])).toEqual([
      { name: "face", index: 1, problem: "Skeleton edge (0, 0) joins a keypoint to itself." },
    ]);
  });
});
