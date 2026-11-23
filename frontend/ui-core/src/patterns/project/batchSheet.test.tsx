/**
 * The batch's panel, on fixture rows, without a screen or a server around it.
 *
 * What it promises: the state is one of the properties rather than a badge
 * beside the name; what is read less often waits behind "N more properties",
 * and folded it cannot be tabbed into; the line that condenses the batch on
 * scroll echoes the page, so it is hidden from assistive tech and adds no
 * second state; and J/K still walk the batches from anywhere in the panel.
 */

import { TooltipProvider } from "@robomous/ui-core";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BatchSheet, type BatchSheetProps, type SheetJob } from "./BatchSheet";
import type { BatchRowView } from "./BatchTable";

const ROW: BatchRowView = {
  id: "b1",
  name: "autopista cámara 1",
  phase: "annotating",
  schemaVersion: 3,
  done: 18,
  total: 48,
  prelabel: null,
  assignees: ["ana", null],
};

const JOBS: readonly SheetJob[] = [
  { id: "j1", label: "Job 1", assignee: "ana", images: 24, done: 12, state: "In progress", finished: false },
  { id: "j2", label: "Job 2", assignee: null, images: 24, done: 6, state: "In progress", finished: false },
];

function renderSheet(over: Partial<BatchSheetProps> = {}): { onStep: ReturnType<typeof vi.fn> } {
  const onStep = vi.fn();
  // The state chip's card is a tooltip; the app mounts its provider at the root.
  render(
    <TooltipProvider>
      <BatchSheet
        row={ROW}
        position={{ at: 0, count: 3 }}
        onStep={onStep}
        onClose={vi.fn()}
        jobs={JOBS}
        noJobs="No jobs yet."
        details={{ review: { accepted: 10, waiting: 5, skipped: 3 }, correction: false, promoted: 0 }}
        {...over}
      />
    </TooltipProvider>,
  );
  return { onStep };
}

describe("the batch's panel", () => {
  it("titles the page with the batch and lists its state among the properties", () => {
    renderSheet();

    expect(screen.getByRole("heading", { level: 2, name: "autopista cámara 1" })).toBeTruthy();
    const facts = within(screen.getByTestId("batch-sheet-facts"));
    // One state on the page for assistive tech: the condensed line's copy is hidden.
    expect(screen.getAllByTestId("batch-phase")).toHaveLength(1);
    expect(facts.getByText("State")).toBeTruthy();
    expect(facts.getByTestId("batch-phase").textContent).toBe("Labeling");
    expect(facts.getByText("18 of 48")).toBeTruthy();
    expect(facts.getByText("ana")).toBeTruthy();
    expect(screen.getByTestId("batch-sheet-condensed").getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the properties read less often behind a fold that cannot be tabbed into until it opens", async () => {
    renderSheet();

    const toggle = screen.getByTestId("batch-sheet-more-toggle");
    expect(toggle.textContent).toBe("3 more properties");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const more = screen.getByTestId("batch-sheet-more");
    expect(more.hasAttribute("inert")).toBe(true);
    expect(more.textContent).toContain("Version 3");
    expect(more.textContent).toContain("10 accepted · 5 waiting · 3 skipped");

    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Fewer properties");
    expect(more.hasAttribute("inert")).toBe(false);
  });

  it("says a correction batch is one, and how many of its images are in the dataset", () => {
    renderSheet({ details: { review: null, correction: true, promoted: 12 } });

    const more = screen.getByTestId("batch-sheet-more");
    expect(more.textContent).toContain("Correction of an earlier batch");
    expect(more.textContent).toContain("12 images");
    expect(more.textContent).not.toContain("accepted");
  });

  it("steps the batches with J and K from inside the panel", async () => {
    const { onStep } = renderSheet();

    await userEvent.click(screen.getByTestId("batch-sheet-more-toggle"));
    await userEvent.keyboard("j");
    await userEvent.keyboard("k");
    expect(onStep.mock.calls).toEqual([[1], [-1]]);
  });
});
