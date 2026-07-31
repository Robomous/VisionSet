/**
 * The benchmark scene: 200 boxes, 20 polygons of 32 vertices, on a 4K asset.
 *
 * #49's numbers, exactly — the vision doc's open topic 4 asks for v1's ceiling as
 * the baseline to beat, and M4's own exit criterion is "60fps with 200+
 * annotations". Twelve tasks argued this engine is *correct*; this file is what
 * lets something finally measure whether it is *fast*.
 *
 * ## Why it lives in the app and not in the annotator package
 *
 * A benchmark fixture is not part of the shipped engine, and this module reaches
 * for `<canvas>` — a global `src/core/`'s `no-restricted-globals` rule bans and
 * `tsconfig.core.json` could not compile. Putting it here also keeps the engine's
 * `dist/` free of a 4K image generator no consumer would ever call.
 *
 * ## Deterministic, and the seed is the fixture
 *
 * Every coordinate comes out of one `mulberry32` stream from one fixed seed, so
 * the scene is byte-identical on every machine and every run. That is what makes
 * a frame time from a laptop and a frame time from a CI runner comparable at all,
 * and what lets `e2e/perf.spec.ts` assert an exact SVG node count.
 *
 * The PRNG is sixteen lines copied from `core/_random.ts` rather than imported:
 * that file matches the `_*.ts` pattern `tsconfig.build.json` excludes, so it is
 * not in the package's `dist/` and cannot be imported from here. Copying the
 * arithmetic is harmless — what that module's own docstring says must never be
 * copied is the *seed list*, because "the seed is in the test name so a failure
 * replays" only holds while there is one list. There is one seed here and it is
 * not a sweep.
 *
 * ## The layout rule
 *
 * Boxes sit on a 20x10 grid and polygons on a 5x4 grid of larger cells, with
 * enough slack that no two shapes are ambiguous to aim at. The number that
 * matters is `Tolerances.shape` — 4 **screen** pixels, so ~11 asset pixels at
 * this asset's fit zoom of about 0.36 — because `resolveTarget` resolves a body
 * with that much outward slack. Every gap here is at least 40 asset pixels,
 * comfortably more than twice that.
 *
 * Polygons are emitted **after** the boxes, so they are last in draw order and
 * `topmostAnnotationAt` resolves a press at a polygon's centre to the polygon
 * even where it overlaps the grid. Overlap is deliberate: a real densely
 * annotated frame has plenty, and a scene that carefully avoided it would be
 * measuring an easier hit test than the one that ships.
 */

import type { Annotation, AssetDescriptor, Point } from "@visionset/annotator";

/** 4K, the size #49 names. The frame every coordinate below is in. */
export const BENCH_ASSET: AssetDescriptor = {
  id: "bench-asset-0001",
  width: 3840,
  height: 2160,
};

/** The scene's shape, exported so a spec asserts the numbers rather than restating them. */
export const BENCH_BOXES = 200;
export const BENCH_POLYGONS = 20;
export const BENCH_POLYGON_VERTICES = 32;

/** 220 annotations and 640 polygon vertices. */
export const BENCH_ANNOTATIONS = BENCH_BOXES + BENCH_POLYGONS;

const SEED = 20260731;

const BOX_COLS = 20;
const BOX_ROWS = 10;
const POLYGON_COLS = 5;
const POLYGON_ROWS = 4;

/** See the docstring: copied arithmetic, not a copied seed list. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ids are generated, not minted.
 *
 * `randomUuid` would make the scene different on every load, which would cost the
 * determinism the whole file is built on — and nothing here needs a real UUID:
 * `AnnotationDocument` keys on the string and refuses only duplicates.
 */
function idOf(kind: string, index: number): string {
  return `bench-${kind}-${String(index).padStart(4, "0")}`;
}

/**
 * The nine keys `parseAnnotation` demands, in one place.
 *
 * Typed as the engine's own `Annotation` rather than as a local interface: a
 * hand-written mirror of a kernel shape is exactly what `scripts/export_wire_fixtures.py`
 * exists to prevent, and the scene still goes in through `documentFromWire`, so
 * the parser is exercised either way.
 */
function annotationOf(id: string, labelClass: string, geometry: Annotation["geometry"]): Annotation {
  return {
    id,
    asset_id: BENCH_ASSET.id,
    label_class: labelClass,
    schema_version: 1,
    geometry,
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
  };
}

/**
 * The scene, in draw order: 200 `vehicle` boxes, then 20 `lane` polygons.
 *
 * The classes are `sampleSchema.ts`'s own, so digits 1 and 2 still activate the
 * bbox and polygon tools on this page — which is what lets a benchmark scenario
 * *draw* as well as drag.
 */
export function benchAnnotations(): readonly Annotation[] {
  const random = mulberry32(SEED);
  const annotations: Annotation[] = [];

  const cellWidth = BENCH_ASSET.width / BOX_COLS;
  const cellHeight = BENCH_ASSET.height / BOX_ROWS;
  for (let index = 0; index < BENCH_BOXES; index += 1) {
    const column = index % BOX_COLS;
    const row = Math.floor(index / BOX_COLS);
    // 96..136 x 110..150, centred in a 192x216 cell with +/-8 of wobble. The
    // tightest gap that leaves is 40 asset pixels, against a `shape` tolerance of
    // about 11 at the fit zoom.
    const width = 96 + random() * 40;
    const height = 110 + random() * 40;
    const centreX = (column + 0.5) * cellWidth + (random() - 0.5) * 16;
    const centreY = (row + 0.5) * cellHeight + (random() - 0.5) * 16;
    annotations.push(
      annotationOf(idOf("box", index), "vehicle", {
        type: "bbox",
        x: Math.round(centreX - width / 2),
        y: Math.round(centreY - height / 2),
        width: Math.round(width),
        height: Math.round(height),
      }),
    );
  }

  const polygonCellWidth = BENCH_ASSET.width / POLYGON_COLS;
  const polygonCellHeight = BENCH_ASSET.height / POLYGON_ROWS;
  for (let index = 0; index < BENCH_POLYGONS; index += 1) {
    const column = index % POLYGON_COLS;
    const row = Math.floor(index / POLYGON_COLS);
    const centreX = (column + 0.5) * polygonCellWidth;
    const centreY = (row + 0.5) * polygonCellHeight;
    const radius = 130 + random() * 40;
    const points: Point[] = [];
    for (let vertex = 0; vertex < BENCH_POLYGON_VERTICES; vertex += 1) {
      const angle = (vertex / BENCH_POLYGON_VERTICES) * Math.PI * 2;
      // Wobbled radius, so it is a dense irregular ring rather than a circle —
      // `nearestEdge` and `nearestVertex` both walk every segment either way, but
      // a shape with equal edges would hide a tie-break bug.
      const wobble = radius * (0.78 + random() * 0.22);
      points.push([
        Math.round(centreX + Math.cos(angle) * wobble),
        Math.round(centreY + Math.sin(angle) * wobble),
      ]);
    }
    annotations.push(annotationOf(idOf("poly", index), "lane", { type: "polygon", points }));
  }

  return annotations;
}

/**
 * The exact centre of box `index`, in asset pixels.
 *
 * The scene tells a harness where its shapes are, rather than the harness
 * re-deriving the grid arithmetic from the constants above. Two spellings of a
 * layout is how a scenario comes to aim eight pixels off and grab a neighbour,
 * and the failure would read as a machine bug rather than as a stale copy.
 */
export function benchBoxCentre(index: number): { readonly x: number; readonly y: number } {
  const annotation = benchAnnotations()[index];
  if (annotation === undefined) throw new RangeError(`no bench box at index ${index}`);
  const geometry = annotation.geometry;
  if (geometry.type !== "bbox") throw new TypeError(`bench annotation ${index} is not a box`);
  return { x: geometry.x + geometry.width / 2, y: geometry.y + geometry.height / 2 };
}

/**
 * The picture: a 4K raster, drawn at load and handed over as a blob URL.
 *
 * **A bitmap and not an SVG, deliberately.** `sampleAsset.ts` is a vector image
 * because it is a diagram whose job is to make a wrong transform visible; this
 * one's job is to be the thing a compositor has to re-rasterize when the stage
 * zooms, which is what a real 4K photograph costs and what a vector image
 * understates. Nothing is committed either way — `tests/architecture/test_tracked_file_sizes.py`
 * caps a tracked file at 200 KB and the repository never commits fixture media,
 * so the image is generated here for the same reason `tests/fixtures/media.py`
 * generates every image the Python suite uses.
 *
 * JPEG rather than PNG: an 8.3-megapixel PNG encode is slow enough to matter
 * inside a test timeout, and a photographic asset is a JPEG anyway.
 *
 * The caller owns the returned URL and must `URL.revokeObjectURL` it.
 */
export async function renderBenchImage(): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = BENCH_ASSET.width;
  canvas.height = BENCH_ASSET.height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("no 2d context: cannot build the benchmark image");

  const random = mulberry32(SEED ^ 0x5f3759df);

  const sky = context.createLinearGradient(0, 0, 0, BENCH_ASSET.height);
  sky.addColorStop(0, "#12202f");
  sky.addColorStop(1, "#2a3345");
  context.fillStyle = sky;
  context.fillRect(0, 0, BENCH_ASSET.width, BENCH_ASSET.height);

  // Coarse texture rather than per-pixel noise: a few thousand fills cost
  // milliseconds where a typed-array noise pass over 8.3M pixels costs seconds,
  // and what is being measured is the compositor's rescale, not the encoder.
  for (let index = 0; index < 2400; index += 1) {
    const x = random() * BENCH_ASSET.width;
    const y = random() * BENCH_ASSET.height;
    const size = 12 + random() * 180;
    context.fillStyle = `hsl(${Math.floor(random() * 360)} ${20 + random() * 40}% ${
      12 + random() * 46
    }%)`;
    context.globalAlpha = 0.18 + random() * 0.3;
    context.fillRect(x, y, size, size * (0.4 + random() * 1.2));
  }
  context.globalAlpha = 1;

  // The ruler `sampleAsset.ts` argues for, kept: a box whose reported x is 1920
  // sitting over a line labelled 1920 is still the cheapest check that the
  // transform is right, and a benchmark that silently drew in the wrong frame
  // would report perfectly good numbers about nothing.
  context.strokeStyle = "#5b6b8566";
  context.fillStyle = "#8ea3c2";
  context.lineWidth = 2;
  context.font = "28px system-ui, sans-serif";
  for (let x = 320; x < BENCH_ASSET.width; x += 320) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, BENCH_ASSET.height);
    context.stroke();
    context.fillText(String(x), x + 8, 36);
  }
  for (let y = 320; y < BENCH_ASSET.height; y += 320) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(BENCH_ASSET.width, y);
    context.stroke();
    context.fillText(String(y), 8, y - 10);
  }

  context.strokeStyle = "#3d4c66";
  context.lineWidth = 6;
  context.strokeRect(3, 3, BENCH_ASSET.width - 6, BENCH_ASSET.height - 6);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.85),
  );
  if (blob === null) throw new Error("canvas.toBlob produced nothing");
  return URL.createObjectURL(blob);
}
