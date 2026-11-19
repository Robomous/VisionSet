/**
 * The shell's breakpoint swap moves the content; it must not remount it.
 *
 * `matchMedia` is stubbed with a verdict the test flips, so a crossing of the
 * breakpoint is a `change` event exactly as a browser would fire it.
 */

import { act, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type JSX } from "react";

import { PROJECT_SECTIONS } from "./ProjectNav";
import { ProjectShell, type ProjectNavData } from "./ProjectShell";

function controllableMatchMedia(initial: boolean): (matches: boolean) => void {
  let matches = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return matches;
    },
    addEventListener: (_: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => void listeners.delete(listener),
  }));
  return (next) => {
    matches = next;
    act(() => listeners.forEach((listener) => listener()));
  };
}

const NAV: ProjectNavData = { sections: PROJECT_SECTIONS, active: "dataset", onNavigate: () => undefined };

function Counter(): JSX.Element {
  const [count, setCount] = useState(0);
  return (
    <button type="button" data-testid="counter" onClick={() => setCount(count + 1)}>
      {count}
    </button>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProjectShell", () => {
  it.each([
    ["wide to narrow", true],
    ["narrow to wide", false],
  ])("keeps the content's state across the breakpoint, %s", async (_, wide) => {
    const resize = controllableMatchMedia(wide);
    render(
      <ProjectShell nav={NAV}>
        <Counter />
      </ProjectShell>,
    );
    await userEvent.click(screen.getByTestId("counter"));
    expect(screen.getByTestId("counter").textContent).toBe("1");

    resize(!wide);

    expect(screen.queryByTestId("project-tabs") === null).toBe(!wide);
    expect(screen.getByTestId("counter").textContent).toBe("1");
  });

  it("holds the content in the strip's tab panel below the breakpoint", () => {
    controllableMatchMedia(false);
    render(
      <ProjectShell nav={NAV}>
        <Counter />
      </ProjectShell>,
    );
    expect(screen.getByRole("tabpanel").contains(screen.getByTestId("counter"))).toBe(true);
  });
});
