import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useTheme } from "./theme";

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
