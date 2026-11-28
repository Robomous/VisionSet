/**
 * A class's keypoint spec, read: its named points in order and the skeleton
 * edges between them. Read-only on every surface — the spec is written over the
 * API — and carried untouched by every form that edits the rest of the class.
 */

import type { JSX } from "react";

import type { LabelClassBody } from "../screens/queries";
import { keypointName, skeletonPairs } from "./keypointSpecRules";
import { PropertyRow } from "./PropertyRow";

type Spec = NonNullable<LabelClassBody["keypoints"]>;

interface Chip {
  readonly key: string;
  readonly label: string;
}

function Chips({ items, testId }: { readonly items: readonly Chip[]; readonly testId: string }): JSX.Element {
  return (
    <ol className="flex flex-wrap items-center gap-1" data-testid={testId}>
      {items.map((item) => (
        <li key={item.key} className="flex h-6 items-center rounded-md bg-muted px-1.5">
          {item.label}
        </li>
      ))}
    </ol>
  );
}

function Points({ spec, slot }: { readonly spec: Spec; readonly slot: string }): JSX.Element {
  return <Chips
      items={spec.names.map((_, index) => ({ key: `point-${String(index)}`, label: keypointName(spec, index) }))}
      testId={`keypoint-names-${slot}`}
    />;
}

function Skeleton({ spec, slot }: { readonly spec: Spec; readonly slot: string }): JSX.Element {
  if (spec.skeleton.length === 0) {
    return (
      <span className="text-muted-foreground" data-testid={`keypoint-skeleton-${slot}`}>
        No edges
      </span>
    );
  }
  return <Chips
      items={skeletonPairs(spec).map((label, index) => ({ key: spec.skeleton[index].join("-"), label }))}
      testId={`keypoint-skeleton-${slot}`}
    />;
}

const NO_SPEC = "No spec: any number of points, drawn without a skeleton";

/**
 * The spec as inspector rows, or as a stacked field. Nothing when the class
 * neither declares keypoints nor carries a spec.
 */
export function KeypointSpecFields({
  declared,
  slot,
  layout,
}: {
  readonly declared: LabelClassBody;
  readonly slot: string;
  readonly layout: "rows" | "stacked";
}): JSX.Element | null {
  const spec = declared.keypoints ?? null;
  if (spec === null && !declared.geometries.includes("keypoints")) return null;

  if (layout === "stacked") {
    return (
      <div className="flex flex-col gap-1.5" data-testid={`keypoint-spec-${slot}`}>
        <span className="text-label">Keypoints</span>
        {spec === null ? (
          <span className="text-xs text-muted-foreground">{NO_SPEC}</span>
        ) : (
          <>
            <Points spec={spec} slot={slot} />
            <span className="text-xs text-muted-foreground">Skeleton</span>
            <Skeleton spec={spec} slot={slot} />
          </>
        )}
      </div>
    );
  }

  return (
    <div data-testid={`keypoint-spec-${slot}`}>
      <PropertyRow label="Keypoints" align="start">
        {spec === null ? (
          <span className="block pt-1.5 text-pretty text-muted-foreground">{NO_SPEC}</span>
        ) : (
          <span className="block pt-0.5">
            <Points spec={spec} slot={slot} />
          </span>
        )}
      </PropertyRow>
      {spec !== null && (
        <PropertyRow label="Skeleton" nested align="start">
          <span className="block pt-0.5">
            <Skeleton spec={spec} slot={slot} />
          </span>
        </PropertyRow>
      )}
    </div>
  );
}
