/**
 * The project navigation column, as a component and nothing else.
 *
 * Everything here is presentational — the host spells the URLs and owns the
 * route change — so what a test can hold is the shape: the back link, the name,
 * the chip-or-nothing, one filled control, one item per section with the open
 * one marked structurally, and the callback each item fires. Which breakpoint
 * draws which layout is a browser fact and lives in `e2e/project-nav.spec.ts`.
 */

import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PROJECT_SECTIONS, ProjectNav, type ProjectNavProps } from "./ProjectNav";

function props(overrides: Partial<ProjectNavProps> = {}): ProjectNavProps {
  return {
    layout: "column",
    name: "road-signs",
    activeVersion: 4,
    sections: PROJECT_SECTIONS,
    active: "schema",
    hrefFor: (section) => `/projects/p/${section}`,
    onNavigate: vi.fn(),
    backHref: "/projects",
    onBack: vi.fn(),
    annotate: {
      targets: [{ id: "b1", name: "drive-01", remaining: 12, schemaVersion: 4 }],
      onOpen: vi.fn(),
    },
    onIngest: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

/** The filled controls on screen: Nova's default `Button` carries `data-variant="primary"`. */
function filled(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="button"][data-variant="primary"]'));
}

describe("ProjectNav", () => {
  it("renders the way out, the name, the version chip, one filled control and four items", () => {
    render(<ProjectNav {...props()} />);

    const back = screen.getByTestId("project-back");
    expect(back.tagName).toBe("A");
    expect(back.textContent).toContain("Projects");
    expect(back.getAttribute("href")).toBe("/projects");

    expect(screen.getByRole("heading", { level: 2, name: "road-signs" })).toBeTruthy();
    expect(screen.getByTestId("chip-version").textContent).toBe("v4 active");

    expect(filled()).toHaveLength(1);
    expect(filled()[0]?.textContent).toContain("Annotate");

    const nav = screen.getByTestId("project-nav");
    const items = within(nav).getAllByRole("link").filter((link) => link.dataset.testid?.startsWith("nav-"));
    expect(items.map((item) => item.textContent)).toEqual(["Overview", "Schema", "Batches", "Dataset"]);
    expect(items.map((item) => item.getAttribute("href"))).toEqual([
      "/projects/p/overview",
      "/projects/p/schema",
      "/projects/p/batches",
      "/projects/p/dataset",
    ]);
  });

  it("marks the open section with aria-current and nothing else with it", () => {
    render(<ProjectNav {...props({ active: "batches" })} />);
    expect(screen.getByTestId("nav-batches").getAttribute("aria-current")).toBe("page");
    for (const other of ["nav-overview", "nav-schema", "nav-dataset"]) {
      expect(screen.getByTestId(other).hasAttribute("aria-current")).toBe(false);
    }
  });

  it("omits the chip when there is no schema, rather than rendering a placeholder", () => {
    render(<ProjectNav {...props({ activeVersion: null })} />);
    expect(screen.queryByTestId("chip-version")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "road-signs" })).toBeTruthy();
  });

  it("reports the section to the host rather than navigating itself", async () => {
    const onNavigate = vi.fn();
    render(<ProjectNav {...props({ onNavigate })} />);
    await userEvent.click(screen.getByTestId("nav-dataset"));
    expect(onNavigate).toHaveBeenCalledWith("dataset");
    // The default click is taken by the host: a real `<a>` for middle-click and
    // "open in new tab", a callback for the router.
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("offers only the sections the host wired", () => {
    render(<ProjectNav {...props({ sections: ["overview", "schema", "dataset"] })} />);
    expect(screen.queryByTestId("nav-batches")).toBeNull();
    expect(screen.getByTestId("nav-dataset")).toBeTruthy();
  });

  it("falls back to Ingest as the filled control when nothing is open for annotation", () => {
    render(<ProjectNav {...props({ annotate: undefined })} />);
    expect(screen.queryByTestId("go-annotate")).toBeNull();
    expect(filled()).toHaveLength(1);
    expect(filled()[0]?.textContent).toContain("Ingest");
  });

  it("steps Ingest back when the content owns the page's filled control", () => {
    render(<ProjectNav {...props({ annotate: undefined, contentOwnsTheAction: true })} />);
    expect(filled()).toHaveLength(0);
    expect(screen.getByTestId("go-ingest").dataset.variant).toBe("secondary");
  });

  it("renders no filled control at all when the host wired neither action", () => {
    render(<ProjectNav {...props({ annotate: undefined, onIngest: undefined })} />);
    expect(filled()).toHaveLength(0);
    expect(screen.queryByTestId("go-ingest")).toBeNull();
  });

  it("asks which batch when more than one is open, and says it is asking", async () => {
    const onOpen = vi.fn();
    render(
      <ProjectNav
        {...props({
          annotate: {
            targets: [
              { id: "b2", name: "drive-02", remaining: 3, schemaVersion: 4 },
              { id: "b1", name: "drive-01", remaining: 12, schemaVersion: 3 },
            ],
            onOpen,
          },
        })}
      />,
    );
    const trigger = screen.getByTestId("go-annotate");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByTestId("annotate-batch-drive-01"));
    expect(onOpen).toHaveBeenCalledWith("b1");
  });

  it("keeps rename and delete behind the overflow", async () => {
    const onRename = vi.fn();
    render(<ProjectNav {...props({ onRename })} />);
    await userEvent.click(screen.getByTestId("project-menu"));
    await userEvent.click(await screen.findByTestId("rename-project"));
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("draws the strip layout as a tab bar with the same items", () => {
    render(
      <ProjectNav {...props({ layout: "strip", active: "overview" })}>
        <p data-testid="content">the section</p>
      </ProjectNav>,
    );
    expect(screen.queryByTestId("project-nav")).toBeNull();
    expect(screen.getByTestId("project-tabs")).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Schema",
      "Batches",
      "Dataset",
    ]);
    expect(screen.getByTestId("nav-overview").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("content")).toBeTruthy();
    // The identity travels with it: nothing the column shows is lost below `lg`.
    expect(screen.getByTestId("project-back")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "road-signs" })).toBeTruthy();
    expect(filled()).toHaveLength(1);
  });

  it("is drawn with Tabler only", () => {
    // `import.meta.url` is an `http://localhost/` URL under jsdom, so the path is
    // resolved from the package root vitest runs in rather than from this module.
    const source = readFileSync(resolve(process.cwd(), "src/patterns/ProjectNav.tsx"), "utf8");
    expect(source).not.toMatch(/lucide-react/);
  });
});
