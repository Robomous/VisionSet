/**
 * A workspace that renders the same picture on every machine, on every day.
 *
 * The visual baselines and the hostile-content scenarios share this file because
 * they need the same thing: the real application, drawing real components, over
 * data that cannot drift. Everything a reference surface asks for is answered
 * here, so nothing escapes to a developer's workspace and no snapshot depends on
 * what happens to be in it.
 *
 * ## What makes it deterministic
 *
 * **Identifiers are literals.** No `crypto.randomUUID`, no counter, no generator:
 * a fixture that invents its own ids is a fixture whose diff is unreadable.
 *
 * **Timestamps sit in 2024.** `formatWhen` renders a relative age under a week and
 * an absolute date beyond it, so a date this old prints the same string forever —
 * where "3m ago" would print a different one every run. It is the least invasive
 * of the options: no clock is patched and the product's own formatting is what
 * gets exercised. The locale that turns it into text is pinned by the `visual`
 * project rather than inherited from the container.
 *
 * **Images are bytes, not URLs.** One 1x1 PNG answers every thumbnail and asset
 * read, so nothing is fetched and nothing decodes differently on another machine.
 *
 * ## What it deliberately does not do
 *
 * No React component is mocked and no screen is replaced. The application under
 * the snapshot is the application, or the snapshot is worth nothing.
 */

import { expect, type Page, type Route } from "@playwright/test";

import { assetActions, batchActions, jobActions, type Wire } from "./_wire";

export const VISUAL = {
  project: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  batch: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  dataset: "cccccccc-3333-4333-8333-cccccccccccc",
  job: "dddddddd-4444-4444-8444-dddddddddddd",
  connection: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
  asset: "ffffffff-6666-4666-8666-ffffffffffff",
} as const;

/**
 * Well beyond `formatWhen`'s one-week relative window, so every "Created" cell
 * prints an absolute date instead of an age that changes while you read it.
 */
export const FIXED_ISO = "2024-03-14T09:00:00Z";

/** A 1x1 PNG. Small enough to inline, real enough for an `<img>` to decode. */
export const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/* ------------------------------------------------------------------ hostile content */

/**
 * The shapes Phase 7 could not seed through the write path, as literals.
 *
 * Deliberately stressful and still legal wire data — a screen that breaks on one
 * of these is breaking on something a real workspace can hold, not on a value the
 * domain would have refused.
 */
export const LONG_PROJECT_NAME =
  "Autonomous-Highway-Perception-Dataset-Q3-2026-Revalidation-Cohort-With-Adverse-Weather-And-Night-Conditions-Extended";

export const LONG_PROJECT_DESCRIPTION =
  "Every frame in this cohort was re-validated against the revised occlusion policy " +
  "after the Q2 audit found that partially visible pedestrians behind stationary " +
  "vehicles were being labelled inconsistently between the day and night splits.";

export const LONG_CLASS_NAME =
  "pedestrian-crossing-with-partial-occlusion-under-adverse-weather-night-split";

export const LONG_MODEL_REFERENCE = "facebook/sam2.1-hiera-base-plus-vitdet-cascade-refiner";

export const LONG_MODEL_REVISION = "b73207f4a1c92e6d5b8f0a3c7e14d9b2f6a8c0e5";

export const LONG_CONNECTION_NAME =
  "sam2-local-cuda-fp16-highway-perception-revalidation-cohort-node-07";

export const LONG_REFUSAL =
  "This batch cannot be completed because 4 of its 6 frames are still unannotated, " +
  "and completing a batch is what pins its schema version and cuts its jobs, which " +
  "has no route back once it has happened.";

export const LONG_CONTENT_HASH =
  "fc4411996bddda3239f9a8fe9d3121394816f586c1162d000c28a158f658f99f";

/* ------------------------------------------------------------------ wire fixtures */

const NO_PROGRESS = {
  unannotated: 0,
  pre_labeled: 0,
  annotated: 0,
  skipped: 0,
  review_pending: 0,
  accepted: 0,
  total: 0,
} satisfies Wire["ProgressCounts"];

export interface VisualOptions {
  /** Swaps the ordinary class list for one carrying a very long name. */
  readonly longClassName?: boolean;
  /** Swaps the ordinary project for one named and described at length. */
  readonly longProjectText?: boolean;
  /** Swaps the ordinary connection for one with a long reference and name. */
  readonly longModelReference?: boolean;
  /** How many annotations the job's frame carries. Default 3. */
  readonly annotationCount?: number;
  /** Fails the project list with this refusal instead of answering it. */
  readonly refusal?: string;
}

function project(options: VisualOptions): Wire["ProjectOut"] {
  return {
    id: VISUAL.project,
    name: options.longProjectText === true ? LONG_PROJECT_NAME : "highway-perception",
    description: options.longProjectText === true ? LONG_PROJECT_DESCRIPTION : "Motorway frames.",
    thumbnail_asset_id: VISUAL.asset,
    thumbnail_hash: LONG_CONTENT_HASH,
    created_at: FIXED_ISO,
  };
}

/**
 * The list the reference image is taken of, four rows deep.
 *
 * One row would render the same components, and the picture would be seven parts
 * empty space to one part table — which is a reference that fails for reasons
 * nobody can read and protects a rhythm it never shows. Four rows put the row
 * height, the divider, the column alignment and the thumbnail column on screen
 * repeatedly, which is where a spacing regression actually becomes visible.
 *
 * Every field is a literal, including the dates: they differ from each other so
 * the sort column has something to be right about, and all of them sit beyond the
 * relative-age window so each prints a fixed string.
 */
function projectList(options: VisualOptions): Wire["ProjectPage"] {
  const rest: Wire["ProjectOut"][] = [
    {
      id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaab",
      name: "urban-intersections",
      description: "Junction footage, four cities.",
      thumbnail_asset_id: VISUAL.asset,
      thumbnail_hash: LONG_CONTENT_HASH,
      created_at: "2024-02-29T09:00:00Z",
    },
    {
      id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaac",
      name: "night-split-revalidation",
      description: null,
      thumbnail_asset_id: null,
      thumbnail_hash: null,
      created_at: "2024-02-11T09:00:00Z",
    },
    {
      id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaad",
      name: "tunnel-lighting",
      description: "Low-light frames held back from the main cohort.",
      thumbnail_asset_id: VISUAL.asset,
      thumbnail_hash: LONG_CONTENT_HASH,
      created_at: "2024-01-05T09:00:00Z",
    },
  ];
  return { items: [project(options), ...rest], total: 4 };
}

function schema(options: VisualOptions): Wire["SchemaVersionOut"] {
  const classes: Wire["SchemaVersionOut"]["classes"] =
    options.longClassName === true
      ? [
          { name: LONG_CLASS_NAME, geometries: ["bbox"], color: "#38bdf8", attributes: [] },
          { name: "vehicle", geometries: ["bbox"], color: "#f56200", attributes: [] },
        ]
      : [
          { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
          { name: "lane", geometries: ["polygon"], color: "#f56200", attributes: [] },
          { name: "pedestrian", geometries: ["bbox"], color: "#22c55e", attributes: [] },
        ];
  return { project_id: VISUAL.project, version: 4, classes };
}

function batch(): Wire["BatchOut"] {
  return {
    id: VISUAL.batch,
    project_id: VISUAL.project,
    name: "drive-01",
    state: "in_annotation",
    allowed_actions: batchActions("in_annotation"),
    promoted_asset_count: 0,
    parent_batch_id: null,
    pre_label_run: null,
    schema_version: 4,
    asset_count: 1,
    progress: { ...NO_PROGRESS, unannotated: 1, total: 1 },
  };
}

function connection(options: VisualOptions): Wire["ConnectionOut"] {
  const long = options.longModelReference === true;
  return {
    id: VISUAL.connection,
    name: long ? LONG_CONNECTION_NAME : "sam2-local",
    connection_type: "local",
    model_id: long ? LONG_MODEL_REFERENCE : "facebook/sam2.1-hiera-base-plus",
    model_revision: long ? LONG_MODEL_REVISION : "b73207",
    device: "cuda",
    precision: "fp16",
    endpoint_url: null,
    provider_id: "sam",
    credential_env: null,
    origin: "huggingface",
    setup_state: "ready",
    allowed_actions: ["download_weights", "update", "delete"],
    capabilities: ["point_suggest"],
    produces: ["bbox", "polygon"],
    download: null,
    integrity_check: null,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

/**
 * One frame's annotations, laid out on a grid so the picture is reproducible.
 *
 * The ids are real UUIDs, derived from the index rather than generated: the wire
 * declares `id` as `format: uuid` and the runtime checks the generated client runs
 * enforce it, so a readable `annotation-0007` is rejected before the screen sees
 * it — and a rejected page is indistinguishable from a slow one, because the
 * workspace simply never leaves "Loading the job".
 */
function annotations(options: VisualOptions): Wire["AnnotationPage"] {
  const count = options.annotationCount ?? 3;
  const names = ["vehicle", "lane", "pedestrian"] as const;
  const items: Wire["AnnotationOut"][] = Array.from({ length: count }, (_, index) => {
    const tail = String(index).padStart(12, "0");
    return {
      id: `a0000000-0000-4000-8000-${tail}`,
      asset_id: VISUAL.asset,
      job_id: VISUAL.job,
      label_class: names[index % names.length] as string,
      geometry: {
        type: "bbox",
        x: 24 + (index % 10) * 58,
        y: 24 + Math.floor(index / 10) * 44,
        width: 46,
        height: 32,
      },
      attributes: {},
      confidence: null,
      model_ref: null,
      provenance: "human",
      schema_version: 4,
    };
  });
  return { items, total: items.length };
}

/* ------------------------------------------------------------------ the server */

/**
 * Answers every request the reference surfaces make.
 *
 * The fallback at the end is deliberate and loud in the only way a fixture can be:
 * an unstubbed path gets an empty page rather than escaping to whatever is
 * listening, so a screen that starts asking something new renders empty instead of
 * rendering somebody's workspace.
 */
export async function serveVisualApi(page: Page, options: VisualOptions = {}): Promise<void> {
  await page.route("**/api/**", (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    const P = VISUAL.project;

    if (path === "/session") return route.fulfill({ json: { issued: false } });

    if (path === "/home") {
      return route.fulfill({
        json: {
          totals: { projects: 1, assets: 1, annotations: 3, releases: 0 },
          resume: null,
        } as unknown as Wire["HomeOut"],
      });
    }

    if (path === "/projects") {
      if (options.refusal !== undefined) {
        return route.fulfill({
          status: 500,
          json: { code: "CONSTRAINT_VIOLATED", message: options.refusal, detail: null },
        });
      }
      return route.fulfill({ json: projectList(options) satisfies Wire["ProjectPage"] });
    }
    if (path === `/projects/${P}`) return route.fulfill({ json: project(options) });
    if (path.endsWith("/schema")) return route.fulfill({ json: schema(options) });
    // The pinned version is asked for by more than one path shape - a batch
    // resolves its own pin, a project asks for the active one - so this matches on
    // the tail rather than on a route the caller happened to use when it was written.
    if (path.includes("/schema/versions/")) return route.fulfill({ json: schema(options) });
    if (path === `/projects/${P}/batches`) {
      return route.fulfill({ json: { items: [batch()], total: 1 } satisfies Wire["BatchPage"] });
    }
    if (path === `/projects/${P}/dataset`) {
      return route.fulfill({
        json: {
          id: VISUAL.dataset,
          project_id: P,
          name: "highway-perception",
          description: null,
        } as unknown as Wire["DatasetOut"],
      });
    }
    if (path === `/datasets/${VISUAL.dataset}/stats`) {
      return route.fulfill({
        json: {
          dataset_id: VISUAL.dataset,
          asset_count: 1,
          annotated_asset_count: 1,
          annotation_count: options.annotationCount ?? 3,
          classes: [],
        } as unknown as Wire["DatasetStatsOut"],
      });
    }
    if (path === `/projects/${P}/stats`) {
      return route.fulfill({
        json: {
          project_id: P,
          asset_count: 1,
          annotated_asset_count: 1,
          annotation_count: options.annotationCount ?? 3,
          class_count: schema(options).classes.length,
          annotated_pct: 100,
          classes: [],
          last_ingest_at: FIXED_ISO,
        } as unknown as Wire["ProjectStatsOut"],
      });
    }

    if (path.startsWith("/inference/connections")) {
      return route.fulfill({
        json: { items: [connection(options)], total: 1 } satisfies Wire["ConnectionPage"],
      });
    }
    if (path.startsWith("/inference/providers")) {
      return route.fulfill({ json: { items: [], total: 0 } as unknown as Wire["ProviderPage"] });
    }

    if (path === `/jobs/${VISUAL.job}`) {
      return route.fulfill({
        json: {
          id: VISUAL.job,
          batch_id: VISUAL.batch,
          state: "in_progress",
          asset_count: 1,
          allowed_actions: jobActions("in_progress"),
          assignee: null,
          pre_label_run: null,
        } satisfies Wire["JobOut"],
      });
    }
    if (path === `/jobs/${VISUAL.job}/progress`) {
      return route.fulfill({
        json: { ...NO_PROGRESS, unannotated: 1, total: 1 } satisfies Wire["ProgressCounts"],
      });
    }
    if (path === `/batches/${VISUAL.batch}`) return route.fulfill({ json: batch() });
    if (path === `/batches/${VISUAL.batch}/assets`) {
      return route.fulfill({
        json: {
          items: [
            {
              id: VISUAL.asset,
              project_id: P,
              modality: "image",
              content_hash: LONG_CONTENT_HASH,
              width: 640,
              height: 480,
              format: "png",
              source_id: null,
              frame_index: 0,
              frame_timestamp: null,
              thumbnail_hash: LONG_CONTENT_HASH,
              ingested_at: FIXED_ISO,
              job_id: VISUAL.job,
              progress: "annotated",
              allowed_actions: assetActions("annotated"),
              annotation_count: options.annotationCount ?? 3,
              min_confidence: null,
            },
          ],
          total: 1,
        } satisfies Wire["BatchAssetPage"],
      });
    }

    if (path.endsWith("/annotations")) return route.fulfill({ json: annotations(options) });
    if (path.endsWith("/content") || path.endsWith("/thumbnail")) {
      return route.fulfill({ contentType: "image/png", body: PIXEL });
    }

    return route.fulfill({ json: { items: [], total: 0 } });
  });
}

/* ------------------------------------------------------------------ navigation */

/** Through the token gate and onto `path`, with the fixture already serving. */
export async function openVisual(
  page: Page,
  path: string,
  options: VisualOptions = {},
): Promise<void> {
  await serveVisualApi(page, options);
  await page.goto(path);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
}

/** The dark theme, applied the way the stylesheet expects to find it. */
export async function useDark(page: Page): Promise<void> {
  await page.evaluate(() => document.documentElement.classList.add("dark"));
}

/**
 * Both bundled families, resolved before anything is captured.
 *
 * A screenshot taken while Inter or Geist is still loading is a screenshot of the
 * fallback stack, and it differs from the next one by a whole typeface.
 */
export async function fontsReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

/**
 * The page is settled enough to photograph: fonts resolved and no image still
 * decoding. Both are awaited rather than slept through, per `e2e_discipline`.
 */
export async function readyForCapture(page: Page): Promise<void> {
  await fontsReady(page);
  await page.evaluate(async () => {
    const images = [...document.querySelectorAll("img")];
    await Promise.all(images.filter((i) => !i.complete).map((i) => i.decode().catch(() => {})));
  });
}

/** The page must not scroll sideways — Phase 7's floor, asserted here too. */
export async function expectNoPageOverflow(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const de = document.documentElement;
    return de.scrollWidth - de.clientWidth;
  });
  expect(overflow, `${where} scrolls the document sideways`).toBeLessThanOrEqual(0);
}
