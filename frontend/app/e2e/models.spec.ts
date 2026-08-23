/**
 * The Models page in a real browser: a grid of connection cards filtered by
 * ability, and a weight download somebody watches on one of them.
 *
 * The cards and chips are asserted here as well as in `models.test.tsx` because
 * the two claims differ: jsdom proves the filtering is total over what the wire
 * can say, and this proves a real workspace opens on it — and that a run in
 * flight is still found, after a reload, on the card its connection is.
 *
 * ## Why this is not `models.test.tsx`
 *
 * The claim is **recovery**, and recovery is a claim about a page that did not
 * start the thing it is showing. jsdom can assert that a component renders a prop;
 * only a browser can throw the whole application away — the React tree, the query
 * cache, every closure that might have been holding a job id — and prove that what
 * comes back still knows a transfer is running. `page.reload()` is the assertion,
 * and there is no jsdom equivalent of it.
 *
 * It is also where the *poll* is real: the bar below moves because a timer fired
 * and an answer changed, with nothing clicked after the screen opened.
 *
 * What is **not** here is the counting half — *and it stops asking once nothing is
 * moving*. That is a claim that nothing happens over an interval, and the only way
 * to make it in a browser is to wait on a clock, which `tests/scripts/e2e_discipline`
 * forbids for the reason it gives. It is asserted in `models.test.tsx`, which
 * can count requests without a browser scheduler deciding the outcome.
 *
 * ## The wire is stubbed and the screen is not
 *
 * `page.route` answers `/api/inference/connections` from a mutable fixture, so the
 * bodies are what the server would send — `_wire.ts`'s rule, and the generated
 * runtime checks enforce it: a row missing a required field is rejected before the
 * screen renders, which is exactly what that gate is for.
 */

import { expect, test, type Page } from "@playwright/test";

import type { Wire } from "./_wire";

const CONNECTION = "22222222-2222-4222-8222-222222222222";
const JOB = "44444444-4444-4444-8444-444444444444";
const CHECK_JOB = "55555555-5555-4555-8555-555555555555";

const GIGABYTE = 1_000_000_000;

/**
 * What `GET /inference/providers` answers once the two shipped drivers are
 * installed — the curated ladder each declares, mirrored field for field so a
 * missing one fails the generated shape check rather than the assertion below it.
 */
const PROVIDERS = {
  items: [
    {
      provider_id: "grounding-dino",
      families: { "grounding-dino": "text_detect", "mm-grounding-dino": "text_detect" },
      curated: [
        {
          provider_id: "grounding-dino",
          model_id: "IDEA-Research/grounding-dino-tiny",
          model_revision: "a2bb814dd30d776dcf7e30523b00659f4f141c71",
          family: "grounding-dino",
          capability: "text_detect",
          hint: "tiny — fastest, comfortable on a CPU",
          access_note: null,
          access_url: null,
        },
        {
          provider_id: "grounding-dino",
          model_id: "IDEA-Research/grounding-dino-base",
          model_revision: "12bdfa3120f3e7ec7b434d90674b3396eccf88eb",
          family: "grounding-dino",
          capability: "text_detect",
          hint: "base — more accurate, wants a GPU",
          access_note: null,
          access_url: null,
        },
      ],
    },
    {
      provider_id: "sam",
      families: {
        sam2: "point_suggest",
        sam2_video: "point_suggest",
        sam3_video: "point_suggest",
      },
      curated: [
        {
          provider_id: "sam",
          model_id: "facebook/sam2.1-hiera-tiny",
          model_revision: "de431c4043854a71d8101e17995dfe596bf101a5",
          family: "sam2_video",
          capability: "point_suggest",
          hint: "tiny — fastest, comfortable on a CPU",
          access_note: null,
          access_url: null,
        },
        {
          provider_id: "sam",
          model_id: "facebook/sam2.1-hiera-small",
          model_revision: "ee5bba1d82bb8749febdf90f45e84b687142ba03",
          family: "sam2_video",
          capability: "point_suggest",
          hint: "small — a little more accurate, still light",
          access_note: null,
          access_url: null,
        },
        {
          provider_id: "sam",
          model_id: "facebook/sam2.1-hiera-base-plus",
          model_revision: "b7320756a13354e7530a63935656d35b2f91a290",
          family: "sam2_video",
          capability: "point_suggest",
          hint: "base-plus — the balanced default",
          access_note: null,
          access_url: null,
        },
        {
          provider_id: "sam",
          model_id: "facebook/sam2.1-hiera-large",
          model_revision: "665f8e2ad61cf5f53d65644ff27c8ee525124610",
          family: "sam2_video",
          capability: "point_suggest",
          hint: "large — the most accurate, wants a GPU",
          access_note: null,
          access_url: null,
        },
        {
          provider_id: "sam",
          model_id: "facebook/sam3",
          model_revision: "3c879f39826c281e95690f02c7821c4de09afae7",
          family: "sam3_video",
          capability: "point_suggest",
          hint: "wants a GPU",
          access_note:
            "Meta publishes these weights under the SAM License and grants access by " +
            "request. Ask for it, then set HF_TOKEN before downloading.",
          access_url: "https://huggingface.co/facebook/sam3",
        },
      ],
    },
    {
      // The third installed driver — the no-op stand-in `cycle.spec.ts` uses
      // against a real server. It curates nothing by name, but it is still a
      // row the real route reports, and a fixture that drops it is answering
      // a question the server was never asked.
      provider_id: "stub",
      families: { visionset_stub: "point_suggest" },
      curated: [],
    },
  ],
  total: 3,
} satisfies Wire["ProviderPage"];

// Derived from the generated run shapes rather than transcribed, because a
// transcription is the defect this file is being typed against, one level down:
// the pair below spelt `state` as `string` and would have gone on accepting a
// job state the server can never send. `job_id` and `error` are supplied by
// `connection` for every caller, so a scenario names neither.
type Download = Omit<Wire["WeightDownloadOut"], "job_id" | "error" | "error_code"> & {
  readonly error?: string | null;
  readonly error_code?: string | null;
};

type Check = Omit<Wire["IntegrityCheckOut"], "job_id" | "error" | "error_code"> & {
  readonly error?: string | null;
  readonly error_code?: string | null;
};

/**
 * What the server answers for one local connection, in the state a test wants.
 *
 * `capabilities` defaults the way the server derives it: nothing until the
 * weights are here, because the ability is read out of the model's own config.
 * That is also why a download in flight is watched on a card with no badge
 * below — the connection cannot say what it answers until the transfer lands.
 */
function connection(
  setup: "not_set_up" | "ready",
  download: Download | null,
  check: Check | null = null,
  capabilities: Wire["ConnectionOut"]["capabilities"] = setup === "ready" ? ["point_suggest"] : [],
): Wire["ConnectionOut"] {
  return {
    id: CONNECTION,
    name: "sam2-local",
    connection_type: "local",
    model_id: "facebook/sam2.1-hiera-base-plus",
    model_revision: "b73207",
    device: "cuda",
    precision: "fp16",
    endpoint_url: null,
    provider_id: "sam",
    credential_env: null,
    setup_state: setup,
    allowed_actions: ["download_weights", "update", "delete"],
    capabilities,
    produces: capabilities.length === 0 ? [] : ["bbox", "polygon"],
    download:
      download === null ? null : { job_id: JOB, error: null, error_code: null, ...download },
    integrity_check:
      check === null ? null : { job_id: CHECK_JOB, error: null, error_code: null, ...check },
    created_at: "2026-08-08T00:00:00Z",
    updated_at: "2026-08-08T00:00:00Z",
  };
}

/**
 * A workspace whose one connection is whatever `next` last returned.
 *
 * Mutable rather than frozen, and derived rather than replayed, for the reason
 * `refactor-protocol` states about doubles: a stub that answers from a script
 * makes a test assert against its own fixture, and a stub whose answer depends on
 * registration order makes it assert against the order too. `next` is asked on
 * every request, so what a test changes is the *workspace*, and the screen reads
 * it the way it reads a server.
 */
async function serveApi(page: Page, next: () => Wire["ConnectionOut"]): Promise<void> {
  // These scenarios reach Models by signing in at `/`, which is a real page
  // now rather than a redirect to the project list — so it makes this request on
  // the way past. Empty totals: nothing here is about the dashboard, and an
  // unrouted request would leave the page waiting on a network that is not there.
  await page.route("**/api/home", (route) =>
    route.fulfill({
      status: 200,
      json: {
        totals: { projects: 0, assets: 0, annotations: 0, releases: 0 },
        resume: null,
        attention: [],
        projects: [],
        activity: [],
      } satisfies Wire["HomeOut"],
    }),
  );
  await page.route("**/api/session", (route) => route.fulfill({ json: { issued: false } }));
  await page.route("**/api/inference/connections*", (route) =>
    route.fulfill({ status: 200, json: { items: [next()], total: 1 } satisfies Wire["ConnectionPage"] }),
  );
  // The create form's own read. It has to hold the whole offered set, because
  // one scenario below asserts the list is taller than the window.
  await page.route("**/api/inference/providers*", (route) =>
    route.fulfill({ status: 200, json: PROVIDERS }),
  );
  // What a card below Ready asks on its own, and the form asks before a confirm.
  // Answered here so no scenario's request escapes to whatever answers on the
  // proxy's port — a real server there replies 401 to this suite's token, and
  // the app signs out on any 401, which reads as the shell vanishing mid-test.
  await page.route("**/api/inference/download-size*", (route) =>
    route.fulfill({
      status: 200,
      json: {
        model_id: "facebook/sam2.1-hiera-base-plus",
        model_revision: "b73207",
        total_bytes: 1.6 * GIGABYTE,
        file_count: 3,
      } satisfies Wire["DownloadSizeOut"],
    }),
  );
  await page.route("**/api/projects**", (route) =>
    route.fulfill({ status: 200, json: { items: [], total: 0 } satisfies Wire["ProjectPage"] }),
  );
}

async function openModels(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await page.getByTestId("rail-models").click();
  await expect(page.getByTestId("models-screen")).toBeVisible();
}

test("the page is a grid of cards, and a chip narrows it to the ability a card declares", async ({
  page,
}) => {
  await serveApi(page, () => connection("ready", null));
  await openModels(page);

  // One card, saying what the connection is *for* — which the flat table of
  // names, kinds and model ids never did — and what it writes, where it runs.
  const grid = page.getByTestId("models-grid");
  await expect(grid.getByTestId("connection-sam2-local")).toHaveCount(1);
  const card = grid.getByTestId("connection-sam2-local");
  await expect(card.getByTestId("capability-badge")).toHaveText(["Suggests from clicks"]);
  await expect(card.getByTestId("produces-chip")).toHaveText(["boxes", "polygons"]);
  await expect(card.getByTestId("connection-source")).toHaveText("Local · cuda · fp16");

  // The chip for the ability it declares keeps it; the other's chip shows the
  // invitation instead. text_detect has a consumer now — pre-labeling a batch —
  // so an ability nothing serves invites a first connection rather than
  // reporting a surface that does not exist.
  await page.getByTestId("capability-chip-point_suggest").click();
  await expect(grid.getByTestId("connection-sam2-local")).toBeVisible();
  await page.getByTestId("capability-chip-text_detect").click();
  await expect(page.getByTestId("models-grid")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add a text-prompt connection" })).toBeVisible();
});

test("a workspace with no connection invites the first one", async ({ page }) => {
  await serveApi(page, () => connection("ready", null));
  // Registered after `serveApi`, because the newest matching route answers first.
  await page.route("**/api/inference/connections*", (route) =>
    route.fulfill({ status: 200, json: { items: [], total: 0 } satisfies Wire["ConnectionPage"] }),
  );
  await openModels(page);
  await expect(page.getByText("Connect a model to enable auto-labeling")).toBeVisible();
  await expect(page.getByTestId("models-grid")).toHaveCount(0);
  await expect(page.getByTestId("capability-chips")).toHaveCount(0);
});

test("a transfer left running is where it got to when you come back", async ({ page }) => {
  // Navigating away is the ordinary way somebody loses sight of a download, and
  // the poll that was watching it goes with the screen. What comes back is read
  // from the wire, so it shows the *current* number rather than the last one this
  // browser happened to see.
  let done = 0.4 * GIGABYTE;
  await serveApi(page, () =>
    connection("not_set_up", { state: "running", bytes_done: done, bytes_total: 1.6 * GIGABYTE }),
  );
  await openModels(page);
  await expect(page.getByTestId("download-progress-prose")).toContainText("25%");

  await page.getByTestId("rail-projects").click();
  await expect(page.getByTestId("models-screen")).toHaveCount(0);
  // The worker keeps going, because nothing about it was ever this browser's.
  done = 1.2 * GIGABYTE;

  await page.getByTestId("rail-models").click();
  await expect(page.getByTestId("download-progress-prose")).toHaveText("1.2 GB of 1.6 GB · 75%");
});

test("the bar moves on the poll alone, and stops being a bar when it lands", async ({ page }) => {
  // Nothing is clicked after the screen opens. Every number below arrives because
  // a timer fired, a request went out, and the answer changed — which is the one
  // part of this feature that only a browser can be asked about.
  let done = 0.8 * GIGABYTE;
  let settled = false;
  await serveApi(page, () =>
    settled
      ? connection("ready", {
          state: "succeeded",
          bytes_done: 1.6 * GIGABYTE,
          bytes_total: 1.6 * GIGABYTE,
        })
      : connection("not_set_up", {
          state: "running",
          bytes_done: done,
          bytes_total: 1.6 * GIGABYTE,
        }),
  );
  await openModels(page);
  await expect(page.getByTestId("download-progress-prose")).toContainText("50%");

  done = 1.4 * GIGABYTE;
  await expect(page.getByTestId("download-progress-prose")).toContainText("88%");

  settled = true;
  await expect(page.getByTestId("connection-status")).toContainText("Ready");
  // The success treatment is the row's own status; the bar goes with the transfer.
  await expect(page.getByTestId("download-progress")).toHaveCount(0);
});

test("a check nobody on this page started survives a reload", async ({ page }) => {
  // The download's proof, one action over. The check kept its job id in a
  // component until now, so only the mount that pressed the menu item could see a
  // run reading gigabytes — and a check somebody started from a terminal was
  // invisible to every browser.
  await serveApi(page, () =>
    connection("ready", null, { state: "running", files_read: 4, files_total: 9 }),
  );
  await openModels(page);

  await expect(page.getByTestId("integrity-progress-prose")).toHaveText("4 of 9 files · 44%");
  await expect(page.getByTestId("integrity-progress-bar")).toHaveAttribute("aria-valuenow", "44");

  // Throw the application away. Nothing survives this that a client is holding.
  await page.reload();
  await expect(page.getByTestId("models-screen")).toBeVisible();

  await expect(page.getByTestId("integrity-progress-prose")).toHaveText("4 of 9 files · 44%");
  await expect(page.getByTestId("integrity-progress-bar")).toHaveAttribute("aria-valuenow", "44");
  // A check in flight is not a setup state: the connection is still ready.
  await expect(page.getByTestId("connection-status")).toContainText("Ready");
});

test("a transfer and a re-read are two records on one row", async ({ page }) => {
  await serveApi(page, () =>
    connection(
      "ready",
      { state: "succeeded", bytes_done: 1.6 * GIGABYTE, bytes_total: 1.6 * GIGABYTE },
      { state: "running", files_read: 3, files_total: 9 },
    ),
  );
  await openModels(page);

  // Files here, and no byte count borrowed from the settled transfer beside it.
  await expect(page.getByTestId("integrity-progress-prose")).toHaveText("3 of 9 files · 33%");
  await expect(page.getByTestId("download-progress")).toHaveCount(0);
});

test("an http connection is asked what it answers, and moves under it", async ({ page }) => {
  let hosted: Wire["ConnectionOut"] = {
    ...connection("ready", null, null, []),
    id: "hosted-1",
    name: "remote-seg",
    connection_type: "http",
    device: null,
    precision: null,
    endpoint_url: "https://models.example/predict",
    provider_id: null,
    credential_env: null,
    allowed_actions: ["test_endpoint", "update", "delete"],
  };
  await serveApi(page, () => hosted);
  await page.route("**/api/inference/connections/hosted-1/test-endpoint", (route) => {
    hosted = { ...hosted, capabilities: ["point_suggest"], provider_id: "http" };
    return route.fulfill({ status: 200, json: hosted });
  });
  await openModels(page);
  const card = page.getByTestId("connection-remote-seg");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("connection-source")).toHaveText("HTTP · models.example");
  await expect(card.getByTestId("capability-badge")).toHaveCount(0);
  await page.getByTestId("actions-remote-seg").click();
  await page.getByTestId("action-test-endpoint").click();
  await expect(card.getByTestId("capability-badge")).toHaveText(["Suggests from clicks"]);
  // And the chip for what it now declares shows it.
  await page.getByTestId("capability-chip-point_suggest").click();
  await expect(page.getByTestId("connection-remote-seg")).toBeVisible();
});

test("a model list taller than the window scrolls instead of running off it", async ({ page }) => {
  // Layout under a real viewport, so it cannot live in `models.test.tsx`:
  // jsdom reports every height as zero and would pass against the implementation
  // this replaced, which clipped the list and left the options past the bottom
  // edge in the DOM, keyboard-reachable and unreachable with a pointer.
  await serveApi(page, () => connection("ready", null));
  await page.route("**/api/inference/download-size*", (route) =>
    route.fulfill({
      status: 200,
      json: {
        model_id: "m",
        model_revision: "r",
        total_bytes: 1_200_000_000,
        file_count: 3,
      } satisfies Wire["DownloadSizeOut"],
    }),
  );
  // Short enough that the curated list cannot fit under its trigger whatever the
  // catalog holds — the condition being tested, rather than a window size that
  // happens to provoke it today.
  await page.setViewportSize({ width: 1280, height: 600 });
  await openModels(page);
  await page.getByTestId("new-connection").click();
  await page.getByTestId("choose-local").click();
  // The trigger only exists once the catalog request has answered — wait for
  // it rather than racing the click against the still-open request.
  await expect(page.getByTestId("connection-model")).toBeVisible();
  await page.getByTestId("connection-model").click();

  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  const box = (await listbox.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(600 + 1);

  // The last entry is the one a clipped list loses, and it is reachable: Radix
  // scrolls it into view, and clicking it selects it rather than hitting a
  // control drawn past the bottom of the window.
  const last = page.getByRole("option", { name: /Custom model/ });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeVisible();
  await last.click();
  await expect(page.getByTestId("connection-custom-model")).toBeVisible();
});

test("a model the installation offers is chosen and becomes a connection", async ({ page }) => {
  // The whole slice in one journey, and it cannot live in `models.test.tsx`:
  // the claim is that the pair sent to the server is the pair the server itself
  // served. `IDEA-Research/grounding-dino-tiny` and its revision are also what
  // the deleted frontend constant used to hold, so asserting those wouldn't tell
  // a copy from a read — a build that still carried the old copy would pass
  // identically. This catalog's id and revision exist nowhere in this build:
  // `acme/vision-widget` is offered by nothing shipped, so the only way the form
  // can send it back is by having read it off the wire just now.
  await serveApi(page, () => connection("not_set_up", null));
  const ACME_REVISION = "beefbeefbeefbeefbeefbeefbeefbeefbeefbeef";
  await page.route("**/api/inference/providers*", (route) =>
    route.fulfill({
      status: 200,
      json: {
        items: [
          {
            provider_id: "acme",
            families: { acme_widget: "point_suggest" },
            curated: [
              {
                provider_id: "acme",
                model_id: "acme/vision-widget",
                model_revision: ACME_REVISION,
                family: "acme_widget",
                capability: "point_suggest",
                hint: "a model no shipped driver curates",
                access_note: null,
                access_url: null,
              },
            ],
          },
        ],
        total: 1,
      } satisfies Wire["ProviderPage"],
    }),
  );
  const created: unknown[] = [];
  await page.route("**/api/inference/connections", async (route, request) => {
    if (request.method() !== "POST") return route.fallback();
    created.push(JSON.parse(request.postData() ?? "{}"));
    return route.fulfill({ status: 201, json: connection("not_set_up", null) });
  });
  await page.route("**/api/inference/download-size*", (route) =>
    route.fulfill({
      status: 200,
      json: {
        model_id: "m",
        model_revision: "r",
        total_bytes: 1_200_000_000,
        file_count: 3,
      } satisfies Wire["DownloadSizeOut"],
    }),
  );
  await openModels(page);

  await page.getByTestId("new-connection").click();
  await page.getByTestId("choose-local").click();
  await expect(page.getByTestId("connection-model")).toBeVisible();
  await page.getByTestId("connection-model").click();
  await page.getByRole("option", { name: /vision-widget/ }).click();
  await page.getByTestId("connection-name").fill("widget");
  await page.getByTestId("connection-submit").click();

  await expect.poll(() => created.length).toBe(1);
  expect(created[0]).toMatchObject({
    model_id: "acme/vision-widget",
    model_revision: ACME_REVISION,
    // The third value read off the wire, and the one nothing in this build could
    // have supplied: `acme` is offered by no shipped driver, so the form can only
    // be sending it back because the catalog said so a moment ago.
    provider_id: "acme",
  });
});
