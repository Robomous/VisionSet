/**
 * The annotation page, against a stubbed API.
 *
 * The cycle suite drives the whole product against a **real server**; this suite is
 * narrower and earlier: it asserts the page's own contract — what it reads, what a save sends,
 * and what the top bar does — with the API held still, so a failure names the page
 * rather than the stack under it.
 *
 * Everything is routed under `/api/`, which is where the app sends requests in
 * development. Routing the bare paths would also intercept the *document*
 * navigation, and the failure reads as "the shell disappeared".
 */

import { expect, test, type Page, type Request } from "@playwright/test";
import { assetActions, batchActions, jobActions } from "./_wire";
import { expectNothingToSave, expectProgress, openOverflow, saveNow, zoomWheel } from "./_frame";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";

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
};

function asset(
  index: number,
  progress: string,
  batchState = "in_annotation",
  jobState = "in_progress",
): Record<string, unknown> {
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
function progressStore(seed: Readonly<Record<string, string>>): Map<string, string> {
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
interface Lifecycle {
  batch: string;
  job: string;
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

function openedWorld(): Lifecycle {
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
interface SchemaSize {
  readonly classes?: number;
}

function schemaOfSize(size: SchemaSize | undefined): typeof SCHEMA {
  const want = size?.classes ?? SCHEMA.classes.length;
  if (want <= SCHEMA.classes.length) return SCHEMA;
  return {
    ...SCHEMA,
    classes: [
      ...SCHEMA.classes,
      ...Array.from({ length: want - SCHEMA.classes.length }, (_unused, index) => ({
        name: `filler-${index + 1}`,
        geometries: ["bbox"],
        color: "#94a3b8",
        attributes: [],
      })),
    ],
  };
}

/**
 * A workspace with a segmenter in it, for the one scenario that needs the
 * suggest tool to actually work.
 *
 * Off by default, because the interesting answer for every other test here is
 * the empty list — that is the state the tool's explanation panel exists for,
 * and it is what a workspace that has never been to the Inference section is in.
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
  setup_state: "ready",
  allowed_actions: [],
  capabilities: ["point_suggest"],
  download: null,
  integrity_check: null,
  created_at: "2026-08-08T00:00:00Z",
  updated_at: "2026-08-08T00:00:00Z",
};

async function serveApi(
  page: Page,
  sent: Request[],
  progress: Map<string, string> = progressStore({ "asset-1": "unannotated", "asset-2": "annotated" }),
  lifecycle: Lifecycle = openedWorld(),
  size?: SchemaSize,
  seeded: readonly Record<string, unknown>[] = [],
  suggestible = false,
): Promise<void> {
  const stored: Record<string, unknown>[] = [...seeded];
  const batchBody = (): Record<string, unknown> => ({
    id: BATCH,
    project_id: PROJECT,
    name: "drive-01",
    state: lifecycle.batch,
    schema_version: 3,
    asset_count: 2,
    allowed_actions: batchActions(lifecycle.batch),
    promoted_asset_count: 0,
    parent_batch_id: null,
    progress: {
      unannotated: 2,
      annotated: 0,
      skipped: 0,
      review_pending: 0,
      accepted: 0,
      total: 2,
    },
  });
  const jobBody = (): Record<string, unknown> => ({
    id: JOB,
    batch_id: BATCH,
    state: lifecycle.job,
    asset_count: 2,
    allowed_actions: jobActions(lifecycle.job, {
      batchState: lifecycle.batch,
      settled: lifecycle.jobSettled ?? true,
    }),
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
        },
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
      return route.fulfill({ json: { items: mine, total: mine.length } });
    }
    if (path.endsWith("/annotations") && request.method() !== "GET" && lifecycle.refuseSave !== undefined) {
      return route.fulfill({ status: 409, json: lifecycle.refuseSave });
    }
    if (path.endsWith("/annotations") && request.method() === "POST") {
      // Kept, and stamped with a server id — the kernel mints its own and the page
      // refetches to learn them (`jobQueries.ts`). A stub that answered an empty
      // list would leave the page permanently dirty and "Saved" unreachable, which
      // says nothing about the product.
      const body = JSON.parse(request.postData() ?? "[]") as Record<string, unknown>[];
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
      return route.fulfill({ status: 201, json: { items: written, total: written.length } });
    }
    if (path.endsWith("/progress") && request.method() === "GET") {
      // **Derived from the same map the PUTs move**, not a frozen literal. It
      // was a literal — `unannotated: 2, annotated: 0` — which meant the counts
      // described a job nobody had touched however far the test had walked it,
      // and any claim about the readout was a claim about the stub. That is the
      // habit worth making impossible: a mock that answers something the
      // endpoint would never have sent is worse than no mock.
      const states = [...progress.values()];
      const count = (of: string): number => states.filter((one) => one === of).length;
      return route.fulfill({
        json: {
          unannotated: count("unannotated"),
          annotated: count("annotated"),
          skipped: count("skipped"),
          review_pending: count("review_pending"),
          accepted: count("accepted"),
          total: states.length,
        },
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
      const body = JSON.parse(request.postData() ?? "{}") as { progress?: string };
      if (body.progress !== undefined) progress.set(assetId, body.progress);
      // `AssetProgressOut`, not `{}`. The route answers where the asset now is, and a
      // stub that answered an empty object was describing a response the endpoint has
      // never sent.
      return route.fulfill({
        status: 200,
        json: { asset_id: assetId, progress: progress.get(assetId) ?? "unannotated" },
      });
    }
    if (path.endsWith("/content") || path.endsWith("/thumbnail")) {
      return route.fulfill({ contentType: "image/png", body: PIXEL });
    }
    if (path === "/projects") return route.fulfill({ json: { items: [], total: 0 } });
    // The suggest tool's own read. Empty is the interesting answer
    // here: it is the state the panel's explanation exists for, and it is what a workspace
    // that has never been to the Inference section is in.
    if (path === "/inference/connections") {
      const items = suggestible ? [READY_SAM] : [];
      return route.fulfill({ json: { items, total: items.length } });
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
          applied: { detail: "balanced" },
          // A box class, so the wire names no settings at all — which is how the
          // editor is told to render no adjustments section (#557).
          parameters: [],
        },
      });
    }
    return route.fulfill({ status: 500, json: { code: "NO_STUB", message: path } });
  });
}

async function openJob(
  page: Page,
  sent: Request[],
  progress?: Map<string, string>,
  lifecycle?: Lifecycle,
  size?: SchemaSize,
  seeded?: readonly Record<string, unknown>[],
  suggestible?: boolean,
): Promise<void> {
  await serveApi(page, sent, progress, lifecycle, size, seeded, suggestible);
  await page.goto(`/jobs/${JOB}`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("annotation-page")).toBeVisible();
}

test("the page loads the job's assets, its pinned schema and its progress", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await expect(page.getByTestId("asset-position")).toContainText("1/2");
  // One of the two frames is past `unannotated` — the fixture's second one is
  // `annotated`. This asserted `0 / 2` against a **frozen** progress stub that
  // described a job nobody had touched; the stub is derived from the same map the
  // PUTs move now, so the number is the one a server would have sent.
  await expect(page.getByTestId("job-progress")).toHaveText("1 / 2 annotated");

  // The **pinned** version, not the project's active schema. A batch pins at
  // approval and never moves, so asking for the active one is asking a different
  // question — and the answer would offer classes the API then refuses.
  const paths = sent.map((r) => new URL(r.url()).pathname);
  expect(paths.some((p) => p.endsWith("/schema/versions/3"))).toBe(true);
  expect(paths.some((p) => p.endsWith("/schema"))).toBe(false);

  // …and the asset's pixels came through the client, not an <img src>: every route
  // but /health needs `Authorization: Bearer`, which an <img> cannot send.
  const content = sent.find((r) => r.url().endsWith("/content"));
  expect(await content?.headerValue("authorization")).toBe("Bearer a-token");
});

/**
 * The flow verb's whole claim: it **saves first, then advances**.
 *
 * This is the assertion jsdom structurally cannot make. Making a document dirty
 * means drawing, drawing means a canvas with a real size, and jsdom's
 * `getBoundingClientRect` returns all zeros — which is what keeps every ordering
 * claim on this page in a browser. A component test clicking the button over a clean document
 * would pass with the commit deleted.
 *
 * The order is read off the request log rather than off the screen, because
 * "the boxes are still there on frame 2" is what a *lost* save also looks like
 * until the next reload.
 */
test("Save and next stores the frame before it moves off it", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("save-state")).toContainText("unsaved");
  // The label is the promise, and here it is one the press will keep.
  await expect(page.getByTestId("save-and-next")).toContainText("Save and next");

  await page.getByTestId("save-and-next").click();

  await expect(page.getByTestId("asset-position")).toContainText("2/2");
  const post = sent.find((r) => r.method() === "POST" && r.url().endsWith("/annotations"));
  expect(post).toBeDefined();
  const body = JSON.parse(post?.postData() ?? "[]") as Record<string, unknown>[];
  expect(body).toHaveLength(1);
  // Written against the frame it was drawn on, which is the half an advance-then-
  // save would get wrong while still looking identical on screen.
  expect(body[0]["asset_id"]).toBe("asset-1");
  await expectNothingToSave(page);
});

/**
 * Decision 2's degradation, in the browser because that is where the label's
 * *other* half lives — the same button reads `Save and next` a drag later.
 */
test("the flow verb reads Next on an untouched frame and Save and next once it carries work", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await expect(page.getByTestId("save-and-next")).toHaveText(/^Next/);

  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByTestId("save-and-next")).toContainText("Save and next");
});

/**
 * `enter` is two meanings that never overlap, and this is the one the table does
 * not hold: with nothing being drawn, the ring close is dead and the adapter
 * reads the press as the flow verb.
 *
 * Both halves in one scenario on purpose — a test of the substitution alone would
 * pass over an implementation that had stopped closing polygons.
 */
test("Enter closes a ring while one is open, and finishes the frame when none is", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  const at = (fx: number, fy: number): { x: number; y: number } => ({
    x: box.x + box.width * fx,
    y: box.y + box.height * fy,
  });
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("2");
  for (const [fx, fy] of [
    [0.3, 0.3],
    [0.5, 0.3],
    [0.4, 0.5],
  ] as const) {
    const point = at(fx, fy);
    await page.mouse.click(point.x, point.y);
  }

  // Still on frame 1: the ring took the press.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("object-total")).toHaveText("1 object");
  await expect(page.getByTestId("asset-position")).toContainText("1/2");

  // Nothing in progress now, so the same key means the button beside it.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("asset-position")).toContainText("2/2");
});

/**
 * The end of the job, where the filled slot changes hands (decision 3).
 *
 * The claim is about `bg-primary` rather than about a marker attribute, because
 * "exactly one filled control" is a statement about what the bar looks like — a
 * `data-` flag nobody styles from would pass over two coral buttons.
 */
test("the last frame hands the filled slot to Finish job, and offers no next", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "annotated", "asset-2": "annotated" }));

  await expect(page.getByTestId("save-and-next")).toBeVisible();
  await page.getByTestId("next-asset").click();
  await expect(page.getByTestId("asset-position")).toContainText("2/2");

  await expect(page.getByTestId("save-and-next")).toHaveCount(0);
  const filled = page.locator("header button.bg-primary");
  await expect(filled).toHaveCount(1);
  await expect(filled).toHaveAttribute("data-testid", "finish-job");
});

/**
 * The navigation cluster's geometry.
 *
 * **In chromium and nowhere else.** jsdom's `getBoundingClientRect` returns all
 * zeros, so every claim below — centred, unmoved, unwrapped — is one a component
 * test would report as passing over a bar laid out any way at all. The cluster's
 * *membership* is asserted in `topBar.test.tsx`, which is what jsdom can see.
 */
test("the navigation cluster sits on the bar's centre and stays there", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const header = page.locator("header").first();
  const cluster = page.getByTestId("frame-navigation");

  const headerBox = (await header.boundingBox())!;
  const before = (await cluster.boundingBox())!;
  const headerCentre = headerBox.x + headerBox.width / 2;
  // Half a pixel of tolerance, because a grid track can land on a subpixel — but
  // not more: the whole point of `1fr auto 1fr` over two flex spacers is that the
  // answer is arithmetic rather than leftover.
  expect(Math.abs(before.x + before.width / 2 - headerCentre)).toBeLessThan(0.5);

  // Now make both side zones much wider than their contents ever are, without
  // touching anything in the cluster. A bar balanced on what the sides left over
  // would move here; one anchored on the header's centre cannot.
  await page.evaluate(() => {
    const identity = document.querySelector('[data-testid="asset-identity"]')!;
    identity.textContent = `${"a-very-long-frame-identifier-".repeat(6)}end`;
    const progress = document.querySelector('[data-testid="job-progress"]')!;
    progress.textContent = `${"9".repeat(60)} / 9999999999 annotated`;
  });

  const after = (await cluster.boundingBox())!;
  expect(after.x).toBeCloseTo(before.x, 1);
  expect(after.width).toBeCloseTo(before.width, 1);
  // And the sides gave way rather than pushing: neither zone now reaches into
  // the cluster's column.
  const identityBox = (await page.getByTestId("asset-identity").boundingBox())!;
  expect(identityBox.x + identityBox.width).toBeLessThanOrEqual(after.x + 1);
});

/**
 * The width the class field gives back.
 *
 * The right zone measures 460px of demand against 366px offered at 1440, which
 * pushes `Save and stay` behind `2xl` and the review move behind `xl` — below
 * those widths they live only in the overflow. Keeping the class field out of the
 * cluster is what pays that back, so
 * this asserts the outcome rather than the patch: both are buttons on the bar at
 * the viewport the suite runs at, and the overflow trigger is at its full size
 * rather than squashed by a zone that had run out of room.
 */
test("both reabsorbable controls are on the bar again at 1440", async ({ page }) => {
  const sent: Request[] = [];
  // An `annotated` frame, because that is the state that declares
  // `submit_for_review` — the heavier of the two, and the one whose presence made
  // the zone overflow in the first place.
  await openJob(page, sent, progressStore({ "asset-1": "annotated", "asset-2": "annotated" }));

  await expect(page.getByTestId("save-and-stay")).toBeVisible();
  await expect(page.getByTestId("submit-for-review")).toBeVisible();
  // Nothing was reabsorbed, so the overflow holds neither copy.
  await expect(page.getByTestId("menu-save")).toHaveCount(0);

  // The squash that reported the overflow before it was visible: `more-actions`
  // measured 16px against its declared 36 while the zone was over-subscribed.
  const overflow = (await page.getByTestId("more-actions").boundingBox())!;
  expect(overflow.width).toBeGreaterThanOrEqual(36);
});

test("the cluster is the same width whichever resolution verb the frame offers", async ({
  page,
}) => {
  // `Skip` is 104px and `Un-skip` 96px, so without a floor a skipped frame pulls
  // the whole cluster 4px sideways — and the cluster is centred, so that moves
  // the arrows under a cursor that has not moved. The class field's reservation
  // used to be the cluster's width; these two floors are what replace it.
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "annotated", "asset-2": "skipped" }));

  const cluster = page.getByTestId("frame-navigation");
  const before = (await cluster.boundingBox())!;

  await page.getByTestId("next-asset").click();
  await expect(page.getByTestId("unskip")).toBeVisible();

  const after = (await cluster.boundingBox())!;
  expect(after.width).toBeCloseTo(before.width, 1);
  expect(after.x).toBeCloseTo(before.x, 1);
});

/**
 * The side panel's two regions, in a browser because none of it is
 * visible to jsdom.
 *
 * `getBoundingClientRect` answers zero for everything there, and `scrollHeight`
 * against `clientHeight` — which is what "scrolls internally" means — is exactly
 * the comparison that needs a layout engine. The height *rule* is arithmetic and
 * is asserted in `classRegion.test.tsx`; what is asserted here is that the
 * arithmetic reaches the screen.
 */
test("the panel stacks a sized classes region over an objects region that takes the rest", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const panel = (await page.getByTestId("annotator-panel").boundingBox())!;
  const classes = (await page.getByTestId("class-region").boundingBox())!;
  const objects = (await page.getByTestId("objects-region").boundingBox())!;

  // Stacked, not side by side, and in that order.
  expect(classes.y).toBeLessThan(objects.y);
  expect(Math.round(classes.width)).toBe(Math.round(objects.width));
  // The objects region reaches the bottom of the panel: it is what absorbs the
  // remainder, which is the half of the split that has no number of its own.
  // Within the panel's own `p-2`, and to the pixel rather than the subpixel: what
  // is being asserted is *reaches the bottom*, not a rounding mode.
  expect(Math.abs(objects.y + objects.height - (panel.y + panel.height - 8))).toBeLessThan(2);
  // And the panel did not grow to fit its contents — the whole point of the cap.
  expect(panel.height).toBeLessThanOrEqual(page.viewportSize()!.height);
});

test("the two regions scroll independently, neither pushing the other", async ({ page }) => {
  const sent: Request[] = [];
  // Twelve classes is past the eight-row cap, so the classes list has surplus to
  // scroll; the objects list has its own scroller whatever is drawn in it.
  await openJob(page, sent, undefined, undefined, { classes: 12 });

  const classList = page.getByTestId("class-list");
  const objectScroller = page.getByTestId("objects-scroller");

  const overflowing = await classList.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  expect(overflowing).toBe(true);

  // Scrolling one moves nothing in the other — two scrollers, not one panel that
  // scrolls as a whole.
  const objectsTopBefore = await objectScroller.evaluate((el) => el.scrollTop);
  await classList.evaluate((el) => {
    el.scrollTop = 200;
  });
  expect(await classList.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await objectScroller.evaluate((el) => el.scrollTop)).toBe(objectsTopBefore);

  // The header and the filter are not rows and do not scroll away with them.
  await expect(page.getByTestId("class-filter")).toBeVisible();
  await expect(page.getByTestId("class-count")).toBeVisible();
});

test("a digit arms the class the panel says it will, whatever the filter shows", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // Filter down to the second class, then press `1` — which belongs to the
  // first, and is not on screen. Schema order, never the filtered order.
  await page.getByTestId("class-filter").fill("lane");
  await expect(page.getByTestId("class-row-vehicle")).toHaveCount(0);

  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");

  await expect(page.getByTestId("tool-bbox")).toHaveAttribute("data-active", "true");
  await page.getByTestId("class-filter").fill("");
  await expect(page.getByTestId("class-row-vehicle")).toHaveAttribute("data-selected", "true");
});

test("the cluster never wraps or drops a control, down to the narrowest supported width", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // 768 is `ANNOTATOR_MIN_VIEWPORT_PX` — one pixel below it the page renders the
  // too-narrow explanation instead, so this is the tightest the bar is ever asked
  // to be. The side zones are what absorb it; the cluster is the `auto` track.
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(page.getByTestId("annotation-page")).toBeVisible();

  const header = (await page.locator("header").first().boundingBox())!;
  const cluster = (await page.getByTestId("frame-navigation").boundingBox())!;
  // One row, not two: a wrapped cluster would be taller than the 44px bar.
  expect(cluster.height).toBeLessThanOrEqual(header.height);

  for (const testId of ["open-gallery", "prev-asset", "asset-position", "next-asset", "skip"]) {
    await expect(page.getByTestId(testId), testId).toBeVisible();
  }
  await expect(page.getByTestId("save-and-next")).toBeVisible();
});

test("Save is inert until something changes, then sends exactly the new annotation", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await expectNothingToSave(page);
  await expect(page.getByTestId("save-state")).toContainText("Saved");

  // Draw one box: digit 1 is `vehicle`, the pinned schema's first class.
  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByTestId("save-state")).toContainText("unsaved");
  await expect(page.getByTestId("object-total")).toHaveText("1 object");

  await saveNow(page);
  await expect.poll(() => sent.filter((r) => r.method() === "POST").length).toBeGreaterThan(0);

  const post = sent.find((r) => r.method() === "POST" && r.url().endsWith("/annotations"));
  const body = JSON.parse(post?.postData() ?? "[]") as Record<string, unknown>[];
  expect(body).toHaveLength(1);
  expect(body[0]["label_class"]).toBe("vehicle");
  // `toAnnotationCreate` drops the client-minted id and the provisional schema
  // version: the kernel mints one and stamps the other.
  expect(body[0]["id"]).toBeUndefined();
  expect(body[0]["schema_version"]).toBeUndefined();

  // Only creates — nothing was updated or deleted, so nothing else was sent.
  expect(sent.filter((r) => r.method() === "PATCH")).toHaveLength(0);
  expect(sent.filter((r) => r.method() === "DELETE")).toHaveLength(0);
});

/** The two opening moves this page sends, in the order they were sent. */
function startsSent(sent: Request[]): string[] {
  return sent
    .filter((request) => request.method() === "POST" && request.url().endsWith("/start"))
    .map((request) => new URL(request.url()).pathname.replace(/^\/api/, ""));
}

/**
 * The workspace routes into the annotator from an *approved* batch — the
 * gallery's `Start annotating`, every tile, a pasted URL — and nothing on that
 * path presses the batch table's own `Start`. So the page makes both opening
 * moves itself, in their one legal order. Without them the job start is refused
 * `BATCH_NOT_IN_ANNOTATION` silently and the first Save answers the raw code.
 */
test("opening a job in an approved batch starts the batch, then the job, and a save lands", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, { batch: "approved", job: "pending" });

  await expect.poll(() => startsSent(sent)).toEqual([
    `/batches/${BATCH}/start`,
    `/jobs/${JOB}/start`,
  ]);

  // …and the page is actually usable afterwards: draw one box, save, and the
  // bar answers Saved rather than a code — the exact gesture the defect refused.
  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await saveNow(page);
  await expect(page.getByTestId("save-state")).toContainText("Saved");
});

test("a refused opening move is sent once, never looped, and its code is on the bar", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, {
    batch: "approved",
    job: "pending",
    refuseBatchStart: "BATCH_NOT_IN_ANNOTATION",
  });

  // The move was attempted and refused…
  await expect.poll(() => startsSent(sent)).toEqual([`/batches/${BATCH}/start`]);

  // …and the refusal surfaces beside the save state, before anybody has saved —
  // the page must never look inert about a batch it could not open. It moved out
  // of the save's own slot, where as a fallback it would survive every
  // later save and report a failure that had not happened.
  await expect(page.getByTestId("opening-refusal")).toContainText(/not open for annotation/i);

  // Force a run of re-renders, then look at the wire. The old effect's bail flags
  // were all false again after a refusal, so every one of these renders re-sent
  // the refused POST.
  //
  // **This used to force them by drawing a box, and cannot any more**: a batch
  // whose start was refused is still `approved`, so its frames declare no
  // `annotate` and the canvas is read-only — which is the point of F2 and is a
  // strictly better answer than a page that draws work it can never save. The
  // zoom is the re-render that survives read-only, because it moves the
  // viewport and not the document, and `onViewChange` fires on every notch.
  const zoomIn = page.getByTestId("zoom-in");
  for (let notch = 0; notch < 8; notch += 1) await zoomIn.click();
  // The renders really happened, and the bar keeps the refusal.
  await expect(page.getByTestId("zoom-readout")).not.toHaveText("100%");
  await expect(page.getByTestId("opening-refusal")).toContainText(/not open for annotation/i);

  // Once — and the job's own start never fired at all, because the batch never
  // reached `in_annotation` for it to be legal in.
  expect(startsSent(sent)).toEqual([`/batches/${BATCH}/start`]);
});

/**
 * The stale-declaration window, and a source of intermittent red.
 *
 * The page fires its opening moves against a *cached* read of the job. An
 * invalidation's refetch is asynchronous, so there is a window where the cache
 * still says `pending` and declares `start` while the server has already moved
 * the job on — and the kernel answers that second start `INVALID_TRANSITION`.
 *
 * Two things were wrong with what happened next, and they are separable.
 *
 * The first is this one: writing the refusal into the slot the **save** reports
 * through, and never clearing it, makes a save that fully succeeded render
 * `INVALID_TRANSITION`'s prose instead of `Saved`, for the life of the mount, for
 * a reason that had nothing to do with the save. A slot that can be filled by an
 * unrelated failure is not a report.
 */
test("a save reports its own outcome, not an opening move's refusal", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, {
    batch: "in_annotation",
    job: "pending",
    refuseJobStart: "INVALID_TRANSITION",
  });

  await expect.poll(() => startsSent(sent)).toEqual([`/jobs/${JOB}/start`]);

  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await saveNow(page);

  // The save landed, so the save says so. This is the assertion the cycle suite
  // was making at `cycle.spec.ts:321` when it failed.
  await expect(page.getByTestId("save-state")).toContainText("Saved");
});

/**
 * The second half: an opening move refused **because it was already made** is
 * not a failure, and reporting it is reporting a non-event.
 *
 * `start` moves a job `pending → in_progress`. The only way that is refused
 * `INVALID_TRANSITION` is that the job is no longer `pending` — which is the
 * state the effect was trying to reach. The honest answer is to go and read the
 * truth, not to tell somebody their page is broken. Anything else the kernel
 * refuses with still surfaces; the scenario above this one proves that.
 */
test("an opening move refused as already-made is not reported, and the page re-reads", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, {
    batch: "in_annotation",
    job: "pending",
    refuseJobStart: "INVALID_TRANSITION",
  });

  await expect.poll(() => startsSent(sent)).toEqual([`/jobs/${JOB}/start`]);

  // Nothing is claimed at the user. The page opened, the job is open, and the
  // one thing that happened is a POST nobody needed to know about.
  await expect(page.getByTestId("opening-refusal")).toBeHidden();
  await expect(page.getByTestId("save-state")).toContainText("Saved");

  // And it went back to the wire rather than trusting the read that misled it:
  // a second `GET /jobs/{id}` after the refusal is the re-read.
  const reads = (): number =>
    sent.filter((r) => r.method() === "GET" && new URL(r.url()).pathname.endsWith(`/jobs/${JOB}`))
      .length;
  await expect.poll(reads).toBeGreaterThan(1);
});

/**
 * The slot contract on its own, with a refusal that is **not** suppressed.
 *
 * The two halves need separating, or reverting either one leaves the
 * other's test green. `INVALID_TRANSITION` never reaches the bar, so a
 * scenario built on it cannot tell whether the save's slot still falls back to
 * an opening refusal. This one uses a refusal that does reach the bar — the
 * batch closed under a stale read, which `require_open_batch` answers
 * `BATCH_NOT_IN_ANNOTATION` — and then saves successfully anyway, because the
 * stub is the server and the page's cache is what is stale.
 *
 * Both statements must be true at once: the opening failure is still on screen,
 * and the save reports the save.
 */
test("an opening refusal stays on the bar without claiming the next save failed", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, {
    batch: "in_annotation",
    job: "pending",
    refuseJobStart: "BATCH_NOT_IN_ANNOTATION",
  });

  await expect(page.getByTestId("opening-refusal")).toContainText(/not open for annotation/i);

  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await saveNow(page);

  await expect(page.getByTestId("save-state")).toContainText("Saved");
  // …and the opening failure did not disappear either. It is a fact about this
  // page, not about the last press.
  await expect(page.getByTestId("opening-refusal")).toContainText(/not open for annotation/i);
});

test("Accept is offered only where the kernel's machine allows the move", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "annotated", "asset-2": "review_pending" }));

  // **Asset 1 is `annotated`, and this used to assert Accept was enabled here.**
  // It is not a legal move: `ASSET_PROGRESS_TRANSITIONS` gives `annotated` three
  // exits — `unannotated`, `skipped`, `review_pending` — and `accepted` is not
  // among them. The button was offering a refusal, and the refusal was one of the
  // silent ones (F3), so pressing it did nothing at all and said nothing about it.
  //
  // The gate is the wire's `allowed_actions` now, which the kernel derives from
  // that same table, so this cannot be got wrong again by reading the table twice.
  await expect(page.getByTestId("accept")).toHaveCount(0);

  await page.getByTestId("next-asset").click();
  await expect(page.getByTestId("asset-position")).toContainText("2/2");
  // Asset 2 is `review_pending`, which is the one state `accepted` is reachable
  // from — the reviewer's half of the machine.
  await expect(page.getByTestId("accept")).toBeVisible();
});

test("the zoom buttons drive the same stage mod+0 resets", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const readout = page.getByTestId("zoom-readout");
  // Waited for, not read: `onViewChange` fires in an effect after mount, so the
  // readout is `—` until the fit is announced. Reading it straight away passes on a
  // quiet machine and fails under load, which is what this scenario did once.
  await expect(readout).toHaveText(/%$/);
  const fitted = (await readout.textContent()) ?? "";

  await page.getByTestId("zoom-in").click();
  await expect(readout).not.toHaveText(fitted);

  await page.getByTestId("fit").click();
  await expect(readout).toHaveText(fitted);

  // …and the chord reaches the same implementation, which is why `mod+0` stays
  // intercepted by the adapter rather than forwarded to the host.
  await page.getByTestId("zoom-in").click();
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("ControlOrMeta+0");
  await expect(readout).toHaveText(fitted);
});

/**
 * The zoom's three settled facts, in the one place all three are visible.
 *
 * The ceiling is a decision rather than a bug: past 8x the picture has no more
 * information in it, and the browser's raster of a scaled stage is where the frame
 * budget goes (`docs/annotations.md`, "The ceiling is raster"). What a person must
 * not meet is a control that accepts presses and does nothing — so the limit is
 * *stated* at both ends, the readout stops at the capped number, and deep zoom
 * shows real pixel blocks instead of interpolated blur.
 *
 * A wheel notch and not twenty button presses: `zoomAbout` is exponential, so one
 * large `deltaY` lands on the ceiling in a single event, and it exercises the path
 * that has no button to be disabled — a wheel past the limit must stop too.
 */
test("the zoom stops at 8x, and the control says so rather than going quiet", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const readout = page.getByTestId("zoom-readout");
  const zoomIn = page.getByTestId("zoom-in");
  await expect(readout).toHaveText(/%$/);

  // Below the pixelated threshold at the fit, which is what makes the assertion
  // after the wheel a change rather than a coincidence.
  await expect(page.getByTestId("annotator-image")).toHaveCSS("image-rendering", "auto");
  await expect(zoomIn).toHaveAttribute("data-at-bound", "false");

  // Moved onto the pane before *every* notch, never once at the top. The wheel
  // listener is the pane's own, and a `mouse.wheel` after a button press is
  // dispatched wherever that press left the cursor — over the header, where it
  // reaches nothing. That silently turned this scenario's refusal assertions into
  // assertions about a wheel event nobody received.
  const wheelOverCanvas = async (delta: number): Promise<void> => {
    const box = await page.getByTestId("annotator-root").boundingBox();
    if (box === null) throw new Error("annotator-root has no bounding box");
    // Held, because a bare wheel pans (#576). Without it this scenario would
    // still move the picture and would assert nothing at all about the zoom.
    await zoomWheel(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, delta);
  };

  await wheelOverCanvas(-4000);

  // The capped value exactly — never an uncapped internal number, and never a
  // rounding of one. `MAX_ZOOM` is 8.
  await expect(readout).toHaveText("800%");
  await expect(page.getByTestId("annotator-image")).toHaveCSS("image-rendering", "pixelated");

  // Disabled with the reason, and `aria-disabled` rather than the native
  // attribute — a natively disabled button takes no pointer events, so its
  // tooltip never opens and the reason is unreadable.
  await expect(zoomIn).toHaveAttribute("aria-disabled", "true");
  await expect(zoomIn).toHaveAttribute("aria-label", "Maximum zoom — 8× image pixels");
  await zoomIn.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Maximum zoom — 8× image pixels");

  // Playwright's own actionability check reads `aria-disabled`, so an ordinary
  // click waits for it to become enabled and times out — which is the assertion
  // this line makes, and evidence the control is disabled to more than the eye.
  await expect(zoomIn).toBeDisabled();

  // Both ways past it are refused, and neither moves the readout. The press is
  // forced past the actionability wait on purpose: the guard inside `onClick` is
  // what refuses, and a click that never lands would not exercise it.
  await zoomIn.click({ force: true });
  await wheelOverCanvas(-4000);
  await expect(readout).toHaveText("800%");

  // The floor gets the same treatment.
  const zoomOut = page.getByTestId("zoom-out");
  await expect(zoomOut).toHaveAttribute("data-at-bound", "false");
  await wheelOverCanvas(8000);
  await expect(readout).toHaveText("5%");
  await expect(zoomOut).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("annotator-image")).toHaveCSS("image-rendering", "auto");
  // …and the other control is live again, which is what tells the two apart from
  // a pair that is simply always disabled.
  await expect(zoomIn).toHaveAttribute("data-at-bound", "false");
});

test("Skip settles the asset and advances", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await page.getByTestId("skip").click();
  await expect.poll(() => sent.filter((r) => r.method() === "PUT").length).toBeGreaterThan(0);

  const put = sent.find((r) => r.method() === "PUT");
  expect(JSON.parse(put?.postData() ?? "{}")).toEqual({ progress: "skipped" });
  await expect(page.getByTestId("asset-position")).toContainText("2/2");
  // Settling a frame advances, and the address follows that too — the
  // auto-advance goes through the same `onNavigate` the buttons do.
  await expect(page).toHaveURL(/asset=asset-2/);
});

/**
 * The address bar names the frame on screen.
 *
 * Left alone, `?asset=` records where the annotator was *entered* — the next and
 * previous buttons move through the job in component state and never touch it.
 * Copy the URL on frame 7, send it, and the reader lands on frame 1 with nothing
 * saying so; worse, they answer about a picture that was never meant.
 *
 * `data-asset` on the page root is the truth these assert against, and it is here
 * for exactly this reason: a harness reading the frame *out of the URL* writes
 * against the wrong id and watches every assertion pass. So the claim
 * worth pinning is not "the URL changes" but "the URL and the screen agree".
 */
async function frameOnScreen(page: Page): Promise<{ url: string | null; screen: string | null }> {
  return {
    url: new URL(page.url()).searchParams.get("asset"),
    screen: await page.getByTestId("annotation-page").getAttribute("data-asset"),
  };
}

test("the address names the frame on screen, and keeps naming it as the job is walked", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // Entered with no parameter at all, which is a legitimate way in — a reload, or
  // a job id typed by hand. The frame it lands on is now sendable.
  await expect(page).toHaveURL(/asset=asset-1/);
  expect(await frameOnScreen(page)).toEqual({ url: "asset-1", screen: "asset-1" });

  await page.getByTestId("next-asset").click();
  await expect(page.getByTestId("asset-position")).toContainText("2/2");
  expect(await frameOnScreen(page)).toEqual({ url: "asset-2", screen: "asset-2" });

  await page.getByTestId("prev-asset").click();
  await expect(page.getByTestId("asset-position")).toContainText("1/2");
  expect(await frameOnScreen(page)).toEqual({ url: "asset-1", screen: "asset-1" });
});

test("the address follows the walk even when the link named a frame to start on", async ({
  page,
}) => {
  const sent: Request[] = [];
  await serveApi(page, sent);
  // The way in that actually happens: a gallery tile, which mints `?asset=`.
  // Entering *without* one cannot tell "reports the frame on screen" apart from
  // "reports the frame it was entered on" — they are the same value there, and
  // the second is the defect.
  await page.goto(`/jobs/${JOB}?asset=asset-1`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("annotation-page")).toBeVisible();
  expect(await frameOnScreen(page)).toEqual({ url: "asset-1", screen: "asset-1" });

  await page.getByTestId("next-asset").click();
  await expect(page.getByTestId("asset-position")).toContainText("2/2");
  expect(await frameOnScreen(page)).toEqual({ url: "asset-2", screen: "asset-2" });
});

test("walking the job leaves the history alone, so Back still means leave", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);
  await expect(page).toHaveURL(/asset=asset-1/);

  // `replace`, not `push`, and this is the assertion that tells them apart. With
  // `push`, Back would walk an annotation session backwards one picture at a time
  // — the browser's own button turned into an undo nobody asked for, two keys away
  // from the real one.
  const before = await page.evaluate(() => history.length);
  await page.getByTestId("next-asset").click();
  await expect(page).toHaveURL(/asset=asset-2/);
  expect(await page.evaluate(() => history.length)).toBe(before);
});

test("a reload lands on the frame the address names, not back at the start", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await page.getByTestId("next-asset").click();
  await expect(page.getByTestId("asset-position")).toContainText("2/2");

  await page.reload();
  await expect(page.getByTestId("annotation-page")).toBeVisible();
  await expect(page.getByTestId("asset-position")).toContainText("2/2");
  expect(await frameOnScreen(page)).toEqual({ url: "asset-2", screen: "asset-2" });
});

test("an asset this job does not carry is corrected in the address, not silently ignored", async ({
  page,
}) => {
  const sent: Request[] = [];
  await serveApi(page, sent);
  // A stale link: the asset moved to another job, or the batch was re-partitioned.
  await page.goto(`/jobs/${JOB}?asset=asset-99`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("annotation-page")).toBeVisible();

  // The fallback to the first asset is old behaviour and stays — a stale link is
  // not an error state. What is new is that it is now *visible*: the address stops
  // naming an asset nobody can see, so the link can be re-copied and be right.
  await expect(page.getByTestId("asset-position")).toContainText("1/2");
  expect(await frameOnScreen(page)).toEqual({ url: "asset-1", screen: "asset-1" });
});

/**
 * A skipped asset must not be a dead end.
 *
 * The kernel is right and is not the problem — `progress_after_annotating`
 * moves an asset only between `unannotated` and `annotated`, because `skipped` is
 * a person's decision and drawing a box does not contradict a decision. What was
 * needed is the door the kernel names: `ASSET_PROGRESS_TRANSITIONS` allows
 * exactly one exit from `skipped`. Without it a user
 * can label a skipped asset, watch `Save` succeed, and lose the work at
 * promotion — `PROMOTABLE_PROGRESS` excludes `skipped`.
 */
test("a skipped asset says so, and the page offers the kernel's one way out", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "skipped", "asset-2": "annotated" }));

  // 1. It says so — visibly, not by the absence of something.
  await expectProgress(page, "skipped");

  // 2. …and the way back is offered where the decision was made, in place of Skip.
  await expect(page.getByTestId("skip")).toHaveCount(0);
  await page.getByTestId("unskip").click();

  await expect.poll(() => sent.filter((r) => r.method() === "PUT").length).toBeGreaterThan(0);
  const put = sent.find((r) => r.method() === "PUT");
  // Spelled the way the kernel spells it. `skipped -> unannotated` is the only
  // edge out; anything else would be asking for a refusal.
  expect(JSON.parse(put?.postData() ?? "{}")).toEqual({ progress: "unannotated" });

  // 3. Reversing a decision is about *this* asset, so it does not advance the way
  //    settling one does — the user came back here to work on it.
  await expect(page.getByTestId("asset-position")).toContainText("1/2");

  // 4. …and the page reflects what actually changed: Skip is offered again, and
  //    `Accept` stays disabled because `unannotated` is not where that move is
  //    legal. The gate is the kernel's and is not loosened to paper over this.
  await expectProgress(page, "unannotated");
  await expect(page.getByTestId("skip")).toBeVisible();
  await expect(page.getByTestId("accept")).toHaveCount(0);
});

test("a skipped asset cannot be drawn on at all, and the page says how to get it back", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "skipped", "asset-2": "annotated" }));

  // **This scenario used to assert the opposite — that drawing on a skipped frame
  // saved.** It did, and that was the hole: `PROMOTABLE_PROGRESS` excludes
  // `skipped`, so the labels were stored and then dropped at promotion, with
  // every layer agreeing because each half is separately valid. The kernel closes
  // it (`WRITABLE_PROGRESS`, 409 `ASSET_NOT_WRITABLE`); this closes it
  // in the browser, so the work is never drawn rather than drawn and refused.
  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();

  // Nothing was drawn, so there is nothing to save and no request to send. That
  // is the guarantee `readOnly` on the canvas exists for: a host that only greyed
  // out the Save would still have a box on the screen and no way to keep it.
  await expect(page.getByTestId("object-total")).toHaveText("0 objects");
  await expectNothingToSave(page);
  expect(sent.filter((r) => r.method() === "POST" && r.url().includes("/annotations"))).toEqual([]);

  // And the way back is one click, on the same bar.
  await expectProgress(page, "skipped");
  await expect(page.getByTestId("skipped-notice")).toBeVisible();
  await expect(page.getByTestId("unskip")).toBeEnabled();
});

/**
 * Read-only mode, which did not exist — audit finding F2.
 *
 * The batch is `completed`, so the kernel declares nothing on any of its frames
 * and every write it could send would answer 409. What shipped instead was a
 * fully live editor: the canvas drew, the palette armed tools, the panel deleted
 * objects, and the first Save rendered `BATCH_NOT_IN_ANNOTATION` as a raw badge —
 * with navigation blocked while dirty, because `go()` commits first. The only way
 * out was to undo your own work.
 */
test("a completed batch opens as a viewer, and says so", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, { batch: "completed", job: "completed" });

  const banner = page.getByTestId("readonly-banner");
  await expect(banner).toBeVisible();
  // Prose with a route onward, not a code. The forward-only correction model is
  // the answer to "then how do I fix this frame".
  await expect(banner).toContainText(/viewing only/i);
  await expect(banner).toContainText(/correction batch/i);

  // Every control that writes is out. `skip` is absent rather than disabled: the
  // pair keeps its slot inside a working job and loses it once the job is
  // closed, which a completed batch's is.
  await expectNothingToSave(page);
  await expect(page.getByTestId("skip")).toHaveCount(0);
  await expect(page.getByTestId("accept")).toHaveCount(0);

  // The strip is present and carries navigation only (#576). It used to be
  // absent entirely, and the reason was sound while every control on it picked a
  // drawing tool — but navigating a batch nobody may edit is most of what a
  // viewer does, and on a trackpad the hand is the only way to do it.
  await expect(page.getByTestId("tool-palette")).toHaveCount(1);
  await expect(page.getByTestId("tool-hand")).toHaveCount(1);
  await expect(page.getByTestId("tool-help")).toHaveCount(1);
  for (const drawing of ["tool-select", "tool-bbox", "tool-polygon", "tool-add-class", "tool-undo"]) {
    await expect(page.getByTestId(drawing)).toHaveCount(0);
  }
});

test("a completed batch's canvas cannot be drawn on, however hard it is asked", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, { batch: "completed", job: "completed" });

  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  // A class hotkey, then a full drag — the exact gesture that draws a box.
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();

  // The claim, and the reason `readOnly` is a prop on the engine rather than a
  // convention in the host: pointer input goes straight into the machine, so a
  // greyed-out toolbar would not have stopped this.
  await expect(page.getByTestId("object-total")).toHaveText("0 objects");
  await expectNothingToSave(page);
  expect(sent.filter((r) => r.method() === "POST" && r.url().includes("/annotations"))).toEqual([]);
});

/**
 * The add-a-class doors, closed by absence: the classes
 * region does not render in the read-only mode at all, so no create path into
 * the add-a-class dialog exists — the region, its filter, its quick-create and
 * its hotkey badges are gone, and the objects region takes the whole panel.
 */
test("a completed batch's viewer renders no classes region, and the objects region takes the panel", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, { batch: "completed", job: "completed" });
  await expect(page.getByTestId("readonly-banner")).toBeVisible();

  await expect(page.getByTestId("class-region")).toHaveCount(0);
  await expect(page.getByTestId("class-add")).toHaveCount(0);
  await expect(page.getByTestId("class-filter")).toHaveCount(0);
  await expect(page.getByTestId("panel-split")).toHaveCount(0);
  await expect(page.getByTestId("add-class-dialog")).toHaveCount(0);

  // `c` reaches nothing: the chord is still claimed, and there is no filter for
  // it to focus, so the keyboard stays on the canvas root.
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("c");
  await expect(page.getByTestId("annotator-root")).toBeFocused();

  // The layout half of decision (a): the objects region is handed the whole
  // panel by the same flex rule that always sized it. Measured, not assumed —
  // the region's top sits where the classes region used to, at the panel's
  // padding edge.
  const panel = (await page.getByTestId("annotator-panel").boundingBox())!;
  const objects = (await page.getByTestId("objects-region").boundingBox())!;
  expect(objects.y - panel.y).toBeLessThanOrEqual(12);
  expect(panel.y + panel.height - (objects.y + objects.height)).toBeLessThanOrEqual(12);
});

/** A stored `vehicle` box on the given asset, in the wire mirror's exact shape. */
function storedBox(assetId: string): Record<string, unknown> {
  return {
    id: "seeded-1",
    asset_id: assetId,
    label_class: "vehicle",
    schema_version: 3,
    geometry: { type: "bbox", x: 40, y: 40, width: 44, height: 34 },
    attributes: {},
    provenance: "human",
    model_ref: null,
    confidence: null,
    job_id: null,
  };
}

/**
 * Read-only selection highlights and advertises nothing: no grips, no vertex
 * dots. The editor is asserted beside it, so the claim is about the mode and not
 * about the fixture. The cursor no longer separates them (#567) and is not
 * compared here.
 */
test("read-only selection grows no handles, where the editor's does", async ({
  page,
}) => {
  const sent: Request[] = [];
  // A stored box, seeded at the stub: a completed batch's viewer cannot draw
  // one, which is the point of the mode.
  await openJob(page, sent, undefined, { batch: "completed", job: "completed" }, undefined, [
    storedBox("asset-1"),
  ]);
  await expect(page.getByTestId("object-row-0")).toBeVisible();

  // Select on the canvas — the viewer's one pointer gesture.
  const shape = page.locator("[data-annotation-id]").first();
  const box = (await shape.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId("object-row-0")).toHaveAttribute("data-selected", "true");

  // (c) Selection did not grow handles…
  await expect(page.locator("[data-handle]")).toHaveCount(0);
  await expect(page.locator("[data-vertex]")).toHaveCount(0);

});

test("the editor grows grips on selection, and hovering a shape stays a plain arrow", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, undefined, undefined, [storedBox("asset-1")]);
  await expect(page.getByTestId("object-row-0")).toBeVisible();

  const shape = page.locator("[data-annotation-id]").first();
  const box = (await shape.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId("object-row-0")).toHaveAttribute("data-selected", "true");

  await expect(page.locator("[data-handle]").first()).toBeVisible();

  // Hovering the body is a plain arrow, not the four-arrow `move` (#567). Only a
  // browser has a computed cursor at all.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const editing = await page
    .getByTestId("annotator-pane")
    .evaluate((node) => getComputedStyle(node).cursor);
  expect(editing).toBe("default");
});

/**
 * Selection is one state, reflected everywhere. A shape
 * picked on the canvas selects its panel row and scrolls it into view — here
 * with enough objects that the row genuinely starts outside the scroller.
 */
test("selecting on the canvas scrolls the object's row into view", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // Draw a column of boxes — enough that the first row scrolls out once the
  // last is drawn and selected.
  const canvas = page.getByTestId("annotator-canvas");
  const frame = (await canvas.boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  const drawn = 14;
  for (let index = 0; index < drawn; index += 1) {
    const left = frame.x + frame.width * (0.05 + 0.9 * (index / drawn));
    const top = frame.y + frame.height * 0.1;
    await page.mouse.move(left, top);
    await page.mouse.down();
    await page.mouse.move(left + frame.width * 0.04, top + frame.height * 0.5, { steps: 4 });
    await page.mouse.up();
  }
  await expect(page.getByTestId("object-total")).toHaveText(`${drawn} objects`);

  // Select the *first* box on the canvas while the list sits scrolled to the
  // bottom (drawing kept appending). Its row must come back into the scroller.
  await page.keyboard.press("v");
  const first = page.locator("[data-annotation-id]").first();
  const target = (await first.boundingBox())!;
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);

  const row = page.getByTestId("object-row-0");
  await expect(row).toHaveAttribute("data-selected", "true");
  const scroller = (await page.getByTestId("objects-scroller").boundingBox())!;
  const where = (await row.boundingBox())!;
  expect(where.y).toBeGreaterThanOrEqual(scroller.y - 1);
  expect(where.y + where.height).toBeLessThanOrEqual(scroller.y + scroller.height + 1);
});

/**
 * **The transition itself**, which is the part easiest to get wrong.
 *
 * Without the job dimension, pressing Finish completes the job and leaves the
 * workspace a live editor — tool strip, classes panel, Skip, Save and next, on
 * every frame — because the declaration the page reads does not move. Completing
 * a job does not complete its batch (`BatchService` derives that separately), so
 * the batch dimension cannot cover it; `asset_actions` reads the job's state, and the
 * invalidation the mutation already performed does the rest.
 *
 * Asserted **in place**: a sentinel written on `window` before the press is read
 * back after it, so a reload — which would hide the whole defect by rebuilding
 * the page from a fresh fetch — fails the test rather than passing it.
 */
test("finishing the job turns the workspace into a viewer in place, on every frame", async ({
  page,
}) => {
  const sent: Request[] = [];
  // Both frames settled, so the job declares `complete` and Finish is live; a
  // stored box on the last frame so the post-transition selection rules have
  // something to select.
  await openJob(
    page,
    sent,
    progressStore({ "asset-1": "annotated", "asset-2": "annotated" }),
    openedWorld(),
    undefined,
    [storedBox("asset-2")],
  );

  // Frame 2 of 2 — where Finish job renders, and only there.
  await page.getByTestId("next-asset").click();
  await expect(page.getByTestId("asset-position")).toHaveText("2/2");

  // The editor, before: the state the defect left behind afterwards.
  await expect(page.getByTestId("tool-palette")).toBeVisible();
  await expect(page.getByTestId("class-region")).toBeVisible();
  await expect(page.getByTestId("readonly-banner")).toHaveCount(0);
  const finish = page.getByTestId("finish-job");
  await expect(finish).toHaveAttribute("data-withheld", "false");

  await page.evaluate(() => {
    (window as unknown as { __sameDocument?: number }).__sameDocument = 439;
  });
  await finish.click();

  // The mode flipped, and the banner names the cause the batch cannot: this
  // batch is still `in_annotation`, so there is no correction route to offer and
  // the sentence stops at the cause.
  const banner = page.getByTestId("readonly-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/viewing only/i);
  await expect(banner).toContainText(/this job is finished/i);
  await expect(page.getByTestId("banner-create-correction")).toHaveCount(0);

  // Same document — no navigation, no reload.
  expect(
    await page.evaluate(() => (window as unknown as { __sameDocument?: number }).__sameDocument),
  ).toBe(439);

  // Visible success, in the vocabulary the add-a-class chain already uses.
  await expect(page.getByText(/job finished/i).first()).toBeVisible();

  // Everything that only ever performed an edit is **absent**, not disabled —
  // the strip included, down to the one button on it that is navigation (#576).
  await expect(page.getByTestId("tool-select")).toHaveCount(0);
  await expect(page.getByTestId("tool-undo")).toHaveCount(0);
  await expect(page.getByTestId("tool-hand")).toHaveCount(1);
  await expect(page.getByTestId("class-region")).toHaveCount(0);
  await expect(page.getByTestId("panel-split")).toHaveCount(0);
  await expect(page.getByTestId("skip")).toHaveCount(0);
  await expect(page.getByTestId("save-and-next")).toHaveCount(0);
  await expectNothingToSave(page);
  // The job's own control keeps its slot and states the outcome.
  await expect(finish).toHaveText(/finished/i);
  await expect(finish).toBeDisabled();

  // The objects region takes the whole panel, measured after the flip
  // rather than assumed from the completed-batch scenario.
  const panel = (await page.getByTestId("annotator-panel").boundingBox())!;
  const objects = (await page.getByTestId("objects-region").boundingBox())!;
  expect(objects.y - panel.y).toBeLessThanOrEqual(12);
  expect(panel.y + panel.height - (objects.y + objects.height)).toBeLessThanOrEqual(12);

  // Both read-only rules hold on the far side of the transition: a press selects,
  // the row follows, and the selection grows no handles.
  const shape = page.locator("[data-annotation-id]").first();
  const where = (await shape.boundingBox())!;
  await page.mouse.click(where.x + where.width / 2, where.y + where.height / 2);
  await expect(page.getByTestId("object-row-0")).toHaveAttribute("data-selected", "true");
  await expect(page.locator("[data-handle]")).toHaveCount(0);
  await expect(page.locator("[data-vertex]")).toHaveCount(0);

  // **Every frame, not only the one Finish was pressed on.** Navigation is what
  // proves it, and navigation still working is half the decision.
  await page.getByTestId("prev-asset").click();
  await expect(page.getByTestId("asset-position")).toHaveText("1/2");
  await expect(page.getByTestId("readonly-banner")).toBeVisible();
  await expect(page.getByTestId("tool-select")).toHaveCount(0);
  await expect(page.getByTestId("tool-hand")).toHaveCount(1);
  await expect(page.getByTestId("class-region")).toHaveCount(0);

  // The other half: the gallery still opens, and no save-first guard engages —
  // there is nothing to save.
  await page.getByTestId("open-gallery").click();
  await expect(page.getByTestId("frame-gallery")).toBeVisible();
  expect(sent.filter((r) => r.method() === "POST" && r.url().includes("/annotations"))).toEqual([]);
});

/**
 * The one frame where the read-only mode could say nothing at all: a banner
 * that renders only while the frame is not skipped leaves a skipped frame in a
 * completed batch with no "viewing only", no route onward, and a skipped notice
 * whose "Un-skip it" names a move the wire withholds there.
 */
test("a skipped frame in a completed batch still says viewing only, and names the correction path", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "skipped", "asset-2": "annotated" }), {
    batch: "completed",
    job: "completed",
  });

  const banner = page.getByTestId("readonly-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/viewing only/i);
  await expect(page.getByTestId("banner-create-correction")).toBeVisible();

  // The notice's remedy is not available here, so the banner is the one surface
  // that speaks — two banners saying different things about one frame is how a
  // person learns to trust neither.
  await expect(page.getByTestId("skipped-notice")).toHaveCount(0);
  // Absent rather than disabled — the frame's own verbs leave once
  // the job is closed, and a completed batch's is. Inside an *open* batch this
  // same frame keeps its Un-skip, which is the distinction that rule turns on.
  await expect(page.getByTestId("unskip")).toHaveCount(0);
});

/**
 * The browser's native image drag must be impossible in every mode. A
 * drag on the asset means whatever the active tool means — draw, move, pan —
 * and a gesture that lifts a ghost of the picture instead is one the product
 * never offers. Two `<img>` elements exist product-wide: the canvas image
 * (inert since the adapter's first commit — `draggable` off, no pointer
 * events) and `AssetThumbnail`, which the frame-gallery overlay puts inside
 * the workspace. Both are held here, against real browser drag machinery.
 */

/** Count native drags anywhere on the page, before any gesture runs. */
async function armDragCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const counted = window as { __drags?: number };
    counted.__drags = 0;
    document.addEventListener(
      "dragstart",
      () => {
        counted.__drags = (counted.__drags ?? 0) + 1;
      },
      true,
    );
  });
}

async function nativeDrags(page: Page): Promise<number> {
  return page.evaluate(() => (window as { __drags?: number }).__drags ?? 0);
}

test("no drag lifts the picture, and the tool's own gesture survives the attempt", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);
  await armDragCounter(page);

  // A long, slow drag straight across the image with the select tool — the
  // exact gesture that picks a picture up in a browser that offers it.
  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5, { steps: 12 });
  await page.mouse.up();
  expect(await nativeDrags(page)).toBe(0);

  // The gallery overlay's thumbnails are pictures too, inside the workspace.
  await page.getByTestId("open-gallery").click();
  const tile = page.getByTestId("frame-gallery").getByTestId("thumbnail").first();
  await expect(tile).toBeVisible();
  const thumb = (await tile.boundingBox())!;
  await page.mouse.move(thumb.x + thumb.width * 0.3, thumb.y + thumb.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(thumb.x + thumb.width * 2, thumb.y + thumb.height * 0.5, { steps: 12 });
  await page.mouse.up();
  expect(await nativeDrags(page)).toBe(0);
  await page.keyboard.press("Escape");

  // The interaction state came through the attempts untouched: the next
  // gesture is an ordinary draw and it lands.
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("object-total")).toHaveText("1 object");
});

test("the read-only mode is no more draggable than the editor", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, { batch: "completed", job: "completed" });
  await expect(page.getByTestId("readonly-banner")).toBeVisible();
  await armDragCounter(page);

  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5, { steps: 12 });
  await page.mouse.up();
  expect(await nativeDrags(page)).toBe(0);
});

/**
 * The half no unit test can reach: **the clipboard survives moving to the next
 * frame.**
 *
 * A store is per asset — `Workspace` is remounted with `key={asset.id}` so an
 * undo history cannot walk into the previous picture — so this is a claim about
 * where the clipboard is *held*: `JobScreen`, which outlives the remount. Copy on
 * frame 1, walk forward, paste on frame 2.
 */
test("a copied annotation can be pasted onto the next frame", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("object-total")).toHaveText("1 object");

  await page.keyboard.press("ControlOrMeta+c");

  // Navigating commits first, so frame 1 is saved on the way out — which is also
  // why the stub answers annotations per asset.
  await page.getByTestId("next-asset").click();
  await expect(page.getByTestId("asset-position")).toContainText("2/2");
  await expect(page.getByTestId("object-total")).toHaveText("0 objects");

  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.getByTestId("object-total")).toHaveText("1 object");
  await expect(page.getByTestId("save-state")).toContainText("unsaved");

  // And it is written against **this** frame, not the one it was copied from.
  await saveNow(page);
  await expect(page.getByTestId("save-state")).toContainText("Saved");
  const posted = sent.filter((r) => r.method() === "POST" && r.url().endsWith("/annotations"));
  const body = JSON.parse(posted.at(-1)?.postData() ?? "[]") as Record<string, unknown>[];
  expect(body).toHaveLength(1);
  expect(body[0].asset_id).toBe("asset-2");
  expect(body[0].label_class).toBe("vehicle");
});

/**
 * Read-only splits the pair, which is the whole reason they are two action kinds.
 *
 * Copy is a read and stays live — carrying a box out of a closed batch is how
 * somebody starts a correction. Paste is a write and is refused by the engine
 * itself, before any request is made, with the banner already on screen saying
 * why. No control is offered for it, so there is nothing to disable-with-reason:
 * the standing explanation is the reason.
 */
test("a viewer may copy but not paste, and the page already says why", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "annotated", "asset-2": "annotated" }), {
    batch: "completed",
    job: "completed",
  });

  await expect(page.getByTestId("readonly-banner")).toBeVisible();
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ControlOrMeta+v");

  await expect(page.getByTestId("object-total")).toHaveText("0 objects");
  await expectNothingToSave(page);
  expect(sent.filter((r) => r.method() === "POST" && r.url().includes("/annotations"))).toEqual([]);
  // The explanation was there before the keystroke and is still the only one.
  await expect(page.getByTestId("readonly-banner")).toContainText(/viewing only/i);
});

test("a viewer can still navigate between frames, because a read-only mode you cannot move in is a screenshot", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, { batch: "completed", job: "completed" });

  await expect(page.getByTestId("asset-position")).toContainText("1/2");
  await page.getByTestId("next-asset").click();
  // Never blocked: nothing can be dirty, so `go()`'s commit-first is a no-op
  // rather than a save that rejects and swallows the navigation with it.
  await expect(page.getByTestId("asset-position")).toContainText("2/2");
  await page.getByTestId("prev-asset").click();
  await expect(page.getByTestId("asset-position")).toContainText("1/2");
});

/**
 * The version-select and Merge slots are **absent**. Drawing them disabled to hold
 * the design's shape leaves nothing to explain them with, and principle 9 forbids a
 * bare disabled control. They come back when the model behind them does.
 */
test("the versioning controls are absent, not disabled", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);
  await expect(page.getByTestId("version-select")).toHaveCount(0);
  await expect(page.getByTestId("merge")).toHaveCount(0);
  // The bar did not lose anything real with them: the controls either side are
  // still there, so this is a removal rather than a header that failed to render.
  await expect(page.getByTestId("open-gallery")).toBeVisible();
  // There is no Save button, so the witness that the bar rendered is
  // the save *state*, which stayed — and the overflow, which took its press.
  await expect(page.getByTestId("save")).toHaveCount(0);
  await expect(page.getByTestId("save-state")).toBeVisible();
  await expect(page.getByTestId("more-actions")).toBeVisible();
});

/**
 * The annotation page owns the viewport.
 *
 * Every other route in the product is a list or a form, and the shell's padded,
 * `max-w-7xl` container is right for those. The annotator is the one screen
 * somebody sits in front of for an hour, and boxing it costs more than looks:
 * `fitToViewport` derives the zoom from `getBoundingClientRect` on the pane, so a
 * pane the shell has shrunk means every asset opens smaller than it needs to and
 * the tolerance constants — all in *screen* pixels, divided by zoom — are applied
 * at a zoom nobody chose.
 */

/** Viewport width minus the rail, which is what the page is entitled to. */
async function paneWidth(page: Page): Promise<number> {
  const rail = await page.getByTestId("app-rail").boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  return width - (rail?.width ?? 0);
}

test("the annotation page fills the viewport beside the rail, with no cap and no padding", async ({
  page,
}) => {
  // Wider than `max-w-7xl` (1280px), so the cap is a real constraint rather than
  // one that happens not to bite. At the suite's default 1440 the content area is
  // 1200 and the cap never engages — which is exactly how this defect survived.
  await page.setViewportSize({ width: 1800, height: 900 });

  const sent: Request[] = [];
  await openJob(page, sent);

  const box = await page.getByTestId("annotation-page").boundingBox();
  expect(box).not.toBeNull();
  // No gutters: the page is everything to the right of the rail.
  expect(box!.width).toBeCloseTo(await paneWidth(page), 0);
  // No padding above the top bar either.
  expect(box!.y).toBe(0);
  expect(box!.height).toBe(900);
});

test("nothing on the annotation page scrolls the document", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // `h-screen` inside a `py-6` container made the document 948px tall in a 900px
  // window, so the canvas's own badge was cut off and the whole page scrolled.
  const scrolls = await page.evaluate(() => ({
    vertical: document.documentElement.scrollHeight > window.innerHeight,
    horizontal: document.documentElement.scrollWidth > window.innerWidth,
  }));
  expect(scrolls).toEqual({ vertical: false, horizontal: false });

  // The badge pinned to the bottom-left of the canvas pane is on screen, which is
  // the symptom a user actually reported.
  const badge = await page.getByTestId("object-total").boundingBox();
  expect(badge).not.toBeNull();
  expect(badge!.y + badge!.height).toBeLessThanOrEqual(900);
});

test("collapsing the rail reflows the annotation page to the new width", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // Expanded first: a fresh session starts collapsed, and this scenario is
  // about what collapsing gives back. Measuring from the default would measure
  // the same 180px in the other direction and read as the page shrinking.
  await page.getByTestId("rail-collapse").click();
  await expect(page.getByTestId("app-rail")).toHaveAttribute("data-collapsed", "false");

  const before = (await page.getByTestId("annotation-page").boundingBox())!;
  await page.getByTestId("rail-collapse").click();
  await expect(page.getByTestId("app-rail")).toHaveAttribute("data-collapsed", "true");

  const after = (await page.getByTestId("annotation-page").boundingBox())!;
  // The whole 180px the rail gave back — 240px expanded, 60px collapsed, the
  // tokens three things have to agree on.
  //
  // Before the fix this was **128**, which is the defect stating itself: at 1440
  // the expanded pane is 1200 and `max-w-7xl` never engages, but collapsing frees
  // enough width for the cap to start biting, so the page grew by less than the
  // rail released and the difference went into gutters.
  expect(after.width - before.width).toBeCloseTo(180, 0);
  expect(after.width).toBeCloseTo(await paneWidth(page), 0);
});

test("every other route keeps the padded, capped container", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });

  const sent: Request[] = [];
  await serveApi(page, sent);
  await page.goto("/projects");
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();

  const main = page.locator("main");
  await expect(main).toBeVisible();
  const box = (await main.boundingBox())!;
  const inner = (await main.locator("> div").first().boundingBox())!;

  // The pane is still the full width beside the rail…
  expect(box.width).toBeCloseTo(await paneWidth(page), 0);
  // …and the *content* inside it is capped at 7xl and inset on both axes, which
  // is right for a list and is what must not move. Measured against the pane's
  // own origin, because the padding lives inside `<main>` rather than above it.
  expect(inner.width).toBeLessThanOrEqual(1280);
  expect(inner.x - box.x).toBeGreaterThan(0);
  expect(inner.y - box.y).toBeGreaterThan(0);
});

/**
 * The rail is continuous across the two panes, whatever the route tree looks like.
 *
 * Splitting a shell into two layout routes is the kind of change that quietly
 * costs local state, and the annotator's full-bleed route introduces exactly that
 * shape. This asserts the
 * property rather than the structure — deliberately, because the structure turns
 * out not to decide it: two sibling `<Route element={<AppShell />}>` branches are
 * reconciled into one instance and preserve the state too. What must not regress
 * is the user-visible half, and that is what is written down here.
 */
test("the rail keeps its collapsed state when the pane changes", async ({ page }) => {
  const sent: Request[] = [];
  // Start inside the **full-bleed** pane, so both crossings below are real.
  await openJob(page, sent);

  // Expanded, which is the state that is *not* the default — so what
  // survives the crossing below is a choice somebody made rather than the value
  // a freshly mounted shell would have produced anyway. That makes this a
  // stricter scenario than it was, not a looser one.
  await page.getByTestId("rail-collapse").click();
  await expect(page.getByTestId("app-rail")).toHaveAttribute("data-collapsed", "false");

  // Full-bleed → padded, by a client-side navigation. A reload would remount
  // everything and prove nothing about the route tree.
  await page.getByTestId("rail-projects").click();
  await expect(page.locator("main .max-w-7xl")).toBeVisible();
  await expect(page.getByTestId("annotation-page")).toHaveCount(0);
  await expect(page.getByTestId("app-rail")).toHaveAttribute("data-collapsed", "false");

  // …and back the other way.
  await page.goBack();
  await expect(page.getByTestId("annotation-page")).toBeVisible();
  await expect(page.getByTestId("app-rail")).toHaveAttribute("data-collapsed", "false");
});

/**
 * `?` must not be *claimed* rather than served.
 *
 * `onHostAction={(name) => name === TOGGLE_HELP}` returns
 * `true`, which means **the host handled this action**, so pressing `?` — a real
 * binding in `core/input/bindings.ts` — is consumed and then discarded. The user
 * gets nothing, and the engine has been told the request was served, so nothing
 * else can pick it up.
 */
test("? opens the shortcut sheet, and ? closes it again", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();

  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcut-sheet")).toHaveCount(0);
});

test("Escape closes the shortcut sheet", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcut-sheet")).toHaveCount(0);
});

test("the sheet lists the engine's own bindings, and the schema's class hotkeys", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("?");
  const sheet = page.getByTestId("shortcut-sheet");
  await expect(sheet).toBeVisible();

  // Engine rows, addressed by the chord they were registered under — which is
  // what makes this a claim about the registry rather than about this markup.
  for (const chord of ["escape", "enter", "delete", "backspace", "mod+z", "mod+shift+z", "mod+a", "mod+c", "mod+v", "mod+0", "?", "v"]) {
    await expect(sheet.locator(`[data-chord="${chord}"]`)).toHaveCount(1);
  }

  // …and the class hotkeys are the *pinned schema's* own classes, in authored
  // order, with no fourth digit invented.
  const classes = sheet.getByTestId("shortcut-class-rows");
  await expect(classes.locator("[data-chord]")).toHaveCount(3);
  await expect(classes.locator('[data-chord="1"]')).toContainText("vehicle");
  await expect(classes.locator('[data-chord="2"]')).toContainText("lane");
  await expect(classes.locator('[data-chord="3"]')).toContainText("pedestrian");

  // `mod+c` and `mod+v` are claimed, so they are ordinary rows — and what the
  // sheet states in the "left to the browser" slot instead is the fact that is
  // now the surprising one.
  await expect(sheet.locator('[data-chord="mod+c"]')).toContainText("Copy");
  await expect(sheet.locator('[data-chord="mod+v"]')).toContainText("Paste");
  await expect(sheet.getByTestId("shortcut-text-fields")).toContainText(
    /typing in a field they are the browser/i,
  );

  // `h` arrives as an ordinary derived row, which is the whole claim the sheet
  // makes about itself: a binding was added and nobody edited this component.
  await expect(sheet.locator('[data-chord="h"]')).toContainText(/hand/i);

  // The gestures are the half that cannot be derived — a two-finger scroll has
  // no chord to be read off — so they are written, and this is what says they
  // are on the sheet at all (#576).
  await expect(sheet.getByTestId("shortcut-pan-rows")).toContainText(/two-finger scroll/i);
  await expect(sheet.getByTestId("shortcut-pan-rows")).toContainText(/hold space/i);
  await expect(sheet.getByTestId("shortcut-zoom-rows")).toContainText(/pinch/i);
  await expect(sheet.getByTestId("shortcut-touch-rows")).toContainText(/two fingers/i);
});

/**
 * The hand, both doors, and the proof that they are one state.
 *
 * `h` and the strip's button reach the same `handTool` on the page — the suggest
 * tool's arrangement — so pressing one must light the other. A scenario driving
 * only the button would pass with the chord unbound, which is exactly the half a
 * trackpad user reaches for first.
 */
test("the hand turns a plain drag into a pan, from the key and from the button", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const canvas = page.getByTestId("annotator-canvas");
  const pane = (await page.getByTestId("annotator-pane").boundingBox())!;
  const button = page.getByTestId("tool-hand");
  await expect(button).toHaveAttribute("data-active", "false");

  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("h");
  await expect(button).toHaveAttribute("data-active", "true");

  const before = (await canvas.boundingBox())!;
  const from = { x: pane.x + pane.width * 0.5, y: pane.y + pane.height * 0.5 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 140, from.y - 60, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => Math.round((await canvas.boundingBox())!.x)).toBe(
    Math.round(before.x - 140),
  );
  // A pan is not an edit: the drag drew nothing and there is nothing to save.
  await expectNothingToSave(page);

  // The button turns it back off.
  await button.click();
  await expect(button).toHaveAttribute("data-active", "false");

  // And so does reaching for a class, which is the half that makes the strip
  // readable: the hand is a mode, the canvas answers a primary press with a pan
  // before the machine hears it, and a class armed under a raised hand would be
  // a tool that draws nothing while the strip lit it and the hand at once. Every
  // route to a class goes through one funnel on the page, so the digit proves
  // the panel's list and the strip's own buttons too.
  await page.keyboard.press("h");
  await expect(button).toHaveAttribute("data-active", "true");
  await page.keyboard.press("1");
  await expect(button).toHaveAttribute("data-active", "false");
  await expect(page.getByTestId("tool-bbox")).toHaveAttribute("data-active", "true");

  // And the same drag draws again.
  const draw = { x: pane.x + pane.width * 0.4, y: pane.y + pane.height * 0.4 };
  await page.mouse.move(draw.x, draw.y);
  await page.mouse.down();
  await page.mouse.move(draw.x + 90, draw.y + 70, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("object-total")).toContainText("1 object");
});

/**
 * The hand puts the *tools* away, not only the cursor.
 *
 * `hover` has two readers — the affordance and the drawing guides — and the hand
 * used to reach neither, only the cursor. So a raised hand over an armed tool
 * still drew the crosshair across the picture and still lit the grip under the
 * pointer: offers the very next press cannot keep, because it is answered by a
 * pan before the machine hears it. This is that half, in the one place it is
 * visible from outside.
 *
 * The tool is armed with a digit rather than by pressing the strip, and the hand
 * with `h` rather than the button, so neither half of the scenario depends on
 * the palette wiring the scenario above already covers. Arming the suggest tool
 * takes the same path — it activates a class, so `tool` is that class's geometry
 * — and needs a model behind it, which this suite does not have.
 */
test("the hand takes the crosshair off the picture, and gives it back", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const pane = (await page.getByTestId("annotator-pane").boundingBox())!;
  const crosshair = page.getByTestId("crosshair");

  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  await page.mouse.move(pane.x + pane.width * 0.5, pane.y + pane.height * 0.5);
  await expect(crosshair).toHaveCount(1);

  await page.keyboard.press("h");
  await expect(crosshair).toHaveCount(0);

  // And back, with no pointer move to wake it: `hover` never stopped tracking,
  // so the guides return where the pointer already is.
  await page.keyboard.press("h");
  await expect(crosshair).toHaveCount(1);
});

/**
 * The surround must not be the rail's near-black navy.
 *
 * A canvas pane at `bg-sidebar-strong` is the only dark surface in
 * the product outside the rail, so the page reads as a different application. It
 * also costs accuracy rather than only looks: a dark surround shifts the perceived
 * contrast and colour of the photograph inside it, on a tool whose whole job is
 * looking closely at pixels.
 */

/** `rgb(r, g, b)` as three numbers, so a colour can be reasoned about. */
function channels(colour: string): readonly number[] {
  return (colour.match(/\d+/g) ?? []).slice(0, 3).map(Number);
}

test("the canvas surround is a light neutral, not the rail's dark chrome", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const stage = await page
    .getByTestId("canvas-stage")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  const rail = await page
    .getByTestId("app-rail")
    .evaluate((node) => getComputedStyle(node).backgroundColor);

  // Light: every channel well above the midpoint. `#111827` fails all three.
  expect(channels(stage).every((value) => value > 200)).toBe(true);
  // Neutral: no channel dominates, so the picture is judged against grey.
  expect(Math.max(...channels(stage)) - Math.min(...channels(stage))).toBeLessThan(24);
  // …and it is emphatically not the rail's treatment, which stays dark.
  expect(stage).not.toBe(rail);
  expect(channels(rail).every((value) => value < 80)).toBe(true);
});

/**
 * A guard on the *new* value rather than a regression test — the dark surround
 * passed this one, being obviously distinguishable from white.
 *
 * What it rejects is the tempting wrong fix: reaching for an existing surface
 * token. `background` and `card` are `#ffffff`, and `muted` is `#f6f8fa`, whose
 * closest channel is five short of white — so an asset with white borders would
 * bleed into its own surround. Measured against a minimum gap of ten, which
 * `muted` fails and `stage` (`#e1e6eb`, gap 20) clears.
 */
test("the surround is distinguishable from the page and from a white image edge", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const [stage, body] = await Promise.all([
    page.getByTestId("canvas-stage").evaluate((node) => getComputedStyle(node).backgroundColor),
    page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  ]);

  // The asset is drawn on white in this stub, and the page behind it is white
  // too. A surround equal to either would hide where the picture ends.
  expect(stage).not.toBe(body);
  const gap = Math.min(...channels(body).map((value, at) => value - channels(stage)[at]));
  expect(gap).toBeGreaterThanOrEqual(10);
});

/**
 * The third acceptance criterion, and also a guard rather than a regression test:
 * a dark surround passed it too. It fails if a later change makes the stage equal
 * to `muted`, which is what the badge is filled with.
 */
test("what is drawn on the surround stays legible against it", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const stage = await page
    .getByTestId("canvas-stage")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  const badge = await page
    .getByTestId("object-total")
    .evaluate((node) => getComputedStyle(node).backgroundColor);

  // The `0 objects` badge is pinned to the pane's bottom-left and sits directly
  // on the surround — the one piece of chrome that does.
  expect(badge).not.toBe(stage);
});

/**
 * The space between a tab bar and its content must not be applied twice.
 *
 * A `flex flex-col gap-3` around `TabsContent`, which carries its own
 * `mt-3`, adds — so the tabs float 24px above
 * the content they switch, about twice what the rhythm asks for.
 *
 * The rule is now that **the primitive owns it**: `TabsContent`'s margin is the
 * one declaration, and a consumer adds no gap of its own. That direction rather
 * than the other because it makes the primitive self-sufficient — a `Tabs` that
 * is not a flex column at all still spaces correctly, and a consumer cannot
 * forget something it never had to know.
 *
 * The annotator's panel has no tabs, so what is left to
 * measure is the project view — the same doubling is possible wherever a `Tabs`
 * sits in a gapped flex column, and the styleguide holds the specimen's own copy.
 */

/** The measured distance between the tab bar and the panel below it, in pixels. */
async function tabGap(page: Page, root: string): Promise<number> {
  const scope = page.getByTestId(root);
  const list = await scope.locator('[role="tablist"]').boundingBox();
  // The active one: Radix keeps every panel mounted and hides the rest, so an
  // unscoped selector resolves to all of them.
  const panel = await scope.locator('[role="tabpanel"][data-state="active"]').boundingBox();
  if (list === null || panel === null) throw new Error(`no tablist/tabpanel under ${root}`);
  return panel.y - (list.y + list.height);
}

test("the project view's tabs use the same one rule", async ({ page }) => {
  const sent: Request[] = [];
  await serveApi(page, sent);
  await page.goto(`/projects/${PROJECT}`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();

  // This one was already right, and asserting it is what stops a later layout
  // tidy-up from adding a gap here and rediscovering the doubling on a different
  // screen.
  await expect(page.getByTestId("project-tabs")).toBeVisible();
  expect(await tabGap(page, "project-tabs")).toBeCloseTo(12, 0);
});

/**
 * The tool palette.
 *
 * The absence these cover is not "a control is missing" but "the primary gesture
 * does nothing": the page opens with no active class, `toolFor` answers `select`,
 * and a drag draws nothing. Every scenario below therefore starts from the page as
 * it opens and reaches the canvas **through the palette** — the digit row and the
 * Labels tab are already covered elsewhere and both worked while this was broken.
 */

/** The stage's rect, which is what a drag's coordinates are taken against. */
async function stageBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.getByTestId("annotator-canvas").boundingBox();
  if (box === null) throw new Error("no canvas");
  return box;
}

test("the palette is on the page as it opens, with select the tool you are in", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const palette = page.getByTestId("tool-palette");
  await expect(palette).toBeVisible();

  // The schema declares one bbox class and one polygon class, so exactly three
  // tools plus help. A tag or a `polyline` would add neither.
  await expect(page.getByTestId("tool-select")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("tool-bbox")).toHaveAttribute("data-active", "false");
  await expect(page.getByTestId("tool-polygon")).toHaveAttribute("data-active", "false");
  await expect(page.getByTestId("tool-help")).toBeVisible();
});

test("pressing the box tool and dragging draws an object, from the page as it opens", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // Nothing drawn, and — the part that was broken — no class chosen by anything
  // other than the palette below.
  await expect(page.getByTestId("object-total")).toHaveText("0 objects");

  await page.getByTestId("tool-bbox").click();
  // A palette press reaches the machine through `AnnotatorCanvas`'s `tool-changed`
  // effect, which lands a tick after the state change, so the drag waits on the
  // button's own report rather than on a timer.
  await expect(page.getByTestId("tool-bbox")).toHaveAttribute("data-active", "true");

  const box = await stageBox(page);
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByTestId("object-total")).toHaveText("1 object");
  // And it is in the Objects panel, carrying the class the box tool activated.
  await expect(page.getByTestId("object-count")).toHaveText("1 object");
  await expect(page.getByTestId("annotator-panel")).toContainText("vehicle");
});

test("pressing the polygon tool and clicking draws a polygon", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await page.getByTestId("tool-polygon").click();
  await expect(page.getByTestId("tool-polygon")).toHaveAttribute("data-active", "true");

  const box = await stageBox(page);
  const at = (fx: number, fy: number): [number, number] => [
    box.x + box.width * fx,
    box.y + box.height * fy,
  ];
  for (const [x, y] of [at(0.35, 0.3), at(0.25, 0.55), at(0.5, 0.55)]) {
    await page.mouse.click(x, y);
  }
  // Enter closes the ring — the close a keyboard can always reach, and the one
  // `drawTriangle` uses in the showcase suite.
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("object-total")).toHaveText("1 object");
  await expect(page.getByTestId("annotator-panel")).toContainText("lane");
});

test("the palette reports the tool whatever moved the class", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // The tool is resolved and never stored, so the digit row and the panel's class
  // list must light the same button the palette's own press does. A palette
  // holding its own idea of the tool is the pair v1 spent two mechanisms keeping
  // in step.
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("2");
  await expect(page.getByTestId("tool-polygon")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("tool-select")).toHaveAttribute("data-active", "false");

  await page.getByTestId("class-row-vehicle").click();
  await expect(page.getByTestId("tool-bbox")).toHaveAttribute("data-active", "true");
  // **Gone, not inactive** (#584). With a boxes-only class held, a polygon is not
  // something that could be drawn here, and a button offering one would answer
  // "what can I draw?" with a lie. The route to a polygon is the class list,
  // which is where choosing a different class belongs.
  await expect(page.getByTestId("tool-polygon")).toHaveCount(0);
});

test("pressing a tool leaves the keyboard alive", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // The claim: the palette refuses the focus a `mousedown` would otherwise take.
  // If it did not, every chord would be dead until the user clicked back on the
  // picture — and the failure is silent, which is what makes this class of bug
  // expensive.
  await page.getByTestId("annotator-root").focus();
  await page.getByTestId("tool-bbox").click();

  await page.keyboard.press("2");
  await expect(page.getByTestId("tool-polygon")).toHaveAttribute("data-active", "true");
});

test("the palette's help entry opens the shortcut sheet", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  await expect(page.getByTestId("shortcut-sheet")).toHaveCount(0);
  await page.getByTestId("tool-help").click();
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
});

/**
 * The four refusals with nowhere to go — audit findings F3 and F4.
 *
 * `setProgress.isError` and `finishJob.isError` were read **nowhere in
 * `AnnotationPage`**. Pressing Skip, Un-skip, Accept or Finish job against a
 * refusal did nothing at all and said nothing about it: the button came back
 * enabled, the badge did not move, and the page read as having ignored the
 * click. Three of the four are one-press actions with no other feedback surface,
 * which is what made these the quietest failures in the product.
 */
test("a refused Skip says why, instead of looking like an ignored click", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, {
    batch: "in_annotation",
    job: "in_progress",
    refuseProgress: "ASSET_NOT_WRITABLE",
  });

  await page.getByTestId("skip").click();

  const said = page.getByTestId("action-refusal");
  await expect(said).toBeVisible();
  // Prose, and the kernel's identifier kept where a bug report can find it
  // rather than where a person has to read it (F16).
  await expect(said).toContainText(/labeling is settled/i);
  await expect(said).not.toContainText("ASSET_NOT_WRITABLE");
  await expect(said).toHaveAttribute("title", "ASSET_NOT_WRITABLE");
  // And the page did not pretend the move landed.
  await expectProgress(page, "unannotated");
});

test("a refused Un-skip says why too, since it is the same silence backwards", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "skipped", "asset-2": "annotated" }), {
    batch: "in_annotation",
    job: "in_progress",
    refuseProgress: "BATCH_NOT_IN_ANNOTATION",
  });

  await page.getByTestId("unskip").click();

  await expect(page.getByTestId("action-refusal")).toContainText(/not open for annotation/i);
  await expectProgress(page, "skipped");
});

test("a refused Accept says why", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(
    page,
    sent,
    progressStore({ "asset-1": "review_pending", "asset-2": "annotated" }),
    { batch: "in_annotation", job: "in_progress", refuseProgress: "INVALID_TRANSITION" },
  );

  await page.getByTestId("accept").click();

  await expect(page.getByTestId("action-refusal")).toContainText(/already moved on/i);
});

/**
 * Principle 9 with principle 4 riding on it: the withheld Finish job
 * carries its reason as a real tooltip that opens on **focus**, not only on
 * hover — which is only possible because the withheld state is `aria-disabled`
 * rather than natively disabled, and only provable in a real browser, where
 * focus and Radix's open-on-focus actually run.
 */
test("a withheld Finish job explains itself on focus, with the count", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "unannotated", "asset-2": "annotated" }), {
    batch: "in_annotation",
    job: "in_progress",
    jobSettled: false,
  });

  // The last frame, the only one Finish job renders on. Frame 1 stays
  // unannotated behind us — the one unresolved frame the sentence counts.
  await page.getByTestId("next-asset").click();
  await expect(page.getByTestId("asset-position")).toContainText("2/2");

  const finish = page.getByTestId("finish-job");
  await expect(finish).toHaveAttribute("aria-disabled", "true");

  // Keyboard first: the reason is reachable without a pointer.
  await finish.focus();
  await expect(page.getByTestId("finish-withheld")).toContainText(
    "1 frame unresolved — annotate or skip it to finish the job.",
  );

  // The press is refused in the handler, so nothing reaches the wire — the
  // `aria-disabled` spelling must not have quietly made the button live.
  // `force`, because Playwright itself honours `aria-disabled` and would
  // refuse to press at all — which is the assistive-tech contract working, but
  // here the claim is about the handler behind it.
  await finish.click({ force: true });
  expect(sent.filter((r) => r.method() === "POST" && r.url().endsWith("/complete"))).toEqual([]);
});

test("a refused Finish job says why, rather than re-enabling in silence", async ({ page }) => {
  const sent: Request[] = [];
  // Every frame settled, so `complete` is declared and the button is live — the
  // only state this refusal is reachable from.
  await openJob(page, sent, progressStore({ "asset-1": "annotated", "asset-2": "annotated" }), {
    batch: "in_annotation",
    job: "in_progress",
    refuseJobComplete: "JOB_NOT_COMPLETE",
  });

  // The last frame, because that is the only one Finish job renders on.
  await page.getByTestId("next-asset").click();
  await expect(page.getByTestId("asset-position")).toContainText("2/2");

  await page.getByTestId("finish-job").click();

  await expect(page.getByTestId("action-refusal")).toContainText(/still need annotating/i);
  // Not "Finished": the job did not move, and a label that said it had would be
  // the page asserting something the server refused.
  await expect(page.getByTestId("finish-job")).toHaveText(/Finish job/);
});

test("a refusal on the bar is a sentence now, not a kernel identifier", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, {
    batch: "approved",
    job: "pending",
    refuseBatchStart: "BATCH_NOT_IN_ANNOTATION",
  });

  // A raw code rendered as a destructive badge is a kernel identifier in front of
  // a user. This is an *opening* refusal, which takes its own notice at the top
  // of the stage's column. Every refusal renders through `refusalProse`, so all
  // of them carry the prose and keep the code in `title`.
  const state = page.getByTestId("opening-refusal");
  await expect(state).toContainText(/not open for annotation/i);
  await expect(state).not.toContainText("BATCH_NOT_IN_ANNOTATION");
  await expect(state).toHaveAttribute("title", "BATCH_NOT_IN_ANNOTATION");
});

/**
 * The review round-trip — the half of the progress machine that is easiest to
 * leave without a door.
 *
 * `annotated -> review_pending -> accepted | annotated` are three legal kernel
 * edges. Without controls for them the gallery's "In review"
 * segment can only be populated through the API or MCP, and `accepted` — the
 * one state that says a human checked the work — is unreachable by any sequence
 * of clicks.
 *
 * Driven end to end on one frame, because the round-trip is the claim: a reviewer
 * sending work back has to leave it in a state the annotator can pick up, and
 * "can pick up" means the canvas is live again.
 */
test("a frame goes out for review, comes back, and is accepted the second time", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "annotated", "asset-2": "annotated" }));

  /** Back to the first frame — settling advances, so every step returns here. */
  const first = async (): Promise<void> => {
    await page.getByTestId("prev-asset").click();
    await expect(page.getByTestId("asset-position")).toContainText("1/2");
  };

  // 1. An annotated frame offers the way in, and nothing else in the review half.
  await expect(page.getByTestId("submit-for-review")).toBeVisible();
  await expect(page.getByTestId("accept")).toHaveCount(0);
  // In the overflow now, and absent from it: an annotated frame has nothing to
  // send back, so the menu must not offer the reviewer's "no".
  await openOverflow(page);
  await expect(page.getByTestId("return-to-annotator")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByTestId("submit-for-review").click();
  // Settling advances, because the person is finished with this frame.
  await expect(page.getByTestId("asset-position")).toContainText("2/2");

  // 2. Seen as a reviewer: the two decisions, and no way to draw. Same screen
  //    wearing the state it is looking at — this product has no annotator
  //    identity to assign work to, so "reviewer" is a thing somebody is doing.
  await first();
  await expectProgress(page, "review_pending");
  await openOverflow(page);
  await expect(page.getByTestId("return-to-annotator")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("accept")).toBeVisible();
  await expect(page.getByTestId("submit-for-review")).toHaveCount(0);
  // `review_pending` is not in `WRITABLE_PROGRESS`, so the frame is read-only —
  // and the banner names the control that undoes that, which is on this toolbar.
  await expect(page.getByTestId("readonly-banner")).toContainText(/return it to the annotator/i);

  // 3. Sent back. The claim that matters: the annotator can pick it up again.
  await openOverflow(page);
  await page.getByTestId("return-to-annotator").click();
  await first();
  await expectProgress(page, "annotated");
  await expect(page.getByTestId("readonly-banner")).toHaveCount(0);
  await expect(page.getByTestId("tool-palette")).toBeVisible();
  await expect(page.getByTestId("submit-for-review")).toBeVisible();

  // 4. Round two, and this time the reviewer says yes.
  await page.getByTestId("submit-for-review").click();
  await first();
  await page.getByTestId("accept").click();
  await first();

  // 5. `accepted` has no exit at all, which is why correcting accepted work needs
  //    a new batch rather than a progress move — and the banner says so.
  await expectProgress(page, "accepted");
  await expect(page.getByTestId("accept")).toHaveCount(0);
  await expect(page.getByTestId("submit-for-review")).toHaveCount(0);
  await openOverflow(page);
  await expect(page.getByTestId("return-to-annotator")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("readonly-banner")).toContainText(/correction batch/i);
});

test("an unannotated frame is not offered to a reviewer at all", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "unannotated", "asset-2": "annotated" }));

  // `annotated` is the only origin of `review_pending`: there is nothing to
  // review until somebody has labelled it, and offering the press would be
  // offering a refusal.
  await expect(page.getByTestId("submit-for-review")).toHaveCount(0);
  await expect(page.getByTestId("accept")).toHaveCount(0);
  await openOverflow(page);
  await expect(page.getByTestId("return-to-annotator")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("a refused review move says why, like every other one", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "annotated", "asset-2": "annotated" }), {
    batch: "in_annotation",
    job: "in_progress",
    refuseProgress: "INVALID_TRANSITION",
  });

  await page.getByTestId("submit-for-review").click();

  await expect(page.getByTestId("action-refusal")).toContainText(/already moved on/i);
  await expectProgress(page, "annotated");
});

test("the job counter never goes backwards when a frame is reviewed", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, progressStore({ "asset-1": "annotated", "asset-2": "annotated" }));

  // **The readout counted `annotated` literally**, so accepting a frame moved it
  // out of that bucket and the number dropped. It never bit before because
  // nothing in the product could produce `accepted` (F24) — adding the review
  // moves is what made it reachable, and the real-server cycle run is what
  // caught it: 3 of 3 became 2 of 3 on an accept.
  //
  // "Annotated" means *past `unannotated`*, which is the same rule the gallery's
  // bar already stated and the only reading that cannot go backwards.
  await expect(page.getByTestId("job-progress")).toHaveText("2 / 2 annotated");

  // Every settling move advances, so each step comes back to the first frame.
  await page.getByTestId("submit-for-review").click();
  await expect(page.getByTestId("job-progress")).toHaveText("2 / 2 annotated");

  await page.getByTestId("prev-asset").click();
  await expectProgress(page, "review_pending");
  await page.getByTestId("accept").click();

  await page.getByTestId("prev-asset").click();
  await expectProgress(page, "accepted");
  await expect(page.getByTestId("job-progress")).toHaveText("2 / 2 annotated");
});

/**
 * Principle 10: the annotation workspace is self-sufficient — no flow may
 * force navigation out of the editor, and **no exit may lose work**.
 *
 * A back arrow that navigates straight out while `prev`/`next` go through the
 * save-first path loses an afternoon's boxes to the one gesture somebody makes
 * when they think they have finished.
 *
 * The grid button is not an exit: it opens an overlay over the workspace, and the
 * save-first claim belongs to the *tile press* below, where the frame actually
 * changes.
 *
 * Asserted in a browser rather than in jsdom on purpose: the claim only exists
 * over a *dirty* document, making one dirty means drawing, and drawing needs a
 * canvas with a real size. jsdom's `getBoundingClientRect` answers all zeros.
 */

/** Draw one box and leave it unsaved — the state the whole principle is about. */
async function drawOneUnsavedBox(page: Page): Promise<void> {
  const canvas = page.getByTestId("annotator-canvas");
  const box = (await canvas.boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("save-state")).toContainText("unsaved");
}

test("back saves the work before it leaves", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);
  await expectNothingToSave(page);
  await drawOneUnsavedBox(page);

  await page.getByTestId("back").click();

  // The POST is the whole assertion: the work reached the server on the way out.
  // Without the guard this leaves nothing behind at all.
  await expect
    .poll(() =>
      sent.filter((r) => r.method() === "POST" && r.url().endsWith("/annotations")).length,
    )
    .toBe(1);
});

test("choosing a frame from the gallery saves first, then switches (#390)", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);
  await expectNothingToSave(page);
  await drawOneUnsavedBox(page);

  // Opening is free: nothing is being left, so nothing is saved yet.
  await page.getByTestId("open-gallery").click();
  await expect(page.getByTestId("frame-gallery")).toBeVisible();
  expect(sent.filter((r) => r.method() === "POST" && r.url().endsWith("/annotations"))).toEqual(
    [],
  );

  // The second frame, by its position — the same save-first `attempt(...)` the
  // navigator's `›` runs, which is the point of routing the tile through it.
  await page.getByRole("button", { name: /^Frame 2,/ }).click();

  await expect
    .poll(() =>
      sent.filter((r) => r.method() === "POST" && r.url().endsWith("/annotations")).length,
    )
    .toBe(1);
  await expect(page.getByTestId("asset-position")).toContainText("2/2");
  await expect(page.getByTestId("frame-gallery")).toHaveCount(0);
});

/**
 * The reassignment picker's canvas anchor.
 *
 * The panel's own half of this is `panel.spec.ts`, against the showcase. What is
 * here is the part jsdom structurally cannot make a claim about: a right-click has
 * to travel through the pane's rect, the viewport transform and the hit test before
 * anybody knows which shape it landed on, and `getBoundingClientRect` answers all
 * zeros in jsdom — so the transform, which is the risky part, is exactly what a
 * unit test would prove nothing about. Everything the *menu* decides is asserted in
 * `canvasReassign.test.tsx` against a real store.
 */

/** One box, drawn and left selected — what a drag leaves behind. */
async function drawSelectedBox(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = (await page.getByTestId("annotator-canvas").boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("1");
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("object-total")).toHaveText("1 object");
  return box;
}

test("right-clicking a shape opens its class picker, and the class lands through the command", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);
  const box = await drawSelectedBox(page);

  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.45, { button: "right" });

  // The pinned schema, judged against this shape's geometry: the other bbox class
  // is offered, and the polygon class is present and refused rather than filtered
  // out — the panel's rule, because it is the panel's component.
  await expect(page.getByTestId("canvas-reclass-lane")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("canvas-reclass-lane")).toContainText("needs polygon");

  await page.getByTestId("canvas-reclass-pedestrian").click();

  await expect(page.getByTestId("object-row-0")).toContainText("1. pedestrian");
  // Through `replaceAnnotationCommand`, so it is one entry in the history and the
  // frame is dirty exactly as a drawn box makes it.
  await expect(page.getByTestId("save-state")).toContainText("unsaved");
  await page.getByTestId("annotator-root").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("object-row-0")).toContainText("1. vehicle");
});

test("the picker's button rides the shape, above the corner its resize grip owns", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);
  const box = await drawSelectedBox(page);

  const trigger = (await page.getByTestId("canvas-reclass").boundingBox())!;
  const corner = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.3 };

  // Clear of the corner on both axes: to the right of it, and above it. A button
  // centred on the corner would sit on the grip and make the shape unresizable.
  expect(trigger.x).toBeGreaterThan(corner.x);
  expect(trigger.y + trigger.height).toBeLessThanOrEqual(corner.y + 1);
  // …and near it, which is what "anchored to the shape" means: a button that
  // merely floated somewhere on the stage would pass the two assertions above.
  expect(trigger.x - corner.x).toBeLessThan(24);
  expect(corner.y - (trigger.y + trigger.height)).toBeLessThan(24);
});

test("a right-click on empty canvas opens nothing, because the hit test is real", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent);
  const box = await drawSelectedBox(page);

  // Well outside the box that was just drawn. Without the hit test this would
  // open the picker anyway — the shape is still selected, so the trigger is on
  // screen and only the *press* is being judged here.
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.9, { button: "right" });

  await expect(page.getByTestId("canvas-reclass-pedestrian")).toHaveCount(0);
  await expect(page.getByTestId("object-row-0")).toContainText("1. vehicle");
});

test("Escape closes the canvas picker and leaves the object alone", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);
  const box = await drawSelectedBox(page);

  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.45, { button: "right" });
  await expect(page.getByTestId("canvas-reclass-pedestrian")).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(page.getByTestId("canvas-reclass-pedestrian")).toHaveCount(0);
  await expect(page.getByTestId("object-row-0")).toContainText("1. vehicle");
});

test("the no-connection panel now has somewhere to send you (#424 D6)", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  // Arming the tool is what makes the editor ask whether a model is reachable —
  // a job nobody suggests on makes no inference request at all.
  await page.getByTestId("tool-suggest").click();
  await expect(page.getByTestId("suggest-no-connections")).toBeVisible();

  // The half that did not exist until this slice. `ui-core` imports no router,
  // so the panel's action is a callback and `routes.tsx` is the only place that
  // can name a destination for it — which is why this is asserted here and not
  // in a component test.
  await page.getByTestId("suggest-configure").click();
  await expect(page).toHaveURL(/\/inference$/);
  await expect(page.getByTestId("inference-screen")).toBeVisible();
});

/**
 * The stage surround is not the asset — and this claim needs a browser, because
 * jsdom has no surround.
 *
 * The pane spans the whole stage while the picture is fitted inside it with
 * padding, so there is a margin around the image that is still the input
 * surface. In jsdom every rectangle is zero, so that margin does not exist and a
 * component test asserting anything about it would be asserting about nothing.
 * Here the two rectangles are measured and the press is put between them.
 *
 * Run at a **non-default zoom**, because the rule has to be applied in asset
 * pixels: one written against screen coordinates would pass at the fitted scale
 * and refuse half the picture at any other.
 */
test("a suggest click in the margin around the picture asks nothing, at any zoom", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, undefined, undefined, undefined, true);

  await page.getByTestId("tool-suggest").click();
  await expect(page.getByTestId("suggest-idle")).toBeVisible();

  // Off the fitted scale, so nothing below can be true by accident of zoom 1.
  await page.getByTestId("zoom-in").click();
  await expect(page.getByTestId("zoom-readout")).not.toHaveText("100%");

  const asks = (): Request[] =>
    sent.filter((r) => r.method() === "POST" && r.url().endsWith("/inference/suggest"));

  // The `<svg>` is laid out at the asset's own size inside the scaled wrapper,
  // so its box on screen *is* the picture's rectangle.
  const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
  const pane = (await page.getByTestId("annotator-pane").boundingBox())!;
  // The fit leaves room on at least one axis, and this test is meaningless
  // without it — so it is asserted rather than assumed.
  expect(picture.x).toBeGreaterThan(pane.x + 2);

  // Left of the picture and inside the pane: on the stage, off the asset.
  await page.mouse.click((pane.x + picture.x) / 2, picture.y + picture.height / 2);
  // Nothing to wait for, so the absence is given a chance to be wrong: a press
  // that *did* ask would have its request logged well inside this.
  await expect(page.getByTestId("suggest-idle")).toBeVisible();
  expect(asks()).toHaveLength(0);
  await expect(page.getByTestId("suggestion-shape")).toHaveCount(0);

  // The same gesture on the picture itself, so the absence above is a rule and
  // not a broken fixture.
  await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);

  await expect(page.getByTestId("suggestion-shape")).toBeVisible();
  expect(asks()).toHaveLength(1);
});

/**
 * The notice surface, measured — which is the only way any of it can be claimed.
 *
 * Every assertion below is about geometry, and jsdom has none:
 * `getBoundingClientRect` answers all zeros, and `scrollWidth` / `clientWidth`
 * answer zero with it. A component test asserting "the notice does not overflow"
 * would pass with the wrap rule deleted, the width halved and the anchor moved
 * back to the corner the zoom widget lives in.
 *
 * A save refusal is the vehicle because it is the one refusal whose *text* the
 * stub controls: a code with no entry in `REFUSAL_PROSE` falls through to the
 * server's own message, so an arbitrarily long unbroken token can be put on
 * screen the way a real model reference arrives.
 */

/** 120 characters, no break opportunity anywhere in it. */
const LONG_MODEL_REF = `IDEA-Research/grounding-dino-tiny@${"0123456789abcdef".repeat(6).slice(0, 86)}`;

/** A job whose every write refuses, carrying `message` back verbatim. */
async function openRefusingSave(page: Page, sent: Request[], message: string): Promise<void> {
  await openJob(page, sent, undefined, {
    ...openedWorld(),
    refuseSave: { code: "STUB_UNMAPPED_REFUSAL", message },
  });
  await drawOneUnsavedBox(page);
  await page.getByTestId("save-and-stay").click();
  await expect(page.getByTestId("save-refusal")).toBeVisible();
}

test("an in-editor notice anchors top-right of the stage, clear of both corners", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openRefusingSave(page, sent, "the kernel's own wording");

  const stage = (await page.getByTestId("canvas-stage").boundingBox())!;
  const card = (await page.getByTestId("save-refusal").boundingBox())!;
  // The stage's hairline, subtracted rather than absorbed into the number: an
  // absolutely positioned child is offset from the padding edge, so a bare
  // `boundingBox` comparison reads 17 and would have to be explained as 16 + 1
  // every time somebody changed the border.
  const border = await page
    .getByTestId("canvas-stage")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).borderTopWidth));

  // 16px — the `md` step — in from the stage's top and right edges. Measured
  // against the *stage*, which is the surface the notice floats over; the top bar
  // is above it and is not what the inset is relative to.
  expect(Math.round(card.y - stage.y - border)).toBe(16);
  expect(Math.round(stage.x + stage.width - border - (card.x + card.width))).toBe(16);

  // The two occupied corners, and the whole reason this one was chosen. The
  // suggest card used to clear the zoom widget with a hard-coded `bottom-16`,
  // and before that sat *under* it, where the widget's subtree swallowed the
  // presses meant for the card's own buttons.
  const strip = (await page.getByTestId("tool-palette").boundingBox())!;
  expect(card.x).toBeGreaterThan(strip.x + strip.width);
  const zoom = (await page.getByTestId("zoom-widget").boundingBox())!;
  expect(card.y + card.height).toBeLessThan(zoom.y);
});

test("a notice wraps a model reference no fixed width could have fitted", async ({ page }) => {
  const sent: Request[] = [];
  await openRefusingSave(page, sent, `Could not reach ${LONG_MODEL_REF} on this machine.`);

  const notice = page.getByTestId("save-refusal");
  // The whole token is on screen, not an elided prefix.
  await expect(notice).toContainText(LONG_MODEL_REF);

  // Nothing to scroll sideways: the token broke mid-word rather than pushing the
  // card's content past its own edge. Widening alone would not have done this —
  // `wrap-anywhere` is the invariant and the width is comfort.
  const overflow = await notice.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // And the card itself did not grow out of the stage to make room.
  const stage = (await page.getByTestId("canvas-stage").boundingBox())!;
  const card = (await notice.boundingBox())!;
  expect(card.x).toBeGreaterThanOrEqual(stage.x);
  expect(card.x + card.width).toBeLessThanOrEqual(stage.x + stage.width);
  // The page never scrolls sideways for a message.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
});

/**
 * The chip's replacement, and it is only provable here.
 *
 * Radix opens a tooltip on hover and on focus, and jsdom runs neither for real —
 * so "the chord is still taught" is a claim about a real pointer over a real
 * button, on the one control that used to print `⌘S` inside itself.
 */
test("Save and stay teaches its chord in a tooltip now the keycap is gone", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);
  await drawOneUnsavedBox(page);

  const stay = page.getByTestId("save-and-stay");
  await expect(stay.locator("kbd")).toHaveCount(0);

  await stay.hover();

  const tip = page.getByTestId("save-and-stay-shortcut").first();
  await expect(tip).toBeVisible();
  // `modKey()` spells the platform's own modifier, so the assertion is on the
  // half that does not move.
  await expect(tip).toContainText(/Save and stay \((⌘|Ctrl)S\)/);
});

/**
 * Saving must not move the camera.
 *
 * The viewport is `AnnotatorCanvas`'s own state and only a real browser has one:
 * jsdom's `getBoundingClientRect` answers all zeros, so there is no fit to
 * disturb, no wheel notch to apply and no pan to measure. A component test for
 * this would pass with the bug fully present.
 *
 * Both halves are read at once off the `<svg>`'s box, which is `_frame.ts`'s own
 * idiom: the element is laid out at the asset's native size inside the
 * `translate(pan) scale(zoom)` wrapper, so its on-screen rect folds zoom, pan and
 * the pane's origin into one measurement. The readout is asserted beside it
 * because a zoom that survived while the pan did not would otherwise read as a
 * pass.
 */
test("saving leaves the viewport exactly where it was", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent);

  const canvas = page.getByTestId("annotator-canvas");
  const pane = (await page.getByTestId("annotator-pane").boundingBox())!;

  // Off the fitted view in both dimensions: a wheel notch over a point that is
  // not the pane's centre changes the zoom *and* the pan, and the secondary drag
  // after it moves the pan again on its own.
  await zoomWheel(page, { x: pane.x + pane.width * 0.35, y: pane.y + pane.height * 0.35 }, -600);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(pane.x + pane.width * 0.55, pane.y + pane.height * 0.5, { steps: 8 });
  await page.mouse.up({ button: "right" });

  const zoomBefore = await page.getByTestId("zoom-readout").textContent();
  expect(zoomBefore).not.toBe("100%");
  const frameBefore = (await canvas.boundingBox())!;

  // Something to actually store — a save with an empty plan sends no request and
  // rebuilds nothing, so a clean frame could not reproduce this at all.
  await drawOneUnsavedBox(page);
  await page.getByTestId("save-and-stay").click();
  await expect(page.getByTestId("save-state")).toContainText("Saved");
  // The refetch the save triggers is what rebuilds the store; wait for the
  // rebuilt document rather than for the button, or the assertion below can run
  // in the window before the camera has been moved.
  await expect(page.getByTestId("object-total")).toContainText("1 object");

  expect(await page.getByTestId("zoom-readout").textContent()).toBe(zoomBefore);
  const frameAfter = (await canvas.boundingBox())!;
  expect({
    x: Math.round(frameAfter.x),
    y: Math.round(frameAfter.y),
    width: Math.round(frameAfter.width),
    height: Math.round(frameAfter.height),
  }).toEqual({
    x: Math.round(frameBefore.x),
    y: Math.round(frameBefore.y),
    width: Math.round(frameBefore.width),
    height: Math.round(frameBefore.height),
  });
});

/**
 * Where a wait is reported, and where it must not be.
 *
 * jsdom cannot answer either half: a cursor is a computed style on a laid-out
 * element, and "nothing is drawn near the click" is a claim about coordinates
 * that every rectangle being zero makes meaningless.
 *
 * The request is **held open** rather than delayed by a sleep. `e2e_discipline`
 * bans fixed waits and is right to: a sleep is a coin toss against any real
 * timing, while a route that has genuinely not answered keeps the wait true for
 * as long as the assertions need it.
 */
test("a suggest request that is out says so on the panel and nowhere else", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, undefined, undefined, undefined, true);

  // Registered after `serveApi`'s, so it wins: Playwright consults the most
  // recently added matching handler first.
  let answer = (): void => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  await page.route("**/inference/suggest", async (route) => {
    await held;
    await route.fulfill({
      json: {
        model_ref: "facebook/sam2-hiera-base-plus@main",
        confidence: 0.91,
        regions: [
          {
            geometry: { type: "bbox", x: 100, y: 100, width: 80, height: 60 },
            contour: [],
          },
        ],
        applied: { detail: "balanced" },
        parameters: [],
      },
    });
  });

  await page.getByTestId("tool-suggest").click();
  await expect(page.getByTestId("suggest-idle")).toBeVisible();

  const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
  await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);

  // The card is the report, and it is up on the frame the request left.
  await expect(page.getByTestId("suggest-asking")).toBeVisible();
  await expect(page.getByTestId("suggest-cold-start")).toHaveCount(0);

  // The mutation test for the removal: restore the ring or the busy cursor and
  // one of these turns red (#557).
  await expect(page.getByTestId("suggest-halo")).toHaveCount(0);
  await expect(page.getByTestId("annotator-pane")).not.toHaveCSS("cursor", "progress");

  // The clicks themselves are still drawn — those are what makes a refine
  // legible, and they are not an indicator.
  await expect(page.getByTestId("prompt-points")).toBeVisible();

  answer();

  await expect(page.getByTestId("suggestion-shape")).toBeVisible();
  await expect(page.getByTestId("annotator-pane")).not.toHaveCSS("cursor", "progress");
});

test("escape takes the wait back while the request is still out", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, undefined, undefined, undefined, true);

  let answer = (): void => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  await page.route("**/inference/suggest", async (route) => {
    await held;
    await route.fulfill({ status: 200, json: { model_ref: "m@1", region: null } });
  });

  await page.getByTestId("tool-suggest").click();
  await expect(page.getByTestId("suggest-idle")).toBeVisible();

  const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
  await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
  await expect(page.getByTestId("suggest-asking")).toBeVisible();

  await page.keyboard.press("Escape");

  // Down with the points — the request is still out, so nothing but the explicit
  // cancel could have done this.
  await expect(page.getByTestId("suggest-asking")).toHaveCount(0);
  await expect(page.getByTestId("prompt-points")).toHaveCount(0);

  answer();
});

/**
 * The adjustments, in a real browser.
 *
 * jsdom can say the section renders. What it cannot say is that a bracket
 * reaches it from the keyboard, that the shape changes without a request
 * leaving, that pressing a control leaves the keyboard working, or that a press
 * on the card never reaches the picture underneath — all of which are about a
 * live document with focus and hit-testing in it.
 */
test("a box class is offered no adjustments at all", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, undefined, undefined, undefined, true);

  await page.getByTestId("tool-suggest").click();
  const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
  await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
  await expect(page.getByTestId("suggestion-shape")).toBeVisible();

  // The stub declares `[]`, which is what the kernel declares for a box — and the
  // editor renders exactly that. No condition in the app mentions a box at all.
  await expect(page.getByTestId("suggest-adjust-open")).toHaveCount(0);
  await expect(page.getByTestId("suggest-adjustments")).toHaveCount(0);
  await expect(page.getByTestId("suggest-detail")).toHaveCount(0);
});

/** A traced ring big enough that the three steps genuinely differ. */
const RING = Array.from({ length: 64 }, (_, index) => {
  const angle = (index / 64) * 2 * Math.PI;
  return [Math.round(160 + 90 * Math.cos(angle)), Math.round(160 + 90 * Math.sin(angle))];
});

/** A polygon answer over that ring, with `detail` declared as the one setting. */
async function servePolygonSuggestion(page: Page): Promise<void> {
  await page.route("**/inference/suggest", async (route) =>
    route.fulfill({
      json: {
        model_ref: "facebook/sam2-hiera-base-plus@main",
        confidence: 0.9,
        regions: [{ geometry: { type: "polygon", points: RING }, contour: RING }],
        applied: { detail: "balanced" },
        parameters: ["detail"],
      },
    }),
  );
}

/** The vertex count the canvas is actually drawing, read off the polygon itself. */
async function drawnVertices(page: Page): Promise<number> {
  const points = (await page.getByTestId("suggestion-shape").getAttribute("points")) ?? "";
  return points.trim().split(/\s+/).filter(Boolean).length;
}

const asks = (sent: readonly Request[]): number =>
  sent.filter((one) => one.url().includes("/inference/suggest")).length;

test("a polygon class steps its detail from the keyboard, with no request", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, undefined, undefined, undefined, true);
  await servePolygonSuggestion(page);

  await page.getByTestId("tool-suggest").click();
  const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
  await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
  await expect(page.getByTestId("suggestion-shape")).toBeVisible();

  // The bracket first, with nothing opened — which is the whole point of it.
  // The shape on the canvas is what has to move, so that is what is measured.
  const before = asks(sent);

  await page.keyboard.press("[");
  const coarse = await drawnVertices(page);
  // The claim that only a real request log can settle: no round trip.
  expect(asks(sent)).toBe(before);

  await page.keyboard.press("]");
  await page.keyboard.press("]");
  const fine = await drawnVertices(page);
  expect(fine).toBeGreaterThan(coarse);
  expect(asks(sent)).toBe(before);

  // And it stops at the end rather than wrapping round to the coarsest.
  await page.keyboard.press("]");
  expect(await drawnVertices(page)).toBe(fine);

  await page.keyboard.press("[");
  await page.keyboard.press("[");

  await page.getByTestId("suggest-adjust-open").click();
  await expect(page.getByTestId("suggest-detail-label")).toHaveText(`Coarse · ${coarse} pts`);
  await expect(page.getByTestId("suggest-detail")).toHaveValue("0");

  // Opening the section must not switch the keyboard off, which is what a control
  // taking focus would silently do — and does, in a browser, where jsdom has no
  // focus to move and would report this working.
  await page.keyboard.press("]");
  await expect(page.getByTestId("suggest-detail")).toHaveValue("1");

  // Escape closes the adjustments and stops there: the points and the shape are
  // both still on screen, and the second press is what takes them.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("suggest-adjustments")).toHaveCount(0);
  await expect(page.getByTestId("suggestion-shape")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("suggestion-shape")).toHaveCount(0);
  await expect(page.getByTestId("suggest-idle")).toBeVisible();
});

test("the preview draws its vertices, and a committed shape does not", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, undefined, undefined, undefined, true);
  await servePolygonSuggestion(page);

  await page.getByTestId("tool-suggest").click();
  const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
  await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);

  const preview = page.getByTestId("suggestion-preview");
  await expect(preview.getByTestId("suggestion-shape")).toBeVisible();

  // Dashed, and carrying one dot per vertex. Without the dots the detail control
  // moves a number and nothing anybody can see (#557).
  await expect(preview.locator("polygon")).toHaveAttribute("stroke-dasharray", "10 6");
  const drawn = await drawnVertices(page);
  expect(drawn).toBeGreaterThan(3);
  await expect(preview.locator("circle")).toHaveCount(drawn);

  // The set follows the detail, with no request — the same fact the counter
  // reports, read off the canvas instead.
  await page.keyboard.press("[");
  await expect(preview.locator("circle")).toHaveCount(await drawnVertices(page));

  // Accept it, and it becomes an ordinary shape: solid, and no vertices until it
  // is selected. That is the contrast the preview state exists to make.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("suggestion-preview")).toHaveCount(0);
  const committed = page.getByTestId("annotator-canvas").locator("g[data-annotation-id]");
  await expect(committed).toHaveCount(1);
  await expect(committed.locator("polygon")).not.toHaveAttribute("stroke-dasharray", "10 6");
});

test("the detail slider moves under the pointer, and hands the keyboard back", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, undefined, undefined, undefined, true);
  await servePolygonSuggestion(page);

  await page.getByTestId("tool-suggest").click();
  const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
  await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
  await expect(page.getByTestId("suggestion-shape")).toBeVisible();
  await page.getByTestId("suggest-adjust-open").click();

  const slider = page.getByTestId("suggest-detail");
  await expect(slider).toHaveValue("1");
  const before = asks(sent);

  // A real drag: press the thumb, travel, release. `fill()` and `click()` both
  // set the value without ever exercising the default action, which is exactly
  // the gap that let a slider ship unmovable — `preventDefault` on the press
  // cancelled the drag and every jsdom assertion still passed (#563).
  const track = (await slider.boundingBox())!;
  await page.mouse.move(track.x + track.width / 2, track.y + track.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width - 1, track.y + track.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect(slider).toHaveValue("2");
  await expect(page.getByTestId("suggest-detail-label")).toContainText("Fine");
  const fine = await drawnVertices(page);
  // Still no round trip: the drag is arithmetic, like the brackets.
  expect(asks(sent)).toBe(before);

  // Dragging the other way, to the coarsest stop. Two *client* simplifications
  // compared against each other — the answer's own geometry arrives already
  // reduced by the server and is not one of the three steps.
  await page.mouse.move(track.x + track.width / 2, track.y + track.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + 1, track.y + track.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(slider).toHaveValue("0");
  await expect(page.getByTestId("suggest-detail-label")).toContainText("Coarse");
  expect(fine).toBeGreaterThan(await drawnVertices(page));

  // And the canvas has its keyboard back the moment the drag ended — without
  // this the brackets, Esc and Enter are all dead and nothing says why.
  await page.keyboard.press("]");
  await expect(slider).toHaveValue("1");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("suggest-adjustments")).toHaveCount(0);
  await expect(page.getByTestId("suggestion-shape")).toBeVisible();
});

test("a press on the suggest panel never reaches the picture underneath", async ({ page }) => {
  const sent: Request[] = [];
  await openJob(page, sent, undefined, undefined, undefined, undefined, true);
  await servePolygonSuggestion(page);

  await page.getByTestId("tool-suggest").click();
  const picture = (await page.getByTestId("annotator-canvas").boundingBox())!;
  await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
  await expect(page.getByTestId("suggestion-shape")).toBeVisible();

  const seeded = await page.getByTestId("prompt-points").locator("circle").count();
  const before = asks(sent);

  // Every interactive control on the card, in turn. None of them may fire a
  // suggest or move the seed point — the card sits over the picture, so a press
  // that fell through would place a prompt point where somebody was aiming at a
  // button (#557).
  await page.getByTestId("suggest-adjust-open").click();
  await expect(page.getByTestId("suggest-adjustments")).toBeVisible();

  const slider = page.getByTestId("suggest-detail");
  const box = (await slider.boundingBox())!;
  await page.mouse.click(box.x + 2, box.y + box.height / 2);
  await slider.click();

  expect(asks(sent)).toBe(before);
  await expect(page.getByTestId("prompt-points").locator("circle")).toHaveCount(seeded);

  // And the keyboard still belongs to the canvas after all of it, which is the
  // half a click that merely *took focus* would break.
  await page.keyboard.press("]");
  await expect(page.getByTestId("suggest-adjustments")).toBeVisible();
  expect(asks(sent)).toBe(before);
});
