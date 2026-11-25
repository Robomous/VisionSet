/**
 * The project navigation, as a component and nothing else.
 *
 * Everything here is presentational — the host spells the URLs and owns the
 * route change — so what a test can hold is the shape: one filled control, one
 * item per section with the open one marked structurally, the overflow, and the
 * callback each item fires. The project's identity is not here at all, nor
 * anywhere on the project's pages. Which breakpoint draws which layout
 * is a browser fact and lives in `e2e/project-nav.spec.ts`.
 */

import { render as plainRender, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { TooltipProvider } from "@robomous/ui-core";

import { stubResizeObserver } from "../testing/resizeObserver.js";
import { ProjectNav, type ProjectNavProps } from "./ProjectNav";
import { PROJECT_SECTIONS } from "./projectSections";

/** The header's actions are icon buttons named by tooltips, which need their provider. */
function render(ui: Parameters<typeof plainRender>[0]): ReturnType<typeof plainRender> {
  return plainRender(ui, { wrapper: TooltipProvider });
}

beforeEach(() => stubResizeObserver());

function props(overrides: Partial<ProjectNavProps> = {}): ProjectNavProps {
  return {
    layout: "bar",
    sections: PROJECT_SECTIONS,
    active: "schema",
    hrefFor: (section) => `/projects/p/${section}`,
    onNavigate: vi.fn(),
    onIngest: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

/**
 * The filled controls on screen: Nova's default `Button` carries `data-variant="default"`.
 * Not keyed on `data-slot`: a button that is a tooltip's trigger takes that slot's name.
 */
function filled(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('button[data-variant="default"]'));
}

describe("ProjectNav", () => {
  it("renders one filled control, four items as links, and the overflow — and no identity", () => {
    render(<ProjectNav {...props()} />);

    expect(filled()).toHaveLength(1);
    // An icon button, named by its tooltip.
    expect(filled()[0]?.getAttribute("aria-label")).toBe("Add images");

    const nav = screen.getByTestId("project-nav");
    const items = within(nav).getAllByRole("link").filter((link) => link.dataset.testid?.startsWith("nav-"));
    expect(items.map((item) => item.textContent)).toEqual([
      "Overview",
      "Images",
      "Classes",
      "Dataset",
    ]);
    expect(items.map((item) => item.getAttribute("href"))).toEqual([
      "/projects/p/overview",
      "/projects/p/images",
      "/projects/p/schema",
      "/projects/p/dataset",
    ]);
    expect(within(nav).getByTestId("project-menu")).toBeTruthy();

    // The name, the chip and the way out are not the bar's.
    expect(within(nav).queryByRole("heading")).toBeNull();
    expect(within(nav).queryByTestId("project-title")).toBeNull();
    expect(within(nav).queryByTestId("chip-version")).toBeNull();
    expect(within(nav).queryByTestId("breadcrumb")).toBeNull();
  });

  it("marks the open section with aria-current and nothing else with it", () => {
    render(<ProjectNav {...props({ active: "images" })} />);
    expect(screen.getByTestId("nav-images").getAttribute("aria-current")).toBe("page");
    for (const other of ["nav-overview", "nav-schema", "nav-dataset"]) {
      expect(screen.getByTestId(other).hasAttribute("aria-current")).toBe(false);
    }
  });

  it("keeps the section ids as the product's nouns while the labels are the words a person reads", () => {
    expect(PROJECT_SECTIONS).toEqual(["overview", "images", "schema", "dataset"]);
    render(<ProjectNav {...props()} />);
    expect(screen.queryByTestId("nav-batches")).toBeNull();
    expect(screen.getByTestId("nav-schema").textContent).toBe("Classes");
    expect(screen.getByTestId("nav-images").getAttribute("href")).toBe("/projects/p/images");
  });

  it("lights nothing for a page that belongs to no section", () => {
    render(<ProjectNav {...props({ active: null })} />);
    expect(document.querySelectorAll('[data-testid^="nav-"][aria-current]')).toHaveLength(0);
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
    expect(screen.queryByTestId("nav-images")).toBeNull();
    expect(screen.getByTestId("nav-dataset")).toBeTruthy();
  });

  it("draws Add images as the bar's one filled control", () => {
    render(<ProjectNav {...props()} />);
    expect(filled()).toEqual([screen.getByTestId("go-ingest")]);
    // Annotate is the Overview's batches band's, never the bar's.
    expect(screen.queryByTestId("go-annotate")).toBeNull();
  });

  it("moves Add images into the overflow on a section it is not about", async () => {
    const onIngest = vi.fn();
    render(<ProjectNav {...props({ ingest: "menu", onIngest })} />);
    expect(screen.queryByTestId("go-ingest")).toBeNull();
    await userEvent.click(screen.getByTestId("project-menu"));
    await userEvent.click(await screen.findByTestId("menu-ingest"));
    expect(onIngest).toHaveBeenCalledTimes(1);
  });

  it("renders no filled control and no Add images entry when the host wired none — the Overview", async () => {
    render(<ProjectNav {...props({ onIngest: undefined })} />);
    expect(filled()).toHaveLength(0);
    expect(screen.queryByTestId("go-ingest")).toBeNull();
    await userEvent.click(screen.getByTestId("project-menu"));
    expect(await screen.findByTestId("rename-project")).toBeTruthy();
    expect(screen.queryByTestId("menu-ingest")).toBeNull();
  });

  it("keeps rename and delete behind the overflow", async () => {
    const onRename = vi.fn();
    render(<ProjectNav {...props({ onRename })} />);
    await userEvent.click(screen.getByTestId("project-menu"));
    await userEvent.click(await screen.findByTestId("rename-project"));
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("draws the strip layout as a tab bar with the same items, the filled control beside it", () => {
    render(
      <ProjectNav {...props({ layout: "strip", active: "overview" })}>
        <p data-testid="content">the section</p>
      </ProjectNav>,
    );
    expect(screen.queryByTestId("project-nav")).toBeNull();
    expect(screen.getByTestId("project-tabs")).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Images",
      "Classes",
      "Dataset",
    ]);
    expect(screen.getByTestId("nav-overview").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("content")).toBeTruthy();
    expect(filled()).toHaveLength(1);
    expect(screen.getByTestId("project-menu")).toBeTruthy();
  });

  it("draws from the one icon set and no other", () => {
    // `import.meta.url` is an `http://localhost/` URL under jsdom, so the path is
    // resolved from the package root vitest runs in rather than from this module.
    const source = readFileSync(resolve(process.cwd(), "src/patterns/ProjectNav.tsx"), "utf8");
    // Both directions: the set it draws, and the one it must not reach back for.
    // Asserting only the absence would pass for a file that had stopped drawing
    // icons at all.
    expect(source).toMatch(/lucide-react/);
    expect(source).not.toMatch(/@tabler\/icons-react/);
  });
});
