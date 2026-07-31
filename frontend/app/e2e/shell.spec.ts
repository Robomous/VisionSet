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

/** The token form's one request. Its body is irrelevant; its status is not. */
async function serveEmptyProjects(page: Page): Promise<void> {
  await page.route("**/projects*", (route) =>
    route.fulfill({ status: 200, json: { items: [], total: 0 } }),
  );
}

async function signIn(page: Page): Promise<void> {
  await serveEmptyProjects(page);
  await page.goto("/");
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();
  await expect(page.getByTestId("app-rail")).toBeVisible();
}

test("the product is behind the token gate and the showcase is not", async ({ page }) => {
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

  // `end` on the Home link is what makes this true: without it `NavLink` treats
  // `/` as a prefix of every route and Home is permanently active.
  await expect(page.getByTestId("rail-home")).toHaveAttribute("aria-current", "page");

  await page.getByTestId("rail-projects").click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByTestId("rail-projects")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("rail-home")).not.toHaveAttribute("aria-current", "page");

  // A real `<a href>`, so middle-click and "open in new tab" work — which on a
  // tool people keep two workspaces open in is not a detail.
  await expect(page.getByTestId("rail-projects")).toHaveAttribute("href", "/projects");
});

test("collapsing the rail narrows it and keeps every control reachable", async ({ page }) => {
  await signIn(page);
  const rail = page.getByTestId("app-rail");

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
  await serveEmptyProjects(page);
  await page.goto("/projects/11111111-1111-4111-8111-111111111111");
  // The gate first, because the credential is per tab and this is a fresh one.
  await page.getByTestId("token-input").fill("a-token");
  await page.getByTestId("token-submit").click();

  await expect(page.getByTestId("app-rail")).toBeVisible();
  // #53's screen, still a placeholder — the claim is that the router put us on it
  // rather than on Home or on a 404.
  await expect(page.getByText("Project", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/11111111/);
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
  await expect(page).toHaveURL(/\/$/);
});
