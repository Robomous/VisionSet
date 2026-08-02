/**
 * The shell: the rail, the gate, and the router's answer to a URL nobody defined.
 *
 * ## Why there is no server here either
 *
 * `page.route` fulfils `GET /projects` — the one request the token form makes —
 * so the whole sign-in path runs for real in a browser against a fixed answer.
 * The alternative, seeding `sessionStorage` and starting inside the gate, would
 * skip the only part of this flow that has ever been wrong.
 *
 * The screens themselves are #53–#57 and are placeholders today, which is why
 * nothing below asserts about their content. What is asserted is everything #58
 * actually owns: what the rail contains, that navigation is real links, that the
 * gate is where the router says it is, and that a deep link resolves.
 *
 * The **server** half of the deep link — a reload on `/ui/projects/abc` reaching
 * the index instead of a 404 — is `tests/server/test_static_ui.py`'s, because it
 * is a property of the wheel's server and this suite runs against vite.
 */

import { expect, test, type Page } from "@playwright/test";

/**
 * The token form's one request. Its body is irrelevant; its status is not.
 *
 * Matched under **`/api/`**, which is where the app sends everything in
 * development — vite proxies that prefix so no CORS layer is needed in production
 * (`docs/ui.md`). Routing `**' + '/projects*` instead would also intercept the
 * *document* request for `/projects`, because `page.route` sees navigations too:
 * the browser would receive JSON where it asked for the application, and the
 * failure reads as "the shell disappeared".
 */
async function serveApi(page: Page, { session = false } = {}): Promise<void> {
  // Every page load asks this first (#179). `false` is this suite's default,
  // because the gate and the sign-out button are what it is about and both are
  // only reachable when the server declines to sign the browser in by itself.
  await page.route("**/api/session", (route) => route.fulfill({ json: { issued: session } }));
  await page.route("**/api/projects**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/schema")) {
      return route.fulfill({
        status: 404,
        json: { code: "SCHEMA_NOT_FOUND", message: "This project has no schema version yet." },
      });
    }
    if (path.endsWith("/schema/versions")) {
      return route.fulfill({ status: 200, json: { items: [], total: 0 } });
    }
    if (/\/api\/projects\/[^/]+$/.test(path)) {
      return route.fulfill({
        status: 200,
        json: { id: PROJECT, name: "highway", description: null },
      });
    }
    // #211's header counts the project, and the catch-all below answers every
    // *collection* with an empty page — which is the wrong shape for this one.
    // A stub that answers a shape the endpoint never sends tests nothing, and
    // this one took the page down with it.
    if (path.endsWith("/stats")) {
      return route.fulfill({
        status: 200,
        json: {
          project_id: PROJECT,
          asset_count: 0,
          annotated_asset_count: 0,
          annotation_count: 0,
          class_count: 0,
          annotated_pct: 0,
          classes: [],
        },
      });
    }
    return route.fulfill({ status: 200, json: { items: [], total: 0 } });
  });
}

const PROJECT = "11111111-1111-4111-8111-111111111111";

async function signIn(page: Page): Promise<void> {
  await serveApi(page);
  await page.goto("/");
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("app-rail")).toBeVisible();
}

test("the browser the server signed in never sees the gate", async ({ page }) => {
  await serveApi(page, { session: true });
  await page.goto("/");

  // Nothing typed, nothing pasted: #179's whole point, in a browser.
  await expect(page.getByTestId("app-rail")).toBeVisible();
  await expect(page.getByTestId("token-input")).toHaveCount(0);

  // The control says what it can actually do. A cookie set by the server is one
  // no script here can delete, so this stops using it rather than forgetting it.
  // Read off the accessible name rather than the text: the rail starts collapsed
  // (#200) and a collapsed rail deliberately drops its labels, keeping them in
  // `aria-label` and `title` so no destination is lost. That is the string a
  // screen reader and a tooltip both get, which makes it the stronger assertion.
  const control = page.getByTestId("rail-sign-out");
  await expect(control).toHaveAttribute("aria-label", "Use a token");
  await control.click();
  await expect(page.getByTestId("token-input")).toBeVisible();

  // And a reload asks again, which on your own machine is the way back in.
  await page.reload();
  await expect(page.getByTestId("app-rail")).toBeVisible();
});

test("the product is behind the token gate and the showcase is not", async ({ page }) => {
  await serveApi(page);
  await page.goto("/");
  await expect(page.getByTestId("token-input")).toBeVisible();
  await expect(page.getByTestId("app-rail")).toHaveCount(0);

  // Two routes deliberately outside it: neither has a server to authenticate
  // against, and asking for a credential to look at them would be theatre.
  await page.goto("/demo");
  await expect(page.getByTestId("annotator-canvas")).toBeVisible();
  await expect(page.getByTestId("token-input")).toHaveCount(0);

  await page.goto("/styleguide");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("VisionSet design system");
  await expect(page.getByTestId("token-input")).toHaveCount(0);
});

test("a token opens the shell, and signing out closes it again", async ({ page }) => {
  await signIn(page);

  await page.getByTestId("rail-sign-out").click();
  await expect(page.getByTestId("token-input")).toBeVisible();
  await expect(page.getByTestId("app-rail")).toHaveCount(0);

  // Forgotten, not merely hidden: a reload does not walk back in.
  await page.reload();
  await expect(page.getByTestId("token-input")).toBeVisible();
});

test("the token survives a reload, because losing it mid-job is the worst moment", async ({
  page,
}) => {
  await signIn(page);
  await page.reload();
  await expect(page.getByTestId("app-rail")).toBeVisible();
});

/** `DESIGN.md`: logo, collapse toggle, Home, Projects, the account control. No more. */
test("the rail carries exactly what the design gives it", async ({ page }) => {
  await signIn(page);

  const rail = page.getByTestId("app-rail");
  await expect(rail.getByRole("link")).toHaveCount(2);
  await expect(page.getByTestId("rail-home")).toBeVisible();
  await expect(page.getByTestId("rail-projects")).toBeVisible();
  await expect(page.getByTestId("rail-collapse")).toBeVisible();
  await expect(page.getByTestId("rail-sign-out")).toBeVisible();
});

test("navigation is real links, and the active one is the one you are on", async ({ page }) => {
  await signIn(page);

  // Signing in at `/` lands on `/projects`, because Home redirects there — so
  // **Projects** is the current page and Home is not. Asserting Home first would
  // be racing the redirect, which is exactly what it did until this comment
  // existed: the scenario passed alone and failed under parallel load.
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByTestId("rail-projects")).toHaveAttribute("aria-current", "page");

  // `end` on the Home link is what keeps this true: without it `NavLink` treats
  // `/` as a prefix of every route and Home is active on every page.
  await expect(page.getByTestId("rail-home")).not.toHaveAttribute("aria-current", "page");

  // A real `<a href>`, so middle-click and "open in new tab" work — which on a
  // tool people keep two workspaces open in is not a detail.
  await expect(page.getByTestId("rail-projects")).toHaveAttribute("href", "/projects");
  await expect(page.getByTestId("rail-home")).toHaveAttribute("href", "/");
});

test("collapsing the rail narrows it and keeps every control reachable", async ({ page }) => {
  await signIn(page);
  const rail = page.getByTestId("app-rail");

  // Expanded first, because collapsed is now where a fresh session starts (#200)
  // — so this scenario has to open the rail before it can claim that closing it
  // narrows anything. The claim itself is unchanged.
  await page.getByTestId("rail-collapse").click();
  await expect(rail).toHaveAttribute("data-collapsed", "false");
  const wide = (await rail.boundingBox())?.width ?? 0;

  await page.getByTestId("rail-collapse").click();
  await expect(rail).toHaveAttribute("data-collapsed", "true");

  const narrow = (await rail.boundingBox())?.width ?? 0;
  expect(narrow).toBeLessThan(wide);
  // The labels go; the controls do not. A collapsed rail that loses a
  // destination is a rail somebody has to expand to use.
  await expect(page.getByTestId("rail-projects")).toBeVisible();
  await expect(page.getByTestId("rail-sign-out")).toBeVisible();
});

test("a deep link inside the product resolves to its screen", async ({ page }) => {
  await serveApi(page);
  await page.goto(`/projects/${PROJECT}`);
  // The gate first, because the credential is per tab and this is a fresh one.
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();

  await expect(page.getByTestId("app-rail")).toBeVisible();
  // #53's project screen — the claim is that the router put us on it rather than
  // on the list or on a 404.
  await expect(page.getByTestId("project-screen")).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/11111111/);
});

/**
 * #171: the project view's section is in the URL, and this is the only place that
 * wiring exists.
 *
 * `ui-core` is deliberately router-free — it takes the tab as a prop and hands one
 * back — so a component test can prove the tabs switch and prove the callback
 * fires, and it cannot prove the two halves are connected. A reload is the whole
 * point of putting the section in the URL, and a reload is a browser fact.
 */
test("the project view's tab is in the URL, and survives a reload", async ({ page }) => {
  await serveApi(page);
  await page.goto(`/projects/${PROJECT}?tab=versions`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();

  // The link opened on the section it named, not on the default.
  await expect(page.getByTestId("version-history")).toBeVisible();
  await expect(page.getByTestId("schema-editor")).toHaveCount(0);

  await page.getByTestId("tab-batches").click();
  await expect(page).toHaveURL(/\?tab=batches$/);
  await expect(page.getByTestId("batches-screen")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("batches-screen")).toBeVisible();
  await expect(page.getByTestId("version-history")).toHaveCount(0);
});

test("a client route nobody defined answers inside the shell, not with a blank page", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/no-such-screen");

  await expect(page.getByText("No such page")).toBeVisible();
  // Inside the shell: the rail is still there, so it is a wrong page rather than
  // a broken application.
  await expect(page.getByTestId("app-rail")).toBeVisible();
  await page.getByRole("link", { name: "Back to Home" }).click();
  // Home redirects to the project list: there is nothing else a workspace's front
  // page could honestly be until a dashboard has numbers to show.
  await expect(page).toHaveURL(/\/projects$/);
});

/**
 * The rail starts collapsed (#200).
 *
 * The unit tests hold the logic — absent key, unparseable value, refused storage
 * all resolve to the default — and cannot see whether anything calls it. These
 * two are the browser half: what a fresh session actually renders, and that a
 * choice survives a reload, which is a browser fact and nothing else.
 *
 * `localStorage` is cleared explicitly rather than trusted to be empty: Playwright
 * gives each test a fresh context, but a scenario that depended on that silently
 * would stop meaning anything the day somebody reused one.
 */
test("a fresh session opens with the rail collapsed", async ({ page }) => {
  await serveApi(page);
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();

  const rail = page.getByTestId("app-rail");
  await expect(rail).toHaveAttribute("data-collapsed", "true");
  // Narrow, not merely labelled narrow: 60px is the collapsed token and 240 the
  // expanded one, so anything under half of 240 can only be the former.
  expect((await rail.boundingBox())?.width ?? 0).toBeLessThan(120);
});

test("a stored preference beats the default, and survives a reload", async ({ page }) => {
  await signIn(page);
  const rail = page.getByTestId("app-rail");
  await expect(rail).toHaveAttribute("data-collapsed", "true");

  await page.getByTestId("rail-collapse").click();
  await expect(rail).toHaveAttribute("data-collapsed", "false");

  // The whole reason the preference is in `localStorage` rather than in state: a
  // default that resets on every page load is not a default, it is a reset.
  await page.reload();
  await expect(page.getByTestId("app-rail")).toHaveAttribute("data-collapsed", "false");

  // And back — the stored value follows the choice in both directions rather than
  // only recording that somebody once expanded it.
  await page.getByTestId("rail-collapse").click();
  await page.reload();
  await expect(page.getByTestId("app-rail")).toHaveAttribute("data-collapsed", "true");
});
