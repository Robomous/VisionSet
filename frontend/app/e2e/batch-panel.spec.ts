/**
 * A batch, in its panel on the Overview — the one place it is looked at and the
 * one place it moves.
 *
 * ## What this replaces
 *
 * A batch used to have a page of its own, a gallery at
 * `/projects/:id/batches/:batchId`, and every lifecycle action was made there.
 * The page is gone: a batch opens in the Overview's right-hand panel
 * (`<aside aria-label="Batch">`, `batch-sheet`), addressed by `?batch=`, and the
 * old URL redirects to it. What the gallery did that has no successor — the
 * frame grid, per-frame progress moves, draft membership editing, the density
 * slider, the job accordions — went with it, and so did the scenarios that
 * covered them. The lifecycle scenarios did not: *Approve*, *Start annotating*,
 * *Complete*, *Complete and promote*, *Promote*, *Create correction batch* and
 * *Delete batch* are the same controls, now in the panel's footer
 * (`batch-sheet-actions`), and each is asserted here against the same stubbed
 * kernel gates the gallery's were.
 *
 * ## Why a browser
 *
 * Which controls a person can press, in what order the writes reach the server,
 * and what the address says after each are claims about a rendered page and a
 * router. The components' own claims — gating, wording, refusals — live in
 * `ui-core`'s vitest suites; the claim that lives here is that the Overview, the
 * URL and the panel agree with each other, and that every write is the one the
 * kernel would accept.
 *
 * Everything is routed under `/api/`, which is where the app sends requests in
 * development. Routing the bare paths would also intercept the *document*
 * navigation, and the failure reads as "the shell disappeared".
 */

import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { batchActions, jobActions, projectDigest, type Wire } from "./_wire";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const BATCH = "22222222-2222-4222-8222-222222222222";
const CORRECTION = "66666666-6666-4666-8666-666666666666";
const JOB = "33333333-3333-4333-8333-333333333333";
const JOB_B = "55555555-5555-4555-8555-555555555555";
const DATASET = "44444444-4444-4444-8444-444444444444";
const NAME = "drive-01";

/** Mid-flight, and deliberately not what the batch's own total says about a page of it. */
const BATCH_COUNTS = {
  total: 48,
  unannotated: 30,
  pre_labeled: 0,
  annotated: 8,
  review_pending: 5,
  accepted: 1,
  skipped: 4,
} satisfies Wire["ProgressCounts"];

/**
 * Nothing outstanding, which is the whole precondition for finishing.
 *
 * The default fixture is mid-flight (30 of 48 unannotated), which is the wrong
 * shape for every claim about *finishing*: Complete is withheld while work is
 * outstanding, so a test written against the default would assert against a
 * control that is correctly disabled.
 */
const SETTLED_COUNTS = {
  total: 48,
  unannotated: 0,
  pre_labeled: 0,
  annotated: 3,
  review_pending: 0,
  accepted: 0,
  skipped: 45,
} satisfies Wire["ProgressCounts"];

/** A draft has no jobs, so its counts are documented zeros rather than data. */
const DRAFT_COUNTS = {
  total: 0,
  unannotated: 0,
  pre_labeled: 0,
  annotated: 0,
  review_pending: 0,
  accepted: 0,
  skipped: 0,
} satisfies Wire["ProgressCounts"];

const SCHEMA = {
  project_id: PROJECT,
  version: 3,
  classes: [{ name: "vehicle", geometries: ["bbox"], color: "#38bdf8", attributes: [] }],
} satisfies Wire["SchemaVersionOut"];

interface Options {
  /** `draft` is the state with the approve CTA, and the state with no jobs. */
  readonly state?: Wire["BatchState"];
  /** Cut the batch into two jobs rather than one. */
  readonly twoJobs?: boolean;
  /** Every frame settled and nothing outstanding. */
  readonly settled?: boolean;
  /** The state the batch's job is in when the page loads. */
  readonly jobState?: Wire["AnnotationJobState"];
}

/**
 * The kernel, as far as one batch's lifecycle goes.
 *
 * It moves as the requests land, for the same reason the server's would: a static
 * stub lets an implementation that never sent the write — which is the entire
 * defect in most of these — pass. The gates the kernel keeps are kept here too,
 * so a control that skipped a link in the chain meets the real 409 rather than a
 * permissive fixture.
 */
async function serveApi(page: Page, sent: Request[], options: Options = {}): Promise<void> {
  const twoJobs = options.twoJobs === true;
  const roster = twoJobs ? [JOB, JOB_B] : [JOB];
  let current = options.state ?? "in_annotation";
  let job = options.jobState ?? "in_progress";
  // What a promotion moved into the trunk, read back by the batch the way the
  // server derives `promoted_asset_count` per read.
  let promoted = 0;
  let deleted = false;
  let correction: Wire["BatchOut"] | null = null;

  const countsFor = (state: Wire["BatchState"]): Wire["ProgressCounts"] =>
    state === "draft" ? DRAFT_COUNTS : options.settled === true ? SETTLED_COUNTS : BATCH_COUNTS;

  const batchOut = (): Wire["BatchOut"] => {
    const counts = countsFor(current);
    return {
      id: BATCH,
      project_id: PROJECT,
      name: NAME,
      state: current,
      schema_version: current === "draft" ? null : 3,
      asset_count: 48,
      progress: counts,
      allowed_actions: batchActions(current),
      promoted_asset_count: promoted,
      parent_batch_id: null,
      pre_label_run: null,
    };
  };

  const jobOut = (id: string): Wire["JobOut"] => ({
    id,
    batch_id: BATCH,
    state: job,
    asset_count: twoJobs ? 24 : 48,
    allowed_actions: jobActions(job),
    assignee: null,
    pre_label_run: null,
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");

    // Answered before anything is recorded: every page load asks whether this
    // server will sign the browser in by itself, and here it will not.
    if (path === "/session") return route.fulfill({ json: { issued: false } });
    sent.push(request);

    if (path === "/projects") {
      return route.fulfill({
        json: {
          items: [{ id: PROJECT, name: "road-signs", description: null, thumbnail_asset_id: null, thumbnail_hash: null, created_at: null, digest: projectDigest() }],
          total: 1,
        } satisfies Wire["ProjectPage"],
      });
    }
    if (path === `/projects/${PROJECT}`) {
      return route.fulfill({
        json: { id: PROJECT, name: "road-signs", description: null, thumbnail_asset_id: null, thumbnail_hash: null, created_at: null } satisfies Wire["ProjectOut"],
      });
    }
    if (path === `/projects/${PROJECT}/schema`) return route.fulfill({ json: SCHEMA });
    if (path === `/projects/${PROJECT}/schema/versions/3`) return route.fulfill({ json: SCHEMA });
    if (path === `/projects/${PROJECT}/dataset`) {
      return route.fulfill({
        json: { id: DATASET, project_id: PROJECT, name: "road-signs", description: null } satisfies Wire["DatasetOut"],
      });
    }
    if (path === `/datasets/${DATASET}/stats`) {
      return route.fulfill({
        json: { dataset_id: DATASET, asset_count: 0, annotated_asset_count: 0, annotation_count: 0, classes: [] } satisfies Wire["DatasetStatsOut"],
      });
    }
    if (path === `/projects/${PROJECT}/stats`) {
      return route.fulfill({
        json: {
          project_id: PROJECT,
          asset_count: 48,
          annotated_asset_count: 0,
          annotation_count: 0,
          class_count: 1,
          annotated_pct: 0,
          classes: [],
          last_ingest_at: null,
        } satisfies Wire["ProjectStatsOut"],
      });
    }
    if (path === `/projects/${PROJECT}/batches`) {
      const items = [...(deleted ? [] : [batchOut()]), ...(correction === null ? [] : [correction])];
      return route.fulfill({ json: { items, total: items.length } satisfies Wire["BatchPage"] });
    }

    // --- one batch's lifecycle ---------------------------------------------
    if (method === "POST" && path === `/batches/${BATCH}/approve`) {
      current = "approved";
      return route.fulfill({ json: batchOut() });
    }
    if (method === "POST" && path === `/batches/${BATCH}/start`) {
      current = "in_annotation";
      return route.fulfill({ json: batchOut() });
    }
    if (method === "POST" && path === `/batches/${BATCH}/complete`) {
      // The kernel's own gate, and the 409 the founder saw reproduced exactly:
      // every asset settled, one job still open, and the batch refusing.
      if (job !== "completed") {
        return route.fulfill({
          status: 409,
          json: { code: "BATCH_NOT_COMPLETE", message: `batch '${NAME}' has 1 of 1 jobs still unfinished` },
        });
      }
      current = "completed";
      return route.fulfill({ json: batchOut() });
    }
    if (method === "POST" && path === `/batches/${BATCH}/promote`) {
      // Only finished work is promoted, and the kernel says so before this
      // fixture would — a control that promoted first would meet the real refusal.
      if (current !== "completed") {
        return route.fulfill({
          status: 409,
          json: { code: "BATCH_NOT_COMPLETE", message: `batch '${NAME}' is '${current}'` },
        });
      }
      promoted = SETTLED_COUNTS.annotated;
      return route.fulfill({
        json: {
          items: Array.from({ length: promoted }, (_, at) => ({
            id: `asset-${at}`,
            project_id: PROJECT,
            modality: "image",
            point_cloud: null,
            content_hash: `${at}`.padStart(8, "0") + "deadbeef",
            width: 1280,
            height: 720,
            format: "jpeg",
            source_id: null,
            frame_index: at,
            frame_timestamp: null,
            thumbnail_hash: null,
            ingested_at: "2026-08-01T09:00:00Z",
          })),
          total: promoted,
        } satisfies Wire["AssetPage"],
      });
    }
    if (method === "POST" && path === `/batches/${BATCH}/corrections`) {
      // Only a completed batch is corrected, and the child starts as a draft over
      // the parent's frames — `parent_batch_id` is the lineage the panel follows.
      if (current !== "completed") {
        return route.fulfill({
          status: 409,
          json: { code: "BATCH_NOT_COMPLETE", message: `batch '${NAME}' is '${current}'` },
        });
      }
      const body = request.postDataJSON() as { name: string };
      correction = {
        id: CORRECTION,
        project_id: PROJECT,
        name: body.name,
        state: "draft",
        schema_version: null,
        asset_count: 48,
        progress: DRAFT_COUNTS,
        allowed_actions: batchActions("draft"),
        promoted_asset_count: 0,
        parent_batch_id: BATCH,
        pre_label_run: null,
      };
      return route.fulfill({ json: correction });
    }
    if (method === "DELETE" && path === `/batches/${BATCH}`) {
      // `completed` is the one state with no delete, and the kernel says so
      // before the menu would have to.
      if (current === "completed") {
        return route.fulfill({
          status: 409,
          json: { code: "BATCH_NOT_DELETABLE", message: `batch '${NAME}' is completed` },
        });
      }
      deleted = true;
      return route.fulfill({ status: 204 });
    }
    if (method === "GET" && path === `/batches/${BATCH}`) return route.fulfill({ json: batchOut() });
    if (method === "GET" && path === `/batches/${CORRECTION}` && correction !== null) {
      return route.fulfill({ json: correction });
    }

    // --- its jobs -------------------------------------------------------------
    if (path === `/batches/${BATCH}/jobs`) {
      // A draft has no jobs at all.
      const ids = current === "draft" ? [] : roster;
      return route.fulfill({
        json: { items: ids.map(jobOut), total: ids.length } satisfies Wire["JobPage"],
      });
    }
    if (method === "GET" && /^\/jobs\/[^/]+\/progress$/.test(path)) {
      return route.fulfill({ json: countsFor(current) satisfies Wire["ProgressCounts"] });
    }
    if (method === "GET" && path === `/jobs/${JOB}`) return route.fulfill({ json: jobOut(JOB) });
    if (method === "POST" && path === `/jobs/${JOB}/complete`) {
      // A job may only be completed from `in_progress`, so a control that skipped
      // `start` gets the 409 a real server would send instead of a silent pass.
      if (job !== "in_progress") {
        return route.fulfill({
          status: 409,
          json: { code: "INVALID_TRANSITION", message: `job cannot become completed from ${job}` },
        });
      }
      job = "completed";
      return route.fulfill({ json: jobOut(JOB) });
    }
    return route.fulfill({ json: { items: [], total: 0 } satisfies Wire["AssetPage"] });
  });
}

/** Sign in at `url`, which is where a pasted link lands. */
async function openAt(page: Page, sent: Request[], url: string, options: Options = {}): Promise<void> {
  await serveApi(page, sent, options);
  await page.goto(url);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
}

/** The batch open in its panel, from the address a person would paste. */
async function openPanel(page: Page, sent: Request[], options: Options = {}): Promise<Locator> {
  await openAt(page, sent, `/projects/${PROJECT}/overview?batch=${BATCH}`, options);
  const panel = page.getByTestId("batch-sheet");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { level: 2, name: NAME })).toBeVisible();
  // The footer is the panel's second read: it is drawn from the batch's own
  // declarations, which arrive after the listing that opened it.
  await expect(panel.getByTestId("batch-sheet-actions")).toBeVisible();
  return panel;
}

/** Every write the page made, as `METHOD path`, in the order the server saw them. */
function writes(sent: Request[]): string[] {
  return sent
    .filter((one) => one.method() !== "GET")
    .map((one) => `${one.method()} ${new URL(one.url()).pathname.replace(/^\/api/, "")}`);
}

// --- the old address, and the new one ------------------------------------------
//
// That the old URL lands on the panel, naming its batch, is asserted with the other
// addresses a project answers, in `navigation.spec.ts`; what is here is the half
// only a history stack can show.

test("the redirect replaces the old address, so Back does not bounce into it", async ({ page }) => {
  const sent: Request[] = [];
  await serveApi(page, sent);
  // One page of history before the old address, which is what Back would land on.
  await page.goto(`/projects/${PROJECT}/ingest`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("ingest-screen")).toBeVisible();

  await page.goto(`/projects/${PROJECT}/batches/${BATCH}`);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/overview\\?batch=${BATCH}$`));
  await expect(page.getByTestId("batch-sheet")).toBeVisible();

  // `replace`: were the old address left in history, Back would redirect straight
  // back to the panel and the person could never leave.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/ingest$`));
});

test("opening a batch from its row writes it into the address, and closing takes it out", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openAt(page, sent, `/projects/${PROJECT}/overview`);

  await expect(page.getByTestId("overview-batches")).toBeVisible();
  await expect(page.getByTestId("batch-sheet")).toHaveCount(0);
  await page.locator(`[data-row-open="${BATCH}"]`).click();

  // The open batch is the URL's, so a reload or a pasted link opens the same panel.
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/overview\\?batch=${BATCH}$`));
  await expect(page.getByTestId("batch-sheet").getByRole("heading", { level: 2, name: NAME })).toBeVisible();

  await page.getByTestId("batch-close").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/overview$`));
  await expect(page.getByTestId("batch-sheet")).toHaveCount(0);
});

test("a rail destination pressed with the panel open goes there, and the panel does not pull it back", async ({
  page,
}) => {
  const sent: Request[] = [];
  await openAt(page, sent, `/projects/${PROJECT}/overview?batch=${BATCH}`);
  await expect(page.getByTestId("batch-sheet").getByRole("heading", { level: 2, name: NAME })).toBeVisible();

  // The press outside dismisses the panel, which takes `?batch=` out of the
  // address; that must not land on top of the navigation the press asked for.
  await page.getByTestId("rail-projects").click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByTestId("projects-screen")).toBeVisible();
});

test("a section pressed with the panel open goes there, and the panel does not pull it back", async ({ page }) => {
  const sent: Request[] = [];
  await openAt(page, sent, `/projects/${PROJECT}/overview?batch=${BATCH}`);
  await expect(page.getByTestId("batch-sheet").getByRole("heading", { level: 2, name: NAME })).toBeVisible();

  await page.getByTestId("nav-images").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/images$`));
  await expect(page.getByTestId("batch-sheet")).toHaveCount(0);
});

test("the panel says which batch it is showing and how far it has come", async ({ page }) => {
  const sent: Request[] = [];
  const panel = await openPanel(page, sent);

  await expect(panel.getByTestId("batch-phase")).toHaveText("Labeling");
  const facts = panel.getByTestId("batch-sheet-facts");
  await expect(facts).toContainText("48");
  await expect(facts).toContainText("v3");
  // Done is everything past `unannotated`: 18 of 48, so the readout is a count,
  // not a state word.
  await expect(facts).toContainText("18 of 48");
});

// --- jobs ----------------------------------------------------------------------

test("a one-job batch lists its job, and Annotate and the job's Open both go into it", async ({
  page,
}) => {
  const sent: Request[] = [];
  const panel = await openPanel(page, sent);

  const jobs = panel.getByTestId("batch-sheet-jobs");
  await expect(jobs.getByTestId("batch-sheet-job-Job 1")).toContainText("Unassigned");
  await expect(jobs.getByTestId(/^batch-sheet-job-/)).toHaveCount(1);

  // The panel's forward step is filled while there is work left, and with exactly
  // one job it goes straight into the editor.
  const annotate = panel.getByTestId("sheet-annotate");
  await expect(annotate).toHaveAttribute("data-variant", "default");
  await annotate.click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${JOB}$`));
});

test("a two-job batch lists both jobs, offers no single Annotate, and each Open goes to its own job", async ({
  page,
}) => {
  const sent: Request[] = [];
  const panel = await openPanel(page, sent, { twoJobs: true });

  const jobs = panel.getByTestId("batch-sheet-jobs");
  await expect(jobs.getByTestId(/^batch-sheet-job-/)).toHaveCount(2);
  await expect(jobs.getByTestId("batch-sheet-job-Job 1")).toBeVisible();
  await expect(jobs.getByTestId("batch-sheet-job-Job 2")).toBeVisible();

  // With two jobs there is no one place *Annotate* could go, so the panel leaves the
  // choice to the jobs themselves rather than picking one.
  await expect(panel.getByTestId("sheet-annotate")).toHaveCount(0);

  await jobs.getByRole("button", { name: "Open Job 2 in the editor" }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${JOB_B}$`));
});

test("a draft batch has no jobs, and says approving is what cuts them", async ({ page }) => {
  const sent: Request[] = [];
  const panel = await openPanel(page, sent, { state: "draft" });

  const jobs = panel.getByTestId("batch-sheet-jobs");
  await expect(jobs).toContainText("No jobs yet");
  await expect(jobs.getByTestId(/^batch-sheet-job-/)).toHaveCount(0);
  await expect(panel.getByTestId("batch-phase")).toHaveText("Draft");
});

// --- the footer is drawn from what the batch declares --------------------------

/**
 * Which controls each state offers, and which it withholds.
 *
 * The footer renders `allowed_actions`, never the state: a control the batch does
 * not declare is not there at all. Asserted in the browser, against the real
 * footer, because the claim is about what a person can press.
 */
const OFFERED: ReadonlyArray<{
  readonly state: Wire["BatchState"];
  readonly options?: Options;
  readonly present: readonly string[];
  readonly absent: readonly string[];
}> = [
  {
    state: "draft",
    present: ["approve-batch"],
    absent: ["start-batch", `complete-${NAME}`, `complete-promote-${NAME}`, `promote-${NAME}`, `correct-${NAME}`, "sheet-annotate", "sheet-prelabel"],
  },
  {
    state: "approved",
    present: ["start-batch"],
    absent: ["approve-batch", `complete-${NAME}`, `complete-promote-${NAME}`, `promote-${NAME}`, `correct-${NAME}`, "sheet-annotate", "sheet-prelabel"],
  },
  {
    state: "in_annotation",
    present: [`complete-${NAME}`, `complete-promote-${NAME}`, "sheet-annotate", "sheet-prelabel"],
    absent: ["approve-batch", "start-batch", `promote-${NAME}`, `correct-${NAME}`],
  },
  {
    state: "completed",
    options: { settled: true },
    present: [`promote-${NAME}`, `correct-${NAME}`],
    absent: ["approve-batch", "start-batch", `complete-${NAME}`, `complete-promote-${NAME}`, "sheet-annotate", "sheet-prelabel"],
  },
];

for (const { state, options, present, absent } of OFFERED) {
  test(`a ${state} batch offers exactly the controls it declares`, async ({ page }) => {
    const sent: Request[] = [];
    const panel = await openPanel(page, sent, { ...options, state });
    const footer = panel.getByTestId("batch-sheet-actions");

    for (const id of present) await expect(footer.getByTestId(id), `${id} on a ${state} batch`).toBeVisible();
    for (const id of absent) await expect(footer.getByTestId(id), `${id} on a ${state} batch`).toHaveCount(0);
    // The overflow is always there: it holds Delete, which is disabled with its reason
    // rather than removed.
    await expect(footer.getByTestId(`batch-overflow-${NAME}`)).toBeVisible();
    // Nothing was sent by looking.
    expect(writes(sent)).toEqual([]);
  });
}

test("a completed batch's Delete is withheld with its reason, not hidden", async ({ page }) => {
  const sent: Request[] = [];
  const panel = await openPanel(page, sent, { state: "completed", settled: true });

  await panel.getByTestId(`batch-overflow-${NAME}`).click();
  await expect(page.getByTestId(`delete-batch-${NAME}`)).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId(`delete-withheld-${NAME}`)).toBeVisible();
  expect(writes(sent)).toEqual([]);
});

// --- approval ------------------------------------------------------------------

test("a draft batch is approved from its panel, and the panel follows the server's answer", async ({
  page,
}) => {
  const sent: Request[] = [];
  const panel = await openPanel(page, sent, { state: "draft" });

  await expect(panel.getByTestId("batch-phase")).toHaveText("Draft");
  await panel.getByTestId("approve-batch").click();
  await expect(page.getByTestId("approve-dialog")).toBeVisible();
  // Nothing is sent by opening the dialog: approval carries a partition, pins the
  // schema and cuts the jobs, and cannot be rolled back.
  expect(writes(sent)).toEqual([]);
  await page.getByTestId("approve-submit").click();

  // The badge moves because the server said so, and the control goes because the
  // batch no longer declares `approve`. Nothing here was optimistic.
  await expect(panel.getByTestId("batch-phase")).toHaveText("Approved");
  await expect(panel.getByTestId("approve-batch")).toHaveCount(0);
  await expect(panel.getByTestId("start-batch")).toBeVisible();
  expect(writes(sent)).toEqual([`POST /batches/${BATCH}/approve`]);
  // The partition is explicit — the tag a discriminated union needs to pick a variant.
  const approve = sent.find((one) => one.method() === "POST")!;
  expect(approve.postDataJSON()).toEqual({ partition: { kind: "single" } });
  // The panel stays on this batch, and the address with it.
  await expect(page).toHaveURL(new RegExp(`\\?batch=${BATCH}$`));
});

test("cancelling the approve dialog changes nothing", async ({ page }) => {
  const sent: Request[] = [];
  const panel = await openPanel(page, sent, { state: "draft" });

  await panel.getByTestId("approve-batch").click();
  await page.getByTestId("approve-cancel").click();

  await expect(page.getByTestId("approve-dialog")).toHaveCount(0);
  await expect(panel.getByTestId("batch-phase")).toHaveText("Draft");
  await expect(panel.getByTestId("approve-batch")).toBeVisible();
  expect(writes(sent)).toEqual([]);
});

// --- starting ------------------------------------------------------------------

test("an approved batch is started from its panel", async ({ page }) => {
  const sent: Request[] = [];
  const panel = await openPanel(page, sent, { state: "approved" });

  await expect(panel.getByTestId("batch-phase")).toHaveText("Approved");
  await panel.getByTestId("start-batch").click();

  await expect(panel.getByTestId("batch-phase")).toHaveText("Labeling");
  await expect(panel.getByTestId("start-batch")).toHaveCount(0);
  expect(writes(sent)).toEqual([`POST /batches/${BATCH}/start`]);
  // It does not navigate: starting a batch is not going anywhere.
  await expect(page).toHaveURL(new RegExp(`/overview\\?batch=${BATCH}$`));
});

// --- finishing -----------------------------------------------------------------

test("Complete is withheld while frames are outstanding, and says how many", async ({ page }) => {
  const sent: Request[] = [];
  const panel = await openPanel(page, sent);

  // 30 unannotated and 5 in review: 35 frames are neither annotated nor skipped.
  await expect(panel.getByTestId(`complete-${NAME}`)).toBeDisabled();
  await expect(panel.getByTestId(`complete-blocked-${NAME}`)).toContainText("still to annotate or skip");
  await expect(panel.getByTestId(`complete-promote-${NAME}`)).toBeDisabled();
  expect(writes(sent)).toEqual([]);
});

test("completing a settled batch finishes its job first", async ({ page }) => {
  const sent: Request[] = [];
  const panel = await openPanel(page, sent, { settled: true });

  // The defect, end to end and in the browser it was reported from: 48 of 48
  // settled, one job still `in_progress`, and the only request the control used to
  // send was the one the server answers 409 to. The stub keeps both kernel gates,
  // so a control that skipped either link would fail here rather than pass on a
  // permissive fixture.
  await panel.getByTestId(`complete-${NAME}`).click();

  await expect
    .poll(() => writes(sent))
    .toEqual([`POST /jobs/${JOB}/complete`, `POST /batches/${BATCH}/complete`]);

  // And the batch really moved — the badge is the server's answer, not the button's
  // optimism, and the batch now declares promotion instead.
  await expect(panel.getByTestId("batch-phase")).toHaveText("Completed");
  await expect(panel.getByTestId(`complete-${NAME}`)).toHaveCount(0);
  await expect(panel.getByTestId(`promote-${NAME}`)).toBeVisible();
});

test("Complete and promote finishes the job, closes the batch, promotes, and says all three", async ({
  page,
}) => {
  const sent: Request[] = [];
  const panel = await openPanel(page, sent, { settled: true });

  // With nothing outstanding the composed step is the panel's one filled control and
  // *Annotate* steps down beside it.
  const composed = panel.getByTestId(`complete-promote-${NAME}`);
  await expect(composed).toHaveAttribute("data-variant", "default");
  await expect(panel.getByTestId("sheet-annotate")).toHaveAttribute("data-variant", "outline");
  await composed.click();

  // In order, and the job first: the batch refuses while its job is open.
  await expect(panel.getByTestId(`completed-${NAME}`)).toHaveText(
    "Completed, finishing 1 job. Promoted 3 assets to the dataset. 45 skipped frames stayed out.",
  );
  expect(writes(sent)).toEqual([
    `POST /jobs/${JOB}/complete`,
    `POST /batches/${BATCH}/complete`,
    `POST /batches/${BATCH}/promote`,
  ]);
  // The batch is `completed` now and declares no `complete`, so the button is gone —
  // the line that says what it did is not.
  await expect(composed).toHaveCount(0);
  await expect(panel.getByTestId("batch-phase")).toHaveText("Completed");
  await expect(panel.getByTestId(`complete-promote-open-dataset-${NAME}`)).toBeVisible();
});

// --- promoting -----------------------------------------------------------------

test("a completed batch is promoted from its panel, and the outcome is said", async ({ page }) => {
  const sent: Request[] = [];
  const panel = await openPanel(page, sent, { state: "completed", settled: true });

  await panel.getByTestId(`promote-${NAME}`).click();

  await expect(panel.getByTestId(`promoted-${NAME}`)).toHaveText(
    "Promoted 3 assets to the dataset. 45 skipped frames stayed out.",
  );
  expect(writes(sent)).toEqual([`POST /batches/${BATCH}/promote`]);
  // Promotion is not a transition: the batch stays completed, and the way onward is
  // offered beside the report.
  await expect(panel.getByTestId("batch-phase")).toHaveText("Completed");
  await expect(panel.getByTestId(`promoted-open-dataset-${NAME}`)).toBeVisible();
});

// --- correcting ----------------------------------------------------------------

test("a completed batch is corrected from its panel, and the panel moves to the correction", async ({
  page,
}) => {
  const sent: Request[] = [];
  const panel = await openPanel(page, sent, { state: "completed", settled: true });

  await panel.getByTestId(`correct-${NAME}`).click();
  const dialog = page.getByTestId("correction-dialog");
  await expect(dialog).toBeVisible();
  // The name is suggested, so the common case is a press rather than typing.
  await expect(dialog.getByTestId("correction-name")).not.toHaveValue("");
  const name = await dialog.getByTestId("correction-name").inputValue();
  expect(writes(sent)).toEqual([]);

  await dialog.getByTestId("correction-submit").click();

  expect(writes(sent)).toEqual([`POST /batches/${BATCH}/corrections`]);
  expect(sent.find((one) => one.method() === "POST")!.postDataJSON()).toEqual({ name });
  // The panel moves to the child — a draft, with its own address — and the parent is
  // untouched and still listed.
  await expect(page).toHaveURL(new RegExp(`/overview\\?batch=${CORRECTION}$`));
  // Named for what it is: the suggested name already says it is a correction, and the
  // panel does not say so twice.
  expect(name).toMatch(/— correction$/);
  await expect(panel.getByRole("heading", { level: 2, name })).toBeVisible();
  await expect(panel.getByTestId("batch-phase")).toHaveText("Draft");
  await expect(panel.getByTestId("approve-batch")).toBeVisible();
  await expect(page.getByTestId(`overview-batch-${NAME}`)).toBeVisible();
});

// --- deleting ------------------------------------------------------------------

test("a batch is deleted from its panel's overflow, and the panel closes with it", async ({ page }) => {
  const sent: Request[] = [];
  const panel = await openPanel(page, sent, { state: "draft" });

  await panel.getByTestId(`batch-overflow-${NAME}`).click();
  await page.getByTestId(`delete-batch-${NAME}`).click();

  // The gate is a gate: nothing is sent until the question is answered, and the
  // question states the consequence rather than asking for a nod.
  const dialog = page.getByTestId("delete-batch-dialog");
  await expect(dialog).toContainText("The annotations stay.");
  expect(writes(sent)).toEqual([]);
  await dialog.getByTestId("delete-batch-submit").click();

  await expect.poll(() => writes(sent)).toEqual([`DELETE /batches/${BATCH}`]);
  // The batch is gone, so its panel is — and so is the `?batch=` that named it.
  await expect(page.getByTestId("batch-sheet")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/overview$`));
  await expect(page.getByTestId(`overview-batch-${NAME}`)).toHaveCount(0);
});
