/**
 * What a page says in the workbench's status bar, and what happens when nothing
 * is there to say it in.
 *
 * The package's screens do not know how the app frames them: the shell mounts an
 * outlet where the page's facts go, and a screen hands its facts to
 * `PageStatus`. The claims worth holding are the three that make that safe — the
 * facts land in the outlet and not beside the page, the outlet is a polite status
 * region from the first render, and a screen mounted with no outlet is quiet
 * rather than broken.
 */

import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useState, type JSX } from "react";

import { PageStatus, PageStatusOutlet, PageStatusProvider } from "./PageStatus";

describe("PageStatus", () => {
  it("puts a page's facts in the outlet, not where the page is", () => {
    render(
      <PageStatusProvider>
        <main data-testid="page">
          <h1>Models</h1>
          <PageStatus>
            <span data-testid="fact">3 models</span>
          </PageStatus>
        </main>
        <footer data-testid="bar">
          <PageStatusOutlet />
        </footer>
      </PageStatusProvider>,
    );

    const fact = screen.getByTestId("fact");
    expect(fact.textContent).toBe("3 models");
    // Rendered by the page, shown in the bar.
    expect(screen.getByTestId("page-status").contains(fact)).toBe(true);
    expect(screen.getByTestId("bar").contains(fact)).toBe(true);
    expect(screen.getByTestId("page").contains(fact)).toBe(false);
  });

  it("is a status region from the first render, so a change to a count is announced", () => {
    render(
      <PageStatusProvider>
        <PageStatusOutlet />
      </PageStatusProvider>,
    );

    // Nothing in it yet, and it is already there for a screen reader to watch.
    const outlet = screen.getByRole("status");
    expect(outlet).toBe(screen.getByTestId("page-status"));
    expect(outlet.textContent).toBe("");
  });

  it("follows the page: the facts change in place and go with it", async () => {
    function Page(): JSX.Element {
      const [count, setCount] = useState(2);
      const [shown, setShown] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setCount((n) => n + 1)}>
            add
          </button>
          <button type="button" onClick={() => setShown(false)}>
            leave
          </button>
          {shown && (
            <PageStatus>
              <span data-testid="fact">{count} projects</span>
            </PageStatus>
          )}
        </>
      );
    }
    render(
      <PageStatusProvider>
        <Page />
        <PageStatusOutlet />
      </PageStatusProvider>,
    );

    const outlet = screen.getByRole("status");
    expect(within(outlet).getByTestId("fact").textContent).toBe("2 projects");
    await userEvent.click(screen.getByRole("button", { name: "add" }));
    expect(within(outlet).getByTestId("fact").textContent).toBe("3 projects");
    // A page that is gone leaves nothing behind in the bar.
    await userEvent.click(screen.getByRole("button", { name: "leave" }));
    expect(outlet.textContent).toBe("");
  });

  it("renders nothing without a provider, and the outlet is still an empty status region", () => {
    render(
      <>
        <PageStatus>
          <span data-testid="fact">3 models</span>
        </PageStatus>
        <PageStatusOutlet />
      </>,
    );

    expect(screen.queryByTestId("fact")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("renders nothing under a provider that has no outlet", () => {
    const { container } = render(
      <PageStatusProvider>
        <PageStatus>
          <span data-testid="fact">3 models</span>
        </PageStatus>
      </PageStatusProvider>,
    );

    expect(screen.queryByTestId("fact")).toBeNull();
    // Not in the page either: the facts are the bar's or nobody's.
    expect(container.textContent).toBe("");
  });

  it("lets the outlet take a class of its own", () => {
    render(
      <PageStatusProvider>
        <PageStatusOutlet className="gap-8" />
      </PageStatusProvider>,
    );

    expect(screen.getByTestId("page-status").className).toContain("gap-8");
  });
});
