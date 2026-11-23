/**
 * `EmptyState` and the drawing it carries.
 *
 * What is pinned is the contract a screen relies on: which drawing it gets,
 * that the drawing is decoration to a screen reader, and that an absent action
 * leaves nothing behind. How the cards look is the stylesheet's and a browser's
 * to show.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EmptyState } from "./AsyncStates";
import { EmptyArt, type EmptyArtName } from "./EmptyArt";

const NAMED: readonly EmptyArtName[] = ["projects", "images", "classes", "models", "dataset", "recipes"];

function art(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>("[data-art]");
  if (found === null) throw new Error("no drawing");
  return found;
}

describe("EmptyState", () => {
  it("names the space, explains it and offers the action", () => {
    render(<EmptyState art="projects" title="No projects yet" description="A project holds a schema." action={<button type="button">New project</button>} />);
    expect(screen.getByText("No projects yet")).not.toBeNull();
    expect(screen.getByText("A project holds a schema.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "New project" })).not.toBeNull();
  });

  it("draws the space's own stack when it is given one", () => {
    const { container } = render(<EmptyState art="dataset" title="Nothing promoted yet" />);
    expect(art(container).dataset.art).toBe("dataset");
  });

  it("falls back to a plain stack that holds the icon", () => {
    const { container } = render(<EmptyState title="No such page" icon={<svg data-testid="compass" />} />);
    expect(art(container).dataset.art).toBe("plain");
    expect(art(container).querySelector("[data-testid=compass]")).not.toBeNull();
  });

  it("gives the plain stack an icon of its own when a screen passes none", () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    expect(art(container).querySelector("svg")).not.toBeNull();
  });

  it("hides the drawing, and every word inside it, from assistive technology", () => {
    const { container } = render(<EmptyState art="models" title="Connect a model" />);
    expect(art(container).getAttribute("aria-hidden")).toBe("true");
    // The drawing's own label ("person 0.94") is a picture of a label: text
    // inside the hidden subtree, never an accessible name.
    expect(art(container).textContent).toContain("person");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders no action slot when there is no action", () => {
    const { container } = render(<EmptyState title="No exporters installed" description="Exporters ship as plugins." />);
    expect(container.querySelectorAll(".vs-empty > *")).toHaveLength(3);
  });

  it("draws smaller in a pane", () => {
    const roomy = render(<EmptyState title="No recipes yet" art="recipes" />);
    const tight = render(<EmptyState title="No recipes yet" art="recipes" size="compact" />);
    expect(art(roomy.container).className).not.toBe(art(tight.container).className);
  });
});

describe("EmptyArt", () => {
  it.each(NAMED)("has a drawing for %s", (name) => {
    const { container } = render(<EmptyArt name={name} />);
    expect(art(container).dataset.art).toBe(name);
    // Every drawing is a stack: more than one card, each with its place.
    expect(container.querySelectorAll(".vs-empty-tile").length).toBeGreaterThan(1);
  });
});
