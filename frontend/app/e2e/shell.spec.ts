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
 * The screens themselves are `ui-core`'s, which is why
 * nothing below asserts about their content. What is asserted is everything the shell
 * actually owns: what the rail contains, that navigation is real links, that the
 * gate is where the router says it is, and that a deep link resolves.
 *
 * The **server** half of the deep link — a reload on `/app/projects/abc` reaching
 * the index instead of a 404 — is `tests/server/test_static_ui.py`'s, because it
 * is a property of the wheel's server and this suite runs against vite.
 */

import { expect, test, type Page } from "@playwright/test";

import type { Wire } from "./_wire";

/**
 * The token form's one request. Its body is irrelevant; its status is not.
 *
 * Matched under **`/api/`**, which is where the app sends everything in
 * development — vite proxies that prefix so no CORS layer is needed in production
 * (`docs/content/ui.md`). Routing `**' + '/projects*` instead would also intercept the
 * *document* request for `/projects`, because `page.route` sees navigations too:
 * the browser would receive JSON where it asked for the application, and the
 * failure reads as "the shell disappeared".
 */
async function serveApi(page: Page, { session = false } = {}): Promise<void> {
  // Every page load asks this first. `false` is this suite's default,
  // because the gate and the sign-out button are what it is about and both are
  // only reachable when the server declines to sign the browser in by itself.
  await page.route("**/api/session", (route) => route.fulfill({ json: { issued: session } }));
  // The Models page's one read. Empty, because this suite is about the
  // rail and the router: what the screen does with rows is `ui-core`'s
  // `models.test.tsx`, and an unrouted request here would leave the page
  // waiting on a network that is not there.
  await page.route("**/api/inference/**", (route) =>
    route.fulfill({ status: 200, json: { items: [], total: 0 } satisfies Wire["ConnectionPage"] }),
  );
  await page.route("**/api/projects**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/schema")) {
      return route.fulfill({
        status: 404,
        json: { code: "SCHEMA_NOT_FOUND", message: "This project has no schema version yet." },
      });
    }
    if (path.endsWith("/schema/versions")) {
      return route.fulfill({
        status: 200,
        json: { items: [], total: 0 } satisfies Wire["SchemaVersionPage"],
      });
    }
    if (/\/api\/projects\/[^/]+$/.test(path)) {
      return route.fulfill({
        status: 200,
        json: { id: PROJECT, name: "highway", description: null, thumbnail_asset_id: null, thumbnail_hash: null, created_at: null } satisfies Wire["ProjectOut"],
      });
    }
    // The project header counts the project, and the catch-all below answers every
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
          // Null is what the endpoint sends for a project whose assets
          // predate v0.1.0, and for one holding none. Present, not omitted:
          // a stub answering a shape the endpoint never sends tests nothing.
          last_ingest_at: null,
        } satisfies Wire["ProjectStatsOut"],
      });
    }
    return route.fulfill({ status: 200, json: { items: [], total: 0 } satisfies Wire["ProjectPage"] });
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

  // Nothing typed, nothing pasted: the browser session's whole point.
  await expect(page.getByTestId("app-rail")).toBeVisible();
  await expect(page.getByTestId("token-input")).toHaveCount(0);

  // The control says what it can actually do. A cookie set by the server is one
  // no script here can delete, so this stops using it rather than forgetting it.
  // Read off the accessible name rather than the text: the rail starts collapsed
  // and a collapsed rail deliberately drops its labels, keeping them in
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

/** The rail: the mark (the collapse toggle's row), Projects, Models, the theme and account controls. No more. */
test("the rail carries exactly what the design gives it", async ({ page }) => {
  await signIn(page);

  const rail = page.getByTestId("app-rail");
  // Two: Projects and Models. `Models` is a top-level destination, because
  // model connections are workspace infrastructure; Home was removed. The count
  // is the assertion — a destination arriving without that decision fails here.
  await expect(rail.getByRole("link")).toHaveCount(2);
  await expect(page.getByTestId("rail-projects")).toBeVisible();
  await expect(page.getByTestId("rail-models")).toBeVisible();
  await expect(page.getByTestId("rail-mark")).toHaveAccessibleName("Robomous VisionSet");
  await expect(page.getByTestId("rail-collapse")).toBeVisible();
  await expect(page.getByTestId("rail-theme")).toBeVisible();
  await expect(page.getByTestId("rail-sign-out")).toBeVisible();
});

test("the Models entry goes to the page, and is current once you are on it", async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByTestId("rail-models")).toHaveAttribute("href", "/models");
  await expect(page.getByTestId("rail-models")).toHaveAccessibleName("Models");

  await page.getByTestId("rail-models").click();
  await expect(page).toHaveURL(/\/models$/);
  await expect(page.getByTestId("models-screen")).toBeVisible();
  await expect(page.getByTestId("rail-models")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("rail-projects")).not.toHaveAttribute("aria-current", "page");
  // A rail destination has no way out of its own: the rail is it, and a second
  // answer to "where am I" inside the pane would contradict it.
  await expect(page.getByTestId("back-link")).toHaveCount(0);
});

test("the page's old address still lands on it", async ({ page }) => {
  // `/inference` was the route before the page was named for what it lists. A
  // bookmark and the editor's older hand-offs are promises, so it redirects
  // rather than answering with the 404 the catch-all gives a route nobody defined.
  await signIn(page);
  await page.goto("/inference");
  await expect(page).toHaveURL(/\/models$/);
  await expect(page.getByTestId("models-screen")).toBeVisible();
  await expect(page.getByTestId("rail-models")).toHaveAttribute("aria-current", "page");
});

test("navigation is real links, and the active one is the one you are on", async ({ page }) => {
  await signIn(page);

  // `/` is the project list's front door: there is no Home page, so signing in
  // at `/` lands on Projects, and Projects is what the rail lights.
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByTestId("rail-projects")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("rail-models")).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("rail-home")).toHaveCount(0);

  await page.getByTestId("rail-models").click();
  await expect(page).toHaveURL(/\/models$/);
  await expect(page.getByTestId("rail-models")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("rail-projects")).not.toHaveAttribute("aria-current", "page");

  // A real `<a href>`, so middle-click and "open in new tab" work — which on a
  // tool people keep two workspaces open in is not a detail.
  await expect(page.getByTestId("rail-projects")).toHaveAttribute("href", "/projects");
  await expect(page.getByTestId("rail-models")).toHaveAttribute("href", "/models");
});

test("collapsed by default the rail is one icon wide, and every control keeps its name", async ({ page }) => {
  await signIn(page);
  const rail = page.getByTestId("app-rail");
  await expect(rail).toHaveAttribute("data-collapsed", "true");
  // `w-rail`: the width every pane is laid out beside by default.
  expect((await rail.boundingBox())?.width).toBe(48);
  // Icons only, so the name is the accessible name — what a screen reader and
  // the tooltip both say.
  await expect(page.getByTestId("rail-projects")).toHaveAccessibleName("Projects");
  await expect(page.getByTestId("rail-models")).toHaveAccessibleName("Models");
  await expect(page.getByTestId("rail-collapse")).toHaveAccessibleName("Expand sidebar");
  await expect(page.getByTestId("rail-collapse")).toHaveAttribute("aria-expanded", "false");
});

test("collapsing the rail narrows it and keeps every control reachable", async ({ page }) => {
  await signIn(page);
  const rail = page.getByTestId("app-rail");

  // Expanded first, because collapsed is where a fresh session starts
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

test("expanding shows the labels without moving a single icon, and ⌘B / Ctrl+B toggles it", async ({ page }) => {
  await signIn(page);
  const rail = page.getByTestId("app-rail");
  const iconX = async (): Promise<number> => {
    const box = (await page.getByTestId("rail-projects").locator("svg").boundingBox())!;
    return box.x + box.width / 2;
  };
  const collapsedX = await iconX();
  // Collapsed, the mark is the toggle: one column has room for one control.
  await expect(page.getByTestId("rail-collapse").getByTestId("rail-mark")).toBeVisible();

  await page.getByTestId("rail-collapse").click();
  // Expanded, the toggle leaves the mark and sits at the right end of its row.
  const mark = (await page.getByTestId("rail-mark").boundingBox())!;
  const toggle = (await page.getByTestId("rail-collapse").boundingBox())!;
  expect(toggle.x).toBeGreaterThan(mark.x + mark.width);
  expect(toggle.y + toggle.height / 2).toBeCloseTo(mark.y + mark.height / 2, 0);
  await expect(rail).toHaveAttribute("data-collapsed", "false");
  expect((await rail.boundingBox())?.width).toBe(208);
  await expect(page.getByTestId("rail-projects")).toContainText("Projects");
  await expect(page.getByTestId("rail-collapse")).toHaveAttribute("aria-expanded", "true");
  // The claim the layout is built on: expanding adds labels beside icons that stay put.
  expect(await iconX()).toBe(collapsedX);

  // The keyboard chord, both ways. `ControlOrMeta` is Playwright's spelling of
  // whichever modifier this platform uses.
  await page.keyboard.press("ControlOrMeta+b");
  await expect(rail).toHaveAttribute("data-collapsed", "true");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(rail).toHaveAttribute("data-collapsed", "false");
});

test("the status bar is on every workbench page and leads to Models", async ({ page }) => {
  await signIn(page);
  const bar = page.getByTestId("status-bar");
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("status-access")).toHaveText("Local workspace · token");
  // The stub has no connections, and the bar says so rather than "0 of 0".
  await expect(page.getByTestId("status-models")).toHaveText("No models connected");
  await page.getByTestId("status-models").click();
  await expect(page).toHaveURL(/\/models$/);
  await expect(page.getByTestId("status-bar")).toBeVisible();
  // On Models the bar's model facts step aside: the page shows every state and
  // every run itself, so the link that led here is gone — what stays is the
  // credential, which no page says. The page's own facts take the left half.
  await expect(page.getByTestId("status-models")).toHaveCount(0);
  await expect(page.getByTestId("status-access")).toHaveText("Local workspace · token");
  // The page's facts have a place there before there is anything to say: with no
  // model connected the region is empty, and present, so a later count is heard.
  await expect(page.getByTestId("page-status")).toBeAttached();
  await expect(page.getByTestId("page-status")).toBeEmpty();
});

test("a deep link inside the product resolves to its screen", async ({ page }) => {
  await serveApi(page);
  await page.goto(`/projects/${PROJECT}`);
  // The gate first, because the credential is per tab and this is a fresh one.
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();

  await expect(page.getByTestId("app-rail")).toBeVisible();
  // The project screen — the claim is that the router put us on it rather than
  // on the list or on a 404.
  await expect(page.getByTestId("project-screen")).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/11111111/);
});

/**
 * Visiting a project opens its tab, and the tab is how you get back.
 *
 * The workbench holds projects the way an editor holds files: the tab appears on
 * the visit, stays when you leave for another page, returns you to where you
 * were, and closing the open one lands on the project list rather than on a page
 * whose project you just put away.
 */
test("visiting a project opens its tab; closing the open tab lands on the list", async ({ page }) => {
  await serveApi(page);
  await page.goto(`/projects/${PROJECT}/schema`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("project-screen")).toBeVisible();

  const tab = page.getByTestId(`open-tab-${PROJECT}`);
  await expect(tab.getByRole("link")).toHaveAttribute("aria-current", "page");

  // Leave the project; the tab stays, no longer current, and still knows the section.
  await page.getByTestId("rail-models").click();
  await expect(page).toHaveURL(/\/models$/);
  await expect(tab.getByRole("link")).not.toHaveAttribute("aria-current", "page");
  await tab.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/schema$`));

  await page.getByTestId(`close-tab-${PROJECT}`).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(tab).toHaveCount(0);
});

/**
 * Tabs that do not fit fold behind "N more", and the open one never does.
 *
 * Eight remembered projects on a narrow window: the strip draws what fits at
 * full width, keeps the open project drawn although it is last in the list, and
 * lists the rest in a menu that opens one — which then takes a slot — or closes
 * one in place. Given the room, nothing folds.
 */
test("open-project tabs that do not fit fold behind N more, and the open one stays drawn", async ({ page }) => {
  const others = ["Warehouse pallets", "Retail shelf SKUs", "Drone roof inspection", "Construction PPE", "Weld seams", "Strawberry ripeness", "Forklift safety zones"].map(
    (name, i) => ({ id: `22222222-2222-4222-8222-00000000000${i}`, name }),
  );
  const ids = [...others.map((o) => o.id), PROJECT];
  await page.addInitScript((open) => {
    if (localStorage.getItem("visionset.open-projects") === null) localStorage.setItem("visionset.open-projects", JSON.stringify(open));
  }, ids);
  await serveApi(page);
  // Registered after `serveApi`, so it answers first: each other project by its own name.
  await page.route("**/api/projects/*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const other = others.find((o) => o.id === id);
    if (other === undefined) return route.fallback();
    return route.fulfill({
      status: 200,
      json: { id, name: other.name, description: null, thumbnail_asset_id: null, thumbnail_hash: null, created_at: null } satisfies Wire["ProjectOut"],
    });
  });
  await page.setViewportSize({ width: 760, height: 600 });
  await page.goto(`/projects/${PROJECT}/schema`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("project-screen")).toBeVisible();

  // The open project is last in the list and still drawn, as the current tab.
  await expect(page.getByTestId(`open-tab-${PROJECT}`).getByRole("link")).toHaveAttribute("aria-current", "page");
  const more = page.getByTestId("open-tabs-more");
  await expect(more).toBeVisible();
  const folded = Number.parseInt((await more.textContent()) ?? "", 10);
  expect(folded).toBeGreaterThan(0);
  // Every open project is either a tab or a row in the menu, never both.
  await expect(page.locator('[data-testid^="open-tab-"]:not([data-testid^="open-tab-folded-"])')).toHaveCount(ids.length - folded);

  // A folded project opens from the menu and takes a slot in the strip.
  const last = others[others.length - 1];
  await more.click();
  await page.getByTestId(`open-tab-folded-${last?.id}`).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${last?.id}`));
  await expect(page.getByTestId(`open-tab-${last?.id}`).getByRole("link")).toHaveAttribute("aria-current", "page");

  // A folded project closes in place; the menu stays open on the rest.
  await more.click();
  const row = page.locator('[data-testid^="open-tab-folded-"]').first();
  const closing = await row.getAttribute("data-testid");
  await row.hover();
  await row.getByRole("button", { name: /^Close / }).click();
  await expect(page.getByTestId(closing ?? "")).toHaveCount(0);
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");

  // Given the room, nothing folds.
  await page.setViewportSize({ width: 2400, height: 600 });
  await expect(more).toHaveCount(0);
  await expect(page.locator('[data-testid^="open-tab-"]')).toHaveCount(ids.length - 1);
});

/**
 * The project view's section is in the URL, and this is the only place that
 * wiring exists.
 *
 * `ui-core` is deliberately router-free — it takes the section as a prop and
 * hands one back — so a component test can prove the navigation moves and prove
 * the callback fires, and it cannot prove the two halves are connected. A reload
 * is the whole point of putting the section in the URL, and a reload is a
 * browser fact.
 */
test("the project view's section is in the URL, and survives a reload", async ({ page }) => {
  await serveApi(page);
  await page.goto(`/projects/${PROJECT}?tab=versions`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();

  // The old link opened on the section it named, not on the default — Overview
  // is the default — and the address is the section's own now.
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/schema$`));
  await expect(page.getByTestId("schema-editor")).toBeVisible();
  await expect(page.getByTestId("overview-panel")).toHaveCount(0);
  await expect(page.getByTestId("overview-empty")).toHaveCount(0);

  // This project holds no images, so its Overview is the first-run invitation.
  await page.getByTestId("nav-overview").click();
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/overview$`));
  await expect(page.getByTestId("overview-empty")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("overview-empty")).toBeVisible();
  await expect(page.getByTestId("schema-editor")).toHaveCount(0);
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
  // There is no Home page, so the way out is the project list — the front door
  // `/` itself redirects to.
  await page.getByRole("link", { name: "Back to projects" }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByTestId("projects-screen")).toBeVisible();
});

/**
 * The rail starts collapsed.
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
  // Narrow, not merely labelled narrow: 48px is the collapsed token and 208 the
  // expanded one, so anything under half of 208 can only be the former.
  expect((await rail.boundingBox())?.width ?? 0).toBeLessThan(104);
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

/**
 * The open tabs survive a reload.
 *
 * The unit tests hold the storage logic — absent key, unparseable value, refused
 * storage all resolve to an empty strip — and cannot see whether anything calls
 * it. This is the browser half: a project opened before a reload is still a tab
 * after it, which is a browser fact and nothing else.
 */
test("the open tabs survive a reload", async ({ page }) => {
  await serveApi(page);
  await page.goto(`/projects/${PROJECT}/overview`);
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("project-screen")).toBeVisible();

  await page.getByTestId("rail-models").click();
  await expect(page).toHaveURL(/\/models$/);
  await page.reload();
  await expect(page.getByTestId(`open-tab-${PROJECT}`)).toBeVisible();
});

const isDark = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.classList.contains("dark"));

test("the theme control switches the page, and the choice survives a reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signIn(page);
  const control = page.getByTestId("rail-theme");
  await expect(control).toHaveAccessibleName("Theme: System");
  expect(await isDark(page)).toBe(false);

  await control.click();
  await expect(page.getByRole("menuitemradio", { name: "System" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Dark" }).click();
  expect(await isDark(page)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
  await expect(control).toHaveAccessibleName("Theme: Dark");

  await page.reload();
  await expect(page.getByTestId("app-rail")).toBeVisible();
  expect(await isDark(page)).toBe(true);
  await expect(page.getByTestId("rail-theme")).toHaveAccessibleName("Theme: Dark");

  // Back to System, which then follows the system as it changes.
  await page.getByTestId("rail-theme").click();
  await page.getByRole("menuitemradio", { name: "System" }).click();
  expect(await isDark(page)).toBe(false);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => isDark(page)).toBe(true);
});

test("the stored theme is on the page before any module runs", async ({ page }) => {
  // With the entry module refused, only `index.html`'s own script can have set
  // the class — so this is the theme the first paint gets.
  await page.route("**/src/main.tsx*", (route) => route.abort());
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => localStorage.setItem("visionset.prefs.theme", "dark"));
  await page.goto("/");
  expect(await isDark(page)).toBe(true);
  await expect(page.getByTestId("app-rail")).toHaveCount(0);
});

test("with nothing stored the first paint follows a dark system", async ({ page }) => {
  await page.route("**/src/main.tsx*", (route) => route.abort());
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  expect(await isDark(page)).toBe(true);
});
