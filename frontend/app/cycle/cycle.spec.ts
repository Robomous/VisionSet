/**
 * The whole cycle, in a browser, against a real server.
 *
 * Token → project → schema → ingest → approve → annotate → complete → promote →
 * publish → export → download. No mocks anywhere: the bundle is the built one that
 * ships in the wheel, and `visionset ui` serves it beside the real API over the
 * real kernel.
 *
 * ## One test, and that is deliberate
 *
 * Every step needs the last one's output — there is no project to ingest into and
 * no batch to approve until earlier steps ran — and Playwright gives each test its
 * own page and its own everything. Splitting this into ten tests would mean either
 * ten sign-ins walking back through the product, or shared module state that makes
 * the order load-bearing and invisible. `test.step` gives the reporting a
 * multi-test file would have bought, without the lie.
 *
 * This is `test_external_client.py`'s shape one surface over: that file walks the
 * whole HTTP cycle in one function using none of the suite's helpers, for the same
 * reason.
 *
 * ## What it deliberately does not do
 *
 * **The source is images, not a video.** The issue says "generated video"; the
 * browser difference between the two is one number in one form, and the video path
 * is already driven end to end by `examples/ingest_end_to_end.py` in the `e2e (cli)`
 * job and by the ingest screen's own component tests. Buying it here costs an apt
 * install of ffmpeg and a decode inside a five-minute budget, for coverage that
 * exists. Recorded rather than skipped quietly.
 *
 * **The export is `dummy`, which writes nothing.** It is the only installed
 * exporter until M6, and `file_count: 0` is an export that ran. What is proved here
 * is the *round trip* — the request carries the format, the response is an archive,
 * and the browser saves it — which is exactly the part real exporters will inherit.
 */

import { expect, test, type Download, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const CYCLE_DIR = process.env["VISIONSET_CYCLE_DIR"] ?? "";

/** Written by `scripts/cycle_server.sh`, which minted it once. */
function token(): string {
  return readFileSync(path.join(CYCLE_DIR, "token"), "utf8").trim();
}

function images(): string[] {
  const dir = path.join(CYCLE_DIR, "images");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".png"))
    .sort()
    .map((name) => path.join(dir, name));
}

/** A name nothing else in the workspace will collide with. */
const PROJECT = "browser-cycle";
const TAG = "v1";

test("the whole cycle, from a pasted token to a downloaded export", async ({ page }) => {
  test.slow();

  await test.step("connect with a workspace token", async () => {
    await page.goto("./");
    await page.getByTestId("token-input").fill(token());
    await page.getByTestId("token-submit").click();
    // The rail is the product; reaching it means the credential was accepted by
    // the real `StoredTokenAuthProvider` against a real digest.
    await expect(page.getByTestId("app-rail")).toBeVisible();
  });

  await test.step("create a project", async () => {
    await page.getByTestId("new-project").click();
    await page.getByTestId("project-name").fill(PROJECT);
    await page.getByTestId("project-description").fill("Driven by #59");
    await page.getByTestId("create-submit").click();
    await expect(page.getByTestId(`project-${PROJECT}`)).toBeVisible();
    await page.getByTestId(`open-${PROJECT}`).click();
    await expect(page.getByTestId("project-screen")).toBeVisible();
  });

  await test.step("declare a schema with all three geometries", async () => {
    // A project starts schema-less on purpose, so the editor opens on an empty
    // draft rather than an error.
    await expect(page.getByTestId("schema-editor")).toContainText("Saving creates version 1");

    for (const [index, [name, geometry]] of (
      [
        ["vehicle", "bbox"],
        ["lane", "polygon"],
        ["daytime", "classification_tag"],
      ] as const
    ).entries()) {
      await page.getByTestId("add-class").click();
      await page.getByTestId(`class-name-${index}`).fill(name);
      if (geometry !== "bbox") {
        await page.getByTestId(`class-geometry-${index}`).click();
        await page.getByRole("option", { name: geometry, exact: true }).click();
      }
    }

    await page.getByTestId("save-schema").click();
    await expect(page.getByTestId("version-1")).toBeVisible();
    await expect(page.getByTestId("version-1")).toContainText("active");
  });

  await test.step("ingest three images into a new batch", async () => {
    await page.getByTestId("go-ingest").click();
    await page.getByTestId("file-input").setInputFiles(images());
    await expect(page.getByTestId("chosen")).toContainText("3 files");

    await page.getByTestId("register-source").click();
    await expect(page.getByTestId("source-card")).toBeVisible();

    await page.getByTestId("batch-name").fill("cycle-batch");
    await page.getByTestId("start-ingest").click();

    // The run is launched with a 202 and polled to its end — the only place in the
    // product where the answer arrives on a job row rather than in the response.
    await expect(page.getByTestId("run-state")).toHaveText("completed", { timeout: 60_000 });
    await expect(page.getByTestId("run-progress")).toContainText("3 of 3");
    await expect(page.getByTestId("failures")).toHaveCount(0);
  });

  let jobUrl = "";

  await test.step("approve the batch, which pins the schema and cuts one job", async () => {
    // Navigated rather than `goBack()`: history depth is an implementation detail
    // of how the previous steps got here, and a cycle this long should not depend
    // on it.
    await openProject(page);
    await expect(page.getByTestId("batches-table")).toBeVisible();
    await expect(page.getByTestId("batch-cycle-batch")).toContainText("draft");

    await page.getByTestId("approve-cycle-batch").click();
    await page.getByTestId("approve-submit").click();

    // The version pins *at approval* — before it, the column is empty.
    await expect(page.getByTestId("state-cycle-batch")).toHaveText("approved");
    await expect(page.getByTestId("batch-cycle-batch")).toContainText("v1");

    await page.getByTestId("start-cycle-batch").click();
    await expect(page.getByTestId("state-cycle-batch")).toHaveText("in_annotation");
  });

  await test.step("annotate all three assets", async () => {
    const jobId = await jobIdOf(page);
    jobUrl = `./jobs/${jobId}`;
    await page.goto(jobUrl);
    await expect(page.getByTestId("annotation-page")).toBeVisible();
    await expect(page.getByTestId("asset-position")).toContainText("1/3");

    // 1 — a box.
    await drawBox(page);
    await page.getByTestId("save").click();
    await expect(page.getByTestId("save-state")).toContainText("Saved");
    await page.getByTestId("next-asset").click();

    // 2 — a polygon, closed with Enter.
    await expect(page.getByTestId("asset-position")).toContainText("2/3");
    await drawPolygon(page);
    await page.getByTestId("save").click();
    await expect(page.getByTestId("save-state")).toContainText("Saved");
    await page.getByTestId("next-asset").click();

    // 3 — a whole-asset tag, from the Labels tab. Never the canvas.
    await expect(page.getByTestId("asset-position")).toContainText("3/3");
    await page.getByTestId("tab-labels").click();
    await page.getByTestId("label-daytime").click();
    await expect(page.getByTestId("label-daytime")).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("object-total")).toHaveText("1 object");
    await page.getByTestId("save").click();
    await expect(page.getByTestId("save-state")).toContainText("Saved");

    // The chain nothing in the browser closed before #59 found it: a batch cannot
    // complete while a job is outstanding, and a job cannot while an asset is
    // unsettled. Saving annotations settles the assets; this closes the job.
    await expect(page.getByTestId("job-progress")).toHaveText("3 / 3 annotated");
    await page.getByTestId("finish-job").click();
    await expect(page.getByTestId("finish-job")).toHaveText("Finished");
  });

  await test.step("complete the batch", async () => {
    await openProject(page);
    await expect(page.getByTestId("batches-table")).toBeVisible();
    await page.getByTestId("complete-cycle-batch").click();
    await expect(page.getByTestId("state-cycle-batch")).toHaveText("completed", {
      timeout: 30_000,
    });
  });

  await test.step("promote the completed batch into the trunk", async () => {
    // The trunk carries assets only, and promotion is a **union** against current
    // membership — idempotent, with no log entry when nothing changed.
    await page.getByTestId("promote-cycle-batch").click();
    await expect(page.getByTestId("promote-cycle-batch")).toHaveText("Promoted");
  });

  await test.step("publish a release", async () => {
    await page.getByTestId("go-dataset").click();
    await expect(page.getByTestId("dataset-stats")).toContainText("3");
    await expect(page.getByTestId("dataset-screen")).toBeVisible();

    await page.getByTestId("publish-release").click();
    await page.getByTestId("release-tag").fill(TAG);
    await page.getByTestId("publish-submit").click();
    await expect(page.getByTestId(`release-${TAG}`)).toBeVisible();
  });

  await test.step("verify the release re-reads every blob", async () => {
    await page.getByTestId(`verify-${TAG}`).click();
    // Re-read and re-hashed, not `is_file()` — which is why this is a button and
    // not something the list does on render.
    await expect(page.getByTestId(`verified-${TAG}`)).toContainText("Intact");
  });

  await test.step("export through the dummy format and download the archive", async () => {
    await page.getByTestId(`export-${TAG}`).click();
    await page.getByTestId("export-format").click();
    await page.getByRole("option", { name: /dummy/ }).click();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("export-submit").click(),
    ]);
    await expectArchive(download);
  });
});

/** Back to the project screen, wherever the last step left the router. */
async function openProject(page: Page): Promise<void> {
  await page.getByTestId("rail-projects").click();
  await expect(page.getByTestId(`open-${PROJECT}`)).toBeVisible();
  await page.getByTestId(`open-${PROJECT}`).click();
  await expect(page.getByTestId("project-screen")).toBeVisible();
}

/** The job the approval cut, read through the browser's own credentialed session. */
async function jobIdOf(page: Page): Promise<string> {
  return await page.evaluate(async (projectName) => {
    const token = globalThis.sessionStorage.getItem("visionset.token") ?? "";
    const headers = { Authorization: `Bearer ${token}` };
    const projects = (await (await fetch("/projects", { headers })).json()) as {
      items: { id: string; name: string }[];
    };
    const project = projects.items.find((one) => one.name === projectName);
    const batches = (await (
      await fetch(`/projects/${project?.id}/batches`, { headers })
    ).json()) as { items: { id: string }[] };
    const jobs = (await (
      await fetch(`/batches/${batches.items[0]?.id}/jobs`, { headers })
    ).json()) as { items: { id: string }[] };
    return jobs.items[0]?.id ?? "";
  }, PROJECT);
}

/**
 * Pick a class and **wait until it is active**.
 *
 * Through the Labels tab rather than the digit, and the difference is not
 * cosmetic: a hotkey's effect reaches the machine through the host's own state, so
 * a press and a drag issued back to back can both be seen while the old class is
 * still current. The panel reflects the class with `data-active`, which turns that
 * into something to wait on — and it is also how a person picks a class.
 *
 * The cycle lost a run to exactly this before the wait existed.
 */
async function activate(page: Page, name: string): Promise<void> {
  await page.getByTestId("tab-labels").click();
  await page.getByTestId(`label-${name}`).click();
  await expect(page.getByTestId(`label-${name}`)).toHaveAttribute("data-active", "true");
}

async function drawBox(page: Page): Promise<void> {
  await activate(page, "vehicle");
  const box = (await page.getByTestId("annotator-canvas").boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("object-total")).toHaveText("1 object");
}

async function drawPolygon(page: Page): Promise<void> {
  await activate(page, "lane");
  const box = (await page.getByTestId("annotator-canvas").boundingBox())!;
  await page.getByTestId("annotator-root").focus();
  for (const [fx, fy] of [
    [0.3, 0.25],
    [0.2, 0.6],
    [0.6, 0.6],
  ] as const) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  }
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("object-total")).toHaveText("1 object");
}

/**
 * The archive arrived and is a zip.
 *
 * `dummy` writes nothing, so the *contents* are not the claim — `file_count: 0` is
 * an export that ran. What is asserted is that the browser received a download with
 * the right name and a zip's own four magic bytes, which is the part every real
 * exporter inherits.
 */
async function expectArchive(download: Download): Promise<void> {
  expect(download.suggestedFilename()).toBe(`${TAG}-dummy.zip`);
  const saved = await download.path();
  expect(saved).not.toBeNull();
  const head = readFileSync(saved as string).subarray(0, 2).toString("latin1");
  expect(head).toBe("PK");
}
