/**
 * `annotate.spec.ts`'s stubbed API, lifted out so a second spec can drive the same
 * job without duplicating the route table.
 *
 * Everything is routed under `/api/`, which is where the app sends requests in
 * development. Routing the bare paths would also intercept the *document*
 * navigation, and the failure reads as "the shell disappeared".
 */

import { expect, type Page, type Request } from "@playwright/test";
import { assetActions, batchActions, jobActions, type Wire } from "./_wire";

export const PROJECT = "11111111-1111-4111-8111-111111111111";
export const BATCH = "22222222-2222-4222-8222-222222222222";
export const JOB = "33333333-3333-4333-8333-333333333333";

const SCHEMA = {
  project_id: PROJECT,
  version: 3,
  classes: [
    { name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] },
    { name: "lane", geometries: ["polygon"], color: "#f97316", attributes: [] },
    // A second **bbox** class, so a reassignment has somewhere to land.
    // It adds no tool — the palette is per geometry — and one hotkey row, which
    // the shortcut-sheet scenario below counts.
    { name: "pedestrian", geometries: ["bbox"], color: "#22c55e", attributes: [] },
  ],
} satisfies Wire["SchemaVersionOut"];

function asset(
  index: number,
  progress: Wire["AssetProgress"],
  batchState: Wire["BatchState"] = "in_annotation",
  jobState: Wire["AnnotationJobState"] = "in_progress",
): Wire["BatchAssetOut"] {
  return {
    id: `asset-${index}`,
    project_id: PROJECT,
    modality: "image",
    content_hash: `${index}`.repeat(8) + "abcdef",
    width: 640,
    height: 480,
    format: "png",
    source_id: null,
    frame_index: index,
    frame_timestamp: null,
    thumbnail_hash: "ab".repeat(32),
    ingested_at: null,
    job_id: JOB,
    progress,
    // Threaded from the batch **and from the job**, because that is what the
    // server does: `asset_actions` returns `[]` for every frame of a batch that
    // is not `in_annotation` and for every frame of a job that has been
    // completed, whatever the frame's own progress is. Without the first a mock
    // would declare `annotate` on a completed batch; without the second it would
    // declare it on a finished job — and since the job's state is what the
    // Finish press moves, that is the whole of the live transition below.
    allowed_actions: assetActions(progress, { batchState, jobState }),
    annotation_count: 0,
    min_confidence: null,
  };
}

/** A 1x1 PNG, so the canvas has real pixels to lay out. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * The stub's progress, which a `PUT` actually moves.
 *
 * Every other piece of this stub is static, and that is right for a suite about
 * what the page *sends*. Progress is the exception because the skip claims are
 * about what the page *shows afterwards*: a `PUT` the server accepts and a listing that
 * keeps answering the old value is exactly the state the defect looked like from
 * the user's side, and a static stub would reproduce the bug rather than the fix.
 */
export function progressStore(
  seed: Readonly<Record<string, Wire["AssetProgress"]>>,
): Map<string, Wire["AssetProgress"]> {
  return new Map(Object.entries(seed));
}

/**
 * The lifecycle half of the stub: batch and job state that the two `start`
 * POSTs actually move, on `progressStore`'s reasoning. The default is everything
 * already open; the
 * approved-batch scenarios are claims about the moves the page itself makes on
 * open, and a stub whose state never moved would reproduce the bug rather than
 * the fix.
 */
export interface Lifecycle {
  batch: Wire["BatchState"];
  job: Wire["AnnotationJobState"];
  /** When set, `POST /batches/{id}/start` refuses 409 with this code instead. */
  refuseBatchStart?: string;
  /**
   * When set, `POST /jobs/{id}/start` refuses 409 with this code instead.
   *
   * The stale-read case, made deterministic: the client's cached `JobOut`
   * says `pending` and declares `start`, while the server's job has already been
   * started. In a real browser that window is opened by an invalidation whose
   * refetch has not landed yet, which is why it only ever appeared on a loaded
   * CI runner. Here it is simply what the stub answers, every time.
   */
  refuseJobStart?: string;
  /** When set, every `PUT .../progress` refuses 409 with this code instead. */
  refuseProgress?: string;
  /**
   * When set, every write to `/annotations` refuses 409 with this code and this
   * message.
   *
   * The message is the interesting half: a code with no entry in `REFUSAL_PROSE`
   * falls through to the server's own wording, which is how an install command —
   * or a model reference — reaches a person verbatim. It is also the only way to
   * put an arbitrarily long unbroken token on screen.
   */
  refuseSave?: { code: string; message: string };
  /** When set, `POST /jobs/{id}/complete` refuses 409 with this code instead. */
  refuseJobComplete?: string;
  /**
   * Whether every asset is settled, which is what makes the job declare
   * `complete`. Defaults true; the withheld Finish-job scenarios set it false.
   */
  jobSettled?: boolean;
}

export function openedWorld(): Lifecycle {
  return { batch: "in_annotation", job: "in_progress" };
}

/**
 * How many classes the served schema declares.
 *
 * Only the classes-region scenarios pass one — everything else wants the three
 * `SCHEMA` names its assertions are written against. Padding rather than
 * replacing, so a scenario asking for twelve still gets `vehicle` and `lane`
 * where it expects them.
 */
export interface SchemaSize {
  readonly classes?: number;
}

function schemaOfSize(size: SchemaSize | undefined): Wire["SchemaVersionOut"] {
  const want = size?.classes ?? SCHEMA.classes.length;
  if (want <= SCHEMA.classes.length) return SCHEMA;
  return {
    ...SCHEMA,
    classes: [
      ...SCHEMA.classes,
      ...Array.from(
        { length: want - SCHEMA.classes.length },
        (_unused, index): Wire["SchemaVersionOut"]["classes"][number] => ({
          name: `filler-${index + 1}`,
          geometries: ["bbox"],
          color: "#94a3b8",
          attributes: [],
        }),
      ),
    ],
  };
}

/**
 * A workspace with a segmenter in it, for the one scenario that needs the
 * suggest tool to actually work.
 *
 * Off by default, because the interesting answer for every other test here is
 * the empty list — that is the state the tool's explanation panel exists for,
 * and it is what a workspace that has never been to the Models page is in.
 */
const READY_SAM = {
  id: "66666666-6666-4666-8666-666666666666",
  name: "local sam",
  connection_type: "local",
  model_id: "facebook/sam2-hiera-base-plus",
  model_revision: "main",
  device: "cuda",
  precision: "fp16",
  endpoint_url: null,
  provider_id: "sam",
  credential_env: null,
  origin: "huggingface",
  setup_state: "ready",
  allowed_actions: [],
  capabilities: ["point_suggest"],
  produces: ["bbox", "polygon"],
  download: null,
  integrity_check: null,
  created_at: "2026-08-08T00:00:00Z",
  updated_at: "2026-08-08T00:00:00Z",
} satisfies Wire["ConnectionOut"];

export async function serveApi(
  page: Page,
  sent: Request[],
  progress: Map<string, Wire["AssetProgress"]> = progressStore({
    "asset-1": "unannotated",
    "asset-2": "annotated",
  }),
  lifecycle: Lifecycle = openedWorld(),
  size?: SchemaSize,
  seeded: readonly Wire["AnnotationOut"][] = [],
  suggestible = false,
): Promise<void> {
  const stored: Wire["AnnotationOut"][] = [...seeded];
  const batchBody = (): Wire["BatchOut"] => ({
    id: BATCH,
    project_id: PROJECT,
    name: "drive-01",
    state: lifecycle.batch,
    schema_version: 3,
    asset_count: 2,
    allowed_actions: batchActions(lifecycle.batch),
    promoted_asset_count: 0,
    parent_batch_id: null,
    pre_label_run: null,
    progress: {
      unannotated: 2,
      pre_labeled: 0,
      annotated: 0,
      skipped: 0,
      review_pending: 0,
      accepted: 0,
      total: 2,
    },
  });
  const jobBody = (): Wire["JobOut"] => ({
    id: JOB,
    batch_id: BATCH,
    state: lifecycle.job,
    asset_count: 2,
    allowed_actions: jobActions(lifecycle.job, {
      batchState: lifecycle.batch,
      settled: lifecycle.jobSettled ?? true,
    }),
    assignee: null,
    pre_label_run: null,
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");

    // Answered before anything is recorded: every page load asks whether this
    // server will sign the browser in by itself, and here it will not —
    // this suite is about the annotation page, and it reaches it with a token.
    if (path === "/session") return route.fulfill({ json: { issued: false } });

    sent.push(request);

    if (path === `/jobs/${JOB}/start` && request.method() === "POST") {
      if (lifecycle.refuseJobStart !== undefined) {
        return route.fulfill({
          status: 409,
          json: { code: lifecycle.refuseJobStart, message: "the kernel's own wording" },
        });
      }
      lifecycle.job = "in_progress";
      return route.fulfill({ json: jobBody() });
    }
    if (path === `/jobs/${JOB}/complete` && request.method() === "POST") {
      if (lifecycle.refuseJobComplete !== undefined) {
        return route.fulfill({
          status: 409,
          json: { code: lifecycle.refuseJobComplete, message: "the kernel's own wording" },
        });
      }
      lifecycle.job = "completed";
      return route.fulfill({ json: jobBody() });
    }
    if (path === `/jobs/${JOB}`) {
      return route.fulfill({ json: jobBody() });
    }
    if (path === `/batches/${BATCH}/start` && request.method() === "POST") {
      if (lifecycle.refuseBatchStart !== undefined) {
        return route.fulfill({
          status: 409,
          json: { code: lifecycle.refuseBatchStart, message: "the stub refuses" },
        });
      }
      lifecycle.batch = "in_annotation";
      return route.fulfill({ json: batchBody() });
    }
    if (path === `/batches/${BATCH}`) {
      return route.fulfill({ json: batchBody() });
    }
    if (path.endsWith("/schema/versions/3")) return route.fulfill({ json: schemaOfSize(size) });
    if (path.endsWith("/assets") && path.startsWith("/batches")) {
      return route.fulfill({
        json: {
          items: [
            asset(1, progress.get("asset-1") ?? "unannotated", lifecycle.batch, lifecycle.job),
            asset(2, progress.get("asset-2") ?? "annotated", lifecycle.batch, lifecycle.job),
          ],
          total: 2,
        } satisfies Wire["BatchAssetPage"],
      });
    }
    if (path.endsWith("/annotations") && request.method() === "GET") {
      // **Per asset**, because the route is `/jobs/{id}/assets/{asset_id}/annotations`
      // and that is what it answers. It used to hand back everything stored, which
      // was harmless only while nothing was saved before navigating — the moment
      // something was, the next frame's document was built from an annotation
      // belonging to the previous one and `createDocument` refuses it outright.
      // Cross-frame paste is what walks that path.
      const assetId = path.split("/").at(-2) ?? "";
      const mine = stored.filter((one) => one.asset_id === assetId);
      return route.fulfill({
        json: { items: mine, total: mine.length } satisfies Wire["AnnotationPage"],
      });
    }
    if (path.endsWith("/annotations") && request.method() !== "GET" && lifecycle.refuseSave !== undefined) {
      return route.fulfill({ status: 409, json: lifecycle.refuseSave });
    }
    if (path.endsWith("/annotations") && request.method() === "POST") {
      // Kept, and stamped with a server id — the kernel mints its own and the page
      // refetches to learn them (`jobQueries.ts`). A stub that answered an empty
      // list would leave the page permanently dirty and "Saved" unreachable, which
      // says nothing about the product.
      const body = JSON.parse(request.postData() ?? "[]") as Wire["AnnotationCreate"][];
      body.forEach((one, at) =>
        stored.push({
          ...one,
          id: `server-${stored.length + at}`,
          // `asset_id` is the client's own, not a literal: `AnnotationCreate`
          // carries it and the kernel writes the label against it.
          schema_version: 3,
          attributes: {},
          provenance: "human",
          model_ref: null,
          confidence: null,
          job_id: null,
        }),
      );
      const written = stored.filter((one) => one.asset_id === body[0]?.asset_id);
      return route.fulfill({
        status: 201,
        json: { items: written, total: written.length } satisfies Wire["AnnotationPage"],
      });
    }
    if (path.endsWith("/progress") && request.method() === "GET") {
      // **Derived from the same map the PUTs move**, not a frozen literal. It
      // was a literal — `unannotated: 2, annotated: 0` — which meant the counts
      // described a job nobody had touched however far the test had walked it,
      // and any claim about the readout was a claim about the stub. That is the
      // habit worth making impossible: a mock that answers something the
      // endpoint would never have sent is worse than no mock.
      const states = [...progress.values()];
      const count = (of: Wire["AssetProgress"]): number =>
        states.filter((one) => one === of).length;
      return route.fulfill({
        json: {
          unannotated: count("unannotated"),
          pre_labeled: count("pre_labeled"),
          annotated: count("annotated"),
          skipped: count("skipped"),
          review_pending: count("review_pending"),
          accepted: count("accepted"),
          total: states.length,
        } satisfies Wire["ProgressCounts"],
      });
    }
    if (path.endsWith("/progress") && request.method() === "PUT") {
      if (lifecycle.refuseProgress !== undefined) {
        return route.fulfill({
          status: 409,
          json: { code: lifecycle.refuseProgress, message: "the kernel's own wording" },
        });
      }
      const assetId = path.split("/").at(-2) ?? "";
      const body = JSON.parse(request.postData() ?? "{}") as {
        progress?: Wire["AssetProgress"];
      };
      if (body.progress !== undefined) progress.set(assetId, body.progress);
      // `AssetProgressOut`, not `{}`. The route answers where the asset now is, and a
      // stub that answered an empty object was describing a response the endpoint has
      // never sent.
      return route.fulfill({
        status: 200,
        json: {
          asset_id: assetId,
          progress: progress.get(assetId) ?? "unannotated",
        } satisfies Wire["AssetProgressOut"],
      });
    }
    if (path.endsWith("/content") || path.endsWith("/thumbnail")) {
      return route.fulfill({ contentType: "image/png", body: PIXEL });
    }
    if (path === "/projects") {
      return route.fulfill({ json: { items: [], total: 0 } satisfies Wire["ProjectPage"] });
    }
    // The suggest tool's own read. Empty is the interesting answer
    // here: it is the state the panel's explanation exists for, and it is what a workspace
    // that has never been to the Models page is in.
    if (path === "/inference/connections") {
      const items = suggestible ? [READY_SAM] : [];
      return route.fulfill({
        json: { items, total: items.length } satisfies Wire["ConnectionPage"],
      });
    }
    if (path === "/inference/suggest" && request.method() === "POST") {
      // `SuggestionOut`, in full: the score rides on the answer, the shapes are
      // a list, each carries the contour it was reduced from, and `parameters`
      // declares which settings apply to this kind. Every field is required, and
      // a shape missing one is refused by the generated runtime check — which
      // reads as "the server answered something this app does not recognise" and
      // looks nothing like a stub bug.
      return route.fulfill({
        json: {
          model_ref: "facebook/sam2-hiera-base-plus@main",
          confidence: 0.91,
          regions: [
            {
              geometry: { type: "bbox", x: 100, y: 100, width: 80, height: 60 },
              contour: [],
            },
          ],
          applied: { tolerance: 1 },
          // A box class, so the wire names no settings at all — which is how the
          // editor is told to render no adjustments section (#557).
          parameters: [],
        } satisfies Wire["SuggestionOut"],
      });
    }
    return route.fulfill({ status: 500, json: { code: "NO_STUB", message: path } });
  });
}

export async function openJob(
  page: Page,
  sent: Request[],
  progress?: Map<string, Wire["AssetProgress"]>,
  lifecycle?: Lifecycle,
  size?: SchemaSize,
  seeded?: readonly Wire["AnnotationOut"][],
  suggestible?: boolean,
): Promise<void> {
  await serveApi(page, sent, progress, lifecycle, size, seeded, suggestible);
  await page.goto(`/jobs/${JOB}`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("annotation-page")).toBeVisible();
}
