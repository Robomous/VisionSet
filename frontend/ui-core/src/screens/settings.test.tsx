import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithData } from "../testing/dataHarness";
import { SettingsScreen } from "./SettingsScreen";
import { DEFAULT_SETTINGS_SECTION, isSettingsSection, SETTINGS_SECTIONS } from "./settingsSections";

type Answer = { status: number; body: unknown };
let health: Answer;
let asked: string[];

beforeEach(() => {
  health = { status: 200, body: { status: "ok", version: "1.2.3" } };
  asked = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname;
    asked.push(path);
    const answer = path.endsWith("/health") ? health : { status: 500, body: { detail: "unstubbed" } };
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("the settings sections", () => {
  it("opens on About, the only section with content", () => {
    expect(SETTINGS_SECTIONS).toEqual(["about"]);
    expect(DEFAULT_SETTINGS_SECTION).toBe("about");
  });

  it("knows its own segments and nothing else", () => {
    expect(isSettingsSection("about")).toBe(true);
    expect(isSettingsSection("appearance")).toBe(false);
    expect(isSettingsSection(undefined)).toBe(false);
  });
});

describe("SettingsScreen", () => {
  it("shows the version the server reports", async () => {
    renderWithData(<SettingsScreen section="about" onSectionChange={() => {}} />);
    expect((await screen.findByTestId("settings-version")).textContent).toBe("1.2.3");
    expect(asked.some((path) => path.endsWith("/health"))).toBe(true);
  });

  it("says the version is not reported when the answer carries none", async () => {
    health = { status: 200, body: { status: "ok" } };
    renderWithData(<SettingsScreen section="about" onSectionChange={() => {}} />);
    expect((await screen.findByTestId("settings-version")).textContent).toBe("Not reported");
  });

  it("renders a failed read as an alert, not as an empty group", async () => {
    health = { status: 500, body: { code: "INTERNAL_ERROR", message: "no", detail: null } };
    renderWithData(<SettingsScreen section="about" onSectionChange={() => {}} />);
    const group = screen.getByTestId("settings-about");
    expect(await within(group).findByRole("alert")).toBeTruthy();
    expect(screen.queryByTestId("settings-version")).toBeNull();
  });

  it("names the page and the group, and says the group's scope", async () => {
    renderWithData(<SettingsScreen section="about" onSectionChange={() => {}} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Settings");
    const group = screen.getByRole("region", { name: "About" });
    expect(within(group).getByText("Workspace")).toBeTruthy();
    await screen.findByTestId("settings-version");
  });

  it("draws each section as a link the host spelled, marking the open one", async () => {
    renderWithData(
      <SettingsScreen section="about" hrefFor={(section) => `/settings/${section}`} onSectionChange={() => {}} />,
    );
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/settings/about"]);
    expect(links[0]?.getAttribute("aria-current")).toBe("page");
    await screen.findByTestId("settings-version");
  });

  it("turns a plain click into the host's navigation and leaves a modified one to the browser", async () => {
    const user = userEvent.setup();
    const onSectionChange = vi.fn();
    renderWithData(
      <SettingsScreen section="about" hrefFor={(section) => `/settings/${section}`} onSectionChange={onSectionChange} />,
    );
    const link = screen.getByTestId("settings-nav-about");
    await user.click(link);
    expect(onSectionChange).toHaveBeenCalledWith("about");

    onSectionChange.mockClear();
    // jsdom cannot open a new tab; stop the default only after the screen has seen the click.
    const stopNavigation = (event: Event): void => event.preventDefault();
    document.addEventListener("click", stopNavigation);
    await user.keyboard("{Control>}");
    await user.click(link);
    await user.keyboard("{/Control}");
    document.removeEventListener("click", stopNavigation);
    expect(onSectionChange).not.toHaveBeenCalled();
    await screen.findByTestId("settings-version");
  });

  it("falls back to buttons when the host spells no URLs", async () => {
    const user = userEvent.setup();
    const onSectionChange = vi.fn();
    renderWithData(<SettingsScreen section="about" onSectionChange={onSectionChange} />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).queryAllByRole("link")).toHaveLength(0);
    await user.click(within(nav).getByRole("button", { name: "About" }));
    expect(onSectionChange).toHaveBeenCalledWith("about");
    await screen.findByTestId("settings-version");
  });
});
