/**
 * The inline script in `index.html` that sets the theme before the first paint
 * repeats ui-core's resolution in plain ES5, so this runs it against every case
 * `resolveTheme` answers and holds the two together.
 */
import { readThemePreference, resolveTheme, THEME_PREF_STORAGE_KEY } from "@visionset/ui-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import INDEX from "../index.html?raw";

function prePaintScript(): () => void {
  const match = /<script data-theme-pre-paint>([\s\S]*?)<\/script>/.exec(INDEX);
  if (match === null) throw new Error("index.html has no pre-paint theme script");
  return new Function(match[1]) as () => void;
}

function stubSystem(dark: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-color-scheme: dark)" && dark,
  }));
}

const html = document.documentElement;

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  html.classList.remove("dark");
});

describe("the pre-paint theme script", () => {
  it("runs before the module entry", () => {
    expect(INDEX.indexOf("data-theme-pre-paint")).toBeLessThan(INDEX.indexOf('type="module"'));
  });

  const stored: (string | null)[] = [null, "system", "light", "dark", "sepia"];
  for (const value of stored) {
    for (const systemDark of [false, true]) {
      it(`agrees with resolveTheme for ${JSON.stringify(value)} on a ${systemDark ? "dark" : "light"} system`, () => {
        if (value !== null) localStorage.setItem(THEME_PREF_STORAGE_KEY, value);
        stubSystem(systemDark);
        prePaintScript()();
        const expected = resolveTheme(readThemePreference(), systemDark);
        expect(html.classList.contains("dark")).toBe(expected === "dark");
      });
    }
  }

  it("follows the system when storage refuses to be read", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new DOMException("refused", "SecurityError");
      },
    });
    stubSystem(true);
    prePaintScript()();
    expect(html.classList.contains("dark")).toBe(true);
  });

  it("is light where there is no matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    prePaintScript()();
    expect(html.classList.contains("dark")).toBe(false);
  });
});
