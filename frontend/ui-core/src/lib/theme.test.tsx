import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearPrefs, readPref, writePref } from "../data/prefs";
import {
  readThemePreference,
  resolveTheme,
  setThemePreference,
  startTheme,
  THEME_PREF_STORAGE_KEY,
  useTheme,
  useThemePreference,
} from "./theme";

afterEach(() => {
  document.documentElement.classList.remove("dark");
  vi.restoreAllMocks();
});

function Shown(): string {
  return useTheme();
}

describe("useTheme", () => {
  it("is light with no class on the page", () => {
    expect(renderHook(() => useTheme()).result.current).toBe("light");
  });

  it("follows the dark class on <html> both ways while mounted", async () => {
    const { result } = renderHook(() => useTheme());
    await act(async () => {
      document.documentElement.classList.add("dark");
    });
    expect(result.current).toBe("dark");
    await act(async () => {
      document.documentElement.classList.remove("dark");
    });
    expect(result.current).toBe("light");
  });

  it("reads a class set before it mounted", () => {
    document.documentElement.classList.add("dark");
    expect(renderHook(() => useTheme()).result.current).toBe("dark");
  });

  it("stops watching when it unmounts", () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const { unmount } = renderHook(() => useTheme());
    expect(disconnect).not.toHaveBeenCalled();
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("renders light on the server, whatever the document says", () => {
    document.documentElement.classList.add("dark");
    expect(renderToString(<Shown />)).toBe("light");
  });
});

function fakeSystem(dark: boolean): { flip: (next: boolean) => void; listeners: () => number } {
  let matches = dark;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === "(prefers-color-scheme: dark)" && matches;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    flip(next) {
      matches = next;
      for (const listener of listeners) listener();
    },
    listeners: () => listeners.size,
  };
}

const html = document.documentElement;

describe("the host's theme", () => {
  let stop: () => void = () => {};

  beforeEach(() => clearPrefs());
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
    clearPrefs();
  });

  it("follows a dark system when nothing is stored", () => {
    fakeSystem(true);
    stop = startTheme();
    expect(html.classList.contains("dark")).toBe(true);
    expect(readThemePreference()).toBe("system");
  });

  it("is light when the system says nothing", () => {
    stop = startTheme();
    expect(html.classList.contains("dark")).toBe(false);
  });

  it("lets a stored preference override the system", () => {
    fakeSystem(true);
    writePref("theme", "light");
    stop = startTheme();
    expect(html.classList.contains("dark")).toBe(false);
  });

  it("follows a live system change while the preference is system, and only then", () => {
    const system = fakeSystem(false);
    stop = startTheme();
    system.flip(true);
    expect(html.classList.contains("dark")).toBe(true);
    system.flip(false);
    expect(html.classList.contains("dark")).toBe(false);

    setThemePreference("light");
    system.flip(true);
    expect(html.classList.contains("dark")).toBe(false);
  });

  it("stops following the system when stopped", () => {
    const system = fakeSystem(false);
    startTheme()();
    expect(system.listeners()).toBe(0);
  });

  it.each(["sepia", "", "DARK", "null"])("reads %j as system", (stored) => {
    fakeSystem(true);
    writePref("theme", stored);
    expect(readThemePreference()).toBe("system");
    stop = startTheme();
    expect(html.classList.contains("dark")).toBe(true);
  });

  it("stores a choice, applies it, and tells the control", async () => {
    fakeSystem(false);
    stop = startTheme();
    const { result } = renderHook(() => useThemePreference());
    expect(result.current).toBe("system");
    await act(async () => setThemePreference("dark"));
    expect(result.current).toBe("dark");
    expect(html.classList.contains("dark")).toBe(true);
    expect(readPref("theme")).toBe("dark");
    expect(localStorage.getItem(THEME_PREF_STORAGE_KEY)).toBe("dark");
  });

  it("still switches, for this load, when the browser refuses storage", () => {
    fakeSystem(false);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("refused", "SecurityError");
    });
    stop = startTheme();
    setThemePreference("dark");
    expect(html.classList.contains("dark")).toBe(true);
    expect(readThemePreference()).toBe("dark");
  });

  it("resolves the same way the pre-paint script is held to", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
