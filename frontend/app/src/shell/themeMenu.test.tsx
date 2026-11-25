import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { startTheme, THEME_PREF_STORAGE_KEY, TooltipProvider } from "@visionset/ui-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeMenu } from "./AppShell";

// Radix opens a menu through DOM APIs jsdom lacks; see ui-core's vitest.setup.ts.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

const html = document.documentElement;
let stop: () => void = () => {};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-color-scheme: dark)",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  stop = startTheme();
});

afterEach(() => {
  stop();
  vi.unstubAllGlobals();
  localStorage.clear();
  html.classList.remove("dark");
});

function renderMenu(collapsed = true): void {
  render(
    <TooltipProvider>
      <ThemeMenu collapsed={collapsed} />
    </TooltipProvider>,
  );
}

describe("the rail's theme control", () => {
  it("names the current choice, which starts as System on a dark system", () => {
    renderMenu();
    expect(screen.getByRole("button", { name: "Theme: System" }).getAttribute("aria-haspopup")).toBe("menu");
    expect(html.classList.contains("dark")).toBe(true);
  });

  it("offers the three choices as radios with the current one checked", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: "Theme: System" }));
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["System", "Light", "Dark"]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  });

  it("switches the page, remembers the choice and renames itself", async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole("button", { name: "Theme: System" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Light" }));
    expect(html.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem(THEME_PREF_STORAGE_KEY)).toBe("light");
    screen.getByRole("button", { name: "Theme: Light" });
  });

  it("is operable from the keyboard alone", async () => {
    const user = userEvent.setup();
    renderMenu(false);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Theme: System" }));
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(html.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem(THEME_PREF_STORAGE_KEY)).toBe("dark");
    screen.getByRole("button", { name: "Theme: Dark" });
  });
});
